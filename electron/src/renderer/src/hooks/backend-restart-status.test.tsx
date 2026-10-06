import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noteBackendStage } from '@/lib/status-polling';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiJson: mock.api }));

import { useModelCatalogue } from '@/features/settings/model-catalogue-query';
import { useActiveBatchJobs } from './use-active-batch-jobs';
import { useComputeTarget } from './use-compute-target';
import { useEngines } from './use-engines';
import { usePerformanceProfile } from './use-performance-profile';

const ANSWERS: Record<string, unknown> = {
  '/batch/jobs?status=active&limit=100': [],
  '/workers/target': { target: 'local', active: { remote: false }, targets: [] },
  '/api/settings/performance-profile': { global: 'balanced' },
  '/engines': { tts: { active: 'omnivoice', backends: [{ id: 'omnivoice', available: true }] } },
  '/models': { models: [] },
};

beforeEach(() => {
  vi.useFakeTimers();
  mock.api.mockImplementation(async (path: string) => ANSWERS[path]);
});

afterEach(() => {
  vi.useRealTimers();
  noteBackendStage('ready');
});

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** What was asked since the last call, in path order. */
function asked() {
  const paths = mock.api.mock.calls.map(([path]) => String(path)).sort();
  mock.api.mockClear();
  return paths;
}

/**
 * The status polls the sidebar and Settings mount. Each keeps its answer for
 * one poll, so the sidebar remounting on a Settings visit asks nothing again;
 * but the workspace remounts the same way once a crashed backend is back, and
 * then showed the dead process's answers: its loaded models, its jobs, its route.
 */
it('asks every status poll again once a restarted backend is back', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const surfaces = () => [
    useActiveBatchJobs(),
    useComputeTarget(),
    usePerformanceProfile(),
    useEngines(),
    useModelCatalogue(),
  ];
  const everything = Object.keys(ANSWERS).sort();
  const first = renderHook(surfaces, { wrapper });
  await wait(0);
  expect(asked()).toEqual(everything);
  first.unmount();
  await wait(4_000);
  renderHook(surfaces, { wrapper }).unmount();
  await wait(0);
  expect(asked()).toEqual([]);

  // The backend crashes; Retry brings it back a few seconds later, and the
  // workspace mounts again.
  noteBackendStage('crashed');
  await wait(4_000);
  noteBackendStage('ready');
  renderHook(surfaces, { wrapper });
  await wait(0);
  expect(asked()).toEqual(everything);
  client.clear();
});
