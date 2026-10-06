import { expect, it } from 'vitest';
import i18n from '@/i18n';
import { chapterName, hasOpening } from './chapter-name';

const t = i18n.t.bind(i18n);
const names = (chapters: { title?: string | null; untitled?: boolean }[]) =>
  chapters.map((_, index) => chapterName(t, chapters, index));

it('names the untitled intro apart from a real "Chapter 1", and counts chapters without it', () => {
  // 'Lời dẫn…\n# Chương 1\n…\n#\n…': the reader's and the render's shapes.
  expect(names([{ title: '' }, { title: 'Chương 1' }, { title: '' }, { title: 'Ba' }])).toEqual([
    t('book.intro_heading'),
    'Chương 1',
    t('audiobook.chapter_n', { n: 2 }),
    'Ba',
  ]);
  expect(names([{ title: '', untitled: true }, { title: 'Chương 1' }])).toEqual([
    t('book.intro_heading'),
    'Chương 1',
  ]);
  expect(t('book.intro_heading')).not.toBe(t('audiobook.chapter_n', { n: 1 }));
});

it('numbers a book without an opening: one chapter, or every chapter untitled', () => {
  expect(names([{ title: '' }])).toEqual([t('audiobook.chapter_n', { n: 1 })]);
  expect(names([{ title: '', untitled: true }])).toEqual([t('audiobook.chapter_n', { n: 1 })]);
  expect(
    names([
      { title: '', untitled: true },
      { title: '', untitled: true },
    ]),
  ).toEqual([t('audiobook.chapter_n', { n: 1 }), t('audiobook.chapter_n', { n: 2 })]);
});

it('knows the opening while a render is still under way', () => {
  // Chapter 0 has reported back untitled; the rest are pending, titles unknown.
  const rendering = [{ title: '', untitled: true }, { title: '' }, { title: '' }];
  expect(hasOpening(rendering)).toBe(true);
  expect(names(rendering)).toEqual([
    t('book.intro_heading'),
    t('audiobook.chapter_n', { n: 1 }),
    t('audiobook.chapter_n', { n: 2 }),
  ]);
  // Nothing reported yet: plain numbers.
  expect(hasOpening([{ title: '' }, { title: '' }])).toBe(false);
});
