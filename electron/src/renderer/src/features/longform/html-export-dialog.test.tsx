import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

const mock = vi.hoisted(() => ({
  api: vi.fn(),
  fetch: vi.fn(),
  save: vi.fn(),
  edit: vi.fn(),
}));
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.api,
  apiFetch: mock.fetch,
  apiPath: (path: string) => '/api' + path,
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('@/lib/export-history', () => ({ saveExport: mock.save }));
vi.mock('@/components/bridge', () => ({ getBridge: () => ({}) }));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({ data: [{ id: 'p-mai', name: 'Mai' }] }),
}));
vi.mock('./longform-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./longform-session')>()),
  editLongform: mock.edit,
}));
import { ExportHtmlButton, embeddedFontBytes } from './html-export-dialog';
import { blankLongformDraft, type Draft } from './longform-session';
import type { HtmlTemplate } from './html-design';

const t = i18n.t.bind(i18n);

function template(id: string, accent: string, body: string, heading: string, extra = {}) {
  return {
    id,
    stories: id === 'script',
    italic: id === 'magazine' ? ['heading'] : [],
    defaults: {
      accent,
      body_font: body,
      heading_font: heading,
      show_names: id === 'script',
      numbering: id === 'magazine' ? 'numeral' : 'words',
    },
    swatch: { bg: '#ffffff', fg: '#111111', accent, line: '#dddddd' },
    ...extra,
  } as HtmlTemplate;
}

const TEMPLATES = [
  template('classic', '#8a2f1b', 'literata', 'eb-garamond'),
  template('modern', '#2459e0', 'inter', 'be-vietnam-pro'),
  template('magazine', '#c8102e', 'source-serif-4', 'playfair-display'),
  template('cinematic', '#ffb547', 'lora', 'montserrat'),
  template('kids', '#f0542d', 'nunito', 'baloo-2'),
  template('script', '#0f766e', 'be-vietnam-pro', 'jetbrains-mono'),
];
const FONTS = [
  {
    id: 'literata',
    family: 'Literata',
    category: 'serif',
    bytes: 238000,
    files: [
      { file: 'Literata.woff2', style: 'normal', weight: [200, 900], bytes: 118000 },
      { file: 'Literata-Italic.woff2', style: 'italic', weight: [200, 900], bytes: 120000 },
    ],
  },
  {
    id: 'eb-garamond',
    family: 'EB Garamond',
    category: 'serif',
    bytes: 300000,
    files: [{ file: 'EBGaramond.woff2', style: 'normal', weight: [400, 800], bytes: 150000 }],
  },
  {
    id: 'inter',
    family: 'Inter',
    category: 'sans',
    bytes: 130000,
    files: [{ file: 'Inter.woff2', style: 'normal', weight: [100, 900], bytes: 130000 }],
  },
];

beforeEach(() => {
  mock.api.mockImplementation(async (path: string) => {
    if (path === '/audiobook/export/html/templates')
      return { templates: TEMPLATES, accents: ['#b3261e', '#1d4ed8'] };
    if (path === '/fonts') return { families: FONTS };
    if (path === '/audiobook/export/html/preview') return { html: '<p>preview</p>' };
    if (path === '/audiobook/export/html') return { id: '0'.repeat(32), bytes: 1 };
    throw new Error('unexpected ' + path);
  });
  mock.save.mockResolvedValue({ canceled: false, path: '/x.zip' });
  mock.fetch.mockResolvedValue(new Response(null));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const book: Draft = {
  ...blankLongformDraft(),
  title: 'Book',
  output: 'audiobook_abc.m4b',
  outputScript: '# One\nHello.',
  outputChapters: [{ title: 'One', status: 'done', duration_ms: 1000 }],
};

function open(draft: Draft = book, mode: 'audiobook' | 'stories' = 'audiobook') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ExportHtmlButton draft={draft} mode={mode} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: t('book.export_html') }));
  return screen.findByRole('dialog', { name: t('bookExport.title') });
}

/** The bodies posted to `path`, parsed. */
function posted(path: string) {
  return mock.api.mock.calls
    .filter(([called]) => called === path)
    .map(([, init]) => JSON.parse(init.body));
}

