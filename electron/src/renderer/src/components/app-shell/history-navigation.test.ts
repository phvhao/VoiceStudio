import { createMemoryHistory } from '@tanstack/react-router';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHistoryNavigation,
  createPressPairing,
  historyKey,
  installHistoryInputs,
  ScrollMemory,
  trackScrolling,
  useInstallHistoryNavigation,
  type HistoryPress,
} from './history-navigation';

type HistoryCommandListener = (command: unknown) => void;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const pathOf = (page: { pathname: string } | null) => page?.pathname ?? null;

describe('history navigation', () => {
  it('knows where Back and Forward lead as the user moves through screens', () => {
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const navigation = createHistoryNavigation(history);
    expect(navigation.state()).toMatchObject({ canGoBack: false, canGoForward: false });

    history.push('/dub');
    history.push('/stories');
    expect(pathOf(navigation.state().back)).toBe('/dub');
    expect(navigation.state()).toMatchObject({ canGoBack: true, canGoForward: false });

    expect(navigation.go('back')).toBe(true);
    expect(history.location.pathname).toBe('/dub');
    expect(pathOf(navigation.state().back)).toBe('/');
    expect(pathOf(navigation.state().forward)).toBe('/stories');

    navigation.go('back');
    expect(history.location.pathname).toBe('/');
    expect(navigation.state().canGoBack).toBe(false);
    // Never past the app's first screen.
    expect(navigation.go('back')).toBe(false);
    expect(history.location.pathname).toBe('/');

    navigation.go('forward');
    expect(history.location.pathname).toBe('/dub');
    navigation.dispose();
  });

  it('drops the screens ahead on a new screen and keeps them on a replacement', () => {
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const navigation = createHistoryNavigation(history);
    history.push('/dub');
    history.push('/stories');
    navigation.go('back');
    history.replace('/dub');
    expect(pathOf(navigation.state().forward)).toBe('/stories');
    history.push('/settings/general');
    expect(navigation.state()).toMatchObject({ canGoForward: false, forward: null });
    expect(pathOf(navigation.state().back)).toBe('/dub');
    expect(navigation.go('forward')).toBe(false);
    navigation.dispose();
  });

  it('tells subscribers about every move and stops after dispose', () => {
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const navigation = createHistoryNavigation(history);
    const listener = vi.fn();
    navigation.subscribe(listener);
    history.push('/dub');
    navigation.go('back');
    expect(listener).toHaveBeenCalledTimes(2);
    navigation.dispose();
    history.push('/batch');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('numbers a screen opened by a plain #/ link as the next one, so Back still counts', () => {
    // The router's hash history, as TanStack behaves around a hash change it
    // did not make: the browser's entry has no state and the router counts it
    // as entry 0 under a random key.
    type Notify = (args: { location: unknown; action: { type: string } }) => void;
    const subscribers = new Set<Notify>();
    let browserState: unknown = { __TSR_index: 0, key: 'home', __TSR_key: 'home' };
    const at = (pathname: string, state: object) => ({ pathname, state, href: pathname });
    const history = {
      location: at('/', browserState as object),
      subscribe(callback: Notify) {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
      back: vi.fn(),
      forward: vi.fn(),
    };
    const notify = (location: ReturnType<typeof at>, type: string) => {
      history.location = location;
      subscribers.forEach((callback) => callback({ location, action: { type } }));
    };
    const renumber = vi.fn((state: object) => {
      browserState = state;
      notify(at(history.location.pathname, state), 'REPLACE');
    });
    const navigation = createHistoryNavigation(history as never, {
      browser: { state: () => browserState, renumber },
    });
    browserState = { __TSR_index: 1, key: 'dub', __TSR_key: 'dub' };
    notify(at('/dub', browserState as object), 'PUSH');
    // The plain link: the browser adds an entry without state.
    browserState = null;
    notify(
      at('/settings/models/tts', { __TSR_index: 0, key: 'random', __TSR_key: 'random' }),
      'GO',
    );
    expect(renumber).toHaveBeenCalledWith(expect.objectContaining({ __TSR_index: 2 }));
    expect(history.location.state).toMatchObject({ __TSR_index: 2 });
    expect(pathOf(navigation.state().back)).toBe('/dub');
    expect(navigation.state().canGoBack).toBe(true);
    expect(navigation.go('back')).toBe(true);
    expect(history.back).toHaveBeenCalledOnce();
    navigation.dispose();
  });
});

describe('press pairing', () => {
  const press = (
    source: HistoryPress['source'],
    from: number,
    to = from,
    direction: HistoryPress['direction'] = 'back',
  ): HistoryPress => ({ direction, source, from, to });

  it("drops the window's report of a press the page already took, in either order", () => {
    const accept = createPressPairing(() => 10_000);
    expect(accept(press('page', 1000, 1080))).toBe(true);
    expect(accept(press('window', 1081))).toBe(false);
    expect(accept(press('window', 5000))).toBe(true);
    expect(accept(press('page', 4950, 5002))).toBe(false);
  });

  it('pairs a Linux app command sent on the press with the mouse release', () => {
    const accept = createPressPairing(() => 10_000);
    expect(accept(press('window', 1000))).toBe(true);
    // Button held 600 ms: the release still belongs to the same press.
    expect(accept(press('page', 1000, 1600))).toBe(false);
  });

  it('still goes back twice for two quick presses, however the reports interleave', () => {
    const grouped = createPressPairing(() => 10_000);
    const results = [
      grouped(press('page', 1000, 1050)),
      grouped(press('page', 1150, 1200)),
      grouped(press('window', 1051)),
      grouped(press('window', 1201)),
    ];
    expect(results).toEqual([true, true, false, false]);
    const interleaved = createPressPairing(() => 10_000);
    expect(
      [
        interleaved(press('window', 1050)),
        interleaved(press('page', 1000, 1050)),
        interleaved(press('window', 1200)),
        interleaved(press('page', 1150, 1200)),
      ].filter(Boolean),
    ).toHaveLength(2);
  });

  it('never pairs presses from the same side or in different directions', () => {
    const accept = createPressPairing(() => 10_000);
    expect(accept(press('page', 1000))).toBe(true);
    expect(accept(press('page', 1010))).toBe(true);
    expect(accept(press('window', 1000, 1000, 'forward'))).toBe(true);
  });
});

describe('history keys', () => {
  const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it('uses Alt+arrows on Windows and Linux', () => {
    expect(historyKey(key('ArrowLeft', { altKey: true }), false)).toBe('back');
    expect(historyKey(key('ArrowRight', { altKey: true }), false)).toBe('forward');
    expect(historyKey(key('ArrowLeft'), false)).toBeNull();
    expect(historyKey(key('ArrowLeft', { altKey: true, ctrlKey: true }), false)).toBeNull();
    expect(historyKey(key('ArrowLeft', { altKey: true, shiftKey: true }), false)).toBeNull();
    expect(historyKey(key('[', { metaKey: true }), false)).toBeNull();
  });

  it('uses ⌘[ and ⌘] on a Mac, and the Back/Forward keys everywhere', () => {
    expect(historyKey(key('[', { metaKey: true }), true)).toBe('back');
    expect(historyKey(key(']', { metaKey: true }), true)).toBe('forward');
    expect(historyKey(key('[', { metaKey: true, altKey: true }), true)).toBe('back');
    expect(historyKey(key('ArrowLeft', { altKey: true }), true)).toBeNull();
    expect(historyKey(key('[', { metaKey: true, shiftKey: true }), true)).toBeNull();
    for (const mac of [true, false]) {
      expect(historyKey(key('BrowserBack'), mac)).toBe('back');
      expect(historyKey(key('BrowserForward'), mac)).toBe('forward');
    }
  });
});

describe('history inputs', () => {
  function install({ mac = false } = {}) {
    let command: HistoryCommandListener | null = null;
    const bridge = {
      app: {
        onHistory: (listener: HistoryCommandListener) => {
          command = listener;
          return () => {
            command = null;
          };
        },
      },
    };
    const navigation = { go: vi.fn(() => true), trackScroll: vi.fn() };
    const remove = installHistoryInputs(window, navigation, { mac, bridge: bridge as never });
    return { navigation, remove, command: (payload: unknown) => command?.(payload as never) };
  }

  const keyDown = (target: EventTarget, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const mouse = (type: 'pointerdown' | 'pointerup', button: number, target: Element = document.body) => {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, button });
    target.dispatchEvent(event);
    return event;
  };

  it('goes back on Alt+← outside fields and leaves fields their keys', () => {
    const { navigation, remove } = install();
    const event = keyDown(document.body, { key: 'ArrowLeft', altKey: true });
    expect(navigation.go).toHaveBeenCalledWith('back');
    expect(event.defaultPrevented).toBe(true);

    document.body.innerHTML =
      '<input id="field"><div id="editor" contenteditable="true"></div><div role="slider" id="slider" tabindex="0"></div>';
    for (const id of ['field', 'editor', 'slider']) {
      const typed = keyDown(document.getElementById(id)!, { key: 'ArrowLeft', altKey: true });
      expect(typed.defaultPrevented).toBe(false);
    }
    expect(navigation.go).toHaveBeenCalledOnce();
    remove();
  });

  it('respects a key a part of the page already handled, an IME composition and key repeat', () => {
    const { navigation, remove } = install();
    const handled = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    keyDown(document.body, { key: 'ArrowLeft', altKey: true, isComposing: true });
    keyDown(document.body, { key: 'ArrowLeft', altKey: true, repeat: true });
    expect(navigation.go).not.toHaveBeenCalled();
    remove();
  });

  it('uses ⌘[ on a Mac and goes back with a Back key even from a field', () => {
    const { navigation, remove } = install({ mac: true });
    keyDown(document.body, { key: '[', metaKey: true });
    keyDown(document.body, { key: 'ArrowLeft', altKey: true });
    document.body.innerHTML = '<textarea id="script"></textarea>';
    keyDown(document.getElementById('script')!, { key: 'BrowserBack' });
    expect(navigation.go.mock.calls).toEqual([['back'], ['back']]);
    remove();
  });

  it("takes the mouse's Back/Forward buttons from Chromium so the history moves once", () => {
    const { navigation, remove, command } = install();
    mouse('pointerdown', 3);
    const release = mouse('pointerup', 3);
    expect(release.defaultPrevented).toBe(true);
    // Windows reports the same press to the window as an app command.
    command({ direction: 'back', at: Date.now() });
    expect(navigation.go.mock.calls).toEqual([['back']]);
    mouse('pointerup', 4);
    expect(navigation.go).toHaveBeenLastCalledWith('forward');
    mouse('pointerup', 0);
    expect(navigation.go).toHaveBeenCalledTimes(2);
    remove();
  });

  it('takes the press over a control that cancels its pointerdown to keep the caret', () => {
    // Focus, Import, Paste and Insert cancel pointerdown for every button.
    // That suppresses the mouse events, so a mouseup listener never saw the
    // release: Chromium went back on its own, and Linux's app command,
    // finding no twin, went back again.
    document.body.innerHTML = '<button id="focus">Focus</button>';
    const control = document.getElementById('focus')!;
    control.addEventListener('pointerdown', (event) => event.preventDefault());
    const { navigation, remove, command } = install();
    command({ direction: 'back', at: Date.now() });
    mouse('pointerdown', 3, control);
    const release = mouse('pointerup', 3, control);
    expect(release.defaultPrevented).toBe(true);
    expect(navigation.go.mock.calls).toEqual([['back']]);
    remove();
  });

  it('leaves a press over an embedded page to Chromium, which moves the history on its release', () => {
    document.body.innerHTML = '<iframe title="Sponsor form"></iframe>';
    const { navigation, remove, command } = install();
    // jsdom has no hover: the pointer is over the frame.
    const frame = document.querySelector('iframe');
    const query = vi
      .spyOn(document, 'querySelector')
      .mockImplementation((selector: string) => (selector === 'iframe:hover' ? frame : null));
    command({ direction: 'back', at: Date.now() });
    query.mockRestore();
    expect(navigation.go).not.toHaveBeenCalled();
    // Off the frame, the window's report alone moves it (the title bar).
    command({ direction: 'back', at: Date.now() });
    expect(navigation.go.mock.calls).toEqual([['back']]);
    remove();
  });

  it("follows the window's report alone where the page saw no mouse event (the title bar)", () => {
    const { navigation, remove, command } = install();
    command({ direction: 'forward', at: Date.now() });
    command({ direction: 'sideways', at: Date.now() });
    command(null);
    expect(navigation.go.mock.calls).toEqual([['forward']]);
    remove();
    command({ direction: 'back', at: Date.now() });
    keyDown(document.body, { key: 'ArrowLeft', altKey: true });
    mouse('pointerup', 3);
    expect(navigation.go).toHaveBeenCalledOnce();
  });

  it('feeds scrolling to the scroll memory', () => {
    const navigation = { trackScroll: vi.fn() };
    const remove = trackScrolling(window, navigation);
    document.body.innerHTML = '<div id="pane"></div>';
    const pane = document.getElementById('pane')!;
    pane.dispatchEvent(new Event('scroll'));
    expect(navigation.trackScroll).toHaveBeenCalledWith(pane);
    remove();
    pane.dispatchEvent(new Event('scroll'));
    expect(navigation.trackScroll).toHaveBeenCalledOnce();
  });
});

describe('installed in the app shell', () => {
  afterEach(() => Reflect.deleteProperty(window, 'voicestudio'));

  it('takes the history keys and mouse buttons in the desktop app', () => {
    Object.defineProperty(window, 'voicestudio', {
      configurable: true,
      value: { app: { platform: 'win32', onHistory: () => () => {} } },
    });
    // Screens visited before the shell installed (a reload) still count for Back.
    const history = createMemoryHistory({ initialEntries: ['/', '/dub'], initialIndex: 1 });
    history.push('/stories');
    const view = renderHook(() => useInstallHistoryNavigation(history));
    const key = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe('/dub');
    const release = new PointerEvent('pointerup', { button: 4, cancelable: true });
    window.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe('/stories');
    view.unmount();
  });

  it('leaves them to the browser in a browser tab, which has its own', () => {
    const history = createMemoryHistory({ initialEntries: ['/'] });
    history.push('/dub');
    const view = renderHook(() => useInstallHistoryNavigation(history));
    const key = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, cancelable: true });
    window.dispatchEvent(key);
    const release = new PointerEvent('pointerup', { button: 3, cancelable: true });
    window.dispatchEvent(release);
    expect(key.defaultPrevented).toBe(false);
    expect(release.defaultPrevented).toBe(false);
    expect(history.location.pathname).toBe('/dub');
    view.unmount();
  });
});

