import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isTypedEdit, useSettledText } from './use-settled-text';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('tells a typed edit from a replaced text', () => {
  expect(isTypedEdit('Hello world', 'Hello, world')).toBe(true);
  expect(isTypedEdit('Hello world', 'Hello wrld')).toBe(true);
  expect(isTypedEdit('Xin chao', 'Xin chào')).toBe(true);
  expect(isTypedEdit('abc', 'abc')).toBe(true);
  // Another book, Clear, a paste.
  expect(isTypedEdit('# One\nA long first book.', '# Two\nAnother book here.')).toBe(false);
  expect(isTypedEdit('# One\nA long first book.', '')).toBe(false);
  expect(isTypedEdit('Start end', 'Start a pasted paragraph of text end')).toBe(false);
});

it('waits for typing to pause, but takes a replaced text at once', () => {
  const { result, rerender } = renderHook(({ text }) => useSettledText(text, 500), {
    initialProps: { text: 'Book A has [voice:Alice] here.' },
  });
  rerender({ text: 'Book A has [voice:Alice] here!' });
  expect(result.current).toBe('Book A has [voice:Alice] here.');
  act(() => void vi.advanceTimersByTime(499));
  expect(result.current).toBe('Book A has [voice:Alice] here.');
  act(() => void vi.advanceTimersByTime(1));
  expect(result.current).toBe('Book A has [voice:Alice] here!');
  // Opening book B shows book B, never book A for half a second.
  rerender({ text: '# Chapter\nBook B, nothing like the other.' });
  expect(result.current).toBe('# Chapter\nBook B, nothing like the other.');
  rerender({ text: '' });
  expect(result.current).toBe('');
});

it('settles on the last text when typing goes on past the delay', () => {
  const { result, rerender } = renderHook(({ text }) => useSettledText(text, 500), {
    initialProps: { text: 'a' },
  });
  for (const text of ['ab', 'abc', 'abcd']) {
    rerender({ text });
    act(() => void vi.advanceTimersByTime(300));
  }
  expect(result.current).toBe('a');
  act(() => void vi.advanceTimersByTime(200));
  expect(result.current).toBe('abcd');
});
