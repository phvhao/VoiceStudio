import { AlertCircleIcon, FilmIcon, RotateCcwIcon } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DUB_VIDEO_FITS, type DubOmission, type DubSegment, type DubVideoFit } from './dub-session';

/** The length factor the last render gave this segment's video (below 1 =
 *  sped up), or undefined when its video was not retimed. */
export function segmentVideoRatio(fit: DubSegment['fit_status']): number | undefined {
  const ratio =
    fit?.video_ratio ?? (fit?.status === 'video_stretched' ? fit.stretch_ratio : undefined);
  return ratio !== undefined && Number.isFinite(ratio) && Math.abs(ratio - 1) >= 0.005
    ? ratio
    : undefined;
}

/** "Video 0.85×" on a segment whose video Smart Fit or Stretch Video retimed. */
export function VideoFitBadge({ fit }: { fit: DubSegment['fit_status'] }) {
  const { t } = useTranslation();
  const ratio = segmentVideoRatio(fit);
  if (ratio === undefined) return null;
  const value = ratio.toFixed(2);
  const title = t(ratio < 1 ? 'segment.fit_video_sped_title' : 'segment.fit_video_slowed_title', {
    ratio: value,
  });
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums"
      title={title}
    >
      <FilmIcon className="size-3" aria-hidden />
      {t('segment.fit_stretched', { ratio: value })}
      <span className="sr-only">{title}</span>
    </span>
  );
}

/** "May be missing content" under a translated line: why, and a second, more
 *  literal translation pass. */
export function OmissionFlag({
  omission,
  disabled,
  onTranslateAgain,
}: {
  omission: DubOmission;
  disabled?: boolean;
  onTranslateAgain: () => void;
}) {
  const { t } = useTranslation();
  const reasonId = useId();
  const reason =
    omission.reason === 'sentences'
      ? t('segment.omission_sentences_title', {
          source: omission.source_sentences,
          target: omission.target_sentences,
        })
      : omission.reason === 'repeated'
        ? t('segment.omission_repeated_title')
        : t('segment.omission_short_title');
  return (
    <div className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 p-1.5 text-xs">
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
        <AlertCircleIcon className="size-3" aria-hidden />
        {t('segment.omission')}
      </span>
      <span id={reasonId} className="min-w-0 flex-1 truncate text-muted-foreground" title={reason}>
        {reason}
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        aria-describedby={reasonId}
        onClick={onTranslateAgain}
      >
        <RotateCcwIcon />
        {t('segment.translate_again')}
      </Button>
    </div>
  );
}

/** Smart Fit's per-line video choice: automatic, Keep, Allow shrink or Allow stretch. */
export function VideoFitControl({
  value,
  mayBeIncomplete,
  disabled,
  onChange,
}: {
  value: DubVideoFit | undefined;
  mayBeIncomplete?: boolean;
  disabled?: boolean;
  onChange: (value: DubVideoFit | undefined) => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <div className="col-span-2 space-y-1" role="group" aria-labelledby={labelId}>
      <span id={labelId}>{t('segment.video_fit')}</span>
      <div className="flex flex-wrap gap-1">
        {([undefined, ...DUB_VIDEO_FITS] as const).map((option) => (
          <Button
            key={option ?? 'auto'}
            size="xs"
            variant={value === option ? 'secondary' : 'ghost'}
            aria-pressed={value === option}
            disabled={disabled}
            title={t('segment.video_fit_' + (option ?? 'auto') + '_title')}
            onClick={() => onChange(option)}
          >
            {t('segment.video_fit_' + (option ?? 'auto'))}
          </Button>
        ))}
      </div>
      {mayBeIncomplete && (
        <p className="text-muted-foreground">{t('segment.video_fit_incomplete')}</p>
      )}
    </div>
  );
}
