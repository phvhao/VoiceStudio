import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';

const mock = vi.hoisted(() => ({
  api: vi.fn(),
  fetch: vi.fn(),
  save: vi.fn(),
  edit: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/api/client', async (original) => ({
  ...(await original<typeof import('@/lib/api/client')>()),
  apiJson: mock.api,
  apiFetch: mock.fetch,
  apiPath: (path: string) => '/api' + path,
}));
vi.mock('@/lib/export-history', () => ({ saveExport: mock.save }));
vi.mock('@/components/bridge', () => ({ getBridge: () => ({}) }));
vi.mock('sonner', () => ({ toast: mock.toast }));
vi.mock('./longform-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./longform-session')>()),
  editLongform: mock.edit,
}));

import { ApiError } from '@/lib/api/client';
import { queryClient as appQueries } from '@/lib/query';
import { ExportVideoButton } from './video-export-dialog';
import { blankLongformDraft, type Draft } from './longform-session';

const timeline = {
  version: 1,
  output: 'audiobook_ab.m4b',
  duration: 3600,
  chapters: [
    {
      title: 'One',
      start: 0,
      end: 3600,
      precision: 'phrase',
      phrases: [{ text: 'Ngày đầu tiên nhập học.', start: 0.4, end: 3, voice: null }],
      sections: [],
      images: [{ phrase: 0, start: 0.4, name: 'dawn.jpg', fit: 'auto' }],
    },
  ],
};

function stream(events: object[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const draft: Draft = {
  ...blankLongformDraft(),
  output: 'audiobook_ab.m4b',
  title: 'Book',
  script: '[image: dawn.jpg]\nNgày đầu tiên nhập học.',
};

beforeEach(() => {
  mock.api.mockImplementation(async (path: string) => {
    if (path.startsWith('/audiobook/timeline/')) return timeline;
    if (path === '/fonts') return { families: [] };
    if (path === '/longform/images')
      return { images: [{ name: 'dawn.jpg', width: 1600, height: 900, bytes: 1, version: 1 }] };
    throw new Error('unexpected ' + path);
  });
  mock.fetch.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response('{}');
    return stream([
      { type: 'start', frames: 90000, parts: 1, missing: [] },
      { type: 'progress', frame: 45000, frames: 90000, percent: 50 },
      { type: 'finishing' },
      { type: 'done', id: 'f'.repeat(32), bytes: 123456789, duration: 3600 },
    ]);
  });
  mock.save.mockResolvedValue({ canceled: false, path: 'C:/Videos/Book.mp4' });
});

afterEach(() => {
  cleanup();
  appQueries.clear();
  vi.clearAllMocks();
});

function openDialog(given: Draft = draft) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ExportVideoButton draft={given} mode="audiobook" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Export video' }));
  return screen.findByRole('dialog', { name: 'Export video' });
}

it('shows the first frame and an estimate, and keeps each choice with the book', async () => {
  const dialog = await openDialog();
  await waitFor(() => expect(within(dialog).getByText(/A 1 h 00 min book/)).toBeInTheDocument());
  const preview = within(dialog).getByTestId('video-preview');
  expect(preview.querySelector('img')?.getAttribute('src')).toBe('/api/longform/images/dawn.jpg');
  expect(preview.textContent).toContain('Ngày');
  fireEvent.click(within(dialog).getByRole('radio', { name: '9:16 · Shorts' }));
  expect(mock.edit).toHaveBeenLastCalledWith(
    'audiobook',
    expect.objectContaining({ videoExport: expect.objectContaining({ aspect: '9:16' }) }),
  );
});

it('makes the video, saves it where asked, then lets the backend drop its copy', async () => {
  const dialog = await openDialog();
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Make video' }));
  await waitFor(() =>
    expect(mock.save).toHaveBeenCalledWith(`/api/audiobook/export/video/${'f'.repeat(32)}`, 'Book.mp4'),
  );
  const posted = JSON.parse(String(mock.fetch.mock.calls[0][1].body));
  expect(posted).toMatchObject({ output: 'audiobook_ab.m4b', title: 'Book', aspect: '16:9' });
  await waitFor(() =>
    expect(mock.fetch).toHaveBeenCalledWith(`/audiobook/export/video/${'f'.repeat(32)}`, {
      method: 'DELETE',
    }),
  );
  expect(mock.toast.success).toHaveBeenCalledWith('Video saved');
});

it('keeps a video whose save was cancelled, to save again or discard', async () => {
  mock.save.mockResolvedValueOnce({ canceled: true });
  const dialog = await openDialog();
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Make video' }));
  expect(await within(dialog).findByText(/The video is ready/)).toBeInTheDocument();
  expect(mock.fetch).not.toHaveBeenCalledWith(expect.anything(), { method: 'DELETE' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save video' }));
  await waitFor(() => expect(mock.save).toHaveBeenCalledTimes(2));
});

it('says why a video cannot be made', async () => {
  mock.fetch.mockRejectedValueOnce(
    new ApiError(409, '{}', { detail: { code: 'video_busy', message: 'x' } } as never),
  );
  const dialog = await openDialog();
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Make video' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Another video is being made. Wait for it to finish.',
  );
  mock.fetch.mockImplementationOnce(async () =>
    stream([{ type: 'error', error_code: 'video_encode_failed', error: 'ffmpeg could not…' }]),
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make video' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('alert')).toHaveTextContent('ffmpeg could not make the video.'),
  );
  // The backend's own (English) sentence never shows, whatever the code.
  for (const code of ['video_failed', 'video_from_a_newer_backend']) {
    mock.fetch.mockImplementationOnce(async () =>
      stream([{ type: 'error', error_code: code, error: 'Backend words.' }]),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make video' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('The video could not be made.'),
    );
    expect(within(dialog).getByRole('alert')).not.toHaveTextContent('Backend words.');
  }
});

it('warns when the pictures changed since the book was made', async () => {
  const dialog = await openDialog({ ...draft, script: '[image: other.jpg]\nNgày đầu tiên.' });
  expect(
    await within(dialog).findByText(/The script's pictures changed since the book was made/),
  ).toBeInTheDocument();
});
