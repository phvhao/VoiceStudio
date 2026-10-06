import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  BookOpenTextIcon,
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  LocateFixedIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SkipBackIcon,
  SkipForwardIcon,
  TableOfContentsIcon,
  XIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { chapterName } from './chapter-name';
import { useMediaState, useMediaTime, type MediaPlayerInstance } from '@/components/media-player';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  activeWordIndex,
  scriptChapters,
  type AudiobookLyricsChapter,
  type AudiobookLyricsTimeline,
  type AudiobookLyricsWord,
} from '@shared/utils/audiobookLyrics';
import { tokenizeMarkup, type MarkupKind } from './script-markup';

/**
 * Read-along for a rendered audiobook: the book model (words, sentences and
 * paragraphs over the lyrics timeline), the transport controls the inline
 * player card shares, and the reader dialog. Every control drives the one
 * media element of the surrounding `StudioMediaPlayer`.
 */

type PlayerRef = RefObject<MediaPlayerInstance | null>;

/** How a word follows the one before it in the script. */
export type WordGap = 'joined' | 'space' | 'line' | 'paragraph';

export interface ReaderWord extends AudiobookLyricsWord {
  /** What the reader shows: `[[term|respelling]]` reads as its term; '' hides a fragment. */
  display: string;
  gap: WordGap;
  /** A performed tag such as `[laughter]`. */
  tag: boolean;
}

export interface ReaderSentence {
  /** Words `start` (inclusive) to `end` (exclusive) of `ReaderBook.words`. */
  start: number;
  end: number;
}

export interface ReaderChapter extends AudiobookLyricsChapter {
  /** Each paragraph as a `[start, end)` range of `ReaderBook.sentences`. */
  paragraphs: Array<[number, number]>;
}

export interface ReaderBook {
  chapters: ReaderChapter[];
  words: ReaderWord[];
  sentences: ReaderSentence[];
  /** The language of the book's text, which the app's own may not be; '' unknown. */
  lang?: string;
}

type WordShape = Pick<ReaderWord, 'display' | 'gap' | 'tag'>;

interface ChapterLayout {
  tokens: string[];
  shapes: WordShape[];
}

// Markup the parser drops before speaking: no spoken token comes from it.
const UNSPOKEN: ReadonlySet<MarkupKind> = new Set([
  'heading',
  // A section's `##` marks; its title is read aloud.
  'section',
  'voice',
  'voiceReset',
  'pause',
  'delivery',
  'volume',
]);
// The parser splits tokens on JS whitespace; the walk below must agree.
const WHITESPACE = /\s/;

// `[[term|respelling]]` is spoken as the respelling but written as the term;
// `[[respelling]]` shows the respelling. NUL marks characters kept hidden, so
// offsets keep lining up with the script.
function writtenTerm(token: string): string {
  const inner = token.slice(2, -2);
  const bar = inner.indexOf('|');
  const term = bar < 0 ? inner : inner.slice(0, bar);
  return '\0\0' + term + '\0'.repeat(token.length - 2 - term.length);
}

interface ScriptText {
  /** Unspoken markup turned to whitespace, for matching the parser's tokens. */
  spoken: string;
  /** What the reader shows per character, hidden markup as NUL. */
  written: string;
  /** Offsets where a performed tag starts. */
  tags: Set<number>;
  /** Characters of bracket tags the parser leaves in the text (performed or unknown). */
  bracketed: boolean[];
  /** Offsets where a chapter heading starts. */
  headings: number[];
}

// Both strings keep the script's offsets: `spoken` for matching the parser's
// tokens, `written` for display, markup hidden (so `[slow]so[/slow].` still
// reads "so.").
function scriptText(script: string): ScriptText {
  const text = script.replace(/\r\n?/g, '\n');
  let spoken = '';
  let written = '';
  const tags = new Set<number>();
  const bracketed: boolean[] = [];
  const headings: number[] = [];
  for (const { text: part, kind } of tokenizeMarkup(text, { headings: true })) {
    if (kind === 'heading') headings.push(spoken.length);
    if (UNSPOKEN.has(kind)) {
      spoken += ' '.repeat(part.length);
      written += '\0'.repeat(part.length);
    } else {
      if (kind === 'expression') tags.add(spoken.length);
      spoken += part;
      written += kind === 'pronunciation' ? writtenTerm(part) : part;
    }
    const tag = kind === 'expression' || kind === 'unknown';
    for (let i = 0; i < part.length; i++) bracketed.push(tag);
  }
  return { spoken, written, tags, bracketed, headings };
}

/** How a word follows the one before it, judged by what is shown between them. */
function gapOf(between: string): WordGap {
  const breaks = between.split('\n').length - 1;
  return breaks > 1 ? 'paragraph' : breaks ? 'line' : WHITESPACE.test(between) ? 'space' : 'joined';
}

/**
 * How each spoken token of each parsed chapter was written: line and
 * paragraph breaks, glued fragments (`[spell]` letters) and display text.
 * The estimated timeline keeps only the tokens, so this walks the script
 * beside the parser. Null when the walk loses step with it (a grammar
 * drift); the reader then shows plain words.
 */
function scriptLayout(script: string, { spoken, written, tags }: ScriptText) {
  const layouts: ChapterLayout[] = [];
  let at = 0;
  for (const { tokens } of scriptChapters(script)) {
    const shapes: WordShape[] = [];
    for (const token of tokens) {
      const from = at;
      while (at < spoken.length && WHITESPACE.test(spoken[at])) at++;
      if (!spoken.startsWith(token, at)) return null;
      // A space inside a hidden respelling does not part the words around it.
      shapes.push({
        display: written.slice(at, at + token.length).replaceAll('\0', ''),
        gap: gapOf(written.slice(from, at)),
        tag: tags.has(at),
      });
      at += token.length;
    }
    layouts.push({ tokens, shapes });
  }
  return layouts;
}

