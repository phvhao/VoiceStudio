import { useEffect, useState } from 'react';

/** Characters a keystroke (or an input method's commit) changes at most. */
const TYPED_CHARS = 8;

/**
 * Whether `next` is `previous` with one small run of characters changed, as
 * typing leaves it — not a text replaced by another book, Clear, an import,
 * a paste or an undo.
 */
export function isTypedEdit(previous: string, next: string): boolean {
  if (Math.abs(previous.length - next.length) > TYPED_CHARS) return false;
  const shorter = Math.min(previous.length, next.length);
  let head = 0;
  while (head < shorter && previous[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < shorter - head &&
    previous[previous.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  return Math.max(previous.length, next.length) - head - tail <= TYPED_CHARS;
}

/**
 * `text` once typing has paused for `delay` ms, so what is worked out from it
 * waits for a pause; a text replaced rather than typed comes through at once,
 * so nothing shown still describes the text it replaced.
 */
export function useSettledText(text: string, delay: number): string {
  const [state, setState] = useState({ last: text, settled: text });
  let current = state;
  if (state.last !== text) {
    current = { last: text, settled: isTypedEdit(state.last, text) ? state.settled : text };
    setState(current);
  }
  const { settled } = current;
  useEffect(() => {
    if (settled === text) return;
    const timer = setTimeout(() => setState((s) => ({ ...s, settled: s.last })), delay);
    return () => clearTimeout(timer);
  }, [text, settled, delay]);
  return settled;
}
