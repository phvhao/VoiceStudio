import { afterEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import {
  describeDubBlockers,
  dubExportBlockers,
  dubGenerateBlockers,
  dubSteps,
  dubTranslateBlockers,
  type DubBlocker,
} from './dub-gates';

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as unknown as TFunction;
const ready = { busy: false, recovery: false, hasSource: true, segments: 4 };

afterEach(() => {
  document.body.innerHTML = '';
});

it('names only the most fundamental pipeline gap: nothing else matters before it', () => {
  const translate = { ...ready, hasTarget: false, translator: 'unavailable' as const };
  expect(dubTranslateBlockers({ ...translate, busy: true, recovery: true })).toEqual(['busy']);
  expect(dubTranslateBlockers({ ...translate, recovery: true })).toEqual(['recovery']);
  expect(dubTranslateBlockers({ ...translate, hasSource: false, segments: 0 })).toEqual([
    'no_source',
  ]);
  expect(dubTranslateBlockers({ ...translate, segments: 0 })).toEqual(['no_segments']);
  // Past the pipeline, every independent gap is listed.
  expect(dubTranslateBlockers(translate)).toEqual(['no_target', 'translator']);
});

it('maps each translation engine state to the gap the user can act on', () => {
  const state = { ...ready, hasTarget: true };
  expect(dubTranslateBlockers({ ...state, translator: null })).toEqual([]);
  expect(dubTranslateBlockers({ ...state, translator: 'loading' })).toEqual(['translator_loading']);
  expect(dubTranslateBlockers({ ...state, translator: 'packs_missing' })).toEqual([
    'language_packs',
  ]);
  expect(dubTranslateBlockers({ ...state, translator: 'packs_failed' })).toEqual([
    'language_packs_failed',
  ]);
});

it('lets a dub re-voice the transcript untranslated, unless several languages need translating', () => {
  const state = {
    ...ready,
    hasTarget: true,
    tts: null,
    needsTranslator: false,
    translator: 'unavailable' as const,
    emptySegments: 0,
  };
  expect(dubGenerateBlockers(state)).toEqual([]);
  expect(dubGenerateBlockers({ ...state, needsTranslator: true })).toEqual(['translator']);
  expect(
    dubGenerateBlockers({ ...state, hasTarget: false, tts: 'engine', emptySegments: 2 }),
  ).toEqual(['no_target', 'tts_engine', 'empty_segments']);
  expect(dubGenerateBlockers({ ...state, tts: 'loading' })).toEqual(['tts_loading']);
});

it('explains Export in the order a job gets there', () => {
  const state = { ...ready, subtitles: false, tracks: 1, hasTrack: true };
  expect(dubExportBlockers(state)).toEqual([]);
  expect(dubExportBlockers({ ...state, busy: true })).toEqual(['busy']);
  expect(dubExportBlockers({ ...state, recovery: true })).toEqual(['recovery']);
  expect(dubExportBlockers({ ...state, hasSource: false, segments: 0, tracks: 0 })).toEqual([
    'no_source',
  ]);
  // The reported case: a transcribed, never generated job.
  expect(dubExportBlockers({ ...state, tracks: 0, hasTrack: false })).toEqual(['no_dub']);
  expect(dubExportBlockers({ ...state, subtitles: true, segments: 0, tracks: 0 })).toEqual([
    'no_segments',
  ]);
  // Subtitles take their language from a generated track too.
  expect(dubExportBlockers({ ...state, subtitles: true, tracks: 0, hasTrack: false })).toEqual([
    'no_dub',
  ]);
  // Every MP4 track switched off.
  expect(dubExportBlockers({ ...state, hasTrack: false })).toEqual(['no_tracks']);
});

it('gives every blocker a message, and a way to its fix where there is one', () => {
  const all: DubBlocker[] = [
    'busy',
    'recovery',
    'no_source',
    'no_segments',
    'no_target',
    'tts_loading',
    'tts_engine',
    'translator_loading',
    'translator',
    'language_packs',
    'language_packs_failed',
    'empty_segments',
    'no_dub',
    'no_tracks',
  ];
  const described = describeDubBlockers(all, {
    t,
    emptySegments: 3,
    languagePacks: 'en → vi',
    showEmptySegment: () => {},
  });
  expect(described.map((blocker) => blocker.id)).toEqual(all);
  for (const blocker of described) expect(blocker.message).toMatch(/^gatedAction\./);
  // Waiting is the whole fix for these two.
  expect(described.filter((blocker) => !blocker.fix).map((blocker) => blocker.id)).toEqual([
    'tts_loading',
    'translator_loading',
  ]);
  expect(described.find((blocker) => blocker.id === 'empty_segments')?.message).toContain(
    '"total":3',
  );
  expect(described.find((blocker) => blocker.id === 'language_packs')?.message).toContain(
    'en → vi',
  );
  expect(described.find((blocker) => blocker.id === 'no_dub')?.fix?.label).toBe(
    'gatedAction.go_to_step {"step":"dub.generate_dub"}',
  );
});

it('leads each fix to the control that clears it, with a fallback when it is not on screen', () => {
  const openSettings = vi.fn();
  document.body.innerHTML = `
    <section data-gate-target="dub-upload"><button>Choose file</button></section>
    <button data-gate-target="dub-generate">Generate Dub</button>`;
  const [noDub, engine] = describeDubBlockers(['no_dub', 'tts_engine'], { t, openSettings });
  noDub.fix!.onSelect();
  expect(document.activeElement).toHaveTextContent('Generate Dub');
  // No engine notice on the page: open the engine's settings instead.
  engine.fix!.onSelect();
  expect(openSettings).toHaveBeenCalledWith('tts');
  // Before a transcript the footer (and Generate) does not exist yet.
  document.querySelector('[data-gate-target="dub-generate"]')!.remove();
  noDub.fix!.onSelect();
  expect(document.activeElement).toHaveTextContent('Choose file');
});

it('marks how far the job has got, Upload → Translate → Generate', () => {
  const steps = dubSteps(t, { transcribed: true, translated: false, generated: false });
  expect(steps.map((step) => [step.label, step.done])).toEqual([
    ['dub.upload_transcribe', true],
    ['dub.translate', false],
    ['dub.generate_dub', false],
  ]);
  document.body.innerHTML = `<section data-gate-target="dub-language"><button>Spanish</button></section>`;
  // No transcript footer yet: Translate leads to the language setup.
  steps[1].onSelect!();
  expect(document.activeElement).toHaveTextContent('Spanish');
});
