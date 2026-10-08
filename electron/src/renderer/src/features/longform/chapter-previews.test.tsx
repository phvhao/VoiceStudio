import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({
  apiFetch: mock.fetch,
  apiPath: (path: string) => path,
  describeError: String,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: ({ src }: { src: string }) => <audio data-testid="preview" src={src} />,
}));
import {
  ChapterPreview,
  useChapterPreview,
  type ChapterPreviewState,
  type RetakenChapter,
} from './chapter-previews';
import { blankLongformDraft, type Draft } from './longform-session';
import { usePreviewLock, type PreviewLock } from './preview-run';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const draft: Draft = {
  ...blankLongformDraft(),
  script: '# One\nThe night was quiet. [voice:Mara] Who is there?',
  voice: 'narrator',
};
const twoChapters: Draft = { ...draft, script: '# One\nFirst words.\n# Two\nLast words.' };

const sse = (events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** A preview stream the test writes as it goes; it errors when its request is aborted. */
function liveStream(signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const abort = () => controller.error(new DOMException('The request was aborted', 'AbortError'));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort);
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    push: (event: object) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    end: () => controller.close(),
  };
}

let state: ChapterPreviewState;
let lock: PreviewLock;
const rendered = vi.fn();
function Harness({
  value,
  label,
  held,
  retaken = null,
  settings = null,
}: {
  value: Draft;
  label?: string;
  held?: PreviewLock;
  retaken?: RetakenChapter | null;
  settings?: string | null;
}) {
  const own = usePreviewLock();
  lock = held ?? own;
  state = useChapterPreview(value, {
    disabled: false,
    canPreview: true,
    previews: lock,
    onRendered: rendered,
    retaken,
    settings,
  });
  return <ChapterPreview preview={state} label={label} />;
}

it('renders one chapter through the preview endpoint, streamed, and reports it', async () => {
  mock.fetch.mockResolvedValue(
    sse([
      { type: 'progress', index: 0, phase: 'rendering', done: 0, total: 2, phrases: true },
      { type: 'done', output: 'longform_cache/abc.wav', title: 'One' },
    ]),
  );
  render(<Harness value={draft} />);
  await act(() => state.render(0));
  expect(mock.fetch).toHaveBeenCalledWith(
    '/audiobook/preview',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(JSON.parse(mock.fetch.mock.calls[0][1].body)).toMatchObject({
    chapter_index: 0,
    text: draft.script,
    stream: true,
  });
  expect(screen.getByText('One')).toBeVisible();
  expect(screen.getByTestId('preview')).toHaveAttribute(
    'src',
    '/audio/' + encodeURIComponent('longform_cache/abc.wav'),
  );
  expect(rendered).toHaveBeenCalledTimes(1);
  expect(lock.busy).toBe(false);
});

it('takes the answer of a backend from before streamed previews', async () => {
  mock.fetch.mockResolvedValue(new Response(JSON.stringify({ output: 'c.wav', title: 'One' })));
  render(<Harness value={draft} />);
  await act(() => state.render(0));
  expect(screen.getByTestId('preview')).toHaveAttribute('src', '/audio/c.wav');
});

it('shows how far it is while it renders, and Stop ends it', async () => {
  let stream!: ReturnType<typeof liveStream>;
  mock.fetch.mockImplementation(async (_path: string, init: RequestInit) => {
    stream = liveStream(init.signal!);
    return stream.response;
  });
  render(<Harness value={draft} />);
  let rendering!: Promise<void>;
  act(() => {
    rendering = state.render(0);
  });
  expect(screen.getByRole('status')).toHaveTextContent('common.loading');
  // One preview at a time: the page's other previews and Generate wait.
  expect(lock.busy).toBe(true);
  await act(async () => stream.push({ type: 'progress', index: 0, phase: 'loading' }));
  expect(await screen.findByText('audiobook.progress_loading')).toBeVisible();
  await act(async () =>
    stream.push({ type: 'progress', index: 0, phase: 'rendering', done: 2, total: 6, rate: 3 }),
  );
  expect(await screen.findByText(/audiobook\.progress_parts/)).toBeVisible();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'common.stop' }));
    await rendering;
  });
  expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(screen.queryByRole('status')).toBeNull();
  // Stopped is no failure, and the lock is free again.
  expect(state.error).toBeNull();
  expect(lock.busy).toBe(false);
  expect(rendered).toHaveBeenCalledTimes(1);
});

