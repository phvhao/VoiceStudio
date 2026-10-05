import { isDefaultVoiceName } from './audiobookScript';

/**
 * Silence (ms) after each punctuation family when text is read sentence by
 * sentence. Mirrors backend/services/chunked_tts.py DEFAULT_PUNCTUATION_PAUSES
 * (tests/test_phrase_rendering.py holds the two equal).
 */
export const DEFAULT_PUNCTUATION_PAUSES = {
  sentence: 300,
  ellipsis: 500,
  semicolon: 250,
  colon: 250,
  dash: 200,
  comma: 120,
};
export const PUNCTUATION_FAMILIES = Object.keys(DEFAULT_PUNCTUATION_PAUSES);
export const MAX_PUNCTUATION_PAUSE_MS = 5000;

export const DEFAULT_OVERRIDES = {
  numStep: null,
  guidanceScale: null,
  posTemp: null,
  classTemp: null,
  postprocess: null,
  seed: null,
  varyRepeats: false,
  emoText: '',
  emoAlpha: null,
  // Seamless joins: null = the server default (zero gaps / trim off, preserving legacy renders).
  lineGapMs: null,
  paragraphGapMs: null,
  trimEdges: null,
  // Reading (sentence by sentence, punctuation pauses, speech check): null
  // follows Settings → Reading; an object is this project's own choice.
  reading: null,
  // Bring every voice of a chapter to one loudness. On unless turned off:
  // overrides saved before this field existed read as on too.
  levelVoices: true,
};

/** Largest cut or boost of one voice's own volume, in dB (the server clamps the same). */
export const MAX_VOICE_GAIN_DB = 12;

/**
 * The key a voice's volume is stored and sent under: its `[voice:NAME]` name,
 * or `''` for the book's default voice. `[voice:]` and `[voice:default]` (any
 * case) read in the default voice — the app never casts that name — and the
 * server levels them by the same rule (backend/services/voice_leveling.py
 * span_voice_name).
 */
export function voiceGainKey(name) {
  return isDefaultVoiceName(name) ? '' : name.trim();
}

/** A volume in dB as stored: within ±MAX_VOICE_GAIN_DB; anything that is not a finite number is 0. */
export function clampVoiceGain(db) {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return Math.max(-MAX_VOICE_GAIN_DB, Math.min(MAX_VOICE_GAIN_DB, db));
}

/** The volume stored for `key`, 0 dB when there is none. */
export function voiceGain(gains, key) {
  return gains && Object.hasOwn(gains, key) ? clampVoiceGain(gains[key]) : 0;
}

/** `gains` with `key` set to `db`; 0 dB removes the key, so untouched voices stay absent. */
export function setVoiceGain(gains, key, db) {
  const value = clampVoiceGain(db);
  return Object.fromEntries([
    ...Object.entries(gains || {}).filter(([name]) => name !== key),
    ...(value ? [[key, value]] : []),
  ]);
}

/** Volumes as persisted → the valid ones (drafts saved before volumes existed have none). */
export function restoreVoiceGains(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.keys(value).flatMap((key) => {
      const db = voiceGain(value, key);
      return db ? [[key, db]] : [];
    }),
  );
}

/**
 * The request's `voice_gains` for the voices `keys` names (zero volumes left
 * out), or `undefined` when none is set — an untouched book sends nothing.
 */
export function voiceGainsToRequest(gains, keys) {
  const body = Object.fromEntries(
    [...new Set(keys)].flatMap((key) => {
      const db = voiceGain(gains, key);
      return db ? [[key, db]] : [];
    }),
  );
  return Object.keys(body).length ? body : undefined;
}

/**
 * Reading settings in their default state. `phraseRendering`: every sentence
 * and clause is its own take, so the engine cannot drop, repeat or swap the
 * clauses of a long one. `punctuationPauses` holds per-family changes only (a
 * missing family uses its default). `verifySpeech`: listen back with the
 * installed speech recognizer and retake mismatches.
 */
export const DEFAULT_READING = {
  phraseRendering: true,
  punctuationPauses: {},
  splitCommas: false,
  verifySpeech: false,
};

/** Effective per-family pauses: defaults overlaid with valid user values. */
export function punctuationPauses(reading) {
  const chosen = (reading && reading.punctuationPauses) || {};
  const out = { ...DEFAULT_PUNCTUATION_PAUSES };
  for (const family of PUNCTUATION_FAMILIES) {
    const value = Number(chosen[family]);
    if (chosen[family] != null && Number.isFinite(value))
      out[family] = Math.round(Math.max(0, Math.min(value, MAX_PUNCTUATION_PAUSE_MS)));
  }
  return out;
}

/**
 * Reading settings as request fields. Every field is explicit, so they win
 * over Settings → Reading on the server; `punctuation_pauses: null` reads a
 * paragraph per take.
 */
export function readingToRequest(reading) {
  const r = { ...DEFAULT_READING, ...reading };
  return {
    punctuation_pauses: r.phraseRendering ? punctuationPauses(r) : null,
    split_commas: Boolean(r.phraseRendering && r.splitCommas),
    verify_speech: Boolean(r.verifySpeech),
  };
}

/** Settings → Reading as the server stores it → the editable shape. */
export function readingFromSettings(settings) {
  return {
    phraseRendering: settings.phrase_rendering !== false,
    punctuationPauses: { ...settings.punctuation_pauses },
    splitCommas: Boolean(settings.split_commas),
    verifySpeech: Boolean(settings.verify_speech),
  };
}

/**
 * Lower the persisted overrides (+ language) into the snake_case request fields
 * the backend expects. Only NON-default values are emitted, plus how to read
 * the text: the project's own reading settings, or `use_app_reading` to
 * follow Settings → Reading (API callers that send neither keep the old
 * render), and `level_voices` unless the project turned leveling off.
 * Shared by the full render and the per-chapter preview so both hit the same
 * cache slot.
 */
export function overridesToRequest(overrides, language) {
  const o = overrides || DEFAULT_OVERRIDES;
  const body = {};
  if (language && language !== 'Auto') body.language = language;
  if (o.numStep != null) body.num_step = o.numStep;
  if (o.guidanceScale != null) body.guidance_scale = o.guidanceScale;
  if (o.posTemp != null) body.position_temperature = o.posTemp;
  if (o.classTemp != null) body.class_temperature = o.classTemp;
  if (o.postprocess != null) body.postprocess_output = o.postprocess;
  if (o.seed != null) body.seed = o.seed;
  if (o.varyRepeats) body.vary_repeats = true;
  const emo = (o.emoText || '').trim();
  if (emo) {
    body.emo_text = emo;
    if (o.emoAlpha != null) body.emo_alpha = o.emoAlpha;
  }
  if (o.lineGapMs != null) body.line_gap_ms = o.lineGapMs;
  if (o.paragraphGapMs != null) body.paragraph_gap_ms = o.paragraphGapMs;
  if (o.trimEdges != null) body.trim_edges = o.trimEdges;
  if (o.reading) Object.assign(body, readingToRequest(o.reading));
  else body.use_app_reading = true;
  if (o.levelVoices !== false) body.level_voices = true;
  return body;
}
