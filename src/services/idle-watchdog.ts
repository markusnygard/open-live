/**
 * Idle watchdog — always active.
 *
 * Polls every 10 seconds. Any production that is 'active' and has had
 * zero WebSocket subscribers for IDLE_TIMEOUT_MS continuously is
 * automatically deactivated.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getDb, isDbConnected } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { deactivateStromFlow } from '../lib/flow-generator.js';
import { getSubscriberCount } from './tally.service.js';
import { clearProductionPflState } from './pfl-state.js';
import { clearAudioState, clearPipState } from '../ws/controller.js';
import { broadcast } from './tally.service.js';
import { activationAbortControllers } from '../routes/productions.js';
import type { ProductionDoc } from '../db/types.js';

const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const POLL_INTERVAL_MS = 10 * 1000;    // 10 seconds

/** productionId → timestamp when subscriber count first dropped to 0 */
const idleSince = new Map<string, number>();

let watchdogInterval: NodeJS.Timeout | null = null;

export function getIdleSince(productionId: string): number | undefined {
  return idleSince.get(productionId);
}

export function isWatchdogEnabled(): boolean {
  return watchdogInterval !== null;
}

/** Call immediately when a subscriber connects — clears the idle timer so the
 *  watchdog cannot deactivate the production while someone is connected. */
export function notifySubscriberJoin(productionId: string): void {
  idleSince.delete(productionId);
}



export function startIdleWatchdog(log: FastifyBaseLogger): void {
  log.info(`[idle-watchdog] Idle auto-deactivation enabled (timeout: ${IDLE_TIMEOUT_MS / 1000}s, poll: ${POLL_INTERVAL_MS / 1000}s)`);

  watchdogInterval = setInterval(() => {
    tick(log).catch((err) => log.error({ err }, '[idle-watchdog] Tick error'));
  }, POLL_INTERVAL_MS);

  // Allow the process to exit even if the interval is still running
  watchdogInterval.unref();
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (!isDbConnected()) return;

  type FindResult = Awaited<ReturnType<ReturnType<typeof getDb>['find']>>;
  let result: FindResult;
  try {
    result = await getDb().find({
      selector: { type: 'production', status: { $in: ['active', 'activating'] } },
    });
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    log.warn({ statusCode: e.statusCode, msg: e.message }, '[idle-watchdog] DB query failed — skipping tick');
    return;
  }

  const docs = Array.isArray(result?.docs) ? (result.docs as ProductionDoc[]) : [];
  const now = Date.now();

  for (const doc of docs) {
    const count = getSubscriberCount(doc._id);

    if (count > 0) {
      // Active connections — clear idle timer
      idleSince.delete(doc._id);
      continue;
    }

    // No subscribers — start or check idle timer
    if (!idleSince.has(doc._id)) {
      idleSince.set(doc._id, now);
      log.debug({ productionId: doc._id }, '[idle-watchdog] Production became idle — starting timer');
      continue;
    }

    const idleMs = now - idleSince.get(doc._id)!;
    if (idleMs < IDLE_TIMEOUT_MS) continue;

    // Idle timeout exceeded — deactivate
    log.info(
      { productionId: doc._id, name: doc.name, idleSec: Math.round(idleMs / 1000) },
      '[idle-watchdog] Auto-deactivating idle production',
    );

    idleSince.delete(doc._id);

    try {
      await deactivateProduction(doc, log);
    } catch (err) {
      log.error({ err, productionId: doc._id }, '[idle-watchdog] Failed to deactivate production');
    }
  }

  // Clean up idle timers for productions no longer active
  const activeIds = new Set(docs.map((d) => d._id));
  for (const id of idleSince.keys()) {
    if (!activeIds.has(id)) idleSince.delete(id);
  }
}

async function deactivateProduction(doc: ProductionDoc, log: FastifyBaseLogger): Promise<void> {
  // Cancel any in-progress activation loop
  const abortController = activationAbortControllers.get(doc._id);
  if (abortController) {
    abortController.abort();
    activationAbortControllers.delete(doc._id);
  }

  clearProductionPflState(doc._id);
  clearAudioState(doc._id);
  clearPipState(doc._id);
  broadcast(doc._id, { type: 'GRP_STATE_RESET' });

  if (doc.stromFlowId) {
    try {
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      await deactivateStromFlow(doc.stromFlowId, strom);
    } catch (err) {
      log.warn({ err, productionId: doc._id }, '[idle-watchdog] Strom flow teardown failed — continuing');
    }
  }

  const updated: ProductionDoc = {
    ...doc,
    status: 'inactive',
    stromFlowId: undefined,
    mixerBlockId: undefined,
    audioMixerBlockId: undefined,
    loudnessMainBlockId: undefined,
    sourceOffsetBlockIds: undefined,
    sourceAudioOffsetBlockIds: undefined,
    whepEndpoint: undefined,
    pgmWhepEndpoint: undefined,
    whipEndpoints: undefined,
    srtOutputUri: undefined,
    whepOutputUrls: undefined,
    tally: { pgm: null, pvw: null },
    updatedAt: new Date().toISOString(),
  };

  await getDb().insert(updated);
  log.info({ productionId: doc._id, name: doc.name }, '[idle-watchdog] Production deactivated');
}
