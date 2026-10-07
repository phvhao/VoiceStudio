import i18next, { type TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en.json';
import vi from '@/i18n/locales/vi.json';
import {
  engineRoutingText,
  engineUnavailableText,
  providerUnavailableText,
  reasonText,
} from './engine-reasons';

let t: TFunction;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'vi',
    fallbackLng: 'en',
    resources: { en: { translation: en }, vi: { translation: vi } },
    interpolation: { escapeValue: false },
  });
  t = instance.t;
});

describe('reasonText', () => {
  it('shows the translation of a known code instead of the English sentence', () => {
    expect(
      reasonText(t, 'diarisation', 'pyannote_not_installed', 'Install the pyannote model bundle'),
    ).toBe(vi.engineReason.diarisation.pyannote_not_installed);
  });

  it('falls back to the backend sentence for a code this renderer does not know', () => {
    expect(reasonText(t, 'unavailable', 'added_by_a_newer_backend', 'Needs a reboot.')).toBe(
      'Needs a reboot.',
    );
  });

  it('never looks up a malformed code', () => {
    expect(reasonText(t, 'unavailable', 'modelSettings.unavailable', 'English')).toBe('English');
    expect(reasonText(t, 'unavailable', '', 'English')).toBe('English');
  });

  it('keeps an older backend without codes on its sentence, and nothing on nothing', () => {
    expect(reasonText(t, 'routing', undefined, '  CPU only.  ')).toBe('CPU only.');
    expect(reasonText(t, 'routing', null, null)).toBeUndefined();
  });

  it('reads every field family the backend codes', () => {
    expect(engineUnavailableText(t, { reason: 'x', reason_code: 'not_installed' })).toBe(
      vi.engineReason.unavailable.not_installed,
    );
    expect(engineRoutingText(t, { routing_reason: 'x', routing_reason_code: 'cpu_fallback' })).toBe(
      vi.engineReason.routing.cpu_fallback,
    );
    expect(
      providerUnavailableText(t, {
        availability_reason: 'x',
        availability_reason_code: 'needs_config',
      }),
    ).toBe(vi.engineReason.unavailable.needs_config);
    expect(engineUnavailableText(t, undefined)).toBeUndefined();
  });
});
