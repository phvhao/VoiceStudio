/**
 * What voice leveling measured in a render. Each SSE `chapter` event of a
 * leveled render carries `levels`: voice name ('' = the default voice, as
 * `voiceGainKey` writes it) → `{ level_db, auto_db }` — the voice's speech
 * level and the gain leveling added in that chapter
 * (`backend/services/voice_leveling.py`, `voice_gains_db`).
 */
export interface VoiceLevel {
  level_db: number;
  auto_db: number;
}
export type VoiceLevels = Record<string, VoiceLevel>;

// Bounds what a stored render may hold, as the backend does per event.
const MAX_VOICES = 200;

/** The well-formed `levels` of a chapter event (or a stored chapter); `undefined` if none. */
export function chapterLevels(source: object): VoiceLevels | undefined {
  const raw = (source as { levels?: unknown }).levels;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const levels: VoiceLevels = {};
  for (const [name, entry] of Object.entries(raw).slice(0, MAX_VOICES)) {
    const { level_db, auto_db } = (entry ?? {}) as Partial<Record<keyof VoiceLevel, unknown>>;
    if (
      typeof level_db === 'number' &&
      Number.isFinite(level_db) &&
      typeof auto_db === 'number' &&
      Number.isFinite(auto_db)
    )
      levels[name] = { level_db, auto_db };
  }
  return Object.keys(levels).length ? levels : undefined;
}

/**
 * The gain leveling added to each voice across a book: the median of its
 * chapters' gains (one loud or quiet chapter does not speak for the book),
 * rounded to 0.1 dB. Voices no chapter measured are absent.
 */
export function bookAutoLevels(chapters: readonly object[] | undefined): Record<string, number> {
  const gains = new Map<string, number[]>();
  for (const chapter of chapters ?? []) {
    for (const [name, level] of Object.entries(chapterLevels(chapter) ?? {}))
      gains.set(name, [...(gains.get(name) ?? []), level.auto_db]);
  }
  return Object.fromEntries(
    [...gains].map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      const median =
        sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      return [name, Math.round(median * 10) / 10 || 0];
    }),
  );
}
