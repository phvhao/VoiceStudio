import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storyToSpans } from '@shared/utils/storyToSpans';
import { scriptOutline } from './script-outline';

const mock = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly detail: string,
    ) {
      super(detail);
    }
  }
  return { api: vi.fn(), toast: Object.assign(vi.fn(), { error: vi.fn() }), ApiError };
});
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.api,
  ApiError: mock.ApiError,
  describeError: (cause: Error) => cause.message,
}));
vi.mock('sonner', () => ({ toast: mock.toast }));
vi.mock('@/lib/i18n-text', () => ({
  tr: (key: string, options?: object) => (options ? `${key} ${JSON.stringify(options)}` : key),
}));
import {
  findRetakes,
  paragraphsAround,
  placeTakes,
  takesAt,
  useRetakes,
  type ListedTake,
  type PlacedTake,
  type RetakeChapter,
  type TakeSource,
} from './take-retake';

afterEach(() => {
  vi.clearAllMocks();
});

/** Takes as `/audiobook/takes` lists them: one span, in reading order. */
const listed = (...texts: string[]): ListedTake[] =>
  texts.map((text, take) => ({ span: 0, take, text, retake: 0, cached: true }));

/** Where each placed take reads in `text`. */
const read = (text: string, takes: ReturnType<typeof placeTakes>) =>
  takes.map((take) => text.slice(take.start, take.end));

describe('placeTakes', () => {
  it('finds takes around a picture, which is never shown', () => {
    const text = 'Hello [image: a.jpg] world. Bye now.\n[image: b.jpg]\nLast one.';
    const takes = placeTakes(
      [{ id: 'script', text, headings: true }],
      listed('Hello world.', 'Bye now.', 'Last one.'),
    );
    expect(read(text, takes)).toEqual(['Hello [image: a.jpg] world.', 'Bye now.', 'Last one.']);
  });

  it('finds each take in the script as the reader shows it, markup aside', () => {
    const text =
      '# One\nIt was late. [voice:Mara] [slow]Who is [[there|thair]]?[/slow]\n\n' +
      '## The door\n[laughter] He opened it, slowly. [pause 1s] Nobody.';
    const source: TakeSource = { id: 'script', text, headings: true };
    const takes = placeTakes(
      [source],
      listed('It was late.', 'Who is there?', 'The door', 'He opened it, slowly.', 'Nobody.'),
    );
    expect(read(text, takes)).toEqual([
      'It was late.',
      // The respelling reads as its word; the closing tag is not shown.
      'Who is [[there|thair]]?',
      'The door',
      'He opened it, slowly.',
      'Nobody.',
    ]);
  });

  it('reads only the chapter it is given, and skips what the text no longer holds', () => {
    const text = '# One\nSame words here.\n# Two\nSame words here. Then more.';
    const two = text.indexOf('# Two');
    const takes = placeTakes(
      [{ id: 'script', text, from: two, to: text.length, headings: true }],
      listed('Edited away since.', 'Same words here.', 'Then more.'),
    );
    expect(takes.map((take) => [take.take, take.start])).toEqual([
      [1, text.lastIndexOf('Same words')],
      [2, text.indexOf('Then more')],
    ]);
  });

  it('places repeats in reading order and a take broken across lines whole', () => {
    const text = 'Again and again.\nAgain and again.\nA sentence that runs\non to the next line.';
    expect(
      read(
        text,
        placeTakes(
          [{ id: 's', text }],
          listed(
            'Again and again.',
            'Again and again.',
            'A sentence that runs on to the next line.',
          ),
        ),
      ),
    ).toEqual([
      'Again and again.',
      'Again and again.',
      'A sentence that runs\non to the next line.',
    ]);
    expect(
      placeTakes([{ id: 's', text }], listed('Again and again.', 'Again and again.'))[1].start,
    ).toBe(17);
  });

  it('places a take of tags alone at its own line of tags, never a neighbour’s', () => {
    const text = 'The keeper climbed the stairs.\n[laughter]\n[sigh] He lit the lamp.';
    // The splitter reads the lone [laughter] as a take of its own; [sigh]
    // leads the next sentence, so it belongs to that take.
    const takes = placeTakes(
      [{ id: 's', text }],
      listed('The keeper climbed the stairs.', '', 'He lit the lamp.'),
    );
    expect(read(text, takes)).toEqual([
      'The keeper climbed the stairs.',
      '[laughter]',
      'He lit the lamp.',
    ]);
  });

  it('finds a Stories chapter’s takes in its lines', () => {
    const lines: TakeSource[] = [
      { id: 'a', text: 'First line, first sentence. Second one.' },
      { id: 'b', text: '' },
      { id: 'c', text: '[voice:Mara] Her line.' },
    ];
    const takes = placeTakes(lines, [
      ...listed('First line, first sentence.', 'Second one.'),
      { span: 1, take: 0, text: 'Her line.', retake: 2, cached: false },
    ]);
    expect(takes.map((take) => [take.source, take.start, take.end, take.retake])).toEqual([
      ['a', 0, 27, 0],
      ['a', 28, 39, 0],
      ['c', 13, 22, 2],
    ]);
  });
});

