/**
 * Canonical longform marker parser — JS twin of
 * backend/services/longform_parser.py (#27).
 *
 * Byte-for-byte mirror of the Python parser, verified by the shared golden
 * corpus tests/fixtures/longform_parser_cases.json (asserted in both
 * tests/test_longform_parser.py and electron/src/shared/test/longformParser.test.js).
 * Do not "improve" one side without the other — the corpus will fail.
 *
 * Grammar precedence (outer→inner):
 *   [image:] (taken out first) → # chapter → ## section → [voice:] → [pause] → SSML-lite.
 */
import { openSsmlTags, parseSsmlLite, roundHalfToEven, spellOut } from './ssmlLite';

export { roundHalfToEven };

export const PAUSE_DEFAULT_MS = 350;
export const PAUSE_MAX_MS = 10000;

// H1 only; title starts with \S so `# ` (no title) is body. Moved-equivalent
// of audiobook.py _HEADING_RE. Global+multiline.
const HEADING_RE = /^[ \t]*#[ \t]+(\S.*)$/gm;
// `## Title` / `### Title` opens a section inside a chapter (mirrors
// _SECTION_RE): read aloud without its marks, as a paragraph of its own, in the
// voice reading there. `####`… stay ordinary text.
const SECTION_RE = /^[ \t]*(#{2,3})[ \t]+(\S.*)$/gm;
// [voice:NAME] — content excludes BOTH brackets (mirrors _VOICE_RE).
const VOICE_RE = /\[voice:([^\][]*)\]/g;
// Pause dialect mirroring omnivoice.utils.text._PAUSE_RE. JS has no atomic
// group; the unit's own `(?:\s*(ms|s))?` is zero-width when no unit follows, so
// the trailing `\s*` is the ONLY consumer of trailing whitespace — no two `\s*`
// overlap on the same run (ReDoS-safe, matches the Python atomic group exactly
// on the full dialect + NO-MATCH boundary set).
const PAUSE_RE = /\[\s*pause(?:\s+(\d+(?:\.\d+)?)(?:\s*(ms|s))?)?\s*\]/gi;

function _pauseMs(num, unit) {
  if (num == null) return PAUSE_DEFAULT_MS;
  const value = parseFloat(num);
  if (!Number.isFinite(value)) return PAUSE_DEFAULT_MS;
  const ms = unit && unit.toLowerCase() === 's' ? value * 1000 : value;
  const msInt = roundHalfToEven(ms);
  return Math.max(0, Math.min(msInt, PAUSE_MAX_MS));
}

/** Mirror of text.py:parse_pause_markers → [[spanText, pauseMsAfter], …]. */
function parsePauseMarkers(text) {
  if (!text || text.indexOf('[') === -1) return [[text, 0]];
  const segments = [];
  let last = 0;
  let pendingText = '';
  const re = new RegExp(PAUSE_RE.source, PAUSE_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    pendingText += text.slice(last, m.index);
    last = re.lastIndex;
    const pause = _pauseMs(m[1] != null ? m[1] : null, m[2] != null ? m[2] : null);
    if (pendingText === '' && segments.length) {
      const [prevText, prevPause] = segments[segments.length - 1];
      segments[segments.length - 1] = [prevText, Math.min(prevPause + pause, PAUSE_MAX_MS)];
    } else {
      segments.push([pendingText, pause]);
    }
    pendingText = '';
    if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-width
  }
  const tail = pendingText + text.slice(last);
  if (tail || !segments.length) segments.push([tail, 0]);
  return segments;
}

/**
 * Mirror of _voice_runs: split `body` at its [voice:NAME] tags, starting in
 * `voice` → [[[voiceId, runText], …], the voice in effect at its end].
 */
function parseVoiceRuns(body, defaultVoice, voice = defaultVoice) {
  const runs = [];
  let curVoice = voice;
  let last = 0;
  const re = new RegExp(VOICE_RE.source, VOICE_RE.flags);
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) runs.push([curVoice, body.slice(last, m.index)]);
    const id = (m[1] || '').trim();
    curVoice = id || defaultVoice;
    last = re.lastIndex;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  runs.push([curVoice, body.slice(last)]);
  return [runs, curVoice];
}

