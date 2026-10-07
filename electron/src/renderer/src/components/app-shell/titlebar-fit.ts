import { useFitSteps } from '@/hooks/use-fit-steps';

/**
 * What a crowded title bar gives up, in order, so the screen's title — and a
 * file or book name beside it, down to its `data-fit-min` width — keeps its
 * room: the words on Get Pro, Star and the search hint, then the star count,
 * then the words on the screen's own title-bar buttons (still read by screen
 * readers), then the Get Pro and Star shortcuts themselves. Each piece hides
 * with `group-data-[fit~=step]/titlebar` inside a header marked `group/titlebar`.
 */
export const TITLEBAR_FIT_STEPS = ['labels', 'count', 'controls', 'shortcuts'] as const;

/** What must not be cut off: the title, and a name down to its minimum. */
export const TITLEBAR_FIT_PARTS = 'h1, [data-fit-min]';
/** How narrow (px) a name beside the title gets before the shortcuts give way. */
export const TITLEBAR_NAME_MIN = 96;

export function useTitlebarFit() {
  return useFitSteps<HTMLElement>(TITLEBAR_FIT_STEPS, TITLEBAR_FIT_PARTS);
}
