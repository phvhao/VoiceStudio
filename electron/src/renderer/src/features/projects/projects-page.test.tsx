import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  remove: vi.fn(),
  detach: vi.fn(),
  open: vi.fn(),
  create: vi.fn(),
  navigate: vi.fn(),
  active: false,
  books: [] as object[],
}));
vi.mock('@/components/workspace-sidebar', () => ({
  SecondarySidebar: ({ children }: any) => <aside>{children}</aside>,
}));
vi.mock('@/components/app-shell/workspace-header', () => ({
  WorkspaceHeader: ({ children }: any) => <header>{children}</header>,
}));
vi.mock('@/components/audio-preview-button', () => ({ AudioPreviewButton: () => null }));
vi.mock('@/components/pipeline-failure', () => ({
  PipelineFailure: ({ fallback }: any) => <p role="alert">{fallback}</p>,
}));
vi.mock('@/components/profile-avatar', () => ({ ProfileAvatar: () => null }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({ data: [] }),
  useDeleteProfile: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/hooks/use-history', () => ({ useHistory: () => ({ data: [] }) }));
vi.mock('@/lib/api/client', () => ({
  apiJson: mocks.api,
  apiPath: (p: string) => p,
  describeError: (e: Error) => e.message,
}));
vi.mock('../dub/dub-session', () => ({
  useDubSession: () => ({ phase: mocks.active ? 'generating' : 'idle' }),
  detachDubProject: mocks.detach,
  attachDubProject: vi.fn(),
  openDubProject: vi.fn(),
}));
vi.mock('../longform/longform-session', () => ({
  useLongformSession: () => ({ active: mocks.active }),
  listLongformProjects: async () => mocks.books,
  openLongformProject: mocks.open,
  createLongformProject: mocks.create,
  deleteLongformProject: mocks.remove,
  renameLongformProject: vi.fn(),
}));
const book = (fields: object) => ({
  autoName: false,
  createdAt: 1,
  updatedAt: 1,
  words: 0,
  chapters: 0,
  output: '',
  outputs: [],
  ...fields,
});
import { ProjectsPage } from './projects-page';

let exports: { id: string; filename: string; destination_path: string }[];
let dubs: { id: string; name: string }[];
let renders: object[];
let clients: QueryClient[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.active = false;
  mocks.books = [book({ id: 'book', mode: 'stories', name: 'Saved story' })];
  mocks.open.mockImplementation(async () => 'audiobook');
  mocks.create.mockImplementation(async () => 'audiobook');
  renders = [];
  exports = [{ id: 'same', filename: 'Exported audio', destination_path: '/kept/audio.wav' }];
  dubs = [{ id: 'same', name: 'Dub project' }];
  mocks.api.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (options?.method === 'DELETE') {
      if (path === '/export/history/same') exports = [];
      if (path === '/projects/same') dubs = [];
      return {};
    }
    if (path === '/projects') return dubs;
    if (path === '/export/history') return exports;
    if (path === '/longform/jobs') return { jobs: renders };
    if (path.startsWith('/audiobook/timeline/'))
      return { chapters: [{ title: 'One', phrases: [{ text: 'Recovered text.', voice: '' }] }] };
    return {};
  });
});
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients = [];
});
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ProjectsPage />
    </QueryClientProvider>,
  );
  await screen.findByRole('checkbox', { name: 'Select Exported audio' });
}
function deletions() {
  return mocks.api.mock.calls.filter(([, options]) => options?.method === 'DELETE');
}

it('confirms single export deletion, supports cancellation, and refreshes the list', async () => {
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Exported audio' }));
  let dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/Exported files.*kept/)).toBeTruthy();
  expect(deletions()).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(deletions()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Exported audio' }));
  dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: 'Select Exported audio' })).toBeNull(),
  );
  expect(deletions().map(([path]) => path)).toEqual(['/export/history/same']);
  expect(screen.getByRole('checkbox', { name: 'Select Dub project' })).toBeTruthy();
});

it('bulk deletion retains failures for retry and does not repeat successful deletes', async () => {
  await mount();
  const original = mocks.api.getMockImplementation()!;
  let fail = true;
  mocks.api.mockImplementation(async (...args) => {
    if (args[0] === '/export/history/same' && args[1]?.method === 'DELETE' && fail)
      throw new Error('Disk unavailable');
    return original(...args);
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Dub project' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Exported audio' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Disk unavailable');
  expect(within(screen.getByRole('dialog')).queryByText('Dub project')).toBeNull();
  fail = false;
  await waitFor(() =>
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }),
    ).not.toBeDisabled(),
  );
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(deletions().filter(([path]) => path === '/projects/same')).toHaveLength(1);
  expect(mocks.detach).toHaveBeenCalledWith('same');
});