/** The shown, non-blank characters of a text, each with where it came from. */
interface Keyed {
  keys: string;
  /** Per key character: its script offset, or the index of its word. */
  at: number[];
}

interface WrittenChapter {
  all: Keyed;
  /** Without bracket tags: a timeline may leave performed tags out of its text. */
  bare: Keyed;
}

/**
 * Each heading-delimited stretch of the script as the characters a reader
 * sees. Stretches the parser drops (blank, markup only) stay; pairing by
 * text passes over them.
 */
function writtenChapters({ written, bracketed, headings }: ScriptText): WrittenChapter[] {
  const bounds = [0, ...headings, written.length];
  const chapters: WrittenChapter[] = [];
  for (let c = 0; c + 1 < bounds.length; c++) {
    const all: Keyed = { keys: '', at: [] };
    const bare: Keyed = { keys: '', at: [] };
    for (let i = bounds[c]; i < bounds[c + 1]; i++) {
      const char = written[i];
      if (char === '\0' || WHITESPACE.test(char)) continue;
      all.keys += char;
      all.at.push(i);
      if (bracketed[i]) continue;
      bare.keys += char;
      bare.at.push(i);
    }
    chapters.push({ all, bare });
  }
  return chapters;
}

const BRACKET_TAG = /\[[^\][]*\]/g;

/** The words' non-blank characters, each with the index of its word. */
function keyedWords(words: readonly AudiobookLyricsWord[], bare: boolean): Keyed {
  const joined = words.map((word) => word.text).join(' ');
  const owner: number[] = [];
  words.forEach((word, k) => {
    for (let i = 0; i <= word.text.length; i++) owner.push(k);
  });
  const hidden = new Set<number>();
  if (bare) {
    for (const match of joined.matchAll(BRACKET_TAG)) {
      for (let i = 0; i < match[0].length; i++) hidden.add(match.index + i);
    }
  }
  const keyed: Keyed = { keys: '', at: [] };
  for (let i = 0; i < joined.length; i++) {
    if (hidden.has(i) || WHITESPACE.test(joined[i])) continue;
    keyed.keys += joined[i];
    keyed.at.push(owner[i]);
  }
  return keyed;
}

function isTag(word: string): boolean {
  return tokenizeMarkup(word)[0]?.kind === 'expression';
}

/**
 * Shapes for words taken from the render's own text (a timeline sidecar).
 * They already read as written, so only their breaks come from the script,
 * found by matching the two character for character. Null when this script
 * chapter is not the text the words were spoken from.
 */
function alignedShapes(
  written: string,
  chapter: WrittenChapter,
  words: readonly AudiobookLyricsWord[],
): WordShape[] | null {
  for (const bare of [false, true]) {
    const script = bare ? chapter.bare : chapter.all;
    const spoken = keyedWords(words, bare);
    if (spoken.keys !== script.keys) continue;
    // First and last script offsets of each word's characters.
    const first: number[] = [];
    const last: number[] = [];
    spoken.at.forEach((word, i) => {
      first[word] ??= script.at[i];
      last[word] = script.at[i];
    });
    let after = -1;
    return words.map((word, k) => {
      const from = first[k];
      const gap = from === undefined || after < 0 ? 'space' : gapOf(written.slice(after, from));
      if (from !== undefined) after = last[k] + 1;
      return { display: word.text, gap, tag: isTag(word.text) };
    });
  }
  return null;
}

// A run of sentence-final marks — Latin, ellipsis, CJK fullwidth, Devanagari
// danda, Arabic and Urdu — then any closing quotes or brackets
// (chunked_tts._PHRASE_CLOSERS). Escapes keep the source free of CJK.
const SENTENCE_END =
  /([.!?\u2026\u3002\uff01\uff1f\u0964\u0965\u061f\u06d4]+)["'\u201d\u2019\u00bb)\u300d\u300f\uff09]*$/;
// A lone period after one of these does not end a sentence (the backend's
// chunked_tts._ABBREVIATIONS).
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'ave',
  'blvd',
  'inc',
  'ltd',
  'corp',
  'dept',
  'est',
  'approx',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'u.s',
  'u.s.a',
  'u.k',
]);

/**
 * Whether `word` closes its sentence when `next` follows it. A lower-case
 * `next` carries the sentence on (`"Ready?" she asked`), and so does a lone
 * period after a number or a common abbreviation, like the backend's phrase
 * splitter.
 */
export function endsSentence(word: string, next: string): boolean {
  const mark = SENTENCE_END.exec(word);
  if (!mark || /^[^\p{L}\p{N}]*\p{Ll}/u.test(next)) return false;
  if (mark[1] !== '.') return true;
  const stem = word.slice(0, mark.index);
  if (/\p{N}$/u.test(stem)) return false;
  return !ABBREVIATIONS.has(stem.replace(/^[^\p{L}]+/u, '').toLowerCase());
}

function sameTokens(tokens: readonly string[], words: readonly AudiobookLyricsWord[]) {
  return tokens.length === words.length && tokens.every((token, i) => token === words[i].text);
}

