import { createRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ZOOM_DEFAULT,
  ZOOM_PRESETS,
  applyZoomKey,
  clampZoom,
  getEditorZoom,
  setEditorZoom,
  useEditorZoom,
  useEditorZoomInput,
  zoomKey,
  zoomedText,
} from './editor-zoom';
import { handleAppZoomKey } from '@/lib/zoom-keys';

afterEach(() => {
  setEditorZoom(ZOOM_DEFAULT);
  vi.restoreAllMocks();
});

const key = (k: string, extra: Partial<KeyboardEventInit> = {}) => ({
  key: k,
  code: '',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  ...extra,
});

it('offers 80–160 % in steps of 10', () => {
  expect(ZOOM_PRESETS).toEqual([80, 90, 100, 110, 120, 130, 140, 150, 160]);
  expect(clampZoom(40)).toBe(80);
  expect(clampZoom(400)).toBe(160);
  expect(clampZoom(114)).toBe(110);
  expect(clampZoom(Number.NaN)).toBe(100);
});

it('scales the type and the leading together', () => {
  expect(zoomedText(100, 1, 1.75)).toEqual({ fontSize: '1rem', lineHeight: '1.75rem' });
  expect(zoomedText(120, 1, 1.75)).toEqual({ fontSize: '1.2rem', lineHeight: '2.1rem' });
});

it('reads Ctrl (or ⌘) with +, − and 0, and nothing else', () => {
  expect(zoomKey(key('='))).toBe('in');
  expect(zoomKey(key('+', { ctrlKey: false, metaKey: true }))).toBe('in');
  expect(zoomKey(key('-'))).toBe('out');
  expect(zoomKey(key('x', { code: 'NumpadSubtract' }))).toBe('out');
  expect(zoomKey(key('0'))).toBe('reset');
  expect(zoomKey(key('=', { ctrlKey: false }))).toBeNull();
  expect(zoomKey(key('=', { altKey: true }))).toBeNull();
  expect(zoomKey(key('a'))).toBeNull();
  setEditorZoom(150);
  expect(applyZoomKey(key('='))).toBe(true);
  expect(applyZoomKey(key('='))).toBe(true);
  expect(getEditorZoom()).toBe(160);
  expect(applyZoomKey(key('0'))).toBe(true);
  expect(getEditorZoom()).toBe(100);
  expect(applyZoomKey(key('b'))).toBe(false);
});

it('keeps the zoom per viewer, and still works when storage is blocked', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const { result } = renderHook(() => useEditorZoom());
  act(() => result.current[1](130));
  expect(result.current[0]).toBe(130);
  expect(setItem).toHaveBeenLastCalledWith('voicestudio.editor-zoom', '130');
  setItem.mockImplementation(() => {
    throw new Error('blocked');
  });
  act(() => result.current[1](90));
  expect(result.current[0]).toBe(90);
});

it('zooms on Ctrl+wheel and the keys inside the editor, not the app', () => {
  const frame = document.createElement('div');
  const inside = document.createElement('textarea');
  frame.append(inside);
  document.body.append(frame);
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement }).current = frame;
  const { unmount } = renderHook(() => useEditorZoomInput(ref));
  const wheel = (deltaY: number, ctrlKey = true) => {
    const event = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true });
    inside.dispatchEvent(event);
    return event;
  };
  expect(wheel(-100).defaultPrevented).toBe(true);
  expect(getEditorZoom()).toBe(110);
  // Small pinch steps add up before they zoom.
  wheel(30);
  expect(getEditorZoom()).toBe(110);
  wheel(30);
  expect(getEditorZoom()).toBe(100);
  // A plain wheel scrolls.
  expect(wheel(-100, false).defaultPrevented).toBe(false);
  const press = new KeyboardEvent('keydown', { ...key('-'), bubbles: true, cancelable: true });
  act(() => void inside.dispatchEvent(press));
  expect(press.defaultPrevented).toBe(true);
  expect(getEditorZoom()).toBe(90);
  // Outside the editor the app keeps its own zoom keys.
  const outside = new KeyboardEvent('keydown', { ...key('-'), bubbles: true, cancelable: true });
  document.body.dispatchEvent(outside);
  expect(outside.defaultPrevented).toBe(false);
  unmount();
  frame.remove();
});

it("takes the zoom keys from the app's zoom while the editor has the focus or the pointer", () => {
  // The app's handler, as App mounts it: on the window, in the capture phase.
  const step = vi.fn();
  const appKeys = (event: KeyboardEvent) => void handleAppZoomKey(event, step);
  window.addEventListener('keydown', appKeys, true);
  const frame = document.createElement('div');
  const inside = document.createElement('textarea');
  frame.append(inside);
  const field = document.createElement('input');
  document.body.append(frame, field);
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement }).current = frame;
  const { unmount } = renderHook(() => useEditorZoomInput(ref));
  const press = (target: EventTarget, k: string, extra: Partial<KeyboardEventInit> = {}) => {
    const init = { ...key(k), ...extra, bubbles: true, cancelable: true };
    const event = new KeyboardEvent('keydown', init);
    act(() => void target.dispatchEvent(event));
    return event;
  };
  try {
    // Typing in the script: Ctrl −, Ctrl = (by key position too) and Ctrl 0 size its text.
    expect(press(inside, '-', { code: 'Minus' }).defaultPrevented).toBe(true);
    expect(getEditorZoom()).toBe(90);
    press(inside, '=', { code: 'Equal' });
    press(inside, '+', { code: 'Equal', shiftKey: true });
    expect(getEditorZoom()).toBe(110);
    press(inside, '0', { code: 'Digit0' });
    expect(getEditorZoom()).toBe(100);
    expect(step).not.toHaveBeenCalled();
    // The pointer over the editor, the focus nowhere in particular.
    frame.dispatchEvent(new Event('pointerenter'));
    press(document.body, '-', { code: 'Minus' });
    expect(getEditorZoom()).toBe(90);
    expect(step).not.toHaveBeenCalled();
    // Another field has the focus: the app zooms, the editor stays.
    press(field, '-', { code: 'Minus' });
    expect(step).toHaveBeenLastCalledWith(-1);
    frame.dispatchEvent(new Event('pointerleave'));
    press(document.body, '0', { code: 'Digit0' });
    expect(step).toHaveBeenLastCalledWith(0);
    expect(getEditorZoom()).toBe(90);
    // Gone: the app has its keys everywhere again.
    unmount();
    press(inside, '=', { code: 'Equal' });
    expect(step).toHaveBeenLastCalledWith(1);
    expect(getEditorZoom()).toBe(90);
  } finally {
    window.removeEventListener('keydown', appKeys, true);
    frame.remove();
    field.remove();
  }
});
