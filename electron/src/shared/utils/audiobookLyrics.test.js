/**
 * Synced-lyrics timing (audiobook player). `evenSplitWords` mirrors
 * `backend/services/karaoke_ass.even_split_words` (same fixtures as
 * tests/test_karaoke_ass.py's even-split cases); the chapter split mirrors
 * `backend/services/longform_parser.py`'s drop rules so cue indices line up
 * with the render stream's chapter list.
 */
import { describe, it, expect } from 'vitest';
import {
  activeWordIndex,
  buildLyricsTimeline,
  evenSplitWords,
  interpolateWords,
  readTimeline,
  scriptChapters,
} from './audiobookLyrics';

describe('evenSplitWords', () => {
  it('distributes tokens uniformly over [start, end]', () => {
    const words = evenSplitWords('one two three four', 10, 12);
    expect(words.map((w) => w.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(words[0].start).toBeCloseTo(10);
    expect(words[0].end).toBeCloseTo(10.5);
    expect(words[2].start).toBeCloseTo(11);
    expect(words[3].end).toBeCloseTo(12);
  });

  it('collapses arbitrary whitespace and returns [] for blank text', () => {
    expect(evenSplitWords('  a \n b\t c  ', 0, 3).map((w) => w.text)).toEqual(['a', 'b', 'c']);
    expect(evenSplitWords('   ', 0, 3)).toEqual([]);
    expect(evenSplitWords('', 0, 3)).toEqual([]);
  });

  it('clamps a degenerate span to zero-length windows instead of going backwards', () => {
    const words = evenSplitWords('a b', 5, 4);
    expect(words[0].start).toBeCloseTo(5);
    expect(words[1].end).toBeCloseTo(5);
  });
});

describe('scriptChapters', () => {
  it('splits on H1 headings and keeps intro text as its own chapter', () => {
    const chs = scriptChapters('Intro line.\n# One\nAlpha beta.\n# Two\nGamma.');
    expect(chs.map((c) => c.title)).toEqual(['Chapter 1', 'One', 'Two']);
    expect(chs[1].tokens).toEqual(['Alpha', 'beta.']);
  });

  it('strips control tokens but keeps reaction tags as highlightable words', () => {
    const [ch] = scriptChapters(
      '# C\n[voice:Mara] Hello [pause 500ms] there [laughs] [slow]end[/slow]',
    );
    expect(ch.tokens).toEqual(['Hello', 'there', '[laughs]', 'end']);
  });

  it('expands spell markup into the same separately spoken tokens as the renderer', () => {
    const [ch] = scriptChapters('# C\nCall [spell]USA[/spell] now.');
    expect(ch.tokens).toEqual(['Call', 'U', 'S', 'A', 'now.']);
  });

  it("mirrors the parser's drop rules: pause-only chapters survive, empty ones don't", () => {
    const chs = scriptChapters('# Silence\n[pause 1s]\n# Nothing\n[voice:Mara]\n# Words\nHi.');
    expect(chs.map((c) => c.title)).toEqual(['Silence', 'Words']);
    expect(chs[0].tokens).toEqual([]);
  });

  it('returns [] for a blank script', () => {
    expect(scriptChapters('')).toEqual([]);
    expect(scriptChapters('   \n ')).toEqual([]);
  });
});

const SCRIPT = '# One\nAlpha beta gamma delta.\n# Two\nEpsilon zeta.';

describe('buildLyricsTimeline — stream chapter durations', () => {
  it('lays chapters end to end and even-splits words inside each', () => {
    const { chapters, words } = buildLyricsTimeline(SCRIPT, {
      chapters: [
        { title: 'One', status: 'done', duration_s: 8 },
        { title: 'Two', status: 'cached', duration_s: 4 },
      ],
    });
    expect(chapters.map((c) => [c.title, c.start, c.end])).toEqual([
      ['One', 0, 8],
      ['Two', 8, 12],
    ]);
    expect(words).toHaveLength(6);
    expect(words[0]).toMatchObject({ text: 'Alpha', start: 0, end: 2, chapterIndex: 0 });
    expect(words[4].start).toBeCloseTo(8); // Epsilon opens chapter two
    expect(words[5].end).toBeCloseTo(12);
  });

  it('skips failed chapters — they are absent from the muxed audio', () => {
    const { chapters, words } = buildLyricsTimeline(SCRIPT, {
      chapters: [
        { title: 'One', status: 'failed' },
        { title: 'Two', status: 'done', duration_s: 4 },
      ],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ title: 'Two', start: 0, end: 4 });
    expect(words.map((w) => w.text)).toEqual(['Epsilon', 'zeta.']);
  });

  it('falls back when the stream list no longer matches the script (post-render edit)', () => {
    const { chapters } = buildLyricsTimeline(SCRIPT + '\n# Three\nNew words.', {
      chapters: [
        { title: 'One', status: 'done', duration_s: 8 },
        { title: 'Two', status: 'done', duration_s: 4 },
      ],
      duration: 18,
    });
    expect(chapters).toHaveLength(3);
    expect(chapters[2].end).toBeCloseTo(18);
  });

  it('falls back when a render stopped mid-book left chapters untimed', () => {
    const { words } = buildLyricsTimeline(SCRIPT, {
      chapters: [
        { title: 'One', status: 'done', duration_s: 8 },
        { title: '', status: 'pending' },
      ],
      duration: 12,
    });
    expect(words).toHaveLength(6);
    expect(words[5].end).toBeCloseTo(12);
  });
});

describe('buildLyricsTimeline — proportional fallback (reload case)', () => {
  it('splits the file duration across all words, chapters proportional to word count', () => {
    const { chapters, words } = buildLyricsTimeline(SCRIPT, { duration: 12 });
    // 6 words over 12s = 2s each: chapter One (4 words) 0–8, Two (2 words) 8–12.
    expect(chapters[0]).toMatchObject({ start: 0, end: 8 });
    expect(chapters[1]).toMatchObject({ start: 8, end: 12 });
    expect(words[1]).toMatchObject({ start: 2, end: 4 });
  });

  it('yields nothing without a usable duration', () => {
    expect(buildLyricsTimeline(SCRIPT, {})).toEqual({ chapters: [], words: [] });
    expect(buildLyricsTimeline(SCRIPT, { duration: 0 })).toEqual({ chapters: [], words: [] });
    expect(buildLyricsTimeline(SCRIPT, { duration: NaN })).toEqual({ chapters: [], words: [] });
  });

  it('yields nothing for a blank script', () => {
    expect(buildLyricsTimeline('', { duration: 10 })).toEqual({ chapters: [], words: [] });
  });
});

describe('activeWordIndex', () => {
  const words = buildLyricsTimeline(SCRIPT, { duration: 12 }).words; // 2s per word

  it('is -1 before the first word and tracks the word under t', () => {
    expect(activeWordIndex(words, -0.5)).toBe(-1);
    expect(activeWordIndex(words, 0)).toBe(0);
    expect(activeWordIndex(words, 1.99)).toBe(0);
    expect(activeWordIndex(words, 2)).toBe(1);
    expect(activeWordIndex(words, 9.5)).toBe(4);
  });

  it('keeps the last word lit at and past the end (karaoke gap behaviour)', () => {
    expect(activeWordIndex(words, 12)).toBe(5);
    expect(activeWordIndex(words, 99)).toBe(5);
  });

  it('handles empty/invalid input', () => {
    expect(activeWordIndex([], 1)).toBe(-1);
    expect(activeWordIndex(null, 1)).toBe(-1);
    expect(activeWordIndex(words, NaN)).toBe(-1);
  });
});

// A sidecar as the render writes it: absolute seconds, silences between takes.
const SIDECAR = {
  version: 1,
  output: 'audiobook_x.m4b',
  duration: 20,
  chapters: [
    {
      title: 'One',
      start: 0,
      end: 12,
      precision: 'phrase',
      phrases: [
        { text: 'Alpha beta.', start: 0.5, end: 2.5, voice: null },
        { text: 'Gamma — delta!', start: 4, end: 6, voice: 'Mara' },
      ],
    },
    {
      title: 'Two',
      start: 12,
      end: 20,
      precision: 'span',
      phrases: [{ text: 'Epsilon zeta.', start: 12.5, end: 15.5, voice: null }],
    },
  ],
};

describe('interpolateWords', () => {
  it('shares a phrase between its words by letters, punctuation taking no time', () => {
    // 5 + 4 letters over 0–9 s: one second a letter.
    const words = interpolateWords('Alpha beta.', 0, 9);
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([
      ['Alpha', 0, 5],
      ['beta.', 5, 9],
    ]);
  });

  it('starts a punctuation-only token with the word after it', () => {
    const [gamma, dash, delta] = interpolateWords('Gamma — delta!', 4, 6);
    expect(gamma).toMatchObject({ start: 4, end: 5 });
    expect(dash).toMatchObject({ text: '—', start: 5, end: 5 });
    expect(delta).toMatchObject({ start: 5, end: 6 });
    expect(activeWordIndex([gamma, dash, delta], 5)).toBe(2);
  });

  it('weighs letters with combining marks and other scripts, and even-splits pure punctuation', () => {
    const words = interpolateWords('Ẩn dụ', 0, 4);
    expect(words[0].end).toBeCloseTo(2);
    expect(interpolateWords('… —', 0, 2).map((w) => w.end)).toEqual([1, 2]);
  });
});

describe('readTimeline', () => {
  it('accepts version 1 only and needs a chapter', () => {
    expect(readTimeline(null)).toBeNull();
    expect(readTimeline({ ...SIDECAR, version: 2 })).toBeNull();
    expect(readTimeline({ version: 1, chapters: [] })).toBeNull();
    expect(readTimeline(SIDECAR)?.chapters).toHaveLength(2);
  });

  it('drops untimed entries, keeps times running forward and reads unknown precision as chapter', () => {
    const { chapters } = readTimeline({
      version: 1,
      chapters: [
        { title: 'A', start: 0, end: 'x', precision: 'phrase', phrases: [] },
        {
          title: 'B',
          start: 0,
          end: 10,
          precision: 'word',
          phrases: [
            { text: 'one', start: 2, end: 4 },
            { text: 'lost', start: null, end: 5 },
            { text: 'two', start: 3, end: 12 },
          ],
        },
      ],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].precision).toBe('chapter');
    expect(chapters[0].phrases.map((p) => [p.text, p.start, p.end, p.voice])).toEqual([
      ['one', 2, 4, null],
      ['two', 4, 10, null],
    ]);
  });
});

describe('buildLyricsTimeline — timeline sidecar', () => {
  it('times words inside each phrase take and exposes the phrases', () => {
    const { chapters, words, phrases } = buildLyricsTimeline('# One\nedited since', {
      chapters: [{ title: 'One', status: 'done', duration_s: 3 }],
      duration: 20,
      timeline: SIDECAR,
    });
    // The words are the ones the audio speaks, not the edited script's.
    expect(words.map((w) => w.text)).toEqual([
      'Alpha',
      'beta.',
      'Gamma',
      '—',
      'delta!',
      'Epsilon',
      'zeta.',
    ]);
    expect(words[0]).toMatchObject({ start: 0.5, chapterIndex: 0, phrase: 0 });
    expect(words[1].end).toBeCloseTo(2.5);
    expect(words[2]).toMatchObject({ start: 4, phrase: 1 });
    expect(words[6]).toMatchObject({ chapterIndex: 1, phrase: 2 });
    expect(words[6].end).toBeCloseTo(15.5);
    expect(chapters.map((c) => [c.title, c.start, c.end, c.precision, c.wordCount])).toEqual([
      ['One', 0, 12, 'phrase', 5],
      ['Two', 12, 20, 'span', 2],
    ]);
    expect(phrases.map((p) => [p.start, p.end, p.wordStart, p.wordCount, p.voice])).toEqual([
      [0.5, 2.5, 0, 2, null],
      [4, 6, 2, 3, 'Mara'],
      [12.5, 15.5, 5, 2, null],
    ]);
  });

  it('keeps the last spoken word lit through the silence after a phrase', () => {
    const { words } = buildLyricsTimeline('', { timeline: SIDECAR });
    expect(activeWordIndex(words, 0.4)).toBe(-1);
    expect(activeWordIndex(words, 3.5)).toBe(1); // between takes: still "beta."
    expect(activeWordIndex(words, 4)).toBe(2); // the next take starts exactly
    expect(activeWordIndex(words, 13)).toBe(5);
  });

  it('even-splits a chapter that only knows its own bounds', () => {
    const { words, chapters } = buildLyricsTimeline('', {
      timeline: {
        version: 1,
        chapters: [
          {
            title: 'C',
            start: 10,
            end: 14,
            precision: 'chapter',
            phrases: [{ text: 'a bb ccc dddd', start: 10, end: 14 }],
          },
        ],
      },
    });
    expect(words.map((w) => [w.start, w.end])).toEqual([
      [10, 11],
      [11, 12],
      [12, 13],
      [13, 14],
    ]);
    expect(chapters[0].precision).toBe('chapter');
  });

  it('reads where each section is heard, from its first word', () => {
    const { chapters } = buildLyricsTimeline('', {
      timeline: {
        version: 1,
        chapters: [
          {
            title: 'One',
            start: 0,
            end: 10,
            precision: 'phrase',
            phrases: [
              { text: 'Intro words.', start: 0, end: 2 },
              { text: 'Part two', start: 3, end: 4 },
              { text: 'Body.', start: 5, end: 9 },
            ],
            sections: [
              { title: 'Part two', level: 2, start: 3, phrase: 1 },
              { title: 'Deep', level: 3, start: 99 },
              { title: 7, level: 2, start: 1 },
            ],
          },
        ],
      },
    });
    expect(chapters[0].sections).toEqual([
      { title: 'Part two', level: 2, start: 3, wordStart: 2 },
      // Clamped into its chapter: after its last word.
      { title: 'Deep', level: 3, start: 10, wordStart: 5 },
    ]);
    expect(readTimeline(SIDECAR)?.chapters[0].sections).toEqual([]);
  });

  it('marks chapters estimated and leaves the shape unchanged without a sidecar', () => {
    const timeline = buildLyricsTimeline(SCRIPT, { duration: 12, timeline: null });
    expect(timeline.chapters.every((c) => c.precision === 'estimate')).toBe(true);
    expect(timeline).not.toHaveProperty('phrases');
    expect(timeline.words[0]).not.toHaveProperty('phrase');
    expect(buildLyricsTimeline(SCRIPT, { duration: 12, timeline: { version: 9 } })).toEqual(
      timeline,
    );
  });
});
