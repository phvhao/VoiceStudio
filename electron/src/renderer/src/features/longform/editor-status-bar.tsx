import { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { castVoice } from './cast-map';
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

/**
 * The editor's bottom line: the caret's line and column, who reads the text
 * at the caret (its cast mapping, or the default voice), and `stats`.
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
    return t('editor.status_voice', {
      name: direct ? profile : t('editor.status_cast', { name: voice, profile }),
    });
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
    </div>
  );
}
