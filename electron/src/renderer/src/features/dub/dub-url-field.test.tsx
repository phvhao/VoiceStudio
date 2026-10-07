import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const clipboard = vi.hoisted(() => ({ read: vi.fn<() => Promise<string>>() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/clipboard', () => ({ readClipboardText: () => clipboard.read() }));

import { copiedLink, DubUrlField, useDubUrlDraft } from './dub-url-field';

function Field({ initial = '', onClear = () => {} }: { initial?: string; onClear?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DubUrlField
      value={value}
      onChange={setValue}
      onClear={() => {
        setValue('');
        onClear();
      }}
      disabled={false}
    />
  );
}

const field = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'dub.paste_url' });
const paste = () => fireEvent.click(screen.getByRole('button', { name: 'context.paste' }));

// Each test gives the clipboard its own answer.
afterEach(() => clipboard.read.mockClear());

it('accepts only a whole web link from the clipboard', () => {
  expect(copiedLink('  https://youtu.be/dQw4w9WgXcQ\n')).toBe('https://youtu.be/dQw4w9WgXcQ');
  expect(copiedLink('http://example.com/video.mp4')).toBe('http://example.com/video.mp4');
  expect(copiedLink('watch this https://youtu.be/x')).toBeNull();
  expect(copiedLink('https://youtu.be/x\nhttps://youtu.be/y')).toBeNull();
  expect(copiedLink('file:///home/me/movie.mp4')).toBeNull();
  expect(copiedLink('javascript:alert(1)')).toBeNull();
  expect(copiedLink('')).toBeNull();
});

it('pastes a copied link in one click and puts the cursor in the field', async () => {
  clipboard.read.mockResolvedValue(' https://www.youtube.com/watch?v=abc ');
  render(<Field />);
  paste();
  await waitFor(() => expect(field()).toHaveValue('https://www.youtube.com/watch?v=abc'));
  expect(field()).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('');
});

it('leaves the field alone and says why when the clipboard holds no link', async () => {
  clipboard.read.mockResolvedValue('Xin chào, đây không phải liên kết');
  render(<Field initial="https://old.example/v" />);
  paste();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('dubUrl.not_link'));
  expect(field()).toHaveValue('https://old.example/v');
  expect(field()).toHaveAttribute('aria-describedby', screen.getByRole('status').id);
  // Typing clears the note.
  fireEvent.change(field(), { target: { value: 'https://new.example/v' } });
  expect(screen.getByRole('status')).toHaveTextContent('');
});

it('tells the user to paste with the keyboard when the clipboard cannot be read', async () => {
  clipboard.read.mockImplementation(async () => {
    throw new DOMException('Denied', 'NotAllowedError');
  });
  render(<Field />);
  paste();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('clone.paste_failed'));
  expect(screen.getByRole('button', { name: 'context.paste' })).toBeEnabled();
});

it('keeps what was typed while the clipboard was being read', async () => {
  let resolve: (text: string) => void = () => {};
  clipboard.read.mockReturnValue(new Promise((done) => (resolve = done)));
  render(<Field />);
  paste();
  fireEvent.change(field(), { target: { value: 'https://typed.example/v' } });
  await act(async () => resolve('https://clipboard.example/v'));
  expect(clipboard.read).toHaveBeenCalledOnce();
  expect(field()).toHaveValue('https://typed.example/v');
  // The read is over: Paste works again.
  clipboard.read.mockResolvedValue('https://clipboard.example/v');
  fireEvent.change(field(), { target: { value: '' } });
  paste();
  await waitFor(() => expect(field()).toHaveValue('https://clipboard.example/v'));
});

it('clears the field and its note', async () => {
  clipboard.read.mockResolvedValue('not a link');
  const onClear = vi.fn();
  render(<Field initial="https://old.example/v" onClear={onClear} />);
  paste();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('dubUrl.not_link'));
  fireEvent.click(screen.getByRole('button', { name: 'common.clear' }));
  expect(onClear).toHaveBeenCalledOnce();
  expect(field()).toHaveValue('');
  expect(screen.getByRole('status')).toHaveTextContent('');
  expect(screen.queryByRole('button', { name: 'common.clear' })).toBeNull();
});

it('keeps a typed link for when the user comes Back to Dubbing', () => {
  function Page() {
    const [value, setValue] = useDubUrlDraft();
    return (
      <DubUrlField
        value={value}
        onChange={setValue}
        onClear={() => setValue('')}
        disabled={false}
      />
    );
  }
  const first = render(<Page />);
  fireEvent.change(field(), { target: { value: 'https://youtu.be/half-typed' } });
  first.unmount();
  const again = render(<Page />);
  expect(field()).toHaveValue('https://youtu.be/half-typed');
  fireEvent.click(screen.getByRole('button', { name: 'common.clear' }));
  again.unmount();
  render(<Page />);
  expect(field()).toHaveValue('');
});

it('keeps the keyboard on Paste when there is nothing to paste', async () => {
  clipboard.read.mockResolvedValue('plain words');
  render(<Field />);
  const button = screen.getByRole('button', { name: 'context.paste' });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('dubUrl.not_link'));
  expect(button).toHaveFocus();
});
