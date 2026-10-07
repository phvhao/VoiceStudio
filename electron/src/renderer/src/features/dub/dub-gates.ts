import type { TFunction } from 'i18next';
import { revealGateTarget, type ActionBlocker, type ActionStep } from '@/components/gated-action';

/** The `data-gate-target` ids the Dub workspace marks, where each fix leads. */
export const DUB_TARGET = {
  upload: 'dub-upload',
  language: 'dub-language',
  translator: 'dub-translator',
  languagePacks: 'dub-language-packs',
  translate: 'dub-translate',
  generate: 'dub-generate',
  tracks: 'dub-export-tracks',
  recovery: 'dub-recovery',
  progress: 'dub-progress',
  engine: 'engine-notice',
} as const;

export type DubBlocker =
  | 'busy'
  | 'recovery'
  | 'no_source'
  | 'no_segments'
  | 'no_target'
  | 'tts_loading'
  | 'tts_engine'
  | 'translator_loading'
  | 'translator'
  | 'language_packs'
  | 'language_packs_failed'
  | 'empty_segments'
  | 'no_dub'
  | 'no_tracks';

/** Why the active translation engine cannot run yet, or null when it can. */
export type DubTranslator = 'loading' | 'unavailable' | 'packs_missing' | 'packs_failed' | null;

export interface DubGateState {
  /** A pipeline step (upload, transcription, translation, generation…) is running. */
  busy: boolean;
  /** An interrupted job is waiting to be resumed or cancelled. */
  recovery: boolean;
  hasSource: boolean;
  segments: number;
}

/**
 * The blockers every step shares, most fundamental first. Only the first
 * applies: each one makes the rest moot (no file means no transcript).
 */
function pipelineBlocker(state: DubGateState): DubBlocker | null {
  if (state.busy) return 'busy';
  if (state.recovery) return 'recovery';
  if (!state.hasSource) return 'no_source';
  if (!state.segments) return 'no_segments';
  return null;
}

function translatorBlocker(translator: DubTranslator): DubBlocker | null {
  if (translator === 'loading') return 'translator_loading';
  if (translator === 'unavailable') return 'translator';
  if (translator === 'packs_missing') return 'language_packs';
  if (translator === 'packs_failed') return 'language_packs_failed';
  return null;
}

/** What stands between the user and translating the transcript. */
export function dubTranslateBlockers(
  state: DubGateState & { hasTarget: boolean; translator: DubTranslator },
): DubBlocker[] {
  const pipeline = pipelineBlocker(state);
  if (pipeline) return [pipeline];
  const missing: DubBlocker[] = [];
  if (!state.hasTarget) missing.push('no_target');
  const translator = translatorBlocker(state.translator);
  if (translator) missing.push(translator);
  return missing;
}

/**
 * What stands between the user and generating the dub. Translating first is
 * not required — a dub may re-voice the transcript as typed — but several
 * target languages are each translated as part of the run.
 */
export function dubGenerateBlockers(
  state: DubGateState & {
    hasTarget: boolean;
    tts: 'engine' | 'loading' | null;
    /** More than one target language and the Agent has not translated them all. */
    needsTranslator: boolean;
    translator: DubTranslator;
    emptySegments: number;
  },
): DubBlocker[] {
  const pipeline = pipelineBlocker(state);
  if (pipeline) return [pipeline];
  const missing: DubBlocker[] = [];
  if (!state.hasTarget) missing.push('no_target');
  if (state.tts === 'loading') missing.push('tts_loading');
  if (state.tts === 'engine') missing.push('tts_engine');
  const translator = state.needsTranslator && translatorBlocker(state.translator);
  if (translator) missing.push(translator);
  if (state.emptySegments) missing.push('empty_segments');
  return missing;
}

/** What stands between the user and exporting in the chosen format. */
export function dubExportBlockers(
  state: DubGateState & {
    subtitles: boolean;
    tracks: number;
    /** The format's track (or MP4 default track) resolves to one that is turned on. */
    hasTrack: boolean;
  },
): DubBlocker[] {
  if (state.busy) return ['busy'];
  if (state.recovery) return ['recovery'];
  if (!state.hasSource) return ['no_source'];
  if (state.subtitles && !state.segments) return ['no_segments'];
  // Subtitles name their language after a generated dub track too.
  if (!state.tracks) return ['no_dub'];
  if (!state.hasTrack) return ['no_tracks'];
  return [];
}

