import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SquareIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WaveformPlayer } from '@/components/waveform-player';
import { PipelineFailure } from '@/components/pipeline-failure';
import { apiPath, describeError } from '@/lib/api/client';
import type { PublicFailure } from '@/lib/api/failure';
import { chapterPreviewBody, type Draft } from './longform-session';
import { beginAppActivity } from '@/lib/app-activity';
import { TakeProgressText } from './generation-progress';
import { PreviewFailure, requestPreview, settingsChanged, type PreviewLock } from './preview-run';
import { scriptOutline, type OutlineChapter } from './script-outline';
import type { TakeProgress } from './take-progress';

/** A rendered chapter preview: its audio, and which chapter of the plan it is. */
export interface ChapterPreviewOutput {
  output: string;
  /** The plan's index of the chapter. */
  index: number;
  /** Its title as the render names it; `''` when the script gave it none. */
  title: string;
  /** The outline's name for it when it rendered. */
  label?: string;
  /** What its audio was rendered from (`chapterFingerprint`). */
  fingerprint: string | null;
  /** The engine, preset and reading it rendered under (`usePreviewSettings`). */
  settings: string | null;
}

/** A retake asked for takes of chapter `chapter` (the plan's index) again; `id` tells retakes apart. */
export interface RetakenChapter {
  chapter: number;
  id: number;
}

export interface ChapterPreviewState {
  /** Render chapter `index` of the plan, named `label` in the outline, and hold its audio. */
  render(index: number, label?: string): Promise<void>;
  pending: boolean;
  /** How far the render is, as it streams it. */
  progress: TakeProgress | null;
  output: ChapterPreviewOutput | null;
  /** Its chapter changed since: the audio no longer sounds like the chapter. */
  outdated: boolean;
  error: string | null;
  failure: PublicFailure | null;
  /** End the render: the backend stops after the take in progress. */
  stop(): void;
  dismiss(): void;
  /** Put the preview's audio away. */
  close(): void;
}

/**
 * What chapter `index` of the plan renders from: its own text, and the
 * book's settings, voices and cast as they reach it — never another
 * chapter's text, so typing elsewhere leaves its preview current. `null`
 * without such a chapter. `outline` is the script's, when already at hand.
 */
export function chapterFingerprint(
  draft: Draft,
  index: number,
  outline: readonly OutlineChapter[] = scriptOutline(draft.script),
): string | null {
  const chapter = outline.find((node) => node.plan === index);
  if (!chapter) return null;
  const script = draft.script.slice(chapter.start, chapter.end);
  return JSON.stringify(chapterPreviewBody({ ...draft, script }, 0));
}

/**
 * One chapter rendered on its own through `/audiobook/preview`. It shares the
 * full render's chapter and segment caches, so the book reuses what it
 * renders. `onRendered` follows every render (the cache changed). It renders
 * under the page's preview lock (`previews`): the editor stays open, and a
 * preview whose chapter changes meanwhile — or after — is kept, marked
 * `outdated`, as is one whose engine, preset or reading (`settings`) changed
 * since. Once a retake asks for one of its takes again (`retaken`), the audio
 * it holds is an older reading of that chapter, and goes; a render of that
 * chapter still running reads the take as it was, and stops.
 */
