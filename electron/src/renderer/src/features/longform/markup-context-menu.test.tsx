import { useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@/i18n';
import { parseCastNames } from '@shared/utils/audiobookScript';
import type { VoiceGains } from '@shared/utils/longformOverrides';
import { MarkupContextMenu } from './markup-context-menu';
import { MarkupTextarea } from './markup-textarea';

function Editor({
  initial,
  onListen,
  onListenRange,
  onVoiceCast,
  onVoiceGains,
  headings = false,
}: {
  initial: string;
  onListen?: () => void;
  onListenRange?: (from: number, to: number) => void;
  onVoiceCast?: (cast: Record<string, string>) => void;
  onVoiceGains?: (gains: VoiceGains) => void;
  headings?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [voiceCast, setVoiceCast] = useState<Record<string, string>>({});
  const [voiceGains, setVoiceGains] = useState<VoiceGains>({});
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <MarkupContextMenu
      getTarget={() => input.current && { element: input.current, setText }}
      disabled={false}
      headings={headings}
      profiles={[
        { id: 'p1', name: 'ms nhu' },
        { id: 'p2', name: 'Hao PV' },
      ]}
      scriptNames={parseCastNames(text)}
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
      onListen={onListen}
      onListenRange={onListenRange}
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
const submenu = async (name: string | RegExp) => {
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  return (await screen.findAllByRole('menu')).at(-1)!;
};

it('removes the tag that was right-clicked', async () => {
  render(<Editor initial="Wait [pause 1s] here" />);
  rightClickAt('Wait [pa'.length);
  expect(within(await screen.findByRole('menu')).getByText('[pause 1s]')).toBeVisible();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove tag' }));
  expect(script().value).toBe('Wait here');
});

it('acts on the tag when the right-click selected a word in it, as macOS does', async () => {
  render(<Editor initial="Wait [pause 1s] here" />);
  // macOS selects the word under the pointer before the menu opens.
  const word = 'Wait ['.length;
  rightClickAt(word, word + 'pause'.length);
  expect(within(await screen.findByRole('menu')).getByText('[pause 1s]')).toBeVisible();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove tag' }));
  expect(script().value).toBe('Wait here');
});

it('offers no tag for a selection reaching past it', async () => {
  render(<Editor initial="Wait [pause 1s] here" />);
  rightClickAt(0, 'Wait [pa'.length);
  await screen.findByRole('menu');
  expect(screen.queryByRole('menuitem', { name: 'Remove tag' })).toBeNull();
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

it('heads a voice tag with its color and recasts the voice', async () => {
  const onVoiceCast = vi.fn();
  render(<Editor initial="[voice:Ben] Hi. [voice:Mara] Hello." onVoiceCast={onVoiceCast} />);
  rightClickAt('[voice:Ben] Hi. [voi'.length);
  const header = within(await screen.findByRole('menu')).getByText('[voice:Mara]');
  // Mara is the script's second voice: the palette's second color, as in the editor.
  expect(header.previousElementSibling).toHaveClass('bg-amber-400');
  const readBy = await submenu(/Read by/);
  fireEvent.click(within(readBy).getByRole('menuitemradio', { name: 'Hao PV' }));
  expect(onVoiceCast).toHaveBeenLastCalledWith({ Mara: 'p2' });
});

it('steps a voice’s volume with the menu open', async () => {
  const onVoiceGains = vi.fn();
  render(<Editor initial="[voice:Mara] Hello." onVoiceGains={onVoiceGains} />);
  rightClickAt(3);
  const volume = await submenu(/Volume/);
  fireEvent.click(within(volume).getByRole('menuitem', { name: /Louder/ }));
  expect(onVoiceGains).toHaveBeenLastCalledWith({ Mara: 1 });
  fireEvent.click(within(volume).getByRole('menuitem', { name: /Louder/ }));
  expect(onVoiceGains).toHaveBeenLastCalledWith({ Mara: 2 });
  expect(screen.getByRole('menuitem', { name: /Volume/ })).toHaveTextContent('+2 dB');
  fireEvent.click(within(volume).getByRole('menuitem', { name: 'Reset to 0 dB' }));
  expect(onVoiceGains).toHaveBeenLastCalledWith({});
});

it('listens to and selects the part a voice reads', async () => {
  const onListenRange = vi.fn();
  const text = 'Intro. [voice:Mara] Her line. [voice:] Narration.';
  render(<Editor initial={text} onListenRange={onListenRange} />);
  const part = [text.indexOf('Her'), text.indexOf('Her line.') + 'Her line.'.length];
  rightClickAt(text.indexOf('[voice:Mara]') + 2);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Listen to this part' }));
  expect(onListenRange).toHaveBeenCalledWith(...part);
  rightClickAt(text.indexOf('[voice:Mara]') + 2);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Select this part' }));
  await waitFor(() => expect([script().selectionStart, script().selectionEnd]).toEqual(part));
});

it('switches a delivery pair to another kind', async () => {
  render(<Editor initial="say [slow]softly[/slow] now" />);
  rightClickAt('say [sl'.length);
  const kinds = await submenu(/Change delivery/);
  expect(within(kinds).getByRole('menuitemradio', { name: 'Slow' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  fireEvent.click(within(kinds).getByRole('menuitemradio', { name: 'Fast' }));
  expect(script().value).toBe('say [fast]softly[/fast] now');
});

it('turns a return to the default voice into a voice', async () => {
  render(<Editor initial="[voice:Mara] Hi. [voice:] Back." />);
  rightClickAt('[voice:Mara] Hi. [vo'.length);
  const voices = await submenu('Change voice');
  fireEvent.click(within(voices).getByRole('menuitem', { name: 'Mara' }));
  expect(script().value).toBe('[voice:Mara] Hi. [voice:Mara] Back.');
});

it('reads a tag on a chapter heading as part of its title', async () => {
  render(<Editor initial={'# One [pause 1s]\nText'} headings />);
  rightClickAt(9);
  await screen.findByRole('menu');
  expect(screen.queryByRole('menuitem', { name: 'Remove tag' })).toBeNull();
});
