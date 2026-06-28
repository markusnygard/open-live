import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { getDb, getSourcesDb } from '../db/index.js';
import { updateProductionDoc } from '../routes/productions.js';
import type { ProductionDoc } from '../db/types.js';
import { getTally, setTally, subscribe, unsubscribe, broadcast } from '../services/tally.service.js';
import { startMeterRelay, stopMeterRelay } from '../services/meter-relay.js';
import { StromClient, type TransitionType as StromTransitionType } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

type InboundMessage =
  | { type: 'CUT'; mixerInput: string; afvRampMs?: number }
  | { type: 'TRANSITION'; mixerInput: string; transitionType: string; durationMs?: number; afvRampMs?: number }
  | { type: 'TAKE'; afvRampMs?: number }
  | { type: 'SET_PVW'; mixerInput: string }
  | { type: 'FTB'; active?: boolean; durationMs?: number }
  | { type: 'SET_OVL'; alpha: number }
  | { type: 'GO_LIVE' }
  | { type: 'CUT_STREAM' }
  | { type: 'GRAPHIC_ON'; overlayId: string }
  | { type: 'GRAPHIC_OFF'; overlayId: string }
  | { type: 'DSK_TOGGLE'; layer: number; visible?: boolean }
  | { type: 'MACRO_EXEC'; macroId: string }
  | { type: 'AUDIO_SET'; elementId: string; property: 'volume' | 'mute'; value: unknown; ramp_ms?: number }
  | { type: 'AFV_SET'; mixerInput: string; enabled: boolean }
  | { type: 'PFL_SET'; elementId: string; enabled: boolean; volume?: number }
  | { type: 'AUX_SEND_SET'; elementId: string; auxBus: number; level: number; enabled: boolean }
  | { type: 'AUX_MASTER_SET'; auxBus: number; volume: number; muted: boolean }
  | { type: 'GRP_SEND_SET'; elementId: string; grpBus: number; level: number; enabled: boolean }
  | { type: 'GRP_MASTER_SET'; grpBus: number; volume: number; muted: boolean }
  | { type: 'SOURCE_OFFSET_SET'; mixerInput: string; offsetMs: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the numeric index from a mixer pad name like "video_in_2" → 2.
 * Returns null if the pad name doesn't match the expected format.
 */
function padToIndex(mixerInput: string): number | null {
  const match = /video_in_(\d+)$/.exec(mixerInput);
  return match ? parseInt(match[1], 10) : null;
}

const VALID_STROM_TRANSITIONS = new Set<StromTransitionType>(['cut', 'fade', 'slide_left', 'slide_right', 'slide_up', 'slide_down']);

function toStromTransition(type: string): StromTransitionType {
  if (VALID_STROM_TRANSITIONS.has(type as StromTransitionType)) return type as StromTransitionType;
  return 'cut';
}

async function makeStromClient(): Promise<StromClient> {
  const token = await getStromToken(config.stromToken).catch(() => undefined)
  return new StromClient({ baseUrl: config.stromUrl, token })
}

async function stromTransition(
  doc: ProductionDoc,
  fromMixerInput: string | null,
  toMixerInput: string | null,
  transitionType: StromTransitionType,
  durationMs?: number,
): Promise<void> {
  if (!doc.stromFlowId || !doc.mixerBlockId) return;
  if (!toMixerInput) {
    console.warn('[controller] Strom transition skipped — no toMixerInput');
    return;
  }
  const toIndex = padToIndex(toMixerInput);
  if (toIndex === null) {
    console.warn('[controller] Strom transition skipped — cannot parse index from pad:', toMixerInput);
    return;
  }
  // Strom's trigger_transition API always transitions from its current PGM to
  // its current PVW — it ignores from_input/to_input entirely (they are only
  // fallbacks when no overlay state exists). We must therefore call selectPreview
  // first to ensure Strom's PVW is the input we want to cut/transition to.
  const fromIndex = fromMixerInput ? (padToIndex(fromMixerInput) ?? toIndex) : toIndex;
  try {
    const strom = await makeStromClient();
    await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { input: toIndex } });
    await strom.mixer.transition(doc.stromFlowId, doc.mixerBlockId, {
      from_input: fromIndex,
      to_input: toIndex,
      transition_type: transitionType,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    });
  } catch (err) {
    console.warn('[controller] Strom transition error:', err);
  }
}

// ---------------------------------------------------------------------------
// Audio volume debounce
// ---------------------------------------------------------------------------

// Debounce rapid volume nudges so back-to-back AUDIO_SET volume messages don't
// flood Strom's HTTP connection pool. Mute changes skip the debounce.
const pendingVolume = new Map<string, NodeJS.Timeout>()

// ---------------------------------------------------------------------------
// Audio follow — AFV registry
// ---------------------------------------------------------------------------

/**
 * Per-production set of mixerInput values that have AFV enabled.
 * Populated by AFV_SET messages from the frontend. Only channels in this set
 * have their routing updated on cuts — channels not in the set are under
 * manual operator control and are never touched by the switcher.
 */
