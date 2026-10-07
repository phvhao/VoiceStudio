import { useEffect, useSyncExternalStore } from 'react';
import type { HistoryLocation, RouterHistory } from '@tanstack/react-router';
import { getBridge, isMac, type VoiceStudioBridge } from '@/components/bridge';
import { isImeComposing } from '@/lib/ime';

/**
 * Back and Forward through the screens the user visited, the way a browser
 * does: the title bar's ← → buttons and, in the desktop app, Alt+←/→ (⌘[ / ⌘]
 * on a Mac), the mouse's Back/Forward buttons and a keyboard's Back/Forward
 * keys (a browser tab has its own). Going back returns each screen's scroll
 * position. The router's hash history is the history; this follows it to know
 * where Back and Forward lead.
 */

export type HistoryDirection = 'back' | 'forward';

/** A screen in the window's history. */
export interface HistoryPage {
  key: string;
  pathname: string;
}

export interface HistoryState {
  /** The screen Back returns to, when known. */
  back: HistoryPage | null;
  /** The screen Forward returns to. */
  forward: HistoryPage | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

const NO_HISTORY: HistoryState = {
  back: null,
  forward: null,
  canGoBack: false,
  canGoForward: false,
};

function entryKey(location: HistoryLocation): string {
  return location.state.__TSR_key ?? location.state.key ?? '';
}

function entryIndex(location: HistoryLocation): number {
  const index = location.state.__TSR_index;
  return Number.isInteger(index) && index > 0 ? index : 0;
}

function pageOf(location: HistoryLocation): HistoryPage {
  return { key: entryKey(location), pathname: location.pathname };
}

/**
 * The screens of the window's history as far as this renderer saw them. The
 * router numbers its entries (`__TSR_index`), so a new screen drops the ones
 * ahead of it, a replacement keeps them, and Back/Forward only move the index.
 */
export class SessionHistory {
  private readonly entries: Array<HistoryPage | undefined> = [];
  private index: number;

  constructor(location: HistoryLocation) {
    this.index = entryIndex(location);
    this.entries[this.index] = pageOf(location);
  }

  /** The current entry's number. */
  get position(): number {
    return this.index;
  }

  apply(
    page: HistoryPage,
    index: number,
    action: 'PUSH' | 'REPLACE' | 'BACK' | 'FORWARD' | 'GO',
  ): void {
    const known = this.entries[index];
    // A traversal to an entry this renderer saw differently (it reloaded):
    // whatever it remembers beyond that point no longer describes the history.
    if (action === 'PUSH' || (action !== 'REPLACE' && known && known.key !== page.key))
      this.entries.length = index;
    this.entries[index] = page;
    this.index = index;
  }

