import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getOutputsDb, getDb } from '../db/index.js';
import type { OutputDoc, ProductionDoc } from '../db/types.js';

const OutputInput = z.object({
  name: z.string().min(1),
  outputType: z.enum(['mpegtssrt', 'efpsrt', 'whep']),
  url: z.string().optional(),
});

const OutputPatch = z.object({
  name: z.string().min(1).optional(),
  url: z.string().optional(),
});

function toApi(doc: OutputDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const outputsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/outputs', async (_req, reply) => {
    const db = getOutputsDb();
    const result = await db.find({ selector: { type: 'output' } });
    return reply.send(result.docs.map(toApi));
  });

  fastify.post('/api/v1/outputs', async (req, reply) => {
    const body = OutputInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: OutputDoc = {
      _id: `output-${randomUUID()}`,
      type: 'output',
      name: body.name,
      outputType: body.outputType,
      url: body.url,
      createdAt: now,
      updatedAt: now,
    };
    await getOutputsDb().insert(doc);
    return reply.status(201).send(toApi(doc));
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    try {
      const doc = await getOutputsDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Output not found', statusCode: 404 });
    }
  });

  fastify.patch<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    const body = OutputPatch.parse(req.body);
    try {
      const doc = await getOutputsDb().get(req.params.id);
      const updated: OutputDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
      await getOutputsDb().insert(updated);
      return reply.send(toApi(updated));
    } catch {
      return reply.status(404).send({ error: 'Output not found', statusCode: 404 });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    try {
      const doc = await getOutputsDb().get(req.params.id);

      const activeProds = await getDb().find({
        selector: { type: 'production', status: { $in: ['active', 'activating'] } },
        fields: ['_id', 'name', 'outputAssignments'],
      });
      const inUse = activeProds.docs.some((p) =>
        (p as unknown as ProductionDoc).outputAssignments?.some((a) => a.outputId === req.params.id),
      );
      if (inUse) {
        return reply.status(409).send({ error: 'Output is used in an active production', statusCode: 409 });
      }

      await getOutputsDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Output not found' });
      }
      throw err;
    }
  });
};

export default outputsRoutes;
