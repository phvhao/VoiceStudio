import {
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type Ref,
  type RefObject,
} from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useScriptSpellcheck } from '@/hooks/use-script-spellcheck';
import { cn } from '@/lib/utils';
import { MarkupEditorContext, type MarkupEditorHandle } from './markup-editor-context';
import {
  classifyToken,
  formatPauseSeconds,
  formatSignedDb,
  normalizeNewlines,
  pauseMs,
  respellingRange,
  tokenAt,
  tokenizeMarkup,
  voiceName,
  voiceSwitches,
  volumeDb,
  type MarkupKind,
  type MarkupSegment,
  type MarkupToken,
  type VoiceSwitch,
} from './script-markup';
import {
  DEFAULT_VOICE_ACCENT,
  VOICE_ACCENTS,
  VOICE_RESET_CHIP,
  voiceAccent,
  type VoiceAccent,
} from './voice-palette';

// Past this size the overlay costs more per keystroke than it is worth; the
// textarea keeps working as plain text.
export const HIGHLIGHT_LIMIT = 200_000;

// Highlights may only paint (background, ring, outline, decoration): anything
// that changes glyph width (weight, padding, letter-spacing) would drift the
// overlay away from the caret. `data-hover` marks the tag under the pointer
// and `data-current` the one holding the caret, while tools listen.
export const MARKUP_STYLES: Record<Exclude<MarkupKind, 'text'>, string> = {
  heading: 'rounded-sm bg-primary/12 ring-1 ring-primary/25',
  section: 'rounded-sm bg-primary/6 ring-1 ring-primary/15',
  voice:
    'rounded-sm bg-sky-500/18 ring-1 ring-sky-500/40 data-hover:bg-sky-500/30 data-hover:ring-sky-500/70 data-current:ring-2',
  voiceReset:
    'rounded-sm bg-sky-500/8 ring-1 ring-sky-500/25 data-hover:bg-sky-500/18 data-hover:ring-sky-500/50 data-current:ring-2',
  pause:
    'rounded-sm bg-amber-500/18 ring-1 ring-amber-500/40 data-hover:bg-amber-500/30 data-hover:ring-amber-500/70 data-current:ring-2',
  delivery:
    'rounded-sm bg-violet-500/18 ring-1 ring-violet-500/40 data-hover:bg-violet-500/30 data-hover:ring-violet-500/70 data-current:ring-2',
  volume:
    'rounded-sm bg-fuchsia-500/16 ring-1 ring-fuchsia-500/40 data-hover:bg-fuchsia-500/28 data-hover:ring-fuchsia-500/70 data-current:ring-2',
  expression:
    'rounded-sm bg-emerald-500/18 ring-1 ring-emerald-500/40 data-hover:bg-emerald-500/30 data-hover:ring-emerald-500/70 data-current:ring-2',
  pronunciation:
    'rounded-sm bg-rose-500/18 ring-1 ring-rose-500/40 data-hover:bg-rose-500/30 data-hover:ring-rose-500/70 data-current:ring-2',
  unknown:
    'rounded-sm underline decoration-destructive decoration-wavy underline-offset-4 data-hover:bg-destructive/10 data-current:bg-destructive/15',
};

// Every mark starts transparent: the textarea above draws the glyphs.
const MARK = 'box-decoration-clone bg-transparent text-transparent';
const KIND_CLASSES = Object.fromEntries(
  Object.entries(MARKUP_STYLES).map(([kind, style]) => [kind, cn(MARK, style)]),
) as Record<Exclude<MarkupKind, 'text'>, string>;
const CHIP_CLASSES = new Map<VoiceAccent, string>(
  [DEFAULT_VOICE_ACCENT, ...VOICE_ACCENTS].map((accent) => [
    accent,
    cn(MARK, 'rounded-sm', accent.chip),
  ]),
);
const RESET_CLASS = cn(MARK, 'rounded-sm', VOICE_RESET_CHIP);

// The tags a click or Alt+Enter can open (a heading is a line, not a tag).
const TOKEN_KINDS = new Set<string>([
  'voice',
  'voiceReset',
  'pause',
  'delivery',
  'volume',
  'expression',
  'pronunciation',
  'unknown',
]);

// The tags an editor without tools still explains on hover: the ones it
// does not read.
const UNKNOWN_KINDS = new Set<string>(['unknown']);

// Zero-width space: an empty line needs a glyph to take up its line.
const EMPTY_LINE = String.fromCharCode(0x200b);

// Shared by the textarea and its overlay so both wrap identically.
const LAYER = 'm-0 block w-full border-0 whitespace-pre-wrap [overflow-wrap:break-word]';
// Room for the line numbers and the voice lane, on both layers. Every size
// in the gutter is in `em` of the text, so it grows with the editor's zoom as
// the label inside it does: 4.5em = a 3.25em label box from 0.25em, a gap,
// the voice lane at 3.75em, and its gap to the text.
const GUTTER = 'ps-[4.5em]';
// The number is painted from `data-line`, so it is not part of the overlay's
// text. It inherits the text's line height and sits on the line's first row.
// A chapter heading shows its chapter ("C2"), a section a lighter mark, and
// the untitled intro a faint label instead of the number. The label's font
// is 0.6875em of the text, so its own `em` is that much smaller: its box is
// set in text `em` divided by 0.6875. It never wraps — a second row would
// paint over the next line's number — and a label too long for the box ends
// in an ellipsis (see LABEL_BOX_EM).
const NUMBERED_LINE =
  'relative before:absolute before:top-0 before:start-[calc(-4.25em/0.6875)] before:w-[calc(3.25em/0.6875)] before:overflow-hidden before:text-end before:text-ellipsis before:whitespace-nowrap before:text-[0.6875em] before:text-muted-foreground/55 before:tabular-nums before:content-[attr(data-line)] data-active:before:text-foreground data-chapter:before:font-medium data-chapter:before:text-primary data-section:before:text-primary/60 data-intro:before:text-muted-foreground/40 data-intro:before:italic';
