import Nano from 'nano';
import { config } from '../config.js';
import type { ProductionDoc, SourceDoc, ProductionConfigDoc, GraphicDoc, OutputDoc } from './types.js';

let db: Nano.DocumentScope<ProductionDoc>;

export function getDb(): Nano.DocumentScope<ProductionDoc> {
  return db;
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

export async function connectDb(): Promise<void> {
  const nano = Nano(config.couchdbUrl);
  const dbList = await nano.db.list();
  if (!dbList.includes(config.couchdbName)) {
    await nano.db.create(config.couchdbName);
  }
  db = nano.use<ProductionDoc>(config.couchdbName);
}

export async function isDbReady(): Promise<boolean> {
  try {
    const nano = Nano(config.couchdbUrl);
    await nano.db.list();
    return true;
  } catch {
    return false;
  }
}
