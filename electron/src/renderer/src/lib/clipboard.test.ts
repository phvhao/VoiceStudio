import { afterEach, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({
  bridge: null as null | { clipboard: { readText: () => Promise<string> } },
}));
vi.mock('@/components/bridge', () => ({ getBridge: () => desktop.bridge }));

import { readClipboardText } from './clipboard';

function stubClipboard(readText?: () => Promise<string>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: readText ? { readText } : undefined,
  });
}

afterEach(() => {
  desktop.bridge = null;
  stubClipboard();
});

it("reads the page's Clipboard API first", async () => {
  const shell = vi.fn(async () => 'from the shell');
  desktop.bridge = { clipboard: { readText: shell } };
  stubClipboard(async () => 'from the page');
  await expect(readClipboardText()).resolves.toBe('from the page');
  expect(shell).not.toHaveBeenCalled();
});

it('falls back to the desktop shell when the page is refused or has no Clipboard API', async () => {
  desktop.bridge = { clipboard: { readText: async () => 'https://youtu.be/abc' } };
  stubClipboard(async () => {
    throw new DOMException('Read permission denied.', 'NotAllowedError');
  });
  await expect(readClipboardText()).resolves.toBe('https://youtu.be/abc');
  stubClipboard();
  await expect(readClipboardText()).resolves.toBe('https://youtu.be/abc');
});

it("rethrows the page's refusal outside the desktop app", async () => {
  stubClipboard(async () => {
    throw new DOMException('Read permission denied.', 'NotAllowedError');
  });
  await expect(readClipboardText()).rejects.toMatchObject({ name: 'NotAllowedError' });
  stubClipboard();
  await expect(readClipboardText()).rejects.toThrow('Clipboard unavailable');
});
