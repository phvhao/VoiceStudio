import { apiPath } from '@/lib/api/client';
import type { AudiobookTimeline } from '@shared/utils/audiobookLyrics';
import type { ReaderBook } from './audiobook-reader';

/**
 * The slideshow of a rendered book: the `[image: NAME]` pictures of its
 * script, shown from where the reading reaches each (the timeline's
 * `chapters[].images`), with the sentence being read as a caption. Pure
 * helpers here; the view is `reader-slideshow.tsx`. The exported HTML book
 * and the MP4 video (`backend/services/book_video.py`) follow the same rules.
 */

/** How a picture meets the frame (`auto`: fill when the shapes are close, else whole). */
export type ImageFit = 'auto' | 'cover' | 'contain';

export interface Slide {
  /** Seconds into the book. */
  start: number;
  /** The library picture; null is the book's own backdrop (its cover) again. */
  name: string | null;
  fit: ImageFit;
}

const FITS = new Set<ImageFit>(['auto', 'cover', 'contain']);
/** Under `auto`, a picture fills the frame when the two shapes are within this ratio. */
export const AUTO_FILL_RATIO = 1.3;
/** A caption holds at most about this many characters of its sentence. */
export const CAPTION_CHARS = 90;

/**
 * The pictures of a timeline in the order they show. Two at one moment: the
 * later one; the same picture again right after itself is not a new slide.
 */
export function timelineSlides(
  timeline: Pick<AudiobookTimeline, 'chapters'> | null | undefined,
): Slide[] {
  const found: Slide[] = [];
  for (const chapter of timeline?.chapters ?? []) {
    // A sidecar is read as it is on disk: anything here may be malformed.
    const images: unknown = (chapter as { images?: unknown } | null)?.images;
    if (!Array.isArray(images)) continue;
    for (const image of images as Array<Record<string, unknown> | null>) {
      if (!image || typeof image.start !== 'number' || !Number.isFinite(image.start)) continue;
      found.push({
        start: Math.max(0, image.start),
        name: typeof image.name === 'string' && image.name ? image.name : null,
        fit: FITS.has(image.fit as ImageFit) ? (image.fit as ImageFit) : 'auto',
      });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const slides: Slide[] = [];
  for (const slide of found) {
    const last = slides[slides.length - 1];
    if (last && Math.abs(last.start - slide.start) < 1e-6) slides[slides.length - 1] = slide;
    else if (!last || last.name !== slide.name || last.fit !== slide.fit) slides.push(slide);
  }
  return slides;
}

/** The slide showing at `time`: the last that started by then, -1 before the first. */
export function slideIndexAt(slides: readonly Slide[], time: number): number {
  let lo = 0;
  let hi = slides.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (slides[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Whether a picture shows whole (on a blurred copy of itself) rather than filling the frame. */
export function showsWhole(
  fit: ImageFit,
  picture: { width: number; height: number },
  frame: { width: number; height: number },
): boolean {
  if (fit !== 'auto') return fit === 'contain';
  if (!picture.width || !picture.height || !frame.width || !frame.height) return false;
  const shape = picture.width / picture.height / (frame.width / frame.height);
  return shape < 1 / AUTO_FILL_RATIO || shape > AUTO_FILL_RATIO;
}

/** A library picture's URL (`thumb`: the small one the picker shows). */
export function imageUrl(name: string, { thumb = false, version }: { thumb?: boolean; version?: number } = {}) {
  const query = new URLSearchParams();
  if (thumb) query.set('thumb', '1');
  if (version !== undefined) query.set('v', String(version));
  const search = query.toString();
  return apiPath(`/longform/images/${encodeURIComponent(name)}${search ? `?${search}` : ''}`);
}

/** The book's cover as the app serves it (outputs are served at `/audio`). */
export function coverUrl(cover: { path: string } | null | undefined): string | undefined {
  const name = cover?.path.split(/[\\/]/).pop();
  return name ? apiPath(`/audio/audiobook_covers/${encodeURIComponent(name)}`) : undefined;
}

/**
 * The words the caption holding word `word` shows: `[from, to]` (inclusive)
 * within its sentence, cut into pieces of about `limit` characters so a long
 * sentence never fills the picture. `null` when no word is being read.
 */
export function captionWords(
  book: ReaderBook,
  sentence: number,
  word: number,
  limit = CAPTION_CHARS,
): [number, number] | null {
  if (sentence < 0 || word < 0 || !book.sentences[sentence]) return null;
  const { start, end } = book.sentences[sentence];
  let from = start;
  let size = 0;
  for (let i = start; i < end; i++) {
    const text = book.words[i].display;
    if (!text) continue;
    const add = text.length + (size ? 1 : 0);
    if (size && size + add > limit) {
      if (word < i) return [from, i - 1];
      from = i;
      size = text.length;
      continue;
    }
    size += add;
  }
  return [from, end - 1];
}
