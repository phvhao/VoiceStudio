import { LANG_CODES } from '@shared/utils/languages';
import type { AudiobookRenderChapter, Draft, Line, Mode } from './longform-session';

/** A finished render as `GET /longform/jobs` lists it (the fields recovery reads). */
export interface RecoverableRender {
  job_id: string;
  type?: 'story' | 'audiobook';
  title?: string;
  output: string;
  /** The library project it was rendered from; renders made before the library have none. */
  project_id?: string;
  /** Whether its reading timeline — the text it was read from — was kept. */
  timeline?: boolean;
  summary?: { voices?: { id: string; name: string }[]; language?: string; format?: string };
}

interface TimelinePhrase {
  text?: unknown;
  voice?: unknown;
  start?: unknown;
  end?: unknown;
  /** A newer timeline marks where a paragraph or a line starts. */
  break?: unknown;
}
interface TimelineChapter {
  title?: unknown;
  untitled?: unknown;
  start?: unknown;
  end?: unknown;
  phrases?: unknown;
  sections?: unknown;
}
export interface RenderTimeline {
  chapters?: unknown;
}

export const renderMode = (render: Pick<RecoverableRender, 'type'>): Mode =>
  render.type === 'story' ? 'stories' : 'audiobook';

/** Whether a render made before the library kept enough to rebuild its book. */
export const canRecoverRender = (render: RecoverableRender) => render.timeline === true;

const list = <T>(value: unknown): T[] =>
  Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const seconds = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
/** A phrase's voice: a cast name (Audiobook) or profile id (Stories); '' = the default voice. */
const voiceOf = (phrase: TimelinePhrase): string | null =>
  phrase.voice === null || phrase.voice === undefined ? null : String(phrase.voice);

/**
 * The book a render made before the library was read from, rebuilt from its
 * reading timeline: chapter and section headings, the text and who reads it,
 * and the settings its summary recorded. Markup the timeline does not keep
 * (pauses, delivery tags, pronunciations) is not recovered. `null` when the
 * timeline holds no text.
 */
export function draftFromRender(
  render: RecoverableRender,
  timeline: RenderTimeline,
  newId: () => string = () => crypto.randomUUID(),
): Partial<Draft> | null {
  const mode = renderMode(render);
  const chapters = list<TimelineChapter>(timeline.chapters);
  const order: string[] = []; // voices in the order they are first heard
  const script: string[] = [];
  const lines: Line[] = [];
  for (const chapter of chapters) {
    const title = chapter.untitled === true ? '' : text(chapter.title);
    const block: string[] = [];
    if (title) {
      block.push('# ' + title);
      lines.push({ id: newId(), text: '# ' + title, profileId: null });
    }
    const sections = new Map<number, { title: string; level: number }[]>();
    for (const section of list<{ title?: unknown; level?: unknown; phrase?: unknown }>(
      chapter.sections,
    )) {
      const at = typeof section.phrase === 'number' ? section.phrase : -1;
      const heading = text(section.title);
      if (at < 0 || !heading) continue;
      const level = section.level === 3 ? 3 : 2;
      sections.set(at, [...(sections.get(at) ?? []), { title: heading, level }]);
    }
    // Every chapter starts in the default voice, as the parser reads it.
    let voice = '';
    let paragraph = '';
    const endParagraph = () => {
      if (paragraph) block.push(paragraph);
      paragraph = '';
    };
    list<TimelinePhrase>(chapter.phrases).forEach((phrase, index) => {
      for (const section of sections.get(index) ?? []) {
        endParagraph();
        block.push('#'.repeat(section.level) + ' ' + section.title);
      }
      const words = text(phrase.text);
      if (!words) return;
      const heard = voiceOf(phrase);
      if (heard !== null && !order.includes(heard)) order.push(heard);
      if (phrase.break === 'paragraph') endParagraph();
      else if (phrase.break === 'line' && paragraph) paragraph += '\n';
      let tag = '';
      if (heard !== null && heard !== voice) {
        tag = heard ? `[voice:${heard}] ` : '[voice:] ';
        voice = heard;
      }
      paragraph += (paragraph && !paragraph.endsWith('\n') ? ' ' : '') + tag + words;
      // Stories: one line per run of one voice.
      const last = lines[lines.length - 1];
      const profileId = heard || null;
      if (last && !last.text.startsWith('#') && last.profileId === profileId && heard !== null)
        last.text += ' ' + words;
      else lines.push({ id: newId(), text: words, profileId });
    });
    endParagraph();
    if (block.length) script.push(block.join('\n\n'));
  }
  if (!lines.some((line) => !line.text.startsWith('#'))) return null;

  // The summary lists the profiles in the order the spans first used them,
  // which is the order the timeline first hears its voices: zipped, they give
  // the default voice and the cast — unless two names shared a profile.
  const voices = Array.isArray(render.summary?.voices) ? render.summary.voices : [];
  const zipped = voices.length === order.length;
  const defaultVoice = zipped
    ? voices[order.indexOf('')]?.id
    : order[0] === ''
      ? voices[0]?.id
      : undefined;
  const voiceCast =
    mode === 'audiobook' && zipped
      ? Object.fromEntries(order.flatMap((name, index) => (name ? [[name, voices[index].id]] : [])))
      : {};
  const language = render.summary?.language || '';
  const known = LANG_CODES.find((entry) => entry.label === language || entry.code === language);
  const book = script.join('\n\n');
  const outputChapters: AudiobookRenderChapter[] = chapters.map((chapter) => ({
    // An untitled chapter's title is the render's English "Chapter N": left
    // blank (and marked), every list names it in the app's language.
    ...(chapter.untitled === true ? { title: '', untitled: true } : { title: text(chapter.title) }),
    status: 'done',
    duration_s: Math.max(0, seconds(chapter.end) - seconds(chapter.start)),
  }));
  return {
    title: text(render.title),
    ...(mode === 'audiobook' ? { script: book } : { lines }),
    voiceCast,
    voice: defaultVoice || null,
    language: known?.label ?? 'Auto',
    format: render.summary?.format === 'mp3' ? 'mp3' : 'm4b',
    output: render.output,
    outputScript: mode === 'audiobook' ? book : '',
    outputChapters,
  };
}
