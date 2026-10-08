export interface AudiobookRenderChapter {
  title?: string;
  status: string;
  duration_s?: number;
}

/** One phrase take in the render's timeline sidecar (seconds into the file). */
export interface AudiobookTimelinePhrase {
  text: string;
  start: number;
  end: number;
  /** The script voice in effect; null is the book's default. */
  voice?: string | null;
  /** It starts a new line or paragraph of the script (newer renders only). */
  break?: AudiobookTimelineBreak;
}

/** How a timeline phrase starts in the script it was rendered from. */
export type AudiobookTimelineBreak = 'line' | 'paragraph';

/**
 * How much of a chapter the render could time: every phrase take, only span
 * boundaries, or only the chapter itself.
 */
export type AudiobookTimelinePrecision = 'phrase' | 'span' | 'chapter';

/** `GET /audiobook/timeline/{output}`: `<output>.timeline.json` beside the book. */
export interface AudiobookTimeline {
  version: number;
  output?: string;
  duration?: number;
  chapters: Array<{
    title: string;
    /** The script gave it no title: `title` is the file's English "Chapter N". */
    untitled?: boolean;
    start: number;
    end: number;
    precision: AudiobookTimelinePrecision;
    phrases: AudiobookTimelinePhrase[];
    /** The chapter's `## Section` headings (newer renders only). */
    sections?: AudiobookTimelineSection[];
    /** The cached chapter audio it came from (newer renders only). */
    key?: string;
    /** Where the script's `[image:]` pictures show (only when it shows any). */
    images?: AudiobookTimelineImage[];
  }>;
}

/** An `[image: NAME]` picture in the timeline sidecar. */
export interface AudiobookTimelineImage {
  /** Index of the entry in the chapter's `phrases` it shows from. */
  phrase: number;
  /** When it shows, in seconds into the file. */
  start: number;
  /** The picture library's name; null: the book's own backdrop again. */
  name: string | null;
  /** `auto`: fill the frame when the shapes are close, else show it whole. */
  fit: 'auto' | 'cover' | 'contain';
}

/** A `## Section` / `### Section` heading in the timeline sidecar. */
export interface AudiobookTimelineSection {
  /** The title as the listener reads it. */
  title: string;
  level: 2 | 3;
  /** Where the heading is heard, in seconds into the file. */
  start: number;
  /** Index of its first entry in the chapter's `phrases`. */
  phrase?: number;
}

/** A section of a timed chapter, from its first word. */
export interface AudiobookLyricsSection {
  title: string;
  level: 2 | 3;
  start: number;
  wordStart: number;
}

export interface AudiobookLyricsWord {
  text: string;
  start: number;
  end: number;
  chapterIndex: number;
  /** Index into `AudiobookLyricsTimeline.phrases`; set only from a sidecar. */
  phrase?: number;
  /** The sidecar says the word starts a new line or paragraph. */
  break?: AudiobookTimelineBreak;
}

export interface AudiobookLyricsChapter {
  title: string;
  start: number;
  end: number;
  wordStart: number;
  wordCount: number;
  /** `'estimate'` when no sidecar timed the book. */
  precision: AudiobookTimelinePrecision | 'estimate';
  /** Its sections; present only when a sidecar timed the book. */
  sections?: AudiobookLyricsSection[];
}

/** A timed unit of the sidecar: a phrase take, a span, or a whole chapter. */
export interface AudiobookLyricsPhrase {
  start: number;
  end: number;
  wordStart: number;
  wordCount: number;
  chapterIndex: number;
  voice: string | null;
}

export interface AudiobookLyricsTimeline {
  chapters: AudiobookLyricsChapter[];
  words: AudiobookLyricsWord[];
  /** Present only when a sidecar timed the book. */
  phrases?: AudiobookLyricsPhrase[];
}

export function evenSplitWords(
  text: string,
  start: number,
  end: number,
): Array<Omit<AudiobookLyricsWord, 'chapterIndex'>>;

export function scriptChapters(script: string): Array<{
  /** '' for a chapter the script gave no title. */
  title: string;
  tokens: string[];
}>;

export function readTimeline(timeline: unknown): {
  chapters: Array<{
    title: string;
    start: number;
    end: number;
    precision: AudiobookTimelinePrecision;
    phrases: Array<
      Required<Omit<AudiobookTimelinePhrase, 'break'>> & Pick<AudiobookTimelinePhrase, 'break'>
    >;
    sections: Array<Omit<AudiobookTimelineSection, 'phrase'>>;
  }>;
} | null;

export function interpolateWords(
  text: string,
  start: number,
  end: number,
): Array<Omit<AudiobookLyricsWord, 'chapterIndex'>>;

export function buildLyricsTimeline(
  script: string,
  options?: {
    chapters?: AudiobookRenderChapter[] | null;
    duration?: number;
    timeline?: AudiobookTimeline | null;
  },
): AudiobookLyricsTimeline;

export function activeWordIndex(words: AudiobookLyricsWord[], time: number): number;
