import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

const ndiSources: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/ndi/sources', async (_req, reply) => {
    try {
      const url = `${config.stromUrl}/api/discovery/ndi/sources`;
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (config.stromToken) {
        headers['Authorization'] = `Bearer ${config.stromToken}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (!resp.ok) {
        return reply.status(502).send({ error: `Strom returned ${resp.status}` });
      }

      const sources = await resp.json();
      return reply.send(sources);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: `NDI discovery unavailable: ${msg}` });
    }
  });
};

export default ndiSources;
