import { StromClient } from '../lib/strom.js';
import { config } from '../config.js';
import { getStromToken } from '../lib/strom-token.js';
import { broadcast } from './tally.service.js';

interface RelayEntry {
  stop: () => void;
  refCount: number;
}

const relays = new Map<string, RelayEntry>();
const RECONNECT_DELAY_MS = 5000;

export function startMeterRelay(productionId: string, flowId: string, mixerBlockId: string): void {
  const existing = relays.get(productionId);
  if (existing) {
    existing.refCount++;
    return;
  }

  const meterPrefix = `${mixerBlockId}:meter:`;
  console.log(`[meter-relay] Starting for production=${productionId} flowId=${flowId} mixerBlockId=${mixerBlockId}`);

  let stopped = false;
  let wsCleanup: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let meterCount = 0;

  function connect() {
    if (stopped) return;

    void getStromToken(config.stromToken).then((token) => {
      if (stopped) return;

      // Build the WS URL for logging (mask token)
      const wsBase = config.stromUrl.replace(/^http/, 'ws');
      console.log(`[meter-relay] Connecting WS to ${wsBase}/api/ws (auth=${token ? 'yes' : 'none'})`);

      const strom = new StromClient({ baseUrl: config.stromUrl, token });

      const closeCleanup = strom.connectWebSocket(
        (event) => {
          if (event.type !== 'MeterData') return;
          meterCount++;
          const { flow_id, element_id, rms, peak } = event.data;
          if (meterCount <= 3) {
            console.log(`[meter-relay] MeterData #${meterCount}: flow_id=${flow_id} element_id=${element_id}`);
          }
          if (flow_id !== flowId) return;
          if (!element_id.startsWith(meterPrefix)) return;
          const suffix = element_id.slice(meterPrefix.length);
          if (suffix === 'main') {
            broadcast(productionId, { type: 'METER_DATA', elementId: 'main', peak, rms });
            return;
          }
          const chNum = parseInt(suffix, 10);
          if (!Number.isFinite(chNum)) return;
          broadcast(productionId, { type: 'METER_DATA', elementId: `ch${chNum}`, peak, rms });
        },
        () => {
          // onClose — schedule reconnect unless intentionally stopped
          if (!stopped) {
            console.log(`[meter-relay] WS closed for production=${productionId}, reconnecting in ${RECONNECT_DELAY_MS}ms`);
            reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
          }
        },
      );

      wsCleanup = closeCleanup;
    }).catch((err: unknown) => {
      if (!stopped) {
        console.warn(`[meter-relay] Token fetch failed, retrying in ${RECONNECT_DELAY_MS}ms:`, err);
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });
  }

  connect();

  relays.set(productionId, {
    refCount: 1,
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsCleanup?.();
    },
  });
}

export function stopMeterRelay(productionId: string): void {
  const entry = relays.get(productionId);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.stop();
    relays.delete(productionId);
  }
}
