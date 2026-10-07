import { useLayoutEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { ApiError, apiJson, describeError } from '@/lib/api/client';
import { tr } from '@/lib/i18n-text';
import { tokenizeMarkup, type MarkupKind } from './script-markup';

/**
 * "Retake this sentence". Read sentence by sentence, every sentence (or
 * clause) of a chapter is an engine take cached on its own, so editing one
 * no longer reads its neighbours anew; asking for one take again makes the
 * next render or preview of its chapter read that take anew and reuse every
 * other. The server lists a chapter's takes with their text as the reader
 * shows it (`/audiobook/takes`; `/longform/takes` for a Stories chapter);
 * this finds each one in the editors' text, so the sentence at the caret,
 * under a selection or around a tag is the one asked for again
 * (`/audiobook/retake`, `/longform/retake`). Pure helpers, plus the hook
 * that gives an editor its retake tools.
 */

/** A chapter's phrase take as `/audiobook/takes` lists it. */
export interface ListedTake {
  /** Its span's index in the chapter, and its own index in that span. */
  span: number;
  take: number;
  /** What it says as the reader shows it: tags left out, `[[word|respelling]]` as the word. */
  text: string;
  /** How many times it was asked for again. */
  retake: number;
  /** Whether a render would reuse its audio (`null` while the engine's rate is unknown). */
  cached: boolean | null;
}

interface TakeListing {
  /** False when the chapter is read in paragraphs: it keeps no takes to retake. */
  phrases: boolean;
  takes: ListedTake[];
}

/** One editor's text in a chapter: the Audiobook script, or one line of a Stories chapter. */
export interface TakeSource {
  /** Which editor holds it. */
  id: string;
  text: string;
  /** The chapter's part of `text`; all of it when left out. */
  from?: number;
  to?: number;
  /** `# Title` lines open chapters and are not read (Audiobook). */
  headings?: boolean;
}

/** A chapter as a retake reaches it: its request, and the text it is written in. */
export interface RetakeChapter {
  /** `audiobook`: a chapter of the script; `longform`: a Stories chapter, posted as spans. */
  api: 'audiobook' | 'longform';
  /** What the takes are listed and asked for again with: a render's inputs for the chapter. */
  body: Record<string, unknown>;
  /** Its text, in reading order. */
  sources: TakeSource[];
  /** The plan's index of the chapter (Audiobook). */
  index?: number;
}

/** A take found in its editor's text: `start…end` covers what it says. */
export interface PlacedTake extends ListedTake {
  source: string;
  start: number;
  end: number;
}

/** The takes a stretch of an editor's text reads: what a retake asks for again. */
export interface RetakeTarget {
  chapter: RetakeChapter;
  takes: PlacedTake[];
}

/** What a script editor offers for "Retake this sentence". */
export interface RetakeTools {
  /**
   * The takes `from…to` of the editor's text reads (`takesAt`); `null` when
   * it reads none. Rejects when they cannot be listed (the backend is
   * unreachable or failed), which is not "no sentence here".
   */
  find(from: number, to: number, signal?: AbortSignal): Promise<RetakeTarget | null>;
  /** Ask for each take of `target` again — after any retake asked for before it. */
  retake(target: RetakeTarget): void;
  /** Look up the takes `from…to` reads and ask for them again; says so when it reads none, or why they could not be looked up. */
  retakeAt(from: number, to: number): void;
}

// Markup that is never shown: chapter headings, a section's marks, and the
// tags the parser turns into voices, pauses, delivery and volume. Bracket
// tags left in the text (reactions, unknown tags) are not shown either.
const HIDDEN: ReadonlySet<MarkupKind> = new Set([
  'heading',
  'section',
  'voice',
  'voiceReset',
  'pause',
  'delivery',
  'volume',
  'expression',
  'unknown',
]);
const TAGS: ReadonlySet<MarkupKind> = new Set(['expression', 'unknown']);
const WHITESPACE = /\s/;

interface Shown {
  /** The shown characters of the chapter, whitespace left out. */
  keys: string;
  /** Per character: its source's index and its offset in that source's text. */
  at: Array<[source: number, offset: number]>;
  /** Bracket tags left in the text, in reading order: what a take of tags alone reads. */
  tags: Array<[source: number, start: number, end: number]>;
}

/** The chapter's text as the reader is shown it, each character mapped back to the script. */
function shownText(sources: readonly TakeSource[]): Shown {
  const shown: Shown = { keys: '', at: [], tags: [] };
  sources.forEach((source, index) => {
    const from = source.from ?? 0;
    const to = source.to ?? source.text.length;
    let offset = from;
    for (const { text, kind } of tokenizeMarkup(source.text.slice(from, to), {
      headings: source.headings,
    })) {
      if (TAGS.has(kind)) shown.tags.push([index, offset, offset + text.length]);
      // `[[word|respelling]]` shows its word; `[[respelling]]` the respelling.
      const [visible, length] =
        kind === 'pronunciation'
          ? [offset + 2, text.slice(2, -2).split('|')[0].length]
          : HIDDEN.has(kind)
            ? [offset, 0]
            : [offset, text.length];
      for (let i = visible; i < visible + length; i++) {
        const char = source.text[i];
        if (WHITESPACE.test(char)) continue;
        shown.keys += char;
        shown.at.push([index, i]);
      }
      offset += text.length;
    }
  });
  return shown;
}

/**
 * Find each listed take in the chapter's text, in reading order: its shown
 * characters (whitespace aside) follow the take before it. A take of tags
 * alone (a `[laughter]` on a line of its own) shows nothing, so it is placed
 * at the tags on the lines between its neighbours, one line of them each —
 * a tag on a neighbour's line is read with that neighbour. A take the text
 * no longer holds (a listing for an older script) is left out, never guessed.
 */
export function placeTakes(
  sources: readonly TakeSource[],
  takes: readonly ListedTake[],
): PlacedTake[] {
  const shown = shownText(sources);
  const placed: Array<PlacedTake & { sourceIndex: number }> = [];
  const lineOf = (source: number, offset: number) =>
    `${source}:${sources[source].text.lastIndexOf('\n', offset - 1)}`;
  let cursor = 0;
  // Takes of tags alone since the last placed take, waiting for the next one.
  let silent: ListedTake[] = [];
  const placeSilent = (until: [source: number, offset: number] | null) => {
    if (!silent.length) return;
    const after = placed.at(-1);
    const neighbours = new Set([
      ...(after ? [lineOf(after.sourceIndex, after.end - 1)] : []),
      ...(until ? [lineOf(...until)] : []),
    ]);
    const lines = new Map<string, Shown['tags']>();
    for (const tag of shown.tags) {
      const [source, start] = tag;
      const past =
        !after ||
        source > after.sourceIndex ||
        (source === after.sourceIndex && start >= after.end);
      const before = !until || source < until[0] || (source === until[0] && start < until[1]);
      const line = lineOf(source, start);
      if (past && before && !neighbours.has(line))
        lines.set(line, [...(lines.get(line) ?? []), tag]);
    }
    // One line of tags per take; any other count leaves them unplaced.
    if (lines.size === silent.length)
      [...lines.values()].forEach((group, k) =>
        placed.push({
          ...silent[k],
          sourceIndex: group[0][0],
          source: sources[group[0][0]].id,
          start: group[0][1],
          end: group[group.length - 1][2],
        }),
      );
    silent = [];
  };
  for (const take of takes) {
    const own = take.text.replace(/\s+/g, '');
    if (!own) {
      silent.push(take);
      continue;
    }
    const at = shown.keys.startsWith(own, cursor) ? cursor : shown.keys.indexOf(own, cursor);
    if (at < 0) continue;
    const [source, start] = shown.at[at];
    placeSilent([source, start]);
    const [lastSource, last] = shown.at[at + own.length - 1];
    placed.push({
      ...take,
      sourceIndex: source,
      source: sources[source].id,
      start,
      end: lastSource === source ? last + 1 : (sources[source].to ?? sources[source].text.length),
    });
    cursor = at + own.length;
  }
  placeSilent(null);
  return placed.map(({ sourceIndex: _index, ...take }) => take);
}

/**
 * The takes `from…to` of an editor's text reads: every take a selection
 * reaches into; at a caret (or a selection of markup alone) the take it is
 * in or right after, else the one the space or markup it sits in leads into
 * on its line — a reaction tag is read with the sentence after it — else the
 * one it follows there. None on a line with no take.
 */
export function takesAt(
  placed: readonly PlacedTake[],
  source: TakeSource,
  from: number,
  to: number,
): PlacedTake[] {
  const own = placed.filter((take) => take.source === source.id);
  if (from < to) {
    const reached = own.filter((take) => take.start < to && take.end > from);
    if (reached.length) return reached;
  }
  const at =
    own.find((take) => take.start <= from && from < take.end) ??
    own.find((take) => take.end === from);
  if (at) return [at];
  const lineStart = source.text.lastIndexOf('\n', from - 1) + 1;
  const newline = source.text.indexOf('\n', to);
  const lineEnd = newline < 0 ? source.text.length : newline;
  const next = own.find((take) => take.start >= to && take.start < lineEnd);
  if (next) return [next];
  const before = own.findLast((take) => take.end <= from && take.end > lineStart);
  return before ? [before] : [];
}

/** The takes a chapter's text reads at `from…to` of editor `source`, from the server's list. */
export async function findRetakes(
  chapter: RetakeChapter,
  source: string,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<RetakeTarget | null> {
  const editor = chapter.sources.find((candidate) => candidate.id === source);
  if (!editor) return null;
  const listing = await apiJson<TakeListing>(`/${chapter.api}/takes`, {
    method: 'POST',
    body: JSON.stringify(chapter.body),
    signal,
  });
  if (!listing.phrases) return null;
  const takes = takesAt(placeTakes(chapter.sources, listing.takes), editor, from, to);
  return takes.length ? { chapter, takes } : null;
}

/** Why a retake failed, in the app's language. */
function retakeFailure(cause: unknown): string {
  // The script no longer says that at that position (an edit raced the
  // menu), or the chapter is gone: asking again finds it where it is now.
  if (cause instanceof ApiError && [400, 404, 409].includes(cause.status))
    return tr('editor.retake_moved');
  return tr('editor.retake_failed', { message: describeError(cause) });
}

/** Ask for each take of `target` again, in reading order: the takes asked for, and why the rest could not be. */
async function askAgain(target: RetakeTarget): Promise<PlacedTake[]> {
  const asked: PlacedTake[] = [];
  try {
    for (const take of target.takes) {
      const { retake } = await apiJson<ListedTake>(`/${target.chapter.api}/retake`, {
        method: 'POST',
        body: JSON.stringify({
          ...target.chapter.body,
          span: take.span,
          take: take.take,
          phrase: take.text,
        }),
      });
      asked.push({ ...take, retake });
    }
  } catch (cause) {
    toast.error(retakeFailure(cause));
  }
  return asked;
}

/**
 * The retake tools of a page's script editors. `chapterAt` says which
 * chapter editor `source` holds at `offset` (`null` where it reads none);
 * `onRetaken` follows every retake that asked for a take, with the takes
 * it asked for, so the page refreshes what played the old ones. One retake
 * runs at a time — one asked for meanwhile waits its turn, never dropped —
 * and the takes of one go one by one, in reading order.
 */
export function useRetakes({
  chapterAt,
  onRetaken,
}: {
  chapterAt(source: string, offset: number): RetakeChapter | null;
  onRetaken(target: RetakeTarget): void;
}) {
  // The editor calls these between renders: they read the latest props.
  const latest = useRef({ chapterAt, onRetaken });
  useLayoutEffect(() => {
    latest.current = { chapterAt, onRetaken };
  });
  const waiting = useRef<RetakeTarget[]>([]);
  const running = useRef(false);
  return useMemo(() => {
    const run = async () => {
      running.current = true;
      try {
        for (let target = waiting.current.shift(); target; target = waiting.current.shift()) {
          const asked = await askAgain(target);
          if (asked.length) latest.current.onRetaken({ ...target, takes: asked });
        }
      } finally {
        running.current = false;
      }
    };
    const retake = (target: RetakeTarget) => {
      waiting.current.push(target);
      if (!running.current) void run();
    };
    return {
      /** `RetakeTools` for editor `source`. */
      tools(source: string): RetakeTools {
        const find = (from: number, to: number, signal?: AbortSignal) => {
          const chapter = latest.current.chapterAt(source, from);
          return chapter
            ? findRetakes(chapter, source, from, to, signal)
            : Promise.resolve<RetakeTarget | null>(null);
        };
        return {
          find,
          retake,
          retakeAt(from, to) {
            void find(from, to).then(
              (target) => (target ? retake(target) : toast(tr('editor.retake_none'))),
              (cause: unknown) => toast.error(retakeFailure(cause)),
            );
          },
        };
      },
    };
  }, []);
}

/** Where the paragraphs holding `takes` start and end in `text`: what plays them back in context. */
export function paragraphsAround(text: string, takes: readonly PlacedTake[]): [number, number] {
  const blank = /\n[ \t]*\n/g;
  const first = Math.min(...takes.map((take) => take.start));
  const last = Math.max(...takes.map((take) => take.end));
  let from = 0;
  let to = text.length;
  for (const match of text.matchAll(blank)) {
    const end = match.index + match[0].length;
    if (end <= first) from = end;
    else if (match.index >= last) {
      to = match.index;
      break;
    }
  }
  return [from, to];
}
