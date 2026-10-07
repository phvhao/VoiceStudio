import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ saveExport: vi.fn(async (_url: string, _name: string) => {}) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/components/bridge', () => ({ getBridge: () => ({}) }));
vi.mock('@/lib/export-history', () => ({ saveExport: mocks.saveExport }));
import { DubExportPanel } from './dub-export-panel';
import type { DubSession } from './dub-session';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const transcribed = {
  jobId: 'job-1',
  inputType: 'video',
  phase: 'editing',
  recovery: null,
  segments: [{ id: '1', start: 0, end: 2, text: 'Hola' }],
  tracks: [],
  exportOptions: { format: 'wav' },
} as unknown as DubSession;

function open(session: DubSession, disabled = false) {
  const view = render(<DubExportPanel session={session} disabled={disabled} />);
  view.container.querySelector('details')!.open = true;
  return screen.getByRole('button', { name: /^exportModal\.export$/ });
}

it('says Export needs a generated dub — and leads there — instead of greying out', async () => {
  // Regression: a transcribed job showed a disabled Export and "Nothing
  // selected or track unavailable", with no hint that the dub was missing.
  const generate = document.createElement('button');
  generate.dataset.gateTarget = 'dub-generate';
  generate.textContent = 'Generate Dub';
  document.body.append(generate);
  const exportButton = open(transcribed);
  expect(exportButton).not.toBeDisabled();
  expect(exportButton).toHaveAttribute('aria-disabled', 'true');
  expect(exportButton).toHaveAccessibleDescription(/gatedAction\.dub_no_dub/);
  expect(screen.queryByText('exportModal.nothing_selected')).toBeNull();
  expect(screen.getByText('gatedAction.dub_no_dub')).toBeVisible();
  fireEvent.click(exportButton);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /gatedAction\.go_to_step/ }));
  await waitFor(() => expect(document.activeElement).toBe(generate));
  expect(mocks.saveExport).not.toHaveBeenCalled();
});

it('points at the MP4 track switches when every track is turned off', async () => {
  const exportButton = open({
    ...transcribed,
    tracks: ['es'],
    exportOptions: { format: 'mp4', excluded: ['original', 'es'] },
  });
  expect(exportButton).toHaveAccessibleDescription(/gatedAction\.dub_no_tracks/);
  fireEvent.click(exportButton);
  fireEvent.click(await screen.findByRole('button', { name: /gatedAction\.show/ }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('switch', { name: 'exportModal.original' }),
    ),
  );
});

it('stays pressable while the page is busy, to say so', () => {
  const exportButton = open({ ...transcribed, phase: 'generating', tracks: ['es'] }, true);
  expect(exportButton).not.toBeDisabled();
  expect(exportButton).toHaveAccessibleDescription(/gatedAction\.busy/);
});

it('exports straight away once a dub exists', async () => {
  const exportButton = open({ ...transcribed, phase: 'done', tracks: ['es'] });
  expect(exportButton).not.toHaveAttribute('aria-disabled');
  fireEvent.click(exportButton);
  await waitFor(() => expect(mocks.saveExport).toHaveBeenCalledOnce());
  expect(String(mocks.saveExport.mock.calls[0][0])).toContain('/dub/download-audio/job-1');
});