/** The gutter label's box, in the label's own `em` (3.25em of the text). */
export const LABEL_BOX_EM = 3.25 / 0.6875;
const ACTIVE_BAND = 'absolute inset-0 -z-10 bg-current text-foreground/[0.04]';
const CHAPTER_BAND = 'absolute inset-0 -z-10 bg-current text-primary/[0.07]';
const CHAPTER_ACCENT = 'absolute inset-y-0 -start-[4.5em] w-0.5 bg-primary/60';
// A section heading: the chapter's band and accent, lighter.
const SECTION_BAND = 'absolute inset-0 -z-10 bg-current text-primary/[0.035]';
const SECTION_ACCENT = 'absolute inset-y-0 -start-[4.5em] w-0.5 bg-primary/30';
// A band is as tall as its line and as wide as the editor: the spread shadow
// paints it across the gutter and the padding (ink overflow, so the overlay
// gains nothing to scroll) and the clip keeps it to the line's height.
const FULL_WIDTH: CSSProperties = {
  boxShadow: '0 0 0 100vmax currentcolor',
  clipPath: 'inset(0 -100vmax)',
};
const LANE = 'absolute start-[3.75em] w-[3px] rounded-full';
// The gutter's mark on a `## Section` / `### Section` line.
const SECTION_MARK = '§';

// A press that moves further than this is a drag that selects text.
const CLICK_SLOP = 4;

interface LineSegment {
  text: string;
  kind: MarkupKind;
  className: string;
}

/** The text the overlay shows, and how to find positions in it. */
interface Model {
  text: string;
  /** Offset of each line's first character. */
  starts: number[];
  lines: LineSegment[][];
  switches: VoiceSwitch[];
}

interface Hit {
  mark: HTMLElement;
  token: MarkupToken;
}

interface LaneSegment {
  top: number;
  height: number;
  voice: string | null;
}

/** Where the lane changes: the voice reading from `y`; `undefined` leaves a gap. */
interface LaneStop {
  y: number;
  voice: string | null | undefined;
}

/** What the gutter shows on one line: its number, or a heading's mark. */
interface GutterLabel {
  text: string;
  kind: 'line' | 'chapter' | 'section' | 'intro';
}

const NO_LANE: LaneSegment[] = [];

function markClass(
  segment: MarkupSegment,
  voices: readonly string[] | undefined,
  chapterBands: boolean,
): string {
  switch (segment.kind) {
    case 'text':
      return '';
    case 'heading':
      return chapterBands ? MARK : KIND_CLASSES.heading;
    case 'section':
      return chapterBands ? MARK : KIND_CLASSES.section;
    case 'voice':
      return voices
        ? (CHIP_CLASSES.get(voiceAccent(voiceName(segment.text), voices)) ?? KIND_CLASSES.voice)
        : KIND_CLASSES.voice;
    case 'voiceReset':
      return voices ? RESET_CLASS : KIND_CLASSES.voiceReset;
    default:
      return KIND_CLASSES[segment.kind];
  }
}

/**
 * The highlighted text, one entry per logical line. A tag broken across lines
 * keeps its kind on both halves.
 */
function splitLines(
  text: string,
  headings: boolean,
  voices: readonly string[] | undefined,
  chapterBands: boolean,
  unsupported: readonly MarkupKind[] | undefined,
): LineSegment[][] {
  const lines: LineSegment[][] = [[]];
  for (const segment of tokenizeMarkup(text, { headings, unsupported })) {
    const className = markClass(segment, voices, chapterBands);
    segment.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, kind: segment.kind, className });
    });
  }
  return lines;
}

// A line with a tag left open: `[` with no `]` after it. The tag may run on
// into the lines below, which then read in its kind.
const OPEN_TAG_RE = /\[[^\]]*$/;

/** The overlay's lines of one text, by line text, and what they were read with. */
interface LineCache {
  options: string;
  lines: Map<string, LineSegment[]>;
}

/**
 * `splitLines` with each line kept by its text: a tag ends on the line it
 * starts on, so a line reads the same wherever it stands, and typing reads
 * again the one line it changes — not the manuscript — while the other lines
 * keep their segments (and their overlay line skips rendering). While a line
 * holds a tag left open, which may carry on into the lines below, the whole
 * text is read at once, as `splitLines` reads it.
 */
function cachedLines(
  cache: { current: LineCache | null },
  text: string,
  headings: boolean,
  voices: readonly string[] | undefined,
  chapterBands: boolean,
  unsupported: readonly MarkupKind[] | undefined,
): LineSegment[][] {
  const options = JSON.stringify([headings, voices ?? null, chapterBands, unsupported ?? null]);
  const known = cache.current?.options === options ? cache.current.lines : undefined;
  const kept = new Map<string, LineSegment[]>();
  const lines: LineSegment[][] = [];
  for (const line of text.split('\n')) {
    let segments = kept.get(line) ?? known?.get(line);
    if (!segments) {
      if (OPEN_TAG_RE.test(line))
        return splitLines(text, headings, voices, chapterBands, unsupported);
      segments = splitLines(line, headings, voices, chapterBands, unsupported)[0];
    }
    kept.set(line, segments);
    lines.push(segments);
  }
  cache.current = { options, lines: kept };
  return lines;
}