export function useChapterPreview(
  draft: Draft,
  {
    disabled,
    canPreview,
    previews,
    onRendered,
    retaken = null,
    outline,
    settings = null,
  }: {
    disabled: boolean;
    canPreview: boolean;
    previews: PreviewLock;
    onRendered?: () => void;
    retaken?: RetakenChapter | null;
    /** The script's outline, when the caller has it. */
    outline?: readonly OutlineChapter[];
    /** What else it sounds like (`usePreviewSettings`). */
    settings?: string | null;
  },
): ChapterPreviewState {
  const [output, setOutput] = useState<ChapterPreviewOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<PublicFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<TakeProgress | null>(null);
  const controller = useRef<AbortController | null>(null);
  // The chapter the render in progress reads, and each chapter's last retake.
  const rendering = useRef<number | null>(null);
  const lastRetake = useRef(new Map<number, number>());
  // Another book opened (or the page left): its preview is not this book's.
  useEffect(() => {
    setOutput(null);
    setError(null);
    setFailure(null);
    return () => controller.current?.abort();
  }, [draft.projectId]);
  const [heard, setHeard] = useState(retaken);
  if (retaken !== heard) {
    setHeard(retaken);
    if (retaken && output?.index === retaken.chapter) setOutput(null);
  }
  useLayoutEffect(() => {
    if (!retaken) return;
    lastRetake.current.set(retaken.chapter, retaken.id);
    if (rendering.current === retaken.chapter) controller.current?.abort();
  }, [retaken]);
  const outdated = useMemo(
    () =>
      output !== null &&
      (chapterFingerprint(draft, output.index, outline) !== output.fingerprint ||
        settingsChanged(output.settings, settings)),
    [draft, output, outline, settings],
  );
  const render = async (chapter: number, label?: string) => {
    if (disabled || controller.current || !canPreview) return;
    if (!previews.acquire('chapter', chapter)) return;
    const current = new AbortController();
    const finishActivity = beginAppActivity('synthesis');
    controller.current = current;
    rendering.current = chapter;
    // What it renders from, as the request leaves.
    const fingerprint = chapterFingerprint(draft, chapter, outline);
    const retake = lastRetake.current.get(chapter);
    setPending(true);
    setProgress(null);
    setError(null);
    setFailure(null);
    try {
      const preview = await requestPreview(chapterPreviewBody(draft, chapter), {
        signal: current.signal,
        onProgress: (heard) => {
          if (!current.signal.aborted) setProgress(heard);
        },
      });
      // An untitled chapter's title is the render's English "Chapter N".
      const title = preview.untitled === true ? '' : (preview.title ?? '');
      // A retake of this chapter meanwhile: the audio reads the take as it was.
      if (!current.signal.aborted && lastRetake.current.get(chapter) === retake)
        setOutput({ output: preview.output, index: chapter, title, label, fingerprint, settings });
    } catch (cause) {
      if (!current.signal.aborted) {
        setError(describeError(cause));
        setFailure(cause instanceof PreviewFailure ? cause.failure : null);
      }
    } finally {
      finishActivity();
      if (controller.current === current) {
        controller.current = null;
        rendering.current = null;
        setPending(false);
        setProgress(null);
        previews.release();
      }
      onRendered?.();
    }
  };
  return {
    render,
    pending,
    progress,
    output,
    outdated,
    error,
    failure,
    stop: () => controller.current?.abort(),
    dismiss: () => {
      setError(null);
      setFailure(null);
    },
    close: () => setOutput(null),
  };
}

/** Marks a preview its text or settings changed since: it no longer sounds like this. */
export function PreviewOutdated() {
  const { t } = useTranslation();
  return (
    <span
      data-slot="preview-outdated"
      title={t('audiobook.preview_outdated_hint')}
      className="shrink-0 rounded-full bg-amber-500/14 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300"
    >
      {t('audiobook.preview_outdated')}
    </span>
  );
}

/**
 * A chapter preview's progress (with Stop), failure or audio: a compact
 * player under the chapter's name. `label` names the chapter as the outline
 * does; without it, its name when it rendered, the render's title, or
 * "Chapter N" in the app's language for an untitled one.
 */
export function ChapterPreview({
  preview,
  label,
}: {
  preview: ChapterPreviewState;
  label?: string;
}) {
  const { t } = useTranslation();
  const output = preview.output;
  const name = output
    ? label || output.label || output.title || t('audiobook.chapter_n', { n: output.index + 1 })
    : '';
  return (
    <>
      {preview.pending && (
        <div className="flex min-w-0 items-center gap-1">
          <p
            role="status"
            data-slot="chapter-preview-progress"
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums"
          >
            {preview.progress ? (
              <TakeProgressText progress={preview.progress} timeLeft />
            ) : (
              t('common.loading')
            )}
          </p>
          <Button size="xs" variant="secondary" onClick={preview.stop}>
            <SquareIcon className="fill-current" />
            {t('common.stop')}
          </Button>
        </div>
      )}
      {preview.error && (
        <PipelineFailure
          failure={preview.failure}
          fallback={preview.error}
          onDismiss={preview.dismiss}
        />
      )}
      {output && (
        <div data-slot="chapter-preview" className="space-y-1">
          <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={name}>
              {name}
            </span>
            {preview.outdated && <PreviewOutdated />}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('common.close')}
              onClick={preview.close}
            >
              <XIcon />
            </Button>
          </p>
          <WaveformPlayer
            compact
            showWaveform={false}
            height={24}
            src={apiPath('/audio/' + encodeURIComponent(output.output))}
            source="chapter-preview"
          />
        </div>
      )}
    </>
  );
}
