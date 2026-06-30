import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

interface Capabilities {
  ndi: boolean;
  sdi: boolean;
  sdiDevices: number;
}

const capabilities: FastifyPluginAsync = async (app) => {
  let cached: Capabilities | null = null;
  let cacheTime = 0;
  const TTL = 30_000;

  app.get('/api/v1/capabilities', async (_req, reply) => {
    if (cached && Date.now() - cacheTime < TTL) return reply.send(cached);

    const caps: Capabilities = { ndi: false, sdi: false, sdiDevices: 0 };

    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (config.stromToken) headers['Authorization'] = `Bearer ${config.stromToken}`;

      // Check NDI via discovery status
      const ndiResp = await fetch(`${config.stromUrl}/api/discovery/devices/status`, {
        headers, signal: AbortSignal.timeout(3000),
      });
      if (ndiResp.ok) {
        const status = await ndiResp.json() as Record<string, unknown>;
        caps.ndi = !!status.ndi_available;
      }

      // Check SDI/DeckLink via device discovery — count actual DeckLink devices
      const devicesResp = await fetch(`${config.stromUrl}/api/discovery/devices`, {
        headers, signal: AbortSignal.timeout(3000),
      });
      if (devicesResp.ok) {
        const devices = await devicesResp.json() as Array<Record<string, unknown>>;
        const decklinkDevices = devices.filter((d) =>
          typeof d.provider === 'string' && d.provider.toLowerCase().includes('decklink')
        );
        caps.sdiDevices = decklinkDevices.length;
        caps.sdi = caps.sdiDevices > 0;
      }

      // Fallback: check blocks API or SDI_DEVICE_COUNT env var
      if (!caps.sdi) {
        // Try environment variable first (most reliable for DeckLink)
        const envCount = parseInt(process.env.SDI_DEVICE_COUNT ?? '', 10);
        if (!isNaN(envCount) && envCount > 0) {
          caps.sdiDevices = envCount;
          caps.sdi = true;
        } else {
          const blocksResp = await fetch(`${config.stromUrl}/api/blocks`, {
            headers, signal: AbortSignal.timeout(3000),
          });
          if (blocksResp.ok) {
            const data = await blocksResp.json() as Record<string, unknown>;
            const blocks = (data.blocks ?? []) as Array<{ id: string }>;
            caps.sdi = blocks.some((b) => b.id === 'builtin.decklink_output');
          }
        }
      }

      cached = caps;
      cacheTime = Date.now();
    } catch {
      // Return last known caps or defaults on error
    }

    return reply.send(cached ?? caps);
  });
};

export default capabilities;