// The voice switches of the last text read: the editor and its status bar
// read the same script on every keystroke.
let lastSwitches: { text: string; headings: boolean; switches: VoiceSwitch[] } | null = null;

/** `voiceSwitches(text, { headings })`, once per text for every reader of it. */
export function textVoiceSwitches(text: string, headings: boolean): VoiceSwitch[] {
  if (lastSwitches?.text === text && lastSwitches.headings === headings)
    return lastSwitches.switches;
  const switches = voiceSwitches(text, { headings });
  lastSwitches = { text, headings, switches };
  return switches;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1))
    starts.push(index + 1);
  return starts;
}

/**
 * What the gutter shows on each line. In a manuscript with chapters, a
 * chapter heading shows its chapter's number among the headings, a section
 * heading a lighter mark, and the first written line of the untitled intro
 * (the text before the first heading, which the render reads as a chapter of
 * its own) a faint label; every other line shows its number.
 */
export function gutterLabels(
  lines: readonly (readonly { text: string; kind: MarkupKind }[])[],
  headings: boolean,
  names: { chapter(n: number): string; section: string; intro: string },
): GutterLabel[] {
  const labels: GutterLabel[] = lines.map((_, index) => ({
    text: String(index + 1),
    kind: 'line',
  }));
  if (!headings) return labels;
  let chapters = 0;
  lines.forEach((segments, index) => {
    const kind = segments[0]?.kind;
    if (kind === 'heading') labels[index] = { text: names.chapter(++chapters), kind: 'chapter' };
    else if (kind === 'section') labels[index] = { text: names.section, kind: 'section' };
  });
  const first = labels.findIndex((label) => label.kind === 'chapter');
  const intro = lines.findIndex((segments) => segments.some((segment) => segment.text.trim()));
  if (first > 0 && intro >= 0 && intro < first && labels[intro].kind === 'line')
    labels[intro] = { text: names.intro, kind: 'intro' };
  return labels;
}

/** The line holding `offset`. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Line-relative start of the tag touching `offset` on a line, else -1. */
function tokenFrom(segments: readonly LineSegment[], offset: number): number {
  let from = 0;
  for (const segment of segments) {
    if (from > offset) break;
    const to = from + segment.text.length;
    if (TOKEN_KINDS.has(segment.kind) && offset <= to) return from;
    from = to;
  }
  return -1;
}

/** Where the caret is: the moving end of the selection. */
function caretOf(element: HTMLTextAreaElement): number {
  return element.selectionDirection === 'backward' ? element.selectionStart : element.selectionEnd;
}

/** The text node and offset holding line-relative `offset` in an overlay line. */
function textPoint(
  line: Element,
  offset: number,
  forward: boolean,
): { node: Text; offset: number } | null {
  let position = 0;
  let last: { node: Text; offset: number } | null = null;
  for (const child of line.childNodes) {
    // Plain runs are text nodes of the line; tags are marks with `data-from`.
    // Bands and the gutter carry no text.
    const node =
      child.nodeType === Node.TEXT_NODE
        ? (child as Text)
        : child instanceof HTMLElement &&
            child.dataset.from !== undefined &&
            child.firstChild?.nodeType === Node.TEXT_NODE
          ? (child.firstChild as Text)
          : null;
    if (!node) continue;
    const end = position + node.data.length;
    if (offset < end || (offset === end && !forward)) return { node, offset: offset - position };
    position = end;
    last = { node, offset: node.data.length };
  }
  return last;
}

/** The union of the rects on the first visual row, or null without layout. */
function firstRow(rects: DOMRectList): DOMRect | null {
  let row: { left: number; top: number; right: number; bottom: number } | null = null;
  for (const rect of rects) {
    if (!rect.width && !rect.height) continue;
    if (!row) row = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    else if (rect.top < row.top + (row.bottom - row.top) / 2) {
      row.left = Math.min(row.left, rect.left);
      row.right = Math.max(row.right, rect.right);
      row.bottom = Math.max(row.bottom, rect.bottom);
    }
  }
  return row && new DOMRect(row.left, row.top, row.right - row.left, row.bottom - row.top);
}

/**
 * Viewport rect of `start…end` (clipped to the start's line), measured on
 * the overlay's text, which lies exactly under the textarea's.
 */
function rangeRect(rows: HTMLElement, model: Model, start: number, end: number): DOMRect | null {
  const { text, starts } = model;
  const from = Math.max(0, Math.min(start, text.length));
  const index = lineOf(starts, from);
  const line = rows.children[index];
  if (!line || typeof document.createRange !== 'function') return null;
  const range = document.createRange();
  if (typeof range.getClientRects !== 'function') return null;
  const lineStart = starts[index];
  const length = (index + 1 < starts.length ? starts[index + 1] - 1 : text.length) - lineStart;
  const a = from - lineStart;
  const b = Math.max(a, Math.min(end - lineStart, length));
  const measure = (head: number, tail: number) => {
    const first = textPoint(line, head, true);
    const last = textPoint(line, tail, false);
    if (!first || !last) return null;
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return firstRow(range.getClientRects());
  };
  if (a < b) return measure(a, b);
  const caret = measure(a, a);
  if (caret) return caret;
  // Not every engine gives a collapsed range a box: take the leading edge of
  // the character after the caret (before it, at the end of a line).
  const before = a === length && length > 0;
  const glyph = before ? measure(a - 1, a) : measure(a, a + 1);
  if (!glyph) return null;
  const rtl = getComputedStyle(line).direction === 'rtl';
  return new DOMRect(before !== rtl ? glyph.right : glyph.left, glyph.top, 0, glyph.height);
}

