import { expect, it } from 'vitest';
import { restoreBookOptions, lexiconMap, repeatedWords, duplicateWords } from './book-options';
it('marks the rows whose word repeats an earlier one, so the copy can be pointed at', () => {
  const rows = [
    { word: 'SQL', pronunciation: 'sequel' },
    { word: '', pronunciation: '' },
    { word: 'GUI', pronunciation: 'gooey' },
    { word: '', pronunciation: '' },
    { word: ' sql ', pronunciation: 'letters' },
  ];
  expect(repeatedWords(rows)).toEqual([false, false, false, false, true]);
  expect(duplicateWords(rows)).toBe(true);
  expect(duplicateWords(rows.slice(0, 4))).toBe(false);
  // Describing the book skips the copy; only a render refuses it.
  expect(() => lexiconMap(rows)).toThrow();
  expect(lexiconMap(rows, { strict: false })).toEqual({ SQL: 'sequel', GUI: 'gooey' });
});
it('restores older drafts with backend-default book options', () => {
  expect(restoreBookOptions(null)).toEqual({
    metadata: {},
    loudness: 'off',
    cover: null,
    lexicon: [],
  });
});
it('keeps supported metadata and rejects conflicting pronunciation rows', () => {
  expect(
    restoreBookOptions({
      metadata: { author: 'Author' },
      cover: { path: '/cover.png', name: 'Cover' },
    }),
  ).toMatchObject({ metadata: { author: 'Author' }, cover: { name: 'Cover' } });
  expect(() =>
    lexiconMap([
      { word: 'SQL', pronunciation: 'sequel' },
      { word: ' sql ', pronunciation: 'letters' },
    ]),
  ).toThrow();
});
