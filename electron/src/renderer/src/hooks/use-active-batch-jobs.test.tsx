import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noteBackendStage } from '@/lib/status-polling';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiJson: mock.api }));

import { useActiveBatchJobs } from './use-active-batch-jobs';

let client: QueryClient;

beforeEach(() => {
  mock.api.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  client.clear();
  vi.useRealTimers();
  noteBackendStage('ready');
});

async function advance(ms: number) {
  const before = mock.api.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  return mock.api.mock.calls.length - before;
}

/** The status bar, the performance presets, the update check and the Batch page. */
async function watchQueue(jobs: unknown[]) {
  mock.api.mockResolvedValue(jobs);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => [
      useActiveBatchJobs(),
      useActiveBatchJobs(),
      useActiveBatchJobs(false),
      useActiveBatchJobs(),
    ],
    { wrapper },
  );
  await advance(0);
  return view;
}

it('checks an idle queue every 30 seconds however many surfaces watch it', async () => {
  await watchQueue([]);
  expect(mock.api).toHaveBeenCalledTimes(1);
  expect(await advance(120_000)).toBe(4);
  expect(new Set(mock.api.mock.calls.map(([path]) => path))).toEqual(
    new Set(['/batch/jobs?status=active&limit=100']),
  );
});

it('follows running jobs every second, and every five while the backend is busy', async () => {
  await watchQueue([{ id: 'job', status: 'running' }]);
  expect(await advance(10_000)).toBe(10);
  noteBackendStage('unresponsive');
  await advance(1_000);
  expect(await advance(30_000)).toBe(6);
});

it('reuses the list when a surface remounts within one poll', async () => {
  const view = await watchQueue([]);
  view.unmount();
  await advance(10_000);
  renderHook(() => useActiveBatchJobs(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  expect(await advance(0)).toBe(0);
});
