import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Profile } from '@/lib/api/types';

const mock = vi.hoisted(() => ({
  profiles: [] as Profile[],
  select: vi.fn(),
  workspace: vi.fn(),
  update: vi.fn(),
  error: vi.fn(),
  audition: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({ data: mock.profiles, isPending: false }),
}));
vi.mock('@/lib/store/clone-settings', () => ({ useCloneSetting: () => 'b' }));
vi.mock('@/lib/store/reference', () => ({ selectCloneProfile: mock.select }));
vi.mock('@/lib/store/workspace', () => ({ setWorkspace: mock.workspace }));
vi.mock('@/lib/api/profiles', () => ({ updateProfileImage: mock.update }));
vi.mock('sonner', () => ({ toast: { error: mock.error } }));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));
vi.mock('./reference-input', () => ({
  ReferenceSourcePicker: ({ start }: { start?: string }) => (
    <div data-testid="source-picker">{start ?? 'none'}</div>
  ),
}));
vi.mock('./audition', () => ({
  toggleAudition: mock.audition,
  stopAudition: vi.fn(),
  useAudition: () => 'idle',
}));

import { VoiceSetup } from './voice-setup';

const voice = (
  id: string,
  name: string,
  created_at: number,
  language: string | null = null,
  audio_duration_seconds: number | null = null,
) =>
  ({
    id,
    name,
    created_at,
    language,
    audio_duration_seconds,
    kind: 'clone',
    ref_audio_path: `${id}.wav`,
  }) as Profile;

