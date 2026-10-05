import type { ComponentProps } from 'react';
import { expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import '@/i18n';
import { parseCastNames } from '@shared/utils/audiobookScript';
import { EditorStatusBar, createCaretSource } from './editor-status-bar';

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
