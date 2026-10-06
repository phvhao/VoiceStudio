import { useQuery } from '@tanstack/react-query';
import type { BatchJob } from '@shared/api/batch-types';
import { apiJson } from '@/lib/api/client';
import { batchStatusPollMs, statusStaleTime } from '@/lib/status-polling';

/**
 * Queued and running batch jobs. The status bar, the performance presets, the
 * update check and the Batch page all read this one list, so they share its
 * request and cadence here: observers of one key that disagree on the URL or
 * the interval each replace the cached list, and the fastest sets the pace.
 */
export const ACTIVE_BATCH_JOBS_QUERY_KEY = ['batch-jobs', 'active'] as const;

function pollMs(query: { state: { data?: BatchJob[] } }) {
  return batchStatusPollMs(query.state.data?.length ?? 0);
}

export function useActiveBatchJobs(enabled = true) {
  return useQuery({
    queryKey: ACTIVE_BATCH_JOBS_QUERY_KEY,
    queryFn: ({ signal }) => apiJson<BatchJob[]>('/batch/jobs?status=active&limit=100', { signal }),
    enabled,
    // A remount within one poll reuses the list; enqueueing invalidates it,
    // and a backend restart ends it.
    staleTime: (query) => statusStaleTime(query, pollMs(query)),
    refetchInterval: pollMs,
  });
}