/**
 * Group the lyrics timeline into what the reader shows: sentences and
 * paragraphs (blank lines and chapter starts). Where the render timed every
 * phrase take, those phrases are the sentences, so the highlight moves
 * exactly with the voice; elsewhere sentences split after sentence-final
 * punctuation, as the renderer phrases them. Every line break starts one.
 * Breaks come from the script when it still holds the text, else from the
 * timeline sidecar's own `break` marks.
 */
export function buildReaderBook(script: string, timeline: AudiobookLyricsTimeline): ReaderBook {
  const text = scriptText(script);
  const timed = timeline.chapters.some((chapter) => chapter.precision !== 'estimate');
  const layouts = timed ? [] : (scriptLayout(script, text) ?? []);
  const written = timed ? writtenChapters(text) : [];
  const words: ReaderWord[] = [];
  const sentences: ReaderSentence[] = [];
  let nextLayout = 0;
  let nextWritten = 0;
  // Failed chapters are missing from the audio and from the timeline: pair
  // each timed chapter with the next script chapter whose text matches.
  const shapesFor = (spoken: AudiobookLyricsWord[], estimate: boolean): WordShape[] => {
    if (estimate) {
      let match = nextLayout;
      while (match < layouts.length && !sameTokens(layouts[match].tokens, spoken)) match++;
      if (match >= layouts.length) return [];
      nextLayout = match + 1;
      return layouts[match].shapes;
    }
    for (let match = nextWritten; match < written.length; match++) {
      const shapes = alignedShapes(text.written, written[match], spoken);
      if (!shapes) continue;
      nextWritten = match + 1;
      return shapes;
    }
    return [];
  };
  const chapters = timeline.chapters.map((chapter): ReaderChapter => {
    const spoken = timeline.words.slice(chapter.wordStart, chapter.wordStart + chapter.wordCount);
    const estimate = chapter.precision === 'estimate';
    const exact = chapter.precision === 'phrase';
    const shapes = shapesFor(spoken, estimate);
    const paragraphs: Array<[number, number]> = [];
    // Last shown text of the open sentence: hidden fragments never end one.
    let tail = '';
    spoken.forEach((word, k) => {
      // The script no longer holds this text (edited since, or never kept):
      // the render's own timeline still says where lines and paragraphs began.
      const shape: WordShape = shapes[k] ?? {
        display: word.text,
        gap: word.break ?? 'space',
        tag: !estimate && isTag(word.text),
      };
      const gap = k === 0 ? 'paragraph' : shape.gap;
      if (
        k === 0 ||
        gap === 'line' ||
        gap === 'paragraph' ||
        (exact
          ? word.phrase !== spoken[k - 1].phrase
          : shape.display !== '' && tail !== '' && endsSentence(tail, shape.display))
      ) {
        if (gap === 'paragraph') paragraphs.push([sentences.length, sentences.length]);
        sentences.push({ start: words.length, end: words.length });
        tail = '';
      }
      words.push({ ...word, display: shape.display, gap, tag: shape.tag });
      sentences[sentences.length - 1].end = words.length;
      paragraphs[paragraphs.length - 1][1] = sentences.length;
      if (shape.display) tail = shape.display;
    });
    return { ...chapter, paragraphs };
  });
  return { chapters, words, sentences };
}

/** Index of the last item starting at or before `value`, -1 before the first. */
function lastStartingBy(items: ReadonlyArray<{ start: number }>, value: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= value) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// Media clocks round: a seek to a chapter's first sample can read back a hair
// before it.
const CLOCK_SLACK_S = 0.05;
// "Previous chapter" restarts the current one once this far in, like a track list.
const RESTART_AFTER_S = 3;

/** Index of the chapter playing at `time`, -1 before the first. */
export function chapterAt(chapters: ReadonlyArray<{ start: number }>, time: number): number {
  return lastStartingBy(chapters, time + CLOCK_SLACK_S);
}

// Both steps skip chapters that share a start with their neighbour (wordless
// ones span no time in a book without chapter timings).

/** Where "previous chapter" goes from `time`; null when already at the book's start. */
export function previousChapterStart(
  chapters: ReadonlyArray<{ start: number }>,
  time: number,
): number | null {
  const current = chapterAt(chapters, time);
  if (current < 0) return null;
  const start = chapters[current].start;
  if (time - start <= RESTART_AFTER_S) {
    for (let i = current - 1; i >= 0; i--) {
      if (chapters[i].start < start - CLOCK_SLACK_S) return chapters[i].start;
    }
  }
  return time - start > CLOCK_SLACK_S ? start : null;
}

/** Where "next chapter" goes from `time`; null in the last chapter. */
export function nextChapterStart(
  chapters: ReadonlyArray<{ start: number }>,
  time: number,
): number | null {
  for (let i = chapterAt(chapters, time) + 1; i < chapters.length; i++) {
    if (chapters[i].start > time + CLOCK_SLACK_S) return chapters[i].start;
  }
  return null;
}

/**
 * Scroll offset that brings the span `[start, end]` (content coordinates) of a
 * viewport `size` long, scrolled to `scroll`, back into its reading zone: null
 * while it is already there, else the offset that puts it a third of the way in.
 */
export function followScroll(
  start: number,
  end: number,
  scroll: number,
  size: number,
  max: number,
): number | null {
  if (start >= scroll + size * 0.1 && end <= scroll + size * 0.75) return null;
  const target = Math.round(Math.max(0, Math.min(max, start - size * 0.3)));
  return Math.abs(target - scroll) < 1 ? null : target;
}

