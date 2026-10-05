import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Popover } from '@base-ui/react/popover';
import type { TFunction } from 'i18next';
import { PauseIcon, SmileIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProfileAvatar } from '@/components/profile-avatar';
import { isImeComposing } from '@/lib/ime';
import { castVoice } from './cast-map';
import type { MarkupEditorEvents, MarkupEditorHandle } from './markup-editor-context';
import {
  DELIVERY_ICONS,
  DELIVERY_LABELS,
  ResetDot,
  VoiceDot,
  expressionGroupLabel,
  searchKey,
  type TagProfile,
  type TagToolProps,
} from './markup-tag-card';
import { applyMarkupEdit, castProfileVoice } from './markup-toolbar';
import {
  DELIVERY_TAGS,
  PAUSE_PRESETS,
  VOICE_RESET_TOKEN,
  castNameForProfile,
  completeTag,
  deliveryKind,
  expressionGroups,
  expressionVariant,
  formatPauseSeconds,
  pauseToken,
  typedTagAt,
  voiceToken,
  type TypedTag,
} from './script-markup';
import { voiceAccent } from './voice-palette';

/** One tag the suggestions offer. */
export interface Suggestion {
  /** Unique within the list. */
  key: string;
  group: 'voice' | 'pause' | 'delivery' | 'expression';
  /** The tag inserted, or the opening half of a delivery pair. */
  open: string;
  /** The closing half of a delivery pair. */
  close?: string;
  label: string;
  detail?: string;
  /** A script name, for its color; `null` is the default voice. */
  voice?: string | null;
  /** Inserting it casts this profile under the name in `open`. */
  profile?: TagProfile;
}

const GROUP_LABELS: Record<Suggestion['group'], string> = {
  voice: 'audiobook.insert_voice',
  pause: 'audiobook.insert_pause',
  delivery: 'context.delivery',
  expression: 'audiobook.insert_reactions',
};

/**
 * Every tag the suggestions can offer, in list order: the script's voices, the
 * way back to the default voice and the profiles not reached through a name
 * yet, then pauses, delivery pairs and expressions.
 */
export function tagSuggestions(
  t: TFunction,
  {
    scriptNames,
    profiles,
    voiceCast,
  }: Pick<TagToolProps, 'scriptNames' | 'profiles' | 'voiceCast'>,
  locale?: string,
): Suggestion[] {
  const profileName = (id: string) => profiles.find((profile) => profile.id === id)?.name;
  // A name cast to a profile (or, in older Stories scripts, a profile id
  // itself) already reaches that profile.
  const reached = new Set(scriptNames.map((name) => castVoice(voiceCast, name) || name));
  return [
    ...scriptNames.map((name): Suggestion => ({
      key: `voice:${name}`,
      group: 'voice',
      open: voiceToken(name),
      label: profileName(name) ?? name,
      detail: profileName(castVoice(voiceCast, name)),
      voice: name,
    })),
    {
      key: 'voice-reset',
      group: 'voice',
      open: VOICE_RESET_TOKEN,
      label: t('markup.voice_reset'),
      voice: null,
    },
    ...profiles
      .filter((profile) => !reached.has(profile.id))
      .map((profile): Suggestion => ({
        key: `profile:${profile.id}`,
        group: 'voice',
        open: voiceToken(castNameForProfile(profile, voiceCast)),
        label: profile.name,
        profile,
      })),
    ...PAUSE_PRESETS.map((preset): Suggestion => ({
      key: `pause:${preset.id}`,
      group: 'pause',
      open: pauseToken(preset.ms),
      label: t(`markup.pause_${preset.id}`),
      detail: formatPauseSeconds(preset.ms, locale),
    })),
    ...DELIVERY_TAGS.map((tag): Suggestion => ({
      key: `delivery:${tag}`,
      group: 'delivery',
      open: `[${tag}]`,
      close: `[/${tag}]`,
      label: t(DELIVERY_LABELS[tag]),
    })),
    ...expressionGroups().flatMap((group) =>
      group.tags.map((tag): Suggestion => ({
        key: `expression:${tag}`,
        group: 'expression',
        open: tag,
        label: [t(expressionGroupLabel(group.key)), expressionVariant(tag)]
          .filter(Boolean)
          .join(' · '),
      })),
    ),
  ];
}

/**
 * The suggestions for what was typed after `[`: those whose tag or label holds
 * it, ignoring case and accents. Profiles wait for something to be typed, so a
 * bare `[` lists the tags themselves rather than every voice installed.
 */
export function matchSuggestions(items: readonly Suggestion[], query: string): Suggestion[] {
  const typed = searchKey(query.trim());
  if (!typed) return items.filter((item) => !item.profile);
  return items.filter(
    (item) =>
      searchKey(item.open + (item.close ?? '')).includes(typed) ||
      searchKey(item.label).includes(typed),
  );
}

