import { expect, it } from 'vitest';
import {
  gridMove,
  namePrefix,
  namePrefixGroups,
  voiceGridColumns,
  voiceGridPresentation,
} from './voice-setup';

it('windows only large voice-choice grids', () => {
  expect(voiceGridPresentation(30)).toBe('grid');
  expect(voiceGridPresentation(31)).toBe('virtual');
});

it('fits four or five 15rem cards across a 1500 px window', () => {
  // The voice column beside a 256 px sidebar, and beside the 48 px rail.
  expect(voiceGridColumns(1500 - 256 - 48)).toBe(4);
  expect(voiceGridColumns(1500 - 48 - 48)).toBe(5);
  expect(voiceGridColumns(0)).toBe(1);
  // The app's text scale widens the cards with it.
  expect(voiceGridColumns(1196, 20)).toBe(3);
});

it('moves through the grid by row and column, mirrored right to left', () => {
  // 10 cards, 4 per row: rows 0–3, 4–7, 8–9.
  expect(gridMove(1, 'ArrowRight', 4, 10)).toBe(2);
  expect(gridMove(1, 'ArrowRight', 4, 10, true)).toBe(0);
  expect(gridMove(0, 'ArrowLeft', 4, 10)).toBeNull();
  expect(gridMove(2, 'ArrowDown', 4, 10)).toBe(6);
  expect(gridMove(7, 'ArrowDown', 4, 10)).toBe(9);
  expect(gridMove(9, 'ArrowDown', 4, 10)).toBeNull();
  expect(gridMove(5, 'ArrowUp', 4, 10)).toBe(1);
  expect(gridMove(1, 'ArrowUp', 4, 10)).toBeNull();
  expect(gridMove(6, 'Home', 4, 10)).toBe(0);
  expect(gridMove(6, 'End', 4, 10)).toBe(9);
  expect(gridMove(6, 'Enter', 4, 10)).toBeNull();
});

it('reads the prefix before a separator, without case', () => {
  expect(namePrefix('ktnb-anh')).toEqual({ key: 'ktnb', label: 'ktnb' });
  expect(namePrefix('KTNB - Chi')).toEqual({ key: 'ktnb', label: 'KTNB' });
  expect(namePrefix('chanel_2')?.key).toBe('chanel');
  expect(namePrefix('Hào: kể chuyện')?.key).toBe('hào');
  expect(namePrefix('Hao PV')).toBeNull();
  expect(namePrefix('-anh')).toBeNull();
  expect(namePrefix('ktnb-')).toBeNull();
});

it('offers a chip only for a prefix two or more voices share, and that narrows the list', () => {
  expect(
    namePrefixGroups(['ktnb-a', 'ktnb-b', 'chanel-1', 'chanel-2', 'ktnb-c', 'solo-1', 'Plain']),
  ).toEqual([
    { key: 'ktnb', label: 'ktnb', count: 3 },
    { key: 'chanel', label: 'chanel', count: 2 },
  ]);
  expect(namePrefixGroups(['ktnb-a', 'ktnb-b'])).toEqual([]);
  expect(namePrefixGroups(['Ada', 'Bo'])).toEqual([]);
});
