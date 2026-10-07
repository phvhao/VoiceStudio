import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({
  apiJson: api,
  apiFetch: vi.fn(),
  describeError: (cause: Error) => cause.message,
}));
import { chapterPreviewBody, longformSession } from './longform-session';
import { usePassagePreview } from './passage-preview';

afterEach(() => {
  vi.clearAllMocks();
});

it('sends a passage with where it is read, so it plays the book’s own takes there', async () => {
  const draft = { ...longformSession.state.drafts.audiobook, voice: 'narrator' };
  const { result } = renderHook(() => usePassagePreview(draft, vi.fn()));
  api.mockResolvedValue({ output: 'passage.wav' });
  const context = { chapter: '# One\nYes.\n\nNo.\n\nYes.', start: 17, end: 21 };
  await act(() => result.current.preview('Yes.', context));
  expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({
    ...chapterPreviewBody({ ...draft, script: 'Yes.' }, 0),
    context,
  });
  expect(result.current.output).toBe('passage.wav');
  // A passage across chapters is sent on its own.
  await act(() => result.current.preview('Yes.', null));
  expect(JSON.parse(api.mock.calls[1][1].body)).not.toHaveProperty('context');
});
