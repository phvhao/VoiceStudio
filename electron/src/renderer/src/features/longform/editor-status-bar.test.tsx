import type { ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import { parseCastNames } from '@shared/utils/audiobookScript';
import { EditorStatusBar, createCaretSource, sameVoiceName } from './editor-status-bar';

const profiles = [
  { id: 'p-hao', name: 'Hao PV' },
  { id: 'p-lan', name: 'Lan' },
];

function bar(
  text: string,
  offset: number,
  props: Partial<ComponentProps<typeof EditorStatusBar>> = {},
) {
  const caret = createCaretSource(offset);
  const view = render(
    <EditorStatusBar
      text={text}
      caret={caret}
      headings
      names={parseCastNames(text)}
      voiceCast={{ Mara: 'p-hao' }}
      profiles={profiles}
      defaultVoiceName="Lan"
      stats="1 chapters · 3 words · 0:01 est. runtime"
      {...props}
    />,
  );
  return { ...view, caret };
}

it('shows the caret position, who reads there and the script stats', () => {
  const text = '# One\n[voice:Mara] Hello there.';
  const { container } = bar(text, text.indexOf('there'));
  expect(screen.getByText('Ln 2, Col 20')).toBeVisible();
  expect(screen.getByText('Voice: Mara, read by Hao PV')).toBeVisible();
  // Mara's color, the same as her tags in the editor.
  expect(container.querySelector('.bg-sky-400')).not.toBeNull();
  expect(screen.getByText('1 chapters · 3 words · 0:01 est. runtime')).toBeVisible();
});

it('names the default voice where no tag applies, and says when none is chosen', () => {
  const text = '[voice:Mara] Hi.\n# Two\nNarrated.';
  const { container, rerender } = bar(text, text.indexOf('Narrated'));
  expect(screen.getByText('Default voice (Lan)')).toBeVisible();
  expect(container.querySelector('.bg-muted-foreground\\/50')).not.toBeNull();
  rerender(
    <EditorStatusBar
      text={text}
      caret={createCaretSource(0)}
      names={[]}
      voiceCast={{}}
      profiles={profiles}
      defaultVoiceName={null}
    />,
  );
  expect(screen.getByText('Default voice (not chosen yet)')).toBeVisible();
});

it('says who reads a name the cast does not map', () => {
  bar('[voice:Ben] Hi.', 12);
  expect(screen.getByText('Voice: Ben, read by Default voice (Lan)')).toBeVisible();
});

it('flags a cast mapping to a deleted voice, and reads profile ids as their names', () => {
  const { rerender } = bar('[voice:Mara] Hi.', 13, { voiceCast: { Mara: 'gone' } });
  expect(screen.getByText('Voice: Mara, read by Unavailable')).toBeVisible();
  rerender(
    <EditorStatusBar
      text="[voice:p-lan] Hi."
      caret={createCaretSource(14)}
      names={['p-lan']}
      voiceCast={{}}
      profiles={profiles}
    />,
  );
  expect(screen.getByText('Voice: Lan')).toBeVisible();
});

it('does not call a cast voice unavailable while the profiles load', () => {
  bar('[voice:Mara] Hi.', 13, { voiceCast: { Mara: 'p-mara' }, profiles: [], loading: true });
  expect(screen.getByText('Voice: Mara, read by Loading…')).toBeVisible();
});

it('follows the caret on its own', () => {
  const text = 'one\ntwo';
  const { caret } = bar(text, 0);
  expect(screen.getByText('Ln 1, Col 1')).toBeVisible();
  act(() => caret.set(text.length));
  expect(screen.getByText('Ln 2, Col 4')).toBeVisible();
});

it('says a name once when it is cast to the voice it is named after', () => {
  const { rerender } = bar('[voice:Hao PV] Hi.', 16, { voiceCast: { 'Hao PV': 'p-hao' } });
  expect(screen.getByText('Voice: Hao PV')).toBeVisible();
  // Case and spaces do not make it another name.
  rerender(
    <EditorStatusBar
      text="[voice:haopv] Hi."
      caret={createCaretSource(15)}
      names={['haopv']}
      voiceCast={{ haopv: 'p-hao' }}
      profiles={profiles}
    />,
  );
  expect(screen.getByText('Voice: haopv')).toBeVisible();
  expect(sameVoiceName('Hào  PV', 'hào pv')).toBe(true);
  expect(sameVoiceName('Mara', 'Hao PV')).toBe(false);
});

it('zooms the editor from its − / % / + control', async () => {
  const onZoomChange = vi.fn();
  const { rerender } = bar('one', 0, { zoom: 100, onZoomChange });
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(onZoomChange).toHaveBeenLastCalledWith(110);
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  expect(onZoomChange).toHaveBeenLastCalledWith(90);
  fireEvent.click(screen.getByRole('button', { name: 'Text size: 100%' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '140%' }));
  expect(onZoomChange).toHaveBeenLastCalledWith(140);
  rerender(
    <EditorStatusBar
      text="one"
      caret={createCaretSource(0)}
      names={[]}
      voiceCast={{}}
      profiles={profiles}
      zoom={160}
      onZoomChange={onZoomChange}
    />,
  );
  expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Text size: 160%' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset to 100%' }));
  expect(onZoomChange).toHaveBeenLastCalledWith(100);
});