it('stays current while another chapter changes, and is outdated once its own does', async () => {
  mock.fetch.mockResolvedValue(sse([{ type: 'done', output: 'one.wav', title: 'One' }]));
  const view = render(<Harness value={twoChapters} />);
  await act(() => state.render(0));
  view.rerender(
    <Harness
      value={{ ...twoChapters, script: '# One\nFirst words.\n# Two\nLast words, edited.' }}
    />,
  );
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  view.rerender(
    <Harness
      value={{ ...twoChapters, script: '# One\nFirst words, edited.\n# Two\nLast words.' }}
    />,
  );
  // Kept, and marked: it no longer sounds like its chapter.
  expect(screen.getByText('audiobook.preview_outdated')).toBeVisible();
  expect(screen.getByTestId('preview')).toBeInTheDocument();
  view.rerender(<Harness value={twoChapters} />);
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
});

it('stays current when a picture is added, moved or removed: pictures change no audio', async () => {
  mock.fetch.mockResolvedValue(sse([{ type: 'done', output: 'one.wav', title: 'One' }]));
  const view = render(<Harness value={twoChapters} />);
  await act(() => state.render(0));
  for (const script of [
    '# One\n[image: a.jpg]\nFirst words.\n# Two\nLast words.',
    '# One\nFirst [image: a.jpg contain] words.\n# Two\nLast words.',
  ]) {
    view.rerender(<Harness value={{ ...twoChapters, script }} />);
    expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  }
  view.rerender(<Harness value={{ ...twoChapters, script: '# One\nFirst [image: a.jpg] word.\n# Two\nLast words.' }} />);
  expect(screen.getByText('audiobook.preview_outdated')).toBeVisible();
});

it('is outdated by a volume its chapter speaks, not by one it does not', async () => {
  mock.fetch.mockResolvedValue(sse([{ type: 'done', output: 'longform_cache/abc.wav' }]));
  const view = render(<Harness value={draft} />);
  await act(() => state.render(0));
  view.rerender(<Harness value={{ ...draft, voiceGains: { Ben: 6 } }} />);
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  view.rerender(<Harness value={{ ...draft, voiceGains: { Mara: 3 } }} />);
  expect(screen.getByText('audiobook.preview_outdated')).toBeVisible();
});

it('renders on through an edit to its chapter, and its audio comes back outdated', async () => {
  let stream!: ReturnType<typeof liveStream>;
  mock.fetch.mockImplementation(async (_path: string, init: RequestInit) => {
    stream = liveStream(init.signal!);
    return stream.response;
  });
  const view = render(<Harness value={twoChapters} />);
  let rendering!: Promise<void>;
  act(() => {
    rendering = state.render(0);
  });
  view.rerender(
    <Harness
      value={{ ...twoChapters, script: '# One\nFirst words, edited.\n# Two\nLast words.' }}
    />,
  );
  await act(async () => {
    stream.push({ type: 'done', output: 'one.wav', title: 'One' });
    stream.end();
    await rendering;
  });
  expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(false);
  expect(screen.getByTestId('preview')).toHaveAttribute('src', '/audio/one.wav');
  expect(screen.getByText('audiobook.preview_outdated')).toBeVisible();
});

