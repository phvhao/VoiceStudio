import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { consumeLongformStream } from '@shared/utils/longformStream';
import type { Overrides } from '@shared/utils/longformOverrides';
import { apiFetch, apiJson } from '@/lib/api/client';
import { publicFailureFromEvent, type PublicFailure } from '@/lib/api/failure';
import { tr } from '@/lib/i18n-text';
import { useReadingSettings } from '@/lib/reading-settings';
import { takeProgress, type TakeProgress } from './take-progress';

/** Which preview holds the lock: a passage, a chapter, or a Stories line. */
export type PreviewKind = 'passage' | 'chapter' | 'line';

/**
 * Previews render one at a time and Generate waits for the one rendering,
 * while the editor, the cast and the settings stay open to edit. `holder`
 * says which kind renders (the Contents rail marks its folded toggle for a
 * chapter's) and `chapter` which chapter a chapter preview is; `acquire`
 * reads a ref, so two previews started in one tick never both start.
 */
export interface PreviewLock {
  holder: PreviewKind | null;
  /** The plan's index of the chapter a chapter preview renders. */
  chapter: number | null;
  busy: boolean;
  /** Take the lock for a preview of `kind` (of `chapter`); false while another holds it. */
  acquire(kind: PreviewKind, chapter?: number): boolean;
  release(): void;
}

export function usePreviewLock(): PreviewLock {
  const held = useRef<PreviewKind | null>(null);
  const [holding, setHolding] = useState<{ kind: PreviewKind; chapter: number | null } | null>(
    null,
  );
  return useMemo(
    () => ({
      holder: holding?.kind ?? null,
      chapter: holding?.chapter ?? null,
      busy: holding !== null,
      acquire(kind, chapter) {
        if (held.current) return false;
        held.current = kind;
        setHolding({ kind, chapter: chapter ?? null });
        return true;
      },
      release() {
        held.current = null;
        setHolding(null);
      },
    }),
    [holding],
  );
}

/**
 * How a retake of chapter `chapter` is heard: `play` (its paragraphs) at once
 * when no preview renders. A preview rendering now reads the take as it was,
 * so a passage stops (`stopPassage`) — and a preview of the retaken chapter
 * stops itself (`useChapterPreview` follows `retaken`) — and `play` waits for
 * the lock to come free. Another chapter's preview renders on: the retake is
 * heard from the next render (`later`).
 */
export function useRetakeHearing(previews: PreviewLock, stopPassage: () => void) {
  const waiting = useRef<(() => void) | null>(null);
  useEffect(() => {
    const play = waiting.current;
    if (previews.busy || !play) return;
    waiting.current = null;
    play();
  }, [previews.busy]);
  return (chapter: number | undefined, { play, later }: { play: () => void; later: () => void }) => {
    if (!previews.busy) play();
    else if (
      previews.holder === 'passage' ||
      (previews.holder === 'chapter' && previews.chapter === chapter)
    ) {
      waiting.current = play;
      if (previews.holder === 'passage') stopPassage();
    } else later();
  };
}

/** `GET /audiobook/sampling`: what a render of the active engine takes for each control left unset. */
interface Sampling {
  engine?: string;
  num_step: number | null;
  guidance_scale: number | null;
  postprocess_output: boolean | null;
}

/**
 * What a preview sounds like beyond its project: the active engine and the
 * sampling its render takes with nothing set (`GET /audiobook/sampling`: the
 * performance preset's steps and postprocessing), and Settings → Reading
 * when the project follows it. A preview keeps the value it rendered under;
 * a different one now marks it outdated. `null` while unknown.
 */
export function usePreviewSettings(reading: Overrides['reading']): string | null {
  // Shared with `storySteps`; a preset, engine or compute change asks it again
  // (RENDER_SETTINGS_DEPENDENTS).
  const sampling = useQuery({
    queryKey: ['longform-sampling', false],
    queryFn: ({ signal }) => apiJson<Sampling>('/audiobook/sampling', { signal }),
    staleTime: 30_000,
  });
  const app = useReadingSettings();
  if (!sampling.data || (!reading && !app.loaded)) return null;
  return JSON.stringify([sampling.data, reading ? null : app.reading]);
}

/** Whether a preview rendered under `then` sounds otherwise under `now` (unknown on either side: no). */
export function settingsChanged(then: string | null, now: string | null): boolean {
  return then !== null && now !== null && then !== now;
}

/** A preview the backend could not render, as its stream explained it. */
export class PreviewFailure extends Error {
  readonly failure: PublicFailure;
  constructor(failure: PublicFailure) {
    super(failure.reason);
    this.name = 'PreviewFailure';
    this.failure = failure;
  }
}

/** `/audiobook/preview`'s answer. */
export type PreviewResult = {
  output: string;
  title?: string;
  untitled?: boolean;
  speech_check?: unknown;
};

/**
 * Render a chapter or passage preview through `/audiobook/preview`, hearing
 * its progress as it renders (`onProgress`). Aborting `signal` closes the
 * request, and the backend stops the render before its next take. A backend
 * from before streamed previews answers once at the end: that answer is used,
 * without progress.
 */
export async function requestPreview(
  body: Record<string, unknown>,
  { signal, onProgress }: { signal: AbortSignal; onProgress?: (progress: TakeProgress) => void },
): Promise<PreviewResult> {
  const response = await apiFetch('/audiobook/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!response.headers.get('content-type')?.includes('text/event-stream'))
    return (await response.json()) as PreviewResult;
  let result: PreviewResult | null = null;
  await consumeLongformStream(
    response,
    (event) => {
      if (event.type === 'progress') {
        const progress = takeProgress(event, performance.now());
        if (progress) onProgress?.(progress);
      } else if (event.type === 'error')
        throw new PreviewFailure(publicFailureFromEvent(event, tr('common.error')));
      else if (event.type === 'done' && typeof event.output === 'string')
        result = event as unknown as PreviewResult;
    },
    { signal },
  );
  signal.throwIfAborted();
  if (!result) throw new Error(tr('dub_workflow.generation_stream_ended'));
  return result;
}
