import { expect, it } from 'vitest';
import { generateBlocker, generateBlockers } from './generate-blocker';

const ready = {
  mode: 'stories' as const,
  busyElsewhere: false,
  importing: false,
  tts: null,
  usable: true,
  voicesReady: true,
  duplicateLexicon: false,
};

it('is null only when everything Generate needs is in place', () => {
  expect(generateBlocker(ready)).toBeNull();
});

it('names the most fundamental reason first', () => {
  expect(generateBlocker({ ...ready, usable: false, voicesReady: false })).toBe('no_lines');
  expect(generateBlocker({ ...ready, mode: 'audiobook', usable: false })).toBe('no_script');
  expect(generateBlocker({ ...ready, voicesReady: false })).toBe('voice');
  expect(generateBlocker({ ...ready, tts: 'engine', voicesReady: false })).toBe('engine');
  expect(generateBlocker({ ...ready, tts: 'loading' })).toBe('engine_loading');
  expect(generateBlocker({ ...ready, importing: true, tts: 'engine' })).toBe('importing');
  expect(generateBlocker({ ...ready, busyElsewhere: true, importing: true })).toBe('busy');
});

it('waits for a preview that renders, which holds the GPU until it ends or is stopped', () => {
  expect(generateBlocker({ ...ready, previewing: true })).toBe('previewing');
  expect(generateBlocker({ ...ready, previewing: true, tts: 'loading' })).toBe('previewing');
  expect(generateBlocker({ ...ready, previewing: true, importing: true })).toBe('importing');
});

it('a duplicated pronunciation word only blocks the audiobook', () => {
  expect(generateBlocker({ ...ready, duplicateLexicon: true })).toBeNull();
  expect(generateBlocker({ ...ready, mode: 'audiobook', duplicateLexicon: true })).toBe('lexicon');
});

it('says which voice is missing instead of a generic voice hint', () => {
  const book = { ...ready, mode: 'audiobook' as const, voicesReady: false };
  expect(generateBlocker({ ...book, defaultVoiceReady: false, castReady: false })).toBe(
    'default_voice',
  );
  expect(generateBlocker({ ...book, defaultVoiceReady: true, castReady: false })).toBe(
    'cast_voice',
  );
  // Stories lines can each carry a voice, so no default is required there.
  expect(generateBlocker({ ...ready, voicesReady: false, defaultVoiceReady: false })).toBe('voice');
  expect(generateBlocker({ ...ready, voicesReady: false, castReady: false })).toBe('cast_voice');
});

it('lists every gap the user can fix at once, most fundamental first', () => {
  expect(generateBlockers(ready)).toEqual([]);
  // A first run: no engine, no script and no narrator are all said at once.
  expect(
    generateBlockers({
      ...ready,
      mode: 'audiobook',
      tts: 'engine',
      usable: false,
      voicesReady: false,
      defaultVoiceReady: false,
      castReady: true,
    }),
  ).toEqual(['engine', 'no_script', 'default_voice']);
  expect(
    generateBlockers({
      ...ready,
      mode: 'audiobook',
      voicesReady: false,
      defaultVoiceReady: false,
      castReady: false,
      duplicateLexicon: true,
    }),
  ).toEqual(['default_voice', 'cast_voice', 'lexicon']);
  // With no lines there is nothing to voice yet: only the lines are missing.
  expect(generateBlockers({ ...ready, usable: false, voicesReady: false })).toEqual(['no_lines']);
  expect(generateBlockers({ ...ready, tts: 'loading', voicesReady: false })).toEqual([
    'engine_loading',
    'voice',
  ]);
});

it('gives a wait as the only reason while it lasts', () => {
  const broken = { ...ready, tts: 'engine' as const, usable: false, voicesReady: false };
  expect(generateBlockers({ ...broken, busyElsewhere: true })).toEqual(['busy']);
  expect(generateBlockers({ ...broken, importing: true })).toEqual(['importing']);
  expect(generateBlockers({ ...broken, previewing: true })).toEqual(['previewing']);
});
