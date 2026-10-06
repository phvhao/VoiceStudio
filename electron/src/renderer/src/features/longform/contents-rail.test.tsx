import { createPortal } from 'react-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { ContentsRail, RAIL_MIN_WIDTH } from './contents-rail';

const t = i18n.t.bind(i18n);

function Harness() {
  return (
    <ContentsRail
      outline={(rail) => (
        <div className={rail.className}>
          <button type="button" onClick={rail.onReveal}>
            Chapter one
          </button>
          <input
            aria-label="Rename"
            onKeyDown={(event) => {
              // What the outline's rename field does: Escape ends the rename.
              if (event.key === 'Escape') event.preventDefault();
            }}
          />
          {/* A row menu: portaled out of the rail, inside it in React's tree. */}
          {createPortal(<button type="button">Menu item</button>, document.body)}
        </div>
      )}
    >
      <textarea aria-label="Script" />
    </ContentsRail>
  );
}

const rail = () => document.querySelector('[data-slot="contents-rail"]')!;
const toggle = () => screen.getByRole('button', { name: t('book.show_contents') });
const open = () => {
  fireEvent.click(toggle());
  expect(rail()).toHaveAttribute('data-overlay');
};

beforeEach(() => {
  // Narrower than the rail needs: the contents open over the editor.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(RAIL_MIN_WIDTH - 100);
});
afterEach(() => vi.restoreAllMocks());

it('moves the focus into the contents over the editor, and Escape gives it back', () => {
  render(<Harness />);
  open();
  // The contents cover the toggle: the focus is in them, so Escape works at once.
  expect(screen.getByRole('button', { name: 'Chapter one' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Chapter one' }), { key: 'Escape' });
  expect(rail()).not.toHaveAttribute('data-overlay');
  expect(toggle()).toHaveFocus();
});

it('closes on Escape anywhere in the editor, unless it was handled or came from a menu', () => {
  render(<Harness />);
  open();
  // The rename field's own Escape ends the rename only.
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename' }), { key: 'Escape' });
  expect(rail()).toHaveAttribute('data-overlay');
  // A row menu closes on its own Escape; the contents stay.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Menu item' }), { key: 'Escape' });
  expect(rail()).toHaveAttribute('data-overlay');
  // In the script, Escape closes them, and the focus stays in the script.
  const script = screen.getByRole('textbox', { name: 'Script' });
  script.focus();
  fireEvent.keyDown(script, { key: 'Escape' });
  expect(rail()).not.toHaveAttribute('data-overlay');
  expect(script).toHaveFocus();
});

it('closes on a press outside the contents, not on one in their menu', () => {
  render(<Harness />);
  open();
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Menu item' }));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Chapter one' }));
  expect(rail()).toHaveAttribute('data-overlay');
  fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Script' }));
  expect(rail()).not.toHaveAttribute('data-overlay');
});
