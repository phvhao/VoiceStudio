import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiJson: mock.api }));

import {
  COMPUTE_TARGET_QUERY_KEY,
  computeTargetForOperation,
  selectComputeTarget,
  useComputeTarget,
  type ComputeTargetState,
} from './use-compute-target';
import { cachedTtsLanguagesSupported } from '@/lib/language-options';

beforeEach(() => mock.api.mockReset());

const workerChosen: ComputeTargetState = {
  target: 'worker-1',
  op: '',
  active: { remote: true, worker_id: 'worker-1', label: 'Studio GPU', reason: 'chosen' },
  remote_operations: ['clone', 'dub', 'tts'],
  targets: [],
};

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

it('serves every surface from one target-wide request', async () => {
  mock.api.mockResolvedValue(workerChosen);
  const { wrapper } = harness();

  // The status bar, a page's readiness check and its language picker.
  const result = renderHook(
    () => [useComputeTarget(true), useComputeTarget(true, 'dub'), useComputeTarget(true, 'design')],
    { wrapper },
  );
  await waitFor(() => expect(result.result.current.every((query) => query.isSuccess)).toBe(true));

  expect(mock.api).toHaveBeenCalledTimes(1);
  expect(mock.api).toHaveBeenCalledWith('/workers/target', { signal: expect.any(AbortSignal) });
  const [target, dub, design] = result.result.current.map((query) => query.data!);
  expect(target).toBe(workerChosen);
  expect(dub).toMatchObject({ op: 'dub', active: { remote: true, worker_id: 'worker-1' } });
  // No worker runs Voice Design, so it stays on this machine.
  expect(design).toMatchObject({ op: 'design', active: { remote: false, label: 'Local' } });
});

it('derives each operation the way the backend does', () => {
  const local = {
    ...workerChosen,
    target: 'local',
    active: { remote: false, label: 'Local', reason: 'chosen' },
  };
  expect(computeTargetForOperation(undefined, 'dub')).toBeUndefined();
  expect(computeTargetForOperation(workerChosen, '')).toBe(workerChosen);
  expect(computeTargetForOperation(local, 'design')!.active).toBe(local.active);
  expect(computeTargetForOperation(workerChosen, 'tts')!.active).toBe(workerChosen.active);
  expect(computeTargetForOperation(workerChosen, 'compare')!.active.remote).toBe(false);
  // A control plane without per-operation routing routes every surface alike.
  const { remote_operations: _, ...older } = workerChosen;
  expect(computeTargetForOperation(older as ComputeTargetState, 'compare')!.active.remote).toBe(
    true,
  );
});

it('reuses a fresh answer when the sidebar remounts', async () => {
  mock.api.mockResolvedValue({ ...workerChosen, targets: [] });
  const { wrapper } = harness();
  const first = renderHook(() => useComputeTarget(true), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  first.unmount();

  const second = renderHook(() => useComputeTarget(true, 'clone'), { wrapper });
  await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
  expect(mock.api).toHaveBeenCalledTimes(1);
});

it('feeds the language guard from the same answer the hooks fetched', async () => {
  // The guard must read the shared snapshot: per-operation entries no longer
  // exist, and a missing target reads as "unknown", which lets every language through.
  const { client, wrapper } = harness();
  client.setQueryData(['engines'], {
    tts: { active: 'kitten', backends: [{ id: 'kitten', supported_language_names: ['english'] }] },
  });
  mock.api.mockResolvedValue({
    ...workerChosen,
    target: 'local',
    active: { remote: false, label: 'Local', reason: 'chosen' },
  });
  const local = renderHook(() => useComputeTarget(true, 'clone'), { wrapper });
  await waitFor(() => expect(local.result.current.isSuccess).toBe(true));
  expect(cachedTtsLanguagesSupported(client, 'clone', ['Japanese'])).toBe(false);
  expect(cachedTtsLanguagesSupported(client, 'clone', ['English'])).toBe(true);

  // A worker's own models are unknown here, so nothing is blocked for it, but
  // a surface no worker runs is still checked against the local model.
  client.setQueryData(COMPUTE_TARGET_QUERY_KEY, workerChosen);
  expect(cachedTtsLanguagesSupported(client, 'clone', ['Japanese'])).toBe(true);
  expect(cachedTtsLanguagesSupported(client, 'compare', ['Japanese'])).toBe(false);
});

it('refreshes models, engines and performance after switching compute target', async () => {
  const state = {
    target: 'worker-1',
    op: 'tts',
    active: { remote: true, worker_id: 'worker-1', label: 'Studio GPU', reason: 'selected' },
    remote_operations: ['tts'],
    targets: [],
  };
  mock.api.mockResolvedValue(state);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');

  await expect(selectComputeTarget(client, 'worker-1')).resolves.toEqual(state);

  expect(mock.api).toHaveBeenCalledWith('/workers/target', {
    method: 'POST',
    body: JSON.stringify({ target: 'worker-1' }),
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance-profile'] });
  // A chapter rendered on a worker is cached under its own key.
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['audiobook-outline'] });
});
