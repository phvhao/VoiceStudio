import { describe, expect, it } from 'vitest';
import { buildLyricsTimeline } from '@shared/utils/audiobookLyrics';
import {
  buildReaderBook,
  chapterAt,
  endsSentence,
  followLine,
  followScroll,
  nextChapterStart,
  playbackClock,
  previousChapterStart,
  sentencePieces,
  type ReaderBook,
} from './audiobook-reader';

// Chapter timings as the render stream reports them; null marks a failed chapter.
function book(script: string, durations: Array<number | null>): ReaderBook {
  const chapters = durations.map((duration_s, index) =>
    duration_s === null
      ? { title: `C${index}`, status: 'failed' }
      : { title: '', status: 'done', duration_s },
  );
  return buildReaderBook(script, buildLyricsTimeline(script, { chapters }));
}

const sentences = (reader: ReaderBook) =>
  reader.sentences.map((_, index) =>
    sentencePieces(reader, index)
      .map(({ lead, text }) => lead + text)
      .join(''),
  );

describe('endsSentence', () => {
  it('ends on full stops, question and exclamation marks, closing quotes included', () => {
    expect(endsSentence('there.', 'Then')).toBe(true);
    expect(endsSentence('“Ready?”', 'He')).toBe(true);
    expect(endsSentence('"Go!"', 'Then')).toBe(true);
    expect(endsSentence('(fin.)', 'Next')).toBe(true);
    expect(endsSentence('word', 'Next')).toBe(false);
    expect(endsSentence('word,', 'Next')).toBe(false);
  });

  it('ends on fullwidth and Devanagari marks', () => {
    expect(endsSentence('\u4f60\u597d\u3002', '\u6211')).toBe(true);
    expect(endsSentence('\u0928\u092e\u0938\u094d\u0924\u0947\u0964', '\u0906\u092a')).toBe(true);
  });

  it('keeps the sentence going into a lower-case word', () => {
    expect(endsSentence('“Ready?”', 'she')).toBe(false);
    expect(endsSentence('Wait...', 'what')).toBe(false);
    expect(endsSentence('Wait…', '“what')).toBe(false);
  });

  it('does not end on a lone period after a number or an abbreviation', () => {
    expect(endsSentence('Dr.', 'Watson')).toBe(false);
    expect(endsSentence('p.m.', 'Then')).toBe(false);
    expect(endsSentence('(e.g.', 'This')).toBe(false);
    expect(endsSentence('1999.', 'Then')).toBe(false);
    expect(endsSentence('Drive.', 'Then')).toBe(true);
  });
});

describe('buildReaderBook', () => {
  it('splits sentences after closing quotes but keeps dialogue tags with their line', () => {
    const reader = book('# One\n“Ready?” she asked. He nodded. "Go!" Then silence.', [8]);
    expect(sentences(reader)).toEqual([
      '“Ready?” she asked.',
      'He nodded.',
      '"Go!"',
      'Then silence.',
    ]);
  });

  it('starts a sentence at every line break and a paragraph at blank lines and chapters', () => {
    const reader = book(
      '# One\n(1) First item\n(2) Second item\n\nNew paragraph. Still it.\n# Two\nLast.',
      [10, 2],
    );
    expect(sentences(reader)).toEqual([
      '(1) First item',
      '(2) Second item',
      'New paragraph.',
      'Still it.',
      'Last.',
    ]);
    expect(reader.chapters.map((chapter) => chapter.paragraphs)).toEqual([
      [
        [0, 2],
        [2, 4],
      ],
      [[4, 5]],
    ]);
    expect(reader.words[reader.sentences[1].start].gap).toBe('line');
    expect(reader.words[reader.sentences[3].start].gap).toBe('space');
  });

  it('shows words as written: markup hidden, spelled letters joined, respellings as the term', () => {
    const reader = book(
      '# One\n[voice:Mara] Say [spell]SQL[/spell] [pause 1s] now [laughter] — [[gif|jif]] [slow]please[/slow].\n[voice:]Done.',
      [10],
    );
    expect(sentences(reader)).toEqual(['Say SQL now [laughter] — gif please.', 'Done.']);
    expect(reader.words.filter((word) => word.tag).map((word) => word.text)).toEqual([
      '[laughter]',
    ]);
    // Every spoken token keeps its own timing, shown or not.
    expect(reader.words.map((word) => word.text)).toContain('[[gif|jif]]');
  });

  it('hides the respelling of a multi-word override and still ends the sentence on it', () => {
    const reader = book('# One\nVisit [[NY|New York]]. Then rest.', [6]);
    expect(sentences(reader)).toEqual(['Visit NY.', 'Then rest.']);
    expect(reader.words.map((word) => word.display)).toEqual(['Visit', 'NY', '.', 'Then', 'rest.']);
  });

  it('pairs chapters with their script text when a failed chapter is missing from the audio', () => {
    const reader = book('# One\nAlpha.\n# Two\nBeta gamma.\n# Three\nSay [spell]AB[/spell].', [
      2,
      null,
      3,
    ]);
    expect(reader.chapters.map((chapter) => chapter.title)).toEqual(['One', 'Three']);
    expect(sentences(reader)).toEqual(['Alpha.', 'Say AB.']);
    // Timings stay the timeline's: chapter Three starts where One ended.
    expect(reader.words.map((word) => word.start)).toEqual([0, 2, 2.75, 3.5, 4.25]);
  });

  it('falls back to plain words when the script no longer matches the render', () => {
    const timeline = buildLyricsTimeline('# One\nAlpha beta. Gamma.', {
      chapters: [{ title: '', status: 'done', duration_s: 3 }],
    });
    const reader = buildReaderBook('# One\nSomething else entirely', timeline);
    expect(sentences(reader)).toEqual(['Alpha beta.', 'Gamma.']);
  });
});

