export function storyToSpans(
  tracks: { text: string; profileId?: string | null; character?: string; speed?: number | null }[],
  cast: { id: string; profileId: string | null; name?: string }[],
  globalSpeed?: number | null,
  options?: {
    /** Also say where each line starts and who says it (the render's plan). */
    layout?: boolean;
  },
): {
  title: string;
  spans: {
    voice_id: string | null;
    text: string;
    pause_ms_after: number;
    speed?: number | null;
    join?: 'continue' | 'paragraph';
    /** A `[volume]` passage's gain in dB. */
    gain_db?: number;
    /** `layout`: the span starts a new line of the story. */
    break_before?: 'paragraph';
    /** `layout`: the line's character, by name and cast slot (the editor's colour). */
    speaker?: { name: string; accent: number };
    /** `[image:]` pictures shown from inside this span: the character (code point) of `text` each shows from. */
    images?: { at: number; name: string | null; fit: 'auto' | 'cover' | 'contain' }[];
  }[];
}[];