/** The whole tag a mark belongs to. */
function markToken(model: Model, line: number, mark: HTMLElement): MarkupToken | null {
  const from = model.starts[line] + Number(mark.dataset.from);
  const to = model.starts[line] + Number(mark.dataset.to);
  const text = model.text.slice(from, to);
  if (text.startsWith('[') && text.endsWith(']'))
    return { start: from, end: to, text, kind: mark.dataset.kind as MarkupToken['kind'] };
  // Half of a tag broken across lines.
  const token = tokenAt(model.text, from + 1);
  return token && token.start <= from && token.end >= to ? token : null;
}

/**
 * The tag under a viewport point: the line by its offset in the overlay, then
 * that line's marks by their boxes. `undefined` when the overlay has no
 * layout to go by.
 */
function hitTest(
  overlay: HTMLElement,
  rows: HTMLElement,
  model: Model,
  x: number,
  y: number,
  kinds: ReadonlySet<string> = TOKEN_KINDS,
): Hit | null | undefined {
  const bounds = overlay.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return undefined;
  if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return null;
  const lines = rows.children;
  const top = y - bounds.top + overlay.scrollTop;
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((lines[middle] as HTMLElement).offsetTop <= top) low = middle;
    else high = middle - 1;
  }
  const line = lines[low] as HTMLElement | undefined;
  if (!line || top < line.offsetTop || top >= line.offsetTop + line.offsetHeight) return null;
  const lineHeight = parseFloat(getComputedStyle(line).lineHeight) || 0;
  for (const mark of line.querySelectorAll<HTMLElement>('mark[data-from]')) {
    if (!kinds.has(mark.dataset.kind ?? '')) continue;
    for (const rect of mark.getClientRects()) {
      // The whole row counts, not only the glyphs' height.
      const lead = Math.max(0, (lineHeight - rect.height) / 2);
      if (x >= rect.left && x < rect.right && y >= rect.top - lead && y < rect.bottom + lead) {
        const token = markToken(model, low, mark);
        return token && { mark, token };
      }
    }
  }
  return null;
}

/** The tag a click opens, if the click did not select text instead. */
function clickedToken(
  event: MouseEvent<HTMLTextAreaElement>,
  press: { x: number; y: number; hit: Hit | null | undefined } | null,
  text: string,
  headings: boolean,
): MarkupToken | null {
  const element = event.currentTarget;
  if (
    event.detail > 1 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    element.selectionStart !== element.selectionEnd
  )
    return null;
  if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= CLICK_SLOP)
    return null;
  if (press && press.hit !== undefined) return press.hit?.token ?? null;
  // Nothing was hovered to go by (touch, no layout): a caret strictly inside
  // a tag opens it, one at its edge is just placing the caret.
  const caret = element.selectionStart;
  const token = tokenAt(text, caret, { headings });
  return token && token.start < caret && caret < token.end ? token : null;
}

function tokenHint(
  t: TFunction,
  token: MarkupToken,
  locale: string,
  { clickable, unsupported }: { clickable: boolean; unsupported?: readonly MarkupKind[] },
): string {
  switch (token.kind) {
    case 'voice':
      return t('editor.hint_voice', { name: voiceName(token.text) ?? '' });
    case 'voiceReset':
      return t('editor.hint_voice_reset');
    case 'pause':
      return t('editor.hint_pause', {
        duration: formatPauseSeconds(pauseMs(token.text) ?? 0, locale),
      });
    case 'delivery':
      return t('editor.hint_delivery', { tag: token.text });
    case 'volume': {
      const db = volumeDb(token.text);
      return db === null
        ? t('editor.hint_volume_end')
        : t('editor.hint_volume', {
            gain: t('leveling.db', { value: formatSignedDb(db, locale) }),
          });
    }
    case 'expression':
      return t('editor.hint_expression', { tag: token.text });
    case 'pronunciation': {
      const [from, to] = respellingRange(token);
      return t('editor.hint_pronunciation', {
        respelling: token.text.slice(from - token.start, to - token.start),
      });
    }
    case 'unknown':
      if (unsupported?.includes(classifyToken(token.text))) return t('editor.hint_unsupported');
      return t(clickable ? 'editor.hint_unknown' : 'editor.hint_unknown_static');
  }
}

/**
 * The voice lane from where each switch lands (content coordinates, in text
 * order): one segment per stretch read by one voice, from `top` to `bottom`.
 * Switches on the same row leave the row to the last of them. A stop without
 * a voice (`undefined`) leaves a gap up to the next one: a chapter heading,
 * where the voice starts over.
 */
export function laneSegments(
  stops: readonly LaneStop[],
  top: number,
  bottom: number,
): LaneSegment[] {
  const segments: LaneSegment[] = [];
  let from = top;
  let voice: string | null | undefined = null;
  const close = (to: number) => {
    if (to <= from || voice === undefined) return;
    const last = segments[segments.length - 1];
    if (last && last.voice === voice && last.top + last.height === from)
      last.height = to - last.top;
    else segments.push({ top: from, height: to - from, voice });
  };
  for (const stop of stops) {
    const y = Math.min(Math.max(stop.y, from), bottom);
    close(y);
    from = y;
    voice = stop.voice;
  }
  close(bottom);
  return segments;
}

