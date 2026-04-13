import { config } from './config.js';
import { connectDb, getDb } from './db/index.js';
import { seedDefaultTemplate } from './db/seed.js';
import { buildServer } from './server.js';
import { StromClient } from './lib/strom.js';
import { getStromToken } from './lib/strom-token.js';
import type { ProductionDoc } from './db/types.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Startup reconciliation: cross-reference each production's stored stromFlowId
 * against the live Strom flow list so the DB reflects reality after a restart.
 *
 * - Productions with a stromFlowId still present in Strom → mark active
 * - Productions with a stromFlowId that no longer exists in Strom → mark inactive
 * - Productions stuck in 'activating' (no live flow) → mark inactive
 *
 * If Strom is unreachable, productions are left as-is (we can't know the truth).
 */
async function reconcileProductionStatuses(
  log: FastifyBaseLogger,
): Promise<void> {
  const db = getDb();

  let liveFlowIds: Set<string>;
  try {
    const stromToken = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
    const { flows } = await strom.flows.list();
    liveFlowIds = new Set(flows.map((f) => f.id));
    log.info({ count: liveFlowIds.size }, '[startup] Fetched Strom flows for reconciliation');
  } catch (err) {
    log.warn({ err }, '[startup] Could not reach Strom — skipping reconciliation');
    return;
  }

  const result = await db.find({ selector: { type: 'production' } });
  for (const doc of result.docs as ProductionDoc[]) {
    const flowAlive = doc.stromFlowId != null && liveFlowIds.has(doc.stromFlowId);

    if (flowAlive && doc.status !== 'active') {
      try {
        await db.insert({ ...doc, status: 'active', updatedAt: new Date().toISOString() } as ProductionDoc);
        log.info({ productionId: doc._id, stromFlowId: doc.stromFlowId }, '[startup] Restored production to active');
      } catch (err) {
        log.error({ err, productionId: doc._id }, '[startup] Failed to restore production to active');
      }
    } else if (!flowAlive && (doc.status === 'active' || doc.status === 'activating')) {
      try {
        await db.insert({ ...doc, status: 'inactive', updatedAt: new Date().toISOString() } as ProductionDoc);
        log.info({ productionId: doc._id }, '[startup] Reset stale production to inactive');
      } catch (err) {
        log.error({ err, productionId: doc._id }, '[startup] Failed to reset production to inactive');
      }
    }
  }
}

async function main() {
  await connectDb();
  await seedDefaultTemplate();

  const app = await buildServer();
  await reconcileProductionStatuses(app.log);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
