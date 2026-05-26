import { getSourcesDb, getDb } from './index.js';

/**
 * Removes legacy dev fixtures left over from earlier development iterations.
 * Safe to call on every startup — silently ignores docs that are already gone.
 */
export async function cleanLegacyFixtures(): Promise<void> {
  const sourcesDb = getSourcesDb();
  const productionsDb = getDb();

  type WithRev = { _rev: string };
  const destroy = async (
    database: ReturnType<typeof getSourcesDb>,
    id: string,
  ): Promise<void> => {
    try {
      const doc = await database.get(id) as WithRev;
      await (database as unknown as { destroy: (id: string, rev: string) => Promise<unknown> })
        .destroy(id, doc._rev);
    } catch {
      // already gone — ignore
    }
  };

  await destroy(productionsDb as unknown as ReturnType<typeof getSourcesDb>, 'prod-dev-test');
  await destroy(sourcesDb, 'src-dev-pat-1');
  await destroy(sourcesDb, 'src-dev-pat-2');
  await destroy(sourcesDb, 'src-dev-pat-3');
  await destroy(sourcesDb, 'src-dev-pat-4');
}