/** Which match to highlight first: the first tag that starts with what was typed. */
export function bestSuggestion(matches: readonly Suggestion[], query: string): number {
  const typed = '[' + searchKey(query.trim());
  return Math.max(
    0,
    matches.findIndex((item) => searchKey(item.open).startsWith(typed)),
  );
}

interface Suggesting {
  handle: MarkupEditorHandle;
  tag: TypedTag;
  /** The highlighted match; `null` until the arrows move it, which is the best match. */
  active: number | null;
}

type TextareaAria = NonNullable<MarkupEditorEvents['textareaAria']>;

// Every editor with suggestions says so, shown or not; the list itself is
// referenced (`aria-controls`) only while it is in the document.
const SUGGESTS: TextareaAria = { 'aria-autocomplete': 'list' };

const optionId = (listId: string, index: number) => `${listId}-option-${index}`;

/**
 * Tag suggestions for a script editor, opened by typing `[`. The editor keeps
 * the focus throughout: the list follows what is typed, and the arrow keys,
 * Enter, Tab and Escape reach it through `onKeyDown` only while it is shown.
 * An IME composition (Vietnamese Telex, CJK) never opens it or loses keys to
 * it. After Escape it stays closed until the caret leaves that bracket.
 */
export function useMarkupAutocomplete({
  getTarget,
  headings = false,
  profiles,
  scriptNames,
  voiceCast,
  onVoiceCast,
  disabled,
  onOpen,
}: Pick<
  TagToolProps,
  'getTarget' | 'headings' | 'profiles' | 'scriptNames' | 'voiceCast' | 'onVoiceCast'
> & {
  disabled: boolean;
  /** The list has just been shown. */
  onOpen(): void;
}) {
  const { t, i18n } = useTranslation();
  const listId = useId();
  const [state, setState] = useState<Suggesting | null>(null);
  if (disabled && state) setState(null);
  // The `[` whose suggestions Escape closed.
  const dismissed = useRef<number | null>(null);
  // Text arrived during an IME composition: look at it once it is committed.
  const composed = useRef(false);
  // Built only while a tag is typed: Stories has an editor per line.
  const query = state?.tag.query;
  const typing = query !== undefined;
  const locale = i18n.resolvedLanguage || i18n.language;
  const all = useMemo(
    () => (typing ? tagSuggestions(t, { scriptNames, profiles, voiceCast }, locale) : []),
    [typing, t, scriptNames, profiles, voiceCast, locale],
  );
  const items = useMemo(
    () => (query === undefined ? [] : matchSuggestions(all, query)),
    [all, query],
  );
  const open = state !== null && items.length > 0;
  const active = open
    ? Math.min(state.active ?? bestSuggestion(items, state.tag.query), items.length - 1)
    : -1;
  const opened = useRef(onOpen);
  useLayoutEffect(() => {
    opened.current = onOpen;
  });
  useEffect(() => {
    if (open) opened.current();
  }, [open]);
  const aria = useMemo<TextareaAria>(
    () =>
      open
        ? {
            ...SUGGESTS,
            'aria-controls': listId,
            'aria-activedescendant': optionId(listId, active),
          }
        : SUGGESTS,
    [open, listId, active],
  );
  // Measured again whenever the tag (or its place, after a scroll) changes.
  const tag = state?.tag;
  const handle = state?.handle;
  const anchor = useMemo(() => tag && handle?.anchorAt(tag.start), [tag, handle]);

  const close = () => setState(null);
  const accept = (index: number) => {
    const item = items[index];
    const target = getTarget();
    close();
    if (!item || !target) return;
    const { element } = target;
    const typed =
      element.selectionStart === element.selectionEnd
        ? typedTagAt(element.value, element.selectionStart, { headings })
        : null;
    if (!typed) return;
    const insert = item.profile
      ? voiceToken(castProfileVoice(item.profile, voiceCast, onVoiceCast))
      : item.open;
    applyMarkupEdit(target, (value) => completeTag(value, typed, insert, item.close));
  };

  const onChange = (editor: MarkupEditorHandle, reason: 'input' | 'caret' | 'scroll' | 'blur') => {
    if (reason === 'blur') {
      close();
      return;
    }
    if (reason === 'scroll') {
      // The text moved under the list: a new tag object re-measures its anchor.
      setState((current) => current && { ...current, tag: { ...current.tag } });
      return;
    }
    if (editor.composing) {
      if (reason === 'input') composed.current = true;
      return;
    }
    const typed = reason === 'input' || composed.current;
    composed.current = false;
    const element = editor.element;
    const at =
      !disabled &&
      element.ownerDocument.activeElement === element &&
      element.selectionStart === element.selectionEnd
        ? typedTagAt(element.value, element.selectionStart, { headings })
        : null;
    if (at?.start !== dismissed.current) dismissed.current = null;
    setState((current) => {
      if (!at || at.start === dismissed.current) return null;
      // The list opens as a tag is typed, not when the caret walks into one.
      if (!typed && current?.tag.start !== at.start) return null;
      if (
        current?.handle === editor &&
        current.tag.query === at.query &&
        current.tag.end === at.end
      )
        return current;
      return { handle: editor, tag: at, active: null };
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, editor: MarkupEditorHandle) => {
    if (!open || state?.handle !== editor || isImeComposing(event)) return false;
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const count = items.length;
        setState(
          (current) =>
            current && {
              ...current,
              active: (Math.min(current.active ?? active, count - 1) + step + count) % count,
            },
        );
        return true;
      }
      case 'Enter':
      case 'Tab':
        if (event.shiftKey) return false;
        accept(active);
        return true;
      case 'Escape':
        dismissed.current = state.tag.start;
        close();
        return true;
      default:
        return false;
    }
  };

  return {
    open,
    items,
    active,
    listId,
    anchor,
    /** ARIA state for the textarea (`MarkupEditorEvents.textareaAria`). */
    aria,
    onChange,
    onKeyDown,
    accept,
    setActive: (index: number) =>
      setState((current) =>
        current && current.active !== index ? { ...current, active: index } : current,
      ),
    close,
  };
}

