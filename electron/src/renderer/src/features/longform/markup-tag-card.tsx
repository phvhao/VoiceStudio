import {
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { Popover } from '@base-ui/react/popover';
import {
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  PauseIcon,
  PlayIcon,
  RabbitIcon,
  RefreshCwIcon,
  RemoveFormattingIcon,
  SearchIcon,
  SmileIcon,
  SpeechIcon,
  SpellCheckIcon,
  TextSelectIcon,
  Trash2Icon,
  TurtleIcon,
  Volume2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProfileAvatar } from '@/components/profile-avatar';
import { cn } from '@/lib/utils';
import {
  setVoiceGain,
  voiceGain,
  voiceGainKey,
  type VoiceGains,
} from '@shared/utils/longformOverrides';
import { castVoice } from './cast-map';
import { VoiceGainControl, useVoiceGainText } from './cast-settings';
import type { MarkupEditorHandle } from './markup-editor-context';
import { applyMarkupEdit, castProfileVoice, type MarkupTarget } from './markup-toolbar';
import {
  DELIVERY_TAGS,
  MAX_PASSAGE_GAIN_DB,
  PAUSE_MAX_MS,
  PAUSE_PRESETS,
  VOICE_RESET_TOKEN,
  VOLUME_CLOSE,
  VOLUME_PRESETS,
  changeDeliveryKind,
  classifyToken,
  cleanRespelling,
  deliveryKind,
  expressionGroups,
  expressionVariant,
  formatPauseSeconds,
  isBareVoiceReset,
  isProfileCastName,
  pauseMs,
  pauseToken,
  removeToken,
  replaceRange,
  replaceVoiceTags,
  respellingParts,
  respellingRange,
  secondsUnit,
  setRespelling,
  setVolume,
  voiceName,
  voiceSection,
  voiceTagsNamed,
  voiceToken,
  volumeDb,
  volumeOpening,
  type DeliveryTag,
  type MarkupEdit,
  type MarkupKind,
  type MarkupToken,
} from './script-markup';
import type { RetakeTools } from './take-retake';
import { voiceAccent } from './voice-palette';
import { VoicePicker } from './voice-picker';

export type TagProfile = { id: string; name: string; image_url?: string | null };

/**
 * What the tools around a script editor (tag card, context menu, suggestions)
 * know about the script, and what they may change besides its text.
 */
export interface TagToolProps {
  getTarget(): MarkupTarget | null;
  /** `# Title` lines open chapters (Audiobook): a tag on one is part of the title. */
  headings?: boolean;
  /** Each line has a voice of its own, which `[voice:]` returns to (Stories). */
  lineVoices?: boolean;
  profiles: TagProfile[];
  /** The profiles are still loading: a cast voice is unknown, not missing. */
  loading?: boolean;
  /** `[voice:NAME]` names used in the script, first-seen order. */
  scriptNames: string[];
  /** The order voices take their colors in; `scriptNames` unless given. */
  voices?: readonly string[];
  voiceCast: Record<string, string>;
  onVoiceCast(cast: Record<string, string>): void;
  /** Volume per voice, the Cast panel's; without `onVoiceGains` no volume is offered. */
  voiceGains?: VoiceGains;
  onVoiceGains?(gains: VoiceGains): void;
  /** The book's default voice, once one is chosen. */
  defaultVoiceName?: string;
  /** Audition `from…to` of the script, such as one voice's part. */
  onListenRange?(from: number, to: number): void;
  /**
   * "Retake this sentence" (Audiobook and Stories, read sentence by
   * sentence): the takes a stretch of the text reads, asked for again.
   */
  retakes?: RetakeTools;
  /**
   * Markup this page does not read (voice switches, delivery and volume on
   * Clone and Voice Design; `heading` for chapters): such a tag can only be
   * removed, and none of these is offered to insert.
   */
  unsupported?: readonly MarkupKind[];
}

export const DELIVERY_LABELS: Record<DeliveryTag, string> = {
  slow: 'audiobook.insert_slow',
  fast: 'audiobook.insert_fast',
  emphasis: 'audiobook.insert_emphasis',
  spell: 'audiobook.insert_spell',
};

export const DELIVERY_ICONS: Record<DeliveryTag, ComponentType<{ className?: string }>> = {
  slow: TurtleIcon,
  fast: RabbitIcon,
  emphasis: BoldIcon,
  spell: SpellCheckIcon,
};

/**
 * The kind of a tag the page does not read (`TagToolProps.unsupported`), or
 * `null`. The editor marks such a tag `unknown`; its own kind still says how
 * it goes, such as a delivery pair that keeps its words.
 */
export function unsupportedKind(
  tools: Pick<TagToolProps, 'unsupported'>,
  token: MarkupToken,
): MarkupToken['kind'] | null {
  const kind = classifyToken(token.text) as MarkupToken['kind'];
  return tools.unsupported?.includes(kind) ? kind : null;
}

/** The label key of what removing a tag does: unwrap a pair, keep a respelled word, or drop it. */
export function removeTagLabel(kind: MarkupToken['kind']): string {
  if (kind === 'delivery' || kind === 'volume') return 'context.remove_markup';
  return kind === 'pronunciation' ? 'context.keep_word' : 'context.remove_tag';
}

/** The label key of a tag kind, as the toolbar names it. */
function tagKindLabel(token: MarkupToken): string {
  switch (token.kind) {
    case 'voice':
      return 'audiobook.insert_voice';
    case 'voiceReset':
      return 'markup.voice_reset';
    case 'pause':
      return 'audiobook.insert_pause';
    case 'delivery':
      return DELIVERY_LABELS[deliveryKind(token.text) ?? 'slow'];
    case 'volume':
      return 'markup.volume';
    case 'expression':
      return 'audiobook.insert_reactions';
    case 'pronunciation':
      return 'markup.pronounce';
    case 'unknown':
      return 'editor.card_unknown_title';
  }
}

/** The label key of an expression group: its sound, or "Reactions" for the rest. */
export function expressionGroupLabel(key: string): string {
  return key === 'other' ? 'audiobook.insert_reactions' : `stories.tones.${key}`;
}

/** Case- and accent-blind text to search in, so "hao" finds "Hào" and "dao" finds "Đào". */
export function searchKey(text: string): string {
  // NFD splits most accents into combining marks; đ is a letter of its own.
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd');
}

/**
 * Edit a tag only while its text is still where it was found, through
 * `applyMarkupEdit` so Ctrl+Z undoes it. False when the tag has moved or
 * changed since: the edit would land on other text.
 */
export function editTag(
  target: MarkupTarget | null,
  token: MarkupToken,
  make: (value: string) => MarkupEdit,
): boolean {
  if (!target || target.element.value.slice(token.start, token.end) !== token.text) return false;
  applyMarkupEdit(target, (value) => make(value));
  return true;
}

/**
 * Whether a `[voice:NAME]` name is a role (Narrator, Mara) rather than the
 * name of the profile reading it (`isProfileCastName`). Until the profiles
 * load, a cast name is taken for the profile's own: it cannot be told yet.
 */
export function isRole(
  {
    profiles,
    voiceCast,
    loading = false,
  }: Pick<TagToolProps, 'profiles' | 'voiceCast' | 'loading'>,
  name: string,
): boolean {
  const reading = castVoice(voiceCast, name) || name;
  const profile = profiles.find((candidate) => candidate.id === reading);
  if (!profile) return !(loading && reading !== name);
  return !isProfileCastName(name, profile);
}

/**
 * Everything that can be done to one tag. The tag card and the context menu
 * both act through here, so a tag behaves the same however it is reached.
 */
export function tagActions(tools: TagToolProps, token: MarkupToken) {
  const {
    getTarget,
    headings = false,
    lineVoices = false,
    voiceCast,
    onVoiceCast,
    voiceGains,
    onVoiceGains,
  } = tools;
  const edit = (make: (value: string) => MarkupEdit) => editTag(getTarget(), token, make);
  const replace = (insert: string) =>
    edit((value) => replaceRange(value, token.start, token.end, insert));
  // The voice a `[voice:NAME]` switches to; the resets and other tags have none.
  const name = voiceName(token.text);
  /** Rewrite this tag, or with `all` every tag of its name, to switch to `voice`. */
  const rewrite = (voice: string | null, all: boolean) => {
    const insert = voice === null ? VOICE_RESET_TOKEN : voiceToken(voice);
    return all && name !== null
      ? edit((value) => replaceVoiceTags(value, token, insert, { headings }))
      : replace(insert);
  };
  const castTo = name === null ? '' : castVoice(voiceCast, name);
  // A reset hands the text to the default voice, whose volume is kept under ''.
  const gainKey = name === null ? '' : voiceGainKey(name);
  const section = (): [number, number] | null => {
    const element = getTarget()?.element;
    return element ? voiceSection(element.value, token, { headings }) : null;
  };
  const select = (range: [number, number] | null, direction?: 'backward') => {
    const element = getTarget()?.element;
    if (!element || !range) return;
    // Once the menu or the card has handed focus back to the editor.
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(range[0], range[1], direction);
    });
  };
  return {
    name,
    /** A `[voice:]` that returns to the line's own voice (Stories), not the shared default. */
    toLine: lineVoices && token.kind === 'voiceReset' && isBareVoiceReset(token.text),
    replace,
    remove: () => edit((value) => removeToken(value, token)),
    /**
     * Switch the tag to a script name, or with `null` back to the default
     * voice; with `all`, every tag of its name (`namesakes`) switches.
     */
    switchTo: (voice: string | null, all = false) => rewrite(voice, all),
    /** Switch the tag (or with `all` every tag of its name) to a profile, cast under a readable name. */
    switchToProfile(profile: TagProfile, all = false) {
      const next = castProfileVoice(profile, voiceCast, onVoiceCast);
      return next === name || rewrite(next, all);
    },
    /** How many `[voice:NAME]` tags of this name the text holds, this one among them. */
    namesakes(): number {
      const element = getTarget()?.element;
      return element && name !== null
        ? voiceTagsNamed(element.value, name, { headings }).length
        : 0;
    },
    /**
     * The name is a role (Narrator, Mara) cast to a voice of its own, not a
     * profile's own name: recasting it is a choice apart from this tag's voice.
     */
    role: name !== null && isRole(tools, name),
    /** The profile cast to the name: '' while the default voice reads it. */
    castTo,
    /** Cast the name to a profile, or with '' leave it to the default voice. */
    cast(profileId: string) {
      if (name === null) return;
      const next = { ...voiceCast };
      if (profileId) next[name] = profileId;
      else delete next[name];
      onVoiceCast(next);
    },
    gain: voiceGain(voiceGains, gainKey),
    setGain: onVoiceGains && ((db: number) => onVoiceGains(setVoiceGain(voiceGains, gainKey, db))),
    /** What a voice tag reads, up to the next change of voice. */
    section,
    listen: tools.onListenRange
      ? () => {
          const range = section();
          if (range && range[0] < range[1]) tools.onListenRange?.(range[0], range[1]);
        }
      : undefined,
    /** Select the voice's part, its start (and the tag) kept in view. */
    selectSection: () => select(section(), 'backward'),
    setPause: (ms: number) => replace(pauseToken(ms)),
    setDelivery: (kind: DeliveryTag) => edit((value) => changeDeliveryKind(value, token, kind)),
    /** The gain a `[volume]` passage reads at, from its opening tag; `null` when it has none. */
    volume(): number | null {
      const element = getTarget()?.element;
      const open = element ? volumeOpening(element.value, token) : null;
      return open && volumeDb(open.text);
    },
    /** Read the `[volume]` passage at `db`: its opening tag changes, the words stay. */
    setVolume: (db: number) => edit((value) => setVolume(value, token, db)),
    respell: (respelling: string) => edit((value) => setRespelling(value, token, respelling)),
    /** Select the respelling in the editor, to retype it there. */
    selectRespelling: () => select(respellingRange(token)),
  };
}

