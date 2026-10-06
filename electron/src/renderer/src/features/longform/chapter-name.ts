import type { TFunction } from 'i18next';

/**
 * A chapter as a list knows it: its title (blank or null where the script
 * gave none) and, where a render said so, whether the script left it untitled.
 */
export interface NamedChapter {
  title?: string | null;
  untitled?: boolean;
}

const blank = (chapter: NamedChapter | undefined) => !chapter?.title?.trim();

/**
 * Whether the first chapter is the book's opening: the untitled text before
 * its first heading, with titled chapters after it (the HTML export's
 * `page_timeline` rule). A lone chapter, or a book whose chapters are all
 * untitled, has no opening: its chapters are numbered.
 */
export function hasOpening(chapters: readonly NamedChapter[]): boolean {
  if (chapters.length < 2 || !blank(chapters[0])) return false;
  const rest = chapters.slice(1);
  if (rest.some((chapter) => chapter?.untitled === true)) return false;
  return chapters[0]?.untitled === true || rest.some((chapter) => !blank(chapter));
}

/**
 * What a list calls chapter `index`: its title, or in the app's language the
 * opening ("Introduction") or "Chapter N" — counted without the opening, so
 * the intro never reads "Chapter 1" beside a real `# Chapter 1`.
 */
export function chapterName(
  t: TFunction,
  chapters: readonly NamedChapter[],
  index: number,
): string {
  const title = chapters[index]?.title;
  if (title?.trim()) return title;
  const opening = hasOpening(chapters);
  if (opening && index === 0) return t('book.intro_heading');
  return t('audiobook.chapter_n', { n: opening ? index : index + 1 });
}
