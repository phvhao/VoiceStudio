export const metadataFields = ['author', 'narrator', 'year', 'genre', 'description'] as const;
export interface BookOptions {
  metadata: Partial<Record<(typeof metadataFields)[number], string>>;
  loudness: 'off' | 'acx' | 'podcast';
  cover: { path: string; name: string } | null;
  lexicon: { word: string; pronunciation: string }[];
}
export function restoreBookOptions(value: Partial<BookOptions> | null | undefined): BookOptions {
  const metadata = Object.fromEntries(
    metadataFields.flatMap((key) =>
      typeof value?.metadata?.[key] === 'string' ? [[key, value.metadata[key]]] : [],
    ),
  );
  return {
    metadata,
    loudness: value?.loudness === 'acx' || value?.loudness === 'podcast' ? value.loudness : 'off',
    cover:
      typeof value?.cover?.path === 'string' && typeof value.cover.name === 'string'
        ? value.cover
        : null,
    lexicon: Array.isArray(value?.lexicon)
      ? value.lexicon.filter(
          (row) => row && typeof row.word === 'string' && typeof row.pronunciation === 'string',
        )
      : [],
  };
}
/** For each row, whether its word repeats one listed above it (case and spaces aside). */
export function repeatedWords(rows: BookOptions['lexicon']): boolean[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const key = row.word.trim().toLowerCase();
    const repeated = Boolean(key) && seen.has(key);
    seen.add(key);
    return repeated;
  });
}
export function duplicateWords(rows: BookOptions['lexicon']): boolean {
  return repeatedWords(rows).includes(true);
}
/**
 * The word → pronunciation map a render sends. A word listed twice has no one
 * pronunciation, so a render refuses it (`strict`, the default). What only
 * describes the book — its outline, whether an audition is current — must
 * not fail on a draft being edited: it reads the first row and skips the copy.
 */
export function lexiconMap(rows: BookOptions['lexicon'], { strict = true } = {}) {
  const repeated = repeatedWords(rows);
  if (strict && repeated.includes(true)) throw new Error('Duplicate pronunciation words');
  return Object.fromEntries(
    rows
      .filter((row, index) => !repeated[index] && row.word.trim() && row.pronunciation.trim())
      .map((row) => [row.word.trim(), row.pronunciation.trim()]),
  );
}
