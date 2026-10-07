import type { TFunction } from 'i18next';
import { getBridge } from '@/components/bridge';
import { apiFetch, apiJson, apiPath } from '@/lib/api/client';
import { saveExport } from '@/lib/export-history';
import { storyToSpans } from '@shared/utils/storyToSpans';
import { designRequest, type HtmlDesign } from './html-design';
import { bookLanguageTag, type Draft, type Mode } from './longform-session';

/** The exported page's own words, in the app's language. */
export function htmlExportLabels(t: TFunction) {
  return {
    play: t('book.html_play'),
    pause: t('book.html_pause'),
    back: t('book.html_back'),
    forward: t('book.html_forward'),
    seek: t('book.html_seek'),
    speed: t('book.html_speed'),
    contents: t('book.contents'),
    narrated_by: t('book.html_narrated_by'),
    player: t('book.html_player'),
    estimated: t('book.html_estimated'),
    keys: t('book.html_keys'),
    keys_chapter: t('book.html_keys_chapter'),
    // A chapter the script left untitled; the page puts in its number.
    chapter_n: t('audiobook.chapter_n', { n: '{n}' }),
    // The text before the first chapter heading.
    intro: t('book.intro_heading'),
    prev_chapter: t('book.html_prev_chapter'),
    next_chapter: t('book.html_next_chapter'),
    settings: t('book.html_settings'),
    text_size: t('book.html_text_size'),
    smaller: t('book.html_smaller'),
    larger: t('book.html_larger'),
    theme: t('book.html_theme'),
    theme_auto: t('book.html_theme_auto'),
    theme_light: t('book.html_theme_light'),
    theme_sepia: t('book.html_theme_sepia'),
    theme_dark: t('book.html_theme_dark'),
    align: t('book.html_align'),
    justify: t('book.html_justify'),
    align_start: t('book.html_align_start'),
    follow: t('book.html_follow'),
    back_to_current: t('book.html_back_to_current'),
    shortcuts: t('book.html_shortcuts'),
    close: t('book.html_close'),
  };
}

export interface HtmlExportOptions {
  mode?: Mode;
  /** The page's design; the backend's default template when left out. */
  design?: HtmlDesign | null;
  /** Names to show for a book's voices: a profile id → its name. */
  voiceNames?: Record<string, string>;
}

/**
 * `POST /audiobook/export/html` for the draft's finished book or story. The
 * script and chapter lengths it was rendered from go along: a book rendered
 * before timelines were kept gets one estimated from them. A story sends its
 * lines as its render posted them — each line's start and character — which
 * marks it a story and gives one rendered before its timeline said who reads
 * each line its turns: the lines it was rendered from when the draft kept
 * them (`outputStory`), else its lines as they stand. The page's own words are in the app's language and
 * direction; the book's text keeps its own language.
 */
export function htmlExportBody(
  draft: Draft,
  t: TFunction,
  lang: string,
  direction: 'ltr' | 'rtl' = 'ltr',
  { mode = 'audiobook', design = null, voiceNames }: HtmlExportOptions = {},
) {
  const durations = draft.outputChapters.map((chapter) =>
    chapter.status === 'failed'
      ? null
      : chapter.duration_ms != null
        ? chapter.duration_ms / 1000
        : (chapter.duration_s ?? Number.NaN),
  );
  const timed = durations.length > 0 && durations.every((d) => d === null || Number.isFinite(d));
  const story = mode === 'stories';
  return {
    output: draft.output,
    title: draft.title,
    metadata: draft.metadata,
    cover_path: draft.cover?.path ?? null,
    text: draft.outputScript || null,
    chapter_durations: (draft.outputScript || story) && timed ? durations : null,
    lang,
    direction,
    book_lang: bookLanguageTag(draft.language),
    labels: htmlExportLabels(t),
    ...(design ? { design: designRequest(design) } : {}),
    ...(story
      ? {
          story:
            draft.outputStory ??
            storyToSpans(draft.lines, draft.cast, draft.globalSpeed, { layout: true }),
        }
      : {}),
    ...(voiceNames && Object.keys(voiceNames).length ? { voice_names: voiceNames } : {}),
  };
}

/** The ZIP's name in the save dialog: the book's title, else its file name. */
export function htmlExportName(draft: Draft): string {
  const stem = draft.title.trim() || draft.output.replace(/\.[^.]+$/, '') || 'audiobook';
  return `${stem}.zip`;
}

/**
 * Build the book's web-page export and save it like every other export: the
 * native save dialog under Electron, a download in the browser. The backend
 * hands the ZIP out once and then removes it: it is a full copy of the book.
 * A save that is cancelled or fails never fetches it, so it is discarded.
 * Resolves to how it ended: `saved`, `canceled` or `downloaded`.
 */
export async function exportBookHtml(
  draft: Draft,
  t: TFunction,
  lang: string,
  direction: 'ltr' | 'rtl' = 'ltr',
  options: HtmlExportOptions = {},
): Promise<'saved' | 'canceled' | 'downloaded'> {
  const { id } = await apiJson<{ id: string }>('/audiobook/export/html', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(htmlExportBody(draft, t, lang, direction, options)),
  });
  const path = '/audiobook/export/html/' + encodeURIComponent(id);
  const url = apiPath(path);
  const name = htmlExportName(draft);
  if (getBridge()) {
    // Best-effort: whatever is left is removed when the backend next starts.
    const discard = () => apiFetch(path, { method: 'DELETE' }).catch(() => undefined);
    const saved = await saveExport(url, name).catch(async (error: unknown) => {
      await discard();
      throw error;
    });
    if (!saved || saved.canceled) {
      await discard();
      return 'canceled';
    }
    return 'saved';
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  return 'downloaded';
}
