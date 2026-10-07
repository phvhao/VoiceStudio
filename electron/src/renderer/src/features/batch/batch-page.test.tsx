import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  tts: null as 'engine' | 'loading' | null,
  translation: { active: 'argos', engines: [{ id: 'argos', installed: true }] } as object,
  navigate: vi.fn(),
  enqueue: vi.fn(async () => [] as File[]),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { reasons?: string }) =>
      params?.reasons ? `${key}: ${params.reasons}` : key,
    i18n: { resolvedLanguage: 'en' },
  }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('@/components/workspace-sidebar', () => ({
  SecondarySidebar: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));
vi.mock('@/components/app-shell/workspace-header', () => ({
  WorkspaceHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock('@/components/engine-notice', () => ({
  EngineNotice: () =>
    state.tts === 'engine' ? (
      <div data-gate-target="engine-notice">
        <button type="button">repairAgent.fix</button>
      </div>
    ) : null,
}));
vi.mock('./watch-folder', () => ({ WatchFolder: () => null }));
vi.mock('./enqueue', () => ({ enqueueVideos: state.enqueue }));
vi.mock('@/features/clone/engine-language-picker', () => ({
  EngineLanguagePicker: () => <button type="button">Language</button>,
}));
vi.mock('@/hooks/use-profiles', () => ({ useProfiles: () => ({ data: [] }) }));
vi.mock('@/hooks/use-tts-readiness', () => ({ useTtsReadiness: () => state.tts }));
vi.mock('@/hooks/use-active-batch-jobs', () => ({
  useActiveBatchJobs: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/features/settings/translation-settings', () => ({
  useTranslationEngines: () => ({ data: state.translation }),
}));
vi.mock('@/lib/language-options', () => ({ cachedTtsLanguagesSupported: () => true }));
import { BatchPage } from './batch-page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.tts = null;
  state.translation = { active: 'argos', engines: [{ id: 'argos', installed: true }] };
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BatchPage />
    </QueryClientProvider>,
  );
  return screen.getByRole('button', { name: /^batch\.add_to_queue$/ });
}

it('says what Add to Queue needs and leads to it, instead of greying out', async () => {
  // Regression: with no video added the button was only disabled.
  const queue = renderPage();
  expect(queue).not.toBeDisabled();
  expect(queue).toHaveAttribute('aria-disabled', 'true');
  expect(queue).toHaveAccessibleDescription(/gatedAction\.batch_no_files/);
  fireEvent.click(queue);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /gatedAction\.show/ }));
  // The sidebar's Add Videos, not the empty queue's copy of it.
  const addVideos = screen
    .getAllByRole('button', { name: 'batch.add_videos' })
    .find((button) => button.dataset.gateTarget === 'batch-files');
  await waitFor(() => expect(document.activeElement).toBe(addVideos));
  expect(state.enqueue).not.toHaveBeenCalled();
});

it('lists an engine that is not ready with the way to set it up', async () => {
  state.tts = 'engine';
  state.translation = { active: 'argos', engines: [{ id: 'argos', installed: false }] };
  const queue = renderPage();
  expect(queue).toHaveAccessibleDescription(/gatedAction\.tts_engine/);
  expect(queue).toHaveAccessibleDescription(/gatedAction\.translator/);
  fireEvent.click(queue);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'gatedAction.open_settings' }));
  await waitFor(() =>
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/settings/models/$family',
      params: { family: 'translation' },
    }),
  );
});

it('queues once everything is in place', async () => {
  const queue = renderPage();
  fireEvent.change(screen.getByLabelText('batch.file_input_label'), {
    target: { files: [new File(['video'], 'one.mp4', { type: 'video/mp4' })] },
  });
  await waitFor(() => expect(queue).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(queue);
  await waitFor(() => expect(state.enqueue).toHaveBeenCalledOnce());
});
