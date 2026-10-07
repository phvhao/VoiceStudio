import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({
  apiFetch: api,
  apiJson: vi.fn(),
  describeError: (cause: Error) => cause.message,
}));
import { chapterPreviewBody, longformSession } from './longform-session';
import { usePassagePreview } from './passage-preview';
import { usePreviewLock } from './preview-run';

afterEach(() => {
  vi.clearAllMocks();
});

const answer = (body: object) => new Response(JSON.stringify(body));

it('sends a passage with where it is read, so it plays the book’s own takes there', async () => {
  const draft = { ...longformSession.state.drafts.audiobook, voice: 'narrator' };
  const { result } = renderHook(() => usePassagePreview(draft, usePreviewLock()));
  api.mockImplementation(async () => answer({ output: 'passage.wav' }));
  const context = { chapter: '# One\nYes.\n\nNo.\n\nYes.', start: 17, end: 21 };
  await act(() => result.current.preview('Yes.', context));
  expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({
    ...chapterPreviewBody({ ...draft, script: 'Yes.' }, 0),
    context,
    stream: true,
  });
  expect(result.current.output).toBe('passage.wav');
  // A passage across chapters is sent on its own.
  await act(() => result.current.preview('Yes.', null));
  expect(JSON.parse(api.mock.calls[1][1].body)).not.toHaveProperty('context');
});

it('hears its progress, holds the page’s preview lock while it renders, and Stop ends it', async () => {
  const draft = { ...longformSession.state.drafts.audiobook, voice: 'narrator' };
  let push!: (event: object) => void;
  api.mockImplementation(async (_path: string, init: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    init.signal!.addEventListener('abort', () =>
      controller.error(new DOMException('The request was aborted', 'AbortError')),
    );
    push = (event) =>
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const { result } = renderHook(() => {
    const lock = usePreviewLock();
    return { lock, passage: usePassagePreview(draft, lock) };
  });
  let previewing!: Promise<void>;
  act(() => {
    previewing = result.current.passage.preview('Yes, it is.');
  });
  expect(result.current.lock.holder).toBe('passage');
  await act(async () =>
    push({ type: 'progress', index: 0, phase: 'rendering', done: 1, total: 3, phrases: true }),
  );
  await vi.waitFor(() => expect(result.current.passage.progress).toMatchObject({ done: 1 }));
  await act(async () => {
    result.current.passage.stop();
    await previewing;
  });
  expect(result.current.passage.pending).toBe(false);
  expect(result.current.passage.progress).toBeNull();
  expect(result.current.passage.error).toBeNull();
  expect(result.current.lock.busy).toBe(false);
});

it('waits while another preview holds the lock', async () => {
  const draft = { ...longformSession.state.drafts.audiobook, voice: 'narrator' };
  const held = {
    holder: 'chapter' as const,
    chapter: 0,
    busy: true,
    acquire: () => false,
    release: vi.fn(),
  };
  const { result } = renderHook(() => usePassagePreview(draft, held));
  await act(() => result.current.preview('Yes.'));
  expect(api).not.toHaveBeenCalled();
  expect(held.release).not.toHaveBeenCalled();
});
