import { NativeDictationSync } from '@/hooks/use-native-dictation';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { GenerationProvider } from '@/hooks/use-generate';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { queryClient } from '@/lib/query';
import { router } from './router';
import { ErrorBoundary } from '@/components/error-boundary';
import { toast } from 'sonner';
import { AnalyticsConsentBanner, AnalyticsRuntime } from '@/components/analytics-consent';
import { getBridge } from '@/components/bridge';
import { FirstSoundHandoff } from '@/components/first-sound-handoff';
import { stepAppearanceScale } from '@/hooks/use-appearance';
import { handleAppZoomKey } from '@/lib/zoom-keys';
import { recordRouteBreadcrumb } from '@/lib/report-breadcrumb';
import { ModelInstallSync } from '@/hooks/use-model-install-sync';
import { RealtimeEventSync } from '@/hooks/use-realtime-events';
import { GenerateBudgetSync } from '@/hooks/use-generate-budget-sync';
import { runRendererTask } from '@/lib/global-error-recovery';
import { WebAuthGate } from '@/components/web-auth-gate';

const notifiedUpdates = new Set<string>();

function UpdateNotifier() {
  const { t } = useTranslation();
  useEffect(() => {
    const updates = getBridge()?.updates;
    if (!updates) return;
    return updates.onState((state) => {
      if (
        (state.status !== 'available' && state.status !== 'downloaded') ||
        !state.availableVersion ||
        notifiedUpdates.has(state.availableVersion)
      )
        return;
      notifiedUpdates.add(state.availableVersion);
      toast.info(t('update.toast_available', { version: state.availableVersion }), {
        action: {
          label: t('common.open'),
          onClick: () =>
            runRendererTask('Navigate to updates', () =>
              router.navigate({ to: '/settings/updates' }),
            ),
        },
      });
    });
  }, [t]);
  return null;
}

export function App() {
  const { t } = useTranslation();
  useEffect(() => {
    const record = () => recordRouteBreadcrumb();
    record();
    window.addEventListener('hashchange', record);
    return () => window.removeEventListener('hashchange', record);
  }, []);
  useEffect(() => {
    // Capture phase, ahead of the page — except where a part of it (the
    // script editor) zooms its own text: those keys are left to it.
    const onKeyDown = (event: KeyboardEvent) => void handleAppZoomKey(event, stepAppearanceScale);
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  useEffect(() => {
    void window.voicestudio?.capture
      ?.labels({
        show: `${t('common.open')} ${t('app.name')}`,
        start: t('transcriptions.capture'),
        stop: t('clone.stop_recording'),
        settings: t('nav.settings'),
        exit: t('app.quit', { app: t('app.name') }),
      })
      .catch(() => {});
  }, [t]);
  useEffect(() => {
    const app = getBridge()?.app;
    if (!app) return;
    return app.onNavigate((path) => {
      if (path === '/settings')
        runRendererTask('Native navigation to settings', () =>
          router.navigate({ to: '/settings' }),
        );
    });
  }, []);
  useEffect(() => {
    const app = getBridge()?.app;
    if (!app?.onPersistenceFlush) return;
    return app.onPersistenceFlush(async () => {
      const [{ flushLongformSessionPersistence }, { projectLibrary }] = await Promise.all([
        import('@/features/longform/longform-session'),
        import('@/features/longform/project-library'),
      ]);
      // Saves open books with edits still waiting for the auto-save.
      await flushLongformSessionPersistence();
      await projectLibrary.flush();
    });
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <WebAuthGate>
          <NativeDictationSync />
          <ModelInstallSync />
          <RealtimeEventSync />
          <GenerateBudgetSync />
          <UpdateNotifier />
          <AnalyticsRuntime />
          <AnalyticsConsentBanner />
          <GenerationProvider>
            <FirstSoundHandoff />
            <TooltipProvider>
              <RouterProvider router={router} />
              <Toaster richColors position="bottom-right" />
            </TooltipProvider>
          </GenerationProvider>
        </WebAuthGate>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
