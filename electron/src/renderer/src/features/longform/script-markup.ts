import { TAGS } from '@shared/utils/constants';
import { isDefaultVoiceName } from '@shared/utils/audiobookScript';

/**
 * Script markup for Stories and Audiobook: the editing side of the longform
 * dialect (`backend/services/longform_parser.py` is the grammar's source of
 * truth). Pure text helpers: the highlighter's tokenizer and the edits the
 * markup toolbar applies. Nothing here decides how a script renders.
 */

// Mirrors omnivoice/utils/text.py: PAUSE_MAX_MS clamps every [pause …], and
// a bare [pause] lasts PAUSE_DEFAULT_MS.
export const PAUSE_MAX_MS = 10_000;
export const PAUSE_DEFAULT_MS = 350;

export const PAUSE_PRESETS = [
  { id: 'breath', ms: 250 },
  { id: 'short', ms: 500 },
  { id: 'medium', ms: 1000 },
  { id: 'long', ms: 2000 },
  { id: 'scene', ms: 3000 },
] as const;

export const DELIVERY_TAGS = ['slow', 'fast', 'emphasis', 'spell'] as const;
export type DeliveryTag = (typeof DELIVERY_TAGS)[number];

/** `[voice:]` returns to the line's (or book's) default voice in both modes. */
export const VOICE_RESET_TOKEN = '[voice:]';

export type MarkupKind =
  | 'text'
  | 'heading'
  | 'section'
  | 'voice'
  | 'voiceReset'
  | 'pause'
  | 'delivery'
  | 'expression'
  | 'pronunciation'
  | 'unknown';

export interface MarkupSegment {
  text: string;
  kind: MarkupKind;
}

// A [[word|respelling]] override (pronunciation._INLINE_RE, bounded the same
// way), else any bracket token without nested brackets (audiobookScript's
// BRACKET_RE). Each alternative is a negated class with one quantifier, so
// matching stays linear.
const TOKEN_RE = /\[\[[^\]]{0,256}\]\]|\[[^\][]*\]/g;
const PRONUNCIATION_RE = /^\[\[[^\]]{0,256}\]\]$/;
// H1 chapter heading, same shape as longform_parser._HEADING_RE.
const HEADING_RE = /^[ \t]*#[ \t]+\S.*$/gm;
// A `## Section` / `### Section` line (longform_parser._SECTION_RE): group 1 is
// its marks; the title after them is spoken, and its tags work as anywhere.
const SECTION_RE = /^([ \t]*(#{2,3})[ \t]+)(\S.*)$/gm;
const VOICE_RE = /^\[voice:([^\][]*)\]$/;
const PAUSE_RE = /^\[\s*pause(?:\s+(\d+(?:\.\d+)?)(?:\s*(ms|s))?)?\s*\]$/i;
const DELIVERY_RE = /^\[\/?(?:slow|fast|emphasis|spell)\]$/i;
const EXPRESSIONS = new Set(TAGS.map((tag) => tag.toLowerCase()));

export function classifyToken(token: string): MarkupKind {
  if (PRONUNCIATION_RE.test(token)) return 'pronunciation';
  const voice = VOICE_RE.exec(token);
  if (voice) {
    const name = voice[1].trim();
    // Stories wrote `[voice:default]` before `[voice:]`; both reset, in any case.
    return isDefaultVoiceName(name) ? 'voiceReset' : 'voice';
  }
  if (PAUSE_RE.test(token)) return 'pause';
  if (DELIVERY_RE.test(token)) return 'delivery';
  if (EXPRESSIONS.has(token.toLowerCase())) return 'expression';
  return 'unknown';
}

/**
 * Split text into plain runs and markup tokens for the editor highlight.
 * Concatenating every segment's text returns the input unchanged, which is
 * what keeps the overlay aligned with the textarea above it.
 */
export function tokenizeMarkup(text: string, { headings = false } = {}): MarkupSegment[] {
  const segments: MarkupSegment[] = [];
  const push = (value: string, kind: MarkupKind) => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && kind === 'text' && last.kind === 'text') last.text += value;
    else segments.push({ text: value, kind });
  };
  const tags = (chunk: string) => {
    let cursor = 0;
    for (const match of chunk.matchAll(TOKEN_RE)) {
      push(chunk.slice(cursor, match.index), 'text');
      push(match[0], classifyToken(match[0]));
      cursor = match.index + match[0].length;
    }
    push(chunk.slice(cursor), 'text');
  };
  if (!headings) {
    tags(text);
    return segments;
  }
  // Between chapter headings, a section line's marks are a segment of their own.
  const scan = (chunk: string) => {
    let cursor = 0;
    for (const match of chunk.matchAll(SECTION_RE)) {
      tags(chunk.slice(cursor, match.index));
      push(match[1], 'section');
      cursor = match.index + match[1].length;
    }
    tags(chunk.slice(cursor));
  };
  let cursor = 0;
  for (const match of text.matchAll(HEADING_RE)) {
    scan(text.slice(cursor, match.index));
    push(match[0], 'heading');
    cursor = match.index + match[0].length;
  }
  scan(text.slice(cursor));
  return segments;
}

