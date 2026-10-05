import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import '@/i18n';
import { VoicePicker } from './voice-picker';

// Decomposed (NFD), as names pasted from macOS can arrive.
const GIONG = 'Giọng Bắc'.normalize('NFD');
const profiles = [
  { id: 'p-mara', name: 'Mara', kind: 'clone' as const },
  { id: 'p-giong', name: GIONG, kind: 'clone' as const },
  { id: 'p-dao', name: 'Đào Lan', kind: 'design' as const },
];

function renderPicker(props: Partial<ComponentProps<typeof VoicePicker>> = {}) {
  const onChange = vi.fn();
  const view = render(
    <VoicePicker
      value={null}
      onChange={onChange}
      profiles={profiles}
      aria-label="Default voice"
      {...props}
    />,
  );
  return { ...view, onChange, trigger: screen.getByRole('combobox', { name: 'Default voice' }) };
}

async function open(trigger: HTMLElement) {
  fireEvent.click(trigger);
  const search = await screen.findByRole('combobox', { name: 'Search voices' });
  await waitFor(() => expect(search).toHaveFocus());
  return search;
}

// The combobox filters on typed input, which carries an inputType.
const type = (search: HTMLElement, value: string) =>
  fireEvent.input(search, { target: { value }, inputType: 'insertText' });

// Accessible names, in list order (the avatars' initials are aria-hidden).
function expectOptions(...names: string[]) {
  const options = screen.queryAllByRole('option');
  expect(options).toHaveLength(names.length);
  options.forEach((option, index) => expect(option).toHaveAccessibleName(names[index]));
}

it('shows the chosen voice on the trigger', () => {
  const { trigger } = renderPicker({ value: 'p-dao' });
  expect(trigger).toHaveTextContent('Đào Lan');
});

it('filters by name ignoring case and accents', async () => {
  const { trigger } = renderPicker();
  const search = await open(trigger);
  expectOptions('Mara', GIONG, 'Đào Lan');
  type(search, 'giong');
  expectOptions(GIONG);
  type(search, 'DAO');
  expectOptions('Đào Lan');
  type(search, 'nobody');
  expectOptions();
  expect(screen.getByText('No matching voices')).toBeInTheDocument();
});

it('opens from the keyboard, moves with the arrows and picks with Enter', async () => {
  const { trigger, onChange } = renderPicker();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const search = await screen.findByRole('combobox', { name: 'Search voices' });
  await waitFor(() => expect(search).toHaveFocus());
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(search).toHaveAttribute(
    'aria-activedescendant',
    screen.getByRole('option', { name: GIONG }).id,
  );
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledExactlyOnceWith('p-giong');
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it('picks the first match with Enter after typing', async () => {
  const { trigger, onChange } = renderPicker();
  const search = await open(trigger);
  type(search, 'lan');
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledExactlyOnceWith('p-dao');
});

it('closes on Escape without a change and hands focus back to the trigger', async () => {
  const { trigger, onChange } = renderPicker({ value: 'p-mara' });
  const search = await open(trigger);
  fireEvent.keyDown(search, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
  expect(onChange).not.toHaveBeenCalled();
});

it('selects with a click and ignores picking the current voice again', async () => {
  const { trigger, onChange } = renderPicker({ value: 'p-mara' });
  await open(trigger);
  expect(screen.getByRole('option', { name: 'Mara' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('option', { name: 'Mara' }));
  expect(onChange).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  await open(trigger);
  fireEvent.click(screen.getByRole('option', { name: 'Đào Lan' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('p-dao');
});

it('offers the default voice first and emits null for it', async () => {
  const defaultOption = { label: 'uses Default voice', detail: 'Mara' };
  const { trigger, onChange, rerender } = renderPicker({ value: 'p-dao', defaultOption });
  await open(trigger);
  const [inherit] = screen.getAllByRole('option');
  expect(inherit).toHaveTextContent('uses Default voice');
  expect(inherit).toHaveTextContent('Mara');
  fireEvent.click(inherit);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(null);

  rerender(
    <VoicePicker
      value={null}
      onChange={onChange}
      profiles={profiles}
      defaultOption={defaultOption}
      aria-label="Default voice"
    />,
  );
  expect(trigger).toHaveTextContent('uses Default voice');
  await open(trigger);
  expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
});

it('keeps the chosen voice highlighted after it changes while closed', async () => {
  const { trigger, rerender, onChange } = renderPicker({ value: 'p-mara' });
  rerender(
    <VoicePicker
      value="p-dao"
      onChange={onChange}
      profiles={profiles}
      aria-label="Default voice"
    />,
  );
  await open(trigger);
  expectOptions('Mara', GIONG, 'Đào Lan');
  expect(screen.getByRole('option', { name: 'Đào Lan' })).toHaveAttribute('data-highlighted');
});

it('flags a voice that no longer exists', () => {
  const { trigger } = renderPicker({ value: 'p-gone' });
  expect(trigger).toHaveTextContent('Voice not found (re-pick)');
});

it('shows the placeholder and the attention ring when nothing is chosen', () => {
  const { trigger } = renderPicker({ attention: true, placeholder: 'Choose a narrator' });
  expect(trigger).toHaveTextContent('Choose a narrator');
  expect(trigger).toHaveAttribute('data-attention');
});

it('stays closed when disabled', () => {
  const { trigger } = renderPicker({ disabled: true });
  expect(trigger).toBeDisabled();
  fireEvent.click(trigger);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

it('groups cloned and designed voices under headings only when both exist', async () => {
  const { trigger, unmount } = renderPicker();
  await open(trigger);
  const cloned = screen.getByRole('group', { name: 'Cloned voices' });
  expect(within(cloned).getAllByRole('option')).toHaveLength(2);
  const designed = screen.getByRole('group', { name: 'Designed voices' });
  expect(within(designed).getByRole('option')).toHaveTextContent('Đào Lan');
  unmount();

  const clonesOnly = renderPicker({ profiles: profiles.slice(0, 2) });
  await open(clonesOnly.trigger);
  expectOptions('Mara', GIONG);
  expect(screen.queryByText('Cloned voices')).not.toBeInTheDocument();
});

it('explains when there are no voices yet', async () => {
  const { trigger } = renderPicker({ profiles: [] });
  await open(trigger);
  expectOptions();
  expect(screen.getByText(/No voice profiles installed yet/)).toBeInTheDocument();
});

it('waits for the profiles to load instead of calling the chosen voice missing', () => {
  const { trigger, rerender, onChange } = renderPicker({
    value: 'p-dao',
    profiles: [],
    loading: true,
  });
  expect(trigger).toHaveTextContent('Loading…');
  expect(trigger).not.toHaveTextContent('Voice not found');
  expect(trigger).toHaveAttribute('aria-busy', 'true');
  expect(trigger).toBeDisabled();
  rerender(
    <VoicePicker
      value="p-dao"
      onChange={onChange}
      profiles={profiles}
      aria-label="Default voice"
    />,
  );
  expect(trigger).toHaveTextContent('Đào Lan');
  expect(trigger).not.toHaveAttribute('aria-busy');
  expect(trigger).toBeEnabled();
});
