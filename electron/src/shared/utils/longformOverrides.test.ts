import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERRIDES,
  MAX_VOICE_GAIN_DB,
  clampVoiceGain,
  overridesToRequest,
  restoreVoiceGains,
  setVoiceGain,
  voiceGain,
  voiceGainKey,
  voiceGainsToRequest,
} from './longformOverrides';

describe('voice leveling request', () => {
  it('levels by default, including overrides saved before the field existed', () => {
    expect(DEFAULT_OVERRIDES.levelVoices).toBe(true);
    const { levelVoices: _, ...legacy } = DEFAULT_OVERRIDES;
    expect(overridesToRequest(legacy as typeof DEFAULT_OVERRIDES, 'Auto')).toHaveProperty(
      'level_voices',
      true,
    );
    expect(
      overridesToRequest({ ...DEFAULT_OVERRIDES, levelVoices: false }, 'Auto'),
    ).not.toHaveProperty('level_voices');
  });
});

describe('voice volumes', () => {
  it('keys the default voice and [voice:default] as one voice unless the cast names it', () => {
    expect(voiceGainKey('', {})).toBe('');
    expect(voiceGainKey(' Mara ', {})).toBe('Mara');
    expect(voiceGainKey('default', { Mara: 'p1' })).toBe('');
    expect(voiceGainKey('default', { default: 'p2' })).toBe('default');
  });

  it('clamps volumes to ±12 dB and drops voices set back to 0 dB', () => {
    expect(clampVoiceGain(30)).toBe(MAX_VOICE_GAIN_DB);
    expect(clampVoiceGain(-30)).toBe(-MAX_VOICE_GAIN_DB);
    expect(clampVoiceGain(Number.NaN)).toBe(0);
    expect(clampVoiceGain('3')).toBe(0);
    const gains = setVoiceGain({ Mara: 2 }, '', -4);
    expect(gains).toEqual({ Mara: 2, '': -4 });
    expect(setVoiceGain(gains, 'Mara', 0)).toEqual({ '': -4 });
    expect(setVoiceGain(null, 'Cole', 99)).toEqual({ Cole: 12 });
    // A name that is also an Object.prototype key is an ordinary voice.
    const odd = setVoiceGain({}, '__proto__', 5);
    expect(voiceGain(odd, '__proto__')).toBe(5);
    expect(voiceGain(odd, 'toString')).toBe(0);
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
  });

  it('restores persisted volumes, keeping only valid ones', () => {
    expect(restoreVoiceGains(undefined)).toEqual({});
    expect(restoreVoiceGains([3])).toEqual({});
    expect(restoreVoiceGains({ Mara: 3, '': 'loud', Cole: 99, Ann: null, Bo: 0 })).toEqual({
      Mara: 3,
      Cole: 12,
    });
  });

  it('sends only the voices asked for, and nothing when none has a volume', () => {
    const gains = { '': -2, Mara: 3, Removed: 6 };
    expect(voiceGainsToRequest(gains, ['', 'Mara', 'Mara', 'Cole'])).toEqual({ '': -2, Mara: 3 });
    expect(voiceGainsToRequest(gains, ['Cole'])).toBeUndefined();
    expect(voiceGainsToRequest({}, [''])).toBeUndefined();
  });
});