// A blank line (paragraph break) — mirrors _BLANK_LINE_RE in longform_parser.py.
const BLANK_LINE_RE = /\n[ \t\r]*\n/;

// [image: NAME] (mirrors _IMAGE_RE): a picture from where it stands; display
// only, taken out of the text before anything else reads it.
const IMAGE_RE = /\[image:([^\][\n]*)\]/gi;
// `auto` (no word given): fill when the shapes are close, else whole (py parity).
export const IMAGE_FITS = ['auto', 'cover', 'contain'];
export const IMAGE_NONE = 'none';

/** Characters (code points, as Python counts them) in `text`. */
function codePoints(text) {
  return Array.from(text).length;
}

/** Mirror of _image_mark: the picture an [image: …] tag names. */
function imageMark(content) {
  const parts = content.trim().split(/\s+/).filter(Boolean);
  const name = parts.length ? parts[0].toLowerCase() : '';
  const fit = parts.length > 1 ? parts[1].toLowerCase() : '';
  return {
    name: name === '' || name === IMAGE_NONE ? null : Array.from(name).slice(0, 120).join(''),
    fit: IMAGE_FITS.includes(fit) ? fit : IMAGE_FITS[0],
  };
}

/**
 * Mirror of extract_image_marks → [text without its [image:] tags, marks].
 * A mark's `pos` is where the tag stood in the returned text (UTF-16 here;
 * only the `at` given to a span is counted in code points, as Python does).
 */
export function extractImageMarks(text) {
  if (!text || text.indexOf('[') === -1) return [text || '', []];
  const marks = [];
  let pos = 0;
  for (;;) {
    const re = new RegExp(IMAGE_RE.source, IMAGE_RE.flags);
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    const s = m.index;
    const e = s + m[0].length;
    const lineStart = text.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = text.indexOf('\n', e);
    if (lineEnd < 0) lineEnd = text.length;
    const blank = (piece) => /^[ \t]*$/.test(piece);
    let cut;
    let at;
    if (blank(text.slice(lineStart, s)) && blank(text.slice(e, lineEnd))) {
      if (lineEnd < text.length) [cut, at] = [[lineStart, lineEnd + 1], lineStart];
      else if (lineStart > 0) [cut, at] = [[lineStart - 1, lineEnd], lineStart - 1];
      else [cut, at] = [[lineStart, lineEnd], lineStart];
    } else {
      if (e < text.length && (text[e] === ' ' || text[e] === '\t')) cut = [s, e + 1];
      else if (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) cut = [s - 1, e];
      else cut = [s, e];
      at = cut[0];
    }
    const removed = cut[1] - cut[0];
    // Only the last marks can stand past the cut (py parity: linear).
    for (let i = marks.length - 1; i >= 0 && marks[i].pos > cut[0]; i--) {
      marks[i].pos = Math.max(cut[0], marks[i].pos - removed);
    }
    marks.push({ pos: at, ...imageMark(m[1]) });
    text = text.slice(0, cut[0]) + text.slice(cut[1]);
    pos = cut[0];
  }
  return [text, marks];
}

/**
 * Mirror of _attach_image_marks: give each mark (`pos` in `body`) to the span
 * read there as `images: [{ at, name, fit }]`, `at` in code points. Returns
 * the marks after every span.
 */
export function attachImageMarks(body, spans, marks) {
  const located = [];
  let cursor = 0;
  for (const span of spans) {
    const found = span.text ? body.indexOf(span.text, cursor) : -1;
    if (found < 0) {
      located.push(null);
      continue;
    }
    located.push([found, found + span.text.length]);
    cursor = found + span.text.length;
  }
  let last = null;
  located.forEach((loc, k) => {
    if (loc) last = k;
  });
  const left = [];
  let k = 0; // marks come in order: one walk over the spans serves them all
  for (const mark of marks) {
    const pos = mark.pos;
    let target = null;
    while (k < located.length) {
      const loc = located[k];
      if (!loc || loc[1] < pos || (loc[1] === pos && !('section' in spans[k]))) {
        k++;
        continue;
      }
      target = [k, loc[1] === pos ? 0 : codePoints(body.slice(loc[0], Math.max(loc[0], pos)))];
      break;
    }
    if (!target) {
      if (last === null) {
        left.push(mark);
        continue;
      }
      target = [last, codePoints(spans[last].text)];
    }
    const span = spans[target[0]];
    (span.images || (span.images = [])).push({ at: target[1], name: mark.name, fit: mark.fit });
  }
  return left;
}