describe('scroll memory', () => {
  function frames() {
    const queue = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queue.set(++id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frame) => {
      queue.delete(frame);
    });
    return {
      run() {
        const [next] = queue;
        if (!next) return false;
        queue.delete(next[0]);
        next[1](0);
        return true;
      },
      get pending() {
        return queue.size;
      },
    };
  }

  function screen(contentClass = 'pane') {
    document.body.innerHTML = `<main data-slot="workspace-content"><header></header><div class="${contentClass}"><p></p></div></main>`;
    return document.querySelector<HTMLElement>(`.${contentClass}`)!;
  }

  it('returns a screen to where it was scrolled when Back comes back to it', () => {
    const tick = frames();
    const history = createMemoryHistory({ initialEntries: ['/dub'] });
    const memory = new ScrollMemory(document);
    const navigation = createHistoryNavigation(history, { scroll: memory });
    const pane = screen();
    pane.scrollTop = 640;
    navigation.trackScroll(pane);
    history.push('/stories');
    const fresh = screen();
    expect(fresh.scrollTop).toBe(0);
    navigation.go('back');
    const rebuilt = screen();
    tick.run();
    expect(rebuilt.scrollTop).toBe(640);
    expect(tick.pending).toBe(0);
    navigation.dispose();
  });

  it('waits for content that is still too short, and gives way to the user', () => {
    const tick = frames();
    const history = createMemoryHistory({ initialEntries: ['/projects'] });
    const memory = new ScrollMemory(document);
    const navigation = createHistoryNavigation(history, { scroll: memory });
    const pane = screen();
    pane.scrollTop = 900;
    navigation.trackScroll(pane);
    history.push('/dub');
    navigation.go('back');
    const rebuilt = screen();
    let room = 100;
    let top = 0;
    Object.defineProperty(rebuilt, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, room);
      },
    });
    tick.run();
    expect(top).toBe(100);
    room = 2000;
    tick.run();
    expect(top).toBe(900);
    expect(tick.pending).toBe(0);

    // Leaving again keeps the position; a wheel turn on return stops the restore.
    navigation.trackScroll(rebuilt);
    history.push('/batch');
    navigation.go('back');
    const again = screen();
    Object.defineProperty(again, 'scrollTop', { get: () => 0, set: () => {} });
    tick.run();
    expect(tick.pending).toBe(1);
    window.dispatchEvent(new Event('wheel'));
    expect(tick.pending).toBe(0);
    navigation.dispose();
  });

  it('keeps the position a restore was returning to when the screen is left before its content grew', () => {
    const tick = frames();
    const history = createMemoryHistory({ initialEntries: ['/projects'] });
    const memory = new ScrollMemory(document);
    const navigation = createHistoryNavigation(history, { scroll: memory });
    const removeScrolling = trackScrolling(window, navigation);
    const pane = screen();
    pane.scrollTop = 900;
    navigation.trackScroll(pane);
    history.push('/dub');
    navigation.go('back');
    const rebuilt = screen();
    let top = 0;
    Object.defineProperty(rebuilt, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, 300);
      },
    });
    tick.run();
    expect(top).toBe(300);
    // Chromium reports the clamped write as a scroll, like the user's own.
    rebuilt.dispatchEvent(new Event('scroll'));
    navigation.go('forward');
    navigation.go('back');
    const grown = screen();
    while (tick.run());
    expect(grown.scrollTop).toBe(900);
    removeScrolling();
    navigation.dispose();
  });

  it("counts the user's own scrolling of a pane the restore had not reached", () => {
    const tick = frames();
    const history = createMemoryHistory({ initialEntries: ['/projects'] });
    const memory = new ScrollMemory(document);
    const navigation = createHistoryNavigation(history, { scroll: memory });
    const pane = screen();
    pane.scrollTop = 900;
    navigation.trackScroll(pane);
    history.push('/dub');
    navigation.go('back');
    const rebuilt = screen();
    let top = 0;
    Object.defineProperty(rebuilt, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, 300);
      },
    });
    tick.run();
    // The user scrolls it themselves: from now on the position is theirs.
    window.dispatchEvent(new Event('wheel'));
    top = 120;
    navigation.trackScroll(rebuilt);
    navigation.go('forward');
    navigation.go('back');
    const again = screen();
    while (tick.run());
    expect(again.scrollTop).toBe(120);
    navigation.dispose();
  });

  it('puts both axes back in one instant write, which a smooth-scrolling pane follows', () => {
    const tick = frames();
    const history = createMemoryHistory({ initialEntries: ['/dub'] });
    const memory = new ScrollMemory(document);
    const navigation = createHistoryNavigation(history, { scroll: memory });
    const pane = screen();
    pane.scrollTop = 640;
    navigation.trackScroll(pane);
    history.push('/stories');
    navigation.go('back');
    const rebuilt = screen();
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      rebuilt.scrollTop = options.top ?? 0;
    });
    Object.defineProperty(rebuilt, 'scrollTo', { value: scrollTo });
    tick.run();
    expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' });
    expect(rebuilt.scrollTop).toBe(640);
    navigation.dispose();
  });

  it('does not restore onto a different screen or after a new screen', () => {
    const tick = frames();
    const history = createMemoryHistory({ initialEntries: ['/dub'] });
    const memory = new ScrollMemory(document);
    const navigation = createHistoryNavigation(history, { scroll: memory });
    const pane = screen();
    pane.scrollTop = 300;
    navigation.trackScroll(pane);
    history.push('/stories');
    navigation.go('back');
    // The screen came back with a different layout: nothing matches the mark.
    const other = screen('other-pane');
    tick.run();
    expect(other.scrollTop).toBe(0);
    history.push('/batch');
    const next = screen();
    while (tick.run());
    expect(next.scrollTop).toBe(0);
    navigation.dispose();
  });
});
