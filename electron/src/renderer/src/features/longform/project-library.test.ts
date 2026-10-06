import { expect, it } from 'vitest';
import { createProjectLibrary, LIBRARY_VERSION } from './project-library';
import { blankLongformDraft } from './longform-session';
import type { LongformKeyedStore } from '@shared/utils/indexedDbLongformStore';

/** The IndexedDB object store in memory: records by key, commits all-or-nothing. */
function memoryStore(initial: Record<string, unknown> = {}) {
  const records = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  const calls: string[] = [];
  let failNext: Error | null = null;
  const store: LongformKeyedStore = {
    entries: async (prefix) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, structuredClone(value)]),
    get: async (key) => structuredClone(records.get(key)),
    commit: async ({ put = [], remove = [] }) => {
      calls.push('commit');
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      for (const key of remove) records.delete(key);
      for (const [key, value] of put) records.set(key, structuredClone(value));
    },
    clearAll: async () => {
      calls.push('clear');
      records.clear();
    },
  };
  return { store, records, calls, fail: (error: Error) => (failNext = error) };
}

const draftWith = (script: string) => ({ ...blankLongformDraft(), script });

it('creates, lists newest first, saves, renames, duplicates and removes projects', async () => {
  const { store } = memoryStore();
  const library = createProjectLibrary(store);
  const draft = draftWith('# One\nHello there.');
  const first = library.create('audiobook', draft, 'First');
  draft.script = 'Edited after the call';
  const second = library.create('stories', blankLongformDraft(), 'Second');
  const [a, b] = await Promise.all([first, second]);
  // Snapshots the draft at the call, not when the write runs.
  expect((await library.get(a.id))?.draft.script).toBe('# One\nHello there.');
  expect((await library.get(a.id))?.draft.projectId).toBe(a.id);
  expect(a).toMatchObject({ mode: 'audiobook', words: 2, chapters: 1, output: '' });
  expect((await library.list()).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());

  const saved = await library.save(a.id, { ...draftWith('New words here'), output: 'book.m4b' });
  expect(saved).toMatchObject({ words: 3, output: 'book.m4b', outputs: ['book.m4b'] });
  expect((await library.list())[0].id).toBe(a.id);
  await library.save(a.id, { ...draftWith('x'), output: 'book2.m4b' });
  expect((await library.list())[0].outputs).toEqual(['book.m4b', 'book2.m4b']);

  await library.rename(a.id, ' Renamed ');
  await expect(library.rename(a.id, '  ')).rejects.toThrow('required');
  const copy = await library.duplicate(a.id, 'Copy');
  expect(copy).toMatchObject({ name: 'Copy', mode: 'audiobook', outputs: ['book2.m4b'] });
  expect((await library.get(copy.id))?.draft).toMatchObject({ script: 'x', projectId: copy.id });

  await library.remove(a.id);
  expect(await library.get(a.id)).toBeNull();
  await expect(library.save(a.id, draftWith('gone'))).rejects.toThrow('no longer exists');
  expect((await library.list()).map((p) => p.name).sort()).toEqual(['Copy', 'Second']);
});

it('a project named after its book follows the title until it is renamed', async () => {
  const library = createProjectLibrary(memoryStore().store);
  const project = await library.create('audiobook', draftWith('Hi'), 'Untitled book 1', {
    autoName: true,
  });
  expect((await library.save(project.id, { ...draftWith('Hi'), title: 'Dế Mèn' })).name).toBe(
    'Dế Mèn',
  );
  await library.rename(project.id, 'My name');
  expect((await library.save(project.id, { ...draftWith('Hi'), title: 'Other' })).name).toBe(
    'My name',
  );
});

it('does not report a successful save when durable storage fails', async () => {
  const memory = memoryStore();
  const library = createProjectLibrary(memory.store);
  memory.fail(new Error('Disk full'));
  await expect(library.create('audiobook', blankLongformDraft(), 'Book')).rejects.toThrow(
    'Disk full',
  );
  expect(await library.list()).toEqual([]);
});

