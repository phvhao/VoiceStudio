import { describe, it, expect } from 'vitest';
import {
  isDefaultVoiceName,
  parseCastNames,
  scriptStats,
  formatRuntimeClock,
  validateScript,
  AUDIOBOOK_WPM,
} from '../utils/audiobookScript';

describe('parseCastNames', () => {
  it('returns distinct [voice:NAME] names in first-seen order', () => {
    const script =
      '# One\n[voice:Narrator] hi [voice:Mara] hey [voice:Narrator] again [voice:Cole] yo';
    expect(parseCastNames(script)).toEqual(['Narrator', 'Mara', 'Cole']);
  });
  it('skips the empty [voice:] reset and trims names', () => {
    expect(parseCastNames('[voice:] plain [voice: Mara ] x')).toEqual(['Mara']);
  });
  it('skips [voice:default] in any case: it is the default voice, not a name to cast', () => {
    const script = '[voice:Mara] a [voice:default] b [voice: Default ] c [voice:DEFAULT] d';
    expect(parseCastNames(script)).toEqual(['Mara']);
    expect(['', ' ', 'default', ' Default ', 'DEFAULT', null].every(isDefaultVoiceName)).toBe(true);
    expect(isDefaultVoiceName('Defaults')).toBe(false);
  });
  it('keeps a `default` name a saved cast already gives a voice', () => {
    const script = '[voice:Default] a [voice:default] b [voice:] c';
    expect(parseCastNames(script, { Default: 'p1' })).toEqual(['Default']);
    expect(parseCastNames(script, { Default: '' })).toEqual([]);
    expect(parseCastNames(script, { '': 'p1' })).toEqual([]);
  });
  it('is empty for a script with no voice tags', () => {
    expect(parseCastNames('# Chapter\nJust narration.')).toEqual([]);
    expect(parseCastNames('')).toEqual([]);
  });
});

describe('scriptStats', () => {
  it('counts H1 chapters, spoken words (markup stripped), and runtime', () => {
    const script =
      '# One\n[voice:Mara] Hello world here. [pause 500ms]\n# Two\nFour more spoken words.';
    const { chapters, words, runtimeSec } = scriptStats(script);
    expect(chapters).toBe(2);
    // "Hello world here" (3) + "Four more spoken words" (4) = 7 — markup excluded.
    expect(words).toBe(7);
    expect(runtimeSec).toBeCloseTo((7 / AUDIOBOOK_WPM) * 60, 5);
  });
  it('treats a title-less script as one chapter', () => {
    expect(scriptStats('just some words').chapters).toBe(1);
  });
  it('counts a section title as spoken words, not its marks or a chapter', () => {
    const { chapters, words } = scriptStats('# One\n## Part two\nBody.\n  ### Deep\n#### four');
    expect(chapters).toBe(1);
    // "Part two" (2) + "Body." + "Deep" + "#### four" (2): `####` stays text.
    expect(words).toBe(6);
  });
  it('counts the words of scripts written without spaces', () => {
    // 今天/天气/很/好 · 我们/去/公园/散步/吧
    const chinese = scriptStats('# 第一章\n今天天气很好。我们去公园散步吧。');
    expect(chinese.words).toBeGreaterThanOrEqual(8);
    expect(formatRuntimeClock(chinese.runtimeSec)).not.toBe('0:00');
    expect(scriptStats('今日は天気がいいです。').words).toBeGreaterThanOrEqual(4);
    expect(scriptStats('วันนี้อากาศดีมาก เราไปเดินเล่นกัน').words).toBeGreaterThanOrEqual(6);
    // Spaced scripts still count their runs; a mixed run counts each word.
    expect(scriptStats('Xin chào các bạn').words).toBe(4);
    expect(scriptStats('Say 你好 now').words).toBe(3);
  });
});

describe('formatRuntimeClock', () => {
  it('formats <1h as M:SS and ≥1h as H:MM', () => {
    expect(formatRuntimeClock(45)).toBe('0:45');
    expect(formatRuntimeClock(125)).toBe('2:05');
    expect(formatRuntimeClock(3720)).toBe('1:02');
  });
});

describe('validateScript', () => {
  it('flags an unknown voice and clears once it is mapped', () => {
    const script = '# One\n[voice:Mara] hello there';
    const unmapped = validateScript(script, { mappedNames: [], profileIds: [] });
    expect(unmapped).toEqual([{ type: 'unknown_voice', name: 'Mara' }]);
    // Mapping Mara clears the warning…
    expect(validateScript(script, { mappedNames: ['Mara'], profileIds: [] })).toEqual([]);
    // …and an exact profile-id match also clears it.
    expect(validateScript(script, { mappedNames: [], profileIds: ['Mara'] })).toEqual([]);
  });
  it('never calls the default voice an unknown voice', () => {
    expect(validateScript('[voice:default] hi [voice:Default] there [voice:] again', {})).toEqual(
      [],
    );
  });
  it('flags empty chapters and unrecognized tags', () => {
    const script = '# Empty\n\n# Full\nSome [wobble] words [pause 1s] and [slow]slow[/slow].';
    const warns = validateScript(script, {});
    expect(warns).toContainEqual({ type: 'empty_chapter', title: 'Empty' });
    expect(warns).toContainEqual({ type: 'unknown_tag', tag: '[wobble]' });
    // Known grammar (pause / SSML / voice / reactions) must NOT warn.
    expect(warns.some((w) => w.type === 'unknown_tag' && w.tag !== '[wobble]')).toBe(false);
  });
  it('does not flag known reaction tags', () => {
    const warns = validateScript('# C\nHa [laughter] ha.', {});
    expect(warns.filter((w) => w.type === 'unknown_tag')).toEqual([]);
  });
  it('reads [[word|respelling]] overrides as speech, not as unknown tags', () => {
    const script = '# Only respellings\n[[gif|jiff]] [[Nuh-VAD-uh]]\n# C\nA [huh] [[x|y]].';
    const warns = validateScript(script, {});
    expect(warns).toEqual([{ type: 'unknown_tag', tag: '[huh]' }]);
    expect(scriptStats('Open the [[gif|jiff file]] now.').words).toBe(5);
  });
});
