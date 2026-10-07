import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activePlaybackSource, claimPlayback } from '@/lib/audio/playback';
import { stopAudition, toggleAudition, useAudition } from './audition';

const players: HTMLMediaElement[] = [];
let play: ReturnType<typeof vi.fn>;

beforeEach(() => {
  players.length = 0;
  play = vi.fn(function (this: HTMLMediaElement) {
    players.push(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play as never);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  stopAudition();
  vi.restoreAllMocks();
});

it('plays one clip at a time through one shared element', async () => {
  const a = renderHook(() => useAudition('voice:a'));
  const b = renderHook(() => useAudition('voice:b'));
  await act(() => toggleAudition('voice:a', '/a.wav'));
  expect(a.result.current).toBe('playing');
  await act(() => toggleAudition('voice:b', '/b.wav'));
  expect(a.result.current).toBe('idle');
  expect(b.result.current).toBe('playing');
  expect(players).toHaveLength(2);
  expect(players[0]).toBe(players[1]);
  expect(players[1].getAttribute('src')).toBe('/b.wav');
  // Its own button again stops it.
  await act(() => toggleAudition('voice:b', '/b.wav'));
  expect(b.result.current).toBe('idle');
  expect(players[1].hasAttribute('src')).toBe(false);
});

it('shares the app-wide playback slot with every other player', async () => {
  const otherStop = vi.fn();
  claimPlayback(otherStop, 'output');
  const a = renderHook(() => useAudition('take:1'));
  await act(() => toggleAudition('take:1', '/1.wav'));
  expect(otherStop).toHaveBeenCalled();
  expect(activePlaybackSource()).toBe('audition:take:1');
  act(() => void claimPlayback(() => {}, 'output'));
  expect(a.result.current).toBe('idle');
});

it('says when a clip cannot play, and tries again on the next press', async () => {
  const a = renderHook(() => useAudition('voice:a'));
  play.mockImplementationOnce(() => Promise.reject(new DOMException('no', 'NotSupportedError')));
  await act(() => toggleAudition('voice:a', '/missing.wav'));
  expect(a.result.current).toBe('failed');
  await act(() => toggleAudition('voice:a', '/a.wav'));
  expect(a.result.current).toBe('playing');
});

it('does not call a clip stopped while it started a failure', async () => {
  const a = renderHook(() => useAudition('voice:a'));
  let reject: (error: unknown) => void = () => {};
  play.mockImplementationOnce(() => new Promise((_, fail) => (reject = fail)));
  let started: Promise<void> = Promise.resolve();
  act(() => {
    started = toggleAudition('voice:a', '/a.wav');
  });
  expect(a.result.current).toBe('loading');
  act(() => stopAudition());
  reject(new DOMException('interrupted', 'AbortError'));
  await act(() => started);
  expect(a.result.current).toBe('idle');
});