/**
 * `followScroll` along one line of text, in either direction: where to set
 * the line's `scrollLeft` to bring the word at `offsetLeft…+width` into view
 * (null while it is in view), and whether the line is scrolled off its start.
 * Right to left, the line starts at its right edge and Chromium's
 * `scrollLeft` runs from 0 down to minus the overflow.
 */
export function followLine(
  word: { offsetLeft: number; offsetWidth: number },
  line: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  rtl: boolean,
): { left: number | null; scrolled: boolean } {
  const { offsetLeft, offsetWidth } = word;
  const { clientWidth, scrollWidth } = line;
  // Distances from the line's start edge, and how far it is scrolled from it.
  const start = rtl ? clientWidth - (offsetLeft + offsetWidth) : offsetLeft;
  const scroll = rtl ? -line.scrollLeft : line.scrollLeft;
  const target = followScroll(
    start,
    start + offsetWidth,
    scroll,
    clientWidth,
    scrollWidth - clientWidth,
  );
  return {
    left: target === null ? null : rtl && target ? -target : target,
    scrolled: (target ?? scroll) > 0,
  };
}

/** `M:SS`, or `H:MM:SS` for a book an hour or longer. */
export function playbackClock(seconds: number, hours = false): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const ss = String(total % 60).padStart(2, '0');
  const mm = String(Math.floor(total / 60) % 60).padStart(2, '0');
  return hours ? `${Math.floor(total / 3600)}:${mm}:${ss}` : `${Math.floor(total / 60)}:${ss}`;
}

/** A chapter's name in the reader: as the lists name it (see `chapterName`). */
export function chapterTitle(t: TFunction, book: ReaderBook, index: number): string {
  return chapterName(t, book.chapters, index);
}

export interface SentencePiece {
  word: number;
  /** Separator rendered before the word: '' or a space. */
  lead: string;
  text: string;
}

/** A sentence as the reader renders it; its text is the pieces joined. */
export function sentencePieces(book: ReaderBook, index: number): SentencePiece[] {
  const { start, end } = book.sentences[index];
  const pieces: SentencePiece[] = [];
  let shown = false;
  for (let word = start; word < end; word++) {
    const { display, gap } = book.words[word];
    pieces.push({ word, lead: display && shown && gap !== 'joined' ? ' ' : '', text: display });
    if (display) shown = true;
  }
  return pieces;
}

// The media clock ticks every animation frame while the book plays. Each
// control below subscribes to what it shows of it (a word, a chapter, the
// clock text), so it re-renders only when that changes.

/** Index of the word under the playhead, -1 before the first. */
export function usePlayingWord(book: ReaderBook): number {
  return useMediaTime((time) => activeWordIndex(book.words, time));
}

/** Index of the chapter under the playhead, -1 before the first. */
export function usePlayingChapter(book: ReaderBook): number {
  return useMediaTime((time) => chapterAt(book.chapters, time));
}

/** Word, sentence and chapter under the playhead. */
export function usePlayhead(book: ReaderBook) {
  const word = usePlayingWord(book);
  const chapter = usePlayingChapter(book);
  return { word, sentence: word < 0 ? -1 : lastStartingBy(book.sentences, word), chapter };
}

/** Move the playhead, clamped to the file. */
function seekTo(player: PlayerRef, time: number) {
  const media = player.current;
  if (!media) return;
  const end = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : Infinity;
  media.currentTime = Math.max(0, Math.min(end, time));
}

function togglePlayback(player: PlayerRef) {
  const media = player.current;
  if (!media) return;
  if (media.paused) void media.play().catch(() => {});
  else void media.pause().catch(() => {});
}

export function PlayPauseButton({ player, className }: { player: PlayerRef; className?: string }) {
  const { t } = useTranslation();
  const paused = useMediaState('paused');
  const waiting = useMediaState('waiting');
  const canPlay = useMediaState('canPlay');
  const error = useMediaState('error');
  return (
    <Button
      type="button"
      size="icon"
      className={cn('shrink-0 rounded-full', className)}
      disabled={Boolean(error) || !canPlay}
      aria-label={t(paused ? 'player.play' : 'player.pause')}
      aria-pressed={!paused}
      aria-busy={waiting}
      onClick={() => togglePlayback(player)}
    >
      {error ? (
        <CircleAlertIcon />
      ) : waiting ? (
        <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
      ) : paused ? (
        <PlayIcon />
      ) : (
        <PauseIcon />
      )}
    </Button>
  );
}

// The seek thumb's diameter: fill and chapter marks follow its centre, which
// travels from half a thumb in at either end.
const THUMB_PX = 12;
const along = (fraction: number) =>
  `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${fraction})`;

/**
 * The playhead as a seek bar `travel` pixels long shows it: it moves on only
 * when the thumb would move a whole pixel or the clock a whole second, so
 * the bar redraws about once a second through a long book instead of every
 * frame. Whole seconds while the bar's length is unknown.
 */
export function seekBarTime(time: number, total: number, travel: number): number {
  if (!(total > 0) || !Number.isFinite(time)) return 0;
  const now = Math.max(0, Math.min(time, total));
  if (now === total) return total;
  const second = Math.floor(now);
  if (!(travel > 0)) return second;
  const pixel = total / travel;
  return Math.max(second, Math.floor(now / pixel) * pixel);
}

