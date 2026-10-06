import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

// A player whose clock the test moves: `subscribe` reruns its callback on
// every tick, as Vidstack's state effects do each animation frame.
const player = vi.hoisted(() => {
  const callbacks = new Set<(state: { currentTime: number }) => void>();
  const state = { currentTime: 0 };
  return {
    state,
    callbacks,
    tick(time: number) {
      state.currentTime = time;
      for (const callback of callbacks) callback(state);
    },
    instance: {
      get currentTime() {
        return state.currentTime;
      },
      subscribe(callback: (value: { currentTime: number }) => void) {
        callbacks.add(callback);
        callback(state);
        return () => void callbacks.delete(callback);
      },
    },
  };
});

vi.mock('@vidstack/react', async (original) => ({
  ...(await original<typeof import('@vidstack/react')>()),
  useMediaPlayer: () => player.instance,
}));

import { useMediaTime } from './media-player';

it('re-renders only when the selected part of the clock changes', () => {
  let renders = 0;
  function Clock() {
    renders++;
    return <span>{useMediaTime((time) => Math.floor(time))}</span>;
  }
  const { unmount } = render(<Clock />);
  expect(screen.getByText('0')).toBeInTheDocument();
  const before = renders;

  for (const time of [0.1, 0.4, 0.8, 0.99]) act(() => player.tick(time));
  expect(renders).toBe(before);

  act(() => player.tick(1.2));
  expect(screen.getByText('1')).toBeInTheDocument();
  expect(renders).toBe(before + 1);

  unmount();
  expect(player.callbacks.size).toBe(0);
});