beforeEach(() => {
  localStorage.clear();
  mock.profiles = [
    voice('a', 'Zoe', 100),
    voice('b', 'Adam', 300, 'English', 12.4),
    voice('c', 'Mia', 200),
    { ...voice('d', 'Design only', 400), kind: 'design' } as Profile,
  ];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const chooseButtons = () =>
  screen.getAllByRole('button').filter((button) => button.hasAttribute('data-choose'));
const names = () => chooseButtons().map((button) => button.getAttribute('aria-label'));
const setup = () => render(<VoiceSetup onChosen={() => {}} onBack={() => {}} />);

it('lists cloned voices newest first, sorts by name on request and remembers it', () => {
  const view = setup();
  expect(names()).toEqual(['Adam', 'Mia', 'Zoe']);
  fireEvent.click(screen.getByRole('radio', { name: 'cloneFlow.sort_name' }));
  expect(names()).toEqual(['Adam', 'Mia', 'Zoe']);
  mock.profiles = [voice('x', 'Beta', 1), voice('y', 'Alpha', 2)];
  view.unmount();
  setup();
  expect(screen.getByRole('radio', { name: 'cloneFlow.sort_name' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(names()).toEqual(['Alpha', 'Beta']);
});

it('marks the current voice, chooses a card and opens editing without choosing', () => {
  const chosen = vi.fn();
  render(<VoiceSetup onChosen={chosen} onBack={() => {}} />);
  const adam = screen.getByRole('button', { name: 'Adam' });
  expect(adam).toHaveAttribute('aria-current', 'true');
  const card = adam.closest('[data-slot="voice-card"]') as HTMLElement;
  // Reference length and a short date; one language in the library, so none named.
  const date = new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(300_000);
  expect(card).toHaveTextContent(`clone.duration_seconds · ${date}`);
  expect(within(card).queryByText(/English/)).toBeNull();
  fireEvent.click(within(card).getByRole('button', { name: 'clone.edit_voice: Adam' }));
  expect(mock.workspace).toHaveBeenCalledWith({ editingProfileId: 'b', panel: null });
  expect(chosen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Mia' }));
  expect(mock.select).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  expect(chosen).toHaveBeenCalledOnce();
});

it('names each voice language only when the library mixes languages', () => {
  mock.profiles = [voice('a', 'Zoe', 100, 'Vietnamese'), voice('b', 'Adam', 300, 'English')];
  setup();
  const card = (name: string) =>
    screen.getByRole('button', { name }).closest('[data-slot="voice-card"]') as HTMLElement;
  expect(card('Adam')).toHaveTextContent('English');
  expect(card('Zoe')).toHaveTextContent('Vietnamese');
});

it('auditions a reference through the shared player, without choosing the voice', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'clone.preview_voice: Adam' }));
  expect(mock.audition).toHaveBeenCalledWith(
    'voice:b',
    expect.stringContaining('/profiles/b/audio'),
  );
  expect(mock.select).not.toHaveBeenCalled();
});

it('uploads a photo from the card and rejects unsupported or oversized images', () => {
  mock.update.mockResolvedValue(voice('b', 'Adam', 300));
  setup();
  const input = screen.getByLabelText('cloneFlow.change_photo: Adam') as HTMLInputElement;
  const gif = new File(['x'], 'a.gif', { type: 'image/gif' });
  fireEvent.change(input, { target: { files: [gif] } });
  expect(mock.error).toHaveBeenCalledWith('profileIdentity.image_limit');
  const huge = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'a.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [huge] } });
  expect(mock.update).not.toHaveBeenCalled();
  const png = new File(['x'], 'a.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [png] } });
  expect(mock.update).toHaveBeenCalledWith('b', png);
});

it('searches by name once the list is long enough, and "/" jumps to the search box', () => {
  mock.profiles = ['One', 'Two', 'Three', 'Four', 'Five'].map((name, index) =>
    voice(name, name, index),
  );
  setup();
  const search = screen.getByRole('textbox', { name: 'common.search' });
  expect(search).toHaveAttribute('aria-keyshortcuts', '/');
  fireEvent.keyDown(window, { key: '/' });
  expect(search).toHaveFocus();
  fireEvent.change(search, { target: { value: 'tw' } });
  expect(names()).toEqual(['Two']);
  // Typed into a text field, "/" is just a character.
  const field = document.createElement('textarea');
  document.body.append(field);
  field.focus();
  fireEvent.keyDown(field, { key: '/' });
  expect(field).toHaveFocus();
  field.remove();
});

it('filters by a name prefix that several voices share', () => {
  mock.profiles = [
    voice('k1', 'ktnb-Anh', 6),
    voice('k2', 'ktnb-Bình', 5),
    voice('k3', 'KTNB - Chi', 4),
    voice('c1', 'chanel-1', 3),
    voice('c2', 'chanel_2', 2),
    voice('s', 'Solo', 1),
  ];
  setup();
  const chips = within(screen.getByRole('radiogroup', { name: 'cloneFlow.prefix_label' }));
  expect(chips.getAllByRole('radio').map((chip) => chip.textContent)).toEqual([
    'clone.history_all6',
    'ktnb3',
    'chanel2',
  ]);
  fireEvent.click(chips.getByRole('radio', { name: 'chanel2' }));
  expect(names()).toEqual(['chanel-1', 'chanel_2']);
  fireEvent.click(chips.getByRole('radio', { name: 'clone.history_all6' }));
  expect(names()).toHaveLength(6);
});

it('moves through the prefix chips and the sort with the arrow keys, one Tab stop each', () => {
  mock.profiles = [
    voice('k1', 'ktnb-Anh', 6),
    voice('k2', 'ktnb-Bình', 5),
    voice('c1', 'chanel-1', 3),
    voice('c2', 'chanel_2', 2),
    voice('s', 'Solo', 1),
  ];
  setup();
  const group = screen.getByRole('radiogroup', { name: 'cloneFlow.prefix_label' });
  const chips = () => within(group).getAllByRole('radio');
  expect(chips().filter((chip) => chip.tabIndex === 0)).toEqual([chips()[0]]);
  act(() => chips()[0].focus());
  fireEvent.keyDown(chips()[0], { key: 'ArrowRight' });
  expect(chips()[1]).toHaveFocus();
  expect(chips()[1]).toHaveAttribute('aria-checked', 'true');
  expect(chips().map((chip) => chip.textContent)).toEqual([
    'clone.history_all5',
    'chanel2',
    'ktnb2',
  ]);
  expect(names()).toEqual(['chanel-1', 'chanel_2']);
  expect(chips().filter((chip) => chip.tabIndex === 0)).toEqual([chips()[1]]);
  // Round from the first to the last, and Home back.
  fireEvent.keyDown(chips()[1], { key: 'ArrowUp' });
  fireEvent.keyDown(chips()[0], { key: 'ArrowLeft' });
  expect(chips()[2]).toHaveFocus();
  expect(names()).toEqual(['ktnb-Anh', 'ktnb-Bình']);
  fireEvent.keyDown(chips()[2], { key: 'Home' });
  expect(chips()[0]).toHaveFocus();
  expect(names()).toHaveLength(5);

  const sort = within(screen.getByRole('radiogroup', { name: 'cloneFlow.sort_label' }));
  const recent = sort.getByRole('radio', { name: 'cloneFlow.sort_recent' });
  expect(sort.getAllByRole('radio').map((radio) => radio.tabIndex)).toEqual([0, -1]);
  act(() => recent.focus());
  fireEvent.keyDown(recent, { key: 'ArrowDown' });
  const byName = sort.getByRole('radio', { name: 'cloneFlow.sort_name' });
  expect(byName).toHaveFocus();
  expect(byName).toHaveAttribute('aria-checked', 'true');
  expect(names().at(-1)).toBe('Solo');
});

it('shows no prefix chips when no prefix narrows the list', () => {
  setup();
  expect(screen.queryByRole('radiogroup', { name: 'cloneFlow.prefix_label' })).toBeNull();
});

it('moves between cards with the arrow keys and keeps one Tab stop in the grid', () => {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  // 1000 px: four 15rem cards per row.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1000,
  });
  try {
    mock.profiles = Array.from({ length: 10 }, (_, index) =>
      voice(`v${index}`, `Voice ${index}`, 100 - index),
    );
    setup();
    const cards = chooseButtons();
    expect(cards.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    act(() => cards[0].focus());
    fireEvent.keyDown(cards[0], { key: 'ArrowDown' });
    expect(chooseButtons()[4]).toHaveFocus();
    fireEvent.keyDown(chooseButtons()[4], { key: 'ArrowRight' });
    expect(chooseButtons()[5]).toHaveFocus();
    // From the row above the short last row, down lands on its last card.
    fireEvent.keyDown(chooseButtons()[5], { key: 'ArrowDown' });
    expect(chooseButtons()[9]).toHaveFocus();
    fireEvent.keyDown(chooseButtons()[9], { key: 'Home' });
    expect(chooseButtons()[0]).toHaveFocus();
    expect(chooseButtons().filter((button) => button.tabIndex === 0)).toEqual([chooseButtons()[0]]);
  } finally {
    if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
  }
});

it('keeps Add a new voice to one row until Upload audio or Record opens it', () => {
  setup();
  expect(screen.queryByTestId('source-picker')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'clone.upload_audio' }));
  expect(screen.getByTestId('source-picker')).toHaveTextContent('upload');
  fireEvent.click(screen.getByRole('button', { name: 'common.close: cloneFlow.add_voice' }));
  expect(screen.queryByTestId('source-picker')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'clone.record' }));
  expect(screen.getByTestId('source-picker')).toHaveTextContent('record');
});

it('opens the drop zone when audio is dragged over the window, not for a photo', () => {
  setup();
  const drag = (type: string) => {
    const event = new Event('dragenter');
    Object.defineProperty(event, 'dataTransfer', {
      value: { items: [{ kind: 'file', type }], types: ['Files'] },
    });
    act(() => void window.dispatchEvent(event));
  };
  drag('image/png');
  expect(screen.queryByTestId('source-picker')).toBeNull();
  drag('audio/wav');
  expect(screen.getByTestId('source-picker')).toHaveTextContent('none');
});

it('shows the drop zone and recorder at once in an empty library', () => {
  mock.profiles = [];
  setup();
  expect(screen.getByTestId('source-picker')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'common.close: cloneFlow.add_voice' })).toBeNull();
});
