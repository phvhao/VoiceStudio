import type { Draft, Mode } from './longform-session';

/**
 * How a finished book's MP4 video looks (`POST /audiobook/export/video`,
 * `backend/services/book_video.py`): kept with the book (`Draft.videoExport`)
 * so the next video starts from the last one's choices.
 */
export interface VideoDesign {
  /** The frame: landscape (YouTube), tall (Shorts, TikTok, Reels) or square. */
  aspect: '16:9' | '9:16' | '1:1';
  /** The frame's short side, in pixels. */
  quality: 720 | 1080;
  /** Pictures zoom slowly while they show. */
  motion: boolean;
  /** A picture crossfades into the next. */
  transitions: boolean;
  /** The sentences being read, burned into the picture. */
  captions: boolean;
  /** Each caption word fills as it is heard. */
  karaoke: boolean;
  /** The book's title as it opens, each chapter's as it begins. */
  titles: boolean;
  /** The captions' bundled font (`/fonts`); null: the default. */
  font: string | null;
  size: 's' | 'm' | 'l';
  /** The colour heard words fill with. */
  accent: string;
}

export const VIDEO_ASPECTS: readonly VideoDesign['aspect'][] = ['16:9', '9:16', '1:1'];
export const VIDEO_QUALITIES: readonly VideoDesign['quality'][] = [720, 1080];
export const CAPTION_SIZES: readonly VideoDesign['size'][] = ['s', 'm', 'l'];
/** Fill colours offered first; any `#rrggbb` is accepted. */
export const VIDEO_ACCENTS = ['#ffd25a', '#7dd3fc', '#86efac', '#f9a8d4', '#ffffff'] as const;
/** The captions' font unless one is chosen (it covers Vietnamese and most Latin scripts). */
export const DEFAULT_VIDEO_FONT = 'be-vietnam-pro';
const HEX_RE = /^#[0-9a-f]{6}$/i;

export const DEFAULT_VIDEO_DESIGN: VideoDesign = {
  aspect: '16:9',
  quality: 1080,
  motion: true,
  transitions: true,
  captions: true,
  karaoke: true,
  titles: true,
  font: null,
  size: 'm',
  accent: VIDEO_ACCENTS[0],
};

/**
 * A saved design as the app can use it: each choice that is missing or not
 * one it knows falls back on its own (a design from an older or newer app
 * keeps the rest); `null` when nothing was saved.
 */
export function restoreVideoDesign(value: unknown): VideoDesign | null {
  if (!value || typeof value !== 'object') return null;
  const saved = value as Partial<Record<keyof VideoDesign, unknown>>;
  const pick = <K extends keyof VideoDesign>(key: K, allowed: readonly unknown[]): VideoDesign[K] =>
    (allowed.includes(saved[key]) ? saved[key] : DEFAULT_VIDEO_DESIGN[key]) as VideoDesign[K];
  const flag = (key: 'motion' | 'transitions' | 'captions' | 'karaoke' | 'titles') =>
    typeof saved[key] === 'boolean' ? (saved[key] as boolean) : DEFAULT_VIDEO_DESIGN[key];
  return {
    aspect: pick('aspect', VIDEO_ASPECTS),
    quality: pick('quality', VIDEO_QUALITIES),
    motion: flag('motion'),
    transitions: flag('transitions'),
    captions: flag('captions'),
    karaoke: flag('karaoke'),
    titles: flag('titles'),
    font:
      typeof saved.font === 'string' && /^[a-z0-9-]{1,40}$/.test(saved.font) ? saved.font : null,
    size: pick('size', CAPTION_SIZES),
    accent:
      typeof saved.accent === 'string' && HEX_RE.test(saved.accent)
        ? saved.accent.toLowerCase()
        : DEFAULT_VIDEO_DESIGN.accent,
  };
}

/** `POST /audiobook/export/video`'s body for the draft's finished book or story. */
export function videoRequest(draft: Draft, design: VideoDesign) {
  return {
    output: draft.output,
    title: draft.title.trim() || null,
    author: draft.metadata?.author?.trim() || null,
    cover_path: draft.cover?.path ?? null,
    aspect: design.aspect,
    quality: design.quality,
    motion: design.motion,
    transitions: design.transitions,
    captions: design.captions,
    karaoke: design.karaoke,
    titles: design.titles,
    font: design.font,
    size: design.size,
    accent: design.accent,
  };
}

/** The video's name in the save dialog: the book's title, else its file name. */
export function videoExportName(draft: Draft): string {
  const stem = draft.title.trim() || draft.output.replace(/\.[^.]+$/, '') || 'audiobook';
  return `${stem}.mp4`;
}

/**
 * About how long making the video takes, in seconds, for a book of
 * `duration` seconds — from runs on a mid-range desktop CPU (a 1080p
 * picture zoom encodes at about 5× real time, a still one at about 10×),
 * rounded toward the slow side. Hardware decides the real figure.
 */
export function estimateVideoSeconds(duration: number, design: VideoDesign): number {
  const speed = design.quality === 1080 ? (design.motion ? 4 : 8) : design.motion ? 6 : 12;
  // A tall 1080p frame has as many pixels as a wide one, but its captions wrap more.
  const tall = design.aspect === '9:16' ? 0.85 : 1;
  return Math.max(10, duration / (speed * tall));
}

/** About how large the video is, in bytes (as the backend checks its disk space). */
export function estimateVideoBytes(duration: number, design: VideoDesign): number {
  return (duration * (design.quality === 1080 ? 1300 : 700) * 1000) / 8;
}

/**
 * The `[image:]` picture names the draft's script holds now, in order — to
 * tell when they differ from those its finished book was made with (the
 * book must be made again for the video to show them).
 */
export function scriptPictureNames(draft: Draft, mode: Mode, parse: (text: string) => string[]) {
  return mode === 'stories'
    ? draft.lines.flatMap((line) => parse(line.text))
    : parse(draft.script);
}
