import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n, { setAppLanguage } from '@/i18n';
import { parseCastNames } from '@shared/utils/audiobookScript';
import type { VoiceGains } from '@shared/utils/longformOverrides';
import { MarkupEditorTools } from './markup-editor-tools';
import { editTag } from './markup-tag-card';
import { MarkupTextarea } from './markup-textarea';
import { tokenAt } from './script-markup';

const profiles = [
  { id: 'p-hao', name: 'Hao PV' },
  { id: 'p-mai', name: 'Mai' },
  { id: 'p-dao', name: 'Đào Lan' },
];

function Editor({
  initial,
  cast = {},
  gains = {},
  headings = false,
  lineVoices = false,
  loading = false,
  onVoiceCast,
  onVoiceGains,
  onListenRange,
}: {
  initial: string;
  loading?: boolean;
  cast?: Record<string, string>;
  gains?: VoiceGains;
  headings?: boolean;
  lineVoices?: boolean;
  onVoiceCast?: (cast: Record<string, string>) => void;
  onVoiceGains?: (gains: VoiceGains) => void;
  onListenRange?: (from: number, to: number) => void;
}) {
  const [text, setText] = useState(initial);
  const [voiceCast, setVoiceCast] = useState(cast);
  const [voiceGains, setVoiceGains] = useState(gains);
  const input = useRef<HTMLTextAreaElement>(null);
  const names = parseCastNames(text);
  return (
    <MarkupEditorTools
      getTarget={() => input.current && { element: input.current, setText }}
      disabled={false}
      headings={headings}
      lineVoices={lineVoices}
      profiles={profiles}
      loading={loading}
      scriptNames={names}
      voiceCast={voiceCast}
      onVoiceCast={(next) => {
        onVoiceCast?.(next);
        setVoiceCast(next);
      }}
      voiceGains={voiceGains}
      onVoiceGains={(next) => {
        onVoiceGains?.(next);
        setVoiceGains(next);
      }}
      defaultVoiceName="Narrator"
      onListenRange={onListenRange}
    >
      <MarkupTextarea
        textareaRef={input}
        aria-label="Script"
        headings={headings}
        voices={names}
        value={text}
        onValueChange={setText}
      />
    </MarkupEditorTools>
  );
}

const script = () => screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
const focus = () => act(() => script().focus());
const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
/** Click inside a tag, as the editor reads a click it has no layout to hit-test. */
const clickAt = (offset: number) => {
  script().setSelectionRange(offset, offset);
  fireEvent.click(script());
};
/** Alt+Enter with the caret at `offset`. */
const openAt = (offset: number) => {
  script().setSelectionRange(offset, offset);
  fireEvent.keyUp(script());
  fireEvent.keyDown(script(), { key: 'Enter', altKey: true });
};
const card = (tag: string) => screen.findByRole('dialog', { name: `Tag ${tag}` });
const noCard = () => expect(screen.queryByRole('dialog')).toBeNull();
/** Type `text` at the caret, the way a keystroke reaches a controlled textarea. */
const type = (text: string) => {
  const element = script();
  const { selectionStart: start, selectionEnd: end, value } = element;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setValue.call(element, value.slice(0, start) + text + value.slice(end));
  element.setSelectionRange(start + text.length, start + text.length);
  fireEvent.input(element);
};
const options = () => within(screen.getByRole('listbox')).getAllByRole('option');
const selected = () => options().find((option) => option.getAttribute('aria-selected') === 'true');

afterEach(() => vi.restoreAllMocks());

