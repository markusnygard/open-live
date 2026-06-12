import Nano from 'nano';
import { config } from '../config.js';
import type { ProductionDoc, SourceDoc, ProductionConfigDoc, GraphicDoc, OutputDoc } from './types.js';

/**
 * Mango injection guard.
 * Throws if any value in the selector contains a CouchDB Mango query operator.
 * Use when building selectors that incorporate user-supplied values.
 */
const MANGO_OPERATORS = new Set([
  '$lt', '$lte', '$eq', '$ne', '$gte', '$gt',
  '$exists', '$type', '$in', '$nin', '$size', '$mod',
  '$regex', '$all', '$elemMatch', '$allMatch', '$keyMapMatch',
  '$or', '$and', '$nor', '$not', '$selector',
]);

export function safeSelector(selector: Record<string, unknown>): void {
  for (const [, value] of Object.entries(selector)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (MANGO_OPERATORS.has(key)) {
          throw new Error(`Mango operator "${key}" is not allowed in user-supplied selector values`);
        }
      }
    }
  }
}

let db: Nano.DocumentScope<ProductionDoc>;

export function getDb(): Nano.DocumentScope<ProductionDoc> {
  return db;
}

export function isDbConnected(): boolean {
  return !!db;
}

export function getSourcesDb(): Nano.DocumentScope<SourceDoc> {
  return db as unknown as Nano.DocumentScope<SourceDoc>;
}

export function getConfigsDb(): Nano.DocumentScope<ProductionConfigDoc> {
  return db as unknown as Nano.DocumentScope<ProductionConfigDoc>;
}

export function getGraphicsDb(): Nano.DocumentScope<GraphicDoc> {
  return db as unknown as Nano.DocumentScope<GraphicDoc>;
}

export function getOutputsDb(): Nano.DocumentScope<OutputDoc> {
  return db as unknown as Nano.DocumentScope<OutputDoc>;
}

const DB_NAME = 'open-live';

export async function connectDb(): Promise<void> {
  const nano = Nano(config.couchdbUrl);
  const dbList = await nano.db.list();
  if (!dbList.includes(DB_NAME)) {
    await nano.db.create(DB_NAME);
  }
  db = nano.use<ProductionDoc>(DB_NAME);
}

export async function isDbReady(): Promise<boolean> {
  try {
    // Use the actual working db handle so we test the same path as real queries
    if (!db) return false;
    await db.info();
    return true;
  } catch {
    return false;
  }
}
