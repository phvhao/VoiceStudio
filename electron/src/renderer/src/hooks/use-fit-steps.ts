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
 * A ref that keeps `fitSteps` current while its element is mounted: when it
 * resizes, when its text or children change (a language switch, a count
 * arriving) and when a font finishes loading. A label therefore shows because
 * it fits in this language at this width, not because the window crossed a
 * breakpoint chosen for English.
 */
export function useFitSteps<T extends HTMLElement>(steps: readonly string[], parts = '') {
  const key = steps.join(' ');
  return useCallback(
    (element: T | null) => {
      if (!element) return;
      const list = key ? key.split(' ') : [];
      let frame = 0;
      const fit = () => {
        frame = 0;
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
    [key, parts],
  );
}
