import { useEffect, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { claimZoomInput, zoomKey } from '@/lib/zoom-keys';

export { zoomKey };

/**
 * The script editor's zoom: one text size per viewer, kept in this browser's
 * storage. It scales the type and the leading of the editor's text alone,
 * never the app (the app's own zoom stays where it is).
 */
export const ZOOM_MIN = 80;
export const ZOOM_MAX = 160;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;
export const ZOOM_PRESETS: readonly number[] = Array.from(
  { length: (ZOOM_MAX - ZOOM_MIN) / ZOOM_STEP + 1 },
  (_, index) => ZOOM_MIN + index * ZOOM_STEP,
);

const STORAGE_KEY = 'voicestudio.editor-zoom';
// A wheel turns this far (in pixels) for one step; a mouse notch is ~100,
// a trackpad pinch sends many small deltas.
const WHEEL_STEP = 50;

/** `value` as a zoom the editor offers: a whole step, within the range. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  const stepped = Math.round(value / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
}

function readZoom(): number {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === null || stored === undefined ? ZOOM_DEFAULT : clampZoom(Number(stored));
  } catch {
    return ZOOM_DEFAULT;
  }
}

let zoom = readZoom();
const listeners = new Set<() => void>();

export function getEditorZoom(): number {
  return zoom;
}

export function setEditorZoom(value: number) {
  const next = clampZoom(value);
  if (next === zoom) return;
  zoom = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(next));
  } catch {
    // Storage blocked (private window): the zoom lasts for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The editor's zoom in percent, and the setter every editor shares. */
export function useEditorZoom(): [number, (value: number) => void] {
  return [useSyncExternalStore(subscribe, getEditorZoom), setEditorZoom];
}

/** The editor's type at `percent`: `fontRem`/`lineRem` are its size at 100 %. */
export function zoomedText(percent: number, fontRem: number, lineRem: number): CSSProperties {
  const scale = percent / 100;
  return {
    fontSize: `${+(fontRem * scale).toFixed(4)}rem`,
    lineHeight: `${+(lineRem * scale).toFixed(4)}rem`,
  };
}

/** Apply a zoom key press: false when the key is no zoom. */
export function applyZoomKey(event: Parameters<typeof zoomKey>[0]): boolean {
  const action = zoomKey(event);
  if (!action) return false;
  setEditorZoom(
    action === 'reset' ? ZOOM_DEFAULT : getEditorZoom() + (action === 'in' ? 1 : -1) * ZOOM_STEP,
  );
  return true;
}

/**
 * Zoom the editor from the keyboard and with Ctrl+wheel (⌘+wheel, or a
 * pinch, on a Mac) while the focus is inside `frame`, or the pointer is over
 * it with the focus nowhere in particular, instead of the app: the app's own
 * zoom keys (a capture listener on the window) leave those presses to it.
 * Elsewhere the keys keep their usual meaning.
 */
export function useEditorZoomInput(frame: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let travel = 0;
    let hovered = false;
    const owns = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && element.contains(target)) return true;
      // Pointing at the editor counts while nothing else has the focus.
      return hovered && (target === document.body || target === document.documentElement);
    };
    const release = claimZoomInput(owns);
    const onPointerEnter = () => {
      hovered = true;
    };
    const onPointerLeave = () => {
      hovered = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !owns(event)) return;
      if (applyZoomKey(event)) event.preventDefault();
    };
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      // Not passive: the app must not zoom as well.
      event.preventDefault();
      travel += event.deltaY;
      if (Math.abs(travel) < WHEEL_STEP) return;
      setEditorZoom(getEditorZoom() + (travel < 0 ? ZOOM_STEP : -ZOOM_STEP));
      travel = 0;
    };
    window.addEventListener('keydown', onKeyDown);
    element.addEventListener('pointerenter', onPointerEnter);
    element.addEventListener('pointerleave', onPointerLeave);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      release();
      window.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('pointerenter', onPointerEnter);
      element.removeEventListener('pointerleave', onPointerLeave);
      element.removeEventListener('wheel', onWheel);
    };
  }, [frame]);
}
