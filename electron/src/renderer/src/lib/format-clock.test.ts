import { expect, it } from 'vitest';
import { formatClock } from './format-clock';

it.each([
  [0, '0:00'],
  [9.99, '0:09'],
  [61, '1:01'],
  [3725, '62:05'],
  [-4, '0:00'],
  [Number.NaN, '0:00'],
  [Number.POSITIVE_INFINITY, '0:00'],
])('formats %s seconds as %s', (seconds, text) => {
  expect(formatClock(seconds)).toBe(text);
});
