import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WaveformPlayer } from '@/components/waveform-player';
import { PipelineFailure } from '@/components/pipeline-failure';
import { apiJson, apiPath, describeError } from '@/lib/api/client';
import { chapterPreviewBody, type Draft } from './longform-session';
import { beginAppActivity } from '@/lib/app-activity';

/** A rendered chapter preview: its audio, and which chapter of the plan it is. */
export interface ChapterPreviewOutput {
  output: string;
  /** The plan's index of the chapter. */
  index: number;
  /** Its title as the render names it; `''` when the script gave it none. */
  title: string;
}

/** A retake asked for takes of chapter `chapter` (the plan's index) again; `id` tells retakes apart. */
export interface RetakenChapter {
  chapter: number;
  id: number;
}

export interface ChapterPreviewState {
  /** Render chapter `index` of the plan and hold its audio. */
  render(index: number): Promise<void>;
  pending: boolean;
  output: ChapterPreviewOutput | null;
  error: string | null;
  dismiss(): void;
  /** Put the preview's audio away. */
  close(): void;
}

/**
 * One chapter rendered on its own through `/audiobook/preview`. It shares the
 * full render's chapter and segment caches, so the book reuses what it
 * renders. `onRendered` follows every render (the cache changed). Once a
 * retake asks for one of its takes again (`retaken`), the audio it holds is
 * an older reading of that chapter, and goes.
 */
export function useChapterPreview(
  draft: Draft,
  {
    disabled,
    canPreview,
    onBusy,
    onRendered,
    retaken = null,
  }: {
    disabled: boolean;
    canPreview: boolean;
    onBusy: (busy: boolean) => void;
    onRendered?: () => void;
    retaken?: RetakenChapter | null;
  },
): ChapterPreviewState {
  const [output, setOutput] = useState<ChapterPreviewOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [heard, setHeard] = useState(retaken);
  if (retaken !== heard) {
    setHeard(retaken);
    if (retaken && output?.index === retaken.chapter) setOutput(null);
  }
  // A preview is stale once the request it came from would change. Deriving
  // the key from that request keeps every input it reads (a voice's volume
  // included) in step without a list to maintain here.
  const fingerprint = JSON.stringify(chapterPreviewBody(draft, 0));
  useEffect(() => {
    setOutput(null);
    setError(null);
    return () => {
      controller.current?.abort();
    };
  }, [fingerprint]);
  const render = async (chapter: number) => {
    if (disabled || controller.current || !canPreview) return;
    const current = new AbortController();
    const finishActivity = beginAppActivity('synthesis');
    controller.current = current;
    onBusy(true);
    setPending(true);
    setError(null);
    try {
      const preview = await apiJson<{ output: string; title?: string; untitled?: boolean }>(
        '/audiobook/preview',
        {
          method: 'POST',
          body: JSON.stringify(chapterPreviewBody(draft, chapter)),
          signal: current.signal,
        },
      );
      // An untitled chapter's title is the render's English "Chapter N".
      const title = preview.untitled === true ? '' : (preview.title ?? '');
      if (!current.signal.aborted) setOutput({ output: preview.output, index: chapter, title });
    } catch (cause) {
      if (!current.signal.aborted) setError(describeError(cause));
    } finally {
      finishActivity();
      if (controller.current === current) {
        controller.current = null;
        setPending(false);
        onBusy(false);
      }
      onRendered?.();
    }
  };
  return {
    render,
    pending,
    output,
    error,
    dismiss: () => setError(null),
    close: () => setOutput(null),
  };
}

/**
 * A chapter preview's progress, failure or audio: a compact player under the
 * chapter's name. `label` names the chapter as the outline does; without it,
 * the render's title, or "Chapter N" in the app's language for an untitled one.
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
    ? label || output.title || t('audiobook.chapter_n', { n: output.index + 1 })
    : '';
  return (
    <>
      {preview.pending && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      {preview.error && <PipelineFailure fallback={preview.error} onDismiss={preview.dismiss} />}
      {output && (
        <div data-slot="chapter-preview" className="space-y-1">
          <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={name}>
              {name}
            </span>
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
