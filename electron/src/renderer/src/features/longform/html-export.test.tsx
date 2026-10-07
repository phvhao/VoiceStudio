import { afterEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

const mock = vi.hoisted(() => ({
  api: vi.fn(),
  fetch: vi.fn(),
  save: vi.fn(),
  bridge: null as unknown,
}));
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.api,
  apiFetch: mock.fetch,
  apiPath: (path: string) => '/api' + path,
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('@/lib/export-history', () => ({ saveExport: mock.save }));
vi.mock('@/components/bridge', () => ({ getBridge: () => mock.bridge }));
import { exportBookHtml, htmlExportBody, htmlExportName } from './html-export';
import { blankLongformDraft, type Draft } from './longform-session';

afterEach(() => {
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
  // No design picked: the backend's default; an audiobook is no story.
  expect(body).not.toHaveProperty('design');
  expect(body).not.toHaveProperty('story');
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

it('sends the design, a story’s lines with their characters, and readable voice names', () => {
  const design = {
    template: 'magazine',
    accent: '#1d4ed8',
    bodyFont: 'literata',
    headingFont: 'system',
    showNames: true,
    numbering: 'roman' as const,
  };
  expect(htmlExportBody(book, t, 'en', 'ltr', { design, voiceNames: { p1: 'Mai' } })).toMatchObject(
    {
      design: {
        template: 'magazine',
        accent: '#1d4ed8',
        body_font: 'literata',
        heading_font: 'system',
        show_names: true,
        numbering: 'roman',
      },
      voice_names: { p1: 'Mai' },
    },
  );
  const story: Draft = {
    ...book,
    output: 'story_abc.m4b',
    outputScript: '',
    outputChapters: [{ title: '', status: 'done', duration_ms: 2000 }],
    cast: [{ id: 'mai', name: 'Mai', profileId: 'p1' }],
    lines: [
      { id: '1', text: 'It was night.', profileId: null },
      { id: '2', text: 'Hello.', profileId: null, character: 'mai' },
    ],
  };
  const body = htmlExportBody(story, t, 'en', 'ltr', { mode: 'stories' });
  // Its lengths travel without a script: the server estimates from the lines.
  expect(body).toMatchObject({ text: null, chapter_durations: [2] });
  expect(body.story).toEqual([
    {
      title: '',
      spans: [
        { voice_id: null, text: 'It was night.', pause_ms_after: 0, speed: null },
        {
          voice_id: 'p1',
          text: 'Hello.',
          pause_ms_after: 0,
          speed: null,
          break_before: 'paragraph',
          speaker: { name: 'Mai', accent: 0 },
        },
      ],
    },
  ]);
  // Edited after its render, a story sends the lines that were read: its
  // page shows the audio's text, chapter for chapter.
  const rendered = body.story;
  const edited: Draft = {
    ...story,
    outputStory: rendered ?? null,
    lines: [
      { id: '3', text: '# Added', profileId: null },
      { id: '4', text: 'Not in the audio.', profileId: null },
    ],
  };
  expect(htmlExportBody(edited, t, 'en', 'ltr', { mode: 'stories' }).story).toEqual(rendered);
});

it('keeps the lines a story was rendered from with its finished file', async () => {
  const { restoreDraft } = await import('./longform-session');
  const plan = [{ title: 'One', spans: [{ voice_id: null, text: 'Read.', pause_ms_after: 0 }] }];
  expect(restoreDraft({ ...blankLongformDraft(), outputStory: plan })?.outputStory).toEqual(plan);
  // A draft from before this was kept, or a damaged one, keeps none.
  expect(restoreDraft({ ...blankLongformDraft(), outputStory: undefined })?.outputStory).toBeNull();
  expect(
    restoreDraft({ ...blankLongformDraft(), outputStory: [{ spans: 'x' }] })?.outputStory,
  ).toBeNull();
});

const EXPORT_ID = '0123456789abcdef0123456789abcdef';

/** Export in the desktop app, whose native save ends with `saved`. */
function exportThroughNativeSave(saved: () => Promise<unknown>) {
  mock.bridge = {};
  mock.api.mockResolvedValue({ id: EXPORT_ID, bytes: 10 });
  mock.fetch.mockResolvedValue(new Response(null));
  mock.save.mockImplementation(saved);
  return exportBookHtml(book, t, 'en');
}

it('exports and saves the page through the native save dialog', async () => {
  await expect(
    exportThroughNativeSave(async () => ({ canceled: false, path: '/books/Night.zip' })),
  ).resolves.toBe('saved');
  expect(mock.save).toHaveBeenCalledWith(
    `/api/audiobook/export/html/${EXPORT_ID}`,
    'Night <Train>.zip',
  );
  const [path, init] = mock.api.mock.calls[0];
  expect(path).toBe('/audiobook/export/html');
  expect(JSON.parse(init.body).output).toBe('audiobook_abc.m4b');
  // Downloaded: the backend already removed it once it was sent.
  expect(mock.fetch).not.toHaveBeenCalled();
});

it('discards the export, a full copy of the book, when the save is cancelled', async () => {
  await expect(exportThroughNativeSave(async () => ({ canceled: true }))).resolves.toBe('canceled');
  expect(mock.fetch).toHaveBeenCalledWith(`/audiobook/export/html/${EXPORT_ID}`, {
    method: 'DELETE',
  });
});

it('discards the export and reports the failure when the save fails', async () => {
  await expect(
    exportThroughNativeSave(async () => {
      throw new Error('Could not download the audio (HTTP 500)');
    }),
  ).rejects.toThrow('Could not download the audio (HTTP 500)');
  expect(mock.fetch).toHaveBeenCalledWith(`/audiobook/export/html/${EXPORT_ID}`, {
    method: 'DELETE',
  });
});

it('reports a failed export without saving anything', async () => {
  mock.api.mockRejectedValue(new Error('No such audiobook'));
  await expect(exportBookHtml(book, t, 'en')).rejects.toThrow('No such audiobook');
  expect(mock.save).not.toHaveBeenCalled();
});