/** Where each voice starts in the laid-out overlay; null without layout. */
function measureLane(overlay: HTMLElement, rows: HTMLElement, model: Model): LaneSegment[] | null {
  // A book read by its default voice alone has nothing to show.
  if (!model.switches.some((change) => change.voice !== null)) return NO_LANE;
  const bounds = overlay.getBoundingClientRect();
  if (!bounds.width && !bounds.height) return null;
  const lineHeight = parseFloat(getComputedStyle(rows).lineHeight);
  const origin = bounds.top - overlay.scrollTop;
  const stops: LaneStop[] = [];
  for (const change of model.switches) {
    const line = lineOf(model.starts, change.offset);
    const row = rows.children[line] as HTMLElement | undefined;
    if (!row) continue;
    let y = row.offsetTop;
    if (change.kind === 'chapter') {
      // The lane breaks at a chapter heading: the voice starts over below it.
      stops.push({ y, voice: undefined }, { y: y + row.offsetHeight, voice: null });
      continue;
    }
    // A tag opening its line starts on the line's first row; only a tag
    // further along needs measuring.
    const rect =
      change.offset === model.starts[line]
        ? null
        : rangeRect(rows, model, change.offset, change.end);
    // A tag's box sits half a leading below the top of its visual row; the
    // whole row belongs to the voice it switches to.
    if (rect)
      y =
        lineHeight > 0
          ? row.offsetTop +
            Math.round((rect.top - origin - row.offsetTop) / lineHeight) * lineHeight
          : rect.top - origin;
    stops.push({ y, voice: change.voice });
  }
  return laneSegments(stops, rows.offsetTop, rows.offsetTop + rows.offsetHeight);
}

const sameLane = (a: readonly LaneSegment[], b: readonly LaneSegment[]) =>
  a.length === b.length &&
  a.every(
    (segment, index) =>
      segment.top === b[index].top &&
      segment.height === b[index].height &&
      segment.voice === b[index].voice,
  );

/**
 * The lane's segments, measured after layout: whenever the text or its type
 * size (`layout`) changes, the editor's width changes (wrapping moves the
 * switches) and once the web fonts have loaded. Measuring waits for the next
 * frame, so a burst of keystrokes measures once.
 */
function useVoiceLane(
  enabled: boolean,
  overlay: RefObject<HTMLDivElement | null>,
  rows: RefObject<HTMLDivElement | null>,
  model: RefObject<Model>,
  text: string,
  layout: string,
): LaneSegment[] {
  const [lane, setLane] = useState(NO_LANE);
  const request = useRef(() => {});
  useLayoutEffect(() => {
    if (!enabled) {
      setLane(NO_LANE);
      return;
    }
    let alive = true;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next =
        overlay.current && rows.current
          ? measureLane(overlay.current, rows.current, model.current)
          : null;
      if (next) setLane((current) => (sameLane(current, next) ? current : next));
    };
    const schedule = () => {
      if (alive && !frame) frame = requestAnimationFrame(measure);
    };
    request.current = schedule;
    schedule();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (overlay.current) observer?.observe(overlay.current);
    void document.fonts?.ready.then(schedule);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      request.current = () => {};
    };
  }, [enabled, overlay, rows, model]);
  useLayoutEffect(() => request.current(), [text, layout]);
  return lane;
}

// What decides where the textarea's text wraps, copied onto `wrappedTop`'s mirror.
const WRAP_STYLES = [
  'direction',
  'font-family',
  'font-size',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'overflow-wrap',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'tab-size',
  'text-indent',
  'text-transform',
  'white-space',
  'word-break',
  'word-spacing',
];

/**
 * Where the visual line holding `offset` starts in the textarea's content:
 * measured in a hidden copy of the text before it, as wide as the textarea
 * and wrapping as it does, so long paragraphs count every row they take.
 */
function wrappedTop(element: HTMLTextAreaElement, offset: number): number {
  const style = getComputedStyle(element);
  const mirror = document.createElement('div');
  for (const name of WRAP_STYLES) mirror.style.setProperty(name, style.getPropertyValue(name));
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-99999px',
    boxSizing: 'border-box',
    border: '0',
    width: `${element.clientWidth}px`,
  });
  mirror.textContent = element.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

/**
 * Put the caret at `offset` and scroll the editor — never the page — so its
 * line sits in the upper third. The line is found in the overlay, which wraps
 * exactly like the textarea; past `HIGHLIGHT_LIMIT` there is none, so it is
 * measured in a copy of the text that wraps the same way.
 */
export function revealOffset(element: HTMLTextAreaElement, offset: number) {
  element.focus({ preventScroll: true });
  element.setSelectionRange(offset, offset);
  const text = element.value;
  let line = 0;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1))
    line++;
  const rows = element.parentElement?.querySelector('[data-slot="markup-lines"]');
  const row = rows?.children[line];
  const top = row instanceof HTMLElement ? row.offsetTop : wrappedTop(element, offset);
  element.scrollTop = Math.max(0, top - element.clientHeight / 3);
}

interface LineProps {
  segments: LineSegment[];
  /** What the gutter shows on the line; `null` without a gutter. */
  label: GutterLabel | null;
  /** The caret's line, while the editor has focus. */
  active: boolean;
  /** Show the active line as a band. */
  band: boolean;
  /** A chapter heading drawn as a full-width band. */
  chapter: boolean;
  /** A section heading, drawn as a lighter band. */
  section: boolean;
  /** Line-relative start of the tag holding the caret, else -1. */
  current: number;
}

const sameSegments = (a: readonly LineSegment[], b: readonly LineSegment[]) =>
  a === b ||
  (a.length === b.length &&
    a.every(
      (segment, index) =>
        segment.text === b[index].text &&
        segment.kind === b[index].kind &&
        segment.className === b[index].className,
    ));

