import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({
  apiJson: mock.api,
  apiPath: (path: string) => path,
  describeError: String,
}));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: ({ src }: { src: string }) => <audio data-testid="preview" src={src} />,
}));
import { BookOutline, outlineRequest } from './book-outline';
import { blankLongformDraft, type Draft } from './longform-session';

const SCRIPT = '# One\nFirst words.\n## Part two\nMore words.\n# Empty\n# Two\nLast.';
const t = i18n.t.bind(i18n);

beforeEach(() => {
  mock.api.mockImplementation(async (path: string) => {
    if (path === '/audiobook/outline')
      return {
        book: true,
        chapters: [
          { title: 'One', status: 'rendered', cached: true, in_book: true },
          { title: 'Two', status: 'changed', cached: false, in_book: false },
        ],
      };
    return { output: 'longform_cache/two.wav', title: 'Two' };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Harness({ initial = SCRIPT, output = '' }: { initial?: string; output?: string }) {
  const [script, setScript] = useState(initial);
  const input = useRef<HTMLTextAreaElement>(null);
  const draft: Draft = { ...blankLongformDraft(), script, voice: 'narrator', output };
  return (
    <QueryClientProvider client={new QueryClient()}>
      <textarea
        ref={input}
        aria-label="Script"
        value={script}
        onChange={(event) => setScript(event.target.value)}
      />
      <BookOutline
        draft={draft}
        disabled={false}
        canPreview
        onBusy={() => {}}
        getTarget={() => input.current && { element: input.current, setText: setScript }}
      />
    </QueryClientProvider>
  );
}

const script = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Script' });
const contents = () => screen.getByRole('navigation', { name: t('book.contents') });

async function choose(title: string, action: string) {
  fireEvent.click(screen.getByRole('button', { name: t('book.more', { title }) }));
  fireEvent.click(await screen.findByRole('menuitem', { name: t(action) }));
}

it('shows the chapters and sections with their length and render status', async () => {
  render(<Harness output="audiobook_b1.m4b" />);
  const tree = within(contents());
  expect(tree.getByRole('button', { name: 'One' })).toBeVisible();
  expect(tree.getByRole('button', { name: 'Part two' })).toBeVisible();
  expect(tree.getByRole('button', { name: 'Two' })).toBeVisible();
  expect(
    tree.getByText(t('book.node_meta', { count: 4, words: '4', runtime: '0:02' })),
  ).toBeVisible();
  // A one-word section reads in the singular.
  expect(t('book.node_meta', { count: 1, words: '1', runtime: '0:00' })).toBe('1 word · 0:00');
  // A chapter with nothing to read is not in the render's plan.
  expect(tree.getByText(t('book.status_empty'))).toBeVisible();
  expect(await tree.findByText(t('book.status_rendered'))).toBeVisible();
  expect(tree.getByText(t('book.status_changed'))).toHaveAttribute('title', t('book.hint_changed'));
  // The length and status sit under the title, which keeps the row's width.
  const meta = within(tree.getByRole('button', { name: 'One' }).parentElement!);
  expect(
    meta.getByText(t('book.status_rendered')).closest('[data-slot=outline-meta]'),
  ).not.toBeNull();
  const [path, init] = mock.api.mock.calls[0];
  expect(path).toBe('/audiobook/outline');
  expect(JSON.parse(init.body)).toEqual(
    outlineRequest({
      ...blankLongformDraft(),
      script: SCRIPT,
      voice: 'narrator',
      output: 'audiobook_b1.m4b',
    }),
  );
  expect(JSON.parse(init.body)).toMatchObject({ output: 'audiobook_b1.m4b', text: SCRIPT });
  expect(JSON.parse(init.body)).not.toHaveProperty('chapter_index');
});

it('moves the caret to a heading when its row is chosen', () => {
  render(<Harness />);
  fireEvent.click(within(contents()).getByRole('button', { name: 'Part two' }));
  expect(script()).toHaveFocus();
  expect(script().selectionStart).toBe(SCRIPT.indexOf('Part two'));
  expect(script().selectionEnd).toBe(SCRIPT.indexOf('Part two'));
});

it('renders a chapter on its own by its index in the plan', async () => {
  render(<Harness />);
  fireEvent.click(
    screen.getByRole('button', { name: t('audiobook.preview_chapter', { title: 'Two' }) }),
  );
  await waitFor(() =>
    expect(mock.api).toHaveBeenCalledWith('/audiobook/preview', expect.anything()),
  );
  const body = mock.api.mock.calls.find(([path]) => path === '/audiobook/preview')?.[1].body;
  // "Empty" renders nothing, so "Two" is the plan's second chapter.
  expect(JSON.parse(body)).toMatchObject({ chapter_index: 1, text: SCRIPT });
  expect(await screen.findByTestId('preview')).toBeInTheDocument();
});

it('renames a heading in the editor', async () => {
  render(<Harness />);
  await choose('Part two', 'book.rename');
  const field = screen.getByRole('textbox', {
    name: t('book.rename_title', { title: 'Part two' }),
  });
  expect(field).toHaveFocus();
  fireEvent.change(field, { target: { value: 'The middle' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(script().value).toBe(SCRIPT.replace('Part two', 'The middle')));
  expect(within(contents()).getByRole('button', { name: 'The middle' })).toBeVisible();
});

it('adds a chapter or a section after a node, and removes a heading', async () => {
  render(<Harness initial={'# One\nFirst.\n# Two\nLast.'} />);
  await choose('One', 'book.add_section');
  await waitFor(() =>
    expect(script().value).toBe(`# One\nFirst.\n\n## ${t('book.new_section')}\n\n# Two\nLast.`),
  );
  await choose('Two', 'book.add_chapter');
  await waitFor(() =>
    expect(script().value).toBe(
      `# One\nFirst.\n\n## ${t('book.new_section')}\n\n# Two\nLast.\n\n# ${t('audiobook.chapter_n', { n: 3 })}\n`,
    ),
  );
  await choose(t('book.new_section'), 'book.remove_heading');
  await waitFor(() =>
    expect(script().value).toBe(
      `# One\nFirst.\n\n\n# Two\nLast.\n\n# ${t('audiobook.chapter_n', { n: 3 })}\n`,
    ),
  );
});

it('calls the text before the first heading the intro, never a second "Chapter 1"', async () => {
  const initial = 'Prologue words.\n# Chương 1\nx';
  render(<Harness initial={initial} />);
  const tree = within(contents());
  expect(tree.getByRole('button', { name: t('book.intro_untitled') })).toBeVisible();
  expect(tree.getByRole('button', { name: 'Chương 1' })).toBeVisible();
  expect(tree.queryByRole('button', { name: t('audiobook.chapter_n', { n: 1 }) })).toBeNull();
  // The intro has no heading to rename or remove: its menu adds one above it.
  await choose(t('book.intro_untitled'), 'book.add_title');
  const heading = `# ${t('book.intro_heading')}\n\n`;
  await waitFor(() => expect(script().value).toBe(heading + initial));
  // The new title is selected, so typing names the chapter. (Focus after a
  // menu action settles once the menu has closed, as in the tests below.)
  await waitFor(() => expect(script()).toHaveFocus());
  expect(script().value.slice(script().selectionStart, script().selectionEnd)).toBe(
    t('book.intro_heading'),
  );
  expect(tree.queryByRole('button', { name: t('book.intro_untitled') })).toBeNull();
  expect(tree.getByRole('button', { name: t('book.intro_heading') })).toBeVisible();
});

it('calls a book with no heading its one chapter, not an untitled intro', async () => {
  const initial = 'Just prose.\n\nMore prose.';
  render(<Harness initial={initial} />);
  const tree = within(contents());
  const only = t('audiobook.chapter_n', { n: 1 });
  expect(tree.getByRole('button', { name: only })).toBeVisible();
  expect(tree.queryByRole('button', { name: t('book.intro_untitled') })).toBeNull();
  // Its title, added, matches what the row said.
  await choose(only, 'book.add_title');
  await waitFor(() => expect(script().value).toBe(`# ${only}\n\n${initial}`));
});

it('offers no rename or remove on the intro', async () => {
  render(<Harness initial={'Prologue words.\n# One\nx'} />);
  fireEvent.click(
    screen.getByRole('button', { name: t('book.more', { title: t('book.intro_untitled') }) }),
  );
  expect(await screen.findByRole('menuitem', { name: t('book.add_chapter') })).toBeVisible();
  expect(screen.queryByRole('menuitem', { name: t('book.rename') })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: t('book.remove_heading') })).toBeNull();
});

it('says why a chapter changed, and when its new audio is ready', async () => {
  mock.api.mockImplementation(async () => ({
    book: true,
    chapters: [
      { title: 'One', status: 'changed', cached: true, in_book: false },
      { title: 'Two', status: 'changed', cached: false, in_book: false },
    ],
  }));
  render(<Harness initial={'# One\nFirst.\n# Two\nLast.'} output="audiobook_b1.m4b" />);
  const row = (title: string) =>
    within(within(contents()).getByRole('button', { name: title }).parentElement!);
  expect(await row('One').findByText(t('book.status_changed'))).toHaveAttribute(
    'title',
    t('book.hint_changed_ready'),
  );
  expect(row('Two').getByText(t('book.status_changed'))).toHaveAttribute(
    'title',
    t('book.hint_changed'),
  );
  // The reason names the script and the settings, and what happens next.
  expect(t('book.hint_changed', { lng: 'en' })).toMatch(/script or settings.*render again/i);
});

it("labels the chapter preview with the outline's localized name", async () => {
  mock.api.mockImplementation(async (path: string) =>
    path === '/audiobook/outline'
      ? { book: false, chapters: [] }
      : { output: 'longform_cache/intro.wav', title: 'Chapter 1', untitled: true },
  );
  render(<Harness initial={'Prologue words.\n# One\nx'} />);
  fireEvent.click(
    screen.getByRole('button', {
      name: t('audiobook.preview_chapter', { title: t('book.intro_untitled') }),
    }),
  );
  expect(await screen.findByTestId('preview')).toBeInTheDocument();
  const preview = screen
    .getByTestId('preview')
    .closest<HTMLElement>('[data-slot=chapter-preview]')!;
  expect(within(preview).getByText(t('book.intro_untitled'))).toBeVisible();
  expect(screen.queryByText('Chapter 1')).toBeNull();
});

it('folds away through its own button and reports a row that moved the caret', () => {
  const onCollapse = vi.fn();
  const onReveal = vi.fn();
  function Rail() {
    const [script, setScript] = useState(SCRIPT);
    const input = useRef<HTMLTextAreaElement>(null);
    return (
      <QueryClientProvider client={new QueryClient()}>
        <textarea ref={input} aria-label="Script" value={script} onChange={() => {}} />
        <BookOutline
          draft={{ ...blankLongformDraft(), script, voice: 'narrator' }}
          disabled={false}
          canPreview
          onBusy={() => {}}
          getTarget={() => input.current && { element: input.current, setText: setScript }}
          onCollapse={onCollapse}
          onReveal={onReveal}
        />
      </QueryClientProvider>
    );
  }
  render(<Rail />);
  fireEvent.click(screen.getByRole('button', { name: t('book.hide_contents') }));
  expect(onCollapse).toHaveBeenCalledTimes(1);
  fireEvent.click(within(contents()).getByRole('button', { name: 'Two' }));
  expect(onReveal).toHaveBeenCalledTimes(1);
});

it('hides the statuses of an earlier script until its own arrive', async () => {
  render(<Harness />);
  expect(await within(contents()).findByText(t('book.status_rendered'))).toBeVisible();
  // The new chapter shifts the plan: the old answer no longer lines up with it.
  mock.api.mockImplementation(async (path: string, init: { body: string }) =>
    path === '/audiobook/outline' && JSON.parse(init.body).text.startsWith('# New')
      ? {
          book: true,
          chapters: [
            { title: 'New', status: 'not_rendered', cached: false },
            { title: 'One', status: 'rendered', cached: true },
            { title: 'Two', status: 'changed', cached: false },
          ],
        }
      : { book: true, chapters: [] },
  );
  fireEvent.change(script(), { target: { value: `# New\nText.\n${SCRIPT}` } });
  expect(within(contents()).queryByText(t('book.status_rendered'))).toBeNull();
  expect(within(contents()).queryByText(t('book.status_changed'))).toBeNull();
  const row = (title: string) =>
    within(within(contents()).getByRole('button', { name: title }).parentElement!);
  expect(
    await row('One').findByText(t('book.status_rendered'), {}, { timeout: 3000 }),
  ).toBeVisible();
  expect(row('New').getByText(t('book.status_not_rendered'))).toBeVisible();
  expect(row('Two').getByText(t('book.status_changed'))).toBeVisible();
});

it('keeps one status answer cached, however often the script settles', async () => {
  const client = new QueryClient();
  function Cached() {
    const [script, setScript] = useState(SCRIPT);
    const draft: Draft = { ...blankLongformDraft(), script, voice: 'narrator' };
    return (
      <QueryClientProvider client={client}>
        <textarea
          aria-label="Script"
          value={script}
          onChange={(event) => setScript(event.target.value)}
        />
        <BookOutline
          draft={draft}
          disabled={false}
          canPreview
          onBusy={() => {}}
          getTarget={() => null}
        />
      </QueryClientProvider>
    );
  }
  render(<Cached />);
  await within(contents()).findByText(t('book.status_rendered'));
  fireEvent.change(script(), { target: { value: `${SCRIPT} More.` } });
  await waitFor(() => expect(mock.api).toHaveBeenCalledTimes(2), { timeout: 3000 });
  await waitFor(() =>
    expect(client.getQueryCache().findAll({ queryKey: ['audiobook-outline'] })).toHaveLength(1),
  );
});

it('hands the focus back to the menu button when its menu closes with nothing done', async () => {
  render(<Harness />);
  const more = screen.getByRole('button', { name: t('book.more', { title: 'Part two' }) });
  more.focus();
  fireEvent.click(more);
  const menu = await screen.findByRole('menu');
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  await waitFor(() => expect(more).toHaveFocus());
});

it('gives the focus to the row when a rename is cancelled or changes nothing', async () => {
  render(<Harness />);
  const field = () =>
    screen.getByRole('textbox', { name: t('book.rename_title', { title: 'Part two' }) });
  const title = () => within(contents()).getByRole('button', { name: 'Part two' });
  await choose('Part two', 'book.rename');
  await waitFor(() => expect(field()).toHaveFocus());
  fireEvent.keyDown(field(), { key: 'Escape' });
  await waitFor(() => expect(title()).toHaveFocus());
  await choose('Part two', 'book.rename');
  await waitFor(() => expect(field()).toHaveFocus());
  fireEvent.change(field(), { target: { value: '   ' } });
  fireEvent.keyDown(field(), { key: 'Enter' });
  await waitFor(() => expect(title()).toHaveFocus());
  expect(script().value).toBe(SCRIPT);
});
