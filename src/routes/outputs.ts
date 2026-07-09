import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getOutputsDb, getDb } from '../db/index.js';
import type { OutputDoc, ProductionDoc } from '../db/types.js';
import { updateProductionDoc } from './productions.js';

const OutputInput = z.object({
  name: z.string().min(1),
  outputType: z.enum(['mpegtssrt', 'efpsrt', 'whep', 'ndi', 'sdi', 'recorder']),
  url: z.string().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
  videoSource: z.string().optional(),
  audioSource: z.string().optional(),
  outputDir: z.string().optional(),
  container: z.string().optional(),
});

const OutputPatch = z.object({
  name: z.string().min(1).optional(),
  url: z.string().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
  videoSource: z.string().optional(),
  audioSource: z.string().optional(),
  outputDir: z.string().optional(),
  container: z.string().optional(),
});

function toApi(doc: OutputDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const outputsRoutes: FastifyPluginAsync = async (fastify) => {
  // List recorder output directories from the filesystem
  fastify.get('/api/v1/recorder/dirs', async (req, reply) => {
    try {
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const basePath = (req.query as Record<string, string>).path || '';
      const showFiles = (req.query as Record<string, string>).files === '1';
      const resolved = nodePath.resolve('/', basePath);
      if (!resolved.startsWith('/')) return reply.send({ dirs: [], files: [], path: basePath, parent: null, root: '/' });
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort();
      const parent = basePath ? nodePath.dirname(basePath) : null;
      const result: any = { dirs, path: basePath, parent: parent === '.' ? '' : parent, root: '/' };
      if (showFiles) {
        const mediaExts = new Set(['.mp4','.mkv','.webm','.mov','.avi','.mxf','.mp3','.wav','.flac','.aac','.ogg','.png','.jpg','.jpeg','.webp','.gif','.bmp']);
        result.files = entries.filter((e) => e.isFile() && mediaExts.has(nodePath.extname(e.name).toLowerCase())).map((e) => e.name).sort();
      }
      return reply.send(result);
    } catch (err: any) {
      return reply.send({ dirs: [], files: [], path: (req.query as any)?.path || '', parent: null, root: '/', error: err?.code === 'EACCES' ? 'Permission denied' : undefined });
    }
  });
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
      latency: body.latency,
      outputDir: body.outputDir,
      container: body.container,
      audioSource: body.audioSource,
      videoSource: body.videoSource,
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

      // Block deletion if output is used by an active/activating production
      const allProds = await getDb().find({
        selector: { type: 'production' },
        fields: ['_id', 'name', 'status', 'outputAssignments', 'deletionWarnings'],
        limit: 200,
      });
      const activeInUse = allProds.docs.some((p) => {
        const prod = p as unknown as ProductionDoc;
        return (prod.status === 'active' || prod.status === 'activating') &&
          prod.outputAssignments?.some((a) => a.outputId === req.params.id);
      });
      if (activeInUse) {
        return reply.status(409).send({ error: 'Output is used in an active production', statusCode: 409 });
      }

      // Remove references from inactive productions and record a warning
      for (const p of allProds.docs) {
        const prod = p as unknown as ProductionDoc;
        if (prod.status !== 'inactive') continue;
        if (!prod.outputAssignments?.some((a) => a.outputId === req.params.id)) continue;
        const warnings = prod.deletionWarnings ?? [];
        warnings.push({ type: 'output', name: doc.name });
        await updateProductionDoc(prod._id, {
          outputAssignments: (prod.outputAssignments ?? []).filter((a) => a.outputId !== req.params.id),
          deletionWarnings: warnings,
        });
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
  // SRT connection health check — called by host-level monitoring script
  fastify.post<{ Params: { id: string }; Body: { connected: boolean } }>(
    '/api/v1/outputs/:id/srt-check',
    async (req, reply) => {
      try {
        const { connected } = req.body;
        await getOutputsDb().get(req.params.id); // verify exists
        const key = `srtcheck_${req.params.id}`;
        const now = new Date().toISOString();
        try {
          const existing = await getDb().get(key) as any;
          await getDb().insert({ ...existing, connected, updatedAt: now } as any);
        } catch {
          await getDb().insert({ _id: key, connected, updatedAt: now } as any);
        }
        return reply.send({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, 'Failed srt check');
        return reply.status(500).send({ error: message, statusCode: 500 });
      }
    },
  );
};

export default outputsRoutes;