/**
 * One logical line of the overlay. Lines only re-render when their own text
 * or state changes, so typing repaints one line, not the manuscript. Marks
 * carry line-relative `data-from`/`data-to`: lines above can change length
 * without touching this one.
 */
const MarkupLine = memo(
  function MarkupLine({ segments, label, active, band, chapter, section, current }: LineProps) {
    let offset = 0;
    return (
      <div
        data-line={label?.text}
        data-active={active ? '' : undefined}
        data-chapter={chapter || label?.kind === 'chapter' ? '' : undefined}
        data-section={section || label?.kind === 'section' ? '' : undefined}
        data-intro={label?.kind === 'intro' ? '' : undefined}
        className={label ? NUMBERED_LINE : 'relative'}
      >
        {chapter && <span className={CHAPTER_BAND} style={FULL_WIDTH} />}
        {chapter && label && <span className={CHAPTER_ACCENT} />}
        {section && <span className={SECTION_BAND} style={FULL_WIDTH} />}
        {section && label && <span className={SECTION_ACCENT} />}
        {band && active && <span className={ACTIVE_BAND} style={FULL_WIDTH} />}
        {segments.length
          ? segments.map((segment, position) => {
              const from = offset;
              offset += segment.text.length;
              return segment.kind === 'text' ? (
                segment.text
              ) : (
                <mark
                  key={position}
                  data-kind={segment.kind}
                  data-from={from}
                  data-to={offset}
                  data-current={from === current ? '' : undefined}
                  className={segment.className}
                >
                  {segment.text}
                </mark>
              );
            })
          : EMPTY_LINE}
      </div>
    );
  },
  (a, b) =>
    a.label?.text === b.label?.text &&
    a.label?.kind === b.label?.kind &&
    a.active === b.active &&
    a.band === b.band &&
    a.chapter === b.chapter &&
    a.section === b.section &&
    a.current === b.current &&
    sameSegments(a.segments, b.segments),
);

type TextareaProps = Omit<ComponentProps<'textarea'>, 'value' | 'onChange' | 'ref'>;

/**
 * A native textarea with markup highlighted behind the text. The textarea
 * stays the editing surface, so IME composition (Vietnamese Telex, CJK),
 * undo and selection behave exactly as before; the overlay only paints
 * token backgrounds at the same positions, plus the optional gutter (line
 * numbers and a lane colored by the voice reading each line).
 *
 * Inside a `MarkupEditorContext`, tags become interactive: hovering one shows
 * a hint and a pointer, clicking it (or Alt+Enter with the caret on it)
 * reports it through `onTokenActivate`.
 */
