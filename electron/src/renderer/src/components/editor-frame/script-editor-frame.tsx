import { useDeferredValue, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatRuntimeClock } from '@shared/utils/audiobookScript';
import { measureWidth, useEditorMeasure } from '@/features/longform/editor-measure';
import { MeasureToggle, ZoomControl } from '@/features/longform/editor-status-bar';
import { useEditorZoom, useEditorZoomInput, zoomedText } from '@/features/longform/editor-zoom';
import { cn } from '@/lib/utils';
import { scriptCounts } from './script-counts';

/**
 * "312 chars · 54 words · 4 sentences · ~0:21" under the script, with the
 * editor's measure and zoom. The counts follow typing a frame late, so a long
 * script never slows the keystroke itself.
 */
export function ScriptStatusLine({
  text,
  speed,
  zoom,
  onZoomChange,
  className,
}: {
  text: string;
  /** The reading speed the estimate assumes (the voice controls' Speed). */
  speed?: number;
  zoom: number;
  onZoomChange(zoom: number): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const deferred = useDeferredValue(text);
  const counts = useMemo(() => scriptCounts(deferred, speed), [deferred, speed]);
  const [measure, setMeasure] = useEditorMeasure();
  const runtime = formatRuntimeClock(counts.seconds);
  const separator = <span aria-hidden="true"> · </span>;
  return (
    <div
      data-slot="script-status"
      className={cn(
        'flex min-w-0 items-center gap-3 border-t border-border/50 bg-muted/20 px-3 py-1 text-[11px] leading-4 whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      <p className="min-w-0 truncate tabular-nums">
        {t('editor.count_chars', { count: counts.chars })}
        {separator}
        {t('editor.count_words', { count: counts.words })}
        {separator}
        {t('editor.count_sentences', { count: counts.sentences })}
        {separator}
        <span aria-hidden="true" title={t('editor.count_runtime', { time: runtime })}>
          ~{runtime}
        </span>
        <span className="sr-only">{t('editor.count_runtime', { time: runtime })}</span>
      </p>
      <MeasureToggle measure={measure} onChange={setMeasure} className="ms-auto" />
      <ZoomControl zoom={zoom} onChange={onZoomChange} />
    </div>
  );
}

/**
 * The script's box in Clone and Voice Design: the editor fills it, the status
 * line closes it, and Ctrl/⌘ + − 0 or Ctrl+wheel inside it size the script's
 * text (the same per-viewer size as the Audiobook editor), not the app. The
 * script keeps to the reading measure the status line sets (the Audiobook
 * editor's too).
 */
export function ScriptEditorFrame({
  text,
  speed,
  className,
  children,
}: {
  text: string;
  speed?: number;
  className?: string;
  /**
   * The editor, given the type size and leading the zoom asks for, and the
   * text column's widest (its `measure`; none fits the frame).
   */
  children(textStyle: CSSProperties, measure: string | undefined): ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useEditorZoom();
  const [measure] = useEditorMeasure();
  useEditorZoomInput(frame);
  return (
    <div
      ref={frame}
      data-slot="script-editor"
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-clip rounded-xl border border-border/50 bg-background/30 transition-colors focus-within:border-border',
        className,
      )}
    >
      {children(zoomedText(zoom, 1, 1.75), measureWidth(measure))}
      <ScriptStatusLine
        className="shrink-0"
        text={text}
        speed={speed}
        zoom={zoom}
        onZoomChange={setZoom}
      />
    </div>
  );
}
