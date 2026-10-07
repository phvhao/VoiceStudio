import { expect, it } from 'vitest';
import { radioStep } from './use-radio-keys';

it('moves through a radio group the ARIA way, wrapping round', () => {
  expect(radioStep('ArrowRight', 0, 3)).toBe(1);
  expect(radioStep('ArrowDown', 2, 3)).toBe(0);
  expect(radioStep('ArrowLeft', 0, 3)).toBe(2);
  expect(radioStep('ArrowUp', 1, 3)).toBe(0);
  expect(radioStep('Home', 2, 3)).toBe(0);
  expect(radioStep('End', 0, 3)).toBe(2);
  expect(radioStep('Enter', 0, 3)).toBeNull();
  expect(radioStep('ArrowRight', 0, 0)).toBeNull();
});

it('trades ← and → in a right-to-left language, as the options are laid out', () => {
  expect(radioStep('ArrowLeft', 0, 3, true)).toBe(1);
  expect(radioStep('ArrowRight', 0, 3, true)).toBe(2);
  // Down and up keep their meaning.
  expect(radioStep('ArrowDown', 0, 3, true)).toBe(1);
});
