import { expect, it } from 'vitest';
import {
  cachedTtsLanguagesSupported,
  languageCode,
  languageOptions,
  languageSupported,
} from './language-options';
import { QueryClient } from '@tanstack/react-query';
import { rankOptions } from '@shared/components/VirtualSearchableSelect';
import { COMPUTE_TARGET_QUERY_KEY } from '@/hooks/use-compute-target';
import { LANGUAGES } from './languages';

it('gives every canonical language a code without changing persisted values', () => {
  expect(LANGUAGES.filter((name) => name !== 'Auto' && !languageCode(name))).toEqual([]);
  expect(languageOptions(['German'], 'de', 'Auto')[0]).toMatchObject({
    value: 'German',
    code: 'de',
    label: 'Deutsch',
  });
});
it('searches native names, translated names, accents and codes locally', () => {
  const options = languageOptions(['German', 'French', 'Japanese'], 'en', 'Auto');
  expect(rankOptions(options, 'francais', [])[0]?.value).toBe('French');
  expect(rankOptions(options, 'DE', [])[0]?.value).toBe('German');
  expect(rankOptions(options, 'Deutsch', [])[0]?.value).toBe('German');
  expect(rankOptions(options, 'ger de', [])[0]?.value).toBe('German');
  expect(rankOptions(options, 'Germany', [])[0]?.value).toBe('German');
  expect(rankOptions(options, String.fromCodePoint(0x1f1e9, 0x1f1ea), [])[0]?.value).toBe('German');
});
it('does not infer support for regional variants, missing lists or a different model', () => {
  expect(languageSupported('German', ['german'])).toBe(true);
  expect(languageSupported('German', ['de'])).toBe(true);
  expect(languageSupported('German', ['english'])).toBe(false);
  expect(languageSupported('Chinese (Traditional)', ['chinese'])).toBe(false);
  expect(languageSupported('German', null)).toBe(true);
  expect(languageSupported('German', [])).toBe(false);
  expect(languageSupported('de', ['german'])).toBe(true);
});

it('matches the codes dub segments store regardless of case', () => {
  // Segment languages are the picker's codes; Chinese is spelled cmn-Hans / cmn-Hant.
  const omnivoice = ['chinese', 'chinese (simplified)', 'chinese (traditional)', 'kurdish'];
  expect(languageSupported('cmn-Hans', omnivoice)).toBe(true);
  expect(languageSupported('cmn-Hant', omnivoice)).toBe(true);
  expect(languageSupported('CMN-HANS', omnivoice)).toBe(true);
  expect(languageSupported('ku', omnivoice)).toBe(true);
  // A model that lists only "chinese" rejects the picker's script-specific names.
  expect(languageSupported('cmn-Hans', ['chinese', 'mandarin'])).toBe(false);
});

it('answers the same for a list it has already indexed', () => {
  const supported = ['english', 'japanese'];
  expect(languageSupported('Japanese', supported)).toBe(true);
  expect(languageSupported('German', supported)).toBe(false);
  expect(languageSupported('ja', supported)).toBe(true);
  expect(languageSupported('German', ['german'])).toBe(true);
});

it('blocks persisted incompatible local selections without guessing worker support', async () => {
  const client = new QueryClient();
  client.setQueryData(COMPUTE_TARGET_QUERY_KEY, { active: { remote: false } });
  client.setQueryData(['engines'], {
    tts: { active: 'kitten', backends: [{ id: 'kitten', supported_language_names: ['english'] }] },
  });
  expect(cachedTtsLanguagesSupported(client, 'clone', ['Japanese'])).toBe(false);
  expect(cachedTtsLanguagesSupported(client, 'clone', ['Auto'])).toBe(true);
  client.setQueryData(COMPUTE_TARGET_QUERY_KEY, { active: { remote: true } });
  expect(cachedTtsLanguagesSupported(client, 'clone', ['Japanese'])).toBe(true);
  client.setQueryData(COMPUTE_TARGET_QUERY_KEY, { active: { remote: false } });
  await client.invalidateQueries({ queryKey: ['engines'] });
  expect(cachedTtsLanguagesSupported(client, 'clone', ['Japanese'])).toBe(true);
  client.removeQueries({ queryKey: COMPUTE_TARGET_QUERY_KEY });
  expect(cachedTtsLanguagesSupported(client, 'clone', ['Japanese'])).toBe(true);
});
it('keeps disabled recent choices behind enabled choices and uses exact matches first', () => {
  const options = languageOptions(['German', 'French'], 'en', 'Auto').map((item) => ({
    ...item,
    disabled: item.value === 'German',
  }));
  expect(rankOptions(options, '', ['German']).map((item) => item.value)).toEqual([
    'French',
    'German',
  ]);
});
