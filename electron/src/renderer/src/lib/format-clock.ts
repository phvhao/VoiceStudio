/**
 * `m:ss` for a media position or length in seconds; anything unknown or
 * negative reads `0:00`. Kept out of the player modules so a list that only
 * shows durations does not load a player to format them.
 */
export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return Math.floor(safe / 60) + ':' + String(Math.floor(safe % 60)).padStart(2, '0');
}
