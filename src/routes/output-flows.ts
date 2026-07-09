import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { outputFlowName } from '../lib/flow-generator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OutputFlowParams {
  /** Production ID */
  id: string;
  /** Output config ID */
  outputId: string;
}

async function makeStromClient(): Promise<StromClient> {
  const token = await getStromToken(config.stromToken).catch(() => undefined);
  return new StromClient({ baseUrl: config.stromUrl, token });
}

// ---------------------------------------------------------------------------
// In-memory tracking of output flow health state
// ---------------------------------------------------------------------------

type FlowHealth = 'stopped' | 'healthy' | 'error'

const healthMap = new Map<string, { state: FlowHealth; since: number }>()

function healthKey(productionId: string, outputId: string): string {
  return `${productionId}:${outputId}`
}

function setHealth(productionId: string, outputId: string, state: FlowHealth) {
  healthMap.set(healthKey(productionId, outputId), { state, since: Date.now() })
}

function getHealth(productionId: string, outputId: string): FlowHealth {
  return healthMap.get(healthKey(productionId, outputId))?.state ?? 'stopped'
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
        if (!flow) return reply.send({ state: 'stopped', health: 'stopped' });

        const running = flow.running === true;
        let health: FlowHealth = 'stopped';

        if (running) {
          health = 'healthy';
          // Check SRT connection status from the monitoring script
          try {
            const srtKey = `srtcheck_${outputId}`;
            const srtDoc = await getDb().get(srtKey).catch(() => null) as any;
            if (srtDoc?.connected === false) {
              health = 'no_clients';
            }
          } catch {}
          setHealth(id, outputId, health);
        } else {
          const prev = getHealth(id, outputId);
          health = prev === 'healthy' || prev === 'no_clients' ? 'error' : 'stopped';
          if (health === 'error') setHealth(id, outputId, 'error');
        }

        return reply.send({
          state: running ? 'running' : 'stopped',
          health,
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
  fastify.post<{ Params: OutputFlowParams }>(
    '/api/v1/productions/:id/outputs/:outputId/start',
    async (req, reply) => {
      const { id, outputId } = req.params;

      try {
        const doc = await getDb().get(id).catch(() => null);
        if (!doc) return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        if (!doc.stromFlowId || doc.status !== 'active') {
          return reply.status(409).send({ error: 'Production is not active', statusCode: 409 });
        }

        const strom = await makeStromClient();

        // Look up the output flow created during activation.
        const existing = await findOutputFlow(strom, id, outputId);
        if (!existing) {
          return reply.status(404).send({
            error: 'Output flow not found — reactivate the production to recreate it',
            statusCode: 404,
          });
        }
        if (existing.running) {
          return reply.status(409).send({ error: 'Output flow already running', statusCode: 409, flowId: existing.id });
        }

        await strom.flows.start(existing.id);
        setHealth(id, outputId, 'healthy');
        return reply.send({ flowId: existing.id, status: 'starting' });
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
        await strom.flows.stop(flow.id).catch(() => {});
        setHealth(id, outputId, 'stopped');
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
