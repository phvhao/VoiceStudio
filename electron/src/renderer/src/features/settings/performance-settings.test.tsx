import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiJson: mock.api, describeError: String }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/app-activity', () => ({ useAppActivities: () => ({}) }));
vi.mock('./system-preflight', () => ({ SystemPreflight: () => null }));
vi.mock('@/components/performance-profile', () => ({ PerformanceProfile: () => null }));
vi.mock('@shared/components/SearchableSelect', () => ({
  default: ({ onChange, disabled }: { onChange: (value: string) => void; disabled: boolean }) => (
    <button disabled={disabled} onClick={() => onChange('GPU-second')}>
      Choose adapter
    </button>
  ),
}));
import { toast } from 'sonner';
import { PerformanceSettings } from './performance-settings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([null, 'cuda', 'compute'])(
  'recovers from a CUDA save error (refetch fails: %s)',
  async (failRefetch) => {
    let retried = false;
    mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/settings/cuda-device') {
        if (init?.method === 'PUT') throw new Error('Save failed');
        if (retried && failRefetch === 'cuda') throw new Error('Refetch failed');
        return {
          value: 'auto',
          devices: [
            { value: 'GPU-first', index: 0, name: 'First' },
            { value: 'GPU-second', index: 1, name: 'Second' },
          ],
        };
      }
      if (path === '/api/settings/compute-device') {
        if (retried && failRefetch === 'compute') throw new Error('Refetch failed');
        return { value: 'auto', effective_family: 'cuda', available_families: ['cpu', 'cuda'] };
      }
      if (path === '/model/loaded') return { models: [], count: 0 };
      return {};
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PerformanceSettings />
      </QueryClientProvider>,
    );
    const selector = await screen.findByRole('button', { name: 'Choose adapter' });
    await waitFor(() => expect(selector).toBeEnabled());
    fireEvent.click(selector);
    await screen.findByRole('alert');
    retried = true;
    const reads = (endpoint: string) =>
      mock.api.mock.calls.filter(
        ([path, init]) => path === endpoint && (!init?.method || init.method === 'GET'),
      ).length;
    const endpoints = ['/api/settings/compute-device', '/api/settings/cuda-device'];
    const beforeRetry = endpoints.map(reads);
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() =>
      endpoints.forEach((endpoint, index) => {
        expect(reads(endpoint)).toBe(beforeRetry[index] + 1);
      }),
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    if (failRefetch) expect(screen.getByRole('alert')).toBeInTheDocument();
    else await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  },
);

it('reports a refused unload as a failure, not as memory freed', async () => {
  mock.api.mockImplementation(async (path: string) => {
    if (path === '/model/loaded')
      return {
        models: [{ id: 'capture-asr', name: 'Dictation', checkpoint: 'sherpa', unloadable: true }],
        count: 1,
      };
    if (path === '/model/unload/capture-asr')
      // The backend answers a refusal with HTTP 200 and `success: false`.
      return {
        unloaded: 'capture-asr',
        success: false,
        reason: 'in use by dictation',
        reason_code: 'in_use_dictation',
      };
    if (path === '/api/settings/cuda-device') return { value: 'auto', devices: [] };
    if (path === '/api/settings/compute-device')
      return { value: 'auto', effective_family: 'cpu', available_families: ['cpu'] };
    return {};
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PerformanceSettings />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'header.unload' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('modelMaintenance.unloadFailed'));
  expect(toast.success).not.toHaveBeenCalled();
  expect(mock.api).toHaveBeenCalledWith('/model/unload/capture-asr', { method: 'POST' });
});
