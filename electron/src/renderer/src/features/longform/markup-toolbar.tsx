import { useState, type ComponentType, type ReactNode } from 'react';
import {
  AnnoyedIcon,
  AudioLinesIcon,
  BoldIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleQuestionMarkIcon,
  HeadingIcon,
  LaughIcon,
  PauseIcon,
  PlusIcon,
  RabbitIcon,
  RotateCcwIcon,
  SearchIcon,
  SmileIcon,
  SpeechIcon,
  SpellCheckIcon,
  TurtleIcon,
  WindIcon,
  ZapIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/popover';
import { ProfileAvatar } from '@/components/profile-avatar';
import { cn } from '@/lib/utils';
import { castVoice } from './cast-map';
import { MARKUP_STYLES } from './markup-textarea';
import {
  PAUSE_MAX_MS,
  PAUSE_PRESETS,
  VOICE_RESET_TOKEN,
  applyVoice,
  castNameForProfile,
  countHeadings,
  expressionGroups,
  expressionVariant,
  formatPauseSeconds,
  insertChapter,
  insertToken,
  pauseToken,
  pronounceSelection,
  sanitizeCastName,
  wrapSelection,
  type DeliveryTag,
  type MarkupEdit,
  type MarkupKind,
} from './script-markup';

/** The textarea the toolbar writes into, and how to commit a new value. */
export interface MarkupTarget {
  element: HTMLTextAreaElement;
  setText(value: string): void;
}

type Profile = { id: string; name: string };

const EXPRESSION_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  laugh: LaughIcon,
  sigh: WindIcon,
  question: CircleQuestionMarkIcon,
  surprise: ZapIcon,
  confirm: CircleCheckIcon,
  dissatisfaction: AnnoyedIcon,
};

const DELIVERY: { tag: DeliveryTag; icon: ComponentType; label: string; hint: string }[] = [
  { tag: 'slow', icon: TurtleIcon, label: 'audiobook.insert_slow', hint: 'markup.slow_hint' },
  { tag: 'fast', icon: RabbitIcon, label: 'audiobook.insert_fast', hint: 'markup.fast_hint' },
  {
    tag: 'emphasis',
    icon: BoldIcon,
    label: 'audiobook.insert_emphasis',
    hint: 'markup.emphasis_hint',
  },
  {
    tag: 'spell',
    icon: SpellCheckIcon,
    label: 'audiobook.insert_spell',
    hint: 'markup.spell_hint',
  },
];

// Above this many profiles the voice picker gets a search field.
const VOICE_SEARCH_MIN = 7;

/**
 * The `[voice:NAME]` name for a profile, casting it to the profile when the
 * name is new, so scripts carry readable names instead of profile ids.
 */
export function castProfileVoice(
  profile: Profile,
  voiceCast: Record<string, string>,
  onVoiceCast: (cast: Record<string, string>) => void,
): string {
  const name = castNameForProfile(profile, voiceCast);
  if (castVoice(voiceCast, name) !== profile.id) onVoiceCast({ ...voiceCast, [name]: profile.id });
  return name;
}

/**
 * Apply an edit to the target textarea. `insertText` keeps it on the native
 * undo stack, so Ctrl+Z removes an inserted tag like any typed text; where
 * that command is unavailable the value is committed directly.
 */
