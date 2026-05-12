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
  let stopped = false;
  let wsCleanup: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (stopped) return;

    void getStromToken(config.stromToken).then((token) => {
      if (stopped) return;

      const strom = new StromClient({ baseUrl: config.stromUrl, token });

      const closeCleanup = strom.connectWebSocket(
        (event) => {
          if (event.type !== 'MeterData') return;
          const { flow_id, element_id, rms, peak } = event.data;
          if (flow_id !== flowId) return;
          if (!element_id.startsWith(meterPrefix)) return;
          const suffix = element_id.slice(meterPrefix.length);
          if (suffix === 'main') {
            broadcast(productionId, { type: 'METER_DATA', elementId: 'main', peak, rms });
            return;
          }
          // AUX bus master meters: Strom emits "meter:aux1", "meter:aux2" (1-indexed)
          if (suffix.startsWith('aux')) {
            const auxNum = parseInt(suffix.slice(3), 10);
            if (Number.isFinite(auxNum)) {
              broadcast(productionId, { type: 'METER_DATA', elementId: `aux${auxNum}`, peak, rms });
              return;
            }
          }
          // GROUP bus master meters: Strom emits "meter:group1", "meter:group2" (1-indexed)
          if (suffix.startsWith('group')) {
            const grpNum = parseInt(suffix.slice(5), 10);
            if (Number.isFinite(grpNum)) {
              broadcast(productionId, { type: 'METER_DATA', elementId: `grp${grpNum}`, peak, rms });
              return;
            }
          }
          const chNum = parseInt(suffix, 10);
          if (!Number.isFinite(chNum)) return;
          broadcast(productionId, { type: 'METER_DATA', elementId: `ch${chNum}`, peak, rms });
        },
        () => {
          if (!stopped) {
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
