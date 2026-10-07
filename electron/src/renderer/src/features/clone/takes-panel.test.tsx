import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GenerateResult, HistoryItem } from '@/lib/api/types';
import type { OutputState } from '@/lib/store/output';

const mock = vi.hoisted(() => ({
  history: [] as HistoryItem[],
  latest: { result: null, objectUrl: null, text: '' } as OutputState,
  clear: vi.fn(),
  star: vi.fn(),
  remove: vi.fn(),
  reuse: vi.fn(),
  open: vi.fn(),
  audition: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/hooks/use-history', () => ({
  useHistory: () => ({ data: mock.history, isSuccess: true }),
  useToggleStarred: () => ({ mutate: mock.star }),
  useDeleteHistoryItem: () => ({ mutate: mock.remove }),
}));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({
    data: [
      { id: 'p1', name: 'Lan' },
      { id: 'p2', name: 'Minh' },
    ],
  }),
}));
vi.mock('@/hooks/use-generate', () => ({ useGenerateClone: () => ({ isGenerating: false }) }));
vi.mock('@/lib/store/output', () => ({
  useLatestOutput: () => mock.latest,
  clearLatestOutput: mock.clear,
}));
vi.mock('@/lib/store/takes', () => ({ openTake: mock.open }));
vi.mock('./reuse-take', () => ({ reuseHistoryTake: mock.reuse }));
vi.mock('./audition', () => ({
  toggleAudition: mock.audition,
  stopAudition: vi.fn(),
  useAudition: () => 'idle',
}));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: ({ src, source }: { src: string; source: string }) => (
    <div data-testid="waveform" data-src={src} data-source={source} />
  ),
}));
vi.mock('@/components/save-audio-button', () => ({
  SaveAudioButton: () => <button type="button">clone.download</button>,
}));
vi.mock('./audio-quality', () => ({
  AudioQuality: ({ source }: { source: string }) => (
    <button type="button" data-source={source}>
      audioQuality.check
    </button>
  ),
}));
vi.mock('./audio-file-details', () => ({ AudioFileDetails: () => <p>file details</p> }));

import { listTakes, TakesPanel } from './takes-panel';

const take = (id: string, mode: string, profile_id = 'p1', created_at = 100): HistoryItem => ({
  id,
  text: `Line ${id}`,
  mode,
  language: 'Auto',
  instruct: null,
  profile_id,
  audio_path: `${id}.wav`,
  duration_seconds: 4.2,
  generation_time: 1.5,
  seed: null,
  starred: false,
  created_at,
});
const output = (id: string | null): OutputState => ({
  result: {
    blob: new Blob(['x']),
    id,
    audioPath: id ? `${id}.wav` : null,
    durationSeconds: 2,
    genTimeSeconds: 1,
    seed: null,
    routing: null,
    dropped: null,
  } satisfies GenerateResult,
  objectUrl: 'blob:new',
  text: 'Fresh line',
});

