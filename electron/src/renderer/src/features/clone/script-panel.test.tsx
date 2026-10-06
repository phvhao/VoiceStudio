import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { ScriptPanel } from './script-panel';

const setCloneSetting = vi.fn();
let script = 'hello world';

vi.mock('@/lib/languages', () => ({
  LANGUAGES: ['Auto'],
  POPULAR_LANGUAGES: [],
  TAGS: ['[laughter]', '[sigh]'],
}));

vi.mock('@/lib/store/clone-settings', () => ({
  useCloneSetting: () => script,
  setCloneSetting: (...args: unknown[]) => setCloneSetting(...args),
}));

const INSERT = 'Insert a pause or expression';

/** The script box, focused, with the caret at `offset`. */
function scriptAt(offset: number) {
  const textarea = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
  act(() => textarea.focus());
  textarea.setSelectionRange(offset, offset);
  return textarea;
}
const card = (tag: string) => screen.findByRole('dialog', { name: `Tag ${tag}` });

function openAt(offset: number) {
  render(<ScriptPanel />);
  const textarea = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
  textarea.focus();
  textarea.setSelectionRange(offset, offset);
  fireEvent.click(screen.getByRole('button', { name: INSERT }));
  return textarea;
}

describe('ScriptPanel', () => {
  beforeEach(() => {
    script = 'hello world';
    setCloneSetting.mockClear();
  });

  it('inserts an expression token at the caret, spaced from the words', () => {
    openAt(5);
    fireEvent.click(screen.getByRole('menuitem', { name: '[laughter]' }));

    expect(setCloneSetting).toHaveBeenCalledWith('text', 'hello [laughter] world');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers the Audiobook pause lengths above the expressions', () => {
    openAt(5);
    const menus = screen.getAllByRole('menu');
    expect(menus.map((menu) => menu.getAttribute('aria-label'))).toEqual(['Pause', 'Reactions']);

    fireEvent.click(screen.getByRole('menuitem', { name: /Breath/ }));
    expect(setCloneSetting).toHaveBeenCalledWith('text', 'hello [pause 250ms] world');

    fireEvent.click(screen.getByRole('button', { name: INSERT }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Medium/ }));
    expect(setCloneSetting).toHaveBeenLastCalledWith('text', 'hello [pause 1s] world');
  });

  it('inserts a custom pause length in seconds, and refuses one out of range', () => {
    openAt(11);
    const seconds = screen.getByRole('spinbutton', { name: 'Custom pause length, in seconds' });
    const insert = screen.getByRole('button', { name: 'Insert' });

    fireEvent.change(seconds, { target: { value: '0' } });
    expect(insert).toBeDisabled();
    fireEvent.change(seconds, { target: { value: '11' } });
    expect(insert).toBeDisabled();

    fireEvent.change(seconds, { target: { value: '2.5' } });
    fireEvent.click(insert);
    expect(setCloneSetting).toHaveBeenCalledWith('text', 'hello world [pause 2.5s]');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens with Alt+/ and closes with Escape, back in the script', () => {
    render(<ScriptPanel />);
    const textarea = screen.getByRole('textbox', { name: 'Script' });
    textarea.focus();

    fireEvent.keyDown(textarea, { key: '/', altKey: true });
    expect(screen.getByRole('dialog', { name: INSERT })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it('closes when its trigger is pressed again', () => {
    render(<ScriptPanel />);
    const trigger = screen.getByRole('button', { name: INSERT });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('highlights pauses and expressions in the script', () => {
    script = 'Hi [pause 1s] there [laughter]';
    const { container } = render(<ScriptPanel />);

    expect(container.querySelector('mark[data-kind="pause"]')?.textContent).toBe('[pause 1s]');
    expect(container.querySelector('mark[data-kind="expression"]')?.textContent).toBe('[laughter]');
  });

  it('turns spell checking off: Chromium checks every language against English', () => {
    render(<ScriptPanel />);
    const textarea = screen.getByRole('textbox', { name: 'Script' });
    expect(textarea).toHaveAttribute('spellcheck', 'false');
    expect(textarea).toHaveAttribute('data-clone-script');
  });

  it('does not open or reopen the token menu when the script box is clicked', () => {
    render(<ScriptPanel />);
    const textarea = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;

    // A plain click to place the caret must not summon the menu.
    fireEvent.pointerDown(textarea);
    fireEvent.click(textarea);
    expect(screen.queryByRole('dialog')).toBeNull();

    // After inserting a token, clicking back in to keep writing must not
    // bring the menu back (regression: onClick reopened it on every caret
    // placement).
    fireEvent.click(screen.getByRole('button', { name: INSERT }));
    fireEvent.click(screen.getByRole('menuitem', { name: '[laughter]' }));
    fireEvent.pointerDown(textarea);
    fireEvent.click(textarea);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the character count', () => {
    render(<ScriptPanel />);
    expect(screen.getByText('11 characters')).toBeInTheDocument();
  });

  describe('tags', () => {
    afterEach(() => {
      delete (document as { execCommand?: unknown }).execCommand;
    });

    it('opens a clicked pause and changes it through the undo stack', async () => {
      const exec = vi.fn((_command: string, _ui?: boolean, _value?: string) => false);
      Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
      const onUserEdit = vi.fn();
      script = 'Wait [pause 1s] here';
      render(<ScriptPanel onUserEdit={onUserEdit} />);
      fireEvent.click(scriptAt(8));
      const pause = await card('[pause 1s]');
      fireEvent.click(within(pause).getByRole('button', { name: /Short/ }));

      expect(exec).toHaveBeenCalledWith('insertText', false, '[pause 500ms]');
      expect(setCloneSetting).toHaveBeenLastCalledWith('text', 'Wait [pause 500ms] here');
      expect(onUserEdit).toHaveBeenCalled();
    });

    it('opens a tag with Alt+Enter and swaps a reaction', async () => {
      script = 'Oh [laughter] no';
      render(<ScriptPanel />);
      fireEvent.keyDown(scriptAt(4), { key: 'Enter', altKey: true });
      const reaction = await card('[laughter]');
      await waitFor(() => expect(within(reaction).getByTitle('[laughter]')).toHaveFocus());
      fireEvent.click(within(reaction).getByTitle('[sigh]'));

      expect(setCloneSetting).toHaveBeenLastCalledWith('text', 'Oh [sigh] no');
    });

    it('removes a tag from the right-click menu, which offers no voice or chapter markup', async () => {
      script = 'Wait [pause 1s] here';
      render(<ScriptPanel />);
      fireEvent.contextMenu(scriptAt(8));
      const menu = await screen.findByRole('menu');
      expect(within(menu).queryByRole('menuitem', { name: 'Voice' })).toBeNull();
      expect(within(menu).queryByRole('menuitem', { name: 'Chapter' })).toBeNull();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove tag' }));

      expect(setCloneSetting).toHaveBeenLastCalledWith('text', 'Wait here');
    });

    it('offers only removal for a voice tag, which Clone does not read', async () => {
      script = '[voice:Mara]Hello';
      render(<ScriptPanel />);
      fireEvent.click(scriptAt(3));
      const voice = await card('[voice:Mara]');
      expect(within(voice).getByText(/Not used on this page/)).toBeVisible();
      expect(
        within(voice)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Remove tag']);
      fireEvent.click(within(voice).getByRole('button', { name: 'Remove tag' }));

      expect(setCloneSetting).toHaveBeenLastCalledWith('text', 'Hello');
    });
  });

  it('closes the caret menu on window resize without treating Window as a DOM node', () => {
    render(<ScriptPanel />);
    fireEvent.click(screen.getByRole('button', { name: INSERT }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent(window, new Event('resize'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
