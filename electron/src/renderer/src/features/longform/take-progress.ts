/**
 * Where a chapter render stands inside its chapter, as the backend streams it
 * (the `progress` events of a render's stream and of a streamed chapter or
 * passage preview): what it waits for — the voice model to load, another job
 * holding the GPU — then how many of the takes it renders are done, and how
 * long one takes on the wall clock (its speech check and retakes included).
 */
export interface TakeProgress {
  /** The chapter's index in the render's plan. */
  index: number;
  phase: 'loading' | 'queued' | 'rendering';
  /** Takes rendered, of the `total` it renders (0 while that is not known). */
  done: number;
  total: number;
  /** The takes are sentences; otherwise parts of up to 800 characters. */
  phrases: boolean;
  /** Seconds one take takes, once one has. */
  rate: number | null;
  /** When this was heard, on the `performance.now()` clock. */
  at: number;
}

const PHASES: ReadonlySet<string> = new Set(['loading', 'queued', 'rendering']);

const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

/** A `progress` event heard at `at`, as the app reads it; `null` for one it cannot read. */
export function takeProgress(event: Record<string, unknown>, at: number): TakeProgress | null {
  if (typeof event.phase !== 'string' || !PHASES.has(event.phase)) return null;
  const done = count(event.done);
  const rate = typeof event.rate === 'number' && event.rate > 0 ? event.rate : null;
  return {
    index: count(event.index),
    phase: event.phase as TakeProgress['phase'],
    done,
    total: Math.max(count(event.total), done),
    phrases: event.phrases === true,
    rate: rate !== null && Number.isFinite(rate) ? rate : null,
    at,
  };
}

/**
 * Seconds the chapter has left at the pace of its takes, counted down from
 * when that was heard, so it never rises while a take renders; `null` while
 * the pace is not known.
 */
export function takeTimeLeft(progress: TakeProgress, now: number): number | null {
  if (progress.phase !== 'rendering' || progress.rate === null || !progress.total) return null;
  const since = Math.max(0, now - progress.at) / 1000;
  return Math.max(0, (progress.total - progress.done) * progress.rate - since);
}