it('previews the book in its design and keeps each choice with the book', async () => {
  const dialog = await open();
  const gallery = await within(dialog).findByRole('radiogroup', { name: t('bookExport.design') });
  const cards = within(gallery).getAllByRole('radio');
  expect(cards.map((card) => card.textContent)).toEqual([
    t('bookExport.template_classic'),
    t('bookExport.template_modern'),
    t('bookExport.template_magazine'),
    t('bookExport.template_cinematic'),
    t('bookExport.template_kids'),
    t('bookExport.template_script'),
  ]);
  // An audiobook starts in Classic, and the preview shows it.
  expect(within(gallery).getByRole('radio', { checked: true })).toHaveTextContent(
    t('bookExport.template_classic'),
  );
  await waitFor(() => expect(posted('/audiobook/export/html/preview')).toHaveLength(1));
  expect(posted('/audiobook/export/html/preview')[0]).toMatchObject({
    output: 'audiobook_abc.m4b',
    design: { template: 'classic', accent: '#8a2f1b', body_font: 'literata' },
    voice_names: { 'p-mai': 'Mai' },
  });
  const frame = await within(dialog).findByTitle(t('bookExport.preview_title'));
  expect(frame).toHaveAttribute('srcdoc', '<p>preview</p>');
  // No script runs in it, and it is a picture: out of the tab order.
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame.closest('[inert]')).not.toBeNull();

  // The arrow keys choose a template; a template brings its own colour and fonts.
  fireEvent.keyDown(cards[0], { key: 'ArrowRight' });
  expect(mock.edit).toHaveBeenLastCalledWith('audiobook', {
    htmlExport: {
      template: 'modern',
      accent: '#2459e0',
      bodyFont: 'inter',
      headingFont: 'be-vietnam-pro',
      showNames: false,
      numbering: 'words',
    },
  });
  expect(document.activeElement).toBe(cards[1]);
  await waitFor(() =>
    expect(posted('/audiobook/export/html/preview').at(-1).design.template).toBe('modern'),
  );

  // Quick options: a colour, the body font, names, numbering.
  fireEvent.click(within(dialog).getByRole('radio', { name: t('bookExport.accent_blue') }));
  expect(mock.edit.mock.lastCall![1].htmlExport.accent).toBe('#1d4ed8');
  fireEvent.click(within(dialog).getByRole('switch', { name: t('bookExport.show_voices') }));
  expect(mock.edit.mock.lastCall![1].htmlExport).toMatchObject({
    template: 'modern',
    accent: '#1d4ed8',
    showNames: true,
  });
  // The fonts it carries are counted; system fonts carry none.
  expect(dialog).toHaveTextContent(/kB/);
});

it('exports the chosen design and closes; a cancelled save keeps it open', async () => {
  const dialog = await open({
    ...book,
    htmlExport: {
      template: 'kids',
      accent: '#123456',
      bodyFont: 'system',
      headingFont: 'system',
      showNames: false,
      numbering: 'none',
    },
  });
  // The book's own design, its custom colour shown as such.
  const gallery = await within(dialog).findByRole('radiogroup', { name: t('bookExport.design') });
  expect(within(gallery).getByRole('radio', { checked: true })).toHaveTextContent(
    t('bookExport.template_kids'),
  );
  expect(within(dialog).getByLabelText(t('bookExport.accent_custom'))).toHaveValue('#123456');
  expect(dialog).toHaveTextContent(t('bookExport.fonts_none'));
  mock.save.mockResolvedValueOnce({ canceled: true });
  fireEvent.click(within(dialog).getByRole('button', { name: t('bookExport.export') }));
  await waitFor(() => expect(mock.fetch).toHaveBeenCalled()); // the copy is discarded
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: t('bookExport.export') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(posted('/audiobook/export/html').at(-1).design).toEqual({
    template: 'kids',
    accent: '#123456',
    body_font: 'system',
    heading_font: 'system',
    show_names: false,
    numbering: 'none',
  });
});

it('shows why an export failed and stays open', async () => {
  const dialog = await open();
  await within(dialog).findByRole('radiogroup', { name: t('bookExport.design') });
  mock.save.mockRejectedValueOnce(new Error('Disk full'));
  fireEvent.click(within(dialog).getByRole('button', { name: t('bookExport.export') }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Disk full');
});

it('exports a story as turns: Script first, its lines and characters along', async () => {
  const story: Draft = {
    ...book,
    output: 'story_abc.m4b',
    outputScript: '',
    cast: [{ id: 'mai', name: 'Mai', profileId: 'p-mai' }],
    lines: [{ id: '1', text: 'Hi.', profileId: null, character: 'mai' }],
  };
  const dialog = await open(story, 'stories');
  const gallery = await within(dialog).findByRole('radiogroup', { name: t('bookExport.design') });
  expect(within(gallery).getByRole('radio', { checked: true })).toHaveTextContent(
    t('bookExport.template_script'),
  );
  expect(
    within(dialog).getByRole('switch', { name: t('bookExport.show_characters') }),
  ).toBeChecked();
  fireEvent.click(within(dialog).getByRole('button', { name: t('bookExport.export') }));
  await waitFor(() => expect(posted('/audiobook/export/html')).toHaveLength(1));
  const body = posted('/audiobook/export/html')[0];
  expect(body.design).toMatchObject({ template: 'script', show_names: true });
  expect(body.story[0].spans[0]).toMatchObject({ speaker: { name: 'Mai', accent: 0 } });
  // A story's voices are profiles, never shown: no names are sent for them.
  expect(body).not.toHaveProperty('voice_names');
});

it('counts each embedded font once, italics only where the template sets them', () => {
  const design = {
    template: 'magazine',
    accent: '#000000',
    bodyFont: 'literata',
    headingFont: 'literata',
    showNames: false,
    numbering: 'words' as const,
  };
  const magazine = TEMPLATES[2];
  const fonts = FONTS as never;
  expect(embeddedFontBytes(design, magazine, fonts)).toBe(Math.ceil(238000 / 3) * 4);
  expect(embeddedFontBytes(design, TEMPLATES[0], fonts)).toBe(Math.ceil(118000 / 3) * 4);
  expect(
    embeddedFontBytes({ ...design, bodyFont: 'system', headingFont: 'nope' }, magazine, fonts),
  ).toBe(0);
});
