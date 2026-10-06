import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/i18n';
import { MarkupTextarea } from '@/features/longform/markup-textarea';
import {
  SCRIPT_UNSUPPORTED_TAGS,
  ScriptInsertMenu,
  ScriptTagSuggestions,
  useScriptInsertMenu,
} from './script-insert-menu';

/** A single-voice script editor, wired as Clone and Voice Design wire theirs. */
function Editor({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = useScriptInsertMenu(ref);
  return (
    <>
      <ScriptInsertMenu menu={insert} setText={setText} />
      <ScriptTagSuggestions menu={insert} setText={setText}>
        <MarkupTextarea
          aria-label="Script"
          textareaRef={ref}
          value={text}
          unsupported={SCRIPT_UNSUPPORTED_TAGS}
          onValueChange={(value) => {
            insert.close();
            setText(value);
          }}
          onKeyDown={insert.onEditorKeyDown}
        />
      </ScriptTagSuggestions>
    </>
  );
}

const script = () => screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
const options = () => within(screen.getByRole('listbox')).getAllByRole('option');
/** Type `text` at the caret, the way a keystroke reaches a controlled textarea. */
const type = (text: string) => {
  const element = script();
  const { selectionStart: start, selectionEnd: end, value } = element;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setValue.call(element, value.slice(0, start) + text + value.slice(end));
  element.setSelectionRange(start + text.length, start + text.length);
  fireEvent.input(element);
};
const startTyping = (initial: string) => {
  render(<Editor initial={initial} />);
  act(() => script().focus());
  script().setSelectionRange(initial.length, initial.length);
};

describe('ScriptTagSuggestions', () => {
  it('suggests only the pauses and expressions a single-voice script reads', async () => {
    startTyping('Hello ');
    type('[');
    const list = await screen.findByRole('listbox', { name: 'Tag suggestions' });
    expect(
      within(list)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual(['Pause', 'Reactions']);
    expect(options().some((option) => /\[voice|\[slow|\[volume/.test(option.textContent!))).toBe(
      false,
    );
    expect(script()).toHaveAttribute('aria-controls', list.id);
  });

  it('inserts the chosen tag with Enter', async () => {
    startTyping('Wait ');
    type('[pa');
    await screen.findByRole('listbox');
    fireEvent.keyDown(script(), { key: 'Enter' });
    expect(script().value).toBe('Wait [pause 250ms]');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('offers nothing for markup only Audiobook and Stories read', () => {
    startTyping('Hi ');
    type('[sl');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('ow');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('puts the Insert menu away once a tag is typed', async () => {
    startTyping('Hi ');
    fireEvent.click(screen.getByRole('button', { name: 'Insert a pause or expression' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    act(() => script().focus());
    type('[');
    await screen.findByRole('listbox');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks voice switches, delivery and volume as not read here', () => {
    const { container } = render(
      <Editor initial="[voice:Mara]Hi [slow]there[/slow] [volume -6dB]x[/volume] [pause 1s] [laughter]" />,
    );
    const kinds = [...container.querySelectorAll('mark')].map((mark) => mark.dataset.kind);
    expect(kinds).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'pause',
      'expression',
    ]);
  });
});
