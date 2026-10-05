import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WaveformPlayer } from '@/components/waveform-player';
import { PipelineFailure } from '@/components/pipeline-failure';
import { apiJson, apiPath, describeError } from '@/lib/api/client';
import { chapterPreviewBody, type Draft } from './longform-session';
import { beginAppActivity } from '@/lib/app-activity';

export interface ChapterPreviewState {
  /** Render chapter `index` of the plan and hold its audio. */
  render(index: number): Promise<void>;
  pending: boolean;
  output: { output: string; title: string } | null;
  error: string | null;
  dismiss(): void;
}

/**
 * One chapter rendered on its own through `/audiobook/preview`. It shares the
 * full render's chapter and segment caches, so the book reuses what it
 * renders. `onRendered` follows every render (the cache changed).
 */
export function useChapterPreview(
  draft: Draft,
  {
    disabled,
    canPreview,
    onBusy,
    onRendered,
  }: {
    disabled: boolean;
    canPreview: boolean;
    onBusy: (busy: boolean) => void;
    onRendered?: () => void;
  },
): ChapterPreviewState {
  const [output, setOutput] = useState<{ output: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
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
      const preview = await apiJson<{ output: string; title: string }>('/audiobook/preview', {
        method: 'POST',
        body: JSON.stringify(chapterPreviewBody(draft, chapter)),
        signal: current.signal,
      });
      if (!current.signal.aborted) setOutput(preview);
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
  return { render, pending, output, error, dismiss: () => setError(null) };
}

/** A chapter preview's progress, failure or audio. */
export function ChapterPreview({ preview }: { preview: ChapterPreviewState }) {
  const { t } = useTranslation();
  return (
    <>
      {preview.pending && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      {preview.error && <PipelineFailure fallback={preview.error} onDismiss={preview.dismiss} />}
      {preview.output && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{preview.output.title}</p>
          <WaveformPlayer
            showWaveform={false}
            src={apiPath('/audio/' + encodeURIComponent(preview.output.output))}
            source="chapter-preview"
          />
        </div>
      )}
    </>
  );
}
