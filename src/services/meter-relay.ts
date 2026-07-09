import { StromClient } from '../lib/strom.js';
import { config } from '../config.js';
import { getStromToken } from '../lib/strom-token.js';
import { broadcast } from './tally.service.js';

interface RelayEntry {
  stop: () => void;
  refCount: number;
  flowId: string;
  mixerBlockId: string;
}

const relays = new Map<string, RelayEntry>();
const RECONNECT_DELAY_MS = 5000;

export function startMeterRelay(productionId: string, flowId: string, mixerBlockId: string): void {
  const existing = relays.get(productionId);
  if (existing) {
    if (existing.flowId !== flowId || existing.mixerBlockId !== mixerBlockId) {
      // Flow or mixer changed (e.g. production reactivation). Stop the
      // stale relay and create a new one below. The refCount carries
      // over from controller WS connections.
      existing.stop();
      relays.delete(productionId);
      // Fall through to create a new relay
    } else {
      existing.refCount++;
      return;
    }
  }

  const meterPrefix = `${mixerBlockId}:meter:`;
  let stopped = false;
  let wsCleanup: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Channel meter watchdog ---
  // GStreamer level elements only post messages while buffers flow. When a
  // source stops (clip ended, player stopped/paused, SDI unplugged), channel
  // meters simply go silent and the UI would freeze at the last value.
  // Bus meters (main/aux/group/monitor) emit continuously (the audiomixer
  // generates silence), so only channel meters need this.
  const WATCHDOG_STALE_MS = 500;
  const WATCHDOG_TICK_MS = 300;
  const chLastSeen = new Map<string, number>();   // 'ch1' → Date.now()
  const chZeroed = new Set<string>();
  const watchdogTimer = setInterval(() => {
    const now = Date.now();
    for (const [chId, last] of chLastSeen) {
      if (now - last > WATCHDOG_STALE_MS && !chZeroed.has(chId)) {
        chZeroed.add(chId);
        broadcast(productionId, {
          type: 'METER_DATA',
          elementId: chId,
          peak: [-100, -100],
          rms: [-100, -100],
        });
      }
    }
  }, WATCHDOG_TICK_MS);

  function connect() {
    if (stopped) return;

    void getStromToken(config.stromToken).then((token) => {
      if (stopped) return;

      const strom = new StromClient({ baseUrl: config.stromUrl, token });
      console.log(`[meter-relay] Connecting to Strom WS for production ${productionId}, flow ${flowId}`);

      const closeCleanup = strom.connectWebSocket(
        (event) => {
          if (event.type === 'MeterData') {
            const { flow_id, element_id, rms, peak } = event.data;
            if (flow_id !== flowId) return;
            if (!element_id.startsWith(meterPrefix)) return;
            const suffix = element_id.slice(meterPrefix.length);
            if (suffix === 'main') {
              broadcast(productionId, { type: 'METER_DATA', elementId: 'main', peak, rms });
              return;
            }
            if (suffix.startsWith('aux')) {
              const auxNum = parseInt(suffix.slice(3), 10);
              if (Number.isFinite(auxNum)) {
                broadcast(productionId, { type: 'METER_DATA', elementId: `aux${auxNum}`, peak, rms });
              }
              return;
            }
            if (suffix.startsWith('group')) {
              const grpNum = parseInt(suffix.slice(5), 10);
              if (Number.isFinite(grpNum)) {
                broadcast(productionId, { type: 'METER_DATA', elementId: `grp${grpNum}`, peak, rms });
              }
              return;
            }
            const chNum = parseInt(suffix, 10);
            if (Number.isFinite(chNum)) {
              const chId = `ch${chNum}`;
              chLastSeen.set(chId, Date.now());
              chZeroed.delete(chId);
              broadcast(productionId, { type: 'METER_DATA', elementId: chId, peak, rms });
            }
          }
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
    flowId,
    mixerBlockId,
    refCount: 1,
    stop: () => {
      stopped = true;
      clearInterval(watchdogTimer);
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
