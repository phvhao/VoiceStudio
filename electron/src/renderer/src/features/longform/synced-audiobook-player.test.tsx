import type { ReactNode, Ref } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';

// One fake media element behind every useMediaState in the card and the
// reader, so the tests see that both drive the same audio.
const media = vi.hoisted(() => {
  const initial = {
    paused: true,
    currentTime: 0,
    duration: 14,
    playbackRate: 1,
    canPlay: true,
    waiting: false,
    error: null as unknown,
  };
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
      set playbackRate(rate: number) {
        set({ playbackRate: rate });
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
    StudioMediaPlayer: ({
      playerRef,
      className,
      children,
    }: {
      playerRef: Ref<unknown>;
      className?: string;
      children: ReactNode;
    }) => {
      useImperativeHandle(playerRef, () => media.instance);
      return <div className={className}>{children}</div>;
    },
    MediaProvider: () => <audio />,
    audioLoaders: [],
    audioSource: (src: string) => ({ src }),
    useMediaState: (key: 'currentTime') => useSyncExternalStore(subscribe, () => media.get(key)),
  };
});

import { SyncedAudiobookPlayer } from './synced-audiobook-player';

// Two seconds a word: Alpha 0, beta. 2, Gamma 4, delta. 6 | Epsilon 8, zeta 10, eta. 12.
const script = '# One\nAlpha beta. Gamma delta.\n\n# Two\nEpsilon zeta eta.';
const chapters = [
  { title: 'One', status: 'done', duration_s: 8 },
  { title: 'Two', status: 'done', duration_s: 6 },
];

const scrollIntoView = vi.fn();
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  if (options.top !== undefined) this.scrollTop = options.top;
  if (options.left !== undefined) this.scrollLeft = options.left;
});

beforeEach(() => {
  media.reset();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
});

afterEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  Reflect.deleteProperty(document, 'caretRangeFromPoint');
});

const renderPlayer = () =>
  render(<SyncedAudiobookPlayer src="/api/audio/book.m4b" script={script} chapters={chapters} />);
const advance = (time: number) => act(() => media.set({ currentTime: time }));
async function openReader() {
  fireEvent.click(screen.getByRole('button', { name: 'Open reader' }));
  const dialog = await screen.findByRole('dialog', { name: 'Follow along' });
  return { dialog, pane: within(dialog).getByRole('region', { name: 'Transcript' }) };
}

