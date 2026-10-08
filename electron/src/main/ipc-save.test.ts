// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/** Both native save handlers, driven through the real registered IPC code. */
const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  savePath: '',
  failWrites: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  /** Simulate a disk that fills up halfway through any write. */
  const halfThenFail = async (
    write: (data: Uint8Array) => Promise<void>,
    data: string | Uint8Array | AsyncIterable<Uint8Array>,
  ) => {
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = Buffer.from(data);
    else if (data instanceof Uint8Array) bytes = data;
    else {
      const chunks: Uint8Array[] = [];
      for await (const chunk of data) chunks.push(chunk);
      bytes = Buffer.concat(chunks);
    }
    await write(bytes.subarray(0, bytes.length >> 1));
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  };
  return {
    ...actual,
    writeFile: (async (path: string, data: string | Uint8Array, options?: unknown) =>
      native.failWrites
        ? halfThenFail((bytes) => actual.writeFile(path, bytes), data)
        : actual.writeFile(path, data, options as never)) as typeof actual.writeFile,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = (async (data: string | Uint8Array, options?: unknown) =>
        native.failWrites
          ? halfThenFail((bytes) => write(bytes), data)
          : write(data, options as never)) as never;
      return handle;
    }) as typeof actual.open,
  };
});

const owner = vi.hoisted(() => {
  const mainFrame = { url: 'app://voicestudio/index.html' };
  const webContents = { mainFrame };
  return { webContents, isMaximized: () => false };
});

const fetchAudio = vi.hoisted(() => vi.fn());
const showSaveDialog = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), exit: vi.fn() },
  BrowserWindow: { fromWebContents: () => owner, getAllWindows: () => [] },
  dialog: { showSaveDialog },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) =>
      native.handlers.set(channel, handler),
    on: vi.fn(),
  },
  net: { fetch: fetchAudio },
  shell: {},
  systemPreferences: {},
}));
vi.mock('./site-browser', () => ({ registerSiteBrowser: vi.fn() }));

import { CHANNELS, registerIpc } from './ipc';
import type { BackendSupervisor } from './backend';
import { decodeDownloadFailure } from '../shared/download-failure';

let directory: string;
let closeSaves: () => Promise<void>;
const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'voicestudio-save-'));
  native.savePath = join(directory, 'take.wav');
  native.failWrites = false;
  native.handlers.clear();
  fetchAudio.mockReset();
  fetchAudio.mockImplementation(async () => new Response('replacement audio bytes'));
  showSaveDialog.mockReset();
  showSaveDialog.mockImplementation(async () => ({ canceled: false, filePath: native.savePath }));
  closeSaves = registerIpc(
    {
      subscribe: () => () => {},
      baseUrl: 'http://127.0.0.1:3900',
      requestHeaders: () => ({}),
    } as unknown as BackendSupervisor,
    () => owner as never,
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const saves = [
  [
    'backend downloads',
    CHANNELS.filesSaveAudio,
    () => ({ url: '/api/audio/take.wav', suggestedName: 'take.wav' }),
  ],
  [
    'local data',
    CHANNELS.filesSaveData,
    () => ({ data: new TextEncoder().encode('replacement data bytes'), suggestedName: 'take.wav' }),
  ],
] as const;

it.each(saves)(
  'keeps an existing export intact when saving %s fails',
  async (_, channel, request) => {
    await writeFile(native.savePath, 'complete previous export');
    native.failWrites = true;
    await expect(native.handlers.get(channel)!(event, request())).rejects.toThrow('no space');
    expect(await readFile(native.savePath, 'utf8')).toBe('complete previous export');
    expect(await readdir(directory)).toEqual(['take.wav']);
  },
);

it.each(saves)(
  'replaces an existing export when saving %s succeeds',
  async (_, channel, request) => {
    await writeFile(native.savePath, 'complete previous export that is longer');
    await expect(native.handlers.get(channel)!(event, request())).resolves.toEqual({
      canceled: false,
      path: native.savePath,
    });
    expect(await readFile(native.savePath, 'utf8')).toMatch(/^replacement (audio|data) bytes$/);
    expect(await readdir(directory)).toEqual(['take.wav']);
  },
);

const saveDownload = () =>
  native.handlers.get(CHANNELS.filesSaveAudio)!(event, {
    url: '/api/audio/book.m4b',
    suggestedName: 'take.wav',
  });

/** Bytes of the hidden partial file the save is writing, once it has `size` of them. */
async function partialWith(size: number): Promise<string | null> {
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.partial')) continue;
      const path = join(directory, name);
      if ((await stat(path).catch(() => null))?.size === size) return path;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

/** A download that sends `first`, then whatever `rest` decides once the save has written it. */
function download(
  first: Uint8Array,
  rest: (controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void>,
) {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(first);
          return;
        }
        await rest(controller);
      },
    }),
  );
}

