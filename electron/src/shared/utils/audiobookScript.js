/**
 * Audiobook script helpers (#1217) — pure, testable text→data functions for the
 * Cast panel, live stats bar, and pre-flight validation. No React, no i18n: the
 * UI supplies labels; these only compute.
 *
 * The bracket-token regexes here MIRROR the canonical grammar in
 * `longformParser.js` / `backend/services/longform_parser.py` (voice + pause +
 * SSML-lite). They exist for name extraction / stats / warnings only — the
 * golden-corpus parser stays the single grammar source of truth for rendering.
 */
import { TAGS } from './constants';

// [voice:NAME] — content excludes BOTH brackets (mirrors _VOICE_RE). Global.
const VOICE_RE = /\[voice:([^\][]*)\]/g;
// H1 chapter heading (mirrors _HEADING_RE): `# <non-space>…`, multiline.
const HEADING_RE = /^[ \t]*#[ \t]+(\S.*)$/gm;
// The `##`/`###` marks of a section line (mirrors _SECTION_RE): `$1` keeps the
// indent, and the title after them is spoken.
const SECTION_MARKS_RE = /^([ \t]*)#{2,3}(?=[ \t]+\S)/gm;
// Any bracket token — used to strip markup before the word count and to
// enumerate tokens for validation. Non-greedy, no nested brackets.
const BRACKET_RE = /\[[^\][]*\]/g;
// [[word|respelling]] / [[respelling]] pronunciation override (mirrors
// pronunciation._INLINE_RE, same bound). Spoken as its respelling, so it is
// neither markup to strip nor an unknown tag.
const INLINE_OVERRIDE_RE = /\[\[([^\]]{0,256})\]\]/g;

// Recognized (non-voice) bracket tokens, so validation can flag the rest.
const PAUSE_TOKEN_RE = /^\[\s*pause(?:\s+\d+(?:\.\d+)?(?:\s*(?:ms|s))?)?\s*\]$/i;
const SSML_TOKEN_RE = /^\[\/?(?:slow|fast|emphasis|spell)\]$/i;
// `[image: NAME]` (longform_parser._IMAGE_RE): a picture, taken out before reading.
const IMAGE_TOKEN_RE = /^\[image:[^\][\n]*\]$/i;
// [volume ±N dB] / [/volume] (mirrors ssml_lite._TAG_RE: a bounded number, an
// optional dB). A [volume] without a readable gain is read aloud: unknown.
export const VOLUME_TOKEN_RE =
  /^(?:\[volume[ \t]+([+-]?[0-9]{1,4}(?:\.[0-9]{1,4})?)[ \t]?(?:db)?\]|\[\/volume\])$/i;
const REACTION_TOKENS = new Set(TAGS.map((s) => s.toLowerCase()));

/** ~ words a listener hears per minute at an audiobook narration pace. */
export const AUDIOBOOK_WPM = 155;

// Scripts written without spaces between words (Chinese, Japanese, Thai, Lao,
// Khmer, Burmese): a whitespace split reads a whole sentence as one word.
const UNSPACED_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const UNSPACED_CHAR_RE = new RegExp(UNSPACED_RE.source, 'gu');
let wordSegmenter;

/** The words in one whitespace-free run: dictionary word breaks where words have no spaces. */
function runWords(run) {
  if (!UNSPACED_RE.test(run)) return 1;
  if (wordSegmenter === undefined)
    wordSegmenter =
      typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'word' })
        : null;
  if (!wordSegmenter) return (run.match(UNSPACED_CHAR_RE) || []).length;
  let words = 0;
  for (const segment of wordSegmenter.segment(run)) if (segment.isWordLike) words++;
  return words;
}

/** Spoken words in `text`: whitespace-separated, and word breaks inside unspaced scripts. */
function countWords(text) {
  let words = 0;
  for (const run of text.split(/\s+/)) if (run) words += runWords(run);
  return words;
}

/**
 * Distinct `[voice:NAME]` names present in the script, in first-seen order.
 * Names are trimmed. `[voice:]` and `[voice:default]` (any case) are skipped:
 * both hand the text back to the default voice, so neither is a castable name.
 * Except a `default` name `cast` already gives a voice: older versions let
 * `[voice:Default]` be cast like any name, and a saved cast keeps reading so.
 */
