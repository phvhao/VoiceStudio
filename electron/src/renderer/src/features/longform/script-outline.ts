import { scriptChapters } from '@shared/utils/audiobookLyrics';
import { scriptStats } from '@shared/utils/audiobookScript';
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

/** The chapters and sections of `script`, offsets into its newline-normalized text. */
export function scriptOutline(script: string): OutlineChapter[] {
  const text = normalizeNewlines(script);
  const heads = [...text.matchAll(CHAPTER_RE)];
  const raw: Array<{ match: RegExpMatchArray | null; start: number; end: number }> = [];
  const firstHead = heads.length ? (heads[0].index ?? 0) : text.length;
  // Text before the first heading is a chapter when it holds anything.
  if (text.slice(0, firstHead).trim()) raw.push({ match: null, start: 0, end: firstHead });
  heads.forEach((match, index) => {
    raw.push({
      match,
      start: match.index ?? 0,
      end: index + 1 < heads.length ? (heads[index + 1].index ?? 0) : text.length,
    });
  });
  let plan = 0;
  return raw.map(({ match, start, end }) => {
    const slice = text.slice(start, end);
    const lineEnd = match ? start + match[0].length : null;
    const bodyStart = lineEnd ?? start;
    const sections: OutlineSection[] = [];
    const marks = [...text.slice(bodyStart, end).matchAll(SECTION_RE)];
    marks.forEach((mark, index) => {
      const at = bodyStart + (mark.index ?? 0);
      const sectionEnd = index + 1 < marks.length ? bodyStart + (marks[index + 1].index ?? 0) : end;
      sections.push({
        title: mark[3].trim(),
        level: mark[2].length === 3 ? 3 : 2,
        start: at,
        titleStart: at + mark[1].length,
        lineEnd: at + mark[0].length,
        end: sectionEnd,
        ...counted(text.slice(at, sectionEnd)),
      });
    });
    // The parser drops a chapter with nothing to render; the plan's indexes skip it.
    const planned = scriptChapters(slice).length > 0;
    return {
      title: match ? match[2].trim() : null,
      level: 1,
      start,
      titleStart: match ? start + match[1].length : null,
      lineEnd,
      end,
      plan: planned ? plan++ : null,
      sections,
      ...counted(slice),
    };
  });
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
