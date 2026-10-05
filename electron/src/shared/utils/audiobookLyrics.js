/**
 * Synced-lyrics timing for the audiobook player — pure, testable text→cue
 * functions, no React and no network. The player highlights the word under
 * `audio.currentTime`, so everything here reduces to: which words exist per
 * chapter, and what `[start, end]` window each one owns inside the final file.
 *
 * Timing sources, in order (mirrors backend/services/karaoke_ass.py):
 *
 * 0. The book's timeline sidecar (`GET /audiobook/timeline/{output}`), when
 *    the render wrote one: the exact start and end of every phrase take
 *    (sentence or clause), measured while the chapter was assembled. Words
 *    come from its phrases and are interpolated by character weight inside
 *    each one. Chapters it could only time coarsely say so in `precision`.
 * 1. Per-chapter durations the render stream already emits (`chapter` SSE
 *    events carry `duration_s`) — no new backend work, no ASR pass. Words
 *    inside a chapter are even-split across its span, exactly like the
 *    karaoke burn-in's old-job fallback.
 * 2. When those durations are unavailable, the whole book's words are
 *    even-split over the audio element's own duration, chapter spans falling
 *    out proportionally by word count.
 *
 * Chapter/token parsing reuses the canonical JS grammar twin, including
 * `[spell]` expansion, so cue count and order match the backend render.
 */
import { parseScriptToSpans } from './longformParser';

const WS = /\s+/;

/**
 * Uniformly distribute a text's whitespace tokens over `[start, end]` —
 * a direct port of `karaoke_ass.even_split_words`. Returns
 * `[{ text, start, end }]`; empty for blank text.
 */
export function evenSplitWords(text, start, end) {
  const tokens = String(text || '')
    .trim()
    .split(WS)
    .filter(Boolean);
  if (!tokens.length) return [];
  const s = Number(start) || 0;
  const dur = Math.max(0, (Number(end) || 0) - s) / tokens.length;
  return tokens.map((tok, i) => ({ text: tok, start: s + i * dur, end: s + (i + 1) * dur }));
}

/**
 * Split a script into the chapters the backend parser would render, each with
 * its display tokens: `[{ title, tokens }]`. Control tokens (voice / pause /
 * SSML-lite) are stripped — they shape delivery, nobody hears them — while
 * reaction tags (`[laughs]`…) stay: the engine performs those, so they get a
 * highlight window like any word. A chapter the script gave no title has
 * title '', for the reader to name in its own language. Returns `[]` for a
 * blank script.
 */
export function scriptChapters(script) {
  return parseScriptToSpans(String(script || '')).map(({ title, spans, untitled }) => ({
    title: untitled ? '' : title,
    tokens: spans.flatMap((span) => span.text.split(WS).filter(Boolean)),
  }));
}

/**
 * Build the full highlight timeline for a rendered book.
 *
 * @param {string} script     the script the render was created from
 * @param {object} opts
 * @param {Array}  [opts.chapters]  the tab's per-chapter stream state, aligned
 *   with the backend plan: `{ title, status, duration_s }` where status is
 *   done | cached | failed. Failed chapters are absent from the muxed audio,
 *   so they get no cue and no time.
 * @param {number} [opts.duration]  the audio element's total duration — the
 *   proportional fallback used when stream timings are absent or don't line
 *   up with the script (edited after the render, stopped mid-book, …).
 * @param {object} [opts.timeline]  the render's timeline sidecar. When it
 *   holds any chapter it wins over both estimates, and the words are the
 *   ones the audio speaks — the script may have changed since.
 * @returns {{ chapters: Array<{title, start, end, wordStart, wordCount, precision}>,
 *            words: Array<{text, start, end, chapterIndex, phrase?}>,
 *            phrases?: Array<{start, end, wordStart, wordCount, chapterIndex, voice}> }}
 */
export function buildLyricsTimeline(
  script,
  { chapters = null, duration = 0, timeline = null } = {},
) {
  const sidecar = readTimeline(timeline);
  if (sidecar) return sidecarLyrics(sidecar);
  const parsed = scriptChapters(script);
  const empty = { chapters: [], words: [] };
  if (!parsed.length) return empty;

  const timed =
    Array.isArray(chapters) &&
    chapters.length === parsed.length &&
    chapters.every((c) => c?.status === 'failed' || Number.isFinite(c?.duration_s));

  const outChapters = [];
  const words = [];
  if (timed) {
    let at = 0;
    for (let i = 0; i < parsed.length; i++) {
      if (chapters[i].status === 'failed') continue; // not in the audio
      const start = at;
      const end = at + Math.max(0, chapters[i].duration_s);
      pushChapter(outChapters, words, parsed[i], chapters[i].title, start, end);
      at = end;
    }
    return { chapters: outChapters, words };
  }

  const total = Number(duration) || 0;
  if (total <= 0) return empty;
  const totalTokens = parsed.reduce((n, c) => n + c.tokens.length, 0);
  if (!totalTokens) return empty;
  // Proportional even split: every word owns the same slice of the file, so
  // chapter spans fall out of their word counts. Wordless (pause-only)
  // chapters get a zero-width span — nothing to highlight there anyway.
  const per = total / totalTokens;
  let at = 0;
  for (const chapter of parsed) {
    const end = at + chapter.tokens.length * per;
    pushChapter(outChapters, words, chapter, '', at, end);
    at = end;
  }
  return { chapters: outChapters, words };
}

