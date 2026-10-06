// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  exposed: new Map<string, any>(),
  invoke: vi.fn(async () => ({ languages: [], available: true })),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => electron.exposed.set(key, value),
  },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

import {
  SPELLCHECK_CHANNELS,
  hasLocalDictionary,
  preventDictionaryDownloads,
  registerSpellcheck,
  scriptSpellcheckLanguages,
} from './spellcheck';

const CHROMIUM_LANGUAGES = ['de-DE', 'en-AU', 'en-GB', 'en-US', 'fr-FR', 'vi'];

function fakeSession(available = CHROMIUM_LANGUAGES) {
  let languages = ['en-US'];
  return {
    availableSpellCheckerLanguages: available,
    getSpellCheckerLanguages: vi.fn(() => languages),
    setSpellCheckerLanguages: vi.fn((next: string[]) => {
      for (const code of next) if (!available.includes(code)) throw new Error('Invalid ' + code);
      languages = next;
    }),
    setSpellCheckerDictionaryDownloadURL: vi.fn(),
  };
}

const mainFrame = { url: 'app://voicestudio/index.html' };
const owner = { webContents: { mainFrame } };
const trusted = { sender: owner.webContents, senderFrame: mainFrame };

let userData: string;
beforeEach(async () => {
  electron.handlers.clear();
  userData = await mkdtemp(join(tmpdir(), 'voicestudio-spellcheck-'));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

function register(platform: NodeJS.Platform, session = fakeSession()) {
  registerSpellcheck(session as never, () => owner as never, { platform, userData });
  const setEnabled = (enabled: unknown, event: unknown = trusted) =>
    electron.handlers.get(SPELLCHECK_CHANNELS.setEnabled)!(event, enabled);
  return { session, setEnabled };
}

it('picks Vietnamese and one English variant the build knows', () => {
  expect(scriptSpellcheckLanguages(CHROMIUM_LANGUAGES)).toEqual(['vi', 'en-US']);
  expect(scriptSpellcheckLanguages(['vi-VN', 'en-GB', 'fr-FR'])).toEqual(['vi-VN', 'en-GB']);
  expect(scriptSpellcheckLanguages(['en-CA'])).toEqual(['en-CA']);
  expect(scriptSpellcheckLanguages([])).toEqual([]);
});

it('matches Chromium dictionary file names to their language', () => {
  expect(hasLocalDictionary(['vi-VN-3-0.bdic'], 'vi')).toBe(true);
  expect(hasLocalDictionary(['en-US-10-1.bdic'], 'en-US')).toBe(true);
  expect(hasLocalDictionary(['en-GB-10-1.bdic', 'vi-VN-3-0.bdic.tmp'], 'en-US')).toBe(false);
  expect(hasLocalDictionary(['vi-VN-3-0.bdic.tmp'], 'vi')).toBe(false);
});

it('points dictionary downloads at the local profile folder, never the network', () => {
  const session = fakeSession();
  preventDictionaryDownloads(session as never, userData);
  const [url] = session.setSpellCheckerDictionaryDownloadURL.mock.calls[0];
  expect(url).toMatch(/^file:\/\/.*\/Dictionaries\/$/);
  expect(url).not.toMatch(/^https?:/);
});

it('checks Vietnamese and English while on and restores the starting languages when off', () => {
  const { session, setEnabled } = register('win32');
  expect(setEnabled(true)).toEqual({
    languages: ['vi', 'en-US'],
    available: true,
  });
  expect(session.setSpellCheckerLanguages).toHaveBeenLastCalledWith(['vi', 'en-US']);
  expect(setEnabled(false)).toEqual({ languages: [], available: true });
  expect(session.setSpellCheckerLanguages).toHaveBeenLastCalledWith(['en-US']);
});

it('leaves macOS to its own checker', () => {
  const { session, setEnabled } = register('darwin');
  expect(setEnabled(true)).toMatchObject({ available: true });
  expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled();
});

it('reports Linux without a local dictionary as unavailable, and available once one is there', async () => {
  const { setEnabled } = register('linux');
  expect(setEnabled(true)).toEqual({
    languages: ['vi', 'en-US'],
    available: false,
  });
  await mkdir(join(userData, 'Dictionaries'));
  await writeFile(join(userData, 'Dictionaries', 'vi-VN-3-0.bdic'), '');
  expect(setEnabled(true)).toMatchObject({ available: true });
});

it('rejects untrusted senders and malformed requests', () => {
  const { session, setEnabled } = register('win32');
  const foreign = { sender: {}, senderFrame: { url: 'https://example.com/' } };
  expect(() => setEnabled(true, foreign)).toThrow('Untrusted');
  expect(() => setEnabled('yes')).toThrow('Invalid');
  expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled();
});

it('exposes the same channel through the preload bridge', async () => {
  await import('../preload/index');
  const bridge = electron.exposed.get('voicestudio');
  await bridge.spellcheck.setEnabled(true);
  expect(electron.invoke).toHaveBeenCalledWith(SPELLCHECK_CHANNELS.setEnabled, true);
});
