import { useFitSteps } from '@/hooks/use-fit-steps';

/**
 * What a crowded title bar gives up, in order, so the screen's title — and a
 * file or book name beside it, down to its `data-fit-min` width — keeps its
 * room: the words on Get Pro, Star and the search hint, then the star count,
 * then the words on the screen's own title-bar buttons (still read by screen
 * readers), then those buttons, Search, Get Pro and Star themselves, which
 * move into one "More actions" menu. Each piece hides with
 * `group-data-[fit~=step]/titlebar` inside a header marked `group/titlebar`.
 * When even that is not enough, a side pane beside the bar narrows: see
 * `useTitlebarFit`'s `onRoom`.
 */
export const TITLEBAR_FIT_STEPS = ['labels', 'count', 'controls', 'overflow'] as const;

/** What must not be cut off: the title, and a name down to its minimum. */
export const TITLEBAR_FIT_PARTS = 'h1, [data-fit-min]';
/** How narrow (px) a name beside the title gets before the shortcuts give way. */
export const TITLEBAR_NAME_MIN = 96;

/**
 * `onRoom` hears the width the bar needs with every step taken — the title in
 * full beside the "More actions" menu. A screen whose side pane shares the
 * bar's row hands it to `WorkspacePane` as `room`, so the pane narrows rather
 * than cut the title.
 */
export function useTitlebarFit(onRoom?: (room: number) => void) {
  return useFitSteps<HTMLElement>(TITLEBAR_FIT_STEPS, TITLEBAR_FIT_PARTS, onRoom);
}
