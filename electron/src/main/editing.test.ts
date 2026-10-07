// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  popup: vi.fn(),
  built: [] as unknown[],
  owner: null as unknown,
  readText: vi.fn(async () => 'https://youtu.be/abc'),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  Menu: {
    buildFromTemplate: (template: unknown) => {
      electron.built.push(template);
      return { popup: electron.popup };
    },
  },
  BrowserWindow: { fromWebContents: () => electron.owner },
  clipboard: { readText: electron.readText },
}));

import {
  attachEditContextMenu,
  DEFAULT_EDIT_MENU_LABELS,
  EDITING_CHANNELS,
  editMenuTemplate,
  registerEditing,
  type EditMenuActions,
  type EditMenuParams,
} from './editing';

const FLAGS = {
  canUndo: true,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
};

function params(patch: Partial<EditMenuParams> = {}): EditMenuParams {
  return {
    isEditable: true,
    selectionText: '',
    editFlags: FLAGS,
    misspelledWord: '',
    dictionarySuggestions: [],
    spellcheckEnabled: false,
    ...patch,
  };
}

function actions(): EditMenuActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    replaceMisspelling: vi.fn(),
    addToDictionary: vi.fn(),
  };
}

const labels = (template: Electron.MenuItemConstructorOptions[]) =>
  template.map((item) => (item.type === 'separator' ? '—' : item.label));

describe('edit menu template', () => {
  it('offers the editing commands in a field, enabled as the field allows', () => {
    const act = actions();
    const template = editMenuTemplate(params(), DEFAULT_EDIT_MENU_LABELS, act, 'win32');
    expect(labels(template)).toEqual([
      'Undo',
      'Redo',
      '—',
      'Cut',
      'Copy',
      'Paste',
      '—',
      'Select all',
    ]);
    const byLabel = Object.fromEntries(template.map((item) => [item.label, item]));
    expect(byLabel.Undo).toMatchObject({ enabled: true, accelerator: 'CmdOrCtrl+Z' });
    expect(byLabel.Redo).toMatchObject({ enabled: false, accelerator: 'Ctrl+Y' });
    expect(byLabel.Cut.enabled).toBe(false);
    expect(byLabel.Paste.enabled).toBe(true);
    (byLabel.Paste.click as () => void)();
    (byLabel['Select all'].click as () => void)();
    expect(act.paste).toHaveBeenCalledOnce();
    expect(act.selectAll).toHaveBeenCalledOnce();
  });

  it('shows shortcuts where the platform menus do, never registering them', () => {
    const linux = editMenuTemplate(params(), DEFAULT_EDIT_MENU_LABELS, actions(), 'linux');
    expect(linux.find((item) => item.label === 'Redo')).toMatchObject({
      accelerator: 'Shift+CmdOrCtrl+Z',
      registerAccelerator: false,
    });
    const mac = editMenuTemplate(params(), DEFAULT_EDIT_MENU_LABELS, actions(), 'darwin');
    expect(mac.every((item) => item.accelerator === undefined)).toBe(true);
    // Same commands on every platform.
    expect(labels(mac)).toEqual(labels(linux));
  });

  it('offers only Copy for selected text outside a field, and nothing without a selection', () => {
    const act = actions();
    const template = editMenuTemplate(
      params({
        isEditable: false,
        selectionText: 'Xin chào',
        editFlags: { ...FLAGS, canCopy: true },
      }),
      DEFAULT_EDIT_MENU_LABELS,
      act,
      'win32',
    );
    expect(labels(template)).toEqual(['Copy']);
    (template[0].click as () => void)();
    expect(act.copy).toHaveBeenCalledOnce();
    expect(editMenuTemplate(params({ isEditable: false }), DEFAULT_EDIT_MENU_LABELS, act)).toEqual(
      [],
    );
    expect(
      editMenuTemplate(
        params({ isEditable: false, selectionText: ' \n' }),
        DEFAULT_EDIT_MENU_LABELS,
        act,
      ),
    ).toEqual([]);
  });

  it('puts spelling suggestions and Add to dictionary first in a spellchecked field', () => {
    const act = actions();
    const template = editMenuTemplate(
      params({
        spellcheckEnabled: true,
        misspelledWord: 'chaò',
        dictionarySuggestions: ['chào', 'chao', 'cháo', 'chạo', 'chảo', 'chão'],
      }),
      DEFAULT_EDIT_MENU_LABELS,
      act,
      'win32',
    );
    expect(labels(template).slice(0, 7)).toEqual([
      'chào',
      'chao',
      'cháo',
      'chạo',
      'chảo',
      'Add to dictionary',
      '—',
    ]);
    (template[0].click as () => void)();
    (template[5].click as () => void)();
    expect(act.replaceMisspelling).toHaveBeenCalledWith('chào');
    expect(act.addToDictionary).toHaveBeenCalledWith('chaò');
  });

  it('says when the dictionary has nothing, and leaves fields without spellcheck alone', () => {
    const act = actions();
    const none = editMenuTemplate(
      params({ spellcheckEnabled: true, misspelledWord: 'xyzzy' }),
      DEFAULT_EDIT_MENU_LABELS,
      act,
    );
    expect(none[0]).toMatchObject({ label: 'No spelling suggestions', enabled: false });
    const off = editMenuTemplate(
      params({ spellcheckEnabled: false, misspelledWord: 'xyzzy', dictionarySuggestions: ['x'] }),
      DEFAULT_EDIT_MENU_LABELS,
      act,
    );
    expect(off[0].label).toBe('Undo');
    const { addToDictionary: _omit, ...withoutDictionary } = act;
    const memoryOnly = editMenuTemplate(
      params({ spellcheckEnabled: true, misspelledWord: 'xyzzy', dictionarySuggestions: ['x'] }),
      DEFAULT_EDIT_MENU_LABELS,
      withoutDictionary,
    );
    expect(labels(memoryOnly)).not.toContain('Add to dictionary');
  });

  it('uses the labels it is given', () => {
    const vi_ = {
      ...DEFAULT_EDIT_MENU_LABELS,
      undo: 'Hoàn tác',
      paste: 'Dán',
    };
    expect(labels(editMenuTemplate(params(), vi_, actions()))).toEqual(
      expect.arrayContaining(['Hoàn tác', 'Dán']),
    );
  });
});