describe('tag card', () => {
  it('opens for a clicked tag and leaves the caret in the editor', async () => {
    render(<Editor initial="Wait [pause 1s] here" />);
    focus();
    clickAt(8);
    const pause = await card('[pause 1s]');
    expect(within(pause).getByText('A silence of 1s.')).toBeVisible();
    expect(within(pause).getByRole('button', { name: /Medium/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The chips change this pause's length; nothing is inserted.
    expect(within(pause).getByRole('group', { name: 'Pause length' })).toBeVisible();
    expect(
      within(pause).getByRole('spinbutton', { name: 'Custom pause length, in seconds' }),
    ).toBeVisible();
    expect(script()).toHaveFocus();
  });

  it('writes pause lengths in the app language, unit included', async () => {
    await act(() => setAppLanguage('vi'));
    try {
      render(<Editor initial="Wait [pause 1.5s] here" />);
      focus();
      clickAt(8);
      const pause = await screen.findByRole('dialog', {
        name: i18n.t('editor.card_label', { tag: '[pause 1.5s]' }),
      });
      expect(
        within(pause).getByText(i18n.t('editor.card_pause', { duration: '1,5 giây' })),
      ).toBeVisible();
      expect(within(pause).getByRole('spinbutton').closest('label')).toHaveTextContent(/giây$/);
    } finally {
      await act(() => setAppLanguage('en'));
    }
  });

  it('moves into the card from the keyboard and hands the focus back on Escape', async () => {
    render(<Editor initial="Wait [pause 1s] here" />);
    focus();
    openAt(6);
    const pause = await card('[pause 1s]');
    await waitFor(() =>
      expect(within(pause).getByRole('button', { name: /Medium/ })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(noCard);
    await waitFor(() => expect(script()).toHaveFocus());
  });

  it('closes once typing changes the tag, or the editor scrolls', async () => {
    render(<Editor initial="Wait [pause 1s] here" />);
    focus();
    clickAt(8);
    await card('[pause 1s]');
    script().setSelectionRange(9, 9);
    type('5');
    await waitFor(noCard);
    expect(script().value).toBe('Wait [pau5se 1s] here');
    clickAt(8);
    await card('[pau5se 1s]');
    fireEvent.scroll(script());
    await waitFor(noCard);
  });

  it('leaves the focus in the field a press outside the card moved it to', async () => {
    // Chromium honours `focus({ preventScroll })`, which is when Base UI
    // returns the focus after a press outside; jsdom never reads the option.
    const focusElement = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      void options?.preventScroll;
      focusElement.call(this, options);
    });
    render(
      <>
        <Editor initial="Wait [pause 1s] here" />
        <input aria-label="Other line" />
      </>,
    );
    focus();
    clickAt(8);
    await card('[pause 1s]');
    const other = screen.getByRole('textbox', { name: 'Other line' });
    fireEvent.pointerDown(other);
    fireEvent.mouseDown(other);
    act(() => other.focus());
    fireEvent.pointerUp(other);
    fireEvent.mouseUp(other);
    fireEvent.click(other);
    await waitFor(noCard);
    await nextFrame();
    await act(() => Promise.resolve());
    expect(other).toHaveFocus();
  });

  it('keeps the focus elsewhere when the card closes on its own', async () => {
    render(
      <>
        <Editor initial="Wait [pause 1s] here" />
        <input aria-label="Cast name" />
      </>,
    );
    focus();
    clickAt(8);
    await card('[pause 1s]');
    const other = screen.getByRole('textbox', { name: 'Cast name' });
    act(() => other.focus());
    fireEvent.scroll(script());
    await waitFor(noCard);
    await nextFrame();
    await act(() => Promise.resolve());
    expect(other).toHaveFocus();
  });

  it('changes a pause to a preset or to its own length, and removes it', async () => {
    render(<Editor initial="Wait [pause 1s] here" />);
    focus();
    clickAt(8);
    fireEvent.click(within(await card('[pause 1s]')).getByRole('button', { name: /Short/ }));
    expect(script().value).toBe('Wait [pause 500ms] here');
    await waitFor(noCard);
    clickAt(8);
    const pause = await card('[pause 500ms]');
    fireEvent.change(within(pause).getByRole('spinbutton'), { target: { value: '2.5' } });
    fireEvent.click(within(pause).getByRole('button', { name: 'Apply' }));
    expect(script().value).toBe('Wait [pause 2.5s] here');
    await waitFor(noCard);
    clickAt(8);
    fireEvent.click(within(await card('[pause 2.5s]')).getByRole('button', { name: 'Remove tag' }));
    expect(script().value).toBe('Wait here');
  });

  it('edits through the undo stack', async () => {
    const exec = vi.fn((_command: string, _ui?: boolean, _value?: string) => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    try {
      render(<Editor initial="Wait [pause 1s] here" />);
      focus();
      clickAt(8);
      fireEvent.click(within(await card('[pause 1s]')).getByRole('button', { name: /Long/ }));
      expect(exec).toHaveBeenCalledWith('insertText', false, '[pause 2s]');
      expect(script().value).toBe('Wait [pause 2s] here');
    } finally {
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });

  it('edits a tag only while it is still where it was', () => {
    render(<Editor initial="Wait [pause 1s] here" />);
    const setText = vi.fn();
    const stale = tokenAt('Now wait [pause 1s] here', 12)!;
    expect(editTag({ element: script(), setText }, stale, () => ({}) as never)).toBe(false);
    expect(setText).not.toHaveBeenCalled();
    expect(script().value).toBe('Wait [pause 1s] here');
  });

  it('switches a delivery pair from either half, and unwraps it', async () => {
    render(<Editor initial="say [slow]softly[/slow] now" />);
    focus();
    clickAt('say [slow]softly[/sl'.length);
    const slow = await card('[/slow]');
    expect(within(slow).getByRole('button', { name: /Slow/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(slow).getByRole('button', { name: /Fast/ }));
    expect(script().value).toBe('say [fast]softly[/fast] now');
    await waitFor(noCard);
    clickAt(6);
    fireEvent.click(within(await card('[fast]')).getByRole('button', { name: /keep the text/ }));
    expect(script().value).toBe('say softly now');
  });

  it('swaps an expression for another sound', async () => {
    render(<Editor initial="Oh [laughter] well" />);
    focus();
    clickAt(6);
    const sound = await card('[laughter]');
    expect(within(sound).getByTitle('[laughter]')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(sound).getByTitle('[surprise-ah]'));
    expect(script().value).toBe('Oh [surprise-ah] well');
  });

  it('respells a word in place, or keeps the word', async () => {
    render(<Editor initial="Open [[gif|jiff]] now" />);
    focus();
    clickAt(8);
    const word = await card('[[gif|jiff]]');
    expect(within(word).getByText('How “gif” is read at this spot.')).toBeVisible();
    const field = within(word).getByRole('textbox', { name: 'Read as' });
    expect(field).toHaveValue('jiff');
    fireEvent.change(field, { target: { value: 'ghif' } });
    fireEvent.submit(field.closest('form')!);
    expect(script().value).toBe('Open [[gif|ghif]] now');
    await waitFor(noCard);
    clickAt(8);
    fireEvent.click(
      within(await card('[[gif|ghif]]')).getByRole('button', { name: /keep the word/ }),
    );
    expect(script().value).toBe('Open gif now');
  });

  it('says what happens to a tag it does not know', async () => {
    render(<Editor initial="Hi [whisper] there" />);
    focus();
    clickAt(6);
    const unknown = await card('[whisper]');
    expect(within(unknown).getByText(/read aloud as written/)).toBeVisible();
    fireEvent.click(within(unknown).getByRole('button', { name: 'Remove tag' }));
    expect(script().value).toBe('Hi there');
  });
});

describe('voice card', () => {
  const pick = async (combobox: HTMLElement, name: string | RegExp) => {
    fireEvent.click(combobox);
    fireEvent.click(await screen.findByRole('option', { name }));
  };

  it('shows who reads a voice and recasts every tag of it', async () => {
    const onVoiceCast = vi.fn();
    render(
      <Editor
        initial="[voice:Mara] Hello. [voice:Mara] Again."
        cast={{ Mara: 'p-mai' }}
        onVoiceCast={onVoiceCast}
      />,
    );
    focus();
    clickAt(3);
    const voice = await card('[voice:Mara]');
    const readBy = within(voice).getByRole('combobox', { name: 'Read by' });
    expect(readBy).toHaveTextContent('Mai');
    await pick(readBy, 'Hao PV');
    expect(onVoiceCast).toHaveBeenLastCalledWith({ Mara: 'p-hao' });
    // Recasting changes no text, so the card stays to go on with.
    expect(screen.getByRole('dialog', { name: 'Tag [voice:Mara]' })).toBeVisible();
    await pick(within(voice).getByRole('combobox', { name: 'Read by' }), /Default voice/);
    expect(onVoiceCast).toHaveBeenLastCalledWith({});
    expect(within(voice).getByText(/not cast yet, so the default voice reads it/)).toBeVisible();
    expect(script().value).toBe('[voice:Mara] Hello. [voice:Mara] Again.');
  });

  it('finds a voice by name ignoring case and accents', async () => {
    const onVoiceCast = vi.fn();
    render(<Editor initial="[voice:Mara] Hello." onVoiceCast={onVoiceCast} />);
    focus();
    clickAt(3);
    fireEvent.click(within(await card('[voice:Mara]')).getByRole('combobox', { name: 'Read by' }));
    const search = await screen.findByRole('combobox', { name: 'Search voices' });
    fireEvent.input(search, { target: { value: 'DAO' }, inputType: 'insertText' });
    // The avatar's initials are hidden from the accessible name.
    const [match, ...rest] = screen.getAllByRole('option');
    expect(rest).toEqual([]);
    expect(match).toHaveAccessibleName('Đào Lan');
    fireEvent.click(match);
    expect(onVoiceCast).toHaveBeenLastCalledWith({ Mara: 'p-dao' });
  });

  it('warns when the voice cast to the name is gone', async () => {
    render(<Editor initial="[voice:Mara] Hello." cast={{ Mara: 'p-deleted' }} />);
    focus();
    clickAt(3);
    expect(
      within(await card('[voice:Mara]')).getByText(/voice cast to this name was deleted/),
    ).toBeVisible();
  });

  it('does not call a cast voice gone while the profiles load', async () => {
    render(<Editor initial="[voice:Mara] Hello." cast={{ Mara: 'p-mara' }} loading />);
    focus();
    clickAt(3);
    const voice = await card('[voice:Mara]');
    expect(within(voice).queryByText(/voice cast to this name was deleted/)).toBeNull();
    expect(
      within(voice).getByRole('combobox', { name: i18n.t('editor.read_by') }),
    ).toHaveTextContent(i18n.t('common.loading'));
  });

  it('switches this tag to another name, a profile, or the default voice', async () => {
    const onVoiceCast = vi.fn();
    render(
      <Editor
        initial="[voice:Mara] Hi. [voice:Ben] Yo. [voice:Mara] Bye."
        onVoiceCast={onVoiceCast}
      />,
    );
    focus();
    clickAt(3);
    await pick(within(await card('[voice:Mara]')).getByRole('combobox', { name: 'Voice' }), 'Ben');
    expect(script().value).toBe('[voice:Ben] Hi. [voice:Ben] Yo. [voice:Mara] Bye.');
    await waitFor(noCard);
    clickAt(3);
    await pick(
      within(await card('[voice:Ben]')).getByRole('combobox', { name: 'Voice' }),
      'Hao PV',
    );
    expect(onVoiceCast).toHaveBeenLastCalledWith({ 'Hao PV': 'p-hao' });
    expect(script().value).toBe('[voice:Hao PV] Hi. [voice:Ben] Yo. [voice:Mara] Bye.');
    await waitFor(noCard);
    clickAt(3);
    await pick(
      within(await card('[voice:Hao PV]')).getByRole('combobox', { name: 'Voice' }),
      'Back to the default voice',
    );
    expect(script().value).toBe('[voice:] Hi. [voice:Ben] Yo. [voice:Mara] Bye.');
  });

  it('sets the volume of the voice, the one the Cast panel shows', async () => {
    const onVoiceGains = vi.fn();
    render(
      <Editor
        initial="[voice:Mara] Hello. [voice:] Back."
        gains={{ Mara: 2 }}
        onVoiceGains={onVoiceGains}
      />,
    );
    focus();
    clickAt(3);
    const voice = await card('[voice:Mara]');
    const volume = within(voice).getByRole('slider', {
      name: i18n.t('leveling.volume_of', { name: 'Mara' }),
    });
    expect(volume).toHaveValue('2');
    fireEvent.change(volume, { target: { value: '5' } });
    expect(onVoiceGains).toHaveBeenLastCalledWith({ Mara: 5 });
    expect(within(voice).getByText('+5 dB')).toBeVisible();
    expect(within(voice).getByText('Applies to every [voice:Mara] in the script.')).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(noCard);
    // `[voice:]` hands the text to the default voice: its volume is the one stored under ''.
    clickAt('[voice:Mara] Hello. [voi'.length);
    const reset = await card('[voice:]');
    fireEvent.change(
      within(reset).getByRole('slider', {
        name: i18n.t('leveling.volume_of', { name: i18n.t('audiobook.default_voice') }),
      }),
      { target: { value: '-3' } },
    );
    expect(onVoiceGains).toHaveBeenLastCalledWith({ Mara: 5, '': -3 });
  });

  it('offers no shared default volume where each line has its own voice', async () => {
    render(<Editor initial="[voice:Mara] Hi. [voice:] Back." lineVoices />);
    focus();
    clickAt('[voice:Mara] Hi. [voi'.length);
    const reset = await card('[voice:]');
    expect(within(reset).getByText(/this line’s own voice/)).toBeVisible();
    expect(within(reset).queryByRole('slider')).toBeNull();
  });

  it('says `[voice:default]` reads the default voice even where lines have their own', async () => {
    // The render reads it in the default voice, not the line's (longformParser).
    const onVoiceGains = vi.fn();
    render(
      <Editor
        initial="[voice:Mara] Hi. [voice:Default] Back."
        lineVoices
        onVoiceGains={onVoiceGains}
      />,
    );
    focus();
    clickAt('[voice:Mara] Hi. [voi'.length);
    const reset = await card('[voice:Default]');
    expect(within(reset).getByText(i18n.t('editor.card_voice_reset'))).toBeVisible();
    expect(within(reset).queryByText(/this line’s own voice/)).toBeNull();
    fireEvent.change(
      within(reset).getByRole('slider', {
        name: i18n.t('leveling.volume_of', { name: i18n.t('audiobook.default_voice') }),
      }),
      { target: { value: '-3' } },
    );
    expect(onVoiceGains).toHaveBeenLastCalledWith({ '': -3 });
  });

  it('listens to and selects the part the voice reads', async () => {
    const onListenRange = vi.fn();
    const text = '# One\n[voice:Mara] Hello there.\n[voice:] Narration.';
    render(<Editor initial={text} headings onListenRange={onListenRange} />);
    focus();
    clickAt(text.indexOf('[voice:Mara]') + 3);
    fireEvent.click(
      within(await card('[voice:Mara]')).getByRole('button', { name: 'Listen to this part' }),
    );
    const part = [text.indexOf('Hello'), text.indexOf('Hello there.') + 'Hello there.'.length];
    expect(onListenRange).toHaveBeenCalledWith(...part);
    await waitFor(noCard);
    clickAt(text.indexOf('[voice:Mara]') + 3);
    fireEvent.click(
      within(await card('[voice:Mara]')).getByRole('button', { name: 'Select this part' }),
    );
    await waitFor(noCard);
    await nextFrame();
    expect([script().selectionStart, script().selectionEnd]).toEqual(part);
    expect(script().selectionDirection).toBe('backward');
  });

  it('cannot listen to a voice that reads nothing', async () => {
    render(<Editor initial="Text [voice:Mara]" onListenRange={vi.fn()} />);
    focus();
    clickAt(8);
    expect(
      within(await card('[voice:Mara]')).getByRole('button', { name: 'Listen to this part' }),
    ).toBeDisabled();
  });
});

describe('suggestions', () => {
  it('lists tags while one is typed after [, and narrows them to what is typed', async () => {
    render(<Editor initial="Hello " />);
    focus();
    script().setSelectionRange(6, 6);
    type('[');
    const list = await screen.findByRole('listbox', { name: 'Tag suggestions' });
    expect(within(list).getByRole('option', { name: /Medium/ })).toBeVisible();
    expect(within(list).getByRole('option', { name: /Slow/ })).toBeVisible();
    expect(script()).toHaveAttribute('aria-controls', list.id);
    expect(script()).toHaveAttribute('aria-autocomplete', 'list');
    type('pa');
    expect(options().every((option) => option.textContent!.includes('[pause'))).toBe(true);
    expect(selected()).toHaveTextContent('Breath');
    expect(script()).toHaveAttribute('aria-activedescendant', selected()!.id);
  });

  it('moves with the arrows and inserts with Enter or Tab', async () => {
    render(<Editor initial="Wait " />);
    focus();
    script().setSelectionRange(5, 5);
    type('[pa');
    await screen.findByRole('listbox');
    expect(fireEvent.keyDown(script(), { key: 'ArrowDown' })).toBe(false);
    expect(selected()).toHaveTextContent('Short');
    expect(script()).toHaveAttribute('aria-activedescendant', selected()!.id);
    fireEvent.keyDown(script(), { key: 'ArrowUp' });
    fireEvent.keyDown(script(), { key: 'ArrowUp' });
    expect(selected()).toHaveTextContent('Scene break');
    expect(fireEvent.keyDown(script(), { key: 'Enter' })).toBe(false);
    expect(script().value).toBe('Wait [pause 3s]');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(script()).not.toHaveAttribute('aria-controls');
    // The caret settles after the inserted tag on the next frame.
    await nextFrame();
    type(' and [sig');
    await screen.findByRole('listbox');
    expect(fireEvent.keyDown(script(), { key: 'Tab' })).toBe(false);
    expect(script().value).toBe('Wait [pause 3s] and [sigh]');
  });

  it('puts the caret between the halves of a delivery pair', async () => {
    render(<Editor initial="Say " />);
    focus();
    script().setSelectionRange(4, 4);
    type('[sl');
    await screen.findByRole('listbox');
    fireEvent.keyDown(script(), { key: 'Enter' });
    expect(script().value).toBe('Say [slow][/slow]');
    await nextFrame();
    expect(script().selectionStart).toBe('Say [slow]'.length);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('casts a profile under a readable name when it is chosen', async () => {
    const onVoiceCast = vi.fn();
    render(<Editor initial="" onVoiceCast={onVoiceCast} />);
    focus();
    type('[hao');
    fireEvent.click(await screen.findByRole('option', { name: /Hao PV/ }));
    expect(onVoiceCast).toHaveBeenCalledWith({ 'Hao PV': 'p-hao' });
    expect(script().value).toBe('[voice:Hao PV]');
  });

  it('keeps the caret in the editor when a suggestion is clicked', async () => {
    render(<Editor initial="" />);
    focus();
    type('[');
    const option = await screen.findByRole('option', { name: /Short/ });
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(script().value).toBe('[pause 500ms]');
    expect(script()).toHaveFocus();
  });

  it('stays closed after Escape until the caret leaves the bracket', async () => {
    render(<Editor initial="Hi " />);
    focus();
    script().setSelectionRange(3, 3);
    type('[');
    await screen.findByRole('listbox');
    expect(fireEvent.keyDown(script(), { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    type('p');
    expect(screen.queryByRole('listbox')).toBeNull();
    // Enter is a line break again.
    expect(fireEvent.keyDown(script(), { key: 'Enter' })).toBe(true);
    script().setSelectionRange(1, 1);
    fireEvent.keyUp(script());
    script().setSelectionRange(5, 5);
    fireEvent.keyUp(script());
    type('a');
    expect(await screen.findByRole('listbox')).toBeVisible();
  });

  it('offers nothing on a chapter heading, whose tags are part of its title', async () => {
    render(<Editor initial={'Text\n# One '} headings />);
    focus();
    script().setSelectionRange(11, 11);
    type('[');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('\n[');
    expect(await screen.findByRole('listbox')).toBeVisible();
  });

  it('does not open when the caret merely walks into a tag', () => {
    render(<Editor initial="Wait [pa" />);
    focus();
    script().setSelectionRange(8, 8);
    fireEvent.keyUp(script());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('never opens or takes keys during an IME composition', async () => {
    render(<Editor initial="Xin chào " />);
    focus();
    script().setSelectionRange(9, 9);
    fireEvent.compositionStart(script());
    type('[');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(fireEvent.keyDown(script(), { key: 'Enter', isComposing: true })).toBe(true);
    fireEvent.compositionEnd(script());
    // The composed text is in: now it counts as typed.
    expect(await screen.findByRole('listbox')).toBeVisible();
    expect(fireEvent.keyDown(script(), { key: 'ArrowDown', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(script(), { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(script().value).toBe('Xin chào [');
  });

  it('puts the tag card away when a new tag is typed', async () => {
    render(<Editor initial="Wait [pause 1s] " />);
    focus();
    clickAt(8);
    await card('[pause 1s]');
    script().setSelectionRange(16, 16);
    type('[');
    await screen.findByRole('listbox');
    await waitFor(noCard);
  });
});
