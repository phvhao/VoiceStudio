export type PunctuationFamily = 'sentence' | 'ellipsis' | 'semicolon' | 'colon' | 'dash' | 'comma';
export const DEFAULT_PUNCTUATION_PAUSES: Record<PunctuationFamily, number>;
export const PUNCTUATION_FAMILIES: PunctuationFamily[];
export const MAX_PUNCTUATION_PAUSE_MS: number;
export interface Overrides {
  numStep: number | null;
  guidanceScale: number | null;
  posTemp: number | null;
  classTemp: number | null;
  postprocess: boolean | null;
  seed: number | null;
  varyRepeats: boolean;
  emoText: string;
  emoAlpha: number | null;
  lineGapMs: number | null;
  paragraphGapMs: number | null;
  trimEdges: boolean | null;
  /** null follows Settings → Reading. */
  reading: Reading | null;
  /** Bring every voice of a chapter to one loudness; only `false` turns it off. */
  levelVoices: boolean;
}
export interface Reading {
  phraseRendering: boolean;
  punctuationPauses: Partial<Record<PunctuationFamily, number>>;
  splitCommas: boolean;
  verifySpeech: boolean;
}
/** Settings → Reading as the server stores it. */
export interface ReadingSettingsBody {
  phrase_rendering: boolean;
  punctuation_pauses: Record<PunctuationFamily, number>;
  split_commas: boolean;
  verify_speech: boolean;
}
export const DEFAULT_READING: Reading;
export function punctuationPauses(
  reading: Pick<Reading, 'punctuationPauses'> | null,
): Record<PunctuationFamily, number>;
export function readingToRequest(reading: Reading | null): {
  punctuation_pauses: Record<PunctuationFamily, number> | null;
  split_commas: boolean;
  verify_speech: boolean;
};
export function readingFromSettings(settings: ReadingSettingsBody): Reading;
export const DEFAULT_OVERRIDES: Overrides;
/** dB of volume per voice: `[voice:NAME]` name → gain, `''` for the default voice. */
export type VoiceGains = Record<string, number>;
export const MAX_VOICE_GAIN_DB: number;
export function voiceGainKey(name: string): string;
export function clampVoiceGain(db: unknown): number;
export function voiceGain(gains: VoiceGains | null | undefined, key: string): number;
export function setVoiceGain(
  gains: VoiceGains | null | undefined,
  key: string,
  db: number,
): VoiceGains;
export function restoreVoiceGains(value: unknown): VoiceGains;
export function voiceGainsToRequest(
  gains: VoiceGains | null | undefined,
  keys: Iterable<string>,
): VoiceGains | undefined;
export function overridesToRequest(
  overrides: Overrides | null,
  language?: string,
): Record<string, string | number | boolean | Record<string, number> | null>;
