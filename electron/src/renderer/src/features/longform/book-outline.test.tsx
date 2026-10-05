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
  expect(tree.getByText(t('book.node_meta', { words: 4, runtime: '0:02' }))).toBeVisible();
  // A chapter with nothing to read is not in the render's plan.
  expect(tree.getByText(t('book.status_empty'))).toBeVisible();
  expect(await tree.findByText(t('book.status_rendered'))).toBeVisible();
  expect(tree.getByText(t('book.status_changed'))).toHaveAttribute('title', t('book.hint_changed'));
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

it('names the opening text before any chapter heading', async () => {
  render(<Harness initial={'Prologue words.\n# One\nx'} />);
  expect(
    within(contents()).getByRole('button', { name: t('audiobook.chapter_n', { n: 1 }) }),
  ).toBeVisible();
  // The opening has no heading to rename or remove.
  fireEvent.click(
    screen.getByRole('button', {
      name: t('book.more', { title: t('audiobook.chapter_n', { n: 1 }) }),
    }),
  );
  expect(await screen.findByRole('menuitem', { name: t('book.add_chapter') })).toBeVisible();
  expect(screen.queryByRole('menuitem', { name: t('book.rename') })).toBeNull();
});
