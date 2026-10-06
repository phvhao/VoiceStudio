import { backendWebSocketUrl } from '@/lib/api/websocket';
import { apiPath } from '@/lib/api/client';
import { queryKeys } from '@/lib/query';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useBackendStatus } from './use-backend-status';
import { isBackendReachable } from '@shared/utils/backendStage';

const EVENT_QUERY_KEYS: Readonly<Record<string, readonly QueryKey[]>> = {
  projects: [['projects']],
  profiles: [queryKeys.profiles],
  dub_history: [['dub-history']],
  export_history: [['export-history']],
  generation_history: [queryKeys.history],
  model_status: [
    queryKeys.engines,
    ['sidebar-model-status'],
    ['loaded-models'],
    ['model-catalogue'],
  ],
};

/**
 * A load announces each step (importing, loading_weights, compiling), but only
 * its end (ready, error) changes what engines, resident models and the catalogue
 * report; the steps in between move the model status line alone. A stage this
 * build does not know refreshes everything, as every stage used to. Performance
 * presets do not depend on a load and keep their own poll.
 */
const MODEL_LOAD_STEPS = new Set(['importing', 'loading_weights', 'compiling']);

function eventQueryKeys(kind: string, event: Record<string, unknown>): readonly QueryKey[] {
  if (kind === 'model_status' && MODEL_LOAD_STEPS.has(String(event.sub_stage)))
    return [['sidebar-model-status']];
  return EVENT_QUERY_KEYS[kind] || [];
}

async function devBackendReady(signal: AbortSignal, remote: boolean): Promise<boolean> {
  if (window.location.protocol === 'app:' || remote) return true;
  try {
    const response = await fetch(apiPath('/health'), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function RealtimeEventSync() {
  const backend = useBackendStatus();
  const client = useQueryClient();
  // Keyed on reachability, not the stage label, for the same reason as
  // CaptureWidget: a `unresponsive` -> `ready` flip is the backend simply
  // finishing its job, not a reason to drop a healthy socket. Depending on
  // `backend.stage` tore the connection down and reconnected on every such
  // flip, which is the reconnect storm this guard exists to avoid (#2430).
  const backendReachable = isBackendReachable(backend.stage);

  useEffect(() => {
    if (!backendReachable) return;
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;
    let connecting = false;
    const request = new AbortController();

    const scheduleReconnect = () => {
      if (!active || reconnectTimer) return;
      const delay = Math.min(1_000 * 2 ** retry, 30_000);
      retry += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (!active || connecting || (socket && socket.readyState < WebSocket.CLOSING)) return;
      connecting = true;
      try {
        if (!(await devBackendReady(request.signal, backend.remote))) {
          scheduleReconnect();
          return;
        }
        const url = await backendWebSocketUrl('/ws/events', backend);
        if (!active) return;
        socket = new WebSocket(url);
        socket.onopen = () => {
          retry = 0;
        };
        socket.onmessage = (message) => {
          let event: Record<string, unknown> | undefined;
          try {
            const parsed: unknown = JSON.parse(String(message.data));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
              event = parsed as Record<string, unknown>;
          } catch {
            return;
          }
          const kind = event?.kind;
          if (!event || typeof kind !== 'string' || !kind || kind === 'ping') return;
          for (const queryKey of eventQueryKeys(kind, event)) {
            void client.invalidateQueries({ queryKey });
          }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = () => {
          socket = null;
          scheduleReconnect();
        };
      } catch {
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    };

    void connect();
    return () => {
      active = false;
      request.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [backend.baseUrl, backend.remote, backendReachable, client]);

  return null;
}