it('shows a compact now-playing card instead of a transcript on the page', () => {
  renderPlayer();
  expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute(
    'aria-valuetext',
    '0:00 / 0:14',
  );
  expect(screen.getByText('0:00 / 0:14')).toBeVisible();
  expect(screen.getByText('One')).toBeVisible();
  expect(screen.getByText('1/2')).toBeVisible();
  expect(document.querySelectorAll('[data-chapter-mark]')).toHaveLength(1);
  expect(screen.getByText('Alpha')).toHaveClass('text-primary');
  expect(screen.getByText('beta.')).not.toHaveClass('text-primary');
  expect(screen.queryByRole('region')).toBeNull();

  advance(4.5);
  expect(screen.getByText('Gamma')).toHaveClass('text-primary');
  expect(screen.queryByText('Alpha')).toBeNull();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it('steps between chapters and changes the playback speed', async () => {
  renderPlayer();
  fireEvent.click(screen.getByRole('button', { name: 'Next chapter' }));
  expect(media.get('currentTime')).toBe(8);
  expect(screen.getByText('Two')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next chapter' })).toBeDisabled();

  advance(9);
  fireEvent.click(screen.getByRole('button', { name: 'Previous chapter' }));
  expect(media.get('currentTime')).toBe(0);

  fireEvent.click(screen.getByRole('button', { name: 'Playback speed: 1×' }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '1.5×' }));
  expect(media.get('playbackRate')).toBe(1.5);
  expect(screen.getByRole('button', { name: 'Playback speed: 1.5×' })).toBeVisible();
});

it('opens the reader on the same audio, grouped by chapter', async () => {
  renderPlayer();
  const { dialog, pane } = await openReader();
  expect(within(pane).getByRole('button', { name: 'One' })).toBeVisible();
  expect(within(pane).getByRole('button', { name: 'Two' })).toBeVisible();
  expect(pane).toHaveTextContent('Alpha beta. Gamma delta.');
  expect(within(dialog).getByText(/Chapter 1 of 2/)).toBeVisible();
  expect(within(dialog).getByText(/Word timing is estimated/)).toBeVisible();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Play' }));
  expect(media.instance.play).toHaveBeenCalledOnce();
  expect(within(dialog).getByRole('button', { name: 'Pause' })).toBeVisible();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(media.instance.pause).not.toHaveBeenCalled();
});

it('plays from a clicked word', async () => {
  renderPlayer();
  advance(4.5);
  const { pane } = await openReader();
  expect(within(pane).getByText('Gamma')).toHaveAttribute('aria-current', 'true');
  fireEvent.click(within(pane).getByText('delta.'));
  expect(media.get('currentTime')).toBeCloseTo(6.001, 6);
  expect(media.instance.play).toHaveBeenCalledOnce();
});

it('maps a click on a sentence shown as text to the word under the caret', async () => {
  renderPlayer();
  const { pane } = await openReader();
  const sentence = within(pane).getByText('Epsilon zeta eta.');
  const text = sentence.firstChild as Text;
  Object.defineProperty(document, 'caretRangeFromPoint', {
    configurable: true,
    value: () => {
      const range = document.createRange();
      range.setStart(text, 'Epsilon ze'.length);
      return range;
    },
  });
  fireEvent.click(sentence);
  expect(media.get('currentTime')).toBeCloseTo(10.001, 6);
});

it('follows reading inside the reader only, pauses on a manual scroll and resumes from the pill', async () => {
  // Layout jsdom lacks: word N sits N * 100px down a 200px-tall pane.
  const region = (element: HTMLElement) => element.getAttribute('role') === 'region';
  const layout: Record<string, PropertyDescriptor> = {
    offsetTop: {
      get(this: HTMLElement) {
        return Number(this.dataset.word ?? 0) * 100;
      },
    },
    offsetHeight: { get: () => 20 },
    clientHeight: {
      get(this: HTMLElement) {
        return region(this) ? 200 : 0;
      },
    },
    scrollHeight: {
      get(this: HTMLElement) {
        return region(this) ? 2000 : 0;
      },
    },
  };
  const saved = Object.keys(layout).map(
    (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
  );
  for (const [name, descriptor] of Object.entries(layout)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
  }
  try {
    renderPlayer();
    const { dialog, pane } = await openReader();
    expect(scrollTo).not.toHaveBeenCalled();

    advance(8.5); // Epsilon, 400px down
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 340, behavior: 'auto' });
    expect(pane.scrollTop).toBe(340);

    fireEvent.wheel(pane, { deltaY: 120 });
    const pill = within(dialog).getByRole('button', { name: 'Back to the current line' });
    scrollTo.mockClear();
    advance(10.5); // zeta: the listener is reading elsewhere, so the pane stays put
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(pill);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 440, behavior: 'auto' });
    expect(within(dialog).queryByRole('button', { name: 'Back to the current line' })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  }
});

it('plays, pauses and skips from the keyboard, leaving the seek bar its own arrows', async () => {
  renderPlayer();
  const { dialog, pane } = await openReader();
  fireEvent.keyDown(pane, { key: ' ' });
  expect(media.instance.play).toHaveBeenCalledOnce();
  fireEvent.keyDown(pane, { key: 'ArrowRight' });
  expect(media.get('currentTime')).toBe(5);
  fireEvent.keyDown(pane, { key: 'ArrowLeft' });
  expect(media.get('currentTime')).toBe(0);
  fireEvent.keyDown(within(dialog).getByRole('slider', { name: 'Seek' }), { key: 'ArrowRight' });
  expect(media.get('currentTime')).toBe(0);
  fireEvent.keyDown(pane, { key: ' ' });
  expect(media.instance.pause).toHaveBeenCalledOnce();
});
