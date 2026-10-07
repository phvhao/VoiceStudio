import { useSyncExternalStore } from 'react';

/**
 * How wide the script editor's lines run, one choice per viewer kept in this
 * browser's storage: `reading` stops them at a comfortable measure, centred in
 * a wider frame; `fit` runs them the frame's full width. The frame itself
 * always fills the page; only its text column changes.
 */
export type EditorMeasure = 'reading' | 'fit';

export const MEASURE_DEFAULT: EditorMeasure = 'reading';
/** The reading measure: the text column's widest, in the editor's own type. */
export const READING_MEASURE = '100ch';

const STORAGE_KEY = 'voicestudio.editor-measure';

function readMeasure(): EditorMeasure {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'fit' ? 'fit' : MEASURE_DEFAULT;
  } catch {
    return MEASURE_DEFAULT;
  }
}

let measure = readMeasure();
const listeners = new Set<() => void>();

export function getEditorMeasure(): EditorMeasure {
  return measure;
}

export function setEditorMeasure(next: EditorMeasure) {
  if (next === measure) return;
  measure = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Storage blocked (private window): the choice lasts for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The editor's measure, and the setter every editor shares. */
export function useEditorMeasure(): [EditorMeasure, (value: EditorMeasure) => void] {
  return [useSyncExternalStore(subscribe, getEditorMeasure), setEditorMeasure];
}

/** The text column's widest for `value` (a CSS length), or none to fit the frame. */
export function measureWidth(value: EditorMeasure): string | undefined {
  return value === 'reading' ? READING_MEASURE : undefined;
}