export function applyMarkupEdit(
  target: MarkupTarget,
  make: (value: string, start: number, end: number) => MarkupEdit,
) {
  const input = target.element;
  const value = input.value;
  const result = make(
    value,
    input.selectionStart ?? value.length,
    input.selectionEnd ?? value.length,
  );
  input.focus();
  input.setSelectionRange(result.from, result.to);
  let native = false;
  try {
    // An empty insert is a deletion; insertText refuses an empty string.
    native =
      typeof document.execCommand === 'function' &&
      (result.insert
        ? document.execCommand('insertText', false, result.insert)
        : result.from === result.to || document.execCommand('delete'));
  } catch {
    native = false;
  }
  if (!native || input.value !== result.text) target.setText(result.text);
  requestAnimationFrame(() => {
    input.focus();
    input.setSelectionRange(result.selectionStart, result.selectionEnd);
  });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

function Swatch({ kind, children }: { kind: Exclude<MarkupKind, 'text'>; children: ReactNode }) {
  return (
    <code className={cn('px-1 font-mono text-[11px] text-foreground', MARKUP_STYLES[kind])}>
      {children}
    </code>
  );
}

const triggerClass = buttonVariants({ variant: 'ghost', size: 'xs' });

export function MarkupToolbar({
  getTarget,
  disabled,
  profiles,
  scriptNames,
  voiceCast,
  onVoiceCast,
  allowNewCharacter = false,
  onChapter,
  actions,
  className,
}: {
  getTarget(): MarkupTarget | null;
  disabled: boolean;
  profiles: Profile[];
  /** `[voice:NAME]` names already used in the script, first-seen order. */
  scriptNames: string[];
  voiceCast: Record<string, string>;
  onVoiceCast(cast: Record<string, string>): void;
  /** Offer a free-text character name (cast later in the Cast panel). */
  allowNewCharacter?: boolean;
  /** Replaces inserting a `# Chapter` heading into the text. */
  onChapter?(): void;
  /** Extra controls for this editor, placed before the markup guide. */
  actions?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'pause' | 'voice' | 'expressions' | 'guide' | null>(null);
  const [customSeconds, setCustomSeconds] = useState('1.5');
  const [voiceQuery, setVoiceQuery] = useState('');
  const [newCharacter, setNewCharacter] = useState('');
  const toggle = (name: NonNullable<typeof open>) => (next: boolean) => {
    setOpen(next ? name : null);
    if (!next) setVoiceQuery('');
  };
  // Closing a popover hands focus straight back to the text being edited.
  const finalFocus = () => getTarget()?.element ?? true;
  const apply = (make: (value: string, start: number, end: number) => MarkupEdit) => {
    const target = getTarget();
    setOpen(null);
    if (target) applyMarkupEdit(target, make);
  };
  const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

  const insertPause = (ms: number) =>
    apply((value, start, end) => insertToken(value, start, end, pauseToken(ms)));
  const customMs = Math.round(Number(customSeconds) * 1000);
  const customValid = Number.isFinite(customMs) && customMs > 0 && customMs <= PAUSE_MAX_MS;

  const voice = (name: string) => apply((value, start, end) => applyVoice(value, start, end, name));
  const voiceProfile = (profile: Profile) =>
    voice(castProfileVoice(profile, voiceCast, onVoiceCast));
  const query = voiceQuery.trim().toLocaleLowerCase();
  const matches = (name: string) => !query || name.toLocaleLowerCase().includes(query);
  const profileName = (id: string) => profiles.find((profile) => profile.id === id)?.name;
  const castNames = scriptNames.filter((name) => matches(profileName(name) ?? name));
  const castProfiles = profiles.filter((profile) => matches(profile.name));
  const addCharacter = () => {
    const name = sanitizeCastName(newCharacter);
    if (!name) return;
    setNewCharacter('');
    voice(name);
  };

  const chapter = () => {
    if (onChapter) {
      onChapter();
      return;
    }
    apply((value, start) =>
      insertChapter(value, start, t('stories.chapterN', { n: countHeadings(value) + 1 })),
    );
  };

  return (
    <div
      role="toolbar"
      aria-label={t('audiobook.markup_toolbar')}
      className={cn(
        'flex flex-wrap items-center gap-0.5 rounded-xl border border-border/60 bg-muted/30 p-1 backdrop-blur-xl',
        className,
      )}
    >
      <Popover open={open === 'pause'} onOpenChange={toggle('pause')}>
        <PopoverTrigger disabled={disabled} className={triggerClass} title={t('markup.pause_hint')}>
          <PauseIcon />
          {t('audiobook.insert_pause')}
          <ChevronDownIcon className="opacity-60" />
        </PopoverTrigger>
        <PopoverContent finalFocus={finalFocus} className="w-64 space-y-2 p-2">
          <Section title={t('markup.pause_hint')}>
            {PAUSE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                onClick={() => insertPause(preset.ms)}
              >
                <span>{t(`markup.pause_${preset.id}`)}</span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {formatPauseSeconds(preset.ms)}
                </span>
              </button>
            ))}
          </Section>
          <form
            className="flex items-center gap-1.5 border-t border-border/50 px-1 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (customValid) insertPause(customMs);
            }}
          >
            <label className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
              {t('markup.pause_custom')}
              <Input
                type="number"
                min="0.1"
                max={PAUSE_MAX_MS / 1000}
                step="0.1"
                value={customSeconds}
                aria-invalid={!customValid}
                className="h-7 w-16 px-2 text-xs"
                onChange={(event) => setCustomSeconds(event.target.value)}
              />
              s
            </label>
            <Button type="submit" size="xs" variant="secondary" disabled={!customValid}>
              {t('markup.insert')}
            </Button>
          </form>
        </PopoverContent>
      </Popover>

      <Popover open={open === 'voice'} onOpenChange={toggle('voice')}>
        <PopoverTrigger disabled={disabled} className={triggerClass} title={t('markup.voice_hint')}>
          <AudioLinesIcon />
          {t('audiobook.insert_voice')}
          <ChevronDownIcon className="opacity-60" />
        </PopoverTrigger>
        <PopoverContent finalFocus={finalFocus} className="w-72 space-y-2 p-2">
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            {t('markup.voice_hint')}
          </p>
          {profiles.length >= VOICE_SEARCH_MIN && (
            <label className="relative block">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={voiceQuery}
                placeholder={t('markup.voice_search')}
                aria-label={t('markup.voice_search')}
                className="h-7 pl-7 text-xs"
                onChange={(event) => setVoiceQuery(event.target.value)}
              />
            </label>
          )}
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {castNames.length > 0 && (
              <Section title={t('markup.voice_in_script')}>
                {castNames.map((name) => {
                  // Older Stories scripts name the profile id itself.
                  const direct = profileName(name);
                  const mapped = castVoice(voiceCast, name);
                  const detail = mapped
                    ? (profileName(mapped) ?? t('modelSettings.unavailable'))
                    : direct
                      ? ''
                      : t('audiobook.cast_uses_default');
                  return (
                    <button
                      key={name}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                      onClick={() => voice(name)}
                    >
                      <span className="size-2 shrink-0 rounded-full bg-sky-500" />
                      <span className="truncate">{direct ?? name}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {detail}
                      </span>
                    </button>
                  );
                })}
              </Section>
            )}
            {castProfiles.length > 0 && (
              <Section title={t('markup.voice_profiles')}>
                {castProfiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                    onClick={() => voiceProfile(profile)}
                  >
                    <ProfileAvatar name={profile.name} className="size-5 shrink-0" />
                    <span className="truncate">{profile.name}</span>
                  </button>
                ))}
              </Section>
            )}
            {!castNames.length && !castProfiles.length && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {profiles.length ? t('markup.voice_none') : t('stories.noProfiles')}
              </p>
            )}
          </div>
          {allowNewCharacter && (
            <form
              className="flex items-center gap-1.5 border-t border-border/50 pt-2"
              onSubmit={(event) => {
                event.preventDefault();
                addCharacter();
              }}
            >
              <Input
                value={newCharacter}
                placeholder={t('markup.voice_new')}
                aria-label={t('markup.voice_new')}
                className="h-7 flex-1 text-xs"
                onChange={(event) => setNewCharacter(event.target.value)}
              />
              <Button
                type="submit"
                size="icon-xs"
                variant="secondary"
                aria-label={t('markup.voice_new')}
                disabled={!sanitizeCastName(newCharacter)}
              >
                <PlusIcon />
              </Button>
            </form>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border-t border-border/50 px-2 pt-2 pb-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            onClick={() =>
              apply((value, start, end) => insertToken(value, start, end, VOICE_RESET_TOKEN))
            }
          >
            <RotateCcwIcon className="size-3.5" />
            {t('markup.voice_reset')}
          </button>
        </PopoverContent>
      </Popover>

      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />

      {DELIVERY.map(({ tag, icon: Icon, label, hint }) => (
        <Button
          key={tag}
          size="xs"
          variant="ghost"
          disabled={disabled}
          title={t(hint)}
          onMouseDown={keepFocus}
          onClick={() =>
            apply((value, start, end) => wrapSelection(value, start, end, `[${tag}]`, `[/${tag}]`))
          }
        >
          <Icon />
          {t(label)}
        </Button>
      ))}
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        title={t('markup.pronounce_hint')}
        onMouseDown={keepFocus}
        onClick={() => apply(pronounceSelection)}
      >
        <SpeechIcon />
        {t('markup.pronounce')}
      </Button>

      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />

      <Popover open={open === 'expressions'} onOpenChange={toggle('expressions')}>
        <PopoverTrigger
          disabled={disabled}
          className={triggerClass}
          title={t('markup.expressions_hint')}
        >
          <SmileIcon />
          {t('audiobook.insert_reactions')}
          <ChevronDownIcon className="opacity-60" />
        </PopoverTrigger>
        <PopoverContent finalFocus={finalFocus} className="w-80 space-y-2 p-2">
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            {t('markup.expressions_hint')}
          </p>
          {expressionGroups().map((group) => {
            const Icon = EXPRESSION_ICONS[group.key] ?? SmileIcon;
            const label =
              group.key === 'other'
                ? t('audiobook.insert_reactions')
                : t(`stories.tones.${group.key}`);
            return (
              <div key={group.key} className="flex items-center gap-2 px-1">
                <span className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className="size-3.5" />
                  {label}
                </span>
                <div className="flex flex-wrap gap-1">
                  {group.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      title={tag}
                      className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs outline-none hover:bg-emerald-500/20 focus-visible:ring-2 focus-visible:ring-ring/40"
                      onClick={() =>
                        apply((value, start, end) => insertToken(value, start, end, tag))
                      }
                    >
                      {group.tags.length > 1 ? expressionVariant(tag) || tag : label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </PopoverContent>
      </Popover>

      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        title={t('markup.chapter_hint')}
        onMouseDown={keepFocus}
        onClick={chapter}
      >
        <HeadingIcon />
        {t('markup.chapter')}
      </Button>

      {actions}

      <Popover open={open === 'guide'} onOpenChange={toggle('guide')}>
        <PopoverTrigger
          className={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }), 'ml-auto')}
          aria-label={t('audiobook.markup_help')}
          title={t('audiobook.markup_help')}
        >
          <CircleHelpIcon />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 space-y-2 p-3 text-xs">
          <p className="text-sm font-medium">{t('audiobook.markup_help')}</p>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-2">
            <dt>
              <Swatch kind="pause">[pause 1s]</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.guide_pause')}</dd>
            <dt>
              <Swatch kind="voice">[voice:Mara]</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.guide_voice')}</dd>
            <dt>
              <Swatch kind="delivery">[slow]…[/slow]</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.guide_delivery')}</dd>
            <dt>
              <Swatch kind="delivery">[spell]…[/spell]</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.spell_hint')}</dd>
            <dt>
              <Swatch kind="pronunciation">[[gif|jiff]]</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.guide_pronounce')}</dd>
            <dt>
              <Swatch kind="expression">[laughter]</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.expressions_hint')}</dd>
            <dt>
              <Swatch kind="heading"># …</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.guide_chapter')}</dd>
            <dt>
              <Swatch kind="unknown">[other]</Swatch>
            </dt>
            <dd className="text-muted-foreground">{t('markup.guide_unknown')}</dd>
          </dl>
          <p className="border-t border-border/50 pt-2 text-muted-foreground">
            {t('markup.guide_select')}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
