import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (actual) => ({
  ...(await actual<typeof import('@/lib/api/client')>()),
  apiJson: api,
}));
import {
  settingsChanged,
  usePreviewLock,
  usePreviewSettings,
  useRetakeHearing,
} from './preview-run';

afterEach(() => {
  vi.clearAllMocks();
});

function hearing() {
  const stopPassage = vi.fn();
  const view = renderHook(() => {
    const lock = usePreviewLock();
    return { lock, hear: useRetakeHearing(lock, stopPassage) };
  });
  return { view, stopPassage };
}

it('plays a retake at once when no preview renders', () => {
  const { view } = hearing();
  const play = vi.fn();
  const later = vi.fn();
  view.result.current.hear(0, { play, later });
  expect(play).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
});

it('stops a passage preview reading the old take, and plays the retake once it has stopped', () => {
  const { view, stopPassage } = hearing();
  act(() => void view.result.current.lock.acquire('passage'));
  const play = vi.fn();
  view.result.current.hear(0, { play, later: vi.fn() });
  expect(stopPassage).toHaveBeenCalledOnce();
  expect(play).not.toHaveBeenCalled();
  act(() => view.result.current.lock.release());
  expect(play).toHaveBeenCalledOnce();
});

it('waits for a preview of the retaken chapter, which stops itself, and lets another chapter render on', () => {
  const { view, stopPassage } = hearing();
  act(() => void view.result.current.lock.acquire('chapter', 2));
  expect(view.result.current.lock.chapter).toBe(2);
  const elsewhere = { play: vi.fn(), later: vi.fn() };
  view.result.current.hear(0, elsewhere);
  expect(elsewhere.later).toHaveBeenCalledOnce();
  const here = { play: vi.fn(), later: vi.fn() };
  view.result.current.hear(2, here);
  expect(stopPassage).not.toHaveBeenCalled();
  expect(here.play).not.toHaveBeenCalled();
  act(() => view.result.current.lock.release());
  expect(here.play).toHaveBeenCalledOnce();
  expect(elsewhere.play).not.toHaveBeenCalled();
  expect(view.result.current.lock.chapter).toBeNull();
});

it('compares preview settings only when both sides are known', () => {
  expect(settingsChanged('a', 'b')).toBe(true);
  expect(settingsChanged('a', 'a')).toBe(false);
  expect(settingsChanged(null, 'b')).toBe(false);
  expect(settingsChanged('a', null)).toBe(false);
});

it("holds the engine's sampling and the app's reading, unless the project reads its own way", async () => {
  let steps = 8;
  api.mockImplementation(async (path: string) => {
    if (path === '/audiobook/sampling')
      return { engine: 'omnivoice', num_step: steps, guidance_scale: 2, postprocess_output: false };
    if (path === '/api/settings/reading')
      return { phrase_rendering: true, punctuation_pauses: null, split_commas: false, verify_speech: false };
    throw new Error(path);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    ({ own }: { own?: { phraseRendering: boolean } }) => usePreviewSettings(own as never),
    { wrapper, initialProps: {} },
  );
  await waitFor(() => expect(view.result.current).not.toBeNull());
  const fast = view.result.current!;
  expect(fast).toContain('"num_step":8');
  // The performance preset changed: the sampling is asked again.
  steps = 32;
  await act(() => client.invalidateQueries({ queryKey: ['longform-sampling'] }));
  await waitFor(() => expect(view.result.current).not.toBe(fast));
  expect(settingsChanged(fast, view.result.current)).toBe(true);
  // A project with its own reading does not follow Settings → Reading.
  view.rerender({ own: { phraseRendering: false } });
  expect(view.result.current).not.toContain('phraseRendering');
});