function fakeContents({ persistent = true } = {}) {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    replaceMisspelling: vi.fn(),
    session: {
      isPersistent: () => persistent,
      addWordToSpellCheckerDictionary: vi.fn(() => true),
    },
  });
  return contents;
}

const contextMenu = (patch: Record<string, unknown> = {}) => ({
  ...params(),
  x: 40,
  y: 60,
  frame: null,
  menuSourceType: 'mouse',
  ...patch,
});

describe('attached edit menu', () => {
  beforeEach(() => {
    electron.popup.mockClear();
    electron.built.length = 0;
    electron.owner = null;
  });

  it('pops the menu up for a field and acts on the contents that was right-clicked', () => {
    const contents = fakeContents();
    const window = { webContents: contents };
    electron.owner = window;
    attachEditContextMenu(contents as never, () => DEFAULT_EDIT_MENU_LABELS, 'linux');
    contents.emit('context-menu', {}, contextMenu());
    expect(electron.popup).toHaveBeenCalledWith({ window, sourceType: 'mouse' });
    const template = electron.built[0] as Electron.MenuItemConstructorOptions[];
    (template.find((item) => item.label === 'Paste')!.click as () => void)();
    expect(contents.paste).toHaveBeenCalledOnce();
  });

  it('opens a keyboard-invoked menu at the field rather than the mouse', () => {
    const contents = fakeContents();
    const window = { webContents: contents };
    electron.owner = window;
    attachEditContextMenu(contents as never, () => DEFAULT_EDIT_MENU_LABELS, 'win32');
    contents.emit(
      'context-menu',
      {},
      contextMenu({ menuSourceType: 'keyboard', x: 12.4, y: 30.6 }),
    );
    expect(electron.popup).toHaveBeenCalledWith({
      window,
      x: 12,
      y: 31,
      sourceType: 'keyboard',
    });
  });

  it('shows nothing where there is nothing to edit or copy', () => {
    const contents = fakeContents();
    attachEditContextMenu(contents as never, () => DEFAULT_EDIT_MENU_LABELS);
    contents.emit('context-menu', {}, contextMenu({ isEditable: false }));
    expect(electron.popup).not.toHaveBeenCalled();
  });

  it('offers Add to dictionary only where the session keeps words, and never acts on closed contents', () => {
    const memory = fakeContents({ persistent: false });
    attachEditContextMenu(memory as never, () => DEFAULT_EDIT_MENU_LABELS);
    memory.emit(
      'context-menu',
      {},
      contextMenu({
        spellcheckEnabled: true,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the'],
      }),
    );
    expect(labels(electron.built[0] as never)).not.toContain('Add to dictionary');

    const kept = fakeContents();
    attachEditContextMenu(kept as never, () => DEFAULT_EDIT_MENU_LABELS);
    kept.emit(
      'context-menu',
      {},
      contextMenu({
        spellcheckEnabled: true,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the'],
      }),
    );
    const template = electron.built[1] as Electron.MenuItemConstructorOptions[];
    (template.find((item) => item.label === 'Add to dictionary')!.click as () => void)();
    expect(kept.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('teh');
    kept.isDestroyed.mockReturnValue(true);
    (template[0].click as () => void)();
    expect(kept.replaceMisspelling).not.toHaveBeenCalled();
  });
});

describe('editing IPC', () => {
  const mainFrame = { url: 'app://voicestudio/index.html' };
  const owner = { webContents: { mainFrame } };
  const trusted = { sender: owner.webContents, senderFrame: mainFrame };
  const foreign = { sender: {}, senderFrame: { url: 'https://example.com/' } };
  const translated = {
    undo: 'Hoàn tác',
    redo: 'Làm lại',
    cut: 'Cắt',
    copy: 'Sao chép',
    paste: 'Dán',
    selectAll: 'Chọn tất cả',
    addToDictionary: 'Thêm vào từ điển',
    noSuggestions: 'Không có gợi ý chính tả',
  };

  beforeEach(() => electron.handlers.clear());

  it('labels the menu in the language the renderer sends', () => {
    const current = registerEditing(() => owner as never);
    expect(current()).toEqual(DEFAULT_EDIT_MENU_LABELS);
    electron.handlers.get(EDITING_CHANNELS.labels)!(trusted, translated);
    expect(current()).toEqual(translated);
  });

  it('rejects labels from other pages and malformed labels', () => {
    const current = registerEditing(() => owner as never);
    const send = electron.handlers.get(EDITING_CHANNELS.labels)!;
    expect(() => send(foreign, translated)).toThrow('Untrusted');
    expect(() => send(trusted, { ...translated, paste: '' })).toThrow('Invalid');
    expect(() => send(trusted, { ...translated, undo: 'x'.repeat(121) })).toThrow('Invalid');
    expect(() => send(trusted, ['Undo'])).toThrow('Invalid');
    expect(current()).toEqual(DEFAULT_EDIT_MENU_LABELS);
  });

  it('reads the clipboard for the app page only', async () => {
    registerEditing(() => owner as never);
    const read = electron.handlers.get(EDITING_CHANNELS.readClipboard)!;
    await expect(read(trusted)).resolves.toBe('https://youtu.be/abc');
    expect(() => read(foreign)).toThrow('Untrusted');
  });
});
