import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { GatedAction } from '@/components/gated-action';
import { runRendererTask } from '@/lib/global-error-recovery';
import { GenerationProgress } from './generation-progress';
import type { GenerateBlocker } from './generate-blocker';
import { describeGenerateBlockers, generateSteps, type GenerateSetup } from './generate-gates';
import type { AudiobookRenderChapter, RenderTiming } from './longform-session';

/** The slice of the render session this panel reads. */
export interface GenerateSession {
  active: 'stories' | 'audiobook' | null;
  stage: string;
  completed: number;
  total: number;
  failed: number;
  stopped: boolean;
  chapters: AudiobookRenderChapter[];
  timing?: RenderTiming | null;
}

/**
 * Generate / Stop, the chapter tracker and the render status in one block, so
 * the primary action and its progress are always in the same, visible place
 * (pinned in the setup column) instead of below the last line of a long script.
 */
export function GeneratePanel({
  mode,
  session,
  blockers,
  setup,
  onGenerate,
  onStop,
}: {
  mode: 'stories' | 'audiobook';
  session: GenerateSession;
  /** What Generate still needs (generateBlockers), most fundamental first. */
  blockers: readonly GenerateBlocker[];
  /** Where the book's setup stands: the checklist shown with what is missing. */
  setup?: GenerateSetup;
  onGenerate: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const active = session.active === mode;
  const openSettings = () =>
    runRendererTask('Open model settings', () =>
      navigate({ to: '/settings/models/$family', params: { family: 'tts' } }),
    );
  const missing = describeGenerateBlockers(blockers, {
    t,
    openSettings,
    // The render holding the GPU belongs to the other mode; its page can stop it.
    showRender: () =>
      runRendererTask('Show the running render', () =>
        navigate({ to: mode === 'stories' ? '/audiobook' : '/stories' }),
      ),
  });
  const status = active
    ? session.stage === 'assembling'
      ? t('audiobook.assembling')
      : session.stage === 'starting'
        ? t('common.loading')
        : t('audiobook.progress_summary', {
            current: Math.min(session.completed + 1, session.total),
            total: session.total,
          })
    : (missing[0]?.message ?? '');
  return (
    <div data-slot="generate-panel" className="flex min-h-0 flex-col gap-3">
      {session.failed > 0 && (
        <p role="status" className="shrink-0 text-xs text-muted-foreground">
          {t('audiobook.failed_note', { count: session.failed })}
        </p>
      )}
      {session.stopped && !session.active && (
        <p role="status" className="shrink-0 text-xs text-muted-foreground">
          {t('audiobook.stopped_note')}
        </p>
      )}
      {active && session.stage !== 'starting' && (
        <div className="min-h-0 max-h-[38vh] overflow-y-auto">
          <GenerationProgress
            chapters={session.chapters}
            assembling={session.stage === 'assembling'}
            timing={session.timing}
          />
        </div>
      )}
      {status && (
        <p role="status" className="shrink-0 text-xs text-muted-foreground">
          {status}
        </p>
      )}
      {active ? (
        <Button variant="outline" className="w-full shrink-0" onClick={onStop}>
          {t('common.stop')}
        </Button>
      ) : (
        // Pressable while blocked: it lists what is missing, with the way to each.
        <GatedAction
          className="w-full shrink-0"
          blockers={missing}
          steps={setup && generateSteps(t, mode, setup, { openSettings })}
          onClick={onGenerate}
        >
          {t(mode === 'stories' ? 'stories.generateAll' : 'audiobook.create')}
        </GatedAction>
      )}
    </div>
  );
}
