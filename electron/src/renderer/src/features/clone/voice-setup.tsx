import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  FingerprintIcon,
  LoaderCircleIcon,
  MicIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
  WandSparklesIcon,
  XIcon,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useProfiles } from '@/hooks/use-profiles';
import { useRadioKeys } from '@/hooks/use-radio-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { profileAudioUrl } from '@/lib/api/client';
import { languageOptions } from '@/lib/language-options';
import type { Profile } from '@/lib/api/types';
import { formatClock } from '@/lib/format-clock';
import { useCloneSetting } from '@/lib/store/clone-settings';
import { selectCloneProfile } from '@/lib/store/reference';
import { setWorkspace } from '@/lib/store/workspace';
import { cn } from '@/lib/utils';
import { stopAudition, toggleAudition, useAudition } from './audition';
import { ProfilePhoto, useProfileImageSave } from './profile-photo';
import { ReferenceSourcePicker } from './reference-input';

const VIRTUALIZE_ABOVE = 30;
const SEARCH_ABOVE = 4;
// Cards are at least 15rem wide: four or five columns in a 1500 px window.
const CARD_MIN_REM = 15;
const CARD_GAP = 8;
const CARD_HEIGHT = 76;
const SORT_KEY = 'voicestudio.voice-picker-sort';
const SORTS = ['recent', 'name'] as const;
type Sort = (typeof SORTS)[number];
type AddStart = 'upload' | 'record' | 'drop';

export function voiceGridPresentation(count: number): 'grid' | 'virtual' {
  return count > VIRTUALIZE_ABOVE ? 'virtual' : 'grid';
}

/** How many cards fit side by side in `width` px (`rem` px to the rem). */
export function voiceGridColumns(width: number, rem = 16): number {
  return Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_REM * rem + CARD_GAP)));
}

/**
 * The card an arrow key (or Home/End) moves to from `index` in a grid of
 * `count` cards, `columns` wide; null when there is none that way.
 */
export function gridMove(
  index: number,
  key: string,
  columns: number,
  count: number,
  rtl = false,
): number | null {
  const last = count - 1;
  let next: number;
  switch (key) {
    case 'ArrowRight':
      next = index + (rtl ? -1 : 1);
      break;
    case 'ArrowLeft':
      next = index + (rtl ? 1 : -1);
      break;
    case 'ArrowDown':
      // From the row above a short last row, land on its last card.
      if (Math.floor(index / columns) === Math.floor(last / columns)) return null;
      next = Math.min(index + columns, last);
      break;
    case 'ArrowUp':
      next = index - columns;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      return null;
  }
  return next >= 0 && next <= last && next !== index ? next : null;
}

// "ktnb-anh", "ktnb_2", "ktnb · 3", "ktnb: Lan": the word before a separator.
const PREFIX = /^\s*([\p{L}\p{N}]+)\s*[-_.:/|·]\s*\S/u;

/** The name's prefix ("ktnb" in "ktnb-anh"), compared without case; null when it has none. */
export function namePrefix(name: string): { key: string; label: string } | null {
  const match = PREFIX.exec(name.normalize('NFC'));
  return match ? { key: match[1].toLocaleLowerCase(), label: match[1] } : null;
}

/**
 * Filter chips for prefixes at least two voices share, largest group first;
 * none when no prefix narrows the list.
 */
export function namePrefixGroups(
  names: readonly string[],
  locale?: string,
): { key: string; label: string; count: number }[] {
  const groups = new Map<string, { key: string; label: string; count: number }>();
  for (const name of names) {
    const prefix = namePrefix(name);
    if (!prefix) continue;
    const group = groups.get(prefix.key);
    if (group) group.count++;
    else groups.set(prefix.key, { ...prefix, count: 1 });
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return [...groups.values()]
    .filter((group) => group.count >= 2 && group.count < names.length)
    .sort((a, b) => b.count - a.count || collator.compare(a.label, b.label));
}

function createdAt(profile: Profile): number {
  const value = profile.created_at;
  if (typeof value === 'number') return value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readSort(): Sort {
  try {
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent';
  } catch {
    return 'recent';
  }
}

/** "12s" for a reference clip, "1:05" past a minute. */
function clipLength(seconds: number, t: TFunction): string {
  return seconds < 59.5
    ? t('clone.duration_seconds', { seconds: Math.max(1, Math.round(seconds)) })
    : formatClock(seconds);
}

/** "7 Oct", with the year only when it is not this one. */
function shortDates(locale: string): (stamp: number) => string {
  const year = new Date().getFullYear();
  const thisYear = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const otherYear = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return (stamp) => (new Date(stamp).getFullYear() === year ? thisYear : otherYear).format(stamp);
}

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let element = node?.parentElement; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY === 'auto' || overflowY === 'scroll') return element;
  }
  return null;
}