/** Mirror of _give_carried_images: marks left over go to the first span that speaks. */
export function giveCarriedImages(spans, carried) {
  const first = spans.find((span) => span.text);
  if (!first || !carried.length) return carried;
  first.images = [
    ...carried.map((m) => ({ at: 0, name: m.name, fit: m.fit })),
    ...(first.images || []),
  ];
  return [];
}

/**
 * Voice→pause→SSML layering for ONE chapter body (no chapter split). The
 * storyToSpans adapter calls this per spoken track. Mirrors Python
 * _parse_chapter_body: [image:] tags are taken out first and given to the
 * spans read where they stood.
 */
export function parseChapterBody(body, { defaultVoice = null, defaultSpeed = null } = {}) {
  const [clean, marks] = extractImageMarks(body || '');
  const spans = runsToSpans(parseVoiceRuns(clean, defaultVoice)[0], defaultSpeed);
  if (marks.length) attachImageMarks(clean, spans, marks);
  return spans;
}

/** Mirror of _runs_to_spans: pause→SSML layering of voice runs into spans. */
function runsToSpans(runs, defaultSpeed) {
  const spans = [];
  for (const [voice, runText] of runs) {
    for (const [spanText, pauseMs] of parsePauseMarkers(runText)) {
      const t = (spanText || '').trim();
      if (!t && pauseMs === 0) continue;
      // [text, speed, paragraphBreakBefore, gainDb]. The whitespace BETWEEN two
      // kept segments is tracked so a blank line sitting on a markup boundary
      // still ends the line instead of being swallowed (py parity).
      const rendered = [];
      let between = '';
      for (const seg of t ? parseSsmlLite(t) : []) {
        const raw = seg.text;
        const st = (seg.spell ? spellOut(raw) : raw).trim();
        if (!st) {
          between += raw;
          continue;
        }
        const sp = seg.speed != null ? seg.speed : defaultSpeed;
        const lead = raw.slice(0, raw.length - raw.trimStart().length);
        rendered.push([st, sp, BLANK_LINE_RE.test(between + lead), seg.gain_db]);
        between = raw.slice(raw.trimEnd().length);
      }
      if (!rendered.length) {
        if (pauseMs > 0) {
          spans.push({ voice_id: voice, text: '', pause_ms_after: pauseMs, speed: null });
        }
        continue;
      }
      rendered.forEach(([st, sp, , gain], j) => {
        const span = {
          voice_id: voice,
          text: st,
          pause_ms_after: j === rendered.length - 1 ? pauseMs : 0,
          speed: sp,
        };
        // A [volume] passage's gain in dB; key present only there (py parity).
        if (gain) span.gain_db = gain;
        // Inline markup split one run of text: say how this span joins the next —
        // straight on, or across a blank line. Key present only here (py parity).
        if (j < rendered.length - 1) span.join = rendered[j + 1][2] ? 'paragraph' : 'continue';
        spans.push(span);
      });
    }
  }
  return spans;
}

/**
 * Mirror of _open_delivery: the delivery tags still open where `text` ends,
 * written out to open them again. Only the stretch after the last voice switch
 * or pause counts: delivery never runs past either.
 */
function openDelivery(text) {
  const [runs] = parseVoiceRuns(text, null, null);
  const pauses = parsePauseMarkers(runs[runs.length - 1][1]);
  const [stretch, pauseMs] = pauses[pauses.length - 1];
  if (pauseMs) return '';
  return openSsmlTags(stretch)
    .map((name) => `[${name}]`)
    .join('');
}