function pushChapter(outChapters, words, parsedChapter, streamTitle, start, end) {
  const wordStart = words.length;
  const split = evenSplitWords(parsedChapter.tokens.join(' '), start, end);
  const chapterIndex = outChapters.length;
  for (const w of split) words.push({ ...w, chapterIndex });
  outChapters.push({
    // The render names an untitled chapter in English ("Chapter 1"): leave it
    // to the reader, which names it in the app's language.
    title: parsedChapter.title && (streamTitle || parsedChapter.title),
    start,
    end,
    wordStart,
    wordCount: split.length,
    precision: 'estimate',
  });
}

const PRECISIONS = new Set(['phrase', 'span', 'chapter']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The usable part of a timeline sidecar (format version 1), or null when it
 * holds no chapter. Defensive, since it is a file on disk: entries without
 * finite times are dropped, times are clamped to run forward, and an unknown
 * precision reads as `"chapter"` (nothing inside the chapter trusted).
 */
export function readTimeline(timeline) {
  if (!timeline || timeline.version !== 1 || !Array.isArray(timeline.chapters)) return null;
  const chapters = [];
  let at = 0;
  for (const chapter of timeline.chapters) {
    if (!chapter || !finite(chapter.start) || !finite(chapter.end)) continue;
    const start = Math.max(at, chapter.start);
    const end = Math.max(start, chapter.end);
    const phrases = [];
    let from = start;
    for (const phrase of Array.isArray(chapter.phrases) ? chapter.phrases : []) {
      if (!phrase || typeof phrase.text !== 'string') continue;
      if (!finite(phrase.start) || !finite(phrase.end)) continue;
      const phraseStart = Math.min(end, Math.max(from, phrase.start));
      const phraseEnd = Math.min(end, Math.max(phraseStart, phrase.end));
      phrases.push({
        text: phrase.text,
        start: phraseStart,
        end: phraseEnd,
        voice: typeof phrase.voice === 'string' ? phrase.voice : null,
      });
      from = phraseEnd;
    }
    // Its `## Section` headings, where each is heard.
    const sections = (Array.isArray(chapter.sections) ? chapter.sections : [])
      .filter((section) => section && typeof section.title === 'string' && finite(section.start))
      .map((section) => ({
        title: section.title,
        level: section.level === 3 ? 3 : 2,
        start: Math.min(end, Math.max(start, section.start)),
      }));
    chapters.push({
      // An untitled chapter carries the file's English "Chapter N": the
      // reader names it in the app's language instead.
      title: typeof chapter.title === 'string' && !chapter.untitled ? chapter.title : '',
      start,
      end,
      precision: PRECISIONS.has(chapter.precision) ? chapter.precision : 'chapter',
      phrases,
      sections,
    });
    at = end;
  }
  return chapters.length ? { chapters } : null;
}

// Letters, marks and digits carry the speech; punctuation takes no time.
const SPOKEN_CHAR = /[\p{L}\p{M}\p{N}]/gu;

/**
 * Words of one timed phrase over `[start, end]`, each owning a share of it
 * proportional to its letters. A punctuation-only token (a dash, a lone
 * quote) spans no time: it starts where the next word starts, so the word —
 * not the mark — stays lit.
 */
export function interpolateWords(text, start, end) {
  const tokens = String(text || '')
    .trim()
    .split(WS)
    .filter(Boolean);
  const weights = tokens.map((token) => token.match(SPOKEN_CHAR)?.length ?? 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return evenSplitWords(text, start, end);
  const per = Math.max(0, end - start) / total;
  let at = 0;
  return tokens.map((token, i) => {
    const word = { text: token, start: start + at * per, end: start + (at + weights[i]) * per };
    at += weights[i];
    return word;
  });
}

function sidecarLyrics({ chapters }) {
  const outChapters = [];
  const words = [];
  const phrases = [];
  chapters.forEach(({ title, start, end, precision, phrases: timed, sections }) => {
    const chapterIndex = outChapters.length;
    const wordStart = words.length;
    // Nothing inside the chapter is known: today's even split over it.
    const units =
      precision === 'chapter'
        ? [{ text: timed.map((p) => p.text).join(' '), start, end, voice: null, even: true }]
        : timed;
    for (const unit of units) {
      const phrase = phrases.length;
      const split = unit.even
        ? evenSplitWords(unit.text, unit.start, unit.end)
        : interpolateWords(unit.text, unit.start, unit.end);
      if (!split.length) continue;
      phrases.push({
        start: unit.start,
        end: unit.end,
        wordStart: words.length,
        wordCount: split.length,
        chapterIndex,
        voice: unit.voice,
      });
      for (const w of split) words.push({ ...w, chapterIndex, phrase });
    }
    const wordCount = words.length - wordStart;
    // Each section from the first word heard at or after its heading.
    const chapterWords = words.slice(wordStart);
    const at = (time) => {
      const index = chapterWords.findIndex((word) => word.start >= time - 1e-6);
      return wordStart + (index < 0 ? wordCount : index);
    };
    outChapters.push({
      title,
      start,
      end,
      wordStart,
      wordCount,
      precision,
      sections: sections.map((section) => ({ ...section, wordStart: at(section.start) })),
    });
  });
  return { chapters: outChapters, words, phrases };
}

/**
 * Index of the word under playback time `t`: the last word whose start is
 * ≤ `t` (binary search — cue lists run to tens of thousands of words), or -1
 * before the first word. Inside a pause the previous word stays lit, matching
 * the karaoke sweep's "gaps finish the previous word" behaviour.
 */
export function activeWordIndex(words, t) {
  if (!Array.isArray(words) || !words.length || !(t >= words[0].start)) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