export function clampPauseMs(ms: number): number {
  return Number.isFinite(ms) ? Math.round(Math.max(0, Math.min(ms, PAUSE_MAX_MS))) : 0;
}

/** `[pause 250ms]` below a second (or off the 0.1 s grid), `[pause 1.5s]` above. */
export function pauseToken(ms: number): string {
  const value = clampPauseMs(ms);
  return value < 1000 || value % 100 !== 0 ? `[pause ${value}ms]` : `[pause ${value / 1000}s]`;
}

export function formatPauseSeconds(ms: number, locale?: string): string {
  return seconds(locale).format(Number((clampPauseMs(ms) / 1000).toFixed(2)));
}

/** The short unit `formatPauseSeconds` writes in `locale`: "s", "giây"… */
export function secondsUnit(locale?: string): string {
  return (
    seconds(locale)
      .formatToParts(1)
      .find((part) => part.type === 'unit')?.value ?? 's'
  );
}

/** Seconds as `locale` writes them, unit included ("1.5s", "1,5 giây"). */
function seconds(locale?: string) {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    maximumFractionDigits: 2,
  });
}

/** How long a `[pause …]` tag pauses, to the millisecond; `null` for any other text. */
export function pauseMs(token: string): number | null {
  const match = PAUSE_RE.exec(token);
  if (!match) return null;
  if (match[1] === undefined) return PAUSE_DEFAULT_MS;
  return clampPauseMs(Number(match[1]) * (match[2]?.toLowerCase() === 's' ? 1000 : 1));
}

export interface ExpressionGroup {
  /** `stories.tones.<key>` label. */
  key: string;
  tags: string[];
}

const EXPRESSION_KEYS: Record<string, string> = {
  laughter: 'laugh',
  sigh: 'sigh',
  question: 'question',
  surprise: 'surprise',
  confirmation: 'confirm',
  dissatisfaction: 'dissatisfaction',
};

/** Expression tags grouped by sound, derived from TAGS so new ones appear. */
export function expressionGroups(tags: readonly string[] = TAGS): ExpressionGroup[] {
  const groups = new Map<string, string[]>();
  for (const tag of tags) {
    const family = tag.slice(1, -1).split('-')[0].toLowerCase();
    const key = EXPRESSION_KEYS[family] ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), tag]);
  }
  return [...groups].map(([key, members]) => ({ key, tags: members }));
}

/** The sound variant shown on an expression chip: `[question-ah]` → `ah`. */
export function expressionVariant(tag: string): string {
  const [, ...rest] = tag.slice(1, -1).split('-');
  return rest.join('-');
}

/**
 * One edit of the source text: replace `from…to` with `insert`, then select
 * `selectionStart…selectionEnd` in the result. `text` is the full result, for
 * callers that cannot apply the edit natively.
 */