/** Each blocker said as what to do, with the way to the control that fixes it. */
export function describeDubBlockers(
  blockers: readonly DubBlocker[],
  {
    t,
    emptySegments = 0,
    languagePacks = '',
    showEmptySegment,
    openSettings,
  }: {
    t: TFunction;
    emptySegments?: number;
    /** The missing Argos pairs, already formatted ("en → es"). */
    languagePacks?: string;
    showEmptySegment?: () => void;
    openSettings?: (family: 'tts' | 'translation') => void;
  },
): ActionBlocker[] {
  const show = (target: string, fallback?: () => void) => ({
    label: t('gatedAction.show'),
    onSelect: () => {
      if (!revealGateTarget(target)) fallback?.();
    },
  });
  // Named, not numbered: the sidebar numbers its own sections differently.
  const step = (name: string, target: string, fallback?: string) => ({
    label: t('gatedAction.go_to_step', { step: name }),
    onSelect: () => {
      if (!revealGateTarget(target) && fallback) revealGateTarget(fallback);
    },
  });
  return blockers.map((id): ActionBlocker => {
    switch (id) {
      case 'busy':
        return { id, message: t('gatedAction.busy'), fix: show(DUB_TARGET.progress) };
      case 'recovery':
        return { id, message: t('gatedAction.recovery'), fix: show(DUB_TARGET.recovery) };
      case 'no_source':
        return {
          id,
          message: t('gatedAction.dub_no_source'),
          fix: step(t('dub.upload_transcribe'), DUB_TARGET.upload),
        };
      case 'no_segments':
        return {
          id,
          message: t('gatedAction.dub_no_segments'),
          fix: step(t('dub.upload_transcribe'), DUB_TARGET.upload),
        };
      case 'no_target':
        return { id, message: t('gatedAction.dub_no_target'), fix: show(DUB_TARGET.language) };
      case 'tts_loading':
        return { id, message: t('gatedAction.tts_loading') };
      case 'tts_engine':
        return {
          id,
          message: t('gatedAction.tts_engine'),
          fix: show(DUB_TARGET.engine, () => openSettings?.('tts')),
        };
      case 'translator_loading':
        return { id, message: t('gatedAction.translator_loading') };
      case 'translator':
        return {
          id,
          message: t('gatedAction.translator'),
          fix: show(DUB_TARGET.translator, () => openSettings?.('translation')),
        };
      case 'language_packs':
        return {
          id,
          message: t('gatedAction.language_packs', { pairs: languagePacks }),
          fix: show(DUB_TARGET.languagePacks),
        };
      case 'language_packs_failed':
        return {
          id,
          message: t('gatedAction.language_packs_failed'),
          fix: show(DUB_TARGET.languagePacks),
        };
      case 'empty_segments':
        return {
          id,
          message: t('gatedAction.dub_empty_segments', { total: emptySegments }),
          fix: showEmptySegment && { label: t('gatedAction.show'), onSelect: showEmptySegment },
        };
      case 'no_dub':
        return {
          id,
          message: t('gatedAction.dub_no_dub'),
          fix: step(t('dub.generate_dub'), DUB_TARGET.generate, DUB_TARGET.upload),
        };
      case 'no_tracks':
        return { id, message: t('gatedAction.dub_no_tracks'), fix: show(DUB_TARGET.tracks) };
    }
  });
}

/** ① Upload & transcribe → ② Translate → ③ Generate dub, as far as the job has got. */
export function dubSteps(
  t: TFunction,
  state: { transcribed: boolean; translated: boolean; generated: boolean },
): ActionStep[] {
  return [
    {
      id: 'upload',
      label: t('dub.upload_transcribe'),
      done: state.transcribed,
      onSelect: () => revealGateTarget(DUB_TARGET.upload),
    },
    {
      id: 'translate',
      label: t('dub.translate'),
      done: state.translated,
      // The Translate actions live in the transcript footer, which exists
      // only once there is a transcript; before that, set the language up.
      onSelect: () =>
        revealGateTarget(DUB_TARGET.translate) || revealGateTarget(DUB_TARGET.language),
    },
    {
      id: 'generate',
      label: t('dub.generate_dub'),
      done: state.generated,
      onSelect: () => revealGateTarget(DUB_TARGET.generate) || revealGateTarget(DUB_TARGET.upload),
    },
  ];
}
