import { useMemo, useSyncExternalStore } from 'react';
import { Menu } from '@base-ui/react/menu';
import { useTranslation } from 'react-i18next';
import { CheckIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { isMac } from '@/components/bridge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { castVoice } from './cast-map';
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_PRESETS, ZOOM_STEP } from './editor-zoom';
import { caretPosition, normalizeNewlines, voiceInEffect, voiceSwitches } from './script-markup';
import { voiceAccent } from './voice-palette';

/**
 * Where the caret is, shared by the editor (which moves it) and the status
 * bar (which shows it). The caret moves on every arrow key; keeping it out of
 * the page's state spares re-rendering the whole workspace each time.
 */
export interface CaretSource {
  get(): number;
  set(offset: number): void;
  subscribe(listener: () => void): () => void;
}

export function createCaretSource(initial = 0): CaretSource {
  let offset = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => offset,
    set(next) {
      if (next === offset) return;
      offset = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Whether two voice names read the same, ignoring case and spaces ("Hao PV" and "haopv"). */
export function sameVoiceName(a: string, b: string): boolean {
  const key = (name: string) => name.normalize('NFC').replace(/\s+/g, '').toLocaleLowerCase();
  return key(a) === key(b);
}

/**
 * The editor's bottom line: the caret's line and column, who reads the text
 * at the caret (its cast mapping, or the default voice), `stats`, and the
 * editor's zoom when `onZoomChange` is given.
 */
export function EditorStatusBar({
  text,
  caret,
  headings = false,
  names,
  voiceCast,
  profiles,
  loading = false,
  defaultVoiceName,
  stats,
  zoom,
  onZoomChange,
  className,
}: {
  text: string;
  caret: CaretSource;
  /** `# Title` lines start chapters, which start on the default voice. */
  headings?: boolean;
  /** The script's `[voice:NAME]` names in first-seen order (their colors). */
  names: readonly string[];
  voiceCast: Record<string, string>;
  profiles: { id: string; name: string }[];
  /** The profiles are still loading: a cast voice is unknown, not missing. */
  loading?: boolean;
  /** The book's default voice, when one is chosen. */
  defaultVoiceName?: string | null;
  stats?: string;
  /** The editor's text size in percent. */
  zoom?: number;
  onZoomChange?(zoom: number): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const offset = useSyncExternalStore(caret.subscribe, caret.get);
  const source = normalizeNewlines(text);
  const switches = useMemo(() => voiceSwitches(source, { headings }), [source, headings]);
  const { line, column } = caretPosition(source, offset);
  const voice = voiceInEffect(switches, offset);
  const defaultVoice = defaultVoiceName
    ? t('editor.status_default', { name: defaultVoiceName })
    : t('editor.status_default_none');
  const reader = () => {
    if (voice === null) return defaultVoice;
    const mapped = castVoice(voiceCast, voice);
    // Older Stories scripts name a profile id directly.
    const direct = mapped ? undefined : profiles.find((profile) => profile.id === voice);
    const profile = mapped
      ? (profiles.find((candidate) => candidate.id === mapped)?.name ??
        t(loading ? 'common.loading' : 'modelSettings.unavailable'))
      : (direct?.name ?? defaultVoice);
    // A name cast to the voice it is named after is said once.
    const name = direct
      ? profile
      : mapped && sameVoiceName(voice, profile)
        ? voice
        : t('editor.status_cast', { name: voice, profile });
    return t('editor.status_voice', { name });
  };
  return (
    <div
      data-slot="editor-status-bar"
      className={cn(
        'flex min-w-0 items-center gap-3 border-t border-border/50 bg-muted/20 px-3 py-1 text-[11px] leading-4 whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      <span className="shrink-0 tabular-nums">{t('editor.status_position', { line, column })}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', voiceAccent(voice, names).dot)}
        />
        <span className="truncate">{reader()}</span>
      </span>
      {stats && <span className="ms-auto min-w-0 truncate">{stats}</span>}
      {zoom !== undefined && onZoomChange && (
        <ZoomControl zoom={zoom} onChange={onZoomChange} className={stats ? '' : 'ms-auto'} />
      )}
    </div>
  );
}

const ZOOM_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs tabular-nums outline-none data-highlighted:bg-accent';

/** − / NN% / +: the editor's text size; the percentage opens the list of sizes. */
function ZoomControl({
  zoom,
  onChange,
  className,
}: {
  zoom: number;
  onChange(zoom: number): void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const percent = (value: number) =>
    (value / 100).toLocaleString(locale, { style: 'percent', maximumFractionDigits: 0 });
  const mod = isMac() ? '⌘' : 'Ctrl';
  const shortcut = (action: string, key: string) =>
    t('editor.zoom_keys', { action: t(action), keys: `${mod} ${key}` });
  return (
    <span data-slot="editor-zoom" className={cn('-me-1.5 flex shrink-0 items-center', className)}>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5 [&_svg]:size-3"
        disabled={zoom <= ZOOM_MIN}
        aria-label={t('editor.zoom_out')}
        title={shortcut('editor.zoom_out', '−')}
        onClick={() => onChange(zoom - ZOOM_STEP)}
      >
        <MinusIcon />
      </Button>
      <Menu.Root>
        <Menu.Trigger
          aria-label={t('editor.zoom_level', { percent: percent(zoom) })}
          className="min-w-10 rounded-sm px-1 text-center tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {percent(zoom)}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end" sideOffset={4} className="z-50">
            <Menu.Popup className="min-w-32 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
              {ZOOM_PRESETS.map((value) => (
                <Menu.Item key={value} className={ZOOM_ITEM} onClick={() => onChange(value)}>
                  <span className="flex w-3.5 justify-center">
                    {value === zoom && <CheckIcon className="size-3.5" />}
                  </span>
                  {value === ZOOM_DEFAULT ? t('editor.zoom_reset') : percent(value)}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5 [&_svg]:size-3"
        disabled={zoom >= ZOOM_MAX}
        aria-label={t('editor.zoom_in')}
        title={shortcut('editor.zoom_in', '+')}
        onClick={() => onChange(zoom + ZOOM_STEP)}
      >
        <PlusIcon />
      </Button>
    </span>
  );
}
