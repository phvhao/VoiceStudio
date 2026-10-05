import { RotateCcwIcon } from 'lucide-react';
import { castVoice } from './cast-map';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  MAX_VOICE_GAIN_DB,
  setVoiceGain,
  voiceGain,
  voiceGainKey,
  type VoiceGains,
} from '@shared/utils/longformOverrides';
import { DEFAULT_VOICE_ACCENT, voiceAccent } from './voice-palette';

/** A voice's color, as its tags and lane show it in the editor. */
function Swatch({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('me-1.5 inline-block size-2 shrink-0 rounded-full align-middle', className)}
    />
  );
}

/** Formats a voice volume for display: "+3 dB", "0 dB", "-2 dB". */
export function useVoiceGainText() {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, {
    signDisplay: 'exceptZero',
    maximumFractionDigits: 1,
  });
  return (db: number) => t('leveling.db', { value: number.format(db) });
}

/**
 * One voice's own volume, -12…+12 dB in 1 dB steps, added on top of the
 * automatic leveling. The Cast panel and the tag card both edit `voiceGains`
 * through it, so a voice has one volume wherever it is set.
 */
export function VoiceGainControl({
  name,
  value,
  disabled,
  onChange,
}: {
  /** The voice as the user reads it: its cast name, or "Default voice". */
  name: string;
  value: number;
  disabled?: boolean;
  onChange: (db: number) => void;
}) {
  const { t } = useTranslation();
  const text = useVoiceGainText()(value);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{t('leveling.volume')}</span>
      <input
        type="range"
        aria-label={t('leveling.volume_of', { name })}
        aria-valuetext={text}
        className="min-w-0 flex-1 accent-primary"
        min={-MAX_VOICE_GAIN_DB}
        max={MAX_VOICE_GAIN_DB}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output className="w-12 shrink-0 text-right tabular-nums">{text}</output>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('leveling.reset_volume_of', { name })}
        title={t('leveling.reset_volume_of', { name })}
        disabled={disabled || value === 0}
        onClick={() => onChange(0)}
      >
        <RotateCcwIcon />
      </Button>
    </div>
  );
}

export function CastSettings({
  title,
  names,
  voices = names,
  cast,
  profiles,
  disabled,
  onChange,
  voiceGains,
  onVoiceGains,
  defaultVoiceName,
}: {
  /** Panel heading; defaults to the Audiobook "Cast" title. */
  title?: string;
  names: string[];
  /**
   * The script's voice names in the order they take their colors, as the
   * editor colors them; `names` unless the panel lists only some of them.
   */
  voices?: readonly string[];
  cast: Record<string, string>;
  profiles: { id: string; name: string }[];
  disabled: boolean;
  onChange: (cast: Record<string, string>) => void;
  /** Volume per voice; with `onVoiceGains`, the default voice and every name get a volume control. */
  voiceGains?: VoiceGains;
  onVoiceGains?: (gains: VoiceGains) => void;
  /** The default voice's profile name, shown on its volume row. */
  defaultVoiceName?: string;
}) {
  const { t } = useTranslation();
  const gainText = useVoiceGainText();
  const volume = (key: string, name: string) =>
    onVoiceGains && (
      <VoiceGainControl
        name={name}
        value={voiceGain(voiceGains, key)}
        disabled={disabled}
        onChange={(db) => onVoiceGains(setVoiceGain(voiceGains, key, db))}
      />
    );
  return (
    <details className="space-y-3" open={names.length > 0}>
      <summary className="cursor-pointer text-sm font-medium">
        {title ?? t('audiobook.cast')}
      </summary>
      {onVoiceGains && (
        <div className="space-y-1.5">
          <p className="flex items-baseline gap-2 text-sm">
            <Swatch className={cn('me-0 self-center', DEFAULT_VOICE_ACCENT.dot)} />
            <span className="shrink-0 font-medium">{t('audiobook.default_voice')}</span>
            {defaultVoiceName && (
              <span className="truncate text-xs text-muted-foreground">{defaultVoiceName}</span>
            )}
          </p>
          {volume('', t('audiobook.default_voice'))}
          <p className="text-xs text-muted-foreground">{t('leveling.volume_hint')}</p>
        </div>
      )}
      {!names.length && (
        <p className="text-xs text-muted-foreground">{t('audiobook.cast_empty')}</p>
      )}
      {names.map((name) => {
        // `[voice:default]` shares the default voice's volume unless it is cast.
        const gainKey = voiceGainKey(name, cast);
        const gain = voiceGain(voiceGains, gainKey);
        return (
          <details key={name} className="space-y-2">
            <summary className="cursor-pointer text-sm">
              {/* An uncast `[voice:default]` reads in the default voice, as the editor shows it. */}
              <Swatch
                className={gainKey ? voiceAccent(name, voices).dot : DEFAULT_VOICE_ACCENT.dot}
              />
              <span className="font-medium">{name}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {castVoice(cast, name)
                  ? profiles.find((profile) => profile.id === castVoice(cast, name))?.name ||
                    t('modelSettings.unavailable')
                  : t('audiobook.cast_uses_default')}
              </span>
              {onVoiceGains && gain !== 0 && (
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {gainText(gain)}
                </span>
              )}
            </summary>
            {volume(gainKey, name)}
            <div
              className="max-h-48 space-y-1 overflow-y-auto"
              role="group"
              aria-label={(title ?? t('audiobook.cast')) + ': ' + name}
            >
              <Button
                size="sm"
                className="w-full justify-start"
                variant={!castVoice(cast, name) ? 'secondary' : 'ghost'}
                disabled={disabled}
                onClick={() => {
                  const next = { ...cast };
                  delete next[name];
                  onChange(next);
                }}
              >
                {t('stories.defaultVoice')}
              </Button>
              {profiles.map((profile) => (
                <Button
                  key={profile.id}
                  className="w-full justify-start"
                  size="sm"
                  variant={castVoice(cast, name) === profile.id ? 'secondary' : 'ghost'}
                  disabled={disabled}
                  onClick={() => onChange({ ...cast, [name]: profile.id })}
                >
                  {profile.name}
                </Button>
              ))}
            </div>
          </details>
        );
      })}
    </details>
  );
}
