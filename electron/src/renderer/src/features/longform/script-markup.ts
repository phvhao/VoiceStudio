import { TAGS } from '@shared/utils/constants';

/**
 * Script markup for Stories and Audiobook: the editing side of the longform
 * dialect (`backend/services/longform_parser.py` is the grammar's source of
 * truth). Pure text helpers: the highlighter's tokenizer and the edits the
 * markup toolbar applies. Nothing here decides how a script renders.
 */

// Mirrors omnivoice/utils/text.py: PAUSE_MAX_MS clamps every [pause …].
export const PAUSE_MAX_MS = 10_000;

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
  | 'voice'
  | 'voiceReset'
  | 'pause'
  | 'delivery'
  | 'expression'
  | 'unknown';

export interface MarkupSegment {
  text: string;
  kind: MarkupKind;
}

// Any bracket token without nested brackets (mirrors audiobookScript's
// BRACKET_RE); a negated class with one quantifier, so matching is linear.
const TOKEN_RE = /\[[^\][]*\]/g;
// H1 chapter heading, same shape as longform_parser._HEADING_RE.
const HEADING_RE = /^[ \t]*#[ \t]+\S.*$/gm;
const VOICE_RE = /^\[voice:([^\][]*)\]$/;
const PAUSE_RE = /^\[\s*pause(?:\s+\d+(?:\.\d+)?(?:\s*(?:ms|s))?)?\s*\]$/i;
const DELIVERY_RE = /^\[\/?(?:slow|fast|emphasis|spell)\]$/i;
const EXPRESSIONS = new Set(TAGS.map((tag) => tag.toLowerCase()));

export function classifyToken(token: string): MarkupKind {
  const voice = VOICE_RE.exec(token);
  if (voice) {
    const name = voice[1].trim();
    // Stories wrote `[voice:default]` before `[voice:]`; both reset.
    return name === '' || name === 'default' ? 'voiceReset' : 'voice';
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
  const scan = (chunk: string) => {
    let cursor = 0;
    for (const match of chunk.matchAll(TOKEN_RE)) {
      push(chunk.slice(cursor, match.index), 'text');
      push(match[0], classifyToken(match[0]));
      cursor = match.index + match[0].length;
    }
    push(chunk.slice(cursor), 'text');
  };
  if (!headings) {
    scan(text);
    return segments;
  }
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

export function formatPauseSeconds(ms: number): string {
  return `${Number((clampPauseMs(ms) / 1000).toFixed(2))} s`;
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

export function voiceToken(name: string): string {
  return `[voice:${name}]`;
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
    name.toLowerCase() === 'default' || (Object.hasOwn(cast, name) && cast[name] !== profile.id);
  const base = sanitizeCastName(profile.name) || profile.id;
  if (!taken(base)) return base;
  const existing = Object.keys(cast).find((name) => cast[name] === profile.id && !taken(name));
  if (existing) return existing;
  let n = 2;
  while (taken(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
