import type { TFunction } from 'i18next';
import { revealGateTarget, type ActionBlocker, type ActionStep } from '@/components/gated-action';
import type { GenerateBlocker } from './generate-blocker';

/** The `data-gate-target` ids Stories and Audiobook mark, where each fix leads. */
export const LONGFORM_TARGET = {
  /** The Audiobook script, or the Stories lines (their empty state while there are none). */
  script: 'longform-script',
  defaultVoice: 'longform-default-voice',
  /** The Cast panel. */
  cast: 'longform-cast',
  /** A cast name whose voice was deleted. */
  castMissing: 'longform-cast-missing',
  /** A pronunciation word listed a second time. */
  lexicon: 'longform-lexicon',
  engine: 'engine-notice',
} as const;

/** Where a book's setup stands, for the checklist Generate's explanation opens with. */
export interface GenerateSetup {
  /** Why the voice engine cannot render yet (useTtsReadiness), or null when it can. */
  engine: 'engine' | 'loading' | null;
  /** There is a script (Audiobook) or a spoken line (Stories). */
  usable: boolean;
  /** Audiobook: the default voice exists. Stories: every spoken line has a voice. */
  voiceReady: boolean;
  /** The script names voices to cast; the Cast step shows only then. */
  casting: boolean;
  castReady: boolean;
}

/** Reveals the first of `targets` the page shows; false when it shows none. */
function reveal(...targets: string[]) {
  return () => targets.some((target) => revealGateTarget(target));
}

/** Each blocker said as what to do, with the way to what fixes it. */
export function describeGenerateBlockers(
  blockers: readonly GenerateBlocker[],
  {
    t,
    openSettings,
    showRender,
  }: {
    t: TFunction;
    /** Settings → Models → TTS, for an engine the page has no notice for. */
    openSettings: () => void;
    /** The other mode's page, whose render holds the GPU and can be stopped there. */
    showRender?: () => void;
  },
): ActionBlocker[] {
  const show = (onSelect: () => unknown) => ({
    label: t('gatedAction.show'),
    onSelect: () => void onSelect(),
  });
  return blockers.map((id): ActionBlocker => {
    const message = t('audiobook.blocked.' + id);
    switch (id) {
      case 'busy':
        return { id, message, fix: showRender && show(showRender) };
      case 'engine':
        return { id, message, fix: show(() => reveal(LONGFORM_TARGET.engine)() || openSettings()) };
      case 'no_lines':
      case 'no_script':
        return { id, message, fix: show(reveal(LONGFORM_TARGET.script)) };
      case 'default_voice':
      case 'voice':
        return { id, message, fix: show(reveal(LONGFORM_TARGET.defaultVoice)) };
      case 'cast_voice':
        return {
          id,
          message,
          fix: show(reveal(LONGFORM_TARGET.castMissing, LONGFORM_TARGET.cast)),
        };
      case 'lexicon':
        return { id, message, fix: show(reveal(LONGFORM_TARGET.lexicon)) };
      // Each ends by itself, or with the Stop beside the preview.
      case 'importing':
      case 'previewing':
      case 'engine_loading':
        return { id, message };
    }
  });
}

/**
 * The parts a book needs, in the order Generate checks them — voice engine,
 * script, voice, cast — each leading to the control that sets it.
 */
export function generateSteps(
  t: TFunction,
  mode: 'stories' | 'audiobook',
  setup: GenerateSetup,
  { openSettings }: { openSettings: () => void },
): ActionStep[] {
  const steps: ActionStep[] = [
    {
      id: 'engine',
      label: t('gatedAction.step_engine'),
      done: setup.engine === null,
      // A ready or starting engine has no notice on the page to go to.
      onSelect:
        setup.engine === 'engine'
          ? () => reveal(LONGFORM_TARGET.engine)() || openSettings()
          : undefined,
    },
    {
      id: 'script',
      label: t('clone.script'),
      done: setup.usable,
      onSelect: reveal(LONGFORM_TARGET.script),
    },
    {
      id: 'voice',
      label: t(mode === 'audiobook' ? 'audiobook.default_voice' : 'gatedAction.step_voices'),
      done: setup.voiceReady,
      onSelect: reveal(LONGFORM_TARGET.defaultVoice),
    },
  ];
  if (setup.casting)
    steps.push({
      id: 'cast',
      label: t(mode === 'audiobook' ? 'audiobook.cast' : 'stories.inline_voices'),
      done: setup.castReady,
      onSelect: reveal(LONGFORM_TARGET.castMissing, LONGFORM_TARGET.cast),
    });
  return steps;
}