interface CorpusCase {
  name: string;
  script?: string;
  chapter_index?: number;
  lines?: Array<{ id: string; text: string; profileId: string | null; speed?: number }>;
  chapter?: unknown;
  takes: Array<[span: number, take: number, text: string]>;
  placed: Array<[span: number, take: number, source: string, start: number, text: string]>;
}

// What the backend lists for these chapters, held equal to it by
// tests/test_longform_segment_cache.py: the editor must find every take.
const CORPUS = Object.values(
  import.meta.glob<CorpusCase[]>('../../../../../../tests/fixtures/retake_take_cases.json', {
    eager: true,
    import: 'default',
  }),
)[0];

describe('the backend’s take lists', () => {
  it.each(CORPUS)('places every take of $name', (corpus) => {
    const takes = corpus.takes.map(([span, take, text]) => ({
      span,
      take,
      text,
      retake: 0,
      cached: null,
    }));
    let sources: TakeSource[];
    if (corpus.script !== undefined) {
      const chapter = scriptOutline(corpus.script).find(
        (node) => node.plan === corpus.chapter_index,
      )!;
      sources = [
        { id: 'script', text: corpus.script, from: chapter.start, to: chapter.end, headings: true },
      ];
    } else {
      // The chapter posted is what the Stories compiler makes of these lines.
      expect(storyToSpans(corpus.lines!, [], null)[0]).toEqual(corpus.chapter);
      sources = corpus.lines!.map((line) => ({ id: line.id, text: line.text }));
    }
    const text = (id: string) => sources.find((source) => source.id === id)!.text;
    expect(
      placeTakes(sources, takes).map((take) => [
        take.span,
        take.take,
        take.source,
        take.start,
        text(take.source).slice(take.start, take.end),
      ]),
    ).toEqual(corpus.placed);
  });
});

describe('takesAt', () => {
  const text = 'One sentence here. [laughter] Two sentence.\n\nThree is alone.   \n# Heading';
  const source: TakeSource = { id: 's', text };
  const placed = placeTakes(
    [source],
    listed('One sentence here.', 'Two sentence.', 'Three is alone.'),
  );
  const at = (from: number, to = from) =>
    takesAt(placed, source, from, to).map((take) => take.text);

  it('is the sentence the caret is in, or just after', () => {
    expect(at(text.indexOf('sentence here'))).toEqual(['One sentence here.']);
    expect(at(text.indexOf('here.') + 'here.'.length)).toEqual(['One sentence here.']);
  });

  it('between sentences, is the one the space or tag leads into on that line, else the one before', () => {
    // A reaction before a sentence is read with it.
    expect(at(text.indexOf('[laughter]') + 3)).toEqual(['Two sentence.']);
    expect(at(text.indexOf('alone.') + 'alone.'.length + 2)).toEqual(['Three is alone.']);
    // A blank line or a heading holds none.
    expect(at(text.indexOf('\n\n') + 1)).toEqual([]);
    expect(at(text.indexOf('# Heading') + 3)).toEqual([]);
  });

  it('is every sentence a selection reaches into', () => {
    expect(at(text.indexOf('here'), text.indexOf('Two') + 2)).toEqual([
      'One sentence here.',
      'Two sentence.',
    ]);
    // A selection of markup alone reads like a caret there.
    expect(at(text.indexOf('[laughter]'), text.indexOf('[laughter]') + 10)).toEqual([
      'Two sentence.',
    ]);
  });
});