export function parseCastNames(text, cast = {}) {
  if (!text) return [];
  const seen = new Set();
  const names = [];
  const re = new RegExp(VOICE_RE.source, VOICE_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = (m[1] || '').trim();
    if (re.lastIndex === m.index) re.lastIndex++; // zero-width guard
    const kept = Boolean(name) && Object.hasOwn(cast, name) && Boolean(cast[name]);
    if ((isDefaultVoiceName(name) && !kept) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** True for a `[voice:…]` value that means the default voice: empty, or `default` in any case. */
export function isDefaultVoiceName(name) {
  const value = (name || '').trim();
  return !value || value.toLowerCase() === 'default';
}

/** Text with every bracket markup token removed (for a spoken-word count). */
function stripMarkup(text) {
  return speakInlineOverrides(text || '').replace(BRACKET_RE, ' ');
}

/** Text with each `[[…]]` override replaced by what it speaks. */
function speakInlineOverrides(text) {
  return text.replace(INLINE_OVERRIDE_RE, (_, inner) =>
    inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner,
  );
}

/**
 * Live script stats: chapters (`# ` H1 count, ≥1 so a title-less script still
 * reads as one chapter), spoken word count (markup stripped; Chinese, Japanese
 * and Thai are split at their word breaks, having no spaces between words),
 * and an estimated runtime in seconds at {@link AUDIOBOOK_WPM}.
 */
export function scriptStats(text) {
  const norm = (text || '').replace(/\r\n?/g, '\n');
  const headings = norm.match(new RegExp(HEADING_RE.source, HEADING_RE.flags)) || [];
  // Spoken words only: drop `# heading` lines (titles aren't narrated as body,
  // mirroring the parser), the marks of `## section` lines (their titles are
  // read aloud) AND bracket markup, then count the words.
  const spoken = stripMarkup(
    norm
      .replace(new RegExp(HEADING_RE.source, HEADING_RE.flags), ' ')
      .replace(new RegExp(SECTION_MARKS_RE.source, SECTION_MARKS_RE.flags), '$1'),
  );
  const words = countWords(spoken);
  const chapters = Math.max(1, headings.length);
  const runtimeSec = words > 0 ? (words / AUDIOBOOK_WPM) * 60 : 0;
  return { chapters, words, runtimeSec };
}

/** Format seconds as a clock string: `H:MM` (≥1h) or `M:SS` (<1h). Pure. */
export function formatRuntimeClock(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Pre-flight warnings for a script (non-blocking hints). Returns an array of
 * `{ type, ... }`:
 *   - `unknown_voice`  `{ name }` — a `[voice:NAME]` neither mapped in the cast
 *                       nor an exact profile id → will use the default voice.
 *   - `empty_chapter`  `{ title }` — a `# heading` with no spoken body.
 *   - `unknown_tag`    `{ tag }` — a bracket token outside the known grammar
 *                       (voice/pause/SSML-lite/reactions) → read aloud literally.
 *
 * @param {string} text
 * @param {object} opts
 * @param {Set<string>|string[]} [opts.mappedNames] cast names with a voice mapped
 * @param {Set<string>|string[]} [opts.profileIds]  known profile ids (exact match)
 */
export function validateScript(text, { mappedNames = [], profileIds = [] } = {}) {
  const warnings = [];
  const norm = (text || '').replace(/\r\n?/g, '\n');
  const mapped = mappedNames instanceof Set ? mappedNames : new Set(mappedNames);
  const ids = profileIds instanceof Set ? profileIds : new Set(profileIds);

  // 1. Unknown voices — a name with no cast mapping and no exact profile match.
  for (const name of parseCastNames(norm)) {
    if (!mapped.has(name) && !ids.has(name)) warnings.push({ type: 'unknown_voice', name });
  }

  // 2. Empty chapters — a `# heading` whose body has no spoken text. Split on
  //    headings (mirroring the parser) and check each body for any word.
  const heads = [];
  const hre = new RegExp(HEADING_RE.source, HEADING_RE.flags);
  let hm;
  while ((hm = hre.exec(norm)) !== null) {
    heads.push({ index: hm.index, end: hm.index + hm[0].length, title: (hm[1] || '').trim() });
    if (hre.lastIndex === hm.index) hre.lastIndex++;
  }
  for (let i = 0; i < heads.length; i++) {
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].index : norm.length;
    const body = norm.slice(heads[i].end, bodyEnd);
    if (!stripMarkup(body).trim()) warnings.push({ type: 'empty_chapter', title: heads[i].title });
  }

  // 3. Unrecognized bracket tokens — anything outside the known grammar.
  const seenTags = new Set();
  const bre = new RegExp(BRACKET_RE.source, BRACKET_RE.flags);
  const tagged = norm.replace(INLINE_OVERRIDE_RE, ' ');
  let bm;
  while ((bm = bre.exec(tagged)) !== null) {
    const tok = bm[0];
    if (bre.lastIndex === bm.index) bre.lastIndex++;
    const lower = tok.toLowerCase();
    const known =
      VOICE_RE.test(tok) ||
      PAUSE_TOKEN_RE.test(tok) ||
      SSML_TOKEN_RE.test(tok) ||
      VOLUME_TOKEN_RE.test(tok) ||
      IMAGE_TOKEN_RE.test(tok) ||
      REACTION_TOKENS.has(lower);
    VOICE_RE.lastIndex = 0; // test() advances a /g regex — reset it
    if (!known && !seenTags.has(lower)) {
      seenTags.add(lower);
      warnings.push({ type: 'unknown_tag', tag: tok });
    }
  }

  return warnings;
}
