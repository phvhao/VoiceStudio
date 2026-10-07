import { screen, type BrowserWindow } from 'electron';
import type { HistoryCommand } from '../preload/index.d';
import { sendToLiveWindow } from './window-safety';

export const HISTORY_CHANNEL = 'app:history';

/** `browser-backward` / `browser-forward` as a history direction; null for other app commands. */
export function historyDirection(command: string): HistoryCommand['direction'] | null {
  if (command === 'browser-backward') return 'back';
  if (command === 'browser-forward') return 'forward';
  return null;
}

/** Whether `point` (window content coordinates) lies on a visible view laid over the page. */
export function pointOverChildView(
  window: Pick<BrowserWindow, 'contentView'>,
  point: { x: number; y: number },
): boolean {
  return window.contentView.children.some((view) => {
    if (!view.getVisible()) return false;
    const bounds = view.getBounds();
    return (
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height
    );
  });
}

/**
 * Windows and Linux report a mouse's Back/Forward buttons (and a keyboard's
 * Back/Forward keys) as app commands: hand them to the app's history, with
 * when they happened. The renderer sees the same press as a pointer event too,
 * where the page has it, and pairs the two (see `history-navigation.ts`); over
 * a page embedded in it, the renderer leaves the press to Chromium. Over a
 * website shown inside the window (the site browser), the press is that
 * website's: Chromium already moves its own history.
 */
export function wireHistoryCommands(window: BrowserWindow): void {
  window.on('app-command', (_event, command) => {
    const direction = historyDirection(command);
    if (!direction) return;
    const cursor = screen.getCursorScreenPoint();
    const content = window.getContentBounds();
    if (pointOverChildView(window, { x: cursor.x - content.x, y: cursor.y - content.y })) return;
    const payload: HistoryCommand = { direction, at: Date.now() };
    sendToLiveWindow(window, HISTORY_CHANNEL, payload);
  });
}