beforeEach(() => {
  mock.history = [
    take('c2', 'clone', 'p2', 300),
    take('d1', 'design', 'p1', 200),
    take('c1', 'clone'),
  ];
  mock.latest = { result: null, objectUrl: null, text: '' };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const rows = () =>
  screen
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-expanded') && button.title);
const row = (title: string) => rows().find((button) => button.title === title) as HTMLElement;

it('lists this workspace’s takes newest first, the session’s new one on top', () => {
  expect(listTakes('clone', mock.history, output('n1')).map((t) => t.id)).toEqual([
    'n1',
    'c2',
    'c1',
  ]);
  expect(listTakes('design', mock.history, output('n1')).map((t) => t.id)).toEqual(['n1', 'd1']);
  // Once history lists the new take it is one row, played from the bytes already here.
  const listed = [take('n1', 'clone', 'p1', 400), ...mock.history];
  const merged = listTakes('clone', listed, output('n1'));
  expect(merged.map((t) => t.id)).toEqual(['n1', 'c2', 'c1']);
  expect(merged[0]).toMatchObject({ latest: true, src: 'blob:new', item: listed[0] });
  // History says Voice Design made it: not a Clone take.
  expect(listTakes('clone', [take('n1', 'design'), ...mock.history], output('n1'))[0].id).toBe(
    'c2',
  );
});

it('opens only the chosen take with its waveform; the new take opens chosen', () => {
  mock.latest = output('n1');
  render(<TakesPanel mode="clone" />);
  expect(rows().map((row) => row.title)).toEqual(['Fresh line', 'Line c2', 'Line c1']);
  const latest = screen.getByRole('region', { name: 'clone.output_title' });
  expect(within(latest).getByTestId('waveform')).toHaveAttribute('data-src', 'blob:new');
  expect(within(latest).getByTestId('waveform')).toHaveAttribute('data-source', 'output');
  expect(screen.getAllByTestId('waveform')).toHaveLength(1);
  // The audio check stays folded behind its button, seeking this take's player.
  expect(within(latest).getByRole('button', { name: 'audioQuality.check' })).toHaveAttribute(
    'data-source',
    'output',
  );

  fireEvent.click(row('Line c1'));
  const chosen = screen.getByRole('region', { name: 'editor.selected_take' });
  expect(within(chosen).getByTestId('waveform')).toHaveAttribute('data-source', 'take-c1');
  expect(screen.getAllByTestId('waveform')).toHaveLength(1);
  fireEvent.click(within(chosen).getByRole('button', { name: 'clone.history_reuse' }));
  expect(mock.reuse).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  fireEvent.click(within(chosen).getByRole('button', { name: 'clone.details' }));
  expect(mock.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));

  fireEvent.click(row('Line c1'));
  expect(screen.queryByTestId('waveform')).toBeNull();
});

it('names the voice on each row only when the takes come from several voices', () => {
  render(<TakesPanel mode="clone" />);
  expect(screen.getByText('Minh')).toBeInTheDocument();
  cleanup();
  mock.history = [take('c1', 'clone'), take('c3', 'clone')];
  render(<TakesPanel mode="clone" />);
  expect(screen.queryByText('Lan')).toBeNull();
});

it("drops a row's voice and date by the list's own width, never the window's", () => {
  // Beside an open pane the dock is 20rem wide in a 960 px window: viewport
  // breakpoints never fired there, the title shrank to an ellipsis and the
  // details slid under Star and Delete.
  render(<TakesPanel mode="clone" />);
  const button = row('Line c2');
  expect(button.closest('ul')).toHaveClass('@container');
  const [title, ...details] = Array.from(button.children);
  // The voice ("Minh"), the length and the date.
  expect(details.map((detail) => detail.textContent)).toContain('Minh');
  for (const detail of [details[0], details[2]]) {
    expect(detail.className).toMatch(/@max-(sm|lg):hidden/);
    expect(detail.className).not.toMatch(/(^|\s)max-(sm|md):hidden/);
  }
  // The title keeps a width of its own, and nothing paints past the row's button.
  expect(title).toHaveClass('min-w-16');
  expect(button).toHaveClass('overflow-hidden');
});

it('closes the new take without deleting it, and deleting it clears it too', () => {
  mock.latest = output('n1');
  mock.history = [take('n1', 'clone', 'p1', 400), ...mock.history];
  const view = render(<TakesPanel mode="clone" />);
  const latest = screen.getByRole('region', { name: 'clone.output_title' });
  fireEvent.click(within(latest).getByRole('button', { name: 'common.close' }));
  expect(mock.clear).toHaveBeenCalledOnce();
  expect(mock.remove).not.toHaveBeenCalled();
  view.unmount();
  render(<TakesPanel mode="clone" />);
  fireEvent.click(screen.getAllByRole('button', { name: 'clone.history_delete' })[0]);
  expect(mock.remove).toHaveBeenCalledWith('n1');
  expect(mock.clear).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getAllByRole('button', { name: 'clone.history_star' })[1]);
  expect(mock.star).toHaveBeenCalledWith({ id: 'c2', starred: true });
});

it('auditions a closed row without opening it', () => {
  render(<TakesPanel mode="clone" />);
  fireEvent.click(screen.getByRole('button', { name: 'player.play: Line c2' }));
  expect(mock.audition).toHaveBeenCalledWith('take:c2', expect.stringContaining('c2.wav'));
  expect(screen.queryByTestId('waveform')).toBeNull();
});

it('stays one line saying so before the first take', () => {
  mock.history = [take('d1', 'design')];
  render(<TakesPanel mode="clone" />);
  expect(screen.getByRole('button', { name: /clone.history_title/ })).toBeDisabled();
  expect(screen.getByText('clone.history_empty')).toBeInTheDocument();
});
