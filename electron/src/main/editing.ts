import {
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  type ContextMenuParams,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { isTrustedRenderer } from './trusted-renderer';
import type { EditMenuLabels } from '../preload/index.d';

export const EDITING_CHANNELS = {
  labels: 'edit-menu:labels',
  readClipboard: 'clipboard:readText',
} as const;

/** English until the renderer sends the labels of the app's language. */
export const DEFAULT_EDIT_MENU_LABELS: EditMenuLabels = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  addToDictionary: 'Add to dictionary',
  noSuggestions: 'No spelling suggestions',
};

const LABEL_KEYS = Object.keys(DEFAULT_EDIT_MENU_LABELS) as Array<keyof EditMenuLabels>;
const MAX_SUGGESTIONS = 5;

/** The parts of Chromium's right-click description the edit menu reads. */
export type EditMenuParams = Pick<
  ContextMenuParams,
  | 'isEditable'
  | 'selectionText'
  | 'editFlags'
  | 'misspelledWord'
  | 'dictionarySuggestions'
  | 'spellcheckEnabled'
>;

/** What the menu's items do, on the web contents that was right-clicked. */
export interface EditMenuActions {
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  replaceMisspelling(word: string): void;
  /** Absent where the session cannot keep words (an in-memory session). */
  addToDictionary?(word: string): void;
}

/**
 * The native menu for a right-click Chromium left to the app: in a text field,
 * the dictionary's suggestions (when the field is spellchecked and the word is
 * misspelled) above Undo, Redo, Cut, Copy, Paste and Select all, each enabled
 * as the field allows; on selected text elsewhere, Copy. Nothing otherwise.
 * Windows and Linux show each item's shortcut, as their menus do; macOS
 * context menus do not.
 */
export function editMenuTemplate(
  params: EditMenuParams,
  labels: EditMenuLabels,
  actions: EditMenuActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const shortcut = (accelerator: string) =>
    platform === 'darwin' ? {} : { accelerator, registerAccelerator: false };
  const flags = params.editFlags;
  if (!params.isEditable) {
    if (!params.selectionText.trim()) return [];
    return [
      {
        label: labels.copy,
        ...shortcut('CmdOrCtrl+C'),
        enabled: flags.canCopy,
        click: actions.copy,
      },
    ];
  }
  const items: MenuItemConstructorOptions[] = [];
  const word = params.misspelledWord;
  if (params.spellcheckEnabled && word) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    }
    if (!suggestions.length) items.push({ label: labels.noSuggestions, enabled: false });
    const add = actions.addToDictionary;
    if (add) items.push({ label: labels.addToDictionary, click: () => add(word) });
    items.push({ type: 'separator' });
  }
  items.push(
    { label: labels.undo, ...shortcut('CmdOrCtrl+Z'), enabled: flags.canUndo, click: actions.undo },
    {
      label: labels.redo,
      ...shortcut(platform === 'win32' ? 'Ctrl+Y' : 'Shift+CmdOrCtrl+Z'),
      enabled: flags.canRedo,
      click: actions.redo,
    },
    { type: 'separator' },
    { label: labels.cut, ...shortcut('CmdOrCtrl+X'), enabled: flags.canCut, click: actions.cut },
    { label: labels.copy, ...shortcut('CmdOrCtrl+C'), enabled: flags.canCopy, click: actions.copy },
    {
      label: labels.paste,
      ...shortcut('CmdOrCtrl+V'),
      enabled: flags.canPaste,
      click: actions.paste,
    },
    { type: 'separator' },
    {
      label: labels.selectAll,
      ...shortcut('CmdOrCtrl+A'),
      enabled: flags.canSelectAll,
      click: actions.selectAll,
    },
  );
  return items;
}

function editActions(contents: WebContents): EditMenuActions {
  // An item can be chosen after its page went away: act only on live contents.
  const live = () => (contents.isDestroyed() ? null : contents);
  return {
    undo: () => live()?.undo(),
    redo: () => live()?.redo(),
    cut: () => live()?.cut(),
    copy: () => live()?.copy(),
    paste: () => live()?.paste(),
    selectAll: () => live()?.selectAll(),
    replaceMisspelling: (word) => live()?.replaceMisspelling(word),
    ...(contents.session.isPersistent()
      ? {
          addToDictionary: (word: string) =>
            void live()?.session.addWordToSpellCheckerDictionary(word),
        }
      : {}),
  };
}

/**
 * Give `contents` the native edit menu. A page that shows a menu of its own
 * (the script editors) cancels the `contextmenu` event, and Chromium then
 * never asks for this one.
 */
export function attachEditContextMenu(
  contents: WebContents,
  labels: () => EditMenuLabels,
  platform: NodeJS.Platform = process.platform,
): void {
  contents.on('context-menu', (_event, params) => {
    const template = editMenuTemplate(params, labels(), editActions(contents), platform);
    if (!template.length) return;
    const window = BrowserWindow.fromWebContents(contents);
    // A menu opened from the keyboard (Shift+F10, the Menu key) belongs at the
    // field, not at the mouse; the point is relative to the window's own page.
    const atField =
      params.menuSourceType === 'keyboard' && window?.webContents === contents
        ? { x: Math.round(params.x), y: Math.round(params.y) }
        : {};
    Menu.buildFromTemplate(template).popup({
      ...(window ? { window } : {}),
      ...(params.frame ? { frame: params.frame } : {}),
      ...atField,
      sourceType: params.menuSourceType,
    });
  });
}

function parseLabels(raw: unknown): EditMenuLabels {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid labels');
  const input = raw as Record<string, unknown>;
  const labels = {} as EditMenuLabels;
  for (const key of LABEL_KEYS) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 120)
      throw new Error('Invalid labels');
    labels[key] = value;
  }
  return labels;
}

/**
 * Editing affordances for every window: the native edit menu, labelled in the
 * app's language once the renderer sends it (English before), and the
 * clipboard read a Paste button falls back to when the page's Clipboard API is
 * refused. Returns the labels for `attachEditContextMenu`.
 */
export function registerEditing(getMainWindow: () => BrowserWindow | null): () => EditMenuLabels {
  let labels = DEFAULT_EDIT_MENU_LABELS;
  const trusted = (event: IpcMainInvokeEvent) => {
    const owner = getMainWindow();
    if (
      !owner ||
      event.sender !== owner.webContents ||
      event.senderFrame !== owner.webContents.mainFrame ||
      !isTrustedRenderer(event.senderFrame.url, process.env.ELECTRON_RENDERER_URL)
    )
      throw new Error('Untrusted editing request');
  };
  ipcMain.handle(EDITING_CHANNELS.labels, (event, raw: unknown) => {
    trusted(event);
    labels = parseLabels(raw);
  });
  ipcMain.handle(EDITING_CHANNELS.readClipboard, (event): Promise<string> => {
    trusted(event);
    return clipboard.readText();
  });
  return () => labels;
}
