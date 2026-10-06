import { Profiler, type ReactNode, type Ref } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    useMediaTime: <T,>(select: (time: number) => T) =>
      useSyncExternalStore(subscribe, () => select(media.get('currentTime'))),
  };
});

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (original) => ({
  ...(await original<typeof import('@/lib/api/client')>()),
  apiJson: api,
}));

import { ApiError } from '@/lib/api/client';
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

// Every commit inside the player, as React's profiler reports it.
const commits = { count: 0, ms: 0 };
const renderPlayer = (output?: string, book = { script, chapters }) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Profiler
        id="player"
        onRender={(_id, _phase, actualDuration) => {
          commits.count++;
          commits.ms += actualDuration;
        }}
      >
        <SyncedAudiobookPlayer
          src="/api/audio/book.m4b"
          script={book.script}
          chapters={book.chapters}
          output={output}
        />
      </Profiler>
    </QueryClientProvider>,
  );
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
  // A timeline runs left to right in every language, its fill and marks too.
  expect(screen.getByRole('slider', { name: 'Seek' }).closest('[dir]')).toHaveAttribute(
    'dir',
    'ltr',
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

// The render's timeline: chapter One timed take by take, with silences
// between; chapter Two known only by its span.
const sidecar = {
  version: 1,
  output: 'audiobook_one.m4b',
  duration: 14,
  chapters: [
    {
      title: 'One',
      start: 0,
      end: 8,
      precision: 'phrase',
      phrases: [
        { text: 'Alpha beta.', start: 1, end: 3, voice: null },
        { text: 'Gamma delta.', start: 5, end: 7, voice: null },
      ],
    },
    {
      title: 'Two',
      start: 8,
      end: 14,
      precision: 'span',
      phrases: [{ text: 'Epsilon zeta eta.', start: 8.5, end: 13, voice: null }],
    },
  ],
};

it('follows the timeline sidecar exactly, phrase by phrase', async () => {
  api.mockResolvedValue(sidecar);
  renderPlayer('audiobook_one.m4b');
  expect(api).toHaveBeenCalledWith(
    '/audiobook/timeline/audiobook_one.m4b',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const { dialog, pane } = await openReader();
  // Before the first take starts nothing is lit.
  await waitFor(() => expect(within(pane).queryByText('Alpha')).toBeNull());
  expect(pane.querySelector('[aria-current]')).toBeNull();
  // A phrase-timed chapter needs no estimate note.
  expect(within(dialog).queryByText(/Word timing is estimated/)).toBeNull();

  advance(1);
  expect(within(pane).getByText('Alpha')).toHaveAttribute('aria-current', 'true');
  advance(4); // the silence after the first take: it stays lit
  expect(within(pane).getByText('beta.')).toHaveAttribute('aria-current', 'true');
  expect(within(pane).getByText('beta.').parentElement).toHaveClass('bg-primary/10');
  advance(5); // the next take, to the millisecond
  expect(within(pane).getByText('Gamma')).toHaveAttribute('aria-current', 'true');
  expect(within(pane).getByText('Alpha beta.')).not.toHaveClass('bg-primary/10');

  fireEvent.click(within(pane).getByText('delta.'));
  expect(media.get('currentTime')).toBeCloseTo(6.001, 6);

  advance(9); // chapter Two is only timed by its span
  expect(within(dialog).getByText(/Word timing is estimated/)).toBeVisible();
});

it('estimates the timing when the book has no timeline', async () => {
  api.mockRejectedValue(new ApiError(404, 'Not found'));
  renderPlayer('audiobook_old.m4b');
  await waitFor(() => expect(api).toHaveBeenCalledOnce());
  await act(async () => {});
  const { dialog, pane } = await openReader();
  // Two seconds a word, from the stream's chapter durations.
  expect(within(pane).getByText('Alpha')).toHaveAttribute('aria-current', 'true');
  expect(within(dialog).getByText(/Word timing is estimated/)).toBeVisible();
});

it('ignores a timeline written for another file and asks for none without an output', async () => {
  api.mockResolvedValue({ ...sidecar, output: 'audiobook_two.m4b' });
  renderPlayer('audiobook_one.m4b');
  await waitFor(() => expect(api).toHaveBeenCalledOnce());
  await act(async () => {});
  const { dialog, pane } = await openReader();
  expect(within(pane).getByText('Alpha')).toHaveAttribute('aria-current', 'true');
  expect(within(dialog).getByText(/Word timing is estimated/)).toBeVisible();

  api.mockClear();
  renderPlayer();
  expect(api).not.toHaveBeenCalled();
});

it('commits nothing on clock ticks that change no word, second or seek-bar step', async () => {
  renderPlayer();
  advance(4.1);
  const { pane } = await openReader();
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  commits.count = 0;
  // The media clock ticks every animation frame; Gamma is read from 4 s to 6 s.
  for (const time of [4.2, 4.4, 4.6, 4.8, 4.95]) advance(time);
  expect(commits.count).toBe(0);
  expect(observer.takeRecords()).toEqual([]);

  advance(6.1);
  expect(commits.count).toBeGreaterThan(0);
  expect(within(pane).getByText('delta.')).toHaveAttribute('aria-current', 'true');
  observer.disconnect();
});

// While a book plays the media clock ticks every animation frame. jsdom has
// no layout engine, so this counts what makes Chromium do layout and style
// work (Performance.getMetrics' LayoutCount / RecalcStyleCount): frames with
// DOM writes that move or resize boxes, frames with any DOM write, reads of
// layout values, and React commits.
describe('playback cost', () => {
  const FRAME_S = 1 / 60;
  const SECONDS = 10;
  // 1,500 words in three chapters of ten paragraphs, read at 2.5 words a second.
  const sentence = 'Sentence ' + 'word '.repeat(8) + 'end.';
  const paragraph = Array.from({ length: 5 }, () => sentence).join(' ');
  const longBook = {
    script: [1, 2, 3]
      .map((n) => `# Chapter ${n}\n` + Array.from({ length: 10 }, () => paragraph).join('\n\n'))
      .join('\n\n'),
    chapters: [1, 2, 3].map((n) => ({ title: `Chapter ${n}`, status: 'done', duration_s: 200 })),
  };

  // Seek bars 652px wide, as in the app's dialog and card.
  class FixedWidthObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const entry = { target, contentRect: { width: 652, height: 20 } };
      this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }

  function spyLayout() {
    const counts = { reads: 0, valueWrites: 0 };
    const restore: Array<() => void> = [];
    const wrap = (target: object, name: string, wrapped: (d: PropertyDescriptor) => object) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (!descriptor) return;
      const patch = wrapped(descriptor);
      // A method replaces an accessor outright: a descriptor holds one kind.
      const { get: _get, set: _set, ...data } = descriptor;
      Object.defineProperty(target, name, { ...('value' in patch ? data : descriptor), ...patch });
      restore.push(() => Object.defineProperty(target, name, descriptor));
    };
    const read = (descriptor: PropertyDescriptor) => ({
      get(this: unknown) {
        counts.reads++;
        return descriptor.get?.call(this);
      },
    });
    // A method, whichever way jsdom defines it.
    const call = (descriptor: PropertyDescriptor) => {
      const method = (descriptor.value ?? descriptor.get?.call(window)) as (
        ...args: unknown[]
      ) => unknown;
      return {
        writable: true,
        value(this: unknown, ...args: unknown[]) {
          counts.reads++;
          return method.apply(this, args);
        },
      };
    };
    for (const name of ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight']) {
      wrap(HTMLElement.prototype, name, read);
    }
    for (const name of [
      'clientWidth',
      'clientHeight',
      'scrollTop',
      'scrollLeft',
      'scrollWidth',
      'scrollHeight',
    ]) {
      wrap(Element.prototype, name, read);
    }
    wrap(Element.prototype, 'getBoundingClientRect', call);
    wrap(Element.prototype, 'getClientRects', call);
    wrap(window, 'getComputedStyle', call);
    // React tracks an input's value through the prototype's setter it finds
    // at mount, so this goes in before the first render.
    wrap(HTMLInputElement.prototype, 'value', (descriptor) => ({
      set(this: HTMLInputElement, value: unknown) {
        if (String(value) !== descriptor.get?.call(this)) counts.valueWrites++;
        descriptor.set?.call(this, value);
      },
    }));
    return { counts, restore: () => restore.reverse().forEach((undo) => undo()) };
  }

  async function measurePlayback({ reader }: { reader: boolean }) {
    vi.stubGlobal('ResizeObserver', FixedWidthObserver);
    const layout = spyLayout();
    const observer = new MutationObserver(() => {});
    try {
      media.set({ duration: 600, currentTime: 30 });
      renderPlayer(undefined, longBook);
      if (reader) await openReader();
      advance(30);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      observer.takeRecords();
      Object.assign(layout.counts, { reads: 0, valueWrites: 0 });
      Object.assign(commits, { count: 0, ms: 0 });
      let layoutFrames = 0;
      let styleFrames = 0;
      for (let frame = 1; frame <= SECONDS * 60; frame++) {
        const writes = layout.counts.valueWrites;
        advance(30 + frame * FRAME_S);
        const records = observer.takeRecords();
        const moved =
          layout.counts.valueWrites > writes ||
          records.some(
            (record) => record.type !== 'attributes' || record.attributeName === 'style',
          );
        if (moved) layoutFrames++;
        if (moved || records.length) styleFrames++;
      }
      const perSecond = (value: number) => Math.round((value / SECONDS) * 10) / 10;
      return {
        layoutFrames: perSecond(layoutFrames),
        styleFrames: perSecond(styleFrames),
        layoutReads: perSecond(layout.counts.reads),
        commits: perSecond(commits.count),
        renderMs: perSecond(commits.ms),
      };
    } finally {
      observer.disconnect();
      layout.restore();
      vi.unstubAllGlobals();
    }
  }

  it.each([{ reader: false }, { reader: true }])(
    'stays light while a long book plays (reader open: $reader)',
    async ({ reader }) => {
      const cost = await measurePlayback({ reader });
      console.info(`playback cost per second, reader open: ${reader}`, cost);
      // A word changes 2.5 times a second, the clock and the seek thumb about once.
      expect(cost.layoutFrames).toBeLessThan(5);
      expect(cost.styleFrames).toBeLessThan(6);
      expect(cost.commits).toBeLessThan(6);
      expect(cost.layoutReads).toBeLessThan(40);
    },
    30_000,
  );
});
