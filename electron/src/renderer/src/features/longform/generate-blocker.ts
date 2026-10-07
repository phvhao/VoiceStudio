export type GenerateBlocker =
  | 'busy'
  | 'importing'
  | 'previewing'
  | 'engine_loading'
  | 'engine'
  | 'no_lines'
  | 'no_script'
  | 'voice'
  | 'default_voice'
  | 'cast_voice'
  | 'lexicon';

export interface GenerateInput {
  mode: 'stories' | 'audiobook';
  /** The OTHER longform mode is rendering; one render runs at a time. */
  busyElsewhere: boolean;
  importing: boolean;
  /** A preview renders: it holds the GPU until it finishes or is stopped. */
  previewing?: boolean;
  tts: 'engine' | 'loading' | null;
  usable: boolean;
  voicesReady: boolean;
  /** The book-wide default voice is a profile that exists (Audiobook needs one). */
  defaultVoiceReady?: boolean;
  /** Every [voice:NAME] cast mapping points at a profile that still exists. */
  castReady?: boolean;
  duplicateLexicon: boolean;
}

/**
 * Every reason Generate is unavailable right now, most fundamental first, or
 * none when it can run. A greyed-out button with no explanation is a dead end:
 * the commonest case (lines with no voice and no default voice) looks exactly
 * like a broken app.
 *
 * A wait — the other mode rendering, an import, a preview — is the only reason
 * while it lasts: nothing starts before it ends, and an import is about to
 * replace the script anyway. Past it, every gap the user can fix is listed.
 */
export function generateBlockers(input: GenerateInput): GenerateBlocker[] {
  if (input.busyElsewhere) return ['busy'];
  if (input.importing) return ['importing'];
  if (input.previewing) return ['previewing'];
  const missing: GenerateBlocker[] = [];
  if (input.tts === 'loading') missing.push('engine_loading');
  if (input.tts === 'engine') missing.push('engine');
  if (!input.usable) missing.push(input.mode === 'stories' ? 'no_lines' : 'no_script');
  // Name the voice that is actually missing: "give every line a voice" is
  // advice for Stories, and an Audiobook always needs its default narrator.
  if (input.mode === 'audiobook' && input.defaultVoiceReady === false)
    missing.push('default_voice');
  if (input.castReady === false) missing.push('cast_voice');
  // Lines without a voice: already named above, and moot while there are no
  // lines to voice (Stories counts no lines as no voices).
  if (
    !input.voicesReady &&
    !missing.includes('default_voice') &&
    !missing.includes('cast_voice') &&
    (input.usable || input.mode === 'audiobook')
  )
    missing.push('voice');
  if (input.mode === 'audiobook' && input.duplicateLexicon) missing.push('lexicon');
  return missing;
}

/** The most fundamental reason Generate is unavailable, or null when it can run. */
export function generateBlocker(input: GenerateInput): GenerateBlocker | null {
  return generateBlockers(input)[0] ?? null;
}
