import { scriptChapters } from '@shared/utils/audiobookLyrics';
import { AUDIOBOOK_WPM, scriptStats } from '@shared/utils/audiobookScript';
import { normalizeNewlines, type MarkupEdit } from './script-markup';

/**
 * An Audiobook script's table of contents: chapters (`# Title`, plus the
 * untitled stretch before the first one) and their sections (`## Title`,
 * `### Title`), read the way the render reads them
 * (`backend/services/longform_parser.py`), with offsets into the editor's
 * text and the edits the outline makes to headings. Pure: no React.
 */

// The heading lines of longform_parser: group 1 is the marks, group 2 the title.
const CHAPTER_RE = /^([ \t]*#[ \t]+)(\S.*)$/gm;
const SECTION_RE = /^([ \t]*(#{2,3})[ \t]+)(\S.*)$/gm;
const HEADING_LINE_RE = /^([ \t]*(#{1,3})[ \t]+)(\S.*)$/;
// `[[word|respelling]]` reads as its word; any other tag is not shown.
const OVERRIDE_RE = /\[\[([^\]]{0,256})\]\]/g;
const TAG_RE = /\[[^\][]*\]/g;

export interface OutlineNode {
  /** The title as written; `null` for the untitled opening chapter. */
  title: string | null;
  level: 1 | 2 | 3;
  /** Where the node's heading line starts (0 for the untitled opening). */
  start: number;
  /** Where its title starts and its heading line ends (`null` without a heading). */
  titleStart: number | null;
  lineEnd: number | null;
  /** Where the node's text ends: the next heading of its level or above. */
  end: number;
  words: number;
  runtimeSec: number;
}

export interface OutlineChapter extends OutlineNode {
  level: 1;
  /** Index in the render's plan (`/audiobook/plan`), `null` when it has nothing to render. */
  plan: number | null;
  sections: OutlineSection[];
}

export interface OutlineSection extends OutlineNode {
  level: 2 | 3;
}

/** A heading's title as the listener and the outline read it. */
export function displayTitle(title: string): string {
  return title
    .replace(OVERRIDE_RE, (_, inner: string) => inner.split('|')[0])
    .replace(TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function counted(text: string) {
  const { words, runtimeSec } = scriptStats(text);
  return { words, runtimeSec };
}

/** A chapter as its own text reads it: offsets count from where that text starts. */
interface ChapterShape extends Omit<OutlineChapter, 'plan'> {
  /** Whether the render plans it: the parser drops a chapter with nothing to render. */
  planned: boolean;
}

/** Chapter `slice` (opening with its `heading` line, `null` for the untitled opening). */
function chapterShape(slice: string, heading: RegExpMatchArray | null): ChapterShape {
  const lineEnd = heading ? heading[0].length : null;
  const bodyStart = lineEnd ?? 0;
  const sections: OutlineSection[] = [];
  const marks = [...slice.slice(bodyStart).matchAll(SECTION_RE)];
  marks.forEach((mark, index) => {
    const at = bodyStart + (mark.index ?? 0);
    const level = mark[2].length === 3 ? 3 : 2;
    // A section runs over its own `###` subsections, to the next heading of its level or above.
    const next = marks.slice(index + 1).find((later) => later[2].length <= level);
    const sectionEnd = next ? bodyStart + (next.index ?? 0) : slice.length;
    sections.push({
      title: mark[3].trim(),
      level,
      start: at,
      titleStart: at + mark[1].length,
      lineEnd: at + mark[0].length,
      end: sectionEnd,
      ...counted(slice.slice(at, sectionEnd)),
    });
  });
  return {
    title: heading ? heading[2].trim() : null,
    level: 1,
    start: 0,
    titleStart: heading ? heading[1].length : null,
    lineEnd,
    end: slice.length,
    planned: scriptChapters(slice).length > 0,
    sections,
    ...counted(slice),
  };
}

// A chapter reads the same wherever it stands — headings end chapters and
// sections, and a chapter's words are its own — so chapters are kept by
// their text: an edit reads again the one chapter it is in, not the book.
// Two generations: reading another text in between (a passage, a story)
// costs the book none of its chapters.
let shapes = new Map<string, ChapterShape>();
let olderShapes = new Map<string, ChapterShape>();
// The last outlines read, newest first: the page, its Contents and a render
// all read the same script.
let outlines: { text: string; outline: readonly OutlineChapter[] }[] = [];

/**
 * The chapters and sections of `script`, offsets into its newline-normalized
 * text. The outline is shared by every reader of the same script: never
 * change it.
 */
export function scriptOutline(script: string): readonly OutlineChapter[] {
  const text = normalizeNewlines(script);
  const known = outlines.find((entry) => entry.text === text);
  if (known) return known.outline;
  const heads = [...text.matchAll(CHAPTER_RE)];
  const raw: Array<{ heading: RegExpMatchArray | null; start: number; end: number }> = [];
  const firstHead = heads.length ? (heads[0].index ?? 0) : text.length;
  // Text before the first heading is a chapter when it holds anything.
  if (text.slice(0, firstHead).trim()) raw.push({ heading: null, start: 0, end: firstHead });
  heads.forEach((heading, index) => {
    raw.push({
      heading,
      start: heading.index ?? 0,
      end: index + 1 < heads.length ? (heads[index + 1].index ?? 0) : text.length,
    });
  });
  const kept = new Map<string, ChapterShape>();
  let plan = 0;
  const outline = raw.map(({ heading, start, end }): OutlineChapter => {
    // A chapter's text opens with its heading line, or holds none: the text
    // alone tells which.
    const slice = text.slice(start, end);
    const shape =
      kept.get(slice) ??
      shapes.get(slice) ??
      olderShapes.get(slice) ??
      chapterShape(slice, heading);
    kept.set(slice, shape);
    const at = (offset: number | null) => (offset === null ? null : start + offset);
    const { planned: _planned, ...node } = shape;
    return {
      ...node,
      start,
      titleStart: at(shape.titleStart),
      lineEnd: at(shape.lineEnd),
      end,
      // The plan's indexes skip a chapter with nothing to render.
      plan: shape.planned ? plan++ : null,
      sections: shape.sections.map((section) => ({
        ...section,
        start: start + section.start,
        titleStart: at(section.titleStart),
        lineEnd: at(section.lineEnd),
        end: start + section.end,
      })),
    };
  });
  olderShapes = shapes;
  shapes = kept;
  outlines = [{ text, outline }, ...outlines.slice(0, 1)];
  return outline;
}

/**
 * The book's chapters, spoken words and estimated runtime — `scriptStats`'s
 * figures — from its outline: each chapter counted on its own text, as the
 * render reads it, so the Contents rows add up to it, and an edit recounts
 * only the chapter it is in.
 */
export function outlineStats(outline: readonly OutlineChapter[]): {
  chapters: number;
  words: number;
  runtimeSec: number;
} {
  const words = outline.reduce((sum, chapter) => sum + chapter.words, 0);
  return {
    chapters: Math.max(1, outline.filter((chapter) => chapter.title !== null).length),
    words,
    runtimeSec: words > 0 ? (words / AUDIOBOOK_WPM) * 60 : 0,
  };
}

/** The node (chapter, or section inside it) holding `offset`. */
export function outlineNodeAt(
  outline: readonly OutlineChapter[],
  offset: number,
): OutlineNode | null {
  const chapter = [...outline].reverse().find((node) => node.start <= offset);
  if (!chapter) return null;
  return [...chapter.sections].reverse().find((node) => node.start <= offset) ?? chapter;
}

function lineAt(text: string, offset: number) {
  const start = offset > 0 ? text.lastIndexOf('\n', offset - 1) + 1 : 0;
  const newline = text.indexOf('\n', start);
  return { start, end: newline < 0 ? text.length : newline };
}

/** A title fit for one heading line. */
function headingTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * Rename the heading whose line starts at `lineStart`; the new title ends up
 * selected. `null` when that line is no heading (the text moved on) or the
 * title is blank.
 */
export function renameHeading(text: string, lineStart: number, title: string): MarkupEdit | null {
  const next = headingTitle(title);
  const line = lineAt(text, lineStart);
  const match = HEADING_LINE_RE.exec(text.slice(line.start, line.end));
  if (!next || line.start !== lineStart || !match) return null;
  const from = line.start + match[1].length;
  return {
    from,
    to: line.end,
    insert: next,
    text: text.slice(0, from) + next + text.slice(line.end),
    selectionStart: from,
    selectionEnd: from + next.length,
  };
}

/**
 * Add a heading of `level` at `at` (where a node's text ends), on a paragraph
 * of its own; its title ends up selected, so typing names it.
 */
export function insertHeading(
  text: string,
  at: number,
  level: 1 | 2 | 3,
  title: string,
): MarkupEdit {
  const position = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, position);
  const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const name = headingTitle(title);
  const marks = `${'#'.repeat(level)} `;
  const insert = `${lead}${marks}${name}\n${position < text.length ? '\n' : ''}`;
  const titleStart = position + lead.length + marks.length;
  return {
    from: position,
    to: position,
    insert,
    text: before + insert + text.slice(position),
    selectionStart: titleStart,
    selectionEnd: titleStart + name.length,
  };
}

/**
 * Remove the heading line starting at `lineStart` and keep the text under it
 * (it joins the chapter or section before). `null` when that line is no heading.
 */
export function removeHeading(text: string, lineStart: number): MarkupEdit | null {
  const line = lineAt(text, lineStart);
  if (line.start !== lineStart || !HEADING_LINE_RE.test(text.slice(line.start, line.end)))
    return null;
  const to = line.end < text.length ? line.end + 1 : line.end;
  return {
    from: line.start,
    to,
    insert: '',
    text: text.slice(0, line.start) + text.slice(to),
    selectionStart: line.start,
    selectionEnd: line.start,
  };
}