  state(): HistoryState {
    const back = this.index > 0 ? (this.entries[this.index - 1] ?? null) : null;
    const forward = this.entries[this.index + 1] ?? null;
    // Entries before the renderer started are real even when unknown: Back
    // still works there, it just cannot say where to.
    return { back, forward, canGoBack: this.index > 0, canGoForward: forward !== null };
  }
}

/* ---------------------------------------------------------------- scroll */

const CONTENT = '[data-slot="workspace-content"]';
const RESTORE_MS = 2500;
const REMEMBERED_SCREENS = 50;
const USER_INPUT = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;

/** Where a scrolled element sat in its screen, so the screen rebuilt later finds it again. */
interface ScrollMark {
  path: number[];
  fingerprint: string;
  top: number;
  left: number;
}

function fingerprint(element: Element): string {
  return `${element.tagName}.${element.getAttribute('class') ?? ''}`;
}

function pathWithin(root: Element, element: Element): number[] | null {
  const path: number[] = [];
  for (let node = element; node !== root;) {
    const parent = node.parentElement;
    if (!parent) return null;
    path.push(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return path.reverse();
}

function elementAt(root: Element, mark: ScrollMark): Element | null {
  let node: Element | undefined = root;
  for (const index of mark.path) node = node?.children[index];
  return node && fingerprint(node) === mark.fingerprint ? node : null;
}

/** Which pane of its screen a mark is, whatever its position. */
function placeOf(mark: Pick<ScrollMark, 'path' | 'fingerprint'>): string {
  return `${mark.path.join('/')}|${mark.fingerprint}`;
}

/** Put `element` at `mark`'s position: both axes in one write, and at once. */
function scrollToMark(element: Element, mark: ScrollMark): void {
  // A pane that scrolls smoothly retargets its animation on every write: two
  // writes (top, then left) sent it back to where it stood, and it never moved.
  if (typeof element.scrollTo === 'function')
    element.scrollTo({ top: mark.top, left: mark.left, behavior: 'instant' });
  else {
    element.scrollTop = mark.top;
    element.scrollLeft = mark.left;
  }
}

/**
 * Scroll positions of each screen's scrolled panes (the workspace content
 * scrolls in panes, never the window), kept by history entry while the user
 * is elsewhere and put back when Back or Forward returns to it. Restoring
 * waits for content that loads after the screen mounts, and gives way as soon
 * as the user scrolls, clicks or types. A position it has not reached yet is
 * no position of the user's: a pane still too short is scrolled only as far as
 * it goes, and leaving it then keeps the position it was being returned to.
 */
export class ScrollMemory {
  private live = new Map<Element, ScrollMark>();
  private readonly screens = new Map<string, ScrollMark[]>();
  /** The marks a restore is still putting back, by place, until the user takes over. */
  private restoring = new Map<string, ScrollMark>();
  private cancelRestore: () => void = () => {};

  constructor(private readonly document: Document) {}

  track(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const root = target.closest(CONTENT);
    const path = root && pathWithin(root, target);
    if (!path) return;
    const mark = { path, fingerprint: fingerprint(target) };
    // The restore's own write, stopped short by content still loading.
    if (this.restoring.has(placeOf(mark))) return;
    this.live.set(target, { ...mark, top: target.scrollTop, left: target.scrollLeft });
  }

  /**
   * Keep the screen being left under its entry key. A screen nobody scrolled
   * this time keeps what it had (a restore still waiting for its content),
   * and so does each pane a restore had not yet reached.
   */
  leave(key: string): void {
    const unreached = [...this.restoring.values()];
    this.cancelRestore();
    if (!this.live.size) return;
    this.screens.delete(key);
    this.screens.set(key, [...this.live.values(), ...unreached]);
    this.live = new Map();
    if (this.screens.size > REMEMBERED_SCREENS)
      this.screens.delete(this.screens.keys().next().value as string);
  }

  restore(key: string): void {
    this.cancelRestore();
    let pending = (this.screens.get(key) ?? []).filter((mark) => mark.top || mark.left);
    if (!pending.length) return;
    const view = this.document.defaultView;
    if (!view) return;
    this.restoring = new Map(pending.map((mark) => [placeOf(mark), mark]));
    const deadline = view.performance.now() + RESTORE_MS;
    let frame = 0;
    // Done putting panes back: every one reached, the user's own input (their
    // scrolling counts from now on), or the screen left or restored anew.
    const finish = () => {
      view.cancelAnimationFrame(frame);
      this.restoring = new Map();
      for (const type of USER_INPUT) view.removeEventListener(type, finish, true);
      this.cancelRestore = () => {};
    };
    const step = () => {
      const root = this.document.querySelector(CONTENT);
      pending = pending.filter((mark) => {
        const element = root && elementAt(root, mark);
        if (!element) return true;
        scrollToMark(element, mark);
        // Content still loading may be too short to reach the spot yet.
        const reached =
          Math.abs(element.scrollTop - mark.top) <= 1 &&
          Math.abs(element.scrollLeft - mark.left) <= 1;
        if (reached) this.restoring.delete(placeOf(mark));
        return !reached;
      });
      if (!pending.length) finish();
      else if (view.performance.now() < deadline) frame = view.requestAnimationFrame(step);
      // Out of time: the panes not reached stop being scrolled, and keep
      // their position until the user takes over or the screen is left.
    };
    for (const type of USER_INPUT)
      view.addEventListener(type, finish, { capture: true, passive: true });
    this.cancelRestore = finish;
    frame = view.requestAnimationFrame(step);
  }

  dispose(): void {
    this.cancelRestore();
  }
}

/* ------------------------------------------------------------ navigation */

export interface HistoryNavigation {
  state(): HistoryState;
  subscribe(listener: () => void): () => void;
  /** Go one screen back or forward; false when there is none. */
  go(direction: HistoryDirection): boolean;
  /** The scroll memory follows the user's scrolling through this. */
  trackScroll(target: EventTarget | null): void;
  dispose(): void;
}

/** The window's own record of its entries, under a router history it backs. */
export interface BrowserEntries {
  /** The current entry's state as the browser keeps it. */
  state(): unknown;
  /** Give the current entry a state; the router sees a replacement. */
  renumber(state: { key: string; __TSR_key: string; __TSR_index: number }): void;
}

function numbered(state: unknown): boolean {
  return Number.isInteger((state as { __TSR_index?: unknown } | null)?.__TSR_index);
}

export function createHistoryNavigation(
  history: RouterHistory,
  {
    scroll = new ScrollMemory(document),
    browser,
  }: { scroll?: ScrollMemory; browser?: BrowserEntries } = {},
): HistoryNavigation {
  const mirror = new SessionHistory(history.location);
  const listeners = new Set<() => void>();
  let currentKey = entryKey(history.location);
  let state = mirror.state();
  const unsubscribe = history.subscribe(({ location, action }) => {
    let type = action.type;
    let page = pageOf(location);
    let index = entryIndex(location);
    // A hash change the router did not make (a plain `#/…` link, an address
    // typed in a browser tab) adds an entry the router left unnumbered, which
    // it then counts as the first: number it as the next screen instead.
    const unnumbered = browser && type !== 'REPLACE' && !numbered(browser.state());
    if (unnumbered) {
      type = 'PUSH';
      index = mirror.position + 1;
      const key = Math.random().toString(36).slice(2, 10);
      page = { key, pathname: location.pathname };
    }
    // A replacement is the same screen under a new key: its scrolling carries on.
    if (type !== 'REPLACE') scroll.leave(currentKey);
    mirror.apply(page, index, type);
    currentKey = page.key;
    if (type === 'BACK' || type === 'FORWARD' || type === 'GO') scroll.restore(page.key);
    state = mirror.state();
    for (const listener of listeners) listener();
    if (unnumbered) browser?.renumber({ key: page.key, __TSR_key: page.key, __TSR_index: index });
  });
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    go(direction) {
      if (direction === 'back' ? !state.canGoBack : !state.canGoForward) return false;
      if (direction === 'back') history.back();
      else history.forward();
      return true;
    },
    trackScroll: (target) => scroll.track(target),
    dispose() {
      unsubscribe();
      scroll.dispose();
      listeners.clear();
    },
  };
}

/* ---------------------------------------------------------------- inputs */

/** How long apart (ms) the page's and the window's reports of one press may be. */
const TWIN_MS = 400;

/** One Back/Forward press, from the page (a mouse event, a Back key) or the window (an app command). */
export interface HistoryPress {
  direction: HistoryDirection;
  source: 'page' | 'window';
  /** When the press started and ended (`Date.now()` time); equal for a key or an app command. */
  from: number;
  to: number;
}

/**
 * Windows and Linux report one press of a mouse's Back button twice: to the
 * page as a pointer event and to the window as an app command (Windows on the
 * release, Linux on the press). A report from the other side that falls within
 * the press is its twin and does not navigate again. Each report is matched at
 * most once, so two quick presses still go back twice.
 */
export function createPressPairing(now: () => number = Date.now): (press: HistoryPress) => boolean {
  let unmatched: HistoryPress[] = [];
  return (press) => {
    const horizon = now() - 10_000;
    unmatched = unmatched.filter((item) => item.to > horizon);
    const twin = unmatched.find(
      (item) =>
        item.direction === press.direction &&
        item.source !== press.source &&
        item.from - TWIN_MS <= press.to &&
        press.from - TWIN_MS <= item.to,
    );
    if (twin) {
      unmatched = unmatched.filter((item) => item !== twin);
      return false;
    }
    unmatched.push(press);
    return true;
  };
}

/** The history shortcut a key press is: Alt+←/→, or ⌘[ / ⌘] on a Mac; the Back/Forward keys anywhere. */
export function historyKey(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  mac: boolean,
): HistoryDirection | null {
  if (event.key === 'BrowserBack') return 'back';
  if (event.key === 'BrowserForward') return 'forward';
  if (event.ctrlKey || event.shiftKey) return null;
  if (mac) {
    // Layouts that type a bracket with Option still report the bracket.
    if (!event.metaKey) return null;
    return event.key === '[' ? 'back' : event.key === ']' ? 'forward' : null;
  }
  if (!event.altKey || event.metaKey) return null;
  return event.key === 'ArrowLeft' ? 'back' : event.key === 'ArrowRight' ? 'forward' : null;
}

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"]';

/** Fields keep their own keys: a shortcut typed in one is never taken for history. */
function inEditableField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

/** When `event` happened, on the `Date.now()` clock main stamps app commands with. */
function eventTime(event: Event): number {
  const now = Date.now();
  const age = performance.now() - event.timeStamp;
  return Number.isFinite(age) && age >= 0 && age < 60_000 ? now - age : now;
}

function mouseDirection(button: number): HistoryDirection | null {
  return button === 3 ? 'back' : button === 4 ? 'forward' : null;
}

/**
 * Whether the pointer is over a page embedded in this one (the sponsor
 * form): a press there is that page's, which this one never sees, and
 * Chromium moves the history itself on its release.
 */
function overEmbeddedPage(document: Document): boolean {
  return document.querySelector('iframe:hover') !== null;
}

/** Follow the user's scrolling for the scroll memory. Returns the removal. */
export function trackScrolling(
  view: Window,
  navigation: Pick<HistoryNavigation, 'trackScroll'>,
): () => void {
  const onScroll = (event: Event) => navigation.trackScroll(event.target);
  view.document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => view.document.removeEventListener('scroll', onScroll, { capture: true });
}

/**
 * Listen for every Back/Forward input the desktop app has (a browser tab has
 * its own, which move the same history). Returns the removal.
 */
export function installHistoryInputs(
  view: Window,
  navigation: Pick<HistoryNavigation, 'go'>,
  { mac, bridge }: { mac: boolean; bridge: VoiceStudioBridge | null },
): () => void {
  const accept = createPressPairing();
  const press = (item: HistoryPress) => {
    if (accept(item)) navigation.go(item.direction);
  };
  const downs = new Map<number, number>();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || isImeComposing(event)) return;
    const direction = historyKey(event, mac);
    if (!direction) return;
    const dedicated = event.key === 'BrowserBack' || event.key === 'BrowserForward';
    if (!dedicated && inEditableField(event.target)) return;
    event.preventDefault();
    if (!dedicated) {
      navigation.go(direction);
      return;
    }
    const at = eventTime(event);
    press({ direction, source: 'page', from: at, to: at });
  };
  // Pointer events, taken first (capture on the window): a control that
  // cancels its pointerdown — to keep the caret in the script — suppresses
  // the mouse events after it, and its Back press then went by untaken.
  const onPointerDown = (event: PointerEvent) => {
    if (mouseDirection(event.button)) downs.set(event.button, eventTime(event));
  };
  const onPointerUp = (event: PointerEvent) => {
    const direction = mouseDirection(event.button);
    if (!direction || event.defaultPrevented) return;
    // Chromium moves the history itself on a Back/Forward release the page
    // lets through; the app takes the press so it moves exactly once.
    event.preventDefault();
    const to = eventTime(event);
    const from = Math.min(downs.get(event.button) ?? to, to);
    downs.delete(event.button);
    press({ direction, source: 'page', from, to });
  };
  view.addEventListener('keydown', onKeyDown);
  view.addEventListener('pointerdown', onPointerDown, true);
  view.addEventListener('pointerup', onPointerUp, true);
  const removeWindowCommands = bridge?.app.onHistory?.((command) => {
    if (
      (command?.direction === 'back' || command?.direction === 'forward') &&
      Number.isFinite(command.at) &&
      !overEmbeddedPage(view.document)
    )
      press({ direction: command.direction, source: 'window', from: command.at, to: command.at });
  });
  return () => {
    view.removeEventListener('keydown', onKeyDown);
    view.removeEventListener('pointerdown', onPointerDown, true);
    view.removeEventListener('pointerup', onPointerUp, true);
    removeWindowCommands?.();
  };
}