it('serializes saves and renames so neither overwrites the other', async () => {
  const library = createProjectLibrary(memoryStore().store);
  const original = await library.create('stories', blankLongformDraft(), 'Original');
  const save = library.save(original.id, draftWith('New edit'));
  const rename = library.rename(original.id, 'Renamed');
  await Promise.all([save, rename]);
  expect((await library.list())[0].name).toBe('Renamed');
  expect((await library.get(original.id))?.draft.script).toBe('New edit');
});

it('clears every record after the writes already queued', async () => {
  const memory = memoryStore();
  const library = createProjectLibrary(memory.store);
  const save = library.create('stories', blankLongformDraft(), 'Disposable');
  const clear = library.clear();
  await Promise.all([save, clear]);
  expect(memory.calls).toEqual(['commit', 'clear']);
  expect(await library.list()).toEqual([]);
  expect(memory.records.size).toBe(0);
});

it('one unreadable project never hides or wipes the others', async () => {
  const memory = memoryStore();
  const library = createProjectLibrary(memory.store);
  const good = await library.create('audiobook', draftWith('Kept'), 'Good');
  const broken = await library.create('audiobook', draftWith('Lost'), 'Broken');
  memory.records.set('meta:' + broken.id, { id: broken.id, name: 42 });
  memory.records.set('meta:junk', 'not an object');
  memory.records.set('draft:' + good.id + 'x', null);
  expect((await library.list()).map((p) => p.id)).toEqual([good.id]);
  // Writing another project leaves the unreadable record as it was.
  await library.save(good.id, draftWith('Still kept'));
  expect(memory.records.get('meta:' + broken.id)).toEqual({ id: broken.id, name: 42 });
  // A readable entry whose draft is corrupt says so instead of opening empty.
  memory.records.set('draft:' + good.id, { version: LIBRARY_VERSION, draft: { script: 1 } });
  await expect(library.get(good.id)).rejects.toThrow('could not be read');
});

it('moves a version 1 library into records of its own, once, keeping unreadable entries', async () => {
  // The shape every build before the library stored: all projects in one record.
  const legacyDraft = { ...blankLongformDraft(), script: '# Chương 1\nXin chào.', projectId: 'p1' };
  const memory = memoryStore({
    workspace: {
      schema: 1,
      payload: {
        projects: [
          { id: 'p1', name: 'Sách cũ', mode: 'audiobook', updatedAt: 1000, draft: legacyDraft },
          {
            id: 'p2',
            name: 'Story',
            mode: 'stories',
            updatedAt: 2000,
            draft: { script: '', lines: [] },
          },
          { id: 'p3', name: 'Broken', mode: 'audiobook', draft: { lines: [] } },
          null,
        ],
      },
    },
  });
  const library = createProjectLibrary(memory.store);
  expect(await library.list()).toMatchObject([
    { id: 'p2', name: 'Story', mode: 'stories', updatedAt: 2000 },
    { id: 'p1', name: 'Sách cũ', mode: 'audiobook', updatedAt: 1000, words: 2, chapters: 1 },
  ]);
  expect((await library.get('p1'))?.draft.script).toBe('# Chương 1\nXin chào.');
  expect(memory.records.get('workspace')).toEqual({
    schema: 1,
    payload: {
      projects: [],
      version: LIBRARY_VERSION,
      unreadable: [{ id: 'p3', name: 'Broken', mode: 'audiobook', draft: { lines: [] } }, null],
    },
  });
  // A second library over the same records migrates nothing twice.
  const commits = memory.calls.length;
  expect(await createProjectLibrary(memory.store).list()).toHaveLength(2);
  expect(memory.calls.length).toBe(commits);
});

it('a migration that fails is retried and loses nothing', async () => {
  const memory = memoryStore({
    workspace: {
      schema: 1,
      payload: {
        projects: [{ id: 'p1', name: 'Old', mode: 'audiobook', draft: draftWith('Text') }],
      },
    },
  });
  const library = createProjectLibrary(memory.store);
  memory.fail(new Error('Disk full'));
  await expect(library.list()).rejects.toThrow('Disk full');
  expect(
    (memory.records.get('workspace') as { payload: { projects: unknown[] } }).payload.projects,
  ).toHaveLength(1);
  expect((await library.list()).map((p) => p.name)).toEqual(['Old']);
});
