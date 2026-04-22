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
  | { type: 'CUT'; mixerInput: string }
  | { type: 'TRANSITION'; mixerInput: string; transitionType: string; durationMs?: number }
  | { type: 'TAKE' }
  | { type: 'SET_PVW'; mixerInput: string }
  | { type: 'FTB'; active?: boolean; durationMs?: number }
  | { type: 'SET_OVL'; alpha: number }
  | { type: 'GO_LIVE' }
  | { type: 'CUT_STREAM' }
  | { type: 'GRAPHIC_ON'; overlayId: string }
  | { type: 'GRAPHIC_OFF'; overlayId: string }
  | { type: 'DSK_TOGGLE'; layer: number; visible?: boolean }
  | { type: 'MACRO_EXEC'; macroId: string }
  | { type: 'AUDIO_SET'; elementId: string; property: 'volume' | 'mute'; value: unknown };

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

function toStromTransition(type: string): StromTransitionType {
  if (type === 'mix' || type === 'dip') return 'fade';
  if (type === 'push') return 'slide_left';
  return 'cut';
}

async function makeStromClient(): Promise<StromClient> {
  const token = await getStromToken(config.stromToken).catch(() => undefined);
  return new StromClient({ baseUrl: config.stromUrl, token });
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
    await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { input: toIndex });
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
// Audio follow
// ---------------------------------------------------------------------------

/**
 * Routes only the PGM source to the main mix bus by setting each channel's
 * to_main_vol routing element to 1.0 (PGM) or 0.0 (everything else).
 * This leaves the volume/mute element untouched so meters and faders continue
 * to function normally on all sources.
 */
async function applyAudioFollow(
  doc: ProductionDoc,
  newPgmMixerInput: string | null,
  stromFlowId: string,
  audioBlockId: string,
  strom: StromClient,
): Promise<void> {
  const sorted = [...doc.sources].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
  const sourcesDb = getSourcesDb();

  let audioIdx = 0;
  for (const assignment of sorted) {
    let streamType: string | undefined;
    try {
      const src = await sourcesDb.get(assignment.sourceId);
      streamType = src.streamType;
    } catch {
      continue; // virtual source — no audio channel
    }
    if (streamType === 'html' || streamType === 'whip') continue;

    const chIdx = ++audioIdx;
    const routeLevel = assignment.mixerInput === newPgmMixerInput ? 1.0 : 0.0;
    const elemId = `${audioBlockId}:to_main_vol_${chIdx - 1}`;
    try {
      await strom.properties.updateElement(stromFlowId, elemId, {
        property_name: 'volume',
        value: routeLevel,
      });
      console.log(`[controller] audio follow ch${chIdx} ${elemId} → ${routeLevel}`);
    } catch (err) {
      console.warn(`[controller] audio follow ch${chIdx} ${elemId} error:`, err);
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
        void applyAudioFollow(doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient());
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
        void applyAudioFollow(doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient());
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
        void applyAudioFollow(doc, tally.pvw, doc.stromFlowId, ctx.audioBlockId, await makeStromClient());
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
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { input: inputIndex });
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
        let elementId: string;
        let property: string;
        if (msg.elementId === 'main') {
          elementId = `${ctx.audioBlockId}:main_volume`;
          property = msg.property === 'volume' ? 'volume' : 'mute';
        } else {
          const chMatch = /^ch(\d+)$/.exec(msg.elementId);
          if (!chMatch) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid audio channel id' }));
            break;
          }
          const ch = parseInt(chMatch[1], 10);
          elementId = `${ctx.audioBlockId}:volume_${ch - 1}`;
          property = msg.property === 'volume' ? 'volume' : 'mute';
        }
        await strom.properties.updateElement(doc.stromFlowId, elementId, { property_name: property, value: msg.value });
        broadcast(productionId, { type: 'AUDIO_STATE', elementId: msg.elementId, property: msg.property, value: msg.value });
      } catch (err) {
        console.warn('[controller] Strom audio update error:', err);
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
      });

      // Fetch production doc once for connect-time sync
      let connectDoc: ProductionDoc | null = null;
      try {
        connectDoc = await getDb().get(id) as ProductionDoc;
      } catch { /* production not found */ }

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
          console.log(`[controller] flow blocks: ${blocks.map((b) => `${b.block_definition_id}(${b.id})`).join(', ')}`);
          const mixerBlock = blocks.find((b) => b.block_definition_id === 'builtin.mixer');
          console.log(`[controller] audio mixerBlock: ${mixerBlock ? `id=${mixerBlock.id}` : 'NOT FOUND'}`);
          if (mixerBlock) {
            ctx.audioBlockId = mixerBlock.id;
            // Apply audio follow immediately so production starts with only PGM audible
            void applyAudioFollow(connectDoc, connectDoc.tally?.pgm ?? null, connectDoc.stromFlowId, mixerBlock.id, strom);
            const rawCh = mixerBlock.properties?.num_channels;
            const numChannels = typeof rawCh === 'number' ? rawCh : typeof rawCh === 'string' ? parseInt(rawCh, 10) || 0 : 0;
            // Read live element properties (block properties don't store fader/mute state)
            for (let i = 1; i <= numChannels; i++) {
              try {
                const res = await strom.properties.getElement(connectDoc.stromFlowId, `${mixerBlock.id}:volume_${i - 1}`);
                const volume = res.properties['volume'];
                const mute = res.properties['mute'];
                if (typeof volume === 'number') {
                  socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'volume', value: volume }));
                }
                if (typeof mute === 'boolean') {
                  socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'mute', value: mute }));
                }
              } catch { /* element not yet ready or unavailable */ }
            }
            // Read main fader level
            try {
              const res = await strom.properties.getElement(connectDoc.stromFlowId, `${mixerBlock.id}:main_volume`);
              const volume = res.properties['volume'];
              if (typeof volume === 'number') {
                socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: 'main', property: 'volume', value: volume }));
              }
            } catch { /* main volume element not yet ready */ }
            if (typeof mixerBlock.id === 'string') {
              startMeterRelay(id, connectDoc.stromFlowId, mixerBlock.id);
            }
          }
        } catch (err) {
          console.warn('[controller] audio sync error:', err);
        }
      }
    }
  );
};

export default controllerWs;
