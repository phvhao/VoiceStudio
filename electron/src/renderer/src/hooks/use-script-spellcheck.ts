import { useSyncExternalStore } from 'react';
import { getBridge } from '@/components/bridge';
import type { SpellcheckState } from '../../../preload/index.d';

/**
 * Settings → Spellcheck while writing (off by default): whether the fields
 * whose text is spoken — scripts, lines, transcripts, phrases — are checked
 * while typing. Off, a Vietnamese script is not underlined end to end by an
 * English dictionary. Fields that are not spoken keep the browser's default.
 */
const storageKey = 'voicestudio.script-spellcheck.v1';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(storageKey) === 'on';
  } catch {
    return false;
  }
}

let enabled = read();
/** What the desktop checker reports once it has been told; null outside Electron or until then. */
let checker: SpellcheckState | null = null;

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell the desktop shell which languages to check in (Vietnamese and English while on). */
function applyToChecker(on: boolean) {
  const bridge = getBridge();
  if (!bridge?.spellcheck) return;
  bridge.spellcheck.setEnabled(on).then(
    (state) => {
      if (enabled !== on) return;
      checker = state;
      notify();
    },
    () => {
      /* The browser's own checker still follows the fields' setting. */
    },
  );
}

export function setScriptSpellcheck(on: boolean) {
  enabled = on;
  checker = null;
  try {
    localStorage.setItem(storageKey, on ? 'on' : 'off');
  } catch {
    /* The in-memory preference still applies for this session. */
  }
  notify();
  applyToChecker(on);
}

/** At startup: a saved "on" sets the checker's languages before the first script is typed. */
export function installScriptSpellcheck() {
  if (enabled) applyToChecker(true);
}

/** The `spellCheck` of every field whose text is spoken. */
export function useScriptSpellcheck(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => enabled,
  );
}

/** What the checker reported for the current setting, for the note under it. */
export function useSpellcheckState(): SpellcheckState | null {
  return useSyncExternalStore(
    subscribe,
    () => checker,
    () => checker,
  );
}
