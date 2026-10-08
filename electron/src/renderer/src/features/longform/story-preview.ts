import { apiFetch, apiJson } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import { exportStoryAudio, exportStems } from '@shared/utils/storyExport';
import { extractImageMarks } from '@shared/utils/longformParser';
import { overridesToRequest, readingToRequest } from '@shared/utils/longformOverrides';
import { resolveStoryVoice } from './story-inputs';
import type { Draft, Line } from './longform-session';
import { beginAppActivity } from '@/lib/app-activity';
// The reading fields travel to /generate as one `reading` field instead.
const READING_FIELDS = new Set([
  'punctuation_pauses',
  'split_commas',
  'verify_speech',
  'use_app_reading',
]);
/** The steps a long-form render takes with no preset to say otherwise. */
const LONGFORM_NUM_STEP = 32;
/**
 * The steps a line is read with: the draft's own, else what a long-form
 * render of the active engine takes (`GET /audiobook/sampling`: the
 * performance preset's steps; `null` for an engine that keeps its own) — so
 * an audition sounds like the story's render, not like /generate's default.
 * The cached answer is shared with the steps slider, and asked again when the
 * preset, engine or compute target changes (`RENDER_SETTINGS_DEPENDENTS`).
 */
export async function storySteps(draft: Draft): Promise<number | null> {
  if (draft.overrides.numStep != null) return draft.overrides.numStep;
  try {
    const sampling = await queryClient.fetchQuery({
      queryKey: ['longform-sampling', false],
      queryFn: ({ signal }) =>
        apiJson<{ num_step: number | null }>('/audiobook/sampling', { signal }),
      staleTime: 30_000,
      // An audition does not wait out retries: it falls back below.
      retry: false,
    });
    return sampling.num_step ?? null;
  } catch {
    return LONGFORM_NUM_STEP;
  }
}
/** `steps`: the render's (`storySteps`); `null` sends none, so the engine keeps its own. */
export function storyChunkBody(
  draft: Draft,
  text: string,
  profileId: string | null,
  speed: number | null,
  profiles: { id: string }[],
  steps: number | null = draft.overrides.numStep ?? LONGFORM_NUM_STEP,
) {
  const body = new FormData();
  body.set('text', text);
  if (steps != null) body.set('num_step', String(steps));
  body.set('speed', String(speed || 1));
  const id = resolveStoryVoice(draft, profileId, profiles);
  if (id) body.set('profile_id', id);
  for (const [key, value] of Object.entries(overridesToRequest(draft.overrides, draft.language)))
    if (!READING_FIELDS.has(key)) body.set(key, String(value));
  // A line is read like the book: the project's own reading, else the app's.
  body.set(
    'reading',
    draft.overrides.reading ? JSON.stringify(readingToRequest(draft.overrides.reading)) : 'app',
  );
  return body;
}
/**
 * What an audition of `line` renders from: its own text, character, voice
 * and speed, and the story's voices, cast, language and settings — never
 * another line's text, so typing elsewhere leaves its audition current. The
 * engine, preset and app reading it renders under are `usePreviewSettings`.
 */
export function linePreviewKey(draft: Draft, line: Line): string {
  return JSON.stringify([
    // As the render reads it: the line's pictures change no audio.
    extractImageMarks(line.text)[0],
    line.character ?? null,
    line.profileId,
    line.speed ?? null,
    draft.cast,
    draft.voice,
    draft.language,
    draft.voiceCast,
    draft.overrides,
    draft.globalSpeed,
  ]);
}
export async function previewStoryLine(
  draft: Draft,
  line: Line,
  signal: AbortSignal,
  profiles: { id: string }[],
) {
  const finishActivity = beginAppActivity('synthesis');
  try {
    const helpers = storyAudioHelpers(draft, signal, profiles, await storySteps(draft));
    const result = await exportStoryAudio([line], helpers.resolve, helpers.fetchChunk);
    signal.throwIfAborted();
    return result.blob;
  } finally {
    finishActivity();
  }
}
function storyAudioHelpers(
  draft: Draft,
  signal: AbortSignal,
  profiles: { id: string }[],
  steps: number | null,
) {
  return {
    resolve: (track: Line) => ({
      profileId:
        track.profileId ||
        draft.cast.find((character) => character.id === track.character)?.profileId ||
        draft.voice,
      speed: track.speed || (draft.globalSpeed !== 1 ? draft.globalSpeed : null),
    }),
    fetchChunk: async (text: string, profileId: string | null, speed: number | null) => {
      signal.throwIfAborted();
      // Aborting it closes the request, and /generate stops before its next take.
      const response = await apiFetch('/generate', {
        method: 'POST',
        body: storyChunkBody(draft, text, profileId, speed, profiles, steps),
        signal,
      });
      return response.blob();
    },
  };
}
export async function renderStoryStems(
  draft: Draft,
  signal: AbortSignal,
  profiles: { id: string }[],
  progress: (done: number, total: number) => void,
) {
  const finishActivity = beginAppActivity('synthesis');
  try {
    const helpers = storyAudioHelpers(draft, signal, profiles, await storySteps(draft));
    const result = await exportStems(
      draft.lines.filter((line) => line.text.trim()),
      helpers.resolve,
      helpers.fetchChunk,
      progress,
    );
    signal.throwIfAborted();
    return result;
  } finally {
    finishActivity();
  }
}
