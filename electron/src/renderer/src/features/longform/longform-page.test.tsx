import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

// What renders, counted by what only it works out on every render: the setup
// column whether it shows the Cast panel, the page what Generate waits for.
const renders = vi.hoisted(() => ({ setup: 0, page: 0 }));
vi.mock('./cast-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cast-settings')>();
  return {
    ...actual,
    showsCastPanel: (...args: Parameters<typeof actual.showsCastPanel>) => {
      renders.setup += 1;
      return actual.showsCastPanel(...args);
    },
  };
});
vi.mock('./generate-blocker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./generate-blocker')>();
  return {
    ...actual,
    generateBlockers: (...args: Parameters<typeof actual.generateBlockers>) => {
      renders.page += 1;
      return actual.generateBlockers(...args);
    },
  };
});
// No backend: nothing it is asked answers.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiJson: () => new Promise(() => {}),
  apiFetch: () => new Promise(() => {}),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock('@/components/app-shell/workspace-header', () => ({
  WorkspaceHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
import { queryClient } from '@/lib/query';
import { AudiobookPage } from './longform-page';
import { blankLongformDraft, editLongform, longformSession } from './longform-session';

const t = i18n.t.bind(i18n);
const SCRIPT = '# One\n[voice:Mara] First words.\n## Part two\nMore words.\n# Two\nLast.';

beforeEach(() => {
  longformSession.setState((state) => ({
    ...state,
    active: null,
    drafts: {
      stories: blankLongformDraft(),
      audiobook: { ...blankLongformDraft(), script: SCRIPT, title: 'Book', voice: 'narrator' },
    },
  }));
  render(
    <QueryClientProvider client={queryClient}>
      <AudiobookPage />
    </QueryClientProvider>,
  );
  renders.setup = 0;
  renders.page = 0;
});
afterEach(cleanup);

const editor = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: t('clone.script') });

it('renders the page for a keystroke, never its setup column', () => {
  fireEvent.change(editor(), { target: { value: SCRIPT + ' And more.' } });
  expect(editor().value).toBe(SCRIPT + ' And more.');
  expect(renders.page).toBeGreaterThan(0);
  expect(renders.setup).toBe(0);
  // The column renders for what it shows.
  fireEvent.change(screen.getByRole('textbox', { name: t('audiobook.meta_title') }), {
    target: { value: 'Another title' },
  });
  expect(renders.setup).toBeGreaterThan(0);
  expect(longformSession.state.drafts.audiobook).toMatchObject({
    script: SCRIPT + ' And more.',
    title: 'Another title',
  });
});

it('renders nothing for a change to the session that leaves the book as it is', () => {
  act(() => longformSession.setState((state) => ({ ...state })));
  act(() => editLongform('stories', { title: 'A story' }));
  expect(renders.page).toBe(0);
  expect(renders.setup).toBe(0);
});

it("shows a replaced script's own warnings at once, never the last book's", () => {
  vi.useFakeTimers();
  try {
    const empty = t('audiobook.warn_empty_chapter', { title: 'Epilogue' });
    act(() => editLongform('audiobook', { script: '# Epilogue\n' }));
    expect(screen.getByText(empty, { exact: false })).toBeTruthy();
    // Another book (or Clear, or an import) replaces the script in place.
    act(() => editLongform('audiobook', { script: '# Prologue\nIt begins here, and goes on.' }));
    expect(screen.queryByText(empty, { exact: false })).toBeNull();
    // Dismissed, the warnings stay away while the script is typed into.
    act(() => editLongform('audiobook', { script: '# Epilogue\n' }));
    fireEvent.click(screen.getByRole('button', { name: t('audiobook.dismiss') }));
    fireEvent.change(editor(), { target: { value: '# Epilogue\n\n' } });
    expect(screen.queryByText(empty, { exact: false })).toBeNull();
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByText(empty, { exact: false })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
