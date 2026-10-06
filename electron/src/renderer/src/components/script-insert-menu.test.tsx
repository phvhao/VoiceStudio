import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { MarkupTextarea } from '@/features/longform/markup-textarea';
import {
  SCRIPT_UNSUPPORTED_TAGS,
  ScriptInsertMenu,
  ScriptTagTools,
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
      <ScriptTagTools menu={insert} setText={setText}>
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
      </ScriptTagTools>
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
/** Click inside a tag, as the editor reads a click it has no layout to hit-test. */
const clickAt = (offset: number) => {
  script().setSelectionRange(offset, offset);
  fireEvent.click(script());
};
/** Alt+Enter with the caret at `offset`. */
const openAt = (offset: number) => {
  script().setSelectionRange(offset, offset);
  fireEvent.keyDown(script(), { key: 'Enter', altKey: true });
};
const rightClickAt = (offset: number) => {
  script().setSelectionRange(offset, offset);
  fireEvent.contextMenu(script());
};
const card = (tag: string) => screen.findByRole('dialog', { name: `Tag ${tag}` });
const noCard = () => expect(screen.queryByRole('dialog', { name: /^Tag / })).toBeNull();
const INSERT = 'Insert a pause or expression';
const open = (initial: string) => {
  render(<Editor initial={initial} />);
  act(() => script().focus());
};
const startTyping = (initial: string) => {
  render(<Editor initial={initial} />);
  act(() => script().focus());
  script().setSelectionRange(initial.length, initial.length);
};

describe('ScriptTagTools', () => {
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

describe('ScriptTagTools', () => {
  afterEach(() => {
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it('opens a clicked pause and changes its length as one undoable edit', async () => {
    const exec = vi.fn((_command: string, _ui?: boolean, _value?: string) => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    open('Wait [pause 1s] here');
    clickAt(8);
    const pause = await card('[pause 1s]');
    expect(script()).toHaveFocus();
    fireEvent.click(within(pause).getByRole('button', { name: /Short/ }));
    expect(exec).toHaveBeenCalledWith('insertText', false, '[pause 500ms]');
    expect(script().value).toBe('Wait [pause 500ms] here');
    await waitFor(noCard);
  });

  it('opens with Alt+Enter, sets a custom length, and removes the pause', async () => {
    open('Wait [pause 1s] here');
    openAt(6);
    const pause = await card('[pause 1s]');
    await waitFor(() =>
      expect(within(pause).getByRole('button', { name: /Medium/ })).toHaveFocus(),
    );
    fireEvent.change(within(pause).getByRole('spinbutton'), { target: { value: '2.5' } });
    fireEvent.click(within(pause).getByRole('button', { name: 'Apply' }));
    expect(script().value).toBe('Wait [pause 2.5s] here');
    await waitFor(noCard);
    clickAt(8);
    fireEvent.click(within(await card('[pause 2.5s]')).getByRole('button', { name: 'Remove tag' }));
    expect(script().value).toBe('Wait here');
  });

  it('swaps a reaction for another sound', async () => {
    open('Oh [laughter] no');
    clickAt(6);
    fireEvent.click(within(await card('[laughter]')).getByTitle('[sigh]'));
    expect(script().value).toBe('Oh [sigh] no');
  });

  it('edits a respelling, or keeps the word', async () => {
    open('Say [[Nguyen|nwen]] now');
    clickAt(8);
    const respelling = await card('[[Nguyen|nwen]]');
    fireEvent.change(within(respelling).getByRole('textbox'), { target: { value: 'win' } });
    fireEvent.click(within(respelling).getByRole('button', { name: 'Apply' }));
    expect(script().value).toBe('Say [[Nguyen|win]] now');
    await waitFor(noCard);
    clickAt(8);
    fireEvent.click(
      within(await card('[[Nguyen|win]]')).getByRole('button', {
        name: 'Remove respelling, keep the word',
      }),
    );
    expect(script().value).toBe('Say Nguyen now');
  });

  it('only removes a tag the page does not read, opened by a click or Alt+Enter', async () => {
    open('[voice:Mara]Hi [slow]there[/slow]');
    clickAt(3);
    const voice = await card('[voice:Mara]');
    expect(within(voice).getByText(/Not used on this page/)).toBeVisible();
    expect(
      within(voice)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Remove tag']);
    fireEvent.keyDown(script(), { key: 'Escape' });
    await waitFor(noCard);
    // From the keyboard the tag arrives with its own kind: still not read here.
    openAt('[voice:Mara]Hi [sl'.length);
    const delivery = await card('[slow]');
    expect(within(delivery).queryByRole('group')).toBeNull();
    fireEvent.click(
      within(delivery).getByRole('button', { name: 'Remove this markup, keep the text' }),
    );
    expect(script().value).toBe('[voice:Mara]Hi there');
  });

  it("right-click offers the tag's actions, editing, and only the inserts read here", async () => {
    open('Wait [pause 1s] here');
    rightClickAt(8);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('[pause 1s]')).toBeVisible();
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '');
    for (const kept of ['Change pause', 'Remove tag', 'Cut', 'Copy', 'Paste', 'Select all'])
      expect(labels.some((label) => label.startsWith(kept))).toBe(true);
    expect(labels).toEqual(expect.arrayContaining(['Pause', 'Pronounce', 'Reactions']));
    for (const dropped of ['Voice', 'Delivery', 'Quieter or louder', 'Chapter'])
      expect(labels).not.toContain(dropped);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove tag' }));
    expect(script().value).toBe('Wait here');
  });

  it('right-click on a tag the page does not read gives the reason and its removal only', async () => {
    open('Say [volume -6dB]soft[/volume] now');
    rightClickAt(7);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText(/Not used on this page/)).toBeVisible();
    expect(within(menu).queryByRole('menuitem', { name: /Change volume/ })).toBeNull();
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Remove this markup, keep the text' }),
    );
    expect(script().value).toBe('Say soft now');
  });

  it('keeps one popup open at a time with the Insert menu', async () => {
    open('Wait [pause 1s] here');
    clickAt(8);
    await card('[pause 1s]');
    fireEvent.keyDown(script(), { key: '/', altKey: true });
    expect(screen.getByRole('dialog', { name: INSERT })).toBeVisible();
    await waitFor(noCard);
    // Opening a tag puts the Insert menu away.
    act(() => script().focus());
    openAt(8);
    await card('[pause 1s]');
    expect(screen.queryByRole('dialog', { name: INSERT })).toBeNull();
  });
});
