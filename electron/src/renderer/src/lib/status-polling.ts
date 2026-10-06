import { isBackendBusy, isBackendReachable } from '@shared/utils/backendStage';

export const ACTIVE_STATUS_POLL_MS = 1_000;
/**
 * Floor for background status polls while the supervisor reports a live but
 * busy (`unresponsive`) backend (#2594, #2601, #2247). Its event loop is held
 * by a job, so every one-second poll from every widget just queues up behind
 * it — occupying the renderer's few sockets per host and, once the job ends,
 * landing on the backend as a burst. Status can wait a few seconds.
 */
export const BUSY_BACKEND_POLL_MS = 5_000;

// Fed by use-backend-status on every supervisor update. Kept here, rather than
// read back from that hook, so this module has no dependency on it.
let currentStage = 'ready';
// When the backend last came back after being out of reach (a crash and Retry,
// a restart): status answered before then came from another process.
let reachableSince = 0;

export function noteBackendStage(stage: string): void {
  if (isBackendReachable(stage) && !isBackendReachable(currentStage)) reachableSince = Date.now();
  currentStage = stage;
}

/** `ms`, lengthened to the busy-backend floor while the backend is stalled. */
export function relaxWhenBackendBusy(ms: number, stage: string = currentStage): number {
  return isBackendBusy(stage) ? Math.max(ms, BUSY_BACKEND_POLL_MS) : ms;
}

/**
 * How long a status poll's answer stays fresh (its `staleTime`): `ms`, its poll
 * interval, so a surface that remounts within one poll — the sidebar does on
 * every Settings visit — asks nothing again. Never across a backend restart: an
 * answer from before the backend last came back up describes a process that is
 * gone (its loaded models, its jobs, its workers), so it is stale at once.
 */
export function statusStaleTime(query: { state: { dataUpdatedAt: number } }, ms: number): number {
  return query.state.dataUpdatedAt < reachableSince ? 0 : ms;
}

export const IDLE_STATUS_POLL_MS = 30_000;
export const IDLE_COMPUTE_TARGET_POLL_MS = 15_000;

export function modelStatusPollMs(activityCount: number, status?: string): number {
  return relaxWhenBackendBusy(
    activityCount > 0 || status === 'loading' ? ACTIVE_STATUS_POLL_MS : IDLE_STATUS_POLL_MS,
  );
}

export function batchStatusPollMs(jobCount: number): number {
  return relaxWhenBackendBusy(jobCount > 0 ? ACTIVE_STATUS_POLL_MS : IDLE_STATUS_POLL_MS);
}

export function loadedModelsPollMs(active: boolean): number {
  return relaxWhenBackendBusy(active ? ACTIVE_STATUS_POLL_MS : IDLE_STATUS_POLL_MS);
}

export function computeTargetPollMs(activeTasks: number | undefined): number {
  return relaxWhenBackendBusy(activeTasks ? ACTIVE_STATUS_POLL_MS : IDLE_COMPUTE_TARGET_POLL_MS);
}
