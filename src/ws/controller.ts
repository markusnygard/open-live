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
import { activePflByProduction, activeAflByProduction, anySoloActive, numAudioChannelsByProduction } from '../services/pfl-state.js';

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
  | { type: 'AFL_SET'; elementId: string; enabled: boolean }
  | { type: 'AUX_SEND_SET'; elementId: string; auxBus: number; level: number; enabled: boolean; pre?: boolean }
  | { type: 'AUX_MASTER_SET'; auxBus: number; volume: number; muted: boolean }
  | { type: 'GRP_SEND_SET'; elementId: string; grpBus: number; level: number; enabled: boolean }
  | { type: 'GRP_MASTER_SET'; grpBus: number; volume: number; muted: boolean }
  | { type: 'MONITOR_SET'; volume: number; muted: boolean }
  | { type: 'SOURCE_OFFSET_SET'; mixerInput: string; offsetMs: number }
  | { type: 'LOUDNESS_RESET' };

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
 * Per-production channel fader level cache.
 * Maps productionId → (elementId → level). elementId is 'ch1', 'ch2', ..., 'main'.
 * Updated immediately on every AUDIO_SET volume message so reconnecting clients
 * receive the last-known fader position even if Strom's block properties don't
 * persist dynamically-set ch${N}_fader values.
 */
const channelLevelsByProduction = new Map<string, Map<string, number>>()

/**
 * Per-production runtime offset registry.
 * Maps productionId → (mixerInput → offsetMs).
 * Populated by SOURCE_OFFSET_SET messages; sent to new clients on connect.
 */
const sourceOffsetsByProduction = new Map<string, Map<string, number>>()

/**
 * Per-production AUX send state cache.
 * Maps productionId → (`ch{N}_aux{M}` → { level, enabled, pre }).
 * Updated on every AUX_SEND_SET so reconnecting clients restore the full per-channel
 * send state (fader position, ON/OFF, and pre/post toggle).
 */
const auxSendByProduction = new Map<string, Map<string, { level: number; enabled: boolean; pre: boolean }>>()

/**
 * Per-production AUX master state cache.
 * Maps productionId → (auxBus(1-indexed) → { volume, muted }).
 * Supplements the Strom block-property fallback so restores work even when Strom
 * is unreachable and the value is authoritative for the current operator session.
 */
const auxMasterByProduction = new Map<string, Map<number, { volume: number; muted: boolean }>>()

/**
 * Per-production GRP send (assignment) state cache.
 * Maps productionId → (`ch{N}_grp{M}` → { level, enabled }).
 * Populated by GRP_SEND_SET messages so the G1/G2 button state survives reconnects.
 */
const grpSendByProduction = new Map<string, Map<string, { level: number; enabled: boolean }>>()

/**
 * Per-production GRP master state cache.
 * Maps productionId → (grpBus(1-indexed) → { volume, muted }).
 */
const grpMasterByProduction = new Map<string, Map<number, { volume: number; muted: boolean }>>()
const monitorByProduction   = new Map<string, { volume: number; muted: boolean }>()


