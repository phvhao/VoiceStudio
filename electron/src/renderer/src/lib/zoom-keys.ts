/**
 * Zoom keys, shared by the app's own zoom (the appearance scale) and the
 * parts of it that zoom their own content (the script editor): Ctrl (⌘ on a
 * Mac) with + or =, − or _, or 0 — the number pad's too, and by key position
 * (`code`) where a layout puts those characters elsewhere.
 */
export type ZoomAction = 'in' | 'out' | 'reset';

export function zoomKey(event: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): ZoomAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const { key, code } = event;
  if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') return 'in';
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'out';
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset';
  return null;
}

/** Decides whether a part of the page zooms itself on this key or wheel event. */
type ZoomOwner = (event: Event) => boolean;
const owners = new Set<ZoomOwner>();

/**
 * Let `owns` take the zoom keys while it says so (focus or pointer inside it):
 * the app's zoom then leaves them to it. Returns the release.
 */
export function claimZoomInput(owns: ZoomOwner): () => void {
  owners.add(owns);
  return () => {
    owners.delete(owns);
  };
}

/** Whether a part of the page zooms itself on this event (the app's zoom stays put). */
export function zoomInputOwned(event: Event): boolean {
  for (const owns of owners) if (owns(event)) return true;
  return false;
}

/**
 * The app's zoom keys: step the appearance scale, unless the event belongs to
 * a part of the page with a zoom of its own. True when the app zoomed.
 */
export function handleAppZoomKey(event: KeyboardEvent, step: (direction: -1 | 0 | 1) => void) {
  const action = zoomKey(event);
  if (!action || zoomInputOwned(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  step(action === 'reset' ? 0 : action === 'in' ? 1 : -1);
  return true;
}
