import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePaneResize } from './use-pane-resize';

// A 645px row — a 900px window beside the full sidebar — holds the screen and
// a voice sample pane that would like 400px, keeps 320px for the screen, and
// narrows no further than 304px by hand or 272px for the screen's title.
function Row({ room }: { room?: number }) {
  const { host, width } = usePaneResize({
    storageKey: 'test.pane-width',
    side: 'right',
    minimum: 304,
    initial: 400,
    maximum: 560,
    reserve: 320,
    room,
    floor: 272,
  });
  return (
    <div data-row>
      <aside ref={host} data-testid="pane" data-width={width} />
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-row') ? 645 : 0;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

const paneWidth = () => Number(screen.getByTestId('pane').dataset.width);

it('keeps the room it reserves for the screen, and no more, without a title to make way for', () => {
  render(<Row />);
  expect(paneWidth()).toBe(645 - 320);
});

it('narrows for a title bar that needs more than the reserve, down to its floor', () => {
  const { rerender } = render(<Row room={300} />);
  // The reserve already covers it.
  expect(paneWidth()).toBe(325);
  // A Russian Clone title bar beside the voice sample pane.
  rerender(<Row room={344} />);
  expect(paneWidth()).toBe(645 - 344);
  rerender(<Row room={500} />);
  expect(paneWidth()).toBe(272);
});
