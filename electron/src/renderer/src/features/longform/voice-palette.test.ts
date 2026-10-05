import { expect, it } from 'vitest';
import { DEFAULT_VOICE_ACCENT, VOICE_ACCENTS, voiceAccent } from './voice-palette';

it('colors voices by where their name first appears, the default voice neutrally', () => {
  const names = ['Mara', 'Ben'];
  expect(voiceAccent('Mara', names)).toBe(VOICE_ACCENTS[0]);
  expect(voiceAccent('Ben', names)).toBe(VOICE_ACCENTS[1]);
  expect(voiceAccent(null, names)).toBe(DEFAULT_VOICE_ACCENT);
  expect(voiceAccent('Nobody', names)).toBe(DEFAULT_VOICE_ACCENT);
});

it('repeats the palette past eight voices', () => {
  const names = Array.from({ length: 10 }, (_, index) => `Voice ${index}`);
  expect(voiceAccent('Voice 8', names)).toBe(VOICE_ACCENTS[0]);
  expect(voiceAccent('Voice 9', names)).toBe(VOICE_ACCENTS[1]);
});

it('keeps the hue order Stories characters have always had', () => {
  expect(VOICE_ACCENTS.map((accent) => accent.border)).toEqual([
    'border-l-sky-400',
    'border-l-amber-400',
    'border-l-emerald-400',
    'border-l-fuchsia-400',
    'border-l-orange-400',
    'border-l-teal-400',
    'border-l-rose-400',
    'border-l-indigo-400',
  ]);
  for (const accent of VOICE_ACCENTS) {
    const hue = /border-l-(\w+)-400/.exec(accent.border)![1];
    for (const classes of [accent.dot, accent.chip, accent.lane, accent.text])
      expect(classes, hue).toContain(`-${hue}-`);
  }
});