/** Wipe all per-production audio state. Called when the pipeline changes. */
function clearAudioState(productionId: string): void {
  afvChannelsByProduction.delete(productionId)
  mutedElementsByProduction.delete(productionId)
  activeFlowIdByProduction.delete(productionId)
  sourceOffsetsByProduction.delete(productionId)
  numAudioChannelsByProduction.delete(productionId)
  channelLevelsByProduction.delete(productionId)
  auxSendByProduction.delete(productionId)
  auxMasterByProduction.delete(productionId)
  grpSendByProduction.delete(productionId)
  grpMasterByProduction.delete(productionId)
  monitorByProduction.delete(productionId)
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
  const properties: Record<string, unknown> = {};
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
    properties[`ch${chIdx}_to_main`] = routed;
  }
  if (Object.keys(properties).length > 0) {
    await strom.flows.updateBlockProperties(stromFlowId, audioBlockId, { properties, ramp_ms: rampMs })
      .catch((err) => console.warn('[controller] audio follow error:', String(err)));
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
        if (msg.property === 'volume') {
          // Debounce: coalesce rapid nudges into one Strom PATCH.
          // Broadcast immediately for UI responsiveness; only the final value is sent to Strom.
          broadcast(productionId, { type: 'AUDIO_STATE', elementId: msg.elementId, property: msg.property, value: msg.value });
          // Cache fader level immediately so reconnecting clients get the correct position.
          if (typeof msg.value === 'number') {
            if (!channelLevelsByProduction.has(productionId)) channelLevelsByProduction.set(productionId, new Map());
            channelLevelsByProduction.get(productionId)!.set(msg.elementId, msg.value as number);
          }
          // Extract ch number before closure (only valid when elementId !== 'main')
          const chMatch = msg.elementId !== 'main' ? /^ch(\d+)$/.exec(msg.elementId) : null;
          if (msg.elementId !== 'main' && !chMatch) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid audio channel id' }));
            break;
          }
          const ch = chMatch ? parseInt(chMatch[1], 10) : null;
          const debounceKey = `${productionId}:vol:${msg.elementId}`;
          const prev = pendingVolume.get(debounceKey);
          if (prev) clearTimeout(prev);
          const flowId = doc.stromFlowId;
          const capturedAudioBlockId = ctx.audioBlockId;
          const capturedValue = msg.value;
          const capturedLogicalId = msg.elementId;
          pendingVolume.set(debounceKey, setTimeout(async () => {
            pendingVolume.delete(debounceKey);
            try {
              const s = await makeStromClient();
              const propName = capturedLogicalId === 'main' ? 'main_fader' : `ch${ch}_fader`;
              await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
                properties: { [propName]: capturedValue },
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
          let props: Record<string, unknown>;
          if (msg.elementId === 'main') {
            props = { main_mute: msg.value };
          } else {
            const chMatch = /^ch(\d+)$/.exec(msg.elementId);
            if (!chMatch) {
              ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid audio channel id' }));
              break;
            }
            const ch = parseInt(chMatch[1], 10);
            // to_main = !mute (true=ON routing, false=OFF routing)
            props = { [`ch${ch}_to_main`]: !msg.value };
          }
          await strom.flows.updateBlockProperties(doc.stromFlowId, ctx.audioBlockId, {
            properties: props,
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
            await strom.flows.updateBlockProperties(doc.stromFlowId, `${ctx.audioBlockId}`, {
              properties: { [`ch${chIdx + 1}_to_main`]: isOnPgm },
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
      if (!activePflByProduction.has(productionId)) activePflByProduction.set(productionId, new Set());
      const activeSet = activePflByProduction.get(productionId)!;
      if (msg.enabled) activeSet.add(msg.elementId); else activeSet.delete(msg.elementId);

      // Mutually exclusive per strip — enabling PFL cancels AFL on the same channel
      if (msg.enabled) activeAflByProduction.get(productionId)?.delete(msg.elementId);

      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const strom = await makeStromClient();
        const props: Record<string, unknown> = { [`ch${chMatch[1]}_pfl`]: msg.enabled };
        if (msg.enabled) props[`ch${chMatch[1]}_afl`] = false;
        await strom.flows.updateBlockProperties(doc.stromFlowId, ctx.audioBlockId, {
          properties: props,
          ramp_ms: 50,
        }).catch((err: unknown) => console.warn('[controller] PFL_SET block props error:', err));
      }

      broadcast(productionId, { type: 'PFL_STATE', elementId: msg.elementId, enabled: msg.enabled });
      if (msg.enabled) broadcast(productionId, { type: 'AFL_STATE', elementId: msg.elementId, enabled: false });
      break;
    }
    case 'AFL_SET': {
      if (!activeAflByProduction.has(productionId)) activeAflByProduction.set(productionId, new Set());
      const activeAflSet = activeAflByProduction.get(productionId)!;
      if (msg.enabled) activeAflSet.add(msg.elementId); else activeAflSet.delete(msg.elementId);

      // Mutually exclusive per strip — enabling AFL cancels PFL on the same channel
      if (msg.enabled) activePflByProduction.get(productionId)?.delete(msg.elementId);

      const aflChMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (aflChMatch && doc.stromFlowId && ctx.audioBlockId) {
        const strom = await makeStromClient();
        const aflProps: Record<string, unknown> = { [`ch${aflChMatch[1]}_afl`]: msg.enabled };
        if (msg.enabled) aflProps[`ch${aflChMatch[1]}_pfl`] = false;
        await strom.flows.updateBlockProperties(doc.stromFlowId, ctx.audioBlockId, {
          properties: aflProps,
          ramp_ms: 50,
        }).catch((err: unknown) => console.warn('[controller] AFL_SET block props error:', err));
      }

      broadcast(productionId, { type: 'AFL_STATE', elementId: msg.elementId, enabled: msg.enabled });
      if (msg.enabled) broadcast(productionId, { type: 'PFL_STATE', elementId: msg.elementId, enabled: false });
      break;
    }
    case 'AUX_SEND_SET': {
      // Set aux_send_{chIdx}_{auxIdx}:volume on the audio mixer for the given AUX bus.
      // elementId is the API channel ID, e.g. 'ch1' (1-indexed) → chIdx=0.
      // auxBus is 1-indexed on the wire (AUX 1 → auxIdx=0).
      // Strom receives enabled ? level : 0.  The fader position (level) is always
      // broadcast so all clients preserve the saved level across ON/OFF.
      //
      // IMPORTANT: ch{N}_aux{M}_pre is a build-time topology property (element_id: "_block")
      // that controls which tee (pre_fader_tee vs post_fader_tee) the send is wired to.
      // It CANNOT be applied to a running pipeline — only the level property maps to a live
      // GStreamer element. We send pre and level as SEPARATE updateBlockProperties calls so
      // that a pre rejection never silences the level update.
      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const chIdx = parseInt(chMatch[1], 10) - 1;     // 0-based
        const chNum = chIdx + 1;
        const stromValue = msg.enabled ? msg.level : 0;
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const capturedAuxBus = msg.auxBus;
        const capturedPre = msg.pre;
        const debounceKey = `${productionId}:aux:ch${chNum}_aux${capturedAuxBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            // Send level update first — this IS live-applicable (aux_send element volume).
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: { [`ch${chNum}_aux${capturedAuxBus}_level`]: stromValue },
            });
            // Send pre separately — this is a build-time property stored in the flow JSON
            // so it takes effect on next production start. Keeping it separate means a
            // rejection of pre (non-live topology change) never blocks the level update.
            if (capturedPre !== undefined) {
              await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
                properties: { [`ch${chNum}_aux${capturedAuxBus}_pre`]: capturedPre },
              }).catch((err) => console.warn('[controller] AUX pre update error (non-live, stored for next start):', err));
            }
          } catch (err) {
            console.warn('[controller] AUX_SEND_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore — keyed by 'ch{N}_aux{M}'
      if (/^ch\d+$/.test(msg.elementId)) {
        const cache = auxSendByProduction.get(productionId) ?? new Map()
        cache.set(`${msg.elementId}_aux${msg.auxBus}`, { level: msg.level, enabled: msg.enabled, pre: msg.pre ?? true })
        auxSendByProduction.set(productionId, cache)
      }
      // Broadcast level + enabled (+ pre when set) so all clients stay in sync
      broadcast(productionId, { type: 'AUX_SEND_STATE', elementId: msg.elementId, auxBus: msg.auxBus, level: msg.level, enabled: msg.enabled, ...(msg.pre !== undefined && { pre: msg.pre }) });
      break;
    }
    case 'AUX_MASTER_SET': {
      // Set aux{N}_volume:volume on the audio mixer (the AUX bus master fader).
      // auxBus is 1-indexed; Strom element is 0-indexed: aux1 → aux0_volume.
      // When muted, Strom receives 0; the fader level is always broadcast so all
      // clients preserve the saved level even while the master is silenced.
      if (doc.stromFlowId && ctx.audioBlockId) {
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:aux-master:${msg.auxBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: {
                [`aux${msg.auxBus}_fader`]: msg.volume,
                [`aux${msg.auxBus}_mute`]: msg.muted,
              },
            });
          } catch (err) {
            console.warn('[controller] AUX_MASTER_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore
      const amCache = auxMasterByProduction.get(productionId) ?? new Map()
      amCache.set(msg.auxBus, { volume: msg.volume, muted: msg.muted })
      auxMasterByProduction.set(productionId, amCache)
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
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:grp:ch${chIdx + 1}_grp${msg.grpBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: { [`ch${chIdx + 1}_to_grp${msg.grpBus}`]: msg.enabled },
            });
          } catch (err) {
            console.warn('[controller] GRP_SEND_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore — keyed by 'ch{N}_grp{M}'
      if (/^ch\d+$/.test(msg.elementId)) {
        const cache = grpSendByProduction.get(productionId) ?? new Map()
        cache.set(`${msg.elementId}_grp${msg.grpBus}`, { level: msg.level, enabled: msg.enabled })
        grpSendByProduction.set(productionId, cache)
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
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:grp-master:${msg.grpBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: {
                [`group${msg.grpBus}_fader`]: msg.volume,
                [`group${msg.grpBus}_mute`]: msg.muted,
              },
            });
          } catch (err) {
            console.warn('[controller] GRP_MASTER_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore
      const gmCache = grpMasterByProduction.get(productionId) ?? new Map()
      gmCache.set(msg.grpBus, { volume: msg.volume, muted: msg.muted })
      grpMasterByProduction.set(productionId, gmCache)
      broadcast(productionId, { type: 'GRP_MASTER_STATE', grpBus: msg.grpBus, volume: msg.volume, muted: msg.muted });
      break;
    }
    case 'MONITOR_SET': {
      // Set monitor_fader / monitor_mute on the builtin.mixer block.
      // The monitor bus (monitor_out pad) is the operator's local listening feed —
      // zero effect on the programme mix or any output bus.
      // NOTE: Property names 'monitor_fader' and 'monitor_mute' follow the
      // aux/group naming convention — confirm with Strom developer if these differ.
      if (doc.stromFlowId && ctx.audioBlockId) {
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:monitor`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: {
                monitor_fader: msg.volume,
                monitor_mute:  msg.muted,
              },
            });
          } catch (err) {
            console.warn('[controller] MONITOR_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore
      monitorByProduction.set(productionId, { volume: msg.volume, muted: msg.muted })
      broadcast(productionId, { type: 'MONITOR_STATE', volume: msg.volume, muted: msg.muted });
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
    case 'LOUDNESS_RESET': {
      if (!doc.stromFlowId || !doc.loudnessMainBlockId) {
        console.warn('[controller] LOUDNESS_RESET: no active loudness block');
        break;
      }
      try {
        const strom = await makeStromClient();
        await strom.loudness.reset(doc.stromFlowId, doc.loudnessMainBlockId);
      } catch (err) {
        console.warn('[controller] LOUDNESS_RESET error:', String(err));
      }
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
          const state = await strom.mixer.getState(connectDoc.stromFlowId, connectDoc.mixerBlockId);
          socket.send(JSON.stringify({ type: 'OVL_STATE', alpha: state.overlay_alpha }));
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
            const rawNumCh = mixerBlock?.properties?.num_channels;
            const numChannels = typeof rawNumCh === 'number' ? rawNumCh
              : typeof rawNumCh === 'string' ? parseInt(rawNumCh, 10)
              : 0;
            numAudioChannelsByProduction.set(id, numChannels);
            // Only initialise registries on first connect for this production.
            // Subsequent connects (refresh, second operator) inherit existing state.
            const isFirstConnect = !afvChannelsByProduction.has(id);
            if (isFirstConnect) {
              afvChannelsByProduction.set(id, new Set());
              mutedElementsByProduction.set(id, new Set());
              // All channels: signal always active, all open to main at start.
              const initProps: Record<string, unknown> = {};
              for (let i = 1; i <= numChannels; i++) {
                initProps[`ch${i}_mute`]    = false;
                initProps[`ch${i}_to_main`] = true;
              }
              await strom.flows.updateBlockProperties(connectDoc.stromFlowId!, audioBlockId, { properties: initProps })
                .catch((err) => console.warn('[controller] init channel props error:', err));
            }
            // Restore fader levels and mute state.
            // Server-side cache (channelLevelsByProduction) is authoritative — it is updated
            // on every AUDIO_SET volume and survives page refreshes / new tabs within the
            // same server session. Strom block properties are used as a fallback for
            // values set before the server started (e.g. pipeline defaults).
            const mutedSet = mutedElementsByProduction.get(id) ?? new Set<string>();
            const levelCache = channelLevelsByProduction.get(id);
            const blockProps = await strom.flows.getBlockProperties(connectDoc.stromFlowId, audioBlockId).catch(() => null);
            for (let i = 1; i <= numChannels; i++) {
              const cachedLevel = levelCache?.get(`ch${i}`);
              const stromLevel = blockProps?.properties[`ch${i}_fader`];
              const volume = cachedLevel ?? (typeof stromLevel === 'number' ? stromLevel : undefined);
              if (volume !== undefined) {
                socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'volume', value: volume }));
              }
              const isMuted = mutedSet.has(`ch${i}`);
              socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'mute', value: isMuted }));
            }
            // Restore main fader level
            const cachedMain = levelCache?.get('main');
            const stromMain = blockProps?.properties['main_fader'];
            const mainVolume = cachedMain ?? (typeof stromMain === 'number' ? stromMain : undefined);
            if (mainVolume !== undefined) {
              socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: 'main', property: 'volume', value: mainVolume }));
            }
            // Restore AUX master state — prefer in-memory cache (set by this session's
            // AUX_MASTER_SET messages), fall back to Strom block properties for the first
            // connect after a server restart when the cache is empty.
            const cachedAuxMasters = auxMasterByProduction.get(id);
            const props = blockProps?.properties ?? {};
            if (cachedAuxMasters && cachedAuxMasters.size > 0) {
              for (const [auxBus, { volume, muted }] of cachedAuxMasters) {
                socket.send(JSON.stringify({ type: 'AUX_MASTER_STATE', auxBus, volume, muted }));
              }
            } else {
              for (const [key, value] of Object.entries(props)) {
                const auxMatch = /^aux(\d+)_fader$/.exec(key);
                if (auxMatch && typeof value === 'number') {
                  const auxBus = parseInt(auxMatch[1], 10);
                  const muted = props[`aux${auxBus}_mute`] === true;
                  socket.send(JSON.stringify({ type: 'AUX_MASTER_STATE', auxBus, volume: value, muted }));
                }
              }
            }
            // Restore GRP master state — same cache-first pattern
            const cachedGrpMasters = grpMasterByProduction.get(id);
            if (cachedGrpMasters && cachedGrpMasters.size > 0) {
              for (const [grpBus, { volume, muted }] of cachedGrpMasters) {
                socket.send(JSON.stringify({ type: 'GRP_MASTER_STATE', grpBus, volume, muted }));
              }
            } else {
              for (const [key, value] of Object.entries(props)) {
                const grpMatch = /^group(\d+)_fader$/.exec(key);
                if (grpMatch && typeof value === 'number') {
                  const grpBus = parseInt(grpMatch[1], 10);
                  const muted = props[`group${grpBus}_mute`] === true;
                  socket.send(JSON.stringify({ type: 'GRP_MASTER_STATE', grpBus, volume: value, muted }));
                }
              }
            }
            // Restore monitor master state — prefer in-memory cache, fall back to Strom block props
            const cachedMonitor = monitorByProduction.get(id);
            if (cachedMonitor) {
              socket.send(JSON.stringify({ type: 'MONITOR_STATE', volume: cachedMonitor.volume, muted: cachedMonitor.muted }));
            } else {
              const monVol = props['monitor_fader'];
              if (typeof monVol === 'number') {
                const monMuted = props['monitor_mute'] === true;
                socket.send(JSON.stringify({ type: 'MONITOR_STATE', volume: monVol, muted: monMuted }));
              }
            }
            // Restore per-channel AUX send state (fader level, ON/OFF, pre/post)
            const cachedAuxSends = auxSendByProduction.get(id);
            if (cachedAuxSends) {
              for (const [key, { level, enabled, pre }] of cachedAuxSends) {
                // key format: 'ch{N}_aux{M}'
                const m = /^(ch\d+)_aux(\d+)$/.exec(key);
                if (m) {
                  socket.send(JSON.stringify({ type: 'AUX_SEND_STATE', elementId: m[1], auxBus: parseInt(m[2], 10), level, enabled, pre }));
                }
              }
            }
            // Restore per-channel GRP send state (G1/G2 assignments + fader level)
            const cachedGrpSends = grpSendByProduction.get(id);
            if (cachedGrpSends) {
              for (const [key, { level, enabled }] of cachedGrpSends) {
                // key format: 'ch{N}_grp{M}'
                const m = /^(ch\d+)_grp(\d+)$/.exec(key);
                if (m) {
                  socket.send(JSON.stringify({ type: 'GRP_SEND_STATE', elementId: m[1], grpBus: parseInt(m[2], 10), level, enabled }));
                }
              }
            }
            // Send current AFV state to this connecting client so it can restore
            // its store without the operator having to re-enable AFV per strip.
            const currentAfvSet = afvChannelsByProduction.get(id) ?? new Set<string>();
            for (const mixerInput of currentAfvSet) {
              socket.send(JSON.stringify({ type: 'AFV_STATE', mixerInput, enabled: true }));
            }
            // Send current PFL/AFL state so newly-connected clients show correct button state.
            for (const elId of (activePflByProduction.get(id) ?? [])) {
              socket.send(JSON.stringify({ type: 'PFL_STATE', elementId: elId, enabled: true }));
            }
            for (const elId of (activeAflByProduction.get(id) ?? [])) {
              socket.send(JSON.stringify({ type: 'AFL_STATE', elementId: elId, enabled: true }));
            }
            // Send current source offset state so newly-connected clients inherit
            // any offsets set by other operators without needing a round-trip.
            const currentOffsets = sourceOffsetsByProduction.get(id);
            if (currentOffsets) {
              for (const [mixerInput, offsetMs] of currentOffsets) {
                socket.send(JSON.stringify({ type: 'SOURCE_OFFSET_STATE', mixerInput, offsetMs }));
              }
            }
            startMeterRelay(id, connectDoc.stromFlowId, audioBlockId, connectDoc.loudnessMainBlockId);
          }
        } catch (err) {
          console.warn('[controller] audio sync error:', err);
        }
      }
    }
  );
};

export default controllerWs;
