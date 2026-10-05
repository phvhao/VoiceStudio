import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

const mock = vi.hoisted(() => ({ api: vi.fn(), save: vi.fn(), bridge: null as unknown }));
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.api,
  apiPath: (path: string) => '/api' + path,
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('@/lib/export-history', () => ({ saveExport: mock.save }));
vi.mock('@/components/bridge', () => ({ getBridge: () => mock.bridge }));
import { ExportHtmlButton, htmlExportBody, htmlExportName } from './html-export';
import { blankLongformDraft, type Draft } from './longform-session';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mock.bridge = null;
});

const t = i18n.t.bind(i18n);
const book: Draft = {
  ...blankLongformDraft(),
  title: 'Night <Train>',
  output: 'audiobook_abc.m4b',
  outputScript: '# One\nHello.\n# Two\nBye.',
  outputChapters: [
    { title: 'One', status: 'done', duration_s: 1.23, duration_ms: 1234 },
    { title: 'Two', status: 'failed' },
  ],
  metadata: { author: 'Ann' },
  cover: { path: '/outputs/audiobook_covers/0123456789ab.png', name: 'c.png' },
};

it('sends the book, how it was rendered and the page words in the app language', () => {
  const body = htmlExportBody(book, t, 'vi');
  expect(body).toMatchObject({
    output: 'audiobook_abc.m4b',
    title: 'Night <Train>',
    metadata: { author: 'Ann' },
    cover_path: '/outputs/audiobook_covers/0123456789ab.png',
    text: book.outputScript,
    // Exact lengths; a failed chapter is not in the file.
    chapter_durations: [1.234, null],
    lang: 'vi',
    direction: 'ltr',
    // The book's own language: the draft reads "Auto", so it is not known.
    book_lang: '',
  });
  expect(body.labels).toMatchObject({
    play: t('book.html_play'),
    contents: t('book.contents'),
    keys: t('book.html_keys'),
    chapter_n: t('audiobook.chapter_n', { n: '{n}' }),
  });
  expect(body.labels.chapter_n).toContain('{n}');
  // An Arabic UI exporting an English book.
  expect(htmlExportBody({ ...book, language: 'English' }, t, 'ar', 'rtl')).toMatchObject({
    lang: 'ar',
    direction: 'rtl',
    book_lang: 'en',
  });
  expect(Object.values(body.labels).every((label) => label && !label.startsWith('book.'))).toBe(
    true,
  );
  // Without a length for every chapter, the server measures the file instead.
  const untimed = { ...book, outputChapters: [{ title: 'One', status: 'done' }] };
  expect(htmlExportBody(untimed, t, 'en').chapter_durations).toBeNull();
  expect(htmlExportName(book)).toBe('Night <Train>.zip');
  expect(htmlExportName({ ...book, title: ' ' })).toBe('audiobook_abc.zip');
});

it('exports and saves the page through the native save dialog', async () => {
  mock.bridge = {};
  mock.api.mockResolvedValue({ id: '0123456789abcdef0123456789abcdef', bytes: 10 });
  render(<ExportHtmlButton draft={book} onError={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: t('book.export_html') }));
  await waitFor(() =>
    expect(mock.save).toHaveBeenCalledWith(
      '/api/audiobook/export/html/0123456789abcdef0123456789abcdef',
      'Night <Train>.zip',
    ),
  );
  const [path, init] = mock.api.mock.calls[0];
  expect(path).toBe('/audiobook/export/html');
  expect(JSON.parse(init.body).output).toBe('audiobook_abc.m4b');
});

it('reports a failed export', async () => {
  const onError = vi.fn();
  mock.api.mockRejectedValue(new Error('No such audiobook'));
  render(<ExportHtmlButton draft={book} onError={onError} />);
  fireEvent.click(screen.getByRole('button', { name: t('book.export_html') }));
  await waitFor(() => expect(onError).toHaveBeenLastCalledWith('No such audiobook'));
  expect(mock.save).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: t('book.export_html') })).toBeEnabled();
});
