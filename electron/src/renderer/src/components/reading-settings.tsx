import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon, SettingsIcon, TextQuoteIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/popover';
import { useReadingSettings } from '@/lib/reading-settings';
import { cn } from '@/lib/utils';
import {
  MAX_PUNCTUATION_PAUSE_MS,
  PUNCTUATION_FAMILIES,
  punctuationPauses,
  type PunctuationFamily,
  type Reading,
} from '@shared/utils/longformOverrides';

// The marks each family covers, as typed in a script.
const MARKS: Record<PunctuationFamily, string> = {
  sentence: '. ! ? ↵',
  ellipsis: '…',
  semicolon: ';',
  colon: ':',
  dash: '—',
  comma: ',',
};

/**
 * How text is read: sentence by sentence with a pause per punctuation mark,
 * and the optional speech check. One form for Settings → Reading, the quick
 * popover on every workspace, and a project's own settings.
 */
export function ReadingForm({
  value,
  disabled,
  onChange,
}: {
  value: Reading;
  disabled: boolean;
  onChange: (value: Reading) => void;
}) {
  const { t } = useTranslation();
  const pauses = punctuationPauses(value);
  const setPause = (family: PunctuationFamily, raw: string) => {
    const next = { ...value.punctuationPauses };
    if (raw.trim() === '') delete next[family];
    else next[family] = Number(raw);
    onChange({ ...value, punctuationPauses: next });
  };
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-2 text-xs">
        {t('pacing.phrase_rendering')}
        <Switch
          disabled={disabled}
          checked={value.phraseRendering}
          onCheckedChange={(phraseRendering) => onChange({ ...value, phraseRendering })}
        />
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('pacing.phrase_rendering_hint')}
      </p>
      {value.phraseRendering && (
        <div role="group" aria-label={t('pacing.pauses')} className="space-y-1.5">
          {PUNCTUATION_FAMILIES.map((family) => (
            <label
              key={family}
              className="flex items-center gap-2 text-xs"
              title={family === 'comma' ? t('pacing.comma_hint') : undefined}
            >
              <span className="w-10 shrink-0 rounded-md bg-muted/60 py-0.5 text-center font-mono text-[11px]">
                {MARKS[family]}
              </span>
              <span className="min-w-0 flex-1 truncate">{t(`pacing.mark_${family}`)}</span>
              <Input
                type="number"
                min={0}
                max={MAX_PUNCTUATION_PAUSE_MS}
                step={50}
                inputMode="numeric"
                aria-label={t(`pacing.mark_${family}`)}
                className="h-7 w-20 px-2 text-right text-xs tabular-nums"
                value={value.punctuationPauses?.[family] ?? pauses[family]}
                disabled={disabled}
                onChange={(event) => setPause(family, event.target.value)}
              />
              <span className="w-5 text-muted-foreground">ms</span>
            </label>
          ))}
          <label className="flex items-center justify-between gap-2 pt-1 text-xs">
            {t('pacing.split_commas')}
            <Switch
              disabled={disabled}
              checked={value.splitCommas}
              onCheckedChange={(splitCommas) => onChange({ ...value, splitCommas })}
            />
          </label>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange({ ...value, punctuationPauses: {}, splitCommas: false })}
          >
            {t('pacing.reset')}
          </Button>
        </div>
      )}
      <label className="flex items-center justify-between gap-2 border-t border-border/50 pt-3 text-xs">
        {t('pacing.verify')}
        <Switch
          disabled={disabled}
          checked={value.verifySpeech}
          onCheckedChange={(verifySpeech) => onChange({ ...value, verifySpeech })}
        />
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('pacing.verify_hint')}</p>
    </div>
  );
}

/** Settings → Reading, edited in place. */
export function GlobalReadingForm({ disabled = false }: { disabled?: boolean }) {
  const { reading, loaded, save } = useReadingSettings();
  return <ReadingForm value={reading} disabled={disabled || !loaded} onChange={save} />;
}

/** One line saying what Settings → Reading currently does. */
export function useReadingSummary(reading: Reading): string {
  const { t } = useTranslation();
  const parts = [
    reading.phraseRendering
      ? t('pacing.summary_phrases', { ms: punctuationPauses(reading).sentence })
      : t('pacing.summary_paragraphs'),
  ];
  if (reading.verifySpeech) parts.push(t('pacing.summary_verify'));
  return parts.join(' · ');
}

/**
 * The quick way in from a workspace: a compact button that opens Settings →
 * Reading in a popover, with a link to the full page.
 */
export function ReadingSettingsButton({
  disabled = false,
  side = 'bottom',
  className,
}: {
  disabled?: boolean;
  /** Open upwards from a bar at the bottom of the window. */
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const { t } = useTranslation();
  const { reading } = useReadingSettings();
  const summary = useReadingSummary(reading);
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        title={summary}
        className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), className)}
      >
        <TextQuoteIcon />
        {t('pacing.button')}
        <ChevronDownIcon className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent side={side} className="max-h-[70vh] w-80 space-y-3 overflow-y-auto p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('pacing.title')}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('pacing.applies_to')}</p>
        </div>
        <GlobalReadingForm disabled={disabled} />
        <Link
          to="/settings/reading"
          className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'w-full justify-start')}
        >
          <SettingsIcon />
          {t('pacing.open_settings')}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