const afvChannelsByProduction = new Map<string, Set<string>>()

/**
 * Per-production set of elementIds (e.g. "ch1") whose ON/OFF is currently OFF.
 * ON/OFF muting targets to_main_vol_N (routing layer) so that volume_N:mute
 * stays false — keeping the channel signal alive and meters visible even when
 * a strip is muted. This registry lets the backend restore mute state on
 * reconnect without reading from Strom (which would return routing-layer values
 * commingled with AFV routing).
 */
const mutedElementsByProduction = new Map<string, Set<string>>()

/**
 * Last-seen stromFlowId per production.
 * A changed flowId means the pipeline was rebuilt (sources remapped, etc.) so
 * any cached channel-index state is invalid and must be cleared immediately
 * even if a client stayed connected across the restart.
 */
const activeFlowIdByProduction = new Map<string, string>()

/**
 * Per-production runtime offset registry.
 * Maps productionId → (mixerInput → offsetMs).
 * Populated by SOURCE_OFFSET_SET messages; sent to new clients on connect.
 */
const sourceOffsetsByProduction = new Map<string, Map<string, number>>()

/** Wipe all per-production audio state. Called when the pipeline changes. */
function clearAudioState(productionId: string): void {
  afvChannelsByProduction.delete(productionId)
  mutedElementsByProduction.delete(productionId)
  activeFlowIdByProduction.delete(productionId)
  sourceOffsetsByProduction.delete(productionId)
}

/**
 * Returns the 0-based audio channel index for a given mixerInput, or null if
 * the source has no audio channel (html/test sources are skipped).
 * WHIP sources (including the virtual "Whip" source) carry audio and are included.
 */
