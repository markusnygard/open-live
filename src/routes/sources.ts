import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getSourcesDb, getDb } from '../db/index.js';
import type { SourceDoc, ProductionDoc } from '../db/types.js';
import { updateProductionDoc } from './productions.js';

const SourceInput = z.object({
  name: z.string().min(1),
  address: z.string(),
  streamType: z.enum(['srt', 'efp', 'whip', 'html']),
  status: z.enum(['active', 'inactive']).default('inactive'),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
});

const SourcePatch = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  streamType: z.enum(['srt', 'efp', 'whip', 'html']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
});

function toApi(doc: SourceDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const sourcesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all sources
  fastify.get('/api/v1/sources', async (_req, reply) => {
    const db = getSourcesDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'source' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/sources — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(toApi));
  });

  // Create a source
  fastify.post('/api/v1/sources', async (req, reply) => {
    const body = SourceInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: SourceDoc = {
      _id: `src-${randomUUID()}`,
      type: 'source',
      name: body.name,
      address: body.address,
      streamType: body.streamType,
      status: body.status,
      liveCamera: body.liveCamera,
      latency: body.latency,
      createdAt: now,
      updatedAt: now,
    };
    await getSourcesDb().insert(doc);
    return reply.status(201).send(toApi(doc));
  });

  // Get a source
  fastify.get<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
    }
  });

  // Update a source
  fastify.patch<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    const body = SourcePatch.parse(req.body);
    try {
      const doc = await getSourcesDb().get(req.params.id);
      const updated: SourceDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
      await getSourcesDb().insert(updated);
      return reply.send(toApi(updated));
    } catch {
      return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
    }
  });

  // Delete a source
  fastify.delete<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);

      // Block deletion if source is used by an active/activating production
      const activeProductions = await getDb().find({
        selector: { type: 'production', status: { $in: ['active', 'activating'] }, 'sources': { $elemMatch: { sourceId: req.params.id } } },
        fields: ['_id', 'name'],
        limit: 1,
      });
      if (activeProductions.docs.length > 0) {
        const prod = activeProductions.docs[0] as unknown as Pick<ProductionDoc, '_id' | 'name'>;
        return reply.status(409).send({ error: `Source is in use by active production "${prod.name}"` });
      }

      // Remove references from inactive productions and record a warning
      const inactiveProductions = await getDb().find({
        selector: { type: 'production', status: 'inactive', 'sources': { $elemMatch: { sourceId: req.params.id } } },
        fields: ['_id', 'name', 'sources', 'deletionWarnings'],
        limit: 100,
      });
      for (const p of inactiveProductions.docs) {
        const prod = p as unknown as ProductionDoc;
        const warnings = prod.deletionWarnings ?? [];
        warnings.push({ type: 'source', name: doc.name });
        await updateProductionDoc(prod._id, {
          sources: prod.sources.filter((s) => s.sourceId !== req.params.id),
          deletionWarnings: warnings,
        });
      }

      await getSourcesDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found' });
      }
      throw err;
    }
  });
};

export default sourcesRoutes;
