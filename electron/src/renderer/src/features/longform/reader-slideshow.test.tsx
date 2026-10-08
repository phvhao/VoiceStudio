import type { ReactNode, Ref } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';

// One fake media element behind the card and the reader (as in
// synced-audiobook-player.test.tsx).
const media = vi.hoisted(() => {
  const initial = { paused: true, currentTime: 0, duration: 14, playbackRate: 1, error: null as unknown };
  type State = typeof initial;
  const listeners = new Set<() => void>();
  let state: State = { ...initial };
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    listeners,
    set,
    get: <K extends keyof State>(key: K): State[K] => state[key],
    reset: () => {
      state = { ...initial };
    },
    instance: {
      get paused() {
        return state.paused;
      },
      get duration() {
        return state.duration;
      },
      get currentTime() {
        return state.currentTime;
      },
      set currentTime(time: number) {
        set({ currentTime: time });
      },
      get playbackRate() {
        return state.playbackRate;
      },
      play: vi.fn(async () => set({ paused: false })),
      pause: vi.fn(async () => set({ paused: true })),
    },
  };
});

vi.mock('@/components/media-player', async () => {
  const { useImperativeHandle, useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    media.listeners.add(listener);
    return () => void media.listeners.delete(listener);
  };
  return {
    StudioMediaPlayer: ({ playerRef, children }: { playerRef: Ref<unknown>; children: ReactNode }) => {
      useImperativeHandle(playerRef, () => media.instance);
      return <div>{children}</div>;
    },
    MediaProvider: () => <audio />,
    audioLoaders: [],
    audioSource: (src: string) => ({ src }),
    useMediaState: (key: 'currentTime') => useSyncExternalStore(subscribe, () => media.get(key)),
    useMediaTime: <T,>(select: (time: number) => T) =>
      useSyncExternalStore(subscribe, () => select(media.get('currentTime'))),
  };
});

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (original) => ({
  ...(await original<typeof import('@/lib/api/client')>()),
  apiJson: api,
}));

import { SyncedAudiobookPlayer } from './synced-audiobook-player';

const script = '# One\nAlpha beta. Gamma delta.\n\n# Two\nEpsilon zeta eta.';
const chapters = [
  { title: 'One', status: 'done', duration_s: 8 },
  { title: 'Two', status: 'done', duration_s: 6 },
];
// Two seconds a word; pictures change at "Gamma" (4 s) and back to the
// cover at chapter Two (8 s).
const timeline = {
  version: 1,
  output: 'book.m4b',
  duration: 14,
  chapters: [
    {
      title: 'One',
      start: 0,
      end: 8,
      precision: 'phrase',
      phrases: [
        { text: 'Alpha beta.', start: 0, end: 4, voice: null },
        { text: 'Gamma delta.', start: 4, end: 8, voice: null },
      ],
      sections: [],
      images: [
        { phrase: 0, start: 0, name: 'dawn.jpg', fit: 'auto' },
        { phrase: 1, start: 4, name: 'noon.png', fit: 'contain' },
      ],
    },
    {
      title: 'Two',
      start: 8,
      end: 14,
      precision: 'phrase',
      phrases: [{ text: 'Epsilon zeta eta.', start: 8, end: 14, voice: null }],
      sections: [],
      images: [{ phrase: 0, start: 8, name: null, fit: 'auto' }],
    },
  ],
};

beforeEach(() => {
  media.reset();
  api.mockImplementation(async (path: string) => {
    if (path.startsWith('/audiobook/timeline/')) return timeline;
    throw new Error('unexpected ' + path);
  });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

const renderPlayer = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SyncedAudiobookPlayer
        src="/api/audio/book.m4b"
        script={script}
        chapters={chapters}
        output="book.m4b"
        cover="/api/audio/audiobook_covers/ab12cd34ef56.png"
      />
    </QueryClientProvider>,
  );
const advance = (time: number) => act(() => media.set({ currentTime: time }));
const current = () =>
  screen.getByTestId('slideshow-current').querySelector('.slideshow-picture')?.getAttribute('src');

it('opens straight into the slideshow: the picture of the moment and the words being read', async () => {
  renderPlayer();
  await waitFor(() => expect(api).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Slideshow' }));
  const dialog = await screen.findByRole('dialog', { name: 'Follow along' });
  expect(within(dialog).getByRole('radio', { name: 'Slideshow' })).toHaveAttribute('aria-checked', 'true');
  await waitFor(() => expect(current()).toMatch(/\/longform\/images\/dawn\.jpg$/));

  await advance(2.5);
  const caption = dialog.querySelector('.slideshow-caption')!;
  expect(caption.textContent).toBe('Alpha beta.');
  expect(caption.querySelector('.is-on')?.textContent).toBe('beta.');
  expect(caption.querySelector('.is-read')?.textContent).toBe('Alpha');

  // The next picture, at the sentence its tag stands before.
  await advance(4.2);
  expect(current()).toMatch(/\/longform\/images\/noon\.png$/);
  expect(dialog.querySelector('.slideshow-caption')!.textContent).toBe('Gamma delta.');

  // `[image: none]`: the cover again.
  await advance(9);
  expect(current()).toBe('/api/audio/audiobook_covers/ab12cd34ef56.png');
});

it('switches between the transcript and the slideshow, and remembers the last view', async () => {
  renderPlayer();
  await waitFor(() => expect(api).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Open reader' }));
  const dialog = await screen.findByRole('dialog', { name: 'Follow along' });
  expect(within(dialog).getByRole('region', { name: 'Transcript' })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Slideshow' }));
  expect(within(dialog).getByTestId('reader-slideshow')).toBeInTheDocument();
  expect(within(dialog).queryByRole('region', { name: 'Transcript' })).toBeNull();
  // Closed and opened again: the reader keeps the listener's view.
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Open reader' }));
  const again = await screen.findByRole('dialog', { name: 'Follow along' });
  expect(within(again).getByTestId('reader-slideshow')).toBeInTheDocument();
  fireEvent.click(within(again).getByRole('radio', { name: 'Read' }));
  expect(within(again).getByRole('region', { name: 'Transcript' })).toBeInTheDocument();
});
