/** How an `[image:]` picture meets the frame. */
export type ImageFit = 'auto' | 'cover' | 'contain';

export const IMAGE_FITS: readonly ImageFit[];
/** The name `[image: none]` uses: back to the book's own backdrop. */
export const IMAGE_NONE: 'none';

/** An `[image:]` tag taken out of a script. */
export interface ImageMark {
  /** Where the tag stood in the returned text (UTF-16 offset). */
  pos: number;
  /** The library picture; null: the book's own backdrop. */
  name: string | null;
  fit: ImageFit;
}

/**
 * The script without its `[image:]` tags — the text the render reads (a tag
 * alone on its line goes with its line, one inside a line with one space) —
 * and the tags taken out. Mirrors `extract_image_marks` in
 * `backend/services/longform_parser.py`.
 */
export function extractImageMarks(text: string): [string, ImageMark[]];

/** The chapters the backend renders from a script (`parse_script_to_spans`). */
export function parseScriptToSpans(
  text: string,
  options?: { defaultVoice?: string | null; defaultSpeed?: number | null },
): {
  title: string;
  /** The script gave it no title. */
  untitled?: boolean;
  spans: {
    voice_id: string | null;
    text: string;
    pause_ms_after: number;
    speed?: number | null;
    /** `[image:]` pictures shown from inside this span: the character (code point) of `text` each shows from. */
    images?: { at: number; name: string | null; fit: ImageFit }[];
  }[];
}[];
