import { useSyncExternalStore } from 'react';
import { claimPlayback } from '@/lib/audio/playback';

/**
 * Quick listening for long lists (saved voices, takes): one shared `<audio>`
 * plays one clip at a time, so a list of hundreds mounts no player per row.
 * It joins the app-wide single-playback slot: starting it stops any other
 * player, and any other player stops it.
 */
export type AuditionStatus = 'idle' | 'loading' | 'playing' | 'failed';

let audio: HTMLAudioElement | null = null;
let current: { key: string; status: AuditionStatus } | null = null;
let release: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: typeof current) {
  current = next;
  for (const listener of listeners) listener();
}

function player(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.addEventListener('ended', () => stopAudition());
  audio.addEventListener('error', () => {
    // A clip that cannot load: say so on its button, and free the slot.
    if (!current || current.status === 'failed' || !audio?.getAttribute('src')) return;
    const key = current.key;
    stopAudition();
    publish({ key, status: 'failed' });
  });
  return audio;
}

/** Stop the clip being auditioned, if any. */
export function stopAudition() {
  release?.();
  release = null;
  if (audio?.getAttribute('src')) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  if (current) publish(null);
}

/** Play `src` for `key`, or stop it when `key` is the clip already playing. */
export async function toggleAudition(key: string, src: string): Promise<void> {
  if (current?.key === key && current.status !== 'failed') {
    stopAudition();
    return;
  }
  stopAudition();
  const element = player();
  release = claimPlayback(stopAudition, `audition:${key}`);
  publish({ key, status: 'loading' });
  element.src = src;
  try {
    await element.play();
    if (current?.key === key) publish({ key, status: 'playing' });
  } catch (error) {
    // Stopped or replaced while it started: not a failure.
    if (current?.key !== key || (error instanceof DOMException && error.name === 'AbortError'))
      return;
    stopAudition();
    publish({ key, status: 'failed' });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What the shared audition is doing for `key`. */
export function useAudition(key: string): AuditionStatus {
  return useSyncExternalStore(
    subscribe,
    () => (current?.key === key ? current.status : 'idle'),
    () => 'idle',
  );
}