it('plays a retake back in the paragraphs that hold it', () => {
  const text = 'First paragraph.\n\nSecond, one. Second, two.\n  \nThird paragraph.';
  const placed = placeTakes(
    [{ id: 's', text }],
    listed('First paragraph.', 'Second, one.', 'Second, two.', 'Third paragraph.'),
  );
  const [from, to] = paragraphsAround(text, [placed[2]]);
  expect(text.slice(from, to)).toBe('Second, one. Second, two.');
  const [all, end] = paragraphsAround(text, [placed[0], placed[3]]);
  expect(text.slice(all, end)).toBe(text);
});

const chapter: RetakeChapter = {
  api: 'audiobook',
  body: { text: '# One\nHi there, friend. Bye now, friend.', chapter_index: 0 },
  index: 0,
  sources: [{ id: 'script', text: '# One\nHi there, friend. Bye now, friend.', headings: true }],
};

it('lists the chapter’s takes with its own request and picks the one at the caret', async () => {
  mock.api.mockResolvedValueOnce({
    phrases: true,
    takes: listed('Hi there, friend.', 'Bye now, friend.'),
  });
  const target = await findRetakes(chapter, 'script', 26, 26);
  expect(mock.api).toHaveBeenCalledWith(
    '/audiobook/takes',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(JSON.parse(mock.api.mock.calls[0][1].body)).toEqual(chapter.body);
  expect(target?.takes.map((take) => take.text)).toEqual(['Bye now, friend.']);
  // Read in paragraphs, a chapter keeps no takes to retake.
  mock.api.mockResolvedValueOnce({ phrases: false, takes: [] });
  expect(await findRetakes(chapter, 'script', 26, 26)).toBeNull();
});

it('asks for each take again in turn, then hands the page what it asked for', async () => {
  const onRetaken = vi.fn();
  const { result } = renderHook(() => useRetakes({ chapterAt: () => chapter, onRetaken }));
  mock.api.mockResolvedValueOnce({
    phrases: true,
    takes: listed('Hi there, friend.', 'Bye now, friend.'),
  });
  const tools = result.current.tools('script');
  const target = await tools.find(6, 40);
  expect(target?.takes).toHaveLength(2);
  mock.api.mockResolvedValueOnce({ retake: 1 }).mockResolvedValueOnce({ retake: 3 });
  await act(async () => {
    tools.retake(target!);
    await vi.waitFor(() => expect(onRetaken).toHaveBeenCalled());
  });
  expect(mock.api.mock.calls.slice(1).map(([path, init]) => [path, JSON.parse(init.body)])).toEqual(
    [
      ['/audiobook/retake', { ...chapter.body, span: 0, take: 0, phrase: 'Hi there, friend.' }],
      ['/audiobook/retake', { ...chapter.body, span: 0, take: 1, phrase: 'Bye now, friend.' }],
    ],
  );
  expect(onRetaken.mock.calls[0][0].takes.map((take: ListedTake) => take.retake)).toEqual([1, 3]);
  expect(mock.toast.error).not.toHaveBeenCalled();
});

it('says when the script moved under a retake, and reports the takes it did ask for', async () => {
  const onRetaken = vi.fn();
  const { result } = renderHook(() => useRetakes({ chapterAt: () => chapter, onRetaken }));
  mock.api.mockResolvedValueOnce({
    phrases: true,
    takes: listed('Hi there, friend.', 'Bye now, friend.'),
  });
  const tools = result.current.tools('script');
  const target = await tools.find(6, 40);
  mock.api
    .mockResolvedValueOnce({ retake: 1 })
    .mockRejectedValueOnce(
      new mock.ApiError(409, 'the take at that position says something else now'),
    );
  await act(async () => {
    tools.retake(target!);
    await vi.waitFor(() => expect(mock.toast.error).toHaveBeenCalled());
  });
  expect(mock.toast.error).toHaveBeenCalledWith('editor.retake_moved');
  expect(onRetaken.mock.calls[0][0].takes.map((take: ListedTake) => take.text)).toEqual([
    'Hi there, friend.',
  ]);
  // Nowhere to look: no chapter there, no request.
  const none = renderHook(() => useRetakes({ chapterAt: () => null, onRetaken })).result.current;
  expect(await none.tools('script').find(0, 0)).toBeNull();
  expect(mock.api).toHaveBeenCalledTimes(3);
});

/** A take of `chapter`, found at `start` of its script. */
const placedAt = (text: string, start: number, take: number): PlacedTake => ({
  span: 0,
  take,
  text,
  retake: 0,
  cached: true,
  source: 'script',
  start,
  end: start + text.length,
});

it('runs a retake asked for while another runs after it, never dropping it', async () => {
  const onRetaken = vi.fn();
  const { result } = renderHook(() => useRetakes({ chapterAt: () => chapter, onRetaken }));
  const tools = result.current.tools('script');
  let answer!: (value: { retake: number }) => void;
  mock.api
    .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    .mockResolvedValueOnce({ retake: 1 });
  await act(async () => {
    tools.retake({ chapter, takes: [placedAt('Hi there, friend.', 6, 0)] });
    // Chosen again before the first one is saved: it waits its turn.
    tools.retake({ chapter, takes: [placedAt('Bye now, friend.', 24, 1)] });
  });
  expect(mock.api).toHaveBeenCalledTimes(1);
  await act(async () => {
    answer({ retake: 2 });
    await vi.waitFor(() => expect(onRetaken).toHaveBeenCalledTimes(2));
  });
  expect(mock.api.mock.calls.map(([, init]) => JSON.parse(init.body).take)).toEqual([0, 1]);
  expect(
    onRetaken.mock.calls.map(([target]) => [target.takes[0].text, target.takes[0].retake]),
  ).toEqual([
    ['Hi there, friend.', 2],
    ['Bye now, friend.', 1],
  ]);
});

it('tells a sentence it could not look up from no sentence there', async () => {
  const onRetaken = vi.fn();
  const tools = renderHook(() =>
    useRetakes({ chapterAt: () => chapter, onRetaken }),
  ).result.current.tools('script');
  mock.api.mockRejectedValueOnce(new mock.ApiError(503, '[starting] the backend is starting'));
  await expect(tools.find(26, 26)).rejects.toThrow('[starting]');
  mock.api.mockRejectedValueOnce(new mock.ApiError(0, 'Failed to fetch'));
  tools.retakeAt(26, 26);
  await vi.waitFor(() =>
    expect(mock.toast.error).toHaveBeenCalledWith(
      'editor.retake_failed {"message":"Failed to fetch"}',
    ),
  );
  expect(mock.toast).not.toHaveBeenCalled();
  mock.api.mockResolvedValueOnce({ phrases: true, takes: [] });
  tools.retakeAt(26, 26);
  await vi.waitFor(() => expect(mock.toast).toHaveBeenCalledWith('editor.retake_none'));
  expect(onRetaken).not.toHaveBeenCalled();
});
