import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import {
  buildOutputFlow,
  findMainFlowInterChannel,
  outputFlowName,
  deactivateStromFlow,
  type OutputFlowConfig,
} from '../lib/flow-generator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OutputFlowParams {
  /** Production ID */
  id: string;
  /** Output config ID */
  outputId: string;
}

const OutputConfigSchema = z.object({
  type: z.enum(['srt', 'efp', 'recording', 'ndi', 'sdi']),
  destination: z.string().optional(),
  bitrate: z.number().optional(),
  deviceNumber: z.number().optional(),
  ndiName: z.string().optional(),
  outputDir: z.string().optional(),
  container: z.string().optional(),
});

const StartBody = z.object({
  config: OutputConfigSchema,
});

async function makeStromClient(): Promise<StromClient> {
  const token = await getStromToken(config.stromToken).catch(() => undefined);
  return new StromClient({ baseUrl: config.stromUrl, token });
}

/**
 * Finds a running output flow by its deterministic name.
 * Returns the flow (id + running state) or null if not found.
 */
async function findOutputFlow(
  strom: StromClient,
  productionId: string,
  outputId: string,
): Promise<{ id: string; running: boolean } | null> {
  const name = outputFlowName(productionId, outputId);
  const { flows } = await strom.flows.list();
  const flow = flows.find((f) => f.name === name);
  if (!flow) return null;
  return { id: flow.id, running: flow.running === true };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const outputFlowRoutes: FastifyPluginAsync = async (fastify) => {
  // Get output flow status
  fastify.get<{ Params: OutputFlowParams }>(
    '/api/v1/productions/:id/outputs/:outputId/status',
    async (req, reply) => {
      const { id, outputId } = req.params;
      try {
        const strom = await makeStromClient();
        const flow = await findOutputFlow(strom, id, outputId);
        if (!flow) return reply.send({ state: 'stopped' });
        return reply.send({
          state: flow.running ? 'running' : 'stopped',
          flowId: flow.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err, id, outputId }, 'Failed to get output flow status');
        return reply.status(500).send({ error: message, statusCode: 500 });
      }
    },
  );

  // Start output flow
  fastify.post<{ Params: OutputFlowParams; Body: { config: OutputFlowConfig } }>(
    '/api/v1/productions/:id/outputs/:outputId/start',
    async (req, reply) => {
      const { id, outputId } = req.params;
      const body = StartBody.parse(req.body);

      try {
        // Load the production to find the running main flow.
        const doc = await getDb().get(id).catch(() => null);
        if (!doc) return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        if (!doc.stromFlowId || doc.status !== 'active') {
          return reply.status(409).send({ error: 'Production is not active', statusCode: 409 });
        }

        const strom = await makeStromClient();

        // Guard: don't start twice.
        const existing = await findOutputFlow(strom, id, outputId);
        if (existing?.running) {
          return reply.status(409).send({ error: 'Output flow already running', statusCode: 409, flowId: existing.id });
        }

        // Resolve the main flow's PGM inter channel to subscribe to.
        const interChannel = await findMainFlowInterChannel(doc.stromFlowId, strom);
        if (!interChannel) {
          return reply.status(409).send({
            error: 'Main production flow has no inter_output to subscribe to',
            statusCode: 409,
          });
        }

        // Build + create + start the output flow.
        const flowBody = buildOutputFlow(id, outputId, interChannel, body.config);
        const created = await strom.flows.create(flowBody);
        const flowId = created.flow.id;

        try {
          await strom.flows.start(flowId);
        } catch (err) {
          await strom.flows.delete(flowId).catch(() => undefined);
          throw err;
        }

        return reply.send({ flowId, status: 'starting' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err, id, outputId }, 'Failed to start output flow');
        return reply.status(500).send({ error: message, statusCode: 500 });
      }
    },
  );

  // Stop output flow
  fastify.post<{ Params: OutputFlowParams }>(
    '/api/v1/productions/:id/outputs/:outputId/stop',
    async (req, reply) => {
      const { id, outputId } = req.params;
      try {
        const strom = await makeStromClient();
        const flow = await findOutputFlow(strom, id, outputId);
        if (!flow) return reply.send({ status: 'stopped' });
        await deactivateStromFlow(flow.id, strom);
        return reply.send({ status: 'stopped' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err, id, outputId }, 'Failed to stop output flow');
        return reply.status(500).send({ error: message, statusCode: 500 });
      }
    },
  );
};

export default outputFlowRoutes;