export type MarkupSuggestions = ReturnType<typeof useMarkupAutocomplete>;

function SuggestionIcon({ item, voices }: { item: Suggestion; voices: readonly string[] }) {
  if (item.profile)
    return (
      <ProfileAvatar
        name={item.profile.name}
        imageUrl={item.profile.image_url}
        className="size-4"
      />
    );
  switch (item.group) {
    case 'voice':
      return item.voice ? (
        <VoiceDot className={voiceAccent(item.voice, voices).dot} />
      ) : (
        <ResetDot />
      );
    case 'pause':
      return <PauseIcon className="text-amber-500" />;
    case 'delivery': {
      const Icon = DELIVERY_ICONS[deliveryKind(item.open) ?? 'slow'];
      return <Icon className="text-violet-500" />;
    }
    case 'expression':
      return <SmileIcon className="text-emerald-500" />;
  }
}

/** The suggestion list, under the `[` being typed. */
export function MarkupAutocomplete({
  suggestions,
  voices,
}: {
  suggestions: MarkupSuggestions;
  /** The order voices take their colors in. */
  voices: readonly string[];
}) {
  const { t } = useTranslation();
  const { open, items, active, listId } = suggestions;
  const list = useRef<HTMLDivElement>(null);
  const hintId = useId();
  // Keep the highlighted option in view by scrolling the list, never the page.
  useLayoutEffect(() => {
    const box = list.current;
    const option = box?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!box || !option) return;
    if (option.offsetTop < box.scrollTop) box.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = option.offsetTop + option.offsetHeight - box.clientHeight;
  }, [active, open]);
  // Mounted only while shown, and gone at once when closed: a list that
  // lingered to animate out would still be there for the next keystroke.
  if (!open) return null;
  const groups: { group: Suggestion['group']; first: number; items: Suggestion[] }[] = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last?.group === item.group) last.items.push(item);
    else groups.push({ group: item.group, first: index, items: [item] });
  });
  return (
    <Popover.Root
      open
      onOpenChange={(next) => {
        if (!next) suggestions.close();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={suggestions.anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="isolate z-50 outline-none"
        >
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            role="presentation"
            className="w-72 max-w-[calc(100vw-1rem)] origin-(--transform-origin) overflow-hidden rounded-lg surface-glass text-popover-foreground shadow-md ring-1 ring-border outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:animate-none"
            // Nothing in the list takes the focus: the caret stays in the editor.
            onMouseDown={(event) => event.preventDefault()}
          >
            <div
              ref={list}
              id={listId}
              role="listbox"
              aria-label={t('editor.suggestions')}
              aria-describedby={hintId}
              className="relative max-h-64 overflow-y-auto overscroll-contain p-1"
            >
              {groups.map(({ group, first, items: members }) => (
                <div key={group} role="group" aria-label={t(GROUP_LABELS[group])}>
                  <p
                    aria-hidden="true"
                    className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {t(GROUP_LABELS[group])}
                  </p>
                  {members.map((item, offset) => {
                    const index = first + offset;
                    return (
                      <div
                        key={item.key}
                        id={optionId(listId, index)}
                        data-index={index}
                        role="option"
                        aria-selected={index === active}
                        className="flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
                        onMouseMove={() => suggestions.setActive(index)}
                        onClick={() => suggestions.accept(index)}
                      >
                        <SuggestionIcon item={item} voices={voices} />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.detail && (
                          <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        )}
                        <code className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                          {item.close ? `${item.open}…${item.close}` : item.open}
                        </code>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <p
              id={hintId}
              className="border-t border-border/50 px-2.5 py-1.5 text-[11px] text-muted-foreground"
            >
              {t('editor.autocomplete_hint')}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
