import { useCallback } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { apiJson } from '@/lib/api/client';
import { refreshRenderSettingsDependents } from '@/lib/render-settings';
import {
  ACTIVE_STATUS_POLL_MS,
  IDLE_STATUS_POLL_MS,
  computeTargetPollMs,
  relaxWhenBackendBusy,
  statusStaleTime,
} from '@/lib/status-polling';

export interface ComputeTarget {
  id: string;
  label: string;
  endpoint: string;
  connected: boolean;
  available: boolean;
  detail: string;
  is_local?: boolean;
  status: 'ready' | 'busy' | 'offline';
  latency_ms: number;
  active_tasks: number;
  max_tasks: number;
  cpu_percent: number | null;
  free_memory_bytes: number | null;
  system_memory_bytes: number;
  cpu_count: number;
  gpu_name: string;
  gpu_memory_bytes: number;
  gpu_utilization_percent: number | null;
}

export interface ComputeTargetState {
  target: string;
  op: string;
  active: {
    remote: boolean;
    worker_id?: string;
    label: string;
    reason: string;
  };
  remote_operations: string[];
  targets: ComputeTarget[];
}

export interface ComputeRuntimeCapability {
  engine: string;
  model_id: string;
  display_name?: string;
  repo_ids?: string[];
  backend?: string;
  supported: boolean;
  installed: boolean;
  downloaded: boolean;
  resident: boolean;
}

export interface ComputeRuntimeStatus {
  target: string;
  remote: boolean;
  label: string;
  reason: string;
  models: ComputeRuntimeCapability[];
}

/** The target-wide answer every surface shares; see computeTargetForOperation. */
export const COMPUTE_TARGET_QUERY_KEY = ['workers', 'target', ''] as const;

/**
 * What `GET /workers/target?op=` answers, derived from the target-wide answer the
 * way the backend derives it (worker/routing.status_for_operation): an operation
 * no worker can run stays local, and every other one follows the target. One
 * request then serves the status bar and every page's readiness and language
 * checks instead of one poll per operation.
 */
export function computeTargetForOperation(
  state: ComputeTargetState | undefined,
  op: string,
): ComputeTargetState | undefined {
  if (!state || !op) return state;
  // Absent on a control plane that predates per-operation routing.
  if (state.target === 'local' || !state.remote_operations || state.remote_operations.includes(op))
    return { ...state, op };
  return {
    ...state,
    op,
    active: {
      remote: false,
      label: 'Local',
      reason: `${op} does not run remotely yet — running locally`,
    },
  };
}

function targetPollMs(query: { state: { data?: ComputeTargetState } }) {
  const state = query.state.data;
  return computeTargetPollMs(state?.targets.find((item) => item.id === state.target)?.active_tasks);
}

export function useComputeTarget(enabled = true, op = '') {
  const select = useCallback(
    (state: ComputeTargetState) => computeTargetForOperation(state, op)!,
    [op],
  );
  return useQuery({
    queryKey: COMPUTE_TARGET_QUERY_KEY,
    queryFn: ({ signal }) => apiJson<ComputeTargetState>('/workers/target', { signal }),
    select,
    enabled,
    // A remount within one poll (the sidebar remounts on every Settings visit)
    // reuses the answer instead of asking again, until the backend restarts.
    staleTime: (query) => statusStaleTime(query, targetPollMs(query)),
    refetchInterval: targetPollMs,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useComputeRuntime(
  target: string | undefined,
  engine: string | undefined,
  op = 'tts',
  enabled = true,
  busy = false,
) {
  return useQuery({
    queryKey: ['workers', 'runtime', target, op, engine],
    queryFn: ({ signal }) =>
      apiJson<ComputeRuntimeStatus>(
        `/workers/runtime?op=${encodeURIComponent(op)}&engine=${encodeURIComponent(engine ?? '')}`,
        { signal },
      ),
    enabled: enabled && Boolean(target && engine),
    refetchInterval: () => relaxWhenBackendBusy(busy ? ACTIVE_STATUS_POLL_MS : IDLE_STATUS_POLL_MS),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export async function selectComputeTarget(client: QueryClient, target: string) {
  const next = await apiJson<ComputeTargetState>('/workers/target', {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
  client.setQueryData(COMPUTE_TARGET_QUERY_KEY, next);
  await Promise.all([
    client.invalidateQueries({ queryKey: ['workers'] }),
    client.invalidateQueries({ queryKey: ['model-catalogue'] }),
    client.invalidateQueries({ queryKey: ['model-recommendations'] }),
    client.invalidateQueries({ queryKey: ['model-install-jobs'] }),
    client.invalidateQueries({ queryKey: ['engines'] }),
    client.invalidateQueries({ queryKey: ['loaded-models'] }),
    client.invalidateQueries({ queryKey: ['performance-profile'] }),
    // A chapter rendered on a worker is cached under its own key.
    refreshRenderSettingsDependents(client),
  ]);
  return next;
}
