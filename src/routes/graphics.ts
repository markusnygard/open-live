import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getGraphicsDb, getDb } from '../db/index.js';
import type { GraphicDoc, ProductionDoc } from '../db/types.js';

// Accept both http/https URLs and data: URIs (inline HTML overlays)
const urlOrDataUri = z.string().min(1).refine(
  (s) => s.startsWith('data:') || (() => { try { new URL(s); return true; } catch { return false; } })(),
  { message: 'Must be a valid URL or data URI' },
);

const GraphicInput = z.object({
  name: z.string().min(1),
  url: urlOrDataUri,
});

const GraphicPatch = z.object({
  name: z.string().min(1).optional(),
  url: urlOrDataUri.optional(),
});

function toApi(doc: GraphicDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const graphicsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/graphics', async (_req, reply) => {
    const db = getGraphicsDb();
    const result = await db.find({ selector: { type: 'graphic' } });
    return reply.send(result.docs.map(toApi));
  });

  fastify.post('/api/v1/graphics', async (req, reply) => {
    const body = GraphicInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: GraphicDoc = {
      _id: `gfx-${randomUUID()}`,
      type: 'graphic',
      name: body.name,
      url: body.url,
      createdAt: now,
      updatedAt: now,
    };
    await getGraphicsDb().insert(doc);
    return reply.status(201).send(toApi(doc));
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/graphics/:id', async (req, reply) => {
    try {
      const doc = await getGraphicsDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Graphic not found', statusCode: 404 });
    }
  });

  fastify.patch<{ Params: { id: string } }>('/api/v1/graphics/:id', async (req, reply) => {
    const body = GraphicPatch.parse(req.body);
    try {
      const doc = await getGraphicsDb().get(req.params.id);
      const updated: GraphicDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
      await getGraphicsDb().insert(updated);
      return reply.send(toApi(updated));
    } catch {
      return reply.status(404).send({ error: 'Graphic not found', statusCode: 404 });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/v1/graphics/:id', async (req, reply) => {
    try {
      const doc = await getGraphicsDb().get(req.params.id);

      // Block deletion if the graphic is assigned to an active or activating production
      const activeProductions = await getDb().find({
        selector: { type: 'production', status: { $in: ['active', 'activating'] } },
        fields: ['_id', 'name', 'graphicAssignments'],
        limit: 100,
      });
      const inUse = activeProductions.docs.find((p) => {
        const assignments = (p as unknown as ProductionDoc).graphicAssignments ?? [];
        return assignments.some((a) => a.graphicId === req.params.id);
      });
      if (inUse) {
        const prod = inUse as unknown as Pick<ProductionDoc, '_id' | 'name'>;
        return reply.status(409).send({ error: `Graphic is in use by active production "${prod.name}"` });
      }

      await getGraphicsDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Graphic not found' });
      }
      throw err;
    }
  });
};

export default graphicsRoutes;
