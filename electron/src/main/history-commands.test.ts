// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ cursor: { x: 0, y: 0 } }));
vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => electron.cursor },
}));

import {
  HISTORY_CHANNEL,
  historyDirection,
  pointOverChildView,
  wireHistoryCommands,
} from './history-commands';

function view(bounds: { x: number; y: number; width: number; height: number }, visible = true) {
  return { getBounds: () => bounds, getVisible: () => visible };
}

function fakeWindow(children: ReturnType<typeof view>[] = []) {
  const send = vi.fn();
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send },
    getContentBounds: () => ({ x: 100, y: 50, width: 1280, height: 800 }),
    contentView: { children },
  });
  return { window, send };
}

beforeEach(() => {
  electron.cursor = { x: 0, y: 0 };
});

it('maps the browser app commands to history directions', () => {
  expect(historyDirection('browser-backward')).toBe('back');
  expect(historyDirection('browser-forward')).toBe('forward');
  expect(historyDirection('media-play-pause')).toBeNull();
});

it('finds visible views laid over the page', () => {
  const window = { contentView: { children: [view({ x: 300, y: 100, width: 400, height: 300 })] } };
  expect(pointOverChildView(window as never, { x: 310, y: 120 })).toBe(true);
  expect(pointOverChildView(window as never, { x: 700, y: 120 })).toBe(false);
  const hidden = {
    contentView: { children: [view({ x: 0, y: 0, width: 2000, height: 2000 }, false)] },
  };
  expect(pointOverChildView(hidden as never, { x: 10, y: 10 })).toBe(false);
});

it('hands Back/Forward app commands to the page with when they happened', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  const { window, send } = fakeWindow();
  wireHistoryCommands(window as never);
  window.emit('app-command', {}, 'browser-backward');
  window.emit('app-command', {}, 'browser-forward');
  window.emit('app-command', {}, 'volume-up');
  expect(send.mock.calls).toEqual([
    [HISTORY_CHANNEL, { direction: 'back', at: 1_700_000_000_000 }],
    [HISTORY_CHANNEL, { direction: 'forward', at: 1_700_000_000_000 }],
  ]);
  vi.restoreAllMocks();
});

it('leaves a press over an embedded website to that website', () => {
  const { window, send } = fakeWindow([view({ x: 300, y: 100, width: 400, height: 300 })]);
  wireHistoryCommands(window as never);
  // Content origin (100, 50): screen (450, 200) is (350, 150) in the window, on the view.
  electron.cursor = { x: 450, y: 200 };
  window.emit('app-command', {}, 'browser-backward');
  expect(send).not.toHaveBeenCalled();
  electron.cursor = { x: 150, y: 80 };
  window.emit('app-command', {}, 'browser-backward');
  expect(send).toHaveBeenCalledOnce();
});