/* ----------------------------------------------------------------- React */

let installed: HistoryNavigation | null = null;
const watchers = new Set<() => void>();
let detach: () => void = () => {};

function setInstalled(navigation: HistoryNavigation | null): void {
  detach();
  installed = navigation;
  detach = navigation?.subscribe(() => watchers.forEach((watcher) => watcher())) ?? (() => {});
  watchers.forEach((watcher) => watcher());
}

function watch(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** Where Back and Forward lead now (nothing until the shell installed the history). */
export function useHistoryState(): HistoryState {
  return useSyncExternalStore(
    watch,
    () => installed?.state() ?? NO_HISTORY,
    () => NO_HISTORY,
  );
}

/** Go back or forward through the installed history; false when there is nowhere to go. */
export function goThroughHistory(direction: HistoryDirection): boolean {
  return installed?.go(direction) ?? false;
}

/** Once, in the app shell: follow `history` and listen for every Back/Forward input. */
export function useInstallHistoryNavigation(history: RouterHistory): void {
  useEffect(() => {
    // The app's hash history keeps its entries in the window's; a memory
    // history (tests) has none there.
    const key = history.location.state.__TSR_key;
    const backed =
      Boolean(key) && (window.history.state as { __TSR_key?: string } | null)?.__TSR_key === key;
    const navigation = createHistoryNavigation(history, {
      browser: backed
        ? {
            state: () => window.history.state,
            renumber: (state) => window.history.replaceState(state, ''),
          }
        : undefined,
    });
    const removeScrolling = trackScrolling(window, navigation);
    const bridge = getBridge();
    const removeInputs = bridge
      ? installHistoryInputs(window, navigation, { mac: isMac(), bridge })
      : () => {};
    setInstalled(navigation);
    return () => {
      removeInputs();
      removeScrolling();
      setInstalled(null);
      navigation.dispose();
    };
  }, [history]);
}
