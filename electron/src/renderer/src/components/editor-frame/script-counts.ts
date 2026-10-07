import { AUDIOBOOK_WPM, scriptStats } from '@shared/utils/audiobookScript';

export interface ScriptCounts {
  /** Characters as the backend counts them (code points). */
  chars: number;
  /** Spoken words: markup left out, unspaced scripts split at their word breaks. */
  words: number;
  /** Sentences, a line break ending one as it does when the script is read. */
  sentences: number;
  /** Estimated length read aloud, at `speed`. */
  seconds: number;
}

// `[[word|respelling]]` speaks its respelling; every other bracket tag is silent.
const OVERRIDE = /\[\[([^\]]{0,256})\]\]/g;
const TAG = /\[[^\][]*\]/g;
const SPOKEN = /[\p{L}\p{N}]/u;
// A sentence ends at . ! ? … and their full-width forms, or a line break.
const SENTENCE_END = /[.!?…。！？]+|\n/;

let sentenceSegmenter: Intl.Segmenter | null | undefined;

function spokenText(text: string): string {
  return text
    .replace(OVERRIDE, (_, inner: string) => inner.slice(inner.indexOf('|') + 1))
    .replace(TAG, ' ');
}

function countSentences(spoken: string): number {
  if (sentenceSegmenter === undefined)
    sentenceSegmenter =
      typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
        : null;
  let sentences = 0;
  if (sentenceSegmenter) {
    for (const { segment } of sentenceSegmenter.segment(spoken))
      if (SPOKEN.test(segment)) sentences++;
    return sentences;
  }
  for (const part of spoken.split(SENTENCE_END)) if (SPOKEN.test(part)) sentences++;
  return sentences;
}

/** The status line's counts for a Clone or Voice Design script. */
export function scriptCounts(text: string, speed = 1): ScriptCounts {
  let chars = 0;
  for (const _ of text) chars++;
  const { words } = scriptStats(text);
  const pace = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return {
    chars,
    words,
    sentences: words ? countSentences(spokenText(text)) : 0,
    seconds: words ? ((words / AUDIOBOOK_WPM) * 60) / pace : 0,
  };
}