it('writes a download to disk as it arrives instead of holding it in memory', async () => {
  const first = new Uint8Array(64 * 1024).fill(1);
  const second = new Uint8Array(64 * 1024).fill(2);
  fetchAudio.mockImplementation(async () =>
    download(first, async (controller) => {
      // A save that buffers the whole response never writes before this point.
      if (!(await partialWith(first.length))) {
        controller.error(new Error('nothing was written before the download finished'));
        return;
      }
      controller.enqueue(second);
      controller.close();
    }),
  );
  await expect(saveDownload()).resolves.toEqual({ canceled: false, path: native.savePath });
  expect(await readFile(native.savePath)).toEqual(Buffer.concat([first, second]));
  expect(await readdir(directory)).toEqual(['take.wav']);
});

it('keeps an existing export intact when the download breaks off', async () => {
  await writeFile(native.savePath, 'complete previous export');
  fetchAudio.mockImplementation(async () =>
    download(new Uint8Array(1024).fill(1), async (controller) => {
      await partialWith(1024);
      controller.error(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    }),
  );
  await expect(saveDownload()).rejects.toThrow('connection reset');
  expect(await readFile(native.savePath, 'utf8')).toBe('complete previous export');
  expect(await readdir(directory)).toEqual(['take.wav']);
});

it('abandons a save still downloading when the app quits, leaving no partial file', async () => {
  await writeFile(native.savePath, 'complete previous export');
  let reachedDisk!: () => void;
  const writing = new Promise<void>((resolve) => (reachedDisk = resolve));
  fetchAudio.mockImplementation(async (_url: string, init: RequestInit) =>
    download(new Uint8Array(1024).fill(1), async (controller) => {
      await partialWith(1024);
      reachedDisk();
      // Like the network: nothing more arrives until the request is aborted.
      await new Promise((resolve) => init.signal!.addEventListener('abort', resolve));
      controller.error(init.signal!.reason);
    }),
  );
  const saving = saveDownload();
  saving.catch(() => {});
  await writing;
  await closeSaves();
  await expect(saving).rejects.toThrow();
  expect(await readFile(native.savePath, 'utf8')).toBe('complete previous export');
  expect(await readdir(directory)).toEqual(['take.wav']);
});

it('starts no download once the app is quitting', async () => {
  let pick!: (result: { canceled: boolean; filePath: string }) => void;
  showSaveDialog.mockImplementation(() => new Promise((resolve) => (pick = resolve)));
  const saving = saveDownload();
  await vi.waitFor(() => expect(showSaveDialog).toHaveBeenCalled());
  await closeSaves();
  pick({ canceled: false, filePath: native.savePath });
  await expect(saving).resolves.toEqual({ canceled: true });
  expect(fetchAudio).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it('carries the backend error body when a backend download fails (#2616)', async () => {
  const detail = {
    code: 'dub_background_unavailable',
    message: 'Separated background is incomplete',
  };
  fetchAudio.mockResolvedValueOnce(
    new Response(JSON.stringify({ detail }), { status: 409, statusText: 'Conflict' }),
  );
  await writeFile(native.savePath, 'complete previous export');
  const error = await native.handlers.get(CHANNELS.filesSaveAudio)!(event, {
    url: '/api/dub/export/x',
    suggestedName: 'take.wav',
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/^Could not download the file \(HTTP 409\)/);
  expect(decodeDownloadFailure(error)).toEqual({
    status: 409,
    statusText: 'Conflict',
    body: JSON.stringify({ detail }),
  });
  expect(await readFile(native.savePath, 'utf8')).toBe('complete previous export');
});
