import { render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fitRoom, fitSteps, useFitSteps } from './use-fit-steps';
import {
  TITLEBAR_FIT_PARTS,
  TITLEBAR_FIT_STEPS,
  TITLEBAR_NAME_MIN,
} from '@/components/app-shell/titlebar-fit';

// jsdom lays nothing out, so each element reports the widths a test gives it,
// read against the steps its bar has taken so far.
function size(element: HTMLElement, client: number, content: (fit: string) => number) {
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => client });
  Object.defineProperty(element, 'scrollWidth', {
    configurable: true,
    get: () => content(element.closest<HTMLElement>('[data-fit]')?.dataset.fit ?? ''),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

it('takes steps only until nothing overflows', () => {
  const bar = document.createElement('header');
  const widths: Record<string, number> = { '': 700, labels: 640, 'labels count': 600 };
  size(bar, 600, (fit) => widths[fit] ?? 560);

  expect(fitSteps(bar, ['labels', 'count', 'controls'])).toBe('labels count');
  expect(bar.dataset.fit).toBe('labels count');
});

it('takes no step when everything fits, and every step when nothing does', () => {
  const roomy = document.createElement('header');
  size(roomy, 600, () => 400);
  expect(fitSteps(roomy, ['labels', 'count'])).toBe('');

  const cramped = document.createElement('header');
  size(cramped, 300, () => 400);
  expect(fitSteps(cramped, ['labels', 'count'])).toBe('labels count');
});

it('treats a part cut short as not fitting, though the bar itself does not overflow', () => {
  const bar = document.createElement('header');
  const title = bar.appendChild(document.createElement('h1'));
  size(bar, 600, () => 600);
  // The title shortens with an ellipsis until the bar gives up the star count.
  size(title, 100, (fit) => (fit.split(' ').includes('count') ? 100 : 130));

  expect(fitSteps(bar, ['labels', 'count', 'controls'], 'h1')).toBe('labels count');
});

it('gives way to a name beside the title until it has its minimum width', () => {
  // A Dub file name shortens before anything else does: the bar never
  // overflowed, so Get Pro, Star and Ctrl K kept their words while the name
  // shrank to an ellipsis.
  const bar = document.createElement('header');
  const title = bar.appendChild(document.createElement('h1'));
  const name = bar.appendChild(document.createElement('span'));
  name.dataset.fitMin = String(TITLEBAR_NAME_MIN);
  size(bar, 900, () => 900);
  size(title, 80, () => 80);
  // Each step hands the name 50px; the file name needs 400px in full.
  const room: Record<string, number> = { '': 20, labels: 70, 'labels count': 120 };
  Object.defineProperty(name, 'clientWidth', {
    configurable: true,
    get: () => room[bar.dataset.fit ?? ''] ?? 170,
  });
  Object.defineProperty(name, 'scrollWidth', { configurable: true, get: () => 400 });

  expect(fitSteps(bar, TITLEBAR_FIT_STEPS, TITLEBAR_FIT_PARTS)).toBe('labels count');
  // Wide enough for the whole name: no step at all, however long it is.
  room[''] = 400;
  expect(fitSteps(bar, TITLEBAR_FIT_STEPS, TITLEBAR_FIT_PARTS)).toBe('');
  // Shortened, yet past its minimum: it shortens, the shortcuts keep their words.
  room[''] = TITLEBAR_NAME_MIN + 10;
  expect(fitSteps(bar, TITLEBAR_FIT_STEPS, TITLEBAR_FIT_PARTS)).toBe('');
});

it('refits when its text changes, as a language switch does', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Ten pixels a character in a hundred-pixel bar.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 100,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.fit?.includes('labels') ? 50 : (this.textContent?.length ?? 0) * 10;
    },
  });
  function Bar({ label }: { label: string }) {
    const fit = useFitSteps<HTMLDivElement>(['labels']);
    return (
      <div data-testid="bar" ref={fit}>
        {label}
      </div>
    );
  }

  const { getByTestId, rerender, unmount } = render(<Bar label="Export" />);
  expect(getByTestId('bar').dataset.fit).toBe('');

  rerender(<Bar label="Exporter la piste audio" />);
  await waitFor(() => expect(getByTestId('bar').dataset.fit).toBe('labels'));

  rerender(<Bar label="Xuất" />);
  await waitFor(() => expect(getByTestId('bar').dataset.fit).toBe(''));
  unmount();
});

it('measures the room the bar needs with every step taken, whatever its width', () => {
  // Laid out at max-content, the bar is as wide as its content; a name
  // beside the title counts only down to its minimum.
  const bar = document.createElement('header');
  const name = bar.appendChild(document.createElement('span'));
  name.dataset.fitMin = '96';
  bar.dataset.fit = 'labels';
  bar.style.width = '320px';
  const seen: string[] = [];
  bar.getBoundingClientRect = () => {
    seen.push(`${bar.dataset.fit}@${bar.style.width}`);
    return { width: bar.style.width === 'max-content' ? 500.4 : 320 } as DOMRect;
  };
  name.getBoundingClientRect = () => ({ width: 180 }) as DOMRect;

  expect(fitRoom(bar, TITLEBAR_FIT_STEPS)).toBe(Math.ceil(500.4 - (180 - 96)));
  expect(seen).toEqual([`${TITLEBAR_FIT_STEPS.join(' ')}@max-content`]);
  // The bar keeps the steps and width it had.
  expect(bar.dataset.fit).toBe('labels');
  expect(bar.style.width).toBe('320px');
});
