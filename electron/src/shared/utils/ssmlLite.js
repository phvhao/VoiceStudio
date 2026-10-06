/**
 * SSML-LITE (client port) of backend/services/ssml_lite.py.
 *
 * Parity is no longer kept by hand: the canonical longform grammar (#27) is
 * exercised end-to-end by the shared golden corpus in
 * tests/fixtures/longform_parser_cases.json, asserted byte-for-byte against
 * BOTH this port (via longformParser.js → storyToSpans) and the Python parser.
 * A drift between the two SSML impls fails one of those two suites.
 *
 * Splits one narration line into ordered prosody segments so the Stories Editor
 * compiles the same `[slow]/[fast]/[emphasis]/[spell]/[volume ±N dB]` markup
 * the Audiobook backend parser honours. Pure; no deps.
 *
 *   parseSsmlLite(text) -> [{ text, speed, spell, emphasis, gain_db? }, …]
 *
 * Plain text → one segment {speed:null, spell:false, emphasis:false}. Tags nest
 * (innermost wins per property; nested volumes add up, clamped to ±12 dB); an
 * unclosed tag runs to end-of-line; a stray close is ignored; adjacent
 * identical-prosody segments merge. `gain_db` is present only where a
 * `[volume]` moves the text; a `[volume]` without a readable number is not a tag.
 */
export const SLOW_SPEED = 0.85;
export const FAST_SPEED = 1.15;
const EMPHASIS_SPEED = 0.92;
/** Largest cut or boost of one `[volume]` passage, nested ones added (MAX_PASSAGE_GAIN_DB). */
export const MAX_PASSAGE_GAIN_DB = 12;
const VOLUME = 'volume';

/** Round half-to-even (banker's rounding) — matches Python int(round(x)). */
export function roundHalfToEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  // exact .5 tie → round to the even neighbour
  return f % 2 === 0 ? f : f + 1;
}

const TAGS = {
  slow: { speed: SLOW_SPEED, spell: null, emphasis: null },
  fast: { speed: FAST_SPEED, spell: null, emphasis: null },
  emphasis: { speed: EMPHASIS_SPEED, spell: null, emphasis: true },
  spell: { speed: null, spell: true, emphasis: null },
};

// Fixed-literal alternation plus the bounded gain a [volume] opens with; no
// quantifier overlap → linear-time (ReDoS-safe). Mirrors ssml_lite._TAG_RE.
const TAG_RE =
  /\[(\/?)(slow|fast|emphasis|spell|volume)(?:[ \t]+([+-]?[0-9]{1,4}(?:\.[0-9]{1,4})?)[ \t]?(?:db)?)?\]/gi;

/**
 * Mirror of _tag_of: the stack entry a match stands for (`slow`, `volume -6`),
 * or null when it is not a tag (a volume without its gain, a gain on anything else).
 */
function tagOf(m) {
  const name = m[2].toLowerCase();
  const gain = m[3];
  if ((gain !== undefined) !== (name === VOLUME && m[1] !== '/')) return null;
  return gain !== undefined ? `${name} ${gain}` : name;
}

const gainTenths = (value) => roundHalfToEven(parseFloat(value) * 10);
const clampTenths = (tenths) =>
  Math.max(-MAX_PASSAGE_GAIN_DB * 10, Math.min(MAX_PASSAGE_GAIN_DB * 10, tenths));

function resolve(stack) {
  let speed = null;
  let spell = false;
  let emphasis = false;
  let gain = 0;
  for (const name of stack) {
    if (name.startsWith(VOLUME)) {
      // Nested volumes add up; each tag and their sum are clamped.
      gain += clampTenths(gainTenths(name.slice(VOLUME.length + 1)));
      continue;
    }
    const spec = TAGS[name];
    if (spec.speed !== null) speed = spec.speed;
    if (spec.spell !== null) spell = !!spec.spell;
    if (spec.emphasis !== null) emphasis = !!spec.emphasis;
  }
  gain = clampTenths(gain);
  return gain ? { speed, spell, emphasis, gain_db: gain / 10 } : { speed, spell, emphasis };
}

/** Mirror of _step: apply one tag (tagOf) to the open-tag stack. */
function step(stack, tag, closing) {
  if (closing) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].split(' ')[0] === tag) {
        stack.splice(i, 1);
        break;
      }
    }
  } else {
    stack.push(tag);
  }
}

/**
 * Mirror of open_tags: the tags still open where `text` ends, outermost first,
 * each as written between its brackets (`slow`, `volume -6`).
 */
export function openSsmlTags(text) {
  const stack = [];
  const re = new RegExp(TAG_RE.source, TAG_RE.flags);
  let m;
  while ((m = re.exec(text || '')) !== null) {
    const tag = tagOf(m);
    if (tag !== null) step(stack, tag, m[1] === '/');
  }
  return stack;
}

export function parseSsmlLite(text) {
  if (!text) return [];
  if (!text.includes('[')) return [{ text, speed: null, spell: false, emphasis: false }];

  const segments = [];
  const stack = [];
  let last = 0;

  const emit = (chunk) => {
    if (!chunk) return;
    const props = resolve(stack);
    const prev = segments[segments.length - 1];
    if (
      prev &&
      prev.speed === props.speed &&
      prev.spell === props.spell &&
      prev.emphasis === props.emphasis &&
      prev.gain_db === props.gain_db
    ) {
      prev.text += chunk;
      return;
    }
    segments.push({ text: chunk, ...props });
  };

  const re = new RegExp(TAG_RE.source, TAG_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = tagOf(m);
    if (tag === null) continue; // not a tag: it stays in the text
    emit(text.slice(last, m.index));
    last = m.index + m[0].length;
    step(stack, tag, m[1] === '/');
  }
  emit(text.slice(last));
  return segments;
}

/** Space out a run for [spell]: "USA" → "U S A". */
export function spellOut(word) {
  return (word || '').split(/\s+/).join('').split('').join(' ');
}
