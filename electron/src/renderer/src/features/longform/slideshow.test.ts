import { describe, expect, it } from 'vitest';
import type { ReaderBook } from './audiobook-reader';
import {
  captionWords,
  coverUrl,
  imageUrl,
  showsWhole,
  slideIndexAt,
  timelineSlides,
} from './slideshow';

const chapter = (images: unknown) =>
  ({ title: '', start: 0, end: 1, precision: 'phrase', phrases: [], images }) as never;

describe('timelineSlides', () => {
  it('lists the pictures in time order, the later of two at one moment', () => {
    const slides = timelineSlides({
      chapters: [
        chapter([
          { phrase: 0, start: 5, name: 'b.jpg', fit: 'contain' },
          { phrase: 0, start: 1, name: 'a.jpg', fit: 'auto' },
          { phrase: 0, start: 5, name: 'c.jpg', fit: 'cover' },
        ]),
        chapter([{ phrase: 0, start: 9, name: null, fit: 'auto' }]),
      ],
    });
    expect(slides).toEqual([
      { start: 1, name: 'a.jpg', fit: 'auto' },
      { start: 5, name: 'c.jpg', fit: 'cover' },
      { start: 9, name: null, fit: 'auto' },
    ]);
  });

  it('reads a malformed sidecar without throwing and keeps one of a repeated picture', () => {
    const slides = timelineSlides({
      chapters: [
        chapter('nope'),
        chapter([
          null,
          { start: 'x', name: 'bad.jpg' },
          { start: 2, name: 'a.jpg', fit: 'sideways' },
          { start: 3, name: 'a.jpg', fit: 'auto' },
        ]),
        null as never,
      ],
    });
    expect(slides).toEqual([{ start: 2, name: 'a.jpg', fit: 'auto' }]);
    expect(timelineSlides(null)).toEqual([]);
  });
});

describe('slideIndexAt', () => {
  const slides = [
    { start: 1, name: 'a', fit: 'auto' as const },
    { start: 4, name: 'b', fit: 'auto' as const },
  ];
  it('is the last slide started by then, -1 before the first', () => {
    expect([0, 1, 3.9, 4, 100].map((t) => slideIndexAt(slides, t))).toEqual([-1, 0, 0, 1, 1]);
    expect(slideIndexAt([], 5)).toBe(-1);
  });
});

describe('showsWhole', () => {
  const frame = { width: 1600, height: 900 };
  it('fills when the shapes are close and shows a far shape whole', () => {
    expect(showsWhole('auto', { width: 1500, height: 1000 }, frame)).toBe(false);
    expect(showsWhole('auto', { width: 800, height: 1200 }, frame)).toBe(true);
    expect(showsWhole('auto', { width: 4000, height: 1000 }, frame)).toBe(true);
    expect(showsWhole('cover', { width: 800, height: 1200 }, frame)).toBe(false);
    expect(showsWhole('contain', { width: 1600, height: 900 }, frame)).toBe(true);
    expect(showsWhole('auto', { width: 0, height: 0 }, frame)).toBe(false);
  });
});

describe('URLs', () => {
  it('names library pictures and the cover by their served paths', () => {
    expect(imageUrl('rừng đêm.jpg')).toMatch(/\/longform\/images\/r%E1%BB%ABng%20%C4%91%C3%AAm\.jpg$/);
    expect(imageUrl('a.jpg', { thumb: true, version: 7 })).toMatch(/\/longform\/images\/a\.jpg\?thumb=1&v=7$/);
    expect(coverUrl({ path: 'C:\\data\\outputs\\audiobook_covers\\ab12cd34ef56.png' })).toMatch(
      /\/audio\/audiobook_covers\/ab12cd34ef56\.png$/,
    );
    expect(coverUrl(null)).toBeUndefined();
  });
});

describe('captionWords', () => {
  const book = (texts: string[]): ReaderBook => ({
    chapters: [],
    words: texts.map((display, i) => ({
      text: display,
      display,
      start: i,
      end: i + 1,
      chapterIndex: 0,
      gap: 'space',
      tag: false,
    })),
    sentences: [{ start: 0, end: texts.length }],
  });
  it('shows a short sentence whole and a long one a piece at a time', () => {
    const short = book(['One', 'two', 'three.']);
    expect(captionWords(short, 0, 1)).toEqual([0, 2]);
    const long = book(Array.from({ length: 30 }, (_, i) => `word${i}`));
    const first = captionWords(long, 0, 0, 40)!;
    const later = captionWords(long, 0, 20, 40)!;
    expect(first[0]).toBe(0);
    expect(later[0]).toBeGreaterThan(first[1]);
    expect(later[0]).toBeLessThanOrEqual(20);
    expect(later[1]).toBeGreaterThanOrEqual(20);
    expect(captionWords(long, -1, 3)).toBeNull();
  });
});
