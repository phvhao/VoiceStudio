import { useTranslation } from 'react-i18next';
import { AudioWaveformIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ReadingForm,
  ReadingSettingsButton,
  useReadingSummary,
} from '@/components/reading-settings';
import { useReadingSettings } from '@/lib/reading-settings';
import type { Overrides } from '@shared/utils/longformOverrides';
import type { AudiobookRenderChapter } from './longform-session';
import { chapterName } from './chapter-name';

/**
 * A book's reading settings: Settings → Reading by default (summarised, with
 * the quick popover to change it for every workspace), or this project's own.
 */
export function PacingSettings({
  value,
  disabled,
  onChange,
}: {
  value: Overrides;
  disabled: boolean;
  onChange: (value: Overrides) => void;
}) {
  const { t } = useTranslation();
  const { reading: shared } = useReadingSettings();
  const summary = useReadingSummary(shared);
  const own = value.reading;
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer text-sm font-medium">{t('pacing.title')}</summary>
      <div role="group" className="flex gap-1 rounded-lg bg-background/40 p-1">
        <Button
          size="xs"
          className="flex-1"
          variant={own ? 'ghost' : 'secondary'}
          aria-pressed={!own}
          disabled={disabled}
          onClick={() => onChange({ ...value, reading: null })}
        >
          {t('pacing.use_global')}
        </Button>
        <Button
          size="xs"
          className="flex-1"
          variant={own ? 'secondary' : 'ghost'}
          aria-pressed={Boolean(own)}
          disabled={disabled}
          // Start from what the book reads like now.
          onClick={() => onChange({ ...value, reading: own ?? { ...shared } })}
        >
          {t('pacing.project_only')}
        </Button>
      </div>
      {own ? (
        <ReadingForm
          value={own}
          disabled={disabled}
          onChange={(reading) => onChange({ ...value, reading })}
        />
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted-foreground">{summary}</p>
          <ReadingSettingsButton disabled={disabled} />
        </div>
      )}
    </details>
  );
}

/** Phrases the speech check still heard differently, grouped by chapter. */
export function SpeechCheckReport({
  chapters,
  suspects,
}: {
  chapters?: AudiobookRenderChapter[];
  suspects?: string[];
}) {
  const { t } = useTranslation();
  const groups = chapters
    ? chapters
        .map((chapter, index) => ({
          title: chapterName(t, chapters, index),
          texts: chapter.suspects ?? [],
        }))
        .filter((group) => group.texts.length > 0)
    : suspects?.length
      ? [{ title: '', texts: suspects }]
      : [];
  const count = groups.reduce((sum, group) => sum + group.texts.length, 0);
  if (!count) return null;
  return (
    <div
      role="status"
      className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/8 p-3 text-xs"
    >
      <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
        <AudioWaveformIcon className="size-4 shrink-0" aria-hidden="true" />
        {t('pacing.suspect_title', { count })}
      </p>
      <p className="text-muted-foreground">{t('pacing.suspect_hint')}</p>
      <ul className="max-h-48 space-y-1.5 overflow-y-auto">
        {groups.map((group) =>
          group.texts.map((text, index) => (
            <li key={`${group.title}-${index}`} className="leading-relaxed">
              {group.title && <span className="me-1.5 text-muted-foreground">{group.title} ·</span>}
              “{text}”
            </li>
          )),
        )}
      </ul>
    </div>
  );
}