it('clears hidden selections when searching and selects only visible rows', async () => {
  await mount();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Dub project' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Exported' } });
  expect(screen.queryByRole('button', { name: /Delete selected/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Select visible' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(deletions().map(([path]) => path)).toEqual(['/export/history/same']);
});

it('deletes library books through the session and blocks deletion during generation', async () => {
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Saved story' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('book'));
  cleanup();
  mocks.active = true;
  await mount();
  expect(screen.getByRole('button', { name: 'Delete Dub project' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Select visible' })).toBeDisabled();
});

it('renaming a dub never issues a deletion', async () => {
  await mount();
  fireEvent.click(screen.getByRole('button', { name: /Rename Dub project/i }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith('/projects/same', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
    }),
  );
  expect(deletions()).toHaveLength(0);
});

it('the Enter that commits an IME composition does not submit a rename', async () => {
  await mount();
  fireEvent.click(screen.getByRole('button', { name: /Rename Dub project/i }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Renamed' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(mocks.api.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0);
  expect(screen.getByRole('textbox')).toBe(input);
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith('/projects/same', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
    }),
  );
});

it('prevents duplicate submissions and cancellation while deletion is pending', async () => {
  await mount();
  const original = mocks.api.getMockImplementation()!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.api.mockImplementation(async (...args) => {
    if (args[1]?.method === 'DELETE') await gate;
    return original(...args);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Delete Dub project' }));
  const dialog = screen.getByRole('dialog');
  const remove = within(dialog).getByRole('button', { name: 'Delete' });
  fireEvent.click(remove);
  fireEvent.click(remove);
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(deletions()).toHaveLength(1);
  finish();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('groups renders under their book and opens the book with the render asked for', async () => {
  mocks.books = [
    book({ id: 'b1', mode: 'audiobook', name: 'My book', words: 1200, chapters: 7 }),
    // Linked by the file it showed: the draft the library adopted.
    book({ id: 'b2', mode: 'audiobook', name: 'Adopted', outputs: ['adopted.m4b'] }),
  ];
  renders = [
    {
      job_id: 'r1',
      type: 'audiobook',
      title: 'test',
      output: 'new.m4b',
      project_id: 'b1',
      created_at: 30,
    },
    {
      job_id: 'r2',
      type: 'audiobook',
      title: 'test',
      output: 'old.m4b',
      project_id: 'b1',
      created_at: 20,
      summary: { chapter_titles: ['One'] },
    },
    { job_id: 'r3', type: 'audiobook', title: 'test', output: 'adopted.m4b', created_at: 10 },
  ];
  await mount();
  expect(screen.getByText('1200 words · 7 chapters')).toBeTruthy();
  // One entry per book, not one per render.
  expect(screen.queryByRole('checkbox', { name: 'Select test' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'My book' }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/audiobook' }));
  expect(mocks.open).toHaveBeenCalledWith('b1');

  const toggle = screen.getByRole('button', { name: 'Show renders of My book' });
  expect(toggle.textContent).toContain('2 renders');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  const older = screen.getAllByRole('button', { name: /^Open My book \u2014 .* in the editor$/ });
  expect(older).toHaveLength(2);
  fireEvent.click(older[1]);
  await waitFor(() =>
    expect(mocks.open).toHaveBeenLastCalledWith('b1', {
      output: 'old.m4b',
      chapters: [{ title: 'One', status: 'done' }],
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show renders of Adopted' }));
  fireEvent.click(screen.getByRole('button', { name: /^Open Adopted \u2014 .* in the editor$/ }));
  await waitFor(() =>
    expect(mocks.open).toHaveBeenLastCalledWith('b2', { output: 'adopted.m4b', chapters: [] }),
  );
});

it('rebuilds the book of an older render, or says why it cannot', async () => {
  mocks.books = [];
  renders = [
    {
      job_id: 'n1',
      type: 'audiobook',
      title: 'test',
      output: 'kept.m4b',
      timeline: true,
      created_at: 30,
    },
    { job_id: 'n2', type: 'audiobook', title: 'test', output: 'bare.m4b', created_at: 20 },
    { job_id: 'n3', type: 'story', title: 'Old story', output: 'story.mp3', created_at: 10 },
  ];
  await mount();
  // Renders of one title group under one entry; the latest is the one played and opened.
  expect(screen.getByRole('button', { name: 'Show renders of test' }).textContent).toContain(
    '2 renders',
  );
  fireEvent.click(screen.getByRole('button', { name: 'test' }));
  await waitFor(() =>
    expect(mocks.create).toHaveBeenCalledWith(
      'audiobook',
      expect.objectContaining({ script: '# One\n\nRecovered text.', output: 'kept.m4b' }),
      'test',
    ),
  );
  expect(mocks.api).toHaveBeenCalledWith('/audiobook/timeline/kept.m4b');
  expect(mocks.navigate).toHaveBeenCalledWith({ to: '/audiobook' });
  // Kept no text: no open action, and the reason instead.
  expect(screen.queryByRole('button', { name: 'Old story' })).toBeNull();
  expect(screen.getByText(/kept no text to rebuild the book/)).toBeTruthy();
});

it('shows why a book cannot be opened while its editor renders', async () => {
  mocks.open.mockRejectedValue(
    new Error('This is rendering. Stop it or wait for it to finish before you switch.'),
  );
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Saved story' }));
  expect((await screen.findByRole('alert')).textContent).toContain('This is rendering');
  expect(mocks.navigate).not.toHaveBeenCalled();
});
