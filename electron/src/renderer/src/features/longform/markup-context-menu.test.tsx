import { useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@/i18n';
import { MarkupContextMenu } from './markup-context-menu';
import { MarkupTextarea } from './markup-textarea';

function Editor({ initial, onListen }: { initial: string; onListen?: () => void }) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <MarkupContextMenu
      getTarget={() => input.current && { element: input.current, setText }}
      disabled={false}
      profiles={[{ id: 'p1', name: 'ms nhu' }]}
      scriptNames={[]}
      voiceCast={{}}
      onVoiceCast={vi.fn()}
      onListen={onListen}
    >
      <MarkupTextarea
        textareaRef={input}
        aria-label="Script"
        value={text}
        onValueChange={setText}
      />
    </MarkupContextMenu>
  );
}

const script = () => screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
const rightClickAt = (start: number, end = start) => {
  script().setSelectionRange(start, end);
  fireEvent.contextMenu(script());
};

it('removes the tag that was right-clicked', async () => {
  render(<Editor initial="Wait [pause 1s] here" />);
  rightClickAt('Wait [pa'.length);
  expect(within(await screen.findByRole('menu')).getByText('[pause 1s]')).toBeVisible();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove tag' }));
  expect(script().value).toBe('Wait here');
});

it('unwraps delivery markup and keeps the words', async () => {
  render(<Editor initial="say [slow]softly[/slow] now" />);
  rightClickAt('say [sl'.length);
  fireEvent.click(await screen.findByRole('menuitem', { name: /keep the text/ }));
  expect(script().value).toBe('say softly now');
});

it('respells the selected word from the menu', async () => {
  render(<Editor initial="Open gif now" />);
  rightClickAt(5, 8);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Pronounce' }));
  expect(script().value).toBe('Open [[gif|gif]] now');
});

it('offers cut and copy only for a selection, and listening when available', async () => {
  const onListen = vi.fn();
  render(<Editor initial="Plain text." onListen={onListen} />);
  rightClickAt(2);
  expect(await screen.findByRole('menuitem', { name: /Copy/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Listen' }));
  expect(onListen).toHaveBeenCalled();
});
