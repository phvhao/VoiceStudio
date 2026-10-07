import { useEffect, useSyncExternalStore } from 'react';
import './editor-focus.css';

/**
 * Focus mode of the Clone and Voice Design script editors: the app's sidebar,
 * the workspace's own panes and the takes below the editor step aside until
 * Esc, the Focus button again, or leaving the page. Kept in memory only: the
 * app always opens with its full layout.
 */
let focused = false;
const listeners = new Set<() => void>();

export function isEditorFocused(): boolean {
  return focused;
}

export function setEditorFocus(next: boolean) {
  if (next === focused) return;
  focused = next;
  // For the stylesheet: the page's title bar takes the sidebar's place.
  if (typeof document !== 'undefined')
    document.documentElement.toggleAttribute('data-editor-focus', next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEditorFocus(): boolean {
  return useSyncExternalStore(subscribe, isEditorFocused, () => false);
}

// Esc in these belongs to them (closing a menu or a dialog), not to focus mode.
const OWN_ESCAPE = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * For the page that offers focus mode: Esc leaves it, and so does leaving
 * the page, so no other workspace opens without its sidebar.
 */
export function useEditorFocusMode() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!focused || event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest(OWN_ESCAPE)) return;
      // Claimed: the page's own Esc (closing its panes) waits for the next press.
      event.preventDefault();
      setEditorFocus(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      setEditorFocus(false);
    };
  }, []);
}