function carriesAudio(data: DataTransfer | null): boolean {
  if (!data) return false;
  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
  // A photo dragged onto a card must not move the cards under it.
  if (items.length) return items.some((item) => !item.type || /^(?:audio|video)\//.test(item.type));
  return Array.from(data.types).includes('Files');
}

function AuditionButton({ profile, tabIndex }: { profile: Profile; tabIndex: number }) {
  const { t } = useTranslation();
  const key = `voice:${profile.id}`;
  const status = useAudition(key);
  const failed = status === 'failed';
  const label = t(failed ? 'player.unavailable' : 'clone.preview_voice');
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      tabIndex={tabIndex}
      aria-label={`${label}: ${profile.name}`}
      aria-pressed={status === 'playing' || status === 'loading'}
      title={status === 'playing' ? t('player.pause') : label}
      className={cn(
        'opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 max-md:opacity-100 motion-reduce:transition-none',
        status !== 'idle' && 'opacity-100',
      )}
      onClick={() => void toggleAudition(key, profileAudioUrl(profile.id, profile.audio_url))}
    >
      {status === 'loading' ? (
        <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
      ) : status === 'playing' ? (
        <PauseIcon />
      ) : status === 'failed' ? (
        <CircleAlertIcon className="text-destructive" />
      ) : (
        <PlayIcon />
      )}
    </Button>
  );
}

function VoiceCard({
  profile,
  index,
  total,
  current,
  tabbable,
  meta,
  onChoose,
  onFocusCard,
}: {
  profile: Profile;
  index: number;
  total: number;
  current: boolean;
  tabbable: boolean;
  meta: string;
  onChoose: (profile: Profile) => void;
  onFocusCard: (index: number) => void;
}) {
  const { t } = useTranslation();
  const photo = useProfileImageSave(profile);
  const tabIndex = tabbable ? 0 : -1;
  const KindIcon = profile.kind === 'design' ? WandSparklesIcon : FingerprintIcon;
  return (
    <div
      role="listitem"
      aria-setsize={total}
      aria-posinset={index + 1}
      data-slot="voice-card"
      data-voice-index={index}
      onFocus={() => onFocusCard(index)}
      className={cn(
        'group/card relative flex min-w-0 items-center gap-3 rounded-xl border bg-card/40 ps-3 pe-1.5 transition-[background-color,border-color,box-shadow] duration-150 hover:border-border hover:bg-muted/40 has-[[data-choose]:focus-visible]:ring-2 has-[[data-choose]:focus-visible]:ring-ring motion-reduce:transition-none',
        current ? 'border-primary/60 bg-primary/5' : 'border-border/60',
      )}
      style={{ height: CARD_HEIGHT }}
    >
      {/* Covers the card so the whole surface chooses the voice; photo and buttons sit above it. */}
      <button
        type="button"
        data-choose
        tabIndex={tabIndex}
        aria-label={profile.name}
        aria-current={current || undefined}
        title={profile.name}
        className="absolute inset-0 rounded-xl outline-none"
        onClick={() => onChoose(profile)}
      />
      <ProfilePhoto
        name={profile.name}
        imageUrl={profile.image_url}
        busy={photo.busy}
        onFile={(file) => void photo.save(file)}
        label={`${t('cloneFlow.change_photo')}: ${profile.name}`}
        tabIndex={tabIndex}
        className="z-10 size-11 text-sm"
      />
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="line-clamp-2 text-sm leading-5 font-medium break-words">
          {profile.name}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <KindIcon className="size-3 shrink-0" aria-hidden="true" />
          {current && <CheckIcon className="size-3 shrink-0 text-primary" aria-hidden="true" />}
          {meta && <span className="truncate tabular-nums">{meta}</span>}
        </span>
      </span>
      <span className="z-10 flex flex-col items-center gap-0.5">
        {profile.ref_audio_path ? <AuditionButton profile={profile} tabIndex={tabIndex} /> : null}
        <Button
          variant="ghost"
          size="icon-xs"
          tabIndex={tabIndex}
          aria-label={`${t('clone.edit_voice')}: ${profile.name}`}
          title={t('clone.edit_voice')}
          className="opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 max-md:opacity-100 motion-reduce:transition-none"
          onClick={() => setWorkspace({ editingProfileId: profile.id, panel: null })}
        >
          <PencilIcon />
        </Button>
      </span>
    </div>
  );
}

