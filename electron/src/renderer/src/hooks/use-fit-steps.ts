import { useCallback } from 'react';

/**
 * Whether `element` is cut off. A part that may shorten (a file or book name,
 * truncated with an ellipsis) counts only once it is narrower than its
 * `data-fit-min` (px): until then it gives way before any step is taken.
 */
const overflows = (element: Element) => {
  if (element.scrollWidth <= element.clientWidth + 1) return false;
  const min = Number((element as HTMLElement).dataset?.fitMin);
  return !(min > 0) || element.clientWidth < min;
};

/**
 * Takes `steps` in order until nothing overflows — neither `element` nor any
 * of its `parts` (a selector) — and records the steps taken, space-separated,
 * in its `data-fit` attribute; when nothing fits, every step is taken. Styles
 * hang each optional piece on its step with `data-[fit~=step]`, so the first
 * steps should give up the least.
 */
export function fitSteps(element: HTMLElement, steps: readonly string[], parts = '') {
  for (let taken = 0; taken <= steps.length; taken++) {
    element.dataset.fit = steps.slice(0, taken).join(' ');
    const measured = parts ? [element, ...element.querySelectorAll(parts)] : [element];
    if (!measured.some(overflows)) break;
  }
  return element.dataset.fit ?? '';
}

/**
 * The width `element` needs once every step is taken: everything in it at its
 * full width, except a part that may shorten, counted at its `data-fit-min`.
 * It depends on the content alone, never on the width the element has now, so
 * a neighbour that gives the element this much room (a side pane narrowing)
 * does not change it.
 */
export function fitRoom(element: HTMLElement, steps: readonly string[]) {
  const { fit } = element.dataset;
  const { width } = element.style;
  element.dataset.fit = steps.join(' ');
  element.style.width = 'max-content';
  let room = element.getBoundingClientRect().width;
  for (const part of element.querySelectorAll<HTMLElement>('[data-fit-min]'))
    room -= Math.max(0, part.getBoundingClientRect().width - Number(part.dataset.fitMin));
  element.style.width = width;
  if (fit === undefined) delete element.dataset.fit;
  else element.dataset.fit = fit;
  return Math.ceil(room);
}

/**
 * A ref that keeps `fitSteps` current while its element is mounted: when it
 * resizes, when its text or children change (a language switch, a count
 * arriving) and when a font finishes loading. A label therefore shows because
 * it fits in this language at this width, not because the window crossed a
 * breakpoint chosen for English. `onRoom`, when given, hears `fitRoom` each
 * time, so a neighbour can make way once every step is not enough.
 */
export function useFitSteps<T extends HTMLElement>(
  steps: readonly string[],
  parts = '',
  onRoom?: (room: number) => void,
) {
  const key = steps.join(' ');
  return useCallback(
    (element: T | null) => {
      if (!element) return;
      const list = key ? key.split(' ') : [];
      let frame = 0;
      const fit = () => {
        frame = 0;
        if (onRoom) onRoom(fitRoom(element, list));
        fitSteps(element, list, parts);
      };
      // Observers report after layout; refitting on the next frame keeps a
      // step that changes the element's own height out of the resize loop.
      const refit = () => {
        if (!frame) frame = requestAnimationFrame(fit);
      };
      fit();
      const content = new MutationObserver(refit);
      content.observe(element, { childList: true, characterData: true, subtree: true });
      const size = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refit);
      size?.observe(element);
      const fonts = typeof document.fonts?.addEventListener === 'function' ? document.fonts : null;
      fonts?.addEventListener('loadingdone', refit);
      return () => {
        cancelAnimationFrame(frame);
        content.disconnect();
        size?.disconnect();
        fonts?.removeEventListener('loadingdone', refit);
      };
    },
    [key, parts, onRoom],
  );
}