it('stops and puts away its preview when another book opens', async () => {
  let stream!: ReturnType<typeof liveStream>;
  mock.fetch.mockImplementation(async (_path: string, init: RequestInit) => {
    stream = liveStream(init.signal!);
    return stream.response;
  });
  const book = { ...draft, projectId: 'book-a' };
  const view = render(<Harness value={book} />);
  let rendering!: Promise<void>;
  act(() => {
    rendering = state.render(0);
  });
  act(() => view.rerender(<Harness value={{ ...book, projectId: 'book-b' }} />));
  await act(() => rendering);
  expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(lock.busy).toBe(false);
  expect(screen.queryByTestId('preview')).toBeNull();

  mock.fetch.mockResolvedValue(sse([{ type: 'done', output: 'b.wav', title: 'One' }]));
  await act(() => state.render(0));
  expect(screen.getByTestId('preview')).toBeInTheDocument();
  view.rerender(<Harness value={{ ...book, projectId: 'book-c' }} />);
  expect(screen.queryByTestId('preview')).toBeNull();
});

it('waits while another preview renders', async () => {
  const held: PreviewLock = {
    holder: 'passage',
    chapter: null,
    busy: true,
    acquire: () => false,
    release: vi.fn(),
  };
  render(<Harness value={draft} held={held} />);
  await act(() => state.render(0));
  expect(mock.fetch).not.toHaveBeenCalled();
  expect(held.release).not.toHaveBeenCalled();
});

it("names an untitled chapter in the app's language, never the render's English", async () => {
  mock.fetch.mockResolvedValue(
    sse([{ type: 'done', output: 'c.wav', title: 'Chapter 1', untitled: true }]),
  );
  render(<Harness value={draft} />);
  await act(() => state.render(0));
  expect(screen.queryByText('Chapter 1')).toBeNull();
  // The test's `t` returns the key: the localized "Chapter N".
  expect(screen.getByText('audiobook.chapter_n')).toBeVisible();
  expect(state.output).toMatchObject({ output: 'c.wav', index: 0, title: '' });
});

it("takes the outline's name for the chapter, and closes", async () => {
  mock.fetch.mockResolvedValue(
    sse([{ type: 'done', output: 'c.wav', title: 'Chapter 1', untitled: true }]),
  );
  render(<Harness value={draft} label="Intro (untitled)" />);
  await act(() => state.render(0));
  expect(screen.getByText('Intro (untitled)')).toBeVisible();
  act(() => screen.getByRole('button', { name: 'common.close' }).click());
  expect(screen.queryByTestId('preview')).toBeNull();
});

it('stops rendering once a sentence of its chapter is retaken: the audio would read the old take', async () => {
  let stream!: ReturnType<typeof liveStream>;
  mock.fetch.mockImplementation(async (_path: string, init: RequestInit) => {
    stream = liveStream(init.signal!);
    return stream.response;
  });
  const view = render(<Harness value={twoChapters} />);
  let rendering!: Promise<void>;
  act(() => {
    rendering = state.render(1);
  });
  expect(lock.chapter).toBe(1);
  // A retake of the other chapter leaves it rendering.
  view.rerender(<Harness value={twoChapters} retaken={{ chapter: 0, id: 1 }} />);
  expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(false);
  view.rerender(<Harness value={twoChapters} retaken={{ chapter: 1, id: 2 }} />);
  await act(() => rendering);
  expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(screen.queryByTestId('preview')).toBeNull();
  // Free for the retake's own audition at once.
  expect(lock.busy).toBe(false);
  expect(state.error).toBeNull();
});

it('is outdated once the engine, preset or reading it rendered under changes', async () => {
  mock.fetch.mockResolvedValue(sse([{ type: 'done', output: 'one.wav', title: 'One' }]));
  const view = render(<Harness value={twoChapters} settings='["fast"]' />);
  await act(() => state.render(0));
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  // Still being asked: says nothing either way.
  view.rerender(<Harness value={twoChapters} settings={null} />);
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  view.rerender(<Harness value={twoChapters} settings='["quality"]' />);
  expect(screen.getByText('audiobook.preview_outdated')).toBeVisible();
  view.rerender(<Harness value={twoChapters} settings='["fast"]' />);
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
});