/**
 * The saved voices as cards in as many columns as the width allows. The page
 * scrolls, not the grid; past VIRTUALIZE_ABOVE cards only the rows in view
 * are mounted. The arrow keys (and Home/End) move between cards, Enter
 * chooses one, and Tab leaves the grid from the card it is on.
 */
function VoiceGrid({
  voices,
  selectedId,
  languageNames,
  scrollRef,
  onChoose,
}: {
  voices: Profile[];
  selectedId: string | null;
  /** Display names of the library's languages; null when it has one language. */
  languageNames: ReadonlyMap<string, string> | null;
  scrollRef?: RefObject<HTMLElement | null>;
  onChoose: (profile: Profile) => void;
}) {
  const { t, i18n } = useTranslation();
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [rem, setRem] = useState(16);
  const [scrollMargin, setScrollMargin] = useState(0);
  const presentation = voiceGridPresentation(voices.length);
  const columns = voiceGridColumns(width, rem);
  const scroller = () => scrollRef?.current ?? scrollParent(gridRef.current);
  const dates = useMemo(() => shortDates(i18n.language), [i18n.language]);
  const currentIndex = voices.findIndex((profile) => profile.id === selectedId);
  const [active, setActive] = useState(Math.max(0, currentIndex));
  const pendingFocus = useRef<number | null>(null);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      setWidth(grid.clientWidth);
      setRem(parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // Where the grid starts in the page's scroll: anything above it may grow.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const page = scrollRef?.current ?? scrollParent(grid);
    if (presentation !== 'virtual' || !grid || !page) return;
    const measure = () => {
      const offset =
        grid.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;
      setScrollMargin((value) => (Math.abs(value - offset) < 1 ? value : offset));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    for (const child of Array.from(page.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [presentation, scrollRef]);

  const rows = useVirtualizer({
    count: presentation === 'virtual' ? Math.ceil(voices.length / columns) : 0,
    getScrollElement: scroller,
    estimateSize: () => CARD_HEIGHT + CARD_GAP,
    overscan: 3,
    scrollMargin,
    getItemKey: (row) => `${columns}:${voices[row * columns]?.id}`,
  });
  const virtualRows = rows.getVirtualItems();
  const firstRendered = presentation === 'virtual' ? (virtualRows[0]?.index ?? 0) * columns : 0;
  const lastRendered =
    presentation === 'virtual'
      ? Math.min(voices.length, ((virtualRows.at(-1)?.index ?? -1) + 1) * columns) - 1
      : voices.length - 1;
  // One card holds the grid's Tab stop; out of view it falls to one in view.
  const clamped = Math.min(active, voices.length - 1);
  const tabStop = clamped >= firstRendered && clamped <= lastRendered ? clamped : firstRendered;

  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const button = gridRef.current?.querySelector<HTMLElement>(
      `[data-voice-index="${index}"] [data-choose]`,
    );
    if (!button) return;
    pendingFocus.current = null;
    button.focus();
  });

  const focusCard = (index: number) => {
    setActive(index);
    const button = gridRef.current?.querySelector<HTMLElement>(
      `[data-voice-index="${index}"] [data-choose]`,
    );
    if (button) {
      button.focus();
      return;
    }
    pendingFocus.current = index;
    rows.scrollToIndex(Math.floor(index / columns), { align: 'auto' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-voice-index]');
    if (!card) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = gridMove(Number(card.dataset.voiceIndex), event.key, columns, voices.length, rtl);
    if (next === null) return;
    event.preventDefault();
    focusCard(next);
  };

  const card = (profile: Profile, index: number) => {
    const created = createdAt(profile);
    const seconds = profile.audio_duration_seconds;
    const meta = [
      seconds ? clipLength(seconds, t) : null,
      created ? dates(created) : null,
      profile.language && languageNames ? (languageNames.get(profile.language) ?? null) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <VoiceCard
        key={profile.id}
        profile={profile}
        index={index}
        total={voices.length}
        current={profile.id === selectedId}
        tabbable={index === tabStop}
        meta={meta}
        onChoose={onChoose}
        onFocusCard={setActive}
      />
    );
  };
  const template = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };

  return presentation === 'virtual' ? (
    <div
      ref={gridRef}
      role="list"
      aria-label={t('clone.saved_profiles')}
      onKeyDown={onKeyDown}
      className="relative w-full"
      style={{ height: rows.getTotalSize() }}
    >
      {virtualRows.map((row) => (
        <div
          key={row.key}
          className="absolute inset-x-0 top-0 grid"
          style={{
            ...template,
            columnGap: CARD_GAP,
            transform: `translateY(${row.start - scrollMargin}px)`,
          }}
        >
          {voices
            .slice(row.index * columns, row.index * columns + columns)
            .map((profile, offset) => card(profile, row.index * columns + offset))}
        </div>
      ))}
    </div>
  ) : (
    <div
      ref={gridRef}
      role="list"
      aria-label={t('clone.saved_profiles')}
      onKeyDown={onKeyDown}
      className="grid"
      style={{ ...template, gap: CARD_GAP }}
    >
      {voices.map(card)}
    </div>
  );
}

/**
 * Adding a voice, folded to one row until it is wanted: Upload audio opens
 * the file picker beside a drop zone, Record the recorder, and audio dragged
 * over the window opens the drop zone. A library without voices shows it open.
 */
function AddVoice({
  start,
  open,
  closable,
  onStart,
  onClose,
}: {
  start: AddStart | null;
  open: boolean;
  closable: boolean;
  onStart: (start: AddStart) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // A drag that opened it while the list was scrolled: bring the drop zone in.
  useEffect(() => {
    if (start === 'drop') ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [start]);
  return (
    <div
      ref={ref}
      data-slot="add-voice"
      className="rounded-xl border border-dashed border-border/70 bg-muted/15 px-3 py-2.5"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <PlusIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          {t('cloneFlow.add_voice')}
        </h3>
        {!open && (
          <span className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => onStart('upload')}>
              <UploadIcon data-icon="inline-start" />
              {t('clone.upload_audio')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onStart('record')}>
              <MicIcon data-icon="inline-start" />
              {t('clone.record')}
            </Button>
          </span>
        )}
        <span className="text-xs text-muted-foreground">{t('clone.reference_hint')}</span>
        {open && closable && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="ms-auto"
            aria-label={`${t('common.close')}: ${t('cloneFlow.add_voice')}`}
            title={t('common.close')}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2.5">
          <ReferenceSourcePicker start={start === 'drop' ? undefined : (start ?? undefined)} />
        </div>
      )}
    </div>
  );
}

export function VoiceSetup({
  onChosen,
  onBack,
  scrollRef,
}: {
  onChosen: () => void;
  onBack: () => void;
  /** The page's scroll container, when the grid is not its direct content. */
  scrollRef?: RefObject<HTMLElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const profiles = useProfiles();
  const selectedId = useCloneSetting('selectedProfileId');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(readSort);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddStart | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const eligibleVoices = useMemo(
    () =>
      (profiles.data ?? []).filter((profile) => profile.kind === 'clone' && profile.ref_audio_path),
    [profiles.data],
  );
  const groups = useMemo(
    () =>
      namePrefixGroups(
        eligibleVoices.map((profile) => profile.name),
        i18n.language,
      ),
    [eligibleVoices, i18n.language],
  );
  const activePrefix = groups.some((group) => group.key === prefix) ? prefix : null;
  const voices = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const matches = eligibleVoices.filter(
      (profile) =>
        (!activePrefix || namePrefix(profile.name)?.key === activePrefix) &&
        (!normalized || profile.name.toLocaleLowerCase().includes(normalized)),
    );
    const collator = new Intl.Collator(i18n.language, { sensitivity: 'base', numeric: true });
    return matches.sort((a, b) =>
      sort === 'name' ? collator.compare(a.name, b.name) : createdAt(b) - createdAt(a),
    );
  }, [eligibleVoices, query, sort, activePrefix, i18n.language]);
  // Each card names its language only when the library mixes languages, in
  // the app's language ("Tiếng Việt", not the stored "Vietnamese").
  const languageNames = useMemo(() => {
    const stored = new Set<string>();
    for (const profile of eligibleVoices)
      if (profile.language && profile.language !== 'Auto') stored.add(profile.language);
    if (stored.size < 2) return null;
    return new Map(
      languageOptions([...stored], i18n.language, '').map((option) => [option.value, option.label]),
    );
  }, [eligibleVoices, i18n.language]);
  const empty = !profiles.isPending && eligibleVoices.length === 0;
  const searchable = eligibleVoices.length > SEARCH_ABOVE;

  // "/" jumps to the search box from anywhere but a text field.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || !searchRef.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('input, textarea, select, [role="dialog"], [role="menu"]'))
      )
        return;
      event.preventDefault();
      searchRef.current.focus();
      searchRef.current.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (carriesAudio(event.dataTransfer)) setAdding((value) => value ?? 'drop');
    };
    window.addEventListener('dragenter', onDragEnter);
    return () => window.removeEventListener('dragenter', onDragEnter);
  }, []);

  useEffect(() => stopAudition, []);

  const chooseSort = (next: Sort) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // Sorting still applies for this session.
    }
  };
  const chooseVoice = (profile: Profile) => {
    stopAudition();
    selectCloneProfile(profile);
    onChosen();
  };
  // One Tab stop each; the arrow keys move and choose (ARIA radio groups).
  const sortKeys = useRadioKeys(SORTS, sort, chooseSort);
  const prefixes = useMemo(() => [null, ...groups.map((group) => group.key)], [groups]);
  const prefixKeys = useRadioKeys(prefixes, activePrefix, setPrefix);
  const chip = (key: string | null, label: string, count: number, index: number) => (
    <button
      key={key ?? ''}
      type="button"
      role="radio"
      aria-checked={activePrefix === key}
      {...prefixKeys.option(index)}
      onClick={() => setPrefix(key)}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
        activePrefix === key
          ? 'border-primary/50 bg-primary/10 text-foreground'
          : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
      )}
    >
      {label}
      <span className="font-normal tabular-nums opacity-70">{count}</span>
    </button>
  );

  return (
    <section className="flex w-full flex-col gap-5">
      <div className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('preferences.back')}
          title={t('preferences.back')}
          className="mt-0.5"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">{t('cloneFlow.choose_voice')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('cloneFlow.choose_hint')}</p>
        </div>
      </div>
      <AddVoice
        start={adding}
        open={adding !== null || empty}
        closable={!empty}
        onStart={setAdding}
        onClose={() => setAdding(null)}
      />
      {eligibleVoices.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="me-auto flex items-center gap-2 text-sm font-medium">
              {t('clone.saved_profiles')}
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground tabular-nums">
                {eligibleVoices.length}
              </span>
            </h3>
            {searchable && (
              <div className="relative w-full sm:w-64">
                <SearchIcon
                  className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={t('common.search')}
                  aria-keyshortcuts="/"
                  placeholder={t('common.search')}
                  className="h-8 ps-8 pe-8 text-sm"
                />
                {!query && (
                  <Kbd aria-hidden="true" className="absolute end-2 top-1/2 -translate-y-1/2">
                    /
                  </Kbd>
                )}
              </div>
            )}
            {eligibleVoices.length > 1 && (
              <div
                role="radiogroup"
                aria-label={t('cloneFlow.sort_label')}
                {...sortKeys.group}
                className="flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5 ring-1 ring-inset ring-border/50"
              >
                {SORTS.map((value, index) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={sort === value}
                    {...sortKeys.option(index)}
                    onClick={() => chooseSort(value)}
                    className={cn(
                      'h-7 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      sort === value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t(value === 'recent' ? 'cloneFlow.sort_recent' : 'cloneFlow.sort_name')}
                  </button>
                ))}
              </div>
            )}
          </div>
          {groups.length > 0 && (
            <div
              role="radiogroup"
              aria-label={t('cloneFlow.prefix_label')}
              {...prefixKeys.group}
              className="flex flex-wrap items-center gap-1.5"
            >
              {chip(null, t('clone.history_all'), eligibleVoices.length, 0)}
              {groups.map((group, index) => chip(group.key, group.label, group.count, index + 1))}
            </div>
          )}
          {voices.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('preferences.no_matches')}
            </p>
          ) : (
            <VoiceGrid
              voices={voices}
              selectedId={selectedId}
              languageNames={languageNames}
              scrollRef={scrollRef}
              onChoose={chooseVoice}
            />
          )}
        </div>
      )}
      {profiles.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('preferences.loading')}
        </p>
      )}
    </section>
  );
}