async function resolveAudioChannelIndex(doc: ProductionDoc, mixerInput: string): Promise<number | null> {
  const sorted = [...doc.sources].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
  const sourcesDb = getSourcesDb();
  let audioIdx = 0;
  for (const assignment of sorted) {
    let streamType: string | undefined;
    try {
      const src = await sourcesDb.get(assignment.sourceId);
      streamType = src.streamType;
    } catch {
      // "Whip" is a virtual WHIP source that carries audio — treat it as 'whip'
      if (assignment.sourceId === 'Whip') {
        streamType = 'whip';
      } else {
        continue; // other virtual sources (test1, test2, html) have no audio
      }
    }
    if (streamType === 'html' || streamType === 'test1' || streamType === 'test2') continue;
    if (assignment.mixerInput === mixerInput) return audioIdx;
    audioIdx++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audio follow
// ---------------------------------------------------------------------------

/**
 * Updates the routing mute (to_main_vol_N:mute) for channels that have AFV
 * enabled so that only the PGM source is audible. Channels without AFV are
 * skipped — they remain under manual operator control via the ON/OFF button.
 * At initial connect (no AFV channels registered yet) it routes only the PGM
 * source so the production starts in a sane state.
 */
async function applyAudioFollow(
  productionId: string,
  doc: ProductionDoc,
  newPgmMixerInput: string | null,
  stromFlowId: string,
  audioBlockId: string,
  strom: StromClient,
  rampMs = 200,
): Promise<void> {
  // Default to empty set — an uninitialised registry never routes all channels.
  const afvChannels = afvChannelsByProduction.get(productionId) ?? new Set<string>();
  const sorted = [...doc.sources].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
  const sourcesDb = getSourcesDb();

  let audioIdx = 0;
  for (const assignment of sorted) {
    let streamType: string | undefined;
    try {
      const src = await sourcesDb.get(assignment.sourceId);
      streamType = src.streamType;
    } catch {
      // "Whip" is a virtual WHIP source that carries audio — treat it as 'whip'
      if (assignment.sourceId === 'Whip') {
        streamType = 'whip';
      } else {
        continue; // other virtual sources (test1, test2, html) have no audio
      }
    }
    if (streamType === 'html' || streamType === 'test1' || streamType === 'test2') continue;

    const chIdx = ++audioIdx;
    // Only update routing for channels the operator has opted into AFV.
    // Channels with AFV off are never touched by the switcher.
    if (!afvChannels.has(assignment.mixerInput)) continue;

    const routed = newPgmMixerInput === null || assignment.mixerInput === newPgmMixerInput;
    const elemId = `${audioBlockId}:to_main_vol_${chIdx - 1}`;
    try {
      await strom.properties.updateElement(stromFlowId, elemId, {
        property_name: 'mute',
        value: !routed,
        ramp_ms: rampMs,
      });
    } catch (err) {
      console.warn(`[controller] audio follow ch${chIdx} error:`, String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(
  productionId: string,
  ws: WebSocket,
  raw: string,
  ctx: { audioBlockId?: string },
): Promise<void> {
  let msg: InboundMessage;
  try {
    msg = JSON.parse(raw) as InboundMessage;
  } catch {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid JSON' }));
    return;
  }

  const db = getDb();
  let doc: ProductionDoc;
  try {
    doc = await db.get(productionId);
  } catch {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Production not found' }));
    return;
  }

  switch (msg.type) {
    case 'CUT': {
      const tally = getTally(productionId);
      const newTally = { pgm: msg.mixerInput, pvw: tally.pgm };
      setTally(productionId, newTally);
      const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'TALLY', ...newTally });
      await stromTransition(doc, tally.pgm, msg.mixerInput, 'cut');
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampMs);
      }
      break;
    }
    case 'TRANSITION': {
      const tally = getTally(productionId);
      const newTally = { pgm: msg.mixerInput, pvw: tally.pgm };
      setTally(productionId, newTally);
      const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'TALLY', ...newTally, transitionType: msg.transitionType, durationMs: msg.durationMs });
      await stromTransition(doc, tally.pgm, msg.mixerInput, toStromTransition(msg.transitionType), msg.durationMs);
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampMs);
      }
      break;
    }
    case 'TAKE': {
      const tally = getTally(productionId);
      const newTally = { pgm: tally.pvw, pvw: tally.pgm };
      setTally(productionId, newTally);
      const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'TALLY', ...newTally });
      await stromTransition(doc, tally.pgm, tally.pvw, 'cut');
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, tally.pvw, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampMs);
      }
      break;
    }
    case 'SET_PVW': {
      const tally = getTally(productionId);
      const newTally = { pgm: tally.pgm, pvw: msg.mixerInput };
      setTally(productionId, newTally);
      const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'TALLY', ...newTally });
      if (doc.stromFlowId && doc.mixerBlockId) {
        const inputIndex = padToIndex(msg.mixerInput);
        if (inputIndex !== null) {
          try {
            const strom = await makeStromClient();
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { input: inputIndex } });
          } catch (err) {
            console.warn('[controller] Strom selectPreview error:', err);
          }
        }
      }
      break;
    }
    case 'FTB': {
      if (!doc.stromFlowId || !doc.mixerBlockId) break;
      try {
        const strom = await makeStromClient();
        const result = await strom.mixer.fadeToBlack(doc.stromFlowId, doc.mixerBlockId, { active: msg.active ?? true, duration_ms: msg.durationMs ?? 1000 });
        broadcast(productionId, { type: 'FTB_STATE', active: result.active });
      } catch (err) {
        console.warn('[controller] Strom FTB error:', err);
        ws.send(JSON.stringify({ type: 'ERROR', error: 'FTB failed' }));
      }
      break;
    }
    case 'SET_OVL': {
      // Persist alpha to DB so it survives page refreshes (retry-on-409 safe)
      await updateProductionDoc(productionId, { overlayAlpha: msg.alpha });
      if (!doc.stromFlowId || !doc.mixerBlockId) break;
      try {
        const strom = await makeStromClient();
        await strom.mixer.setOverlayAlpha(doc.stromFlowId, doc.mixerBlockId, { alpha: msg.alpha });
      } catch (err) {
        console.warn('[controller] Strom setOverlayAlpha error:', err);
      }
      break;
    }
    case 'GO_LIVE': {
      const updated: ProductionDoc = { ...doc, status: 'active', updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'ON_AIR', value: true });
      break;
    }
    case 'CUT_STREAM': {
      const updated: ProductionDoc = { ...doc, status: 'active', updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'ON_AIR', value: false });
      break;
    }
    case 'GRAPHIC_ON':
    case 'GRAPHIC_OFF': {
      const active = msg.type === 'GRAPHIC_ON';
      const updated: ProductionDoc = {
        ...doc,
        graphics: doc.graphics.map((g) =>
          g.id === msg.overlayId ? { ...g, active } : g
        ),
        updatedAt: new Date().toISOString(),
      };
      await db.insert(updated);
      broadcast(productionId, { type: 'GRAPHIC', overlayId: msg.overlayId, active });
      break;
    }
    case 'DSK_TOGGLE': {
      if (!doc.stromFlowId || !doc.mixerBlockId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Pipeline not active or mixer block not resolved' }));
        break;
      }
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      const result = await strom.mixer.toggleDsk(doc.stromFlowId, doc.mixerBlockId, {
        dsk: msg.layer + 1,
        enabled: msg.visible ?? true,
      });
      const layer0 = result.dsk - 1;
      await updateProductionDoc(productionId, {
        dskLayers: { ...(doc.dskLayers ?? {}), [layer0]: result.enabled },
      });
      broadcast(productionId, { type: 'DSK_STATE', layer: layer0, visible: result.enabled });
      break;
    }
    case 'MACRO_EXEC': {
      const macro = (doc.macros ?? []).find((m) => m.id === msg.macroId);
      if (!macro) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Macro not found' }));
        break;
      }
      const strom = await makeStromClient();
      let failedAt = -1;
      let failError = '';
      for (let i = 0; i < macro.actions.length; i++) {
        const action = macro.actions[i];
        try {
          const currentDoc = await getDb().get(productionId);
          // Macros reference sourceId; resolve to mixerInput for tally/Strom
          const resolveInput = (sourceId: string) =>
            currentDoc.sources.find((s) => s.sourceId === sourceId)?.mixerInput ?? null;
          if (action.type === 'CUT' && action.sourceId) {
            const mixerInput = resolveInput(action.sourceId);
            if (!mixerInput) break;
            const tally = getTally(productionId);
            const newTally = { pgm: mixerInput, pvw: tally.pgm };
            setTally(productionId, newTally);
            const updated: ProductionDoc = { ...currentDoc, tally: newTally, updatedAt: new Date().toISOString() };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'TALLY', ...newTally });
            await stromTransition(currentDoc, tally.pgm, mixerInput, 'cut');
          } else if (action.type === 'TRANSITION' && action.sourceId) {
            const mixerInput = resolveInput(action.sourceId);
            if (!mixerInput) break;
            const tally = getTally(productionId);
            const newTally = { pgm: mixerInput, pvw: tally.pgm };
            setTally(productionId, newTally);
            const updated: ProductionDoc = { ...currentDoc, tally: newTally, updatedAt: new Date().toISOString() };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'TALLY', ...newTally, transitionType: action.transitionType, durationMs: action.durationMs });
            await stromTransition(currentDoc, tally.pgm, mixerInput, toStromTransition(action.transitionType ?? 'cut'), action.durationMs);
          } else if (action.type === 'TAKE') {
            const tally = getTally(productionId);
            const newTally = { pgm: tally.pvw, pvw: tally.pgm };
            setTally(productionId, newTally);
            const updated: ProductionDoc = { ...currentDoc, tally: newTally, updatedAt: new Date().toISOString() };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'TALLY', ...newTally });
            await stromTransition(currentDoc, tally.pgm, tally.pvw, 'cut');
          } else if (action.type === 'GRAPHIC_ON' && action.overlayId) {
            const updated: ProductionDoc = {
              ...currentDoc,
              graphics: currentDoc.graphics.map((g) => g.id === action.overlayId ? { ...g, active: true } : g),
              updatedAt: new Date().toISOString(),
            };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'GRAPHIC', overlayId: action.overlayId, active: true });
          } else if (action.type === 'GRAPHIC_OFF' && action.overlayId) {
            const updated: ProductionDoc = {
              ...currentDoc,
              graphics: currentDoc.graphics.map((g) => g.id === action.overlayId ? { ...g, active: false } : g),
              updatedAt: new Date().toISOString(),
            };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'GRAPHIC', overlayId: action.overlayId, active: false });
          } else if (action.type === 'DSK_TOGGLE') {
            if (!currentDoc.stromFlowId || !currentDoc.mixerBlockId) {
              throw new Error('Pipeline not active or mixer block not resolved');
            }
            await strom.mixer.toggleDsk(currentDoc.stromFlowId, currentDoc.mixerBlockId, {
              dsk: (action.layer ?? 0) + 1,
              enabled: action.visible ?? true,
            });
          }
        } catch (err) {
          failedAt = i;
          failError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      if (failedAt !== -1) {
        ws.send(JSON.stringify({ type: 'MACRO_ERROR', macroId: msg.macroId, failedActionIndex: failedAt, error: failError }));
      } else {
        broadcast(productionId, { type: 'MACRO_EXECUTED', macroId: msg.macroId });
      }
      break;
    }
    case 'AUDIO_SET': {
      if (!doc.stromFlowId) break;
      try {
        const strom = await makeStromClient();
        // Resolve audio block ID from cache; fetch flow only if not yet known
        if (!ctx.audioBlockId) {
          const { flow } = await strom.flows.get(doc.stromFlowId);
          const audioBlock = (flow.blocks ?? []).find((b) => b.block_definition_id === 'builtin.mixer');
          if (audioBlock) ctx.audioBlockId = audioBlock.id;
        }
        if (!ctx.audioBlockId) {
          console.warn('[controller] AUDIO_SET: builtin.mixer block not found');
          break;
        }
        let stromElementId: string;
        let property: string;
        if (msg.elementId === 'main') {
          stromElementId = `${ctx.audioBlockId}:main_volume`;
          property = msg.property === 'volume' ? 'volume' : 'mute';
        } else {
          const chMatch = /^ch(\d+)$/.exec(msg.elementId);
          if (!chMatch) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid audio channel id' }));
            break;
          }
          const ch = parseInt(chMatch[1], 10);
          if (msg.property === 'volume') {
            stromElementId = `${ctx.audioBlockId}:volume_${ch - 1}`;
            property = 'volume';
          } else {
            // Mute targets the routing layer (to_main_vol_N) so that the channel
            // signal stays active and VU meters remain visible even when OFF.
            // volume_N:mute is always kept false; only routing is toggled.
            stromElementId = `${ctx.audioBlockId}:to_main_vol_${ch - 1}`;
            property = 'mute';
          }
        }
        if (msg.property === 'volume') {
          // Debounce: coalesce rapid nudges into one Strom PATCH.
          // Broadcast immediately for UI responsiveness; only the final value is sent to Strom.
          broadcast(productionId, { type: 'AUDIO_STATE', elementId: msg.elementId, property: msg.property, value: msg.value });
          const debounceKey = `${productionId}:${stromElementId}`;
          const prev = pendingVolume.get(debounceKey);
          if (prev) clearTimeout(prev);
          const flowId = doc.stromFlowId;
          const capturedStromId = stromElementId;
          const capturedProperty = property;
          const capturedValue = msg.value;
          const capturedLogicalId = msg.elementId;
          pendingVolume.set(debounceKey, setTimeout(async () => {
            pendingVolume.delete(debounceKey);
            try {
              const s = await makeStromClient();
              await s.properties.updateElement(flowId, capturedStromId, {
                property_name: capturedProperty,
                value: capturedValue,
              });
            } catch (err) {
              console.warn('[controller] Strom audio update error:', err);
              broadcast(productionId, { type: 'AUDIO_STATE', elementId: capturedLogicalId, property: 'volume', value: capturedValue });
            }
          }, 150));
        } else {
          // Update mute registry for state restoration on reconnect
          if (msg.elementId !== 'main') {
            const mutedSet = mutedElementsByProduction.get(productionId);
            if (mutedSet) {
              if (msg.value === true) mutedSet.add(msg.elementId);
              else mutedSet.delete(msg.elementId);
            }
          }
          await strom.properties.updateElement(doc.stromFlowId, stromElementId, {
            property_name: property,
            value: msg.value,
            ...(msg.ramp_ms !== undefined && { ramp_ms: msg.ramp_ms }),
          });
          broadcast(productionId, { type: 'AUDIO_STATE', elementId: msg.elementId, property: msg.property, value: msg.value });
        }
      } catch (err) {
        console.warn('[controller] Strom audio update error:', err);
      }
      break;
    }
    case 'AFV_SET': {
      // Register or deregister this mixer input in the per-production AFV set
      // so that applyAudioFollow knows which channels to route on cuts.
      if (!afvChannelsByProduction.has(productionId)) {
        afvChannelsByProduction.set(productionId, new Set());
      }
      const afvSet = afvChannelsByProduction.get(productionId)!;

      if (msg.enabled) {
        afvSet.add(msg.mixerInput);
        // Immediately apply routing based on current tally so the channel
        // doesn't have to wait for the next cut to take effect.
        if (doc.stromFlowId && ctx.audioBlockId) {
          const tally = getTally(productionId);
          const isOnPgm = tally.pgm === msg.mixerInput;
          const chIdx = await resolveAudioChannelIndex(doc, msg.mixerInput);
          if (chIdx !== null) {
            // Clear this channel from the manual mute registry — AFV now owns routing.
            // Broadcast the cleared mute so all clients (including the sender's own
            // store for any reconnect scenario) reflect the correct state.
            const elementId = `ch${chIdx + 1}`;
            mutedElementsByProduction.get(productionId)?.delete(elementId);
            broadcast(productionId, { type: 'AUDIO_STATE', elementId, property: 'mute', value: false });
            const strom = await makeStromClient();
            await strom.properties.updateElement(doc.stromFlowId, `${ctx.audioBlockId}:to_main_vol_${chIdx}`, {
              property_name: 'mute',
              value: !isOnPgm,
            }).catch((err) => console.warn('[controller] AFV_SET routing error:', err));
          }
        }
      } else {
        afvSet.delete(msg.mixerInput);
        // No Strom call here — the frontend sends AUDIO_SET mute immediately after
        // AFV_SET disable to set the desired routing state (ON → open, OFF → closed).
        // Letting AFV_SET touch to_main_vol_N would race with that message.
      }
      // Broadcast to all connected clients so every operator's UI stays in sync.
      broadcast(productionId, { type: 'AFV_STATE', mixerInput: msg.mixerInput, enabled: msg.enabled });
      break;
    }
    case 'PFL_SET': {
      // Set pfl_volume_N:volume on the audio mixer to route this channel to the PFL bus.
      // elementId is the API channel ID, e.g. 'ch1' (1-indexed) → pfl_volume_0 (0-indexed).
      // pfl_out is allow-not-linked so this is safe even when no WHEP client is connected.
      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const chIdx = parseInt(chMatch[1], 10) - 1; // 0-based
        const pflElementId = `${ctx.audioBlockId}:pfl_volume_${chIdx}`;
        const strom = await makeStromClient();
        // When disabling: always 0. When enabling: use provided volume (fader level)
        // or default to 1.0 (unity) so PFL matches perceived channel level.
        const pflValue = msg.enabled ? (msg.volume ?? 1.0) : 0.0;
        await strom.properties.updateElement(doc.stromFlowId, pflElementId, {
          property_name: 'volume',
          value: pflValue,
        }).catch((err) => console.warn('[controller] PFL_SET error:', err));
      }
      // Broadcast so all operator clients stay in sync
      broadcast(productionId, { type: 'PFL_STATE', elementId: msg.elementId, enabled: msg.enabled });
      break;
    }
    case 'AUX_SEND_SET': {
      // Set aux_send_{chIdx}_{auxIdx}:volume on the audio mixer for the given AUX bus.
      // elementId is the API channel ID, e.g. 'ch1' (1-indexed) → chIdx=0.
      // auxBus is 1-indexed on the wire (AUX 1 → auxIdx=0).
      // Strom receives enabled ? level : 0.  The fader position (level) is always
      // broadcast so all clients preserve the saved level across ON/OFF.
      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const chIdx = parseInt(chMatch[1], 10) - 1;     // 0-based
        const auxIdx = msg.auxBus - 1;                   // 0-based
        const auxElementId = `${ctx.audioBlockId}:aux_send_${chIdx}_${auxIdx}`;
        const stromValue = msg.enabled ? msg.level : 0;
        const flowId = doc.stromFlowId;
        const debounceKey = `${productionId}:aux:${auxElementId}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.properties.updateElement(flowId, auxElementId, {
              property_name: 'volume',
              value: stromValue,
            });
          } catch (err) {
            console.warn('[controller] AUX_SEND_SET error:', err);
          }
        }, 150));
      }
      // Broadcast level + enabled so all clients can restore fader position and ON/OFF state
      broadcast(productionId, { type: 'AUX_SEND_STATE', elementId: msg.elementId, auxBus: msg.auxBus, level: msg.level, enabled: msg.enabled });
      break;
    }
    case 'AUX_MASTER_SET': {
      // Set aux{N}_volume:volume on the audio mixer (the AUX bus master fader).
      // auxBus is 1-indexed; Strom element is 0-indexed: aux1 → aux0_volume.
      // When muted, Strom receives 0; the fader level is always broadcast so all
      // clients preserve the saved level even while the master is silenced.
      if (doc.stromFlowId && ctx.audioBlockId) {
        const auxElementId = `${ctx.audioBlockId}:aux${msg.auxBus - 1}_volume`;
        const stromValue = msg.muted ? 0 : msg.volume;
        const flowId = doc.stromFlowId;
        const debounceKey = `${productionId}:aux-master:${auxElementId}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.properties.updateElement(flowId, auxElementId, {
              property_name: 'volume',
              value: stromValue,
            });
          } catch (err) {
            console.warn('[controller] AUX_MASTER_SET error:', err);
          }
        }, 150));
      }
      broadcast(productionId, { type: 'AUX_MASTER_STATE', auxBus: msg.auxBus, volume: msg.volume, muted: msg.muted });
      break;
    }
    case 'GRP_SEND_SET': {
      // Set to_grp{grpIdx}_vol_{chIdx}:volume on the audio mixer.
      // elementId is API channel ID e.g. 'ch1' (1-indexed) → chIdx=0.
      // grpBus is 1-indexed (GRP 1 → grpIdx=0).
      // Strom receives enabled ? level : 0. Fader position always broadcast for multi-client sync.
      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const chIdx = parseInt(chMatch[1], 10) - 1;
        const grpIdx = msg.grpBus - 1;
        const grpElementId = `${ctx.audioBlockId}:to_grp${grpIdx}_vol_${chIdx}`;
        const stromValue = msg.enabled ? msg.level : 0;
        const flowId = doc.stromFlowId;
        const debounceKey = `${productionId}:grp:${grpElementId}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.properties.updateElement(flowId, grpElementId, {
              property_name: 'volume',
              value: stromValue,
            });
          } catch (err) {
            console.warn('[controller] GRP_SEND_SET error:', err);
          }
        }, 150));
      }
      broadcast(productionId, { type: 'GRP_SEND_STATE', elementId: msg.elementId, grpBus: msg.grpBus, level: msg.level, enabled: msg.enabled });
      break;
    }
    case 'GRP_MASTER_SET': {
      // Set group{N}_volume:volume on the audio mixer (group bus master fader).
      // grpBus is 1-indexed; Strom element is 0-indexed: grp1 → group0_volume.
      // Groups auto-feed into main — the group master fader controls contribution to PGM output.
      // When muted, Strom receives 0; fader level always broadcast for multi-client sync.
      if (doc.stromFlowId && ctx.audioBlockId) {
        const grpElementId = `${ctx.audioBlockId}:group${msg.grpBus - 1}_volume`;
        const stromValue = msg.muted ? 0 : msg.volume;
        const flowId = doc.stromFlowId;
        const debounceKey = `${productionId}:grp-master:${grpElementId}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.properties.updateElement(flowId, grpElementId, {
              property_name: 'volume',
              value: stromValue,
            });
          } catch (err) {
            console.warn('[controller] GRP_MASTER_SET error:', err);
          }
        }, 150));
      }
      broadcast(productionId, { type: 'GRP_MASTER_STATE', grpBus: msg.grpBus, volume: msg.volume, muted: msg.muted });
      break;
    }
    case 'SOURCE_OFFSET_SET': {
      // Apply a time offset (ms) to the builtin.time_offset block for this mixer input.
      // The offset is applied live to the running Strom flow and stored in the runtime
      // registry so newly-connected clients receive the current value on connect.
      const { mixerInput, offsetMs } = msg;
      if (!Number.isFinite(offsetMs)) break;

      // Update runtime registry
      const offsets = sourceOffsetsByProduction.get(productionId) ?? new Map<string, number>();
      offsets.set(mixerInput, offsetMs);
      sourceOffsetsByProduction.set(productionId, offsets);

      // Apply to Strom if the flow is running and we know the block ID.
      // offset_ms is a synthetic property on builtin.time_offset blocks — Strom stores it
      // via pad.set_offset() on the identity element's src pad (not a GStreamer element property).
      if (!doc.stromFlowId) {
        console.warn('[controller] SOURCE_OFFSET_SET: production not active, offset stored in registry only');
      } else if (!doc.sourceOffsetBlockIds?.[mixerInput]) {
        console.warn(`[controller] SOURCE_OFFSET_SET: no offset block for ${mixerInput} — re-activate production to pick up time_offset blocks`);
      } else {
        const offsetBlockId = doc.sourceOffsetBlockIds[mixerInput];
        const flowId = doc.stromFlowId;
        const debounceKey = `${productionId}:offset:${mixerInput}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.properties.updateElement(flowId, `${offsetBlockId}:offset_identity`, {
              property_name: 'offset_ms',
              value: offsetMs,
            });
          } catch (err) {
            console.warn(`[controller] SOURCE_OFFSET_SET error (${mixerInput}):`, String(err));
          }
        }, 150));
      }

      broadcast(productionId, { type: 'SOURCE_OFFSET_STATE', mixerInput, offsetMs });
      break;
    }
    default: {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Unknown message type' }));
    }
  }
}

const controllerWs: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/ws/productions/:id/controller',
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      subscribe(id, socket);

      // Per-connection context — mutable so the audio block ID can be populated
      // at connect time and reused on every subsequent AUDIO_SET without a flow fetch.
      const ctx: { audioBlockId?: string } = {};

      // Register message/close handlers immediately so no messages are dropped
      // while we perform the async connect-time sync below.
      socket.on('message', (raw: Buffer | string) => {
        void handleMessage(id, socket, raw.toString(), ctx);
      });

      socket.on('close', () => {
        unsubscribe(id, socket);
        stopMeterRelay(id);
        // Audio state registries are kept in memory so other connected clients
        // and future reconnects inherit the current AFV/mute configuration.
        // State is only wiped when the pipeline changes (new stromFlowId).
      });

      // Fetch production doc once for connect-time sync
      let connectDoc: ProductionDoc | null = null;
      try {
        connectDoc = await getDb().get(id) as ProductionDoc;
      } catch { /* production not found */ }

      // Detect pipeline change (new stromFlowId = sources remapped or flow rebuilt).
      // If the pipeline changed while a client stayed connected across the restart,
      // stale channel-index registries would apply mutes/AFV to the wrong channels.
      // Wipe immediately so this connect is treated as a fresh start.
      if (connectDoc?.stromFlowId) {
        const lastFlowId = activeFlowIdByProduction.get(id)
        if (lastFlowId && lastFlowId !== connectDoc.stromFlowId) {
          clearAudioState(id)
        }
        activeFlowIdByProduction.set(id, connectDoc.stromFlowId)
      }

      // Restore tally from DB if not already in memory (e.g. after server restart)
      let tally = getTally(id);
      if (tally.pgm === null && tally.pvw === null && connectDoc?.tally) {
        if (connectDoc.tally.pgm !== null || connectDoc.tally.pvw !== null) {
          tally = connectDoc.tally;
          setTally(id, tally);
        }
      }
      socket.send(JSON.stringify({ type: 'TALLY', ...tally }));

      // Sync OVL alpha: prefer live Strom value, fall back to persisted value in doc
      if (connectDoc?.stromFlowId && connectDoc?.mixerBlockId) {
        try {
          const strom = await makeStromClient();
          const ovl = await strom.mixer.getOverlayAlpha(connectDoc.stromFlowId, connectDoc.mixerBlockId);
          socket.send(JSON.stringify({ type: 'OVL_STATE', alpha: ovl.alpha }));
        } catch {
          if (connectDoc.overlayAlpha !== undefined) {
            socket.send(JSON.stringify({ type: 'OVL_STATE', alpha: connectDoc.overlayAlpha }));
          }
        }
      } else if (connectDoc?.overlayAlpha !== undefined) {
        socket.send(JSON.stringify({ type: 'OVL_STATE', alpha: connectDoc.overlayAlpha }));
      }

      // Send persisted DSK layer states so the controller reflects the live pipeline
      if (connectDoc?.dskLayers) {
        for (const [layer, visible] of Object.entries(connectDoc.dskLayers)) {
          socket.send(JSON.stringify({ type: 'DSK_STATE', layer: Number(layer), visible }));
        }
      }

      // Sync audio channel state and start meter relay using the audio mixer block
      if (connectDoc?.stromFlowId) {
        try {
          const strom = await makeStromClient();
          const { flow } = await strom.flows.get(connectDoc.stromFlowId);
          const blocks = flow.blocks ?? [];
          // Prefer the persisted audioMixerBlockId; fall back to scanning live flow blocks
          const audioBlockId = connectDoc.audioMixerBlockId ?? blocks.find((b) => b.block_definition_id === 'builtin.mixer')?.id;
          const mixerBlock = audioBlockId ? blocks.find((b) => b.id === audioBlockId) : undefined;
          if (audioBlockId) {
            ctx.audioBlockId = audioBlockId;
            const numChannels = typeof mixerBlock?.properties?.num_channels === 'number'
              ? mixerBlock.properties.num_channels as number
              : 0;
            // Only initialise registries on first connect for this production.
            // Subsequent connects (refresh, second operator) inherit existing state.
            const isFirstConnect = !afvChannelsByProduction.has(id);
            if (isFirstConnect) {
              afvChannelsByProduction.set(id, new Set());
              mutedElementsByProduction.set(id, new Set());
              // Clear volume_N:mute for all channels so signal is always active —
              // pre-fader metering stays visible even when a strip is OFF.
              // Clear to_main_vol_N routing so every channel reaches main at start.
              await Promise.allSettled([
                ...Array.from({ length: numChannels }, (_, i) =>
                  strom.properties.updateElement(connectDoc.stromFlowId!, `${audioBlockId}:volume_${i}`, {
                    property_name: 'mute', value: false,
                  })
                ),
                ...Array.from({ length: numChannels }, (_, i) =>
                  strom.properties.updateElement(connectDoc.stromFlowId!, `${audioBlockId}:to_main_vol_${i}`, {
                    property_name: 'mute', value: false,
                  })
                ),
              ]);
            } else {
              // Returning/additional client — re-apply Strom state from registries in
              // case Strom restarted and lost its in-memory routing state.
              const afvSet   = afvChannelsByProduction.get(id) ?? new Set<string>();
              const mutedSet = mutedElementsByProduction.get(id) ?? new Set<string>();
              // Ensure volume_N:mute is always false (signal always active)
              await Promise.allSettled(
                Array.from({ length: numChannels }, (_, i) =>
                  strom.properties.updateElement(connectDoc.stromFlowId!, `${audioBlockId}:volume_${i}`, {
                    property_name: 'mute', value: false,
                  })
                )
              );
              // Re-apply manual mutes (to_main_vol_N for muted non-AFV channels)
              for (const elId of mutedSet) {
                const chMatch = /^ch(\d+)$/.exec(elId);
                if (chMatch) {
                  const ch = parseInt(chMatch[1], 10);
                  await strom.properties.updateElement(connectDoc.stromFlowId!, `${audioBlockId}:to_main_vol_${ch - 1}`, {
                    property_name: 'mute', value: true,
                  }).catch(() => {});
                }
              }
              // Re-apply AFV routing for channels that opted in
              if (afvSet.size > 0) {
                const tally = getTally(id);
                void applyAudioFollow(id, connectDoc, tally.pgm, connectDoc.stromFlowId!, audioBlockId, strom);
              }
            }
            // Read live fader levels from Strom; mute state comes from our registry
            // (volume_N:mute is always false — we use to_main_vol_N for muting)
            const mutedSet = mutedElementsByProduction.get(id) ?? new Set<string>();
            for (let i = 1; i <= numChannels; i++) {
              try {
                const res = await strom.properties.getElement(connectDoc.stromFlowId, `${audioBlockId}:volume_${i - 1}`);
                const volume = res.properties['volume'];
                if (typeof volume === 'number') {
                  socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'volume', value: volume }));
                }
              } catch { /* element not yet ready or unavailable */ }
              // Send mute state from registry — accurate regardless of Strom state
              const isMuted = mutedSet.has(`ch${i}`);
              socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'mute', value: isMuted }));
            }
            // Read main fader level
            try {
              const res = await strom.properties.getElement(connectDoc.stromFlowId, `${audioBlockId}:main_volume`);
              const volume = res.properties['volume'];
              if (typeof volume === 'number') {
                socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: 'main', property: 'volume', value: volume }));
              }
            } catch { /* main volume element not yet ready */ }
            // Send current AFV state to this connecting client so it can restore
            // its store without the operator having to re-enable AFV per strip.
            const currentAfvSet = afvChannelsByProduction.get(id) ?? new Set<string>();
            for (const mixerInput of currentAfvSet) {
              socket.send(JSON.stringify({ type: 'AFV_STATE', mixerInput, enabled: true }));
            }
            // Send current source offset state so newly-connected clients inherit
            // any offsets set by other operators without needing a round-trip.
            const currentOffsets = sourceOffsetsByProduction.get(id);
            if (currentOffsets) {
              for (const [mixerInput, offsetMs] of currentOffsets) {
                socket.send(JSON.stringify({ type: 'SOURCE_OFFSET_STATE', mixerInput, offsetMs }));
              }
            }
            startMeterRelay(id, connectDoc.stromFlowId, audioBlockId);
          }
        } catch (err) {
          console.warn('[controller] audio sync error:', err);
        }
      }
    }
  );
};

export default controllerWs;
