import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A Stories line audition renders under the page's preview lock: the editor
// stays open meanwhile, other auditions wait, and a finished audition whose
// own line (or the settings) changed stays, marked outdated — typing in
// another line leaves it as it is.

const audition = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: ({ src }: { src: string }) => <audio data-testid="line-audio" src={src} />,
}));
vi.mock('./story-preview', async (actual) => ({
  ...(await actual<typeof import('./story-preview')>()),
  previewStoryLine: audition.preview,
}));
vi.mock('./story-stems', () => ({ StoryStems: () => null }));
vi.mock('@/components/pipeline-failure', () => ({ PipelineFailure: () => null }));
import { StoryEditor } from './story-editor';
import { blankLongformDraft, type Draft } from './longform-session';
import { usePreviewLock, type PreviewLock } from './preview-run';

beforeEach(() => {
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => 'blob:line');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

let lock: PreviewLock;
function Page() {
  lock = usePreviewLock();
  const [draft, setDraft] = useState<Draft>({
    ...blankLongformDraft(),
    voice: 'narrator',
    lines: [
      { id: 'a', text: 'Hello there.', profileId: null },
      { id: 'b', text: 'And again.', profileId: null },
    ],
  });
  return (
    <StoryEditor
      draft={draft}
      profiles={[{ id: 'narrator', name: 'Narrator' }]}
      disabled={false}
      previews={lock}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
    />
  );
}

const lines = () => screen.getAllByRole('textbox', { name: 'stories.linePlaceholder' });
const card = (index: number) =>
  within(lines()[index].closest<HTMLElement>('[class*="group/line"]')!);

it('keeps the editor open while a line renders, and the other lines wait', async () => {
  let finish!: (blob: Blob) => void;
  audition.preview.mockReturnValue(new Promise<Blob>((resolve) => (finish = resolve)));
  render(<Page />);
  fireEvent.click(card(0).getByRole('button', { name: 'stories.preview' }));
  expect(lock.holder).toBe('line');
  expect(lines()[0]).toBeEnabled();
  expect(lines()[1]).toBeEnabled();
  expect(card(1).getByRole('button', { name: 'stories.preview' })).toBeDisabled();
  await act(async () => finish(new Blob(['audio'])));
  expect(card(0).getByTestId('line-audio')).toBeInTheDocument();
  expect(lock.busy).toBe(false);
  expect(card(1).getByRole('button', { name: 'stories.preview' })).toBeEnabled();
});

it('marks an audition outdated once its own line changes, not another line', async () => {
  audition.preview.mockResolvedValue(new Blob(['audio']));
  render(<Page />);
  await act(async () => {
    fireEvent.click(card(0).getByRole('button', { name: 'stories.preview' }));
  });
  expect(card(0).getByTestId('line-audio')).toBeInTheDocument();
  fireEvent.change(lines()[1], { target: { value: 'And again, and again.' } });
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  fireEvent.change(lines()[0], { target: { value: 'Hello there, friend.' } });
  expect(card(0).getByText('audiobook.preview_outdated')).toBeVisible();
  // Still there to compare with.
  expect(card(0).getByTestId('line-audio')).toBeInTheDocument();
});

it('stops an audition whose line is deleted, so its Stop never goes missing', async () => {
  let signal!: AbortSignal;
  audition.preview.mockImplementation(
    (_draft: Draft, _line: unknown, aborted: AbortSignal) =>
      new Promise<Blob>((_resolve, reject) => {
        signal = aborted;
        aborted.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  );
  render(<Page />);
  fireEvent.click(card(0).getByRole('button', { name: 'stories.preview' }));
  expect(lock.busy).toBe(true);
  await act(async () => {
    fireEvent.click(card(0).getByRole('button', { name: 'stories.removeLine' }));
  });
  expect(signal.aborted).toBe(true);
  // Every other line can be heard again, and Generate stops waiting.
  expect(lock.busy).toBe(false);
  expect(lines()).toHaveLength(1);
  expect(card(0).getByRole('button', { name: 'stories.preview' })).toBeEnabled();
});

it('marks an audition outdated once the engine, preset or reading it rendered under changes', async () => {
  audition.preview.mockResolvedValue(new Blob(['audio']));
  function Settings({ settings }: { settings: string | null }) {
    const own = usePreviewLock();
    return (
      <StoryEditor
        draft={{
          ...blankLongformDraft(),
          voice: 'narrator',
          lines: [{ id: 'a', text: 'Hello there.', profileId: null }],
        }}
        profiles={[{ id: 'narrator', name: 'Narrator' }]}
        disabled={false}
        previews={own}
        previewSettings={settings}
        onChange={() => {}}
      />
    );
  }
  const view = render(<Settings settings='["fast"]' />);
  await act(async () => {
    fireEvent.click(card(0).getByRole('button', { name: 'stories.preview' }));
  });
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  // A sampling answer that has not come back says nothing either way.
  view.rerender(<Settings settings={null} />);
  expect(screen.queryByText('audiobook.preview_outdated')).toBeNull();
  view.rerender(<Settings settings='["quality"]' />);
  expect(card(0).getByText('audiobook.preview_outdated')).toBeVisible();
});
