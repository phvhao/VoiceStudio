import type { QueryClient } from '@tanstack/react-query';

/**
 * Answers that hold how this machine renders speech — the steps the performance
 * preset renders at, the active TTS engine, and whether a job runs here or on a
 * worker — beyond the request they were asked with: which Audiobook chapters are
 * already rendered (a chapter's cache key holds all three) and the sampling a
 * long-form render takes. Whatever changes one of those settings asks them again,
 * so the Contents rail and the render's time left never go by the old ones.
 */
export const RENDER_SETTINGS_DEPENDENTS = [['audiobook-outline'], ['longform-sampling']] as const;

export async function refreshRenderSettingsDependents(client: QueryClient): Promise<void> {
  await Promise.all(
    RENDER_SETTINGS_DEPENDENTS.map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}
