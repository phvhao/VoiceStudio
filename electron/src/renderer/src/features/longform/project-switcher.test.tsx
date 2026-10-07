import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

const m = vi.hoisted(() => ({
  state: {
    active: null as string | null,
    drafts: { audiobook: { projectId: 'b1', title: '' }, stories: { projectId: null, title: '' } },
    saving: { audiobook: 'saved', stories: 'idle' },
    saveError: { audiobook: null as string | null, stories: null },
  },
  blocker: null as string | null,
  list: vi.fn(),
  open: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  duplicate: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
}));
vi.mock('./longform-session', () => ({
  useLongformState: (select: (state: typeof m.state) => unknown) => select(m.state),
  useLongformActive: () => m.state.active,
  useDraftField: (mode: 'audiobook' | 'stories', field: 'projectId' | 'title') =>
    m.state.drafts[mode][field],
  listLongformProjects: m.list,
  openLongformProject: m.open,
  newLongformProject: m.create,
  renameLongformProject: m.rename,
  duplicateLongformProject: m.duplicate,
  deleteLongformProject: m.remove,
  saveLongformProject: m.save,
  switchBlocker: () => m.blocker,
}));
import { ProjectSwitcher } from './project-settings';

const project = (fields: object) => ({
  autoName: false,
  createdAt: 1,
  updatedAt: 1,
  words: 10,
  chapters: 2,
  output: '',
  outputs: [],
  ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.blocker = null;
  m.state.saving.audiobook = 'saved';
  m.state.saveError.audiobook = null;
  m.list.mockResolvedValue([
    project({ id: 'b2', mode: 'audiobook', name: 'Second book', updatedAt: 20, output: 'x.m4b' }),
    project({ id: 'b1', mode: 'audiobook', name: 'First book', updatedAt: 10 }),
    project({ id: 's1', mode: 'stories', name: 'A story', updatedAt: 30 }),
  ]);
  for (const fn of [m.open, m.create, m.rename, m.duplicate, m.remove, m.save])
    fn.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectSwitcher mode="audiobook" />
    </QueryClientProvider>,
  );
  const trigger = await screen.findByRole('button', { name: /^First book — / });
  return trigger;
}

it('names the open book with its save state and lists only this mode, newest first', async () => {
  const trigger = await mount();
  expect(screen.getByRole('status').textContent).toBe('Saved');
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  const books = within(dialog)
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('data-library-open'));
  expect(books.map((b) => b.textContent)).toEqual([
    expect.stringContaining('Second book'),
    expect.stringContaining('First book'),
  ]);
  expect(books[0].textContent).toContain('Audio ready');
  expect(books[1].textContent).toContain('Open now');
  expect(books[1].textContent).toContain('10 words · 2 chapters');
  expect(within(dialog).queryByText('A story')).toBeNull();
});

it('opens a book from the list or by search and Enter, and starts a new one', async () => {
  fireEvent.click(await mount());
  const dialog = await screen.findByRole('dialog');
  const search = within(dialog).getByRole('searchbox', { name: 'Search by name…' });
  fireEvent.change(search, { target: { value: 'second' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  await waitFor(() => expect(m.open).toHaveBeenCalledWith('b2'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: /^First book — / }));
  fireEvent.click(await screen.findByRole('button', { name: 'New book' }));
  await waitFor(() => expect(m.create).toHaveBeenCalledWith('audiobook'));
});

it('renames, duplicates and deletes only after confirming, saying the audio is kept', async () => {
  fireEvent.click(await mount());
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename Second book' }));
  const name = within(dialog).getByRole('textbox', { name: 'Project name' });
  fireEvent.change(name, { target: { value: 'Better name' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
  await waitFor(() => expect(m.rename).toHaveBeenCalledWith('b2', 'Better name'));

  fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate Second book' }));
  await waitFor(() => expect(m.duplicate).toHaveBeenCalledWith('b2', 'Second book (copy)'));

  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Second book' }));
  expect(m.remove).not.toHaveBeenCalled();
  const confirm = within(dialog).getByRole('alertdialog', { name: 'Delete “Second book”?' });
  expect(confirm.textContent).toContain('Audio you already rendered is kept');
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(m.remove).toHaveBeenCalledWith('b2'));
});

it('while this editor renders, switching is disabled and says why', async () => {
  m.blocker = 'This is rendering. Stop it or wait for it to finish before you switch.';
  fireEvent.click(await mount());
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(m.blocker)).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'New book' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: /^Second book/ })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Delete First book' })).toBeDisabled();
  // Renaming or copying the open book is still fine.
  expect(within(dialog).getByRole('button', { name: 'Rename First book' })).not.toBeDisabled();
});

it('arrow keys move between books', async () => {
  fireEvent.click(await mount());
  const dialog = await screen.findByRole('dialog');
  const search = within(dialog).getByRole('searchbox');
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toContain('Second book');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toContain('First book');
});

it('a failed save offers a retry', async () => {
  m.state.saving.audiobook = 'error';
  m.state.saveError.audiobook = 'Disk full';
  await mount();
  const retry = screen.getByRole('button', { name: 'Save failed — retry' });
  expect(retry.getAttribute('title')).toContain('Disk full');
  fireEvent.click(retry);
  expect(m.save).toHaveBeenCalledWith('audiobook');
});
