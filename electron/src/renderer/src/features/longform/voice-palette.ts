/**
 * One color per `[voice:NAME]`, shared by everything that shows a voice: the
 * editor's chips and voice lane, the Cast panel, the status bar, the Stories
 * character cards. Colors follow the order names first appear in the script,
 * so a voice keeps its color wherever it is shown.
 *
 * Literal class names only: Tailwind generates what it can see in source.
 * `chip` paints a voice token in the editor overlay, so it may only paint
 * (background, ring, outline): anything that changes glyph metrics would
 * drift the overlay away from the caret.
 */
export interface VoiceAccent {
  /** Left edge of a card (Stories lines). */
  border: string;
  /** A small swatch next to a name. */
  dot: string;
  /** A `[voice:NAME]` token in the editor; reacts to `data-hover` and `data-current`. */
  chip: string;
  /** The editor's voice lane. */
  lane: string;
  /** Text in the voice's color. */
  text: string;
}

export const VOICE_ACCENTS: readonly VoiceAccent[] = [
  {
    border: 'border-l-sky-400',
    dot: 'bg-sky-400',
    chip: 'bg-sky-500/18 ring-1 ring-sky-500/45 data-hover:bg-sky-500/30 data-hover:ring-sky-500/70 data-current:ring-2',
    lane: 'bg-sky-400',
    text: 'text-sky-600 dark:text-sky-400',
  },
  {
    border: 'border-l-amber-400',
    dot: 'bg-amber-400',
    chip: 'bg-amber-500/18 ring-1 ring-amber-500/45 data-hover:bg-amber-500/30 data-hover:ring-amber-500/70 data-current:ring-2',
    lane: 'bg-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
  },
  {
    border: 'border-l-emerald-400',
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-500/18 ring-1 ring-emerald-500/45 data-hover:bg-emerald-500/30 data-hover:ring-emerald-500/70 data-current:ring-2',
    lane: 'bg-emerald-400',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    border: 'border-l-fuchsia-400',
    dot: 'bg-fuchsia-400',
    chip: 'bg-fuchsia-500/18 ring-1 ring-fuchsia-500/45 data-hover:bg-fuchsia-500/30 data-hover:ring-fuchsia-500/70 data-current:ring-2',
    lane: 'bg-fuchsia-400',
    text: 'text-fuchsia-600 dark:text-fuchsia-400',
  },
  {
    border: 'border-l-orange-400',
    dot: 'bg-orange-400',
    chip: 'bg-orange-500/18 ring-1 ring-orange-500/45 data-hover:bg-orange-500/30 data-hover:ring-orange-500/70 data-current:ring-2',
    lane: 'bg-orange-400',
    text: 'text-orange-600 dark:text-orange-400',
  },
  {
    border: 'border-l-teal-400',
    dot: 'bg-teal-400',
    chip: 'bg-teal-500/18 ring-1 ring-teal-500/45 data-hover:bg-teal-500/30 data-hover:ring-teal-500/70 data-current:ring-2',
    lane: 'bg-teal-400',
    text: 'text-teal-600 dark:text-teal-400',
  },
  {
    border: 'border-l-rose-400',
    dot: 'bg-rose-400',
    chip: 'bg-rose-500/18 ring-1 ring-rose-500/45 data-hover:bg-rose-500/30 data-hover:ring-rose-500/70 data-current:ring-2',
    lane: 'bg-rose-400',
    text: 'text-rose-600 dark:text-rose-400',
  },
  {
    border: 'border-l-indigo-400',
    dot: 'bg-indigo-400',
    chip: 'bg-indigo-500/18 ring-1 ring-indigo-500/45 data-hover:bg-indigo-500/30 data-hover:ring-indigo-500/70 data-current:ring-2',
    lane: 'bg-indigo-400',
    text: 'text-indigo-600 dark:text-indigo-400',
  },
];

/** The book's default voice, and any name the palette does not know. */
export const DEFAULT_VOICE_ACCENT: VoiceAccent = {
  border: 'border-l-border/60',
  dot: 'bg-muted-foreground/50',
  chip: 'bg-muted-foreground/12 ring-1 ring-muted-foreground/35 data-hover:bg-muted-foreground/22 data-hover:ring-muted-foreground/60 data-current:ring-2',
  lane: 'bg-muted-foreground/30',
  text: 'text-muted-foreground',
};

/** `[voice:]` hands the text back to the default voice: a neutral dashed outline. */
export const VOICE_RESET_CHIP =
  'outline-1 -outline-offset-1 outline-dashed outline-muted-foreground/55 data-hover:bg-muted-foreground/12 data-hover:outline-muted-foreground/80 data-current:outline-2';

/**
 * The accent for `name` among `names` (the script's voice names in
 * first-seen order); `null` — the default voice — and unknown names are
 * neutral. Past eight voices the colors repeat.
 */
export function voiceAccent(name: string | null, names: readonly string[]): VoiceAccent {
  const index = name === null ? -1 : names.indexOf(name);
  return index < 0 ? DEFAULT_VOICE_ACCENT : VOICE_ACCENTS[index % VOICE_ACCENTS.length];
}
