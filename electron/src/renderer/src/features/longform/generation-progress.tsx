import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, CircleIcon, LoaderCircleIcon, XIcon, ZapIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatClock } from '@/lib/format-clock';
import type { AudiobookRenderChapter, RenderTiming } from './longform-session';
import { chapterName } from './chapter-name';

/**
 * Seconds a render has left, or `null` while nothing tells it yet: the time
 * the chapters rendered so far took, scaled to the chapters still to render
 * and counted down from the last chapter's event, so it never rises while a
 * chapter renders. A chapter weighs a fixed part (setting up its voices, its
 * first take) plus a part that grows with its words, half and half for a
 * chapter of average length. Chapters the cache holds take no time: those
 * that finished as cached, and those the outline found cached before the
 * render started.
 */
export function renderTimeLeft(
  chapters: readonly AudiobookRenderChapter[],
  timing: RenderTiming,
  now: number,
): number | null {
  const { words } = timing;
  const mean = words?.length ? words.reduce((sum, count) => sum + count, 0) / words.length : 0;
  const weight = (index: number) => (words && mean > 0 ? 0.5 + (0.5 * words[index]) / mean : 1);
  let spent = 0;
  let rendered = 0;
  let left = 0;
  let last = timing.startedAt;
  chapters.forEach((chapter, index) => {
    const finishedAt = timing.finishedAt[index];
    if (finishedAt == null) {
      if (timing.cached?.[index] !== true) left += weight(index);
      return;
    }
    // Chapters render one after another: this one took the time since the last.
    if (chapter.status === 'done') {
      spent += finishedAt - last;
      rendered += weight(index);
    }
    last = finishedAt;
  });
  if (!rendered || !left) return null;
  return Math.max(0, (spent / rendered) * left - (now - last)) / 1000;
}

function ChapterStatusIcon({ status }: { status: string }) {
  if (status === 'rendering')
    return <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />;
  if (status === 'done') return <CheckIcon className="size-3.5" />;
  if (status === 'cached') return <ZapIcon className="size-3.5" />;
  if (status === 'failed') return <XIcon className="size-3.5" />;
  return <CircleIcon className="size-3.5" />;
}

export function GenerationProgress({
  chapters,
  assembling,
  timing = null,
}: {
  chapters: AudiobookRenderChapter[];
  assembling: boolean;
  timing?: RenderTiming | null;
}) {
  const { t } = useTranslation();
  const mounted = useRef(performance.now());
  const [now, setNow] = useState(mounted.current);
  const completed = useMemo(
    () =>
      chapters.filter((chapter) => ['done', 'cached', 'failed'].includes(chapter.status)).length,
    [chapters],
  );
  const total = chapters.length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  // From the render's own start, so leaving the page and coming back keeps the count.
  const elapsed = (now - (timing?.startedAt ?? mounted.current)) / 1000;
  const eta = timing && !assembling ? renderTimeLeft(chapters, timing, now) : null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-xl border border-primary/15 bg-primary/5 p-3 shadow-[inset_0_1px_0_rgb(255_255_255/4%)]"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">
          {assembling
            ? t('audiobook.assembling')
            : t('audiobook.progress_summary', { current: completed, total })}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
          {formatClock(elapsed)}
          {eta == null ? '' : ` · ${t('audiobook.eta', { time: formatClock(eta) })}`}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${assembling ? 100 : percent}%` }}
        />
      </div>
      {total > 0 && (
        <ol className="mt-2 max-h-36 space-y-0.5 overflow-y-auto">
          {chapters.map((chapter, index) => (
            <li
              key={index}
              title={chapter.status === 'failed' ? chapter.error : undefined}
              className="flex min-w-0 items-center gap-2 py-0.5 text-xs"
            >
              <span
                className={
                  chapter.status === 'failed'
                    ? 'text-destructive'
                    : chapter.status === 'rendering'
                      ? 'text-primary'
                      : 'text-muted-foreground'
                }
              >
                <ChapterStatusIcon status={chapter.status} />
              </span>
              <span
                className={`truncate ${
                  chapter.status === 'pending'
                    ? 'text-muted-foreground/55'
                    : chapter.status === 'rendering'
                      ? 'font-medium'
                      : 'text-muted-foreground'
                }`}
              >
                {chapterName(t, chapters, index)}
              </span>
              {chapter.status === 'cached' && (
                <span className="shrink-0 text-muted-foreground">
                  · {t('audiobook.cached_tag')}
                </span>
              )}
              {chapter.suspects && chapter.suspects.length > 0 && (
                <span
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                  title={chapter.suspects.join('\n')}
                >
                  · {t('pacing.check_count', { count: chapter.suspects.length })}
                </span>
              )}
              {chapter.status === 'failed' && (
                <span className="min-w-0 truncate text-destructive/80">
                  · {t('audiobook.failed_tag')}
                  {chapter.error ? `: ${chapter.error}` : ''}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