/** Seek bar with a mark at every chapter start after the first. */
export function SeekBar({
  player,
  chapters,
  onSeek,
  className,
}: {
  player: PlayerRef;
  chapters: ReadonlyArray<{ start: number }>;
  onSeek?(): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const duration = useMediaState('duration');
  const error = useMediaState('error');
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const bar = useRef<HTMLDivElement>(null);
  // How far the thumb's centre travels; observed, never read from layout.
  const [travel, setTravel] = useState(0);
  useEffect(() => {
    const element = bar.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setTravel(Math.max(0, Math.round(entry.contentRect.width) - THUMB_PX));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const now = useMediaTime((time) => seekBarTime(time, total, travel));
  const hours = total >= 3600;
  return (
    // A timeline runs left to right in every language: the thumb, the fill and
    // the chapter marks all measure from the left.
    <div
      ref={bar}
      dir="ltr"
      className={cn(
        'relative flex h-5 min-w-0 items-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/12"
      >
        <div className="h-full bg-primary" style={{ width: total ? along(now / total) : 0 }} />
        {total > 0 &&
          chapters.map(
            (chapter, index) =>
              index > 0 &&
              chapter.start > 0 &&
              chapter.start < total && (
                // The canvas colour itself: glass surfaces clear `bg-background`.
                <span
                  key={index}
                  data-chapter-mark=""
                  className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-(--background)"
                  style={{ left: along(chapter.start / total) }}
                />
              ),
          )}
      </div>
      <input
        type="range"
        min={0}
        max={total || 1}
        step="0.01"
        value={now}
        disabled={!total || Boolean(error)}
        aria-label={t('player.seek')}
        aria-valuetext={`${playbackClock(now, hours)} / ${playbackClock(total, hours)}`}
        className="relative h-5 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:invisible [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_var(--background)]"
        onInput={(event) => {
          seekTo(player, Number(event.currentTarget.value));
          onSeek?.();
        }}
      />
    </div>
  );
}

export function PlaybackTime({
  part = 'both',
  className,
}: {
  part?: 'elapsed' | 'total' | 'both';
  className?: string;
}) {
  const duration = useMediaState('duration');
  const hours = Number.isFinite(duration) && duration >= 3600;
  const elapsed = useMediaTime((time) => playbackClock(time, hours));
  const total = playbackClock(duration, hours);
  return (
    <span
      className={cn('shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground', className)}
    >
      {part === 'elapsed' ? elapsed : part === 'total' ? total : `${elapsed} / ${total}`}
    </span>
  );
}

const MENU_POPUP =
  'max-h-[min(60vh,24rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none';
const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-highlighted:bg-accent';

const RATES = [0.75, 1, 1.25, 1.5, 2];

export function RateMenu({ player }: { player: PlayerRef }) {
  const { t, i18n } = useTranslation();
  const rate = useMediaState('playbackRate');
  const format = (value: number) =>
    `${value.toLocaleString(i18n.resolvedLanguage || i18n.language)}×`;
  const label = t('reader.speed', { rate: format(rate) });
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'xs' }),
          'min-w-11 font-mono tabular-nums',
        )}
        aria-label={label}
        title={label}
      >
        {format(rate)}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={cn(MENU_POPUP, 'min-w-28')}>
            <Menu.RadioGroup value={rate}>
              {RATES.map((value) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  closeOnClick
                  className={MENU_ITEM}
                  onClick={() => {
                    if (player.current) player.current.playbackRate = value;
                  }}
                >
                  <span className="flex size-3.5 items-center justify-center">
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-3.5" />
                    </Menu.RadioItemIndicator>
                  </span>
                  <span className="font-mono tabular-nums">{format(value)}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ChapterStepButton({
  direction,
  player,
  chapters,
  onSeek,
}: {
  direction: 'previous' | 'next';
  player: PlayerRef;
  chapters: ReadonlyArray<{ start: number }>;
  onSeek?(): void;
}) {
  const { t } = useTranslation();
  const target = useMediaTime((time) =>
    direction === 'next' ? nextChapterStart(chapters, time) : previousChapterStart(chapters, time),
  );
  const label = t(direction === 'next' ? 'reader.next_chapter' : 'reader.previous_chapter');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={target === null}
      aria-label={label}
      title={label}
      onClick={() => {
        if (target === null) return;
        seekTo(player, target);
        onSeek?.();
      }}
    >
      {direction === 'next' ? <SkipForwardIcon /> : <SkipBackIcon />}
    </Button>
  );
}

function SkipButton({
  seconds,
  player,
  onSeek,
}: {
  seconds: -10 | 10;
  player: PlayerRef;
  onSeek(): void;
}) {
  const { t } = useTranslation();
  const label = t(seconds < 0 ? 'reader.back_10' : 'reader.forward_10');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => {
        seekTo(player, (player.current?.currentTime ?? 0) + seconds);
        onSeek();
      }}
    >
      {seconds < 0 ? <RotateCcwIcon /> : <RotateCwIcon />}
    </Button>
  );
}

const ChapterMenu = memo(function ChapterMenu({
  book,
  player,
  current,
  onSeek,
}: {
  book: ReaderBook;
  player: PlayerRef;
  current: number;
  onSeek(): void;
}) {
  const { t } = useTranslation();
  const hours = (book.chapters.at(-1)?.end ?? 0) >= 3600;
  return (
    <Menu.Root>
      <Menu.Trigger
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        aria-label={t('reader.chapters')}
      >
        <TableOfContentsIcon />
        <span className="hidden sm:inline">{t('reader.chapters')}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={cn(MENU_POPUP, 'w-80 max-w-[calc(100vw-2rem)]')}>
            <Menu.RadioGroup value={current}>
              {book.chapters.map((chapter, index) => (
                <Menu.RadioItem
                  key={index}
                  value={index}
                  closeOnClick
                  className={cn(MENU_ITEM, 'data-checked:text-primary')}
                  onClick={() => {
                    seekTo(player, chapter.start);
                    onSeek();
                  }}
                >
                  <span className="w-6 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{chapterTitle(t, book, index)}</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {playbackClock(chapter.start, hours)}
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
});

function ReaderHeader({
  book,
  player,
  onSeek,
}: {
  book: ReaderBook;
  player: PlayerRef;
  onSeek(): void;
}) {
  const { t } = useTranslation();
  const chapter = usePlayingChapter(book);
  return (
    <div className="flex items-center gap-3 border-b border-border/50 py-3 pe-3 ps-5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <BookOpenTextIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
          <DialogTitle className="shrink-0 text-xs font-medium text-muted-foreground">
            {t('audiobook.lyrics')}
          </DialogTitle>
          {chapter >= 0 && book.chapters.length > 1 && (
            <span className="truncate">
              · {t('reader.chapter_of', { n: chapter + 1, total: book.chapters.length })}
            </span>
          )}
        </div>
        <p className="truncate text-base font-semibold">
          {chapter >= 0 ? chapterTitle(t, book, chapter) : '\u00a0'}
        </p>
      </div>
      {book.chapters.length > 1 && (
        <ChapterMenu book={book} player={player} current={chapter} onSeek={onSeek} />
      )}
      <DialogClose
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.close')}
            title={t('common.close')}
          />
        }
      >
        <XIcon />
      </DialogClose>
    </div>
  );
}

type SentenceState = 'past' | 'current' | 'future';

const SENTENCE =
  'cursor-pointer rounded-sm box-decoration-clone transition-[color,background-color,box-shadow] duration-200 hover:bg-accent/60 motion-reduce:transition-none';

// Only the sentence being read splits into word spans (for the word colour);
// the rest stay text runs, so a whole book stays a light DOM. Neither state
// changes a glyph's metrics, so nothing reflows as reading moves on.
const ReaderSentenceText = memo(function ReaderSentenceText({
  book,
  index,
  state,
  activeWord,
  activeRef,
}: {
  book: ReaderBook;
  index: number;
  state: SentenceState;
  activeWord: number;
  activeRef: RefObject<HTMLSpanElement | null>;
}) {
  const pieces = sentencePieces(book, index);
  let content: ReactNode[];
  if (state === 'current') {
    content = pieces.map(({ word, lead, text }) => (
      <Fragment key={word}>
        {lead}
        <span
          data-word={word}
          ref={word === activeWord ? activeRef : undefined}
          aria-current={word === activeWord || undefined}
          className={cn(
            'transition-colors duration-150 motion-reduce:transition-none',
            word < activeWord && 'text-foreground/55',
            book.words[word].tag && 'text-muted-foreground',
            word === activeWord && 'text-primary',
          )}
        >
          {text}
        </span>
      </Fragment>
    ));
  } else {
    // Merge plain words into runs; performed tags keep a muted span.
    content = [];
    let run = '';
    for (const { word, lead, text } of pieces) {
      if (!book.words[word].tag) {
        run += lead + text;
        continue;
      }
      content.push(run + lead);
      run = '';
      content.push(
        <span key={word} className="text-muted-foreground">
          {text}
        </span>,
      );
    }
    content.push(run);
  }
  return (
    <span
      data-sentence={index}
      className={cn(
        SENTENCE,
        state === 'past' && 'text-foreground/55',
        state === 'current' && 'bg-primary/10 ring-[3px] ring-primary/10 hover:bg-primary/10',
      )}
    >
      {content}
    </span>
  );
});

/**
 * `active` as one part of the book sees it, where `from`–`to` is that part's
 * range: the real index inside it, +Infinity once read past it, -1 before it.
 * Parts the reading is not in keep the same props word after word, so their
 * memoized components skip rendering.
 */
function relativeTo(active: number, from: number, to: number): number {
  return active < from ? -1 : active >= to ? Number.POSITIVE_INFINITY : active;
}

const ReaderParagraph = memo(function ReaderParagraph({
  book,
  from,
  to,
  activeSentence,
  activeWord,
  activeRef,
}: {
  book: ReaderBook;
  /** Sentences `from` (inclusive) to `to` (exclusive). */
  from: number;
  to: number;
  /** The sentence being read, as `relativeTo` this paragraph. */
  activeSentence: number;
  activeWord: number;
  activeRef: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <p>
      {Array.from({ length: to - from }, (_, k) => {
        const sentence = from + k;
        const gap = book.words[book.sentences[sentence].start].gap;
        return (
          <Fragment key={sentence}>
            {k > 0 && (gap === 'line' ? <br /> : gap === 'joined' ? null : ' ')}
            <ReaderSentenceText
              book={book}
              index={sentence}
              state={
                sentence < activeSentence
                  ? 'past'
                  : sentence === activeSentence
                    ? 'current'
                    : 'future'
              }
              activeWord={sentence === activeSentence ? activeWord : -1}
              activeRef={activeRef}
            />
          </Fragment>
        );
      })}
    </p>
  );
});

const ReaderChapterSection = memo(function ReaderChapterSection({
  book,
  index,
  activeSentence,
  activeWord,
  activeRef,
  onPlayFrom,
}: {
  book: ReaderBook;
  index: number;
  /** The sentence being read; past chapters pass +Infinity, coming ones -1. */
  activeSentence: number;
  activeWord: number;
  activeRef: RefObject<HTMLSpanElement | null>;
  onPlayFrom(time: number): void;
}) {
  const { t } = useTranslation();
  const chapter = book.chapters[index];
  return (
    <section>
      <h3 className="mb-3 text-start">
        <button
          type="button"
          className="rounded-md text-start font-heading text-lg font-semibold outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => onPlayFrom(chapter.start)}
        >
          {chapterTitle(t, book, index)}
        </button>
      </h3>
      <div className="space-y-4">
        {chapter.paragraphs.map(([from, to]) => {
          const active = relativeTo(activeSentence, from, to);
          return (
            <ReaderParagraph
              key={from}
              book={book}
              from={from}
              to={to}
              activeSentence={active}
              activeWord={active >= from && active < to ? activeWord : -1}
              activeRef={activeRef}
            />
          );
        })}
      </div>
    </section>
  );
});

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === 'function') {
    const caret = document.caretPositionFromPoint(x, y);
    return caret && { node: caret.offsetNode, offset: caret.offset };
  }
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y);
    return range && { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/** The word under a click in a sentence rendered as text; its first word without caret APIs. */
function wordAtPoint(book: ReaderBook, index: number, element: HTMLElement, x: number, y: number) {
  const pieces = sentencePieces(book, index);
  const caret = caretAt(x, y);
  if (!caret || !element.contains(caret.node)) return book.sentences[index].start;
  // Characters before the caret across the sentence's text nodes.
  let offset = caret.offset;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && node !== caret.node; node = walker.nextNode()) {
    offset += node.textContent?.length ?? 0;
  }
  let end = 0;
  for (const { word, lead, text } of pieces) {
    end += lead.length + text.length;
    if (text && offset <= end) return word;
  }
  return book.sentences[index].end - 1;
}

const Transcript = memo(function Transcript({
  book,
  activeWord,
  activeRef,
  onPlayFrom,
  onPlayWord,
}: {
  book: ReaderBook;
  activeWord: number;
  activeRef: RefObject<HTMLSpanElement | null>;
  onPlayFrom(time: number): void;
  onPlayWord(word: number): void;
}) {
  const activeSentence = activeWord < 0 ? -1 : lastStartingBy(book.sentences, activeWord);
  const activeChapter = activeWord < 0 ? -1 : book.words[activeWord].chapterIndex;
  // One delegated handler for every word: a click plays from the word under
  // it; a drag that selected text is left alone.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (window.getSelection()?.isCollapsed === false) return;
    const target = event.target as HTMLElement;
    const word = target.closest<HTMLElement>('[data-word]');
    const sentence = target.closest<HTMLElement>('[data-sentence]');
    if (word) onPlayWord(Number(word.dataset.word));
    else if (sentence) {
      const index = Number(sentence.dataset.sentence);
      onPlayWord(wordAtPoint(book, index, sentence, event.clientX, event.clientY));
    }
  };
  return (
    <div
      // Body text set justified like a book, without automatic hyphenation
      // (it breaks Vietnamese words); each paragraph's last line stays at the start.
      className="mx-auto max-w-[68ch] space-y-10 text-justify text-[15px] leading-8 text-foreground hyphens-manual [text-align-last:start] [text-justify:inter-word]"
      onClick={onClick}
    >
      {book.chapters.map((_, index) => (
        <ReaderChapterSection
          key={index}
          book={book}
          index={index}
          activeSentence={
            index < activeChapter
              ? Number.POSITIVE_INFINITY
              : index > activeChapter
                ? -1
                : activeSentence
          }
          activeWord={index === activeChapter ? activeWord : -1}
          activeRef={activeRef}
          onPlayFrom={onPlayFrom}
        />
      ))}
    </div>
  );
});

// Keys that scroll the transcript by hand.
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

function ReaderTranscript({
  book,
  player,
  paneRef,
  following,
  onFollowingChange,
}: {
  book: ReaderBook;
  player: PlayerRef;
  paneRef: RefObject<HTMLDivElement | null>;
  following: boolean;
  onFollowingChange(following: boolean): void;
}) {
  const { t } = useTranslation();
  const activeWord = usePlayingWord(book);
  const activeRef = useRef<HTMLSpanElement>(null);
  const pointerDown = useRef(false);
  const settled = useRef(false);
  // Where the glide this started is heading, until it ends. Following
  // measures against it rather than the offset mid-glide, which is stale by
  // the next frame and would re-aim (restart) the glide word after word.
  const gliding = useRef<number | null>(null);

  useEffect(() => {
    const release = () => {
      pointerDown.current = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  // Follow the reading inside the pane only: offsets are layout positions
  // (the dialog's open animation scales client rects), and the page under
  // the dialog never scrolls. Runs when the word being read changes, a few
  // times a second, never per clock tick.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const word = activeRef.current;
    if (!following) gliding.current = null;
    if (!following || !pane || !word) return;
    const scroll = gliding.current ?? pane.scrollTop;
    const size = pane.clientHeight;
    const start = word.offsetTop;
    const top = followScroll(
      start,
      start + word.offsetHeight,
      scroll,
      size,
      pane.scrollHeight - size,
    );
    // The first position after opening and long jumps land at once; reading glides.
    const jump = !settled.current || (top !== null && Math.abs(top - scroll) > size * 2);
    settled.current = true;
    if (top === null) return;
    pane.scrollTo({ top, behavior: jump ? 'instant' : 'auto' });
    gliding.current = jump ? null : top;
  }, [activeWord, following, paneRef]);

  const playFrom = useCallback(
    (time: number) => {
      seekTo(player, time);
      void player.current?.play().catch(() => {});
      onFollowingChange(true);
    },
    [onFollowingChange, player],
  );
  // A hair past the word's start, so clock rounding cannot light the one before.
  const playWord = useCallback(
    (index: number) => {
      const word = book.words[index];
      if (word) playFrom(Math.min(word.end, word.start + 0.001));
    },
    [book, playFrom],
  );

  // Only the reader's own gestures stop following; its programmatic scrolls
  // and layout shifts never do.
  const stop = () => onFollowingChange(false);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={paneRef}
        role="region"
        aria-label={t('reader.transcript')}
        tabIndex={0}
        className="relative h-full overflow-y-auto scroll-smooth px-6 py-8 outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset motion-reduce:scroll-auto sm:px-10"
        onWheel={(event) => {
          if (!event.ctrlKey && event.deltaY !== 0) stop();
        }}
        onTouchMove={stop}
        onKeyDown={(event) => {
          if (SCROLL_KEYS.has(event.key)) stop();
        }}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onScroll={() => {
          // Scrollbar drags, and selections dragged past the edge.
          if (pointerDown.current) stop();
        }}
        onScrollEnd={() => {
          gliding.current = null;
        }}
      >
        {book.words.length ? (
          // The book's own language and direction, which the app's may not be.
          <div lang={book.lang} dir="auto">
            <Transcript
              book={book}
              activeWord={activeWord}
              activeRef={activeRef}
              onPlayFrom={playFrom}
              onPlayWord={playWord}
            />
          </div>
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">{t('reader.empty')}</p>
        )}
      </div>
      {!following && activeWord >= 0 && (
        <Button
          type="button"
          size="sm"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-lg"
          onClick={() => onFollowingChange(true)}
        >
          <LocateFixedIcon />
          {t('reader.back_to_current')}
        </Button>
      )}
    </div>
  );
}

function ReaderFooter({
  book,
  player,
  onSeek,
}: {
  book: ReaderBook;
  player: PlayerRef;
  onSeek(): void;
}) {
  const { t } = useTranslation();
  const chapters = book.chapters.length > 1;
  return (
    <div className="space-y-2 border-t border-border/50 px-5 pt-3 pb-3">
      <div className="flex items-center gap-3">
        <PlaybackTime part="elapsed" />
        <SeekBar player={player} chapters={book.chapters} onSeek={onSeek} className="flex-1" />
        <PlaybackTime part="total" />
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
          {t('reader.shortcuts')}
        </p>
        <div className="col-start-2 flex items-center gap-1">
          {chapters && (
            <ChapterStepButton
              direction="previous"
              player={player}
              chapters={book.chapters}
              onSeek={onSeek}
            />
          )}
          <SkipButton seconds={-10} player={player} onSeek={onSeek} />
          <PlayPauseButton player={player} className="size-10" />
          <SkipButton seconds={10} player={player} onSeek={onSeek} />
          {chapters && (
            <ChapterStepButton
              direction="next"
              player={player}
              chapters={book.chapters}
              onSeek={onSeek}
            />
          )}
        </div>
        <div className="flex justify-end">
          <RateMenu player={player} />
        </div>
      </div>
      <TimingNote book={book} />
    </div>
  );
}

/** Says the highlight is estimated, while the chapter playing was not timed phrase by phrase. */
function TimingNote({ book }: { book: ReaderBook }) {
  const { t } = useTranslation();
  const playing = usePlayingChapter(book);
  const chapter = book.chapters[Math.max(0, playing)];
  if (!chapter || chapter.precision === 'phrase') return null;
  return (
    <DialogDescription className="text-center text-[11px] text-muted-foreground">
      {t('reader.estimated')}
    </DialogDescription>
  );
}

// Controls that answer Space or the arrow keys themselves keep them.
const USES_SPACE =
  'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role^="menuitem"], [role="tab"], [role="slider"], [role="combobox"]';
const USES_ARROWS =
  'input, select, textarea, [contenteditable="true"], [role="slider"], [role="combobox"], [role="listbox"], [role="menu"], [role="menubar"], [role="radiogroup"], [role="tablist"], [role="toolbar"]';

/**
 * Full-window read-along over the inline player's audio element: the
 * transcript by chapter, paragraph and sentence, following the playhead.
 * Render it inside the `StudioMediaPlayer` that owns `player`.
 */
export function AudiobookReader({
  open,
  onOpenChange,
  player,
  book,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  player: PlayerRef;
  book: ReaderBook;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  // Every opening follows the playhead again. Adjusted while rendering, so
  // the first frame already lands on the line being read.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setFollowing(true);
  }
  // Every jump the listener asks for brings the transcript back to the playhead.
  const follow = useCallback(() => setFollowing(true), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    const target = event.target as Element;
    if (event.key === ' ' && !target.closest(USES_SPACE)) {
      event.preventDefault();
      togglePlayback(player);
    } else if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      !target.closest(USES_ARROWS)
    ) {
      event.preventDefault();
      seekTo(player, (player.current?.currentTime ?? 0) + (event.key === 'ArrowLeft' ? -5 : 5));
      follow();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        initialFocus={pane}
        className="flex h-[min(90vh,52rem)] w-[min(96vw,64rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onKeyDown={onKeyDown}
      >
        <ReaderHeader book={book} player={player} onSeek={follow} />
        <ReaderTranscript
          book={book}
          player={player}
          paneRef={pane}
          following={following}
          onFollowingChange={setFollowing}
        />
        <ReaderFooter book={book} player={player} onSeek={follow} />
      </DialogContent>
    </Dialog>
  );
}
