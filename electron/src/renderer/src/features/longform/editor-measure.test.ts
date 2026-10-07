import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MEASURE_DEFAULT,
  READING_MEASURE,
  getEditorMeasure,
  measureWidth,
  setEditorMeasure,
  useEditorMeasure,
} from './editor-measure';

afterEach(() => {
  setEditorMeasure(MEASURE_DEFAULT);
  vi.restoreAllMocks();
});

it('reads at the reading measure until the viewer fits the frame', () => {
  expect(MEASURE_DEFAULT).toBe('reading');
  expect(measureWidth('reading')).toBe(READING_MEASURE);
  expect(READING_MEASURE).toBe('100ch');
  expect(measureWidth('fit')).toBeUndefined();
});

it('shares one choice between the editors and keeps it for the viewer', () => {
  const first = renderHook(() => useEditorMeasure());
  const second = renderHook(() => useEditorMeasure());
  act(() => first.result.current[1]('fit'));
  expect(second.result.current[0]).toBe('fit');
  expect(localStorage.getItem('voicestudio.editor-measure')).toBe('fit');
  act(() => second.result.current[1]('reading'));
  expect(first.result.current[0]).toBe('reading');
  expect(localStorage.getItem('voicestudio.editor-measure')).toBe('reading');
});

it('still switches when the browser blocks its storage', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  setEditorMeasure('fit');
  expect(getEditorMeasure()).toBe('fit');
});
