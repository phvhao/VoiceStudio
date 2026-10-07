import type { TFunction } from 'i18next';
import { revealGateTarget, type ActionBlocker } from '@/components/gated-action';
import type { UseGenerateClone } from '@/hooks/use-generate';
import type { CloneBlocker } from '@/lib/clone-readiness';

/** The `data-gate-target` ids Clone and Voice Design mark, where each fix leads. */
export const SYNTHESIS_TARGET = {
  cloneScript: 'clone-script',
  /** Clone's "Voice · name" button, which opens the voice chooser. */
  cloneVoice: 'clone-voice',
  designScript: 'design-script',
  engine: 'engine-notice',
} as const;

export type SynthesisBlocker =
  | 'voice_sample_busy'
  | 'tts_loading'
  | 'tts_engine'
  /** The engine ignores reference audio, so it cannot clone. */
  | 'clone_unsupported'
  /** The engine needs a reference clip, so it cannot design. */
  | 'design_unsupported'
  /** Re-rendering a saved design voice clones its sample, which the engine cannot. */
  | 'reuse_unsupported'
  | 'no_voice'
  | 'no_text';

/**
 * What stands between the user and synthesizing on Clone, most fundamental
 * first. The readiness check names one blocker; the script is independent of
 * all of them, so an empty one is listed beside it.
 */
export function cloneBlockers(blocker: CloneBlocker, text: string): SynthesisBlocker[] {
  if (!blocker) return [];
  const missing: SynthesisBlocker[] = [];
  if (blocker === 'preparing') missing.push('voice_sample_busy');
  // Clone reads the saved voices before its composer shows: still loading
  // here is the engine.
  if (blocker === 'loading') missing.push('tts_loading');
  if (blocker === 'engine') missing.push('tts_engine');
  if (blocker === 'cloning') missing.push('clone_unsupported');
  if (blocker === 'reference') missing.push('no_voice');
  if (blocker === 'text' || !text.trim()) missing.push('no_text');
  return missing;
}

/** What stands between the user and synthesizing on Voice Design, most fundamental first. */
export function designBlockers(
  blocker: UseGenerateClone['designBlocker'],
  text: string,
): SynthesisBlocker[] {
  const missing: SynthesisBlocker[] = [];
  if (blocker === 'loading') missing.push('tts_loading');
  if (blocker === 'engine') missing.push('tts_engine');
  if (blocker === 'design') missing.push('design_unsupported');
  if (blocker === 'cloning') missing.push('reuse_unsupported');
  if (!text.trim()) missing.push('no_text');
  return missing;
}

/** Each blocker said as what to do, with the way to the control that fixes it. */
export function describeSynthesisBlockers(
  blockers: readonly SynthesisBlocker[],
  {
    t,
    engine = '',
    script,
    openSettings,
    chooseVoice,
  }: {
    t: TFunction;
    /** The active engine's name, for "X can't design voices". */
    engine?: string;
    /** The page's script: SYNTHESIS_TARGET.cloneScript or designScript. */
    script: string;
    /** Settings → Models → TTS. */
    openSettings: () => void;
    /** Where to pick a voice when the page shows no voice button to go to. */
    chooseVoice?: () => void;
  },
): ActionBlocker[] {
  const show = (target: string, fallback?: () => void) => ({
    label: t('gatedAction.show'),
    onSelect: () => {
      if (!revealGateTarget(target)) fallback?.();
    },
  });
  const settings = { label: t('gatedAction.open_settings'), onSelect: openSettings };
  return blockers.map((id): ActionBlocker => {
    switch (id) {
      case 'voice_sample_busy':
        return { id, message: t('gatedAction.voice_sample_busy') };
      case 'tts_loading':
        return { id, message: t('gatedAction.tts_loading') };
      case 'tts_engine':
        return {
          id,
          message: t('gatedAction.tts_engine'),
          fix: show(SYNTHESIS_TARGET.engine, openSettings),
        };
      case 'clone_unsupported':
        return { id, message: t('convert.cloning_required'), fix: settings };
      case 'design_unsupported':
        return {
          id,
          message: t('designWorkspace.engine_cannot_design', { engine }),
          fix: settings,
        };
      case 'reuse_unsupported':
        return {
          id,
          message: t('designWorkspace.engine_cannot_reuse_sample', { engine }),
          fix: settings,
        };
      case 'no_voice':
        return {
          id,
          message: t('gatedAction.no_voice'),
          fix: show(SYNTHESIS_TARGET.cloneVoice, chooseVoice),
        };
      case 'no_text':
        return { id, message: t('gatedAction.no_text'), fix: show(script) };
    }
  });
}