export function MarkupTextarea({
  value,
  onValueChange,
  textareaRef,
  headings = false,
  autoGrow = false,
  voices,
  gutter = false,
  activeLine = false,
  unsupported,
  onCaretChange,
  textStyle,
  className,
  textClassName,
  title,
  onScroll,
  onKeyDown,
  onKeyUp,
  onClick,
  onSelect,
  onFocus,
  onBlur,
  onPointerDown,
  onPointerMove,
  onPointerLeave,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: TextareaProps & {
  value: string;
  onValueChange(value: string): void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Highlight `# Chapter` and `## Section` lines (Audiobook manuscripts). */
  headings?: boolean;
  /** Grow with the content instead of scrolling inside. */
  autoGrow?: boolean;
  /** Typography and padding, applied to both layers. */
  textClassName?: string;
  /** The script's `[voice:NAME]` names in first-seen order: each voice gets its color. */
  voices?: readonly string[];
  /** Line numbers, and a lane showing which voice reads each line. */
  gutter?: boolean;
  /** Band the caret's line while editing; chapter headings become full-width bands. */
  activeLine?: boolean;
  /**
   * Tags this page does not read (voice switches, delivery and volume on
   * Clone and Voice Design): marked as unknown, with a hint saying so.
   */
  unsupported?: readonly MarkupKind[];
  /** The caret moved while the editor has focus (typing, clicks, arrow keys). */
  onCaretChange?(offset: number): void;
  /**
   * Type size and leading of both layers (the editor's zoom). A change keeps
   * the same text in view and measures the lane again.
   */
  textStyle?: CSSProperties;
}) {
  const { t, i18n } = useTranslation();
  const tools = useContext(MarkupEditorContext);
  const spellcheck = useScriptSpellcheck();
  const input = useRef<HTMLTextAreaElement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  // Offsets come from the textarea's selection, which only knows `\n`.
  const text = normalizeNewlines(value);
  const highlight = text.length <= HIGHLIGHT_LIMIT;
  const editable = !props.disabled && !props.readOnly;
  const interactive = editable && Boolean(tools?.onTokenActivate);
  // Without tools to open a tag, hovering still explains the ones not read.
  const hints = interactive || (editable && Boolean(unsupported?.length));
  const lineCache = useRef<LineCache | null>(null);
  const lines = useMemo(
    () =>
      highlight ? cachedLines(lineCache, text, headings, voices, activeLine, unsupported) : [],
    [text, headings, voices, activeLine, unsupported, highlight],
  );
  const starts = useMemo(() => lineStarts(text), [text]);
  const switches = useMemo(
    () => (highlight && gutter ? textVoiceSwitches(text, headings) : []),
    [text, headings, gutter, highlight],
  );
  // The caret's line and the tag it touches (line-relative), while focused.
  const [editing, setEditing] = useState<{ line: number; token: number } | null>(null);
  // What the overlay last committed, for queries between renders.
  const model = useRef<Model>({ text, starts, lines, switches });
  const composing = useRef(false);
  const selection = useRef<{ start: number; end: number; text: string } | null>(null);
  const caret = useRef<number | null>(null);
  const press = useRef<{ x: number; y: number; hit: Hit | null | undefined } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hovered = useRef<Hit | null>(null);
  const hoverFrame = useRef(0);

  const setInput = useCallback(
    (node: HTMLTextAreaElement | null) => {
      input.current = node;
      if (typeof textareaRef === 'function') textareaRef(node);
      else if (textareaRef) textareaRef.current = node;
    },
    [textareaRef],
  );
  const handle = useMemo<MarkupEditorHandle>(() => {
    const rectAt = (start: number, end = start) =>
      rows.current
        ? rangeRect(rows.current, model.current, Math.min(start, end), Math.max(start, end))
        : null;
    return {
      get element() {
        return input.current as HTMLTextAreaElement;
      },
      get composing() {
        return composing.current;
      },
      rectAt,
      anchorAt: (start, end = start) => ({
        getBoundingClientRect: () =>
          rectAt(start, end) ?? input.current?.getBoundingClientRect() ?? new DOMRect(),
        contextElement: input.current ?? undefined,
      }),
    };
  }, []);

  // Follow the caret: its line and tag for the overlay, and the listeners.
  const track = (reason: 'input' | 'caret') => {
    const element = input.current;
    if (!element) return;
    const current = model.current;
    const focused = element.ownerDocument.activeElement === element;
    const at = caretOf(element);
    let next: { line: number; token: number } | null = null;
    if (focused && (gutter || activeLine || interactive)) {
      const line = lineOf(current.starts, at);
      const collapsed = element.selectionStart === element.selectionEnd;
      next = {
        line,
        token:
          interactive && collapsed
            ? tokenFrom(current.lines[line] ?? [], at - current.starts[line])
            : -1,
      };
    }
    setEditing((previous) =>
      previous === next ||
      (previous && next && previous.line === next.line && previous.token === next.token)
        ? previous
        : next,
    );
    const last = selection.current;
    selection.current = {
      start: element.selectionStart,
      end: element.selectionEnd,
      text: current.text,
    };
    if (
      reason === 'input' ||
      !last ||
      last.start !== element.selectionStart ||
      last.end !== element.selectionEnd ||
      last.text !== current.text
    )
      tools?.onEditorChange?.(handle, reason);
    if (focused && at !== caret.current) {
      caret.current = at;
      onCaretChange?.(at);
    }
  };

  const showHover = (hit: Hit | null) => {
    const previous = hovered.current;
    if (
      previous?.mark === hit?.mark &&
      previous?.token.start === hit?.token.start &&
      previous?.token.text === hit?.token.text
    )
      return;
    if (previous && previous.mark !== hit?.mark) previous.mark.removeAttribute('data-hover');
    hovered.current = hit;
    const element = input.current;
    if (!element) return;
    if (hit) {
      hit.mark.setAttribute('data-hover', '');
      if (interactive) element.style.cursor = 'pointer';
      element.title = tokenHint(t, hit.token, i18n.resolvedLanguage || i18n.language, {
        clickable: interactive,
        unsupported,
      });
    } else {
      element.style.cursor = '';
      if (title === undefined) element.removeAttribute('title');
      else element.title = title;
    }
  };
  // Hover is hit-tested once per frame, straight on the DOM: moving the
  // pointer never re-renders the editor.
  const scheduleHover = () => {
    if (hoverFrame.current || (!pointer.current && !hovered.current)) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const at = pointer.current;
      showHover(
        at && hints && overlay.current && rows.current
          ? (hitTest(
              overlay.current,
              rows.current,
              model.current,
              at.x,
              at.y,
              interactive ? TOKEN_KINDS : UNKNOWN_KINDS,
            ) ?? null)
          : null,
      );
    });
  };

  // Effects reach the latest closures through here.
  const latest = useRef({ track, scheduleHover });
  useLayoutEffect(() => {
    model.current = { text, starts, lines, switches };
    latest.current = { track, scheduleHover };
  });
  useLayoutEffect(
    () => () => {
      cancelAnimationFrame(hoverFrame.current);
      hoverFrame.current = 0;
    },
    [],
  );
  useLayoutEffect(() => latest.current.scheduleHover(), [hints]);

  const syncScroll = useCallback(() => {
    if (overlay.current && input.current) overlay.current.scrollTop = input.current.scrollTop;
  }, []);
  const fit = useCallback(() => {
    const node = input.current;
    if (!autoGrow || !node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [autoGrow]);
  // Where the editor was scrolled to, as a share of its height: a zoom keeps it.
  const scrolled = useRef(0);
  const keepScroll = () => {
    const node = input.current;
    if (node) scrolled.current = node.scrollHeight ? node.scrollTop / node.scrollHeight : 0;
  };
  const rendered = useRef(text);
  useLayoutEffect(() => {
    fit();
    syncScroll();
    keepScroll();
    if (rendered.current === text) return;
    rendered.current = text;
    latest.current.track('input');
    latest.current.scheduleHover();
  }, [text, fit, syncScroll]);
  const layout = textStyle ? `${textStyle.fontSize}/${textStyle.lineHeight}` : '';
  const laidOut = useRef(layout);
  useLayoutEffect(() => {
    if (laidOut.current === layout) return;
    laidOut.current = layout;
    fit();
    const node = input.current;
    if (node && !autoGrow) node.scrollTop = scrolled.current * node.scrollHeight;
    syncScroll();
    latest.current.scheduleHover();
  }, [layout, fit, syncScroll, autoGrow]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!autoGrow || !node || typeof ResizeObserver === 'undefined') return;
    // Wrapping, and so the height, changes with the editor's width.
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoGrow, fit]);
  const lane = useVoiceLane(gutter && highlight, overlay, rows, model, text, layout);
  // Each chapter's gutter label, written once per language.
  const chapterLabel = useMemo(() => {
    const written = new Map<number, string>();
    return (n: number) => {
      let label = written.get(n);
      if (label === undefined) written.set(n, (label = t('editor.gutter_chapter', { n })));
      return label;
    };
  }, [t]);
  const labels = useMemo(
    () =>
      gutter
        ? gutterLabels(lines, headings, {
            chapter: chapterLabel,
            section: SECTION_MARK,
            intro: t('editor.gutter_intro'),
          })
        : null,
    [gutter, lines, headings, chapterLabel, t],
  );

  const scrollbarGutter = autoGrow ? '' : '[scrollbar-gutter:stable]';
  return (
    <div data-slot="markup-textarea" className={cn('relative', className)}>
      {highlight && (
        <div
          ref={overlay}
          aria-hidden="true"
          style={textStyle}
          className={cn(
            LAYER,
            textClassName,
            scrollbarGutter,
            gutter && GUTTER,
            // `isolate` keeps the bands (z-index -10) above the editor's
            // background; no scroll anchoring, the textarea sets scrollTop.
            'pointer-events-none absolute inset-0 isolate overflow-hidden text-transparent select-none [overflow-anchor:none]',
          )}
        >
          <div ref={rows} data-slot="markup-lines">
            {lines.map((segments, index) => (
              <MarkupLine
                key={index}
                segments={segments}
                label={labels?.[index] ?? null}
                active={editing?.line === index}
                band={activeLine}
                chapter={activeLine && headings && segments[0]?.kind === 'heading'}
                section={activeLine && headings && segments[0]?.kind === 'section'}
                current={editing?.line === index ? editing.token : -1}
              />
            ))}
          </div>
          {lane.map((segment, index) => (
            <span
              key={index}
              className={cn(LANE, voiceAccent(segment.voice, voices ?? []).lane)}
              style={{ top: segment.top + 1, height: Math.max(0, segment.height - 2) }}
            />
          ))}
        </div>
      )}
      <textarea
        ref={setInput}
        value={value}
        title={title}
        onChange={(event) => onValueChange(event.target.value)}
        onScroll={(event) => {
          syncScroll();
          keepScroll();
          onScroll?.(event);
          scheduleHover();
          tools?.onEditorChange?.(handle, 'scroll');
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || !editable) return;
          if (tools?.onEditorKeyDown?.(event, handle)) {
            event.preventDefault();
            return;
          }
          if (
            !interactive ||
            event.key !== 'Enter' ||
            !event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.nativeEvent.isComposing
          )
            return;
          const token = tokenAt(model.current.text, caretOf(event.currentTarget), { headings });
          if (!token) return;
          event.preventDefault();
          tools?.onTokenActivate?.(token, handle, 'keyboard');
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event);
          track('caret');
        }}
        onSelect={(event) => {
          onSelect?.(event);
          track('caret');
        }}
        onClick={(event) => {
          onClick?.(event);
          track('caret');
          const pressed = press.current;
          press.current = null;
          if (!interactive || event.defaultPrevented) return;
          const token = clickedToken(event, pressed, model.current.text, headings);
          if (token) tools?.onTokenActivate?.(token, handle, 'pointer');
        }}
        onFocus={(event) => {
          onFocus?.(event);
          selection.current = null;
          track('caret');
        }}
        onBlur={(event) => {
          onBlur?.(event);
          selection.current = null;
          setEditing(null);
          tools?.onEditorChange?.(handle, 'blur');
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          press.current =
            event.button !== 0 || !interactive
              ? null
              : {
                  x: event.clientX,
                  y: event.clientY,
                  // A touch has no hover to go by: the caret decides on click.
                  hit:
                    event.pointerType === 'touch' || !overlay.current || !rows.current
                      ? undefined
                      : hitTest(
                          overlay.current,
                          rows.current,
                          model.current,
                          event.clientX,
                          event.clientY,
                        ),
                };
        }}
        onPointerMove={(event) => {
          onPointerMove?.(event);
          if (event.pointerType === 'touch' || (!hints && !hovered.current)) return;
          pointer.current = { x: event.clientX, y: event.clientY };
          scheduleHover();
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          pointer.current = null;
          showHover(null);
        }}
        onCompositionStart={(event) => {
          onCompositionStart?.(event);
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          onCompositionEnd?.(event);
          composing.current = false;
          // The composed text is in: let the listeners look again.
          selection.current = null;
          track('caret');
        }}
        className={cn(
          LAYER,
          textClassName,
          scrollbarGutter,
          gutter && GUTTER,
          'resize-none bg-transparent outline-none',
          // Fixed-height editors fill the wrapper (which the caller sizes)
          // and scroll inside; the overlay follows that scroll.
          autoGrow ? 'relative overflow-hidden' : 'absolute inset-0 h-full overflow-y-auto',
        )}
        style={textStyle}
        // Settings → Spellcheck while writing (off by default): an English
        // dictionary would underline a Vietnamese script end to end.
        spellCheck={spellcheck}
        {...props}
        {...tools?.textareaAria}
      />
    </div>
  );
}