// A timeline sidecar: one chapter entry per `[title, precision, phrase texts]`,
// each phrase two seconds with a second of silence after it.
function timedBook(
  script: string,
  chapters: Array<[string, 'phrase' | 'span' | 'chapter', string[]]>,
): ReaderBook {
  let at = 0;
  const timeline = {
    version: 1,
    chapters: chapters.map(([title, precision, texts]) => {
      const start = at;
      const phrases = texts.map((text) => {
        const phrase = { text, start: at, end: at + 2, voice: null };
        at += 3;
        return phrase;
      });
      return { title, start, end: at, precision, phrases };
    }),
  };
  return buildReaderBook(script, buildLyricsTimeline(script, { timeline }));
}

describe('buildReaderBook — timeline sidecar', () => {
  it('makes every phrase take a sentence, where punctuation alone would not split', () => {
    const reader = timedBook('# One\nDr. Watson came, slowly. Then left.', [
      ['One', 'phrase', ['Dr. Watson came,', 'slowly.', 'Then left.']],
    ]);
    expect(sentences(reader)).toEqual(['Dr. Watson came,', 'slowly.', 'Then left.']);
    expect(reader.words[reader.sentences[1].start]).toMatchObject({ start: 3, gap: 'space' });
    expect(reader.chapters[0].precision).toBe('phrase');
  });

  it('keeps line breaks, paragraphs and chapters from the script', () => {
    const reader = timedBook('# One\nAlpha beta.\nGamma.\n\nNew one.\n# Two\nLast.', [
      ['One', 'phrase', ['Alpha beta.', 'Gamma.', 'New one.']],
      ['Two', 'phrase', ['Last.']],
    ]);
    expect(sentences(reader)).toEqual(['Alpha beta.', 'Gamma.', 'New one.', 'Last.']);
    expect(reader.words[reader.sentences[1].start].gap).toBe('line');
    expect(reader.chapters.map((chapter) => chapter.paragraphs)).toEqual([
      [
        [0, 2],
        [2, 3],
      ],
      [[3, 4]],
    ]);
  });

  it('matches through markup, whether or not the render kept performed tags', () => {
    const script =
      '# One\n[voice:Mara] Say [spell]SQL[/spell] [pause 1s] now [laughter] — [[gif|jif]] [slow]please[/slow].\n[voice:]Done.';
    for (const said of ['Say S Q L now [laughter] — gif please.', 'Say SQL now — gif please.']) {
      const reader = timedBook(script, [['One', 'phrase', [said, 'Done.']]]);
      // Spelled letters read as written in the script.
      expect(sentences(reader)).toEqual([said.replace('S Q L', 'SQL'), 'Done.']);
      expect(reader.words[reader.sentences[1].start].gap).toBe('line');
      expect(reader.words.some((word) => word.tag)).toBe(said.includes('[laughter]'));
    }
  });

  it('reads a section title as its own line, without its marks', () => {
    const script = '# One\nAlpha.\n\n## Part [voice:Mara] two\nBeta.';
    const reader = timedBook(script, [['One', 'phrase', ['Alpha.', 'Part', 'two', 'Beta.']]]);
    expect(sentences(reader)).toEqual(['Alpha.', 'Part', 'two', 'Beta.']);
    expect(reader.words.map((word) => [word.display, word.gap])).toEqual([
      ['Alpha.', 'paragraph'],
      ['Part', 'paragraph'],
      ['two', 'space'],
      ['Beta.', 'line'],
    ]);
    // Without a timeline the estimate walks the same words.
    expect(book(script, [4]).words.map((word) => word.display)).toEqual([
      'Alpha.',
      'Part',
      'two',
      'Beta.',
    ]);
  });

  it('pairs chapters with their script text when a failed chapter is missing', () => {
    const reader = timedBook('# One\nAlpha.\n# Two\nBeta.\n# Three\nGamma.\n\nDelta.', [
      ['One', 'phrase', ['Alpha.']],
      ['Three', 'phrase', ['Gamma.', 'Delta.']],
    ]);
    expect(reader.chapters.map((chapter) => chapter.title)).toEqual(['One', 'Three']);
    expect(reader.chapters[1].paragraphs).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('joins a phrase cut inside an unspaced run back onto the one before it', () => {
    const reader = timedBook('# One\n\u4f60\u597d\u3002\u6211\u5f88\u597d\u3002', [
      ['One', 'phrase', ['\u4f60\u597d\u3002', '\u6211\u5f88\u597d\u3002']],
    ]);
    expect(reader.sentences).toHaveLength(2);
    expect(reader.words[1].gap).toBe('joined');
  });

  it('shows what the audio says, phrase by phrase, when the script has changed since', () => {
    const reader = timedBook('# One\nSomething else entirely.', [
      ['One', 'phrase', ['Alpha beta.', 'Gamma.']],
    ]);
    expect(sentences(reader)).toEqual(['Alpha beta.', 'Gamma.']);
    expect(reader.chapters[0].paragraphs).toEqual([[0, 2]]);
  });

  it('splits coarsely timed chapters into sentences by punctuation', () => {
    const reader = timedBook('# One\nAlpha beta. Gamma.\nDelta.', [
      ['One', 'span', ['Alpha beta. Gamma.', 'Delta.']],
    ]);
    expect(sentences(reader)).toEqual(['Alpha beta.', 'Gamma.', 'Delta.']);
    expect(reader.chapters[0].precision).toBe('span');
  });
});

describe('chapter steps', () => {
  // The second chapter has no words: without stream timings it spans no time.
  const chapters = [{ start: 0 }, { start: 10 }, { start: 10 }, { start: 25 }];

  it('finds the chapter under the playhead, allowing for clock rounding', () => {
    expect(chapterAt(chapters, 0)).toBe(0);
    expect(chapterAt(chapters, 9.9)).toBe(0);
    expect(chapterAt(chapters, 9.97)).toBe(2);
    expect(chapterAt(chapters, 30)).toBe(3);
    expect(chapterAt([], 3)).toBe(-1);
  });

  it('steps to the next chapter start, past chapters that span no time', () => {
    expect(nextChapterStart(chapters, 3)).toBe(10);
    expect(nextChapterStart(chapters, 10)).toBe(25);
    expect(nextChapterStart(chapters, 26)).toBeNull();
  });

  it('restarts the chapter once a few seconds in, else steps back a chapter', () => {
    expect(previousChapterStart(chapters, 12)).toBe(0);
    expect(previousChapterStart(chapters, 20)).toBe(10);
    expect(previousChapterStart(chapters, 2)).toBe(0);
    expect(previousChapterStart(chapters, 0)).toBeNull();
  });
});

describe('followScroll', () => {
  it('leaves a line inside the reading zone alone', () => {
    expect(followScroll(300, 320, 200, 400, 5000)).toBeNull();
  });

  it('brings a line below or above the zone a third of the way in', () => {
    expect(followScroll(560, 580, 200, 400, 5000)).toBe(440);
    expect(followScroll(100, 120, 200, 400, 5000)).toBe(0);
  });

  it('stays within the scrollable range', () => {
    expect(followScroll(4990, 5010, 0, 400, 4700)).toBe(4700);
  });
});

describe('followLine', () => {
  const line = { scrollLeft: 0, clientWidth: 200, scrollWidth: 2000 };

  it('scrolls a left-to-right line forward to the word', () => {
    expect(followLine({ offsetLeft: 900, offsetWidth: 40 }, line, false)).toEqual({
      left: 840,
      scrolled: true,
    });
    expect(followLine({ offsetLeft: 50, offsetWidth: 40 }, line, false)).toEqual({
      left: null,
      scrolled: false,
    });
  });

  it('scrolls a right-to-left line the other way, as Chromium counts it', () => {
    // The line starts at its right edge and overflows to the left: a word far
    // into it sits at a negative offset, and scrollLeft runs down from 0.
    expect(followLine({ offsetLeft: -900, offsetWidth: 40 }, line, true)).toEqual({
      left: -1000,
      scrolled: true,
    });
    // Its first words are in view at the start.
    expect(followLine({ offsetLeft: 120, offsetWidth: 40 }, line, true)).toEqual({
      left: null,
      scrolled: false,
    });
    // Scrolled on, the line comes back for a word near its start.
    expect(
      followLine({ offsetLeft: 120, offsetWidth: 40 }, { ...line, scrollLeft: -700 }, true),
    ).toEqual({ left: 0, scrolled: false });
  });
});

describe('playbackClock', () => {
  it('formats minutes, or hours for long books', () => {
    expect(playbackClock(0)).toBe('0:00');
    expect(playbackClock(75.9)).toBe('1:15');
    expect(playbackClock(3725, true)).toBe('1:02:05');
    expect(playbackClock(Number.NaN, true)).toBe('0:00:00');
  });
});