/**
 * Mirror of _parse_sectioned_body: one Audiobook chapter body with its
 * `##`/`###` section headings. A heading line is parsed like any other text,
 * without its marks; the first of its spans that speaks carries `section`
 * (the title as written) and `section_level`, and it is a paragraph of its own
 * (`join: 'paragraph'` on the span before it and on its last span). The voice
 * runs on across it, and so does a delivery tag open around it.
 */
function parseSectionedBody(body, { defaultVoice = null, defaultSpeed = null } = {}) {
  const spans = [];
  let voice = defaultVoice;
  let pending = null;
  const breaks = new Set();
  let carry = '';
  const add = (piece, heading = null) => {
    const text = carry + piece;
    carry = openDelivery(text);
    const [runs, next] = parseVoiceRuns(text, defaultVoice, voice);
    voice = next;
    const block = runsToSpans(runs, defaultSpeed);
    if (heading) {
      if (spans.length) breaks.add(spans.length - 1);
      pending = heading;
    }
    for (const span of block) {
      if (pending && span.text) {
        span.section = pending[0];
        span.section_level = pending[1];
        pending = null;
      }
      spans.push(span);
    }
    if (heading && block.length) breaks.add(spans.length - 1);
  };
  const re = new RegExp(SECTION_RE.source, SECTION_RE.flags);
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    add(body.slice(last, m.index));
    add(m[2], [m[2].trim(), m[1].length]);
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  add(body.slice(last));
  for (const i of [...breaks].sort((a, b) => a - b)) {
    const span = spans[i];
    if (i < spans.length - 1 && span.text && !span.pause_ms_after && !('join' in span))
      span.join = 'paragraph';
  }
  return spans;
}

/** Mirror of parse_script_to_spans → [{ title, spans:[{voice_id,text,pause_ms_after,speed}], untitled? }]. */
export function parseScriptToSpans(text, { defaultVoice = null, defaultSpeed = null } = {}) {
  if (!text) return [];
  const [norm, marks] = extractImageMarks(text.replace(/\r\n?/g, '\n'));

  const matches = [];
  const re = new RegExp(HEADING_RE.source, HEADING_RE.flags);
  let m;
  while ((m = re.exec(norm)) !== null) {
    matches.push({ index: m.index, end: m.index + m[0].length, title: m[1] });
    if (re.lastIndex === m.index) re.lastIndex++;
  }

  // [title, body, where the body starts, where the text the chapter owns
  // starts: its heading line, so a tag there opens it] (py parity).
  const raw = [];
  if (!matches.length) {
    raw.push([null, norm, 0, 0]);
  } else {
    const intro = norm.slice(0, matches[0].index);
    if (intro.trim()) raw.push([null, intro, 0, 0]);
    for (let i = 0; i < matches.length; i++) {
      const end = i + 1 < matches.length ? matches[i + 1].index : norm.length;
      raw.push([
        matches[i].title.trim(),
        norm.slice(matches[i].end, end),
        matches[i].end,
        raw.length ? matches[i].index : 0,
      ]);
    }
  }

  const chapters = [];
  let carried = [];
  raw.forEach(([title, body, offset, owns], n) => {
    const spans = parseSectionedBody(body, { defaultVoice, defaultSpeed });
    if (marks.length) {
      const limit = n + 1 < raw.length ? raw[n + 1][3] : norm.length + 1;
      const mine = marks
        .filter((m) => owns <= m.pos && m.pos < limit)
        .map((m) => ({ ...m, pos: Math.max(0, m.pos - offset) }));
      carried = giveCarriedImages(spans, carried);
      carried = carried.concat(attachImageMarks(body, spans, mine));
    }
    if (!spans.length) return;
    // An untitled body keeps the English "Chapter N" of the file's chapter
    // marks, flagged so a reader can name it in its own language (py parity).
    const chapter = { title: title || `Chapter ${chapters.length + 1}`, spans };
    if (!title) chapter.untitled = true;
    chapters.push(chapter);
  });
  return chapters;
}
