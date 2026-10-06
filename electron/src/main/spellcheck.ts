import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type Session } from 'electron';
import { isTrustedRenderer } from './trusted-renderer';
import type { SpellcheckState } from '../preload/index.d';

export const SPELLCHECK_CHANNELS = { setEnabled: 'spellcheck:setEnabled' } as const;

/** Where Chromium keeps Hunspell dictionaries (`.bdic`) for a profile. */
export function dictionaryDirectory(userData: string): string {
  return join(userData, 'Dictionaries');
}

/**
 * Never fetch a dictionary. Off macOS, Chromium's Hunspell checker downloads
 * the dictionary of every language it is set to from Google on first use — a
 * network call nobody agreed to. Pointing the downloader at the local
 * dictionary folder leaves only the files already there, on every platform
 * (macOS uses its own checker and ignores this).
 */
export function preventDictionaryDownloads(session: Session, userData: string): void {
  session.setSpellCheckerDictionaryDownloadURL(
    `${pathToFileURL(dictionaryDirectory(userData)).href}/`,
  );
}

/**
 * The languages scripts are checked in: Vietnamese and English, as the build
 * names them (`vi`, `en-US`…). A code missing from `available` would throw.
 */
export function scriptSpellcheckLanguages(available: readonly string[]): string[] {
  const find = (...codes: string[]) =>
    codes.map((code) => available.find((item) => item.toLowerCase() === code)).find(Boolean);
  const english = find('en-us', 'en-gb', 'en') ?? available.find((item) => /^en(-|$)/i.test(item));
  return [find('vi', 'vi-vn'), english].filter((code): code is string => Boolean(code));
}

/** Whether a Hunspell dictionary for `language` is on disk (`vi-VN-3-0.bdic` serves `vi`). */
export function hasLocalDictionary(files: readonly string[], language: string): boolean {
  const prefix = language.toLowerCase() + '-';
  return files.some((file) => {
    const name = file.toLowerCase();
    return name.endsWith('.bdic') && name.startsWith(prefix);
  });
}

function listDictionaries(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Settings → Spellcheck while writing. On, the session checks Vietnamese and
 * English (macOS's own checker picks its languages itself); off, it goes back
 * to the languages it started with. Windows and macOS check with the system's
 * checker, offline; Linux only has the dictionaries already in the profile.
 */
export function registerSpellcheck(
  session: Session,
  getMainWindow: () => BrowserWindow | null,
  { platform = process.platform, userData }: { platform?: NodeJS.Platform; userData: string },
): void {
  const defaults = session.getSpellCheckerLanguages();
  const trusted = (event: IpcMainInvokeEvent) => {
    const owner = getMainWindow();
    if (
      !owner ||
      event.sender !== owner.webContents ||
      event.senderFrame !== owner.webContents.mainFrame ||
      !isTrustedRenderer(event.senderFrame.url, process.env.ELECTRON_RENDERER_URL)
    )
      throw new Error('Untrusted spellcheck request');
  };
  ipcMain.handle(SPELLCHECK_CHANNELS.setEnabled, (event, enabled: unknown): SpellcheckState => {
    trusted(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid spellcheck request');
    if (!enabled) {
      session.setSpellCheckerLanguages(defaults);
      return { languages: [], available: true };
    }
    const languages = scriptSpellcheckLanguages(session.availableSpellCheckerLanguages);
    if (platform !== 'darwin' && languages.length) session.setSpellCheckerLanguages(languages);
    const files = platform === 'linux' ? listDictionaries(dictionaryDirectory(userData)) : [];
    return {
      languages,
      available:
        platform !== 'linux' || languages.some((language) => hasLocalDictionary(files, language)),
    };
  });
}