export interface MarkupEdit {
  from: number;
  to: number;
  insert: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

function clampRange(text: string, start: number, end: number): [number, number] {
  const from = Math.max(0, Math.min(start, text.length));
  return [from, Math.max(from, Math.min(end, text.length))];
}

function edit(
  text: string,
  from: number,
  to: number,
  insert: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): MarkupEdit {
  return {
    from,
    to,
    insert,
    text: text.slice(0, from) + insert + text.slice(to),
    selectionStart,
    selectionEnd,
  };
}

/**
 * Insert a standalone token (pause, expression, voice switch) after the
 * selection — never over it — padded with spaces so it cannot glue onto a
 * word. The caret lands after the token.
 */
export function insertToken(text: string, start: number, end: number, token: string): MarkupEdit {
  const [, at] = clampRange(text, start, end);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const left = before && !/\s$/.test(before) ? ' ' : '';
  const right = after && !/^\s/.test(after) ? ' ' : '';
  const insert = left + token + right;
  const caret = at + left.length + token.length;
  return edit(text, at, at, insert, caret);
}

/**
 * Wrap the selection in an open/close pair and keep the wrapped words
 * selected; with no selection, insert the pair with the caret between them.
 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  open: string,
  close: string,
): MarkupEdit {
  const [from, to] = clampRange(text, start, end);
  const selected = text.slice(from, to);
  if (!selected) return edit(text, from, to, open + close, from + open.length);
  // Leave surrounding spaces outside the markup so `[slow] word [/slow]`
  // does not speak a stray pause at each edge.
  const lead = selected.length - selected.trimStart().length;
  const trail = selected.length - selected.trimEnd().length;
  const core = selected.slice(lead, selected.length - trail);
  if (!core) return edit(text, to, to, open + close, to + open.length);
  const innerStart = from + lead + open.length;
  return edit(
    text,
    from + lead,
    to - trail,
    open + core + close,
    innerStart,
    innerStart + core.length,
  );
}

/**
 * Respell the selection for this occurrence: `[[word|word]]` with the second
 * half selected, ready to type how it should be read. With no selection, an
 * empty `[[|]]` with the caret on the word half.
 */
export function pronounceSelection(text: string, start: number, end: number): MarkupEdit {
  const [from, to] = clampRange(text, start, end);
  const selected = text.slice(from, to);
  const word = selected.trim().replace(/[[\]|]/g, '');
  if (!word) return edit(text, to, to, '[[|]]', to + 2);
  const lead = selected.length - selected.trimStart().length;
  const trail = selected.length - selected.trimEnd().length;
  const respelling = from + lead + 3 + word.length;
  return edit(
    text,
    from + lead,
    to - trail,
    `[[${word}|${word}]]`,
    respelling,
    respelling + word.length,
  );
}

export function voiceToken(name: string): string {
  return `[voice:${name}]`;
}

/**
 * `[voice:]`, with nothing in it. Where each line has a voice of its own
 * (Stories) it returns to the line's voice; `[voice:default]` reads in the
 * default voice there, as everywhere.
 */
export function isBareVoiceReset(token: string): boolean {
  return VOICE_RE.exec(token)?.[1].trim() === '';
}

/** The name in a `[voice:NAME]` tag; `null` for the resets and for any other text. */
export function voiceName(token: string): string | null {
  const name = VOICE_RE.exec(token)?.[1].trim();
  return name && !isDefaultVoiceName(name) ? name : null;
}

/**
 * Voice the selection with `name` and return to the default after it; with a
 * bare caret, switch the voice from the caret on.
 */
export function applyVoice(text: string, start: number, end: number, name: string): MarkupEdit {
  const [from, to] = clampRange(text, start, end);
  return text.slice(from, to).trim()
    ? wrapSelection(text, from, to, voiceToken(name), VOICE_RESET_TOKEN)
    : insertToken(text, from, to, voiceToken(name));
}

/**
 * Start a chapter at the caret's line: the heading goes on its own line after
 * the current one (or replaces an empty line), and its title stays selected
 * so typing renames it.
 */
export function insertChapter(text: string, caret: number, title: string): MarkupEdit {
  const [at] = clampRange(text, caret, caret);
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const newline = text.indexOf('\n', at);
  const lineEnd = newline < 0 ? text.length : newline;
  const heading = `# ${title}`;
  if (!text.slice(lineStart, lineEnd).trim()) {
    const before = text.slice(0, lineStart);
    const lead = before && !before.endsWith('\n\n') ? '\n' : '';
    const tail = text.slice(lineEnd) ? '' : '\n';
    const titleStart = lineStart + lead.length + 2;
    return edit(
      text,
      lineStart,
      lineEnd,
      lead + heading + tail,
      titleStart,
      titleStart + title.length,
    );
  }
  const insert = `\n\n${heading}\n`;
  const titleStart = lineEnd + 4;
  return edit(text, lineEnd, lineEnd, insert, titleStart, titleStart + title.length);
}

/** How many chapter headings the text already has (for "Chapter N"). */
export function countHeadings(text: string): number {
  return text.match(HEADING_RE)?.length ?? 0;
}

/** A cast name usable inside `[voice:NAME]`: no brackets, single spaces. */
export function sanitizeCastName(name: string): string {
  return name.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The readable `[voice:NAME]` name for a profile, so scripts say
 * `[voice:Mara]` instead of a profile id. Reuses the profile's own name when
 * it is free (or already mapped to this profile), then any name already cast
 * to this profile, and only then a numbered variant. `default` is reserved:
 * Stories reads `[voice:default]` as "back to the default voice".
 */
export function castNameForProfile(
  profile: { id: string; name: string },
  cast: Record<string, string>,
): string {
  const taken = (name: string) =>
    isDefaultVoiceName(name) || (Object.hasOwn(cast, name) && cast[name] !== profile.id);
  const base = sanitizeCastName(profile.name) || profile.id;
  if (!taken(base)) return base;
  const existing = Object.keys(cast).find((name) => cast[name] === profile.id && !taken(name));
  if (existing) return existing;
  let n = 2;
  while (taken(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

const BLANK_LINE_RE = /\n[ \t]*\n/g;

/** Whether `text` has anything to say besides markup. */
const speaks = (text: string) =>
  tokenizeMarkup(text).some(
    (segment) =>
      (segment.kind === 'text' || segment.kind === 'pronunciation') && segment.text.trim(),
  );
const VOICE_TOKEN_RE = /\[voice:([^\][]*)\]/g;

/**
 * The text to audition for a selection: the selected text, or the paragraph
 * around a bare caret. Chapter headings are dropped (a preview renders one
 * chapter), and the `[voice:NAME]` in effect where the passage starts is
 * carried in front of it, so a line inside a character's part is heard in
 * that character's voice. `null` when there is nothing to speak.
 */
export function previewPassage(text: string, start: number, end: number): string | null {
  let [from, to] = clampRange(text, start, end);
  if (from === to) {
    const before = [...text.slice(0, from).matchAll(BLANK_LINE_RE)].pop();
    from = before ? before.index + before[0].length : 0;
    const after = new RegExp(BLANK_LINE_RE.source).exec(text.slice(to));
    to = after ? to + after.index : text.length;
  }
  const raw = text.slice(from, to);
  const passage = raw.replace(HEADING_RE, '').trim();
  if (!speaks(passage)) return null;
  // Each chapter starts on the default voice, so look back only to its
  // heading — including one that opens the passage itself.
  const opening = new RegExp(HEADING_RE.source, 'm').exec(raw);
  const startsChapter = opening !== null && !speaks(raw.slice(0, opening.index));
  const lead = text.slice(0, startsChapter ? from + opening.index + opening[0].length : from);
  const heading = [...lead.matchAll(HEADING_RE)].pop();
  const chapter = heading ? lead.slice(heading.index + heading[0].length) : lead;
  const voice = [...chapter.matchAll(VOICE_TOKEN_RE)].pop();
  const name = voice?.[1].trim();
  return name && !isDefaultVoiceName(name) && !passage.startsWith('[voice:')
    ? `${voiceToken(name)} ${passage}`
    : passage;
}

/**
 * The text as a textarea holds it: a textarea only knows `\n` line breaks, so
 * offsets read from its selection count against this.
 */
export function normalizeNewlines(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** 1-based line and column of `offset`, as an editor's status bar shows them. */
export function caretPosition(text: string, offset: number): { line: number; column: number } {
  const [at] = clampRange(text, offset, offset);
  let line = 1;
  let lineStart = 0;
  for (let index = text.indexOf('\n'); index !== -1 && index < at;) {
    line++;
    lineStart = index + 1;
    index = text.indexOf('\n', lineStart);
  }
  return { line, column: at - lineStart + 1 };
}

export interface VoiceSwitch {
  /** Where the switch is written: the tag, or the chapter heading's line. */
  offset: number;
  end: number;
  /** Who reads from here on; `null` is the book's default voice. */
  voice: string | null;
  kind: 'voice' | 'reset' | 'chapter';
}

/**
 * Every place the narrator changes, in order, read the way the render reads
 * them (longform_parser): `[voice:NAME]` holds until the next switch,
 * `[voice:]` and `[voice:default]` return to the default voice, and with
 * `headings` every `# Title` line opens a chapter on the default voice. A tag
 * inside a heading line is part of the chapter's title, so it switches nothing.
 */
export function voiceSwitches(text: string, { headings = false } = {}): VoiceSwitch[] {
  const switches: VoiceSwitch[] = [];
  const scan = (from: number, to: number) => {
    for (const match of text.slice(from, to).matchAll(VOICE_TOKEN_RE)) {
      const offset = from + match.index;
      const name = match[1].trim();
      const reset = isDefaultVoiceName(name);
      switches.push({
        offset,
        end: offset + match[0].length,
        voice: reset ? null : name,
        kind: reset ? 'reset' : 'voice',
      });
    }
  };
  if (!headings) {
    scan(0, text.length);
    return switches;
  }
  let cursor = 0;
  for (const match of text.matchAll(HEADING_RE)) {
    scan(cursor, match.index);
    cursor = match.index + match[0].length;
    switches.push({ offset: match.index, end: cursor, voice: null, kind: 'chapter' });
  }
  scan(cursor, text.length);
  return switches;
}

/**
 * The voice in effect at `offset` among a text's `switches`. A heading's whole
 * line belongs to its chapter; a tag takes over once `offset` is inside it, so
 * the caret on `[voice:Mara]` already reads as Mara.
 */
export function voiceInEffect(switches: readonly VoiceSwitch[], offset: number): string | null {
  let voice: string | null = null;
  for (const change of switches) {
    if (change.kind === 'chapter' ? change.offset > offset : change.offset >= offset) break;
    voice = change.voice;
  }
  return voice;
}

/** The voice in effect at `offset` (`null` is the default voice). */
export function voiceAt(text: string, offset: number, options: { headings?: boolean } = {}) {
  return voiceInEffect(voiceSwitches(text, options), offset);
}

/**
 * What a voice tag reads: from the tag's end to the next switch (or the end
 * of its chapter, or of the text), without the whitespace around it.
 */
export function voiceSection(
  text: string,
  token: Pick<MarkupToken, 'end'>,
  options: { headings?: boolean } = {},
): [number, number] {
  const next = voiceSwitches(text, options).find((change) => change.offset >= token.end);
  let from = token.end;
  let to = next ? next.offset : text.length;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return [from, to];
}

export interface MarkupToken {
  start: number;
  end: number;
  text: string;
  kind: Exclude<MarkupKind, 'text' | 'heading' | 'section'>;
}

const HEADING_LINE_RE = new RegExp(HEADING_RE.source);

/** Whether `offset` is on a `# Chapter` heading line. */
function onHeadingLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', lineStart);
  return HEADING_LINE_RE.test(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd));
}

/**
 * The markup token under (or touching) position `pos`, for editing it. With
 * `headings`, a tag on a `# Chapter` line is part of the title, as the
 * highlighter and the renderer read it, so there is no token there.
 */
export function tokenAt(text: string, pos: number, { headings = false } = {}): MarkupToken | null {
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > pos) break;
    if (pos > end) continue;
    if (headings && onHeadingLine(text, start)) return null;
    return { start, end, text: match[0], kind: classifyToken(match[0]) as MarkupToken['kind'] };
  }
  return null;
}

/**
 * The tag holding all of `start…end`: the one at a collapsed caret, or the
 * one a selection lies inside. A right-click on macOS selects the word under
 * the pointer before the menu opens, so `[pause 1s]` arrives with `pause`
 * selected.
 */
export function tokenAround(
  text: string,
  start: number,
  end: number,
  options: { headings?: boolean } = {},
): MarkupToken | null {
  for (const at of [start, end]) {
    const token = tokenAt(text, at, options);
    if (token && token.start <= start && end <= token.end) return token;
  }
  return null;
}

/** Replace `from…to` with `insert`; the caret lands after it, or it is selected. */
export function replaceRange(
  text: string,
  from: number,
  to: number,
  insert: string,
  { select = false } = {},
): MarkupEdit {
  const [a, b] = clampRange(text, from, to);
  return edit(text, a, b, insert, select ? a : a + insert.length, a + insert.length);
}

/** A delivery tag's kind, `[/Slow]` → `slow`; `null` for any other text. */
export function deliveryKind(token: string): DeliveryTag | null {
  if (!DELIVERY_RE.test(token)) return null;
  return token.replace(/[[\]/]/g, '').toLowerCase() as DeliveryTag;
}

/**
 * A delivery tag and its partner, opening half first: the next closing tag of
 * the same kind after an opening one, the last opening tag before a closing
 * one. `null` for a tag without its partner.
 */
function deliveryPair(
  text: string,
  token: MarkupToken,
): [Pick<MarkupToken, 'start' | 'end'>, Pick<MarkupToken, 'start' | 'end'>] | null {
  const name = deliveryKind(token.text);
  if (!name) return null;
  const closing = token.text.startsWith('[/');
  // `name` is one of the four delivery words, so it needs no escaping.
  const partner = new RegExp(String.raw`\[` + (closing ? '' : '/') + name + String.raw`\]`, 'gi');
  let match: RegExpExecArray | null = null;
  if (closing) {
    for (const m of text.slice(0, token.start).matchAll(partner)) match = m as RegExpExecArray;
  } else {
    partner.lastIndex = token.end;
    match = partner.exec(text);
  }
  if (!match) return null;
  const other = { start: match.index, end: match.index + match[0].length };
  return closing ? [other, token] : [token, other];
}

/**
 * Remove a token. A delivery tag takes its partner with it and keeps the
 * words between them; a respelling keeps the word it respelled; any other tag
 * goes with one neighbouring space, so no double space is left behind.
 */
export function removeToken(text: string, token: MarkupToken): MarkupEdit {
  const pair = token.kind === 'delivery' ? deliveryPair(text, token) : null;
  if (pair) {
    const [open, close] = pair;
    return replaceRange(text, open.start, close.end, text.slice(open.end, close.start), {
      select: true,
    });
  }
  if (token.kind === 'pronunciation') {
    const inner = token.text.slice(2, -2);
    const word = inner.includes('|') ? inner.slice(0, inner.indexOf('|')) : inner;
    return replaceRange(text, token.start, token.end, word, { select: true });
  }
  const after = text[token.end] === ' ' && (token.start === 0 || /\s/.test(text[token.start - 1]));
  return replaceRange(text, token.start, token.end + (after ? 1 : 0), '');
}

/**
 * Read a delivery pair another way, `[slow]…[/slow]` → `[fast]…[/fast]`: both
 * halves change in one edit (one undo step) and the words between them stay.
 * A tag without its partner changes alone. The caret ends after the tag that
 * was edited.
 */
export function changeDeliveryKind(
  text: string,
  token: MarkupToken,
  kind: DeliveryTag,
): MarkupEdit {
  const closing = token.text.startsWith('[/');
  const pair = deliveryPair(text, token);
  if (!pair)
    return replaceRange(text, token.start, token.end, closing ? `[/${kind}]` : `[${kind}]`);
  const [open, close] = pair;
  const insert = `[${kind}]${text.slice(open.end, close.start)}[/${kind}]`;
  return edit(
    text,
    open.start,
    close.end,
    insert,
    open.start + (closing ? insert.length : kind.length + 2),
  );
}

/** Select the "how it is read" half of `[[word|respelling]]`. */
export function respellingRange(token: MarkupToken): [number, number] {
  const bar = token.text.indexOf('|');
  return bar < 0 ? [token.start + 2, token.end - 2] : [token.start + bar + 1, token.end - 2];
}

/**
 * The halves of `[[word|respelling]]`: the word the author wrote (`null` in a
 * bare `[[respelling]]`) and what is spoken in its place.
 */
export function respellingParts(token: Pick<MarkupToken, 'text'>): {
  word: string | null;
  respelling: string;
} {
  const inner = token.text.slice(2, -2);
  const bar = inner.indexOf('|');
  return bar < 0
    ? { word: null, respelling: inner }
    : { word: inner.slice(0, bar), respelling: inner.slice(bar + 1) };
}

// The inside of an override is bounded like pronunciation._INLINE_RE.
const RESPELLING_MAX = 256;

/**
 * A respelling as it can sit inside `[[…|…]]`: brackets, bars and line breaks
 * would end or split the override, so they become spaces.
 */
export function cleanRespelling(value: string): string {
  return value
    .replace(/[[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Speak `respelling` for this override from now on; the caret lands after it. */
export function setRespelling(text: string, token: MarkupToken, respelling: string): MarkupEdit {
  const { word } = respellingParts(token);
  const head = word === null ? '' : `${word}|`;
  const said = cleanRespelling(respelling)
    .slice(0, Math.max(0, RESPELLING_MAX - head.length))
    .trim();
  return replaceRange(text, token.start, token.end, `[[${head}${said}]]`);
}

// How much of a tag being typed the suggestions look at, each side of the caret.
const TYPED_TAG_MAX = 40;

/** A tag being typed: its `[`, the text typed after it, and where it ends. */
export interface TypedTag {
  start: number;
  /** Past the rest of a tag the caret sits in (through its `]`), else the caret. */
  end: number;
  /** What was typed between the `[` and the caret. */
  query: string;
}

/**
 * The tag being typed at `caret`: a `[` on the caret's line with no `[`, `]`
 * or line break between it and the caret, at most TYPED_TAG_MAX characters
 * back. `[[` starts a respelling, not a tag, and with `headings` a `# Chapter`
 * line holds a title, not tags (as `tokenAt` reads it). With the caret inside
 * a tag (`[pa|use 1s]`), `end` reaches past its `]`, so completing it replaces
 * the whole tag instead of leaving its tail behind.
 */
export function typedTagAt(
  text: string,
  caret: number,
  { headings = false } = {},
): TypedTag | null {
  const [at] = clampRange(text, caret, caret);
  const head = text.slice(Math.max(0, at - TYPED_TAG_MAX - 1), at);
  const bracket = head.lastIndexOf('[');
  if (bracket < 0) return null;
  const query = head.slice(bracket + 1);
  const start = at - query.length - 1;
  if (/[\]\n]/.test(query) || text[start - 1] === '[' || text[start + 1] === '[') return null;
  if (headings && onHeadingLine(text, start)) return null;
  const tail = text.slice(at, at + TYPED_TAG_MAX);
  const close = tail.search(/[[\]\n]/);
  return { start, end: close >= 0 && tail[close] === ']' ? at + close + 1 : at, query };
}

/**
 * Complete the tag being typed: `open` replaces it from its `[`, and with a
 * closing half the caret lands between the two (`[slow]|[/slow]`). Like
 * `insertToken`, a single tag keeps a space between itself and the word after.
 */
export function completeTag(
  text: string,
  tag: Pick<TypedTag, 'start' | 'end'>,
  open: string,
  close = '',
): MarkupEdit {
  const after = text.slice(tag.end);
  const space = !close && after && !/^\s/.test(after) ? ' ' : '';
  return edit(text, tag.start, tag.end, open + close + space, tag.start + open.length);
}
