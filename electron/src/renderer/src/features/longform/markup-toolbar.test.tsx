import { useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import { MarkupToolbar } from './markup-toolbar';
import { MarkupTextarea } from './markup-textarea';

const profiles = [
  { id: 'p-nhu', name: 'ms nhu' },
  { id: 'p-thang', name: 'thangvd' },
];

function Editor({
  initial,
  cast = {},
  onVoiceCast = vi.fn(),
}: {
  initial: string;
  cast?: Record<string, string>;
  onVoiceCast?: (cast: Record<string, string>) => void;
}) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <MarkupToolbar
        getTarget={() => input.current && { element: input.current, setText }}
        disabled={false}
        profiles={profiles}
        scriptNames={[]}
        voiceCast={cast}
        onVoiceCast={onVoiceCast}
        allowNewCharacter
      />
      <MarkupTextarea
        textareaRef={input}
        aria-label="Script"
        value={text}
        onValueChange={setText}
      />
    </>
  );
}

const script = () => screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
const select = (start: number, end = start) => script().setSelectionRange(start, end);
const flush = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

it('inserts a pause preset at the cursor', async () => {
  render(<Editor initial="Hello world" />);
  select(5);
  fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Medium/ }));
  expect(script().value).toBe('Hello [pause 1s] world');
  await flush();
  expect(script().selectionStart).toBe('Hello [pause 1s]'.length);
});

it('inserts a custom pause in seconds', async () => {
  render(<Editor initial="Hello" />);
  select(5);
  fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
  fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '2.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  expect(script().value).toBe('Hello [pause 2.5s]');
});

it('wraps the selection in a delivery tag', () => {
  render(<Editor initial="say hello now" />);
  select(4, 9);
  fireEvent.click(screen.getByRole('button', { name: /Slow/ }));
  expect(script().value).toBe('say [slow]hello[/slow] now');
});

it('voices a selection with a readable cast name and maps it to the profile', async () => {
  const onVoiceCast = vi.fn();
  render(<Editor initial="He said hello." onVoiceCast={onVoiceCast} />);
  select(8, 13);
  fireEvent.click(screen.getByRole('button', { name: /^Voice/ }));
  fireEvent.click(await screen.findByRole('button', { name: /ms nhu/ }));
  expect(onVoiceCast).toHaveBeenCalledWith({ 'ms nhu': 'p-nhu' });
  expect(script().value).toBe('He said [voice:ms nhu]hello[voice:].');
});

it('adds a new character name for the Cast panel to map', async () => {
  const onVoiceCast = vi.fn();
  render(<Editor initial="Line." onVoiceCast={onVoiceCast} />);
  select(0);
  fireEvent.click(screen.getByRole('button', { name: /^Voice/ }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'New character' }), {
    target: { value: 'Old [Sailor]' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'New character' }));
  expect(script().value).toBe('[voice:Old Sailor] Line.');
  expect(onVoiceCast).not.toHaveBeenCalled();
});

it('inserts a chapter heading with the next chapter number', () => {
  render(<Editor initial={'# Chapter 1\nText'} />);
  select(14);
  fireEvent.click(screen.getByRole('button', { name: /^Chapter/ }));
  expect(script().value).toBe('# Chapter 1\nText\n\n# Chapter 2\n');
});

it('highlights markup behind the text', () => {
  const { container } = render(<Editor initial="Hi [pause 1s] [voice:Mara]there [oops]" />);
  const kinds = [...container.querySelectorAll('mark')].map((mark) => [
    mark.textContent,
    mark.dataset.kind,
  ]);
  expect(kinds).toEqual([
    ['[pause 1s]', 'pause'],
    ['[voice:Mara]', 'voice'],
    ['[oops]', 'unknown'],
  ]);
});
