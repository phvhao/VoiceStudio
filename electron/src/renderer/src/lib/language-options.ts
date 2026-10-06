import languageCodes from '@shared/language-codes.json';
import languageRegions from '@shared/language-regions.json';
import { LANG_CODES } from '@shared/utils/languages';
import { normalizeSearch, type SearchOption } from '@shared/components/VirtualSearchableSelect';
import type { QueryClient } from '@tanstack/react-query';
import type { EnginesResponse } from './api/types';
import {
  COMPUTE_TARGET_QUERY_KEY,
  computeTargetForOperation,
  type ComputeTargetState,
} from '@/hooks/use-compute-target';

const codes: Record<string, string> = {
  ...languageCodes,
  ...Object.fromEntries(LANG_CODES.map((item) => [item.label.toLowerCase(), item.code])),
};
// Codes compare without case: the pickers spell Chinese cmn-Hans / cmn-Hant, and
// dub segments store that code as the language they are rendered in.
const codeValues = new Set(Object.values(codes).map((code) => code.toLowerCase()));
// These display names are accepted by the backend; keep persisted values unchanged.
export function languageCode(name: string) {
  return codes[name.toLowerCase()] || '';
}

/** A model's names and codes as sets, built once per list rather than scanned per language. */
const supportIndexes = new WeakMap<readonly string[], { names: Set<string>; codes: Set<string> }>();
function supportIndex(supported: readonly string[]) {
  let index = supportIndexes.get(supported);
  if (!index) {
    index = { names: new Set(), codes: new Set() };
    for (const candidate of supported) {
      const name = candidate.toLowerCase();
      index.names.add(name);
      index.codes.add((languageCode(candidate) || name).toLowerCase());
    }
    supportIndexes.set(supported, index);
  }
  return index;
}

export function languageSupported(name: string, supported?: readonly string[] | null) {
  const lower = name.toLowerCase();
  if (lower === 'auto' || supported == null) return true;
  const code = languageCode(name).toLowerCase() || (codeValues.has(lower) ? lower : '');
  const index = supportIndex(supported);
  return index.names.has(lower) || Boolean(code && index.codes.has(code));
}

/** Shared guard for persisted selections after an engine switch. Unknown metadata remains open. */
export function ttsLanguagesSupported(
  data:
    | {
        tts?: {
          active: string | null;
          backends: { id: string; supported_language_names?: string[] | null }[];
        };
      }
    | undefined,
  languages: string[],
) {
  const selected = data?.tts?.backends.find((engine) => engine.id === data.tts?.active);
  return languages.every((language) =>
    languageSupported(language, selected?.supported_language_names),
  );
}

export function cachedTtsLanguagesSupported(
  client: QueryClient,
  operation: string,
  languages: string[],
) {
  // Every surface reads the one target-wide snapshot that useComputeTarget polls.
  const target = computeTargetForOperation(
    client.getQueryData<ComputeTargetState>(COMPUTE_TARGET_QUERY_KEY),
    operation,
  );
  // Unknown worker metadata must not incorrectly block a capable remote model.
  if (!target || target.active.remote) return true;
  const state = client.getQueryState(['engines']);
  if (state?.status === 'error' || state?.isInvalidated) return true;
  return ttsLanguagesSupported(client.getQueryData<EnginesResponse>(['engines']), languages);
}

export interface LanguageOption extends SearchOption {
  code: string;
  native: string;
}
const cache = new Map<string, Map<string, LanguageOption>>();
export function languageOptions(
  names: string[],
  locale: string,
  autoLabel: string,
): LanguageOption[] {
  let entries = cache.get(locale);
  if (!entries) {
    entries = new Map();
    cache.set(locale, entries);
  }
  const display = new Intl.DisplayNames([locale, 'en'], { type: 'language', fallback: 'none' });
  const regionDisplay = new Intl.DisplayNames([locale, 'en'], { type: 'region', fallback: 'none' });
  const englishRegions = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  return [...new Set(names)].map((value) => {
    if (value.toLowerCase() === 'auto')
      return {
        value,
        label: autoLabel,
        native: '',
        code: '',
        search: [normalizeSearch(autoLabel), 'auto'],
        pinned: true,
      };
    const cached = entries.get(value);
    if (cached) return cached;
    const code = languageCode(value);
    let label = value,
      native = '';
    if (code) {
      try {
        label = display.of(code) || value;
        native =
          new Intl.DisplayNames([code], { type: 'language', fallback: 'none' }).of(code) || '';
      } catch {
        /* A language without ICU data retains its canonical name. */
      }
    }
    const region = (languageRegions as Record<string, string>)[code === 'zh' ? 'cmn-Hans' : code];
    const flagAliases =
      region && /^[A-Z]{2}$/.test(region)
        ? [
            region,
            regionDisplay.of(region) || '',
            englishRegions.of(region) || '',
            String.fromCodePoint(...[...region].map((char) => char.charCodeAt(0) + 127397)),
          ]
        : [];
    const aliases = code === 'zh' ? ['mandarin'] : code === 'tl' ? ['tagalog'] : [];
    const option = {
      value,
      label,
      code,
      native,
      search: [
        ...new Set(
          [value, label, native, code, ...flagAliases, ...aliases]
            .map(normalizeSearch)
            .filter(Boolean),
        ),
      ],
    };
    entries.set(value, option);
    return option;
  });
}