export type TagActions = ReturnType<typeof tagActions>;

/** A tag the editor opened: clicked, or reached with Alt+Enter. */
export interface TagActivation {
  token: MarkupToken;
  handle: MarkupEditorHandle;
  via: 'pointer' | 'keyboard';
  /** Tells activations apart: each one opens a fresh card. */
  id: number;
}

const CARD =
  'w-72 max-w-[calc(100vw-1rem)] origin-(--transform-origin) space-y-3 rounded-lg surface-glass p-3 text-sm text-popover-foreground shadow-md ring-1 ring-border outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none';
const CHIP =
  'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:border-primary/50 aria-pressed:bg-primary/12 [&_svg]:size-3.5';

// Values of the voice pickers. A `[voice:NAME]` name never holds a bracket,
// so these never collide with one.
const DEFAULT_CHOICE = '[default]';
const PROFILE_CHOICE = '[profile]';

/**
 * The card for the tag the user clicked, or reached with Alt+Enter: what the
 * tag does and the edits it allows. After a click the editor keeps the focus,
 * so typing goes on; from the keyboard the focus moves into the card, and
 * closing it hands the focus back to the editor.
 */
export function MarkupTagCard({
  activation,
  onClose,
  ...tools
}: TagToolProps & {
  /** The tag the card is open for; `null` closes it. */
  activation: TagActivation | null;
  onClose(): void;
}) {
  const { t } = useTranslation();
  // The last tag stays on the card while it animates closed.
  const [shown, setShown] = useState(activation);
  if (activation && activation !== shown) setShown(activation);
  const current = activation ?? shown;
  const popupRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLElement | null>(null);
  const anchor = useMemo(
    () => current && current.handle.anchorAt(current.token.start, current.token.end),
    [current],
  );
  if (!current) return null;
  const { token, handle } = current;
  return (
    <Popover.Root
      key={current.id}
      open={activation !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={6}
          className="isolate z-50 outline-none"
        >
          <Popover.Popup
            ref={popupRef}
            aria-label={t('editor.card_label', { tag: token.text })}
            initialFocus={current.via === 'keyboard' ? focusRef : false}
            // The focus goes back to the editor only when closing would lose
            // it: from inside the card, or from nowhere. A press in another
            // field or line, or a menu opened meanwhile, keeps it where it is.
            finalFocus={() => {
              const active = document.activeElement;
              return !active || active === document.body || popupRef.current?.contains(active)
                ? handle.element
                : false;
            }}
            className={CARD}
          >
            <TagCardBody token={token} tools={tools} focusRef={focusRef} onDone={onClose} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Header({
  icon,
  title,
  token,
  children,
}: {
  icon: ReactNode;
  title: string;
  /** The tag as written, beside the title; left out where the title already says it. */
  token?: MarkupToken;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="min-w-0 truncate font-medium" title={token ? undefined : title}>
          {title}
        </span>
        {token && (
          <code className="ms-auto max-w-[55%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
            {token.text}
          </code>
        )}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/** A voice's color swatch (`voiceAccent(...).dot`). */
export function VoiceDot({ className }: { className: string }) {
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', className)} />;
}

/** The dashed ring `[voice:]` wears in the editor: back to the default voice. */
export function ResetDot() {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground/70"
    />
  );
}

/** The card's last row: the tag's actions, and the one that takes it away at the end. */
function Footer({ children, end }: { children?: ReactNode; end: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-border/50 pt-2">
      {children}
      <span className="ms-auto flex">{end}</span>
    </div>
  );
}

/**
 * "Retake this sentence" on the card of a tag read inside a sentence — a
 * reaction, a delivery or a respelling that came out wrong: that sentence is
 * read anew and the rest of the chapter reused. Only where the page reads
 * sentence by sentence.
 */
function RetakeButton({ token, tools, onDone }: Pick<BodyProps, 'token' | 'tools' | 'onDone'>) {
  const { t } = useTranslation();
  const { retakes } = tools;
  if (!retakes) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      title={t('editor.retake_hint')}
      onClick={() => {
        retakes.retakeAt(token.start, token.end);
        onDone();
      }}
    >
      <RefreshCwIcon />
      {t('editor.retake_sentence')}
    </Button>
  );
}

interface VoiceChoice {
  value: string;
  label: string;
  icon: ReactNode;
}

interface VoiceChoiceGroup {
  key: string;
  label?: string;
  items: VoiceChoice[];
}

/**
 * A voice picker on the card: a list grouped like the toolbar's (the default
 * voice, the script's names, the profiles), searchable ignoring case and
 * accents, since a library of cloned voices grows long.
 */
function VoiceChoicePicker({
  label,
  value,
  groups,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  groups: VoiceChoiceGroup[];
  /** Shown while `value` is none of the choices, such as a voice still loading. */
  placeholder?: string;
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  const shown = groups.filter((group) => group.items.length > 0);
  const items = Combobox.createItems(shown, {
    getValue: (choice: VoiceChoice) => choice.value,
    getLabel: (choice: VoiceChoice) => choice.label,
  });
  const current = shown.flatMap((group) => group.items).find((choice) => choice.value === value);
  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={(next) => {
        // Picking the current voice again changes nothing.
        if (typeof next === 'string' && next !== value) onChange(next);
      }}
      filter={(choice: VoiceChoice, query: string) =>
        searchKey(choice.label).includes(searchKey(query))
      }
      // The search starts empty, not seeded with the chosen voice's name.
      defaultInputValue=""
      autoHighlight
    >
      <Combobox.Trigger
        aria-label={label}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-input/20 px-2 text-start text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30 dark:hover:bg-input/50"
      >
        {current?.icon}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? placeholder}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={4} className="isolate z-50 outline-none">
          <Combobox.Popup
            aria-label={label}
            className="flex max-h-[min(50vh,18rem,var(--available-height))] w-(--anchor-width) max-w-(--available-width) min-w-56 origin-(--transform-origin) flex-col overflow-hidden rounded-lg surface-glass text-popover-foreground shadow-md ring-1 ring-border outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:animate-none"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2.5">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Combobox.Input
                placeholder={t('markup.voice_search')}
                aria-label={t('markup.voice_search')}
                className="h-8 w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Combobox.Empty>
              <p className="px-3 py-3 text-center text-xs text-muted-foreground">
                {t('markup.voice_none')}
              </p>
            </Combobox.Empty>
            <Combobox.List className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 empty:p-0">
              {(group: VoiceChoiceGroup) => (
                <Combobox.Group key={group.key} items={group.items}>
                  {group.label && (
                    <Combobox.GroupLabel className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {group.label}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(choice: VoiceChoice) => (
                      <Combobox.Item
                        key={choice.value}
                        value={choice.value}
                        className="flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                      >
                        {choice.icon}
                        <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                        <Combobox.ItemIndicator className="flex">
                          <CheckIcon className="size-3.5" />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

interface BodyProps {
  token: MarkupToken;
  tools: TagToolProps;
  act: TagActions;
  focusRef: RefObject<HTMLElement | null>;
  /** The card is done: an edit changed the tag it describes, or the choice was made. */
  onDone(): void;
}

function TagCardBody({ token: shown, tools, focusRef, onDone }: Omit<BodyProps, 'act'>) {
  const { t } = useTranslation();
  const unread = unsupportedKind(tools, shown);
  const token = unread ? { ...shown, kind: unread } : shown;
  const act = tagActions(tools, token);
  const props = { token, tools, act, focusRef, onDone };
  const remove = (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => {
        act.remove();
        onDone();
      }}
    >
      <Trash2Icon />
      {t('context.remove_tag')}
    </Button>
  );
  if (unread) return <UnsupportedBody {...props} />;
  switch (token.kind) {
    case 'voice':
    case 'voiceReset':
      return <VoiceBody {...props} remove={remove} />;
    case 'pause':
      return <PauseBody {...props} remove={remove} />;
    case 'expression':
      return <ExpressionBody {...props} remove={remove} />;
    case 'delivery':
      return <DeliveryBody {...props} />;
    case 'volume':
      return <VolumeBody {...props} />;
    case 'pronunciation':
      return <PronunciationBody {...props} />;
    case 'unknown':
      return (
        <>
          <Header
            icon={<CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />}
            title={t('editor.card_unknown_title')}
            token={token}
          >
            {t('editor.card_unknown')}
          </Header>
          <Footer end={remove} />
        </>
      );
  }
}

/** A tag this page does not read: what it is, why it does nothing here, and its removal. */
function UnsupportedBody({ token, act, focusRef, onDone }: BodyProps) {
  const { t } = useTranslation();
  const pair = token.kind === 'delivery' || token.kind === 'volume';
  const Icon = pair ? RemoveFormattingIcon : Trash2Icon;
  return (
    <>
      <Header
        icon={<CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />}
        title={t(tagKindLabel(token))}
        token={token}
      >
        {t('editor.hint_unsupported')}
      </Header>
      <Footer
        end={
          <Button
            ref={(node) => void (focusRef.current = node)}
            size="xs"
            variant="ghost"
            onClick={() => {
              act.remove();
              onDone();
            }}
          >
            <Icon />
            {t(removeTagLabel(token.kind))}
          </Button>
        }
      />
    </>
  );
}

/**
 * `[voice:NAME]` and `[voice:]`: the voice reading from here (changing it
 * rewrites this tag, or every tag of its name), the voice a role is cast to,
 * and how loud the voice reads.
 */
function VoiceBody({ token, tools, act, onDone, remove }: BodyProps & { remove: ReactNode }) {
  const { t } = useTranslation();
  const { profiles, scriptNames, defaultVoiceName, lineVoices = false, loading = false } = tools;
  const voices = tools.voices ?? scriptNames;
  const { name, toLine, role } = act;
  // Older Stories scripts put a profile id in the tag.
  const profileName = (id: string) => profiles.find((profile) => profile.id === id)?.name;
  const label = (voice: string) => profileName(voice) ?? voice;
  const avatar = (profile: TagProfile) => (
    <ProfileAvatar name={profile.name} imageUrl={profile.image_url} className="size-4" />
  );
  // Every tag of the name, this one among them: offered once there are others.
  const namesakes = act.namesakes();
  const [all, setAll] = useState(false);
  const switchTo = (value: string) => {
    const profile = value.startsWith(PROFILE_CHOICE)
      ? profiles.find((candidate) => PROFILE_CHOICE + candidate.id === value)
      : undefined;
    const every = all && namesakes > 1;
    if (profile) act.switchToProfile(profile, every);
    else act.switchTo(value === DEFAULT_CHOICE ? null : value, every);
    onDone();
  };
  // A name that is a profile id reads in that profile without being cast.
  const direct = name !== null && !act.castTo && profileName(name) !== undefined;
  // The profile reading the name: null while the default voice reads it.
  const readingVoice = act.castTo || (direct ? name : null);
  const missing = act.castTo !== '' && profileName(act.castTo) === undefined && !loading;
  const section = act.section();
  const reads = section !== null && section[0] < section[1];
  const voiceLabel = t('audiobook.insert_voice');
  // A role is chosen as itself; a profile's own name, as that profile.
  const choice =
    name === null ? DEFAULT_CHOICE : role ? name : PROFILE_CHOICE + (readingVoice ?? name);
  const voiceRow = (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 text-xs">
      <span className="text-muted-foreground">{voiceLabel}</span>
      <VoiceChoicePicker
        label={voiceLabel}
        value={choice}
        placeholder={loading ? t('common.loading') : undefined}
        onChange={switchTo}
        groups={[
          {
            key: 'default',
            items: [{ value: DEFAULT_CHOICE, label: t('markup.voice_reset'), icon: <ResetDot /> }],
          },
          {
            // The script's roles; a profile's own name is listed as the profile.
            key: 'script',
            label: t('markup.voice_in_script'),
            items: scriptNames
              .filter((voice) => isRole(tools, voice))
              .map((voice) => ({
                value: voice,
                label: label(voice),
                icon: <VoiceDot className={voiceAccent(voice, voices).dot} />,
              })),
          },
          {
            key: 'profiles',
            label: t('markup.voice_profiles'),
            items: profiles.map((profile) => ({
              value: PROFILE_CHOICE + profile.id,
              label: profile.name,
              icon: avatar(profile),
            })),
          },
        ]}
      />
    </div>
  );
  return (
    <>
      {name === null ? (
        <>
          <Header icon={<ResetDot />} title={t('markup.voice_reset')} token={token}>
            {t(toLine ? 'editor.card_voice_reset_line' : 'editor.card_voice_reset')}
          </Header>
          {voiceRow}
        </>
      ) : (
        <>
          {/* The name once, in its color: the tag as written says no more. */}
          <Header icon={<VoiceDot className={voiceAccent(name, voices).dot} />} title={label(name)}>
            {t('editor.card_voice')}
          </Header>
          {voiceRow}
          {namesakes > 1 && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={all}
                onChange={(event) => setAll(event.target.checked)}
                className="mt-0.5 accent-primary"
              />
              <span className="min-w-0 break-words">
                {t(lineVoices ? 'editor.voice_apply_all_line' : 'editor.voice_apply_all', {
                  count: namesakes,
                  tag: voiceToken(name),
                })}
              </span>
            </label>
          )}
        </>
      )}
      {/* A role's own voice, for all its tags: a choice apart from this tag's. */}
      {name !== null && role && (
        <div className="space-y-1 border-t border-border/50 pt-2">
          <p className="text-xs text-muted-foreground">
            {t('editor.role_read_by', { name: label(name) })}
          </p>
          <VoicePicker
            value={readingVoice}
            onChange={(id) => act.cast(id ?? '')}
            profiles={profiles}
            loading={loading}
            defaultOption={{
              label: defaultVoiceName
                ? t('editor.status_default', { name: defaultVoiceName })
                : t('editor.status_default_none'),
            }}
            aria-label={t('editor.role_read_by', { name: label(name) })}
            className="h-8 text-xs"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t('editor.role_read_by_hint', { tag: voiceToken(name) })}
          </p>
          {(missing || readingVoice === null) && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {missing ? t('editor.cast_missing') : t('editor.uncast', { name: label(name) })}
            </p>
          )}
        </div>
      )}
      {/* In Stories `[voice:]` goes back to each line's own voice, not one shared default. */}
      {act.setGain && !toLine && (
        <div className="space-y-1">
          <VoiceGainControl
            name={name === null ? t('audiobook.default_voice') : label(name)}
            value={act.gain}
            onChange={act.setGain}
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            {name === null ? t('editor.volume_default') : t('editor.voice_volume_hint')}
          </p>
        </div>
      )}
      <Footer end={remove}>
        {name !== null && act.listen && (
          <Button
            size="xs"
            variant="ghost"
            disabled={!reads}
            onClick={() => {
              act.listen?.();
              onDone();
            }}
          >
            <PlayIcon />
            {t('editor.listen_part')}
          </Button>
        )}
        {name !== null && (
          <Button
            size="xs"
            variant="ghost"
            disabled={!reads}
            onClick={() => {
              act.selectSection();
              onDone();
            }}
          >
            <TextSelectIcon />
            {t('editor.select_part')}
          </Button>
        )}
      </Footer>
    </>
  );
}

function PauseBody({ token, act, focusRef, onDone, remove }: BodyProps & { remove: ReactNode }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const ms = pauseMs(token.text) ?? 0;
  const [seconds, setSeconds] = useState(String(ms / 1000));
  const customMs = Math.round(Number(seconds) * 1000);
  const valid = Number.isFinite(customMs) && customMs > 0 && customMs <= PAUSE_MAX_MS;
  const choose = (next: number) => {
    if (next !== ms) act.setPause(next);
    onDone();
  };
  return (
    <>
      <Header
        icon={<PauseIcon className="size-3.5 shrink-0 text-amber-500" />}
        title={t('audiobook.insert_pause')}
        token={token}
      >
        {t('editor.card_pause', { duration: formatPauseSeconds(ms, locale) })}
      </Header>
      <div role="group" aria-label={t('editor.pause_length')} className="flex flex-wrap gap-1">
        {PAUSE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            ref={preset.ms === ms ? (node) => void (focusRef.current = node) : undefined}
            type="button"
            aria-pressed={preset.ms === ms}
            className={CHIP}
            onClick={() => choose(preset.ms)}
          >
            {t(`markup.pause_${preset.id}`)}
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {formatPauseSeconds(preset.ms, locale)}
            </span>
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) choose(customMs);
        }}
      >
        <label className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          {t('markup.pause_custom')}
          <Input
            type="number"
            min="0.1"
            max={PAUSE_MAX_MS / 1000}
            step="0.1"
            value={seconds}
            aria-invalid={!valid}
            aria-label={t('editor.pause_custom_seconds')}
            className="h-7 w-16 px-2 text-xs"
            onChange={(event) => setSeconds(event.target.value)}
          />
          <span aria-hidden="true">{secondsUnit(locale)}</span>
        </label>
        <Button type="submit" size="xs" variant="secondary" disabled={!valid}>
          {t('editor.apply')}
        </Button>
      </form>
      <Footer end={remove} />
    </>
  );
}

function ExpressionBody({
  token,
  tools,
  act,
  focusRef,
  onDone,
  remove,
}: BodyProps & { remove: ReactNode }) {
  const { t } = useTranslation();
  const groups = expressionGroups();
  const current = token.text.toLowerCase();
  const group = groups.find((candidate) =>
    candidate.tags.some((tag) => tag.toLowerCase() === current),
  );
  const title = group
    ? [t(expressionGroupLabel(group.key)), expressionVariant(token.text)]
        .filter(Boolean)
        .join(' · ')
    : token.text;
  return (
    <>
      <Header
        icon={<SmileIcon className="size-3.5 shrink-0 text-emerald-500" />}
        title={title}
        token={token}
      >
        {t('editor.card_expression')}
      </Header>
      <div className="space-y-1.5">
        {groups.map((candidate) => (
          <div key={candidate.key} className="flex items-center gap-2">
            <span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
              {t(expressionGroupLabel(candidate.key))}
            </span>
            <div className="flex flex-wrap gap-1">
              {candidate.tags.map((tag) => {
                const pressed = tag.toLowerCase() === current;
                return (
                  <button
                    key={tag}
                    ref={pressed ? (node) => void (focusRef.current = node) : undefined}
                    type="button"
                    title={tag}
                    aria-pressed={pressed}
                    className={CHIP}
                    onClick={() => {
                      if (!pressed) act.replace(tag);
                      onDone();
                    }}
                  >
                    {candidate.tags.length > 1
                      ? expressionVariant(tag) || tag
                      : t(expressionGroupLabel(candidate.key))}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <Footer end={remove}>
        <RetakeButton token={token} tools={tools} onDone={onDone} />
      </Footer>
    </>
  );
}

function DeliveryBody({ token, tools, act, focusRef, onDone }: BodyProps) {
  const { t } = useTranslation();
  const kind = deliveryKind(token.text) ?? 'slow';
  const Icon = DELIVERY_ICONS[kind];
  return (
    <>
      <Header
        icon={<Icon className="size-3.5 shrink-0 text-violet-500" />}
        title={t(DELIVERY_LABELS[kind])}
        token={token}
      >
        {t('editor.card_delivery', { open: `[${kind}]`, close: `[/${kind}]` })}
      </Header>
      <div role="group" aria-label={t('context.delivery')} className="flex flex-wrap gap-1">
        {DELIVERY_TAGS.map((tag) => {
          const KindIcon = DELIVERY_ICONS[tag];
          return (
            <button
              key={tag}
              ref={tag === kind ? (node) => void (focusRef.current = node) : undefined}
              type="button"
              aria-pressed={tag === kind}
              className={CHIP}
              onClick={() => {
                if (tag !== kind) act.setDelivery(tag);
                onDone();
              }}
            >
              <KindIcon />
              {t(DELIVERY_LABELS[tag])}
            </button>
          );
        })}
      </div>
      <Footer
        end={
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              act.remove();
              onDone();
            }}
          >
            <RemoveFormattingIcon />
            {t('context.remove_markup')}
          </Button>
        }
      >
        <RetakeButton token={token} tools={tools} onDone={onDone} />
      </Footer>
    </>
  );
}

/** `[volume …]` and `[/volume]`: how much quieter or louder the passage between them reads. */
function VolumeBody({ token, act, focusRef, onDone }: BodyProps) {
  const { t } = useTranslation();
  const gainText = useVoiceGainText();
  // A `[/volume]` without its opening tag has no gain to change.
  const current = act.volume();
  const [db, setDb] = useState(Math.round(current ?? 0));
  const choose = (next: number) => {
    if (next !== current) act.setVolume(next);
    onDone();
  };
  return (
    <>
      <Header
        icon={<Volume2Icon className="size-3.5 shrink-0 text-fuchsia-500" />}
        title={t('markup.volume')}
        token={token}
      >
        {current === null
          ? t('editor.card_volume_unpaired')
          : t('editor.card_volume', { gain: gainText(current), close: VOLUME_CLOSE })}
      </Header>
      {current !== null && (
        <>
          <div role="group" aria-label={t('markup.volume')} className="flex flex-wrap gap-1">
            {VOLUME_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                aria-pressed={preset.db === current}
                className={CHIP}
                onClick={() => choose(preset.db)}
              >
                {t(preset.label)}
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {gainText(preset.db)}
                </span>
              </button>
            ))}
          </div>
          <form
            className="flex items-center gap-2 text-xs"
            onSubmit={(event) => {
              event.preventDefault();
              choose(db);
            }}
          >
            <input
              ref={(node) => void (focusRef.current = node)}
              type="range"
              aria-label={t('editor.volume_passage')}
              aria-valuetext={gainText(db)}
              className="min-w-0 flex-1 accent-primary"
              min={-MAX_PASSAGE_GAIN_DB}
              max={MAX_PASSAGE_GAIN_DB}
              step={1}
              value={db}
              onChange={(event) => setDb(Number(event.target.value))}
            />
            <output className="w-12 shrink-0 text-end tabular-nums">{gainText(db)}</output>
            <Button type="submit" size="xs" variant="secondary" disabled={db === current}>
              {t('editor.apply')}
            </Button>
          </form>
        </>
      )}
      <Footer
        end={
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              act.remove();
              onDone();
            }}
          >
            <RemoveFormattingIcon />
            {t('context.remove_markup')}
          </Button>
        }
      />
    </>
  );
}

function PronunciationBody({ token, tools, act, focusRef, onDone }: BodyProps) {
  const { t } = useTranslation();
  const { word, respelling } = respellingParts(token);
  const [value, setValue] = useState(respelling);
  const next = cleanRespelling(value);
  return (
    <>
      <Header
        icon={<SpeechIcon className="size-3.5 shrink-0 text-rose-500" />}
        title={t('markup.pronounce')}
        token={token}
      >
        {word ? t('editor.card_pronunciation', { word }) : t('editor.card_pronunciation_bare')}
      </Header>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!next) return;
          if (next !== respelling) act.respell(next);
          onDone();
        }}
      >
        <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">{t('editor.read_as')}</span>
          <Input
            ref={(node) => void (focusRef.current = node)}
            value={value}
            aria-invalid={!next}
            className="h-7 min-w-0 flex-1 px-2 text-xs"
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <Button type="submit" size="xs" variant="secondary" disabled={!next}>
          {t('editor.apply')}
        </Button>
      </form>
      <Footer
        end={
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              act.remove();
              onDone();
            }}
          >
            <RemoveFormattingIcon />
            {t('context.keep_word')}
          </Button>
        }
      >
        <RetakeButton token={token} tools={tools} onDone={onDone} />
      </Footer>
    </>
  );
}
