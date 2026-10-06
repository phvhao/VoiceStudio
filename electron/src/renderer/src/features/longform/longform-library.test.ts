import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';
import type { LongformKeyedStore } from '@shared/utils/indexedDbLongformStore';

// The library over an in-memory object store, and the network stubbed: the
// session's auto-save, switching and render paths run for real.
const h = vi.hoisted(() => {
  const records = new Map<string, unknown>();
  const state = { commits: 0, fail: null as Error | null };
  const store = {
    entries: async (prefix: string) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)]),
    get: async (key: string) => structuredClone(records.get(key)),
    commit: async ({ put = [], remove = [] }: { put?: [string, unknown][]; remove?: string[] }) => {
      if (state.fail) {
        const error = state.fail;
        state.fail = null;
        throw error;
      }
      state.commits += 1;
      for (const key of remove) records.delete(key);
      for (const [key, value] of put) records.set(key, structuredClone(value));
    },
    clearAll: async () => records.clear(),
  };
  return {
    records,
    state,
    store,
    fetch: vi.fn(),
    // A fresh library per test (mocked modules outlive vi.resetModules).
    create: null as null | (() => unknown),
    library: null as unknown,
  };
});
vi.mock('@/lib/api/client', () => ({
  apiFetch: h.fetch,
  describeError: (error: Error) => error.message,
}));
vi.mock('./project-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./project-library')>();
  h.create = () => actual.createProjectLibrary(h.store as LongformKeyedStore);
  h.library = h.create();
  return {
    ...actual,
    projectLibrary: new Proxy({}, { get: (_, key) => (h.library as never)[key] }),
  };
});

type Session = typeof import('./longform-session');
let session: Session;
const library = async () => (await import('./project-library')).projectLibrary;
const freshLibrary = () => {
  if (h.create) h.library = h.create();
};
const draftOf = (mode: 'audiobook' | 'stories') => session.longformSession.state.drafts[mode];
/** Let the queued saves land. */
const settle = async () => {
  await session.flushLongformProjects();
  await (await library()).flush();
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.resetModules();
  h.records.clear();
  h.state.commits = 0;
  h.state.fail = null;
  h.fetch.mockReset();
  localStorage.clear();
  freshLibrary();
  session = await import('./longform-session');
});
afterEach(async () => {
  // Nothing of this test's session may land in the next one's storage.
  await session.flushLongformSessionPersistence();
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('creates the project on the first edit and saves a second after the last edit', async () => {
  session.editLongform('audiobook', { voice: 'narrator' });
  // A setting alone is not a book yet.
  expect(draftOf('audiobook').projectId).toBeNull();
  expect(session.longformSession.state.saving.audiobook).toBe('idle');

  session.editLongform('audiobook', { script: 'Hello' });
  const id = draftOf('audiobook').projectId;
  expect(id).toEqual(expect.any(String));
  expect(session.longformSession.state.saving.audiobook).toBe('saving');
  await vi.advanceTimersByTimeAsync(500);
  session.editLongform('audiobook', { script: 'Hello world' });
  await vi.advanceTimersByTimeAsync(999);
  expect(h.state.commits).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await settle();

  expect(h.state.commits).toBe(1);
  const project = await (await library()).get(id!);
  expect(project).toMatchObject({ name: 'Untitled book 1', mode: 'audiobook', words: 2 });
  expect(project?.draft).toMatchObject({ script: 'Hello world', voice: 'narrator' });
  expect(session.longformSession.state.saving.audiobook).toBe('saved');

  // The name follows the title until the project is renamed.
  session.editLongform('audiobook', { title: 'Dế Mèn' });
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  expect((await (await library()).list())[0].name).toBe('Dế Mèn');
});

it('switching saves the open book first and is refused while that editor renders', async () => {
  const other = await (
    await library()
  ).create('audiobook', { ...session.blankLongformDraft(), script: 'Book B' }, 'B');
  session.editLongform('audiobook', { script: 'Book A, just typed' });
  const first = draftOf('audiobook').projectId!;

  expect(await session.openLongformProject(other.id)).toBe('audiobook');
  expect(draftOf('audiobook')).toMatchObject({ script: 'Book B', projectId: other.id });
  expect((await (await library()).get(first))?.draft.script).toBe('Book A, just typed');
  expect(session.longformSession.state.saving.audiobook).toBe('saved');

  session.longformSession.setState((s) => ({ ...s, active: 'audiobook' }));
  const reason = 'This is rendering. Stop it or wait for it to finish before you switch.';
  expect(session.switchBlocker('audiobook')).toBe(reason);
  await expect(session.openLongformProject(first)).rejects.toThrow(reason);
  await expect(session.newLongformProject('audiobook')).rejects.toThrow(reason);
  await expect(session.deleteLongformProject(other.id)).rejects.toThrow(reason);
  expect(draftOf('audiobook').projectId).toBe(other.id);
  // The other editor is free.
  const story = await (await library()).create('stories', session.blankLongformDraft(), 'S');
  expect(await session.openLongformProject(story.id)).toBe('stories');
  session.longformSession.setState((s) => ({ ...s, active: null }));
});

it('opening a render of a book shows that render', async () => {
  const book = await (
    await library()
  ).create('audiobook', { ...session.blankLongformDraft(), script: 'x', output: 'new.m4b' }, 'B');
  await session.openLongformProject(book.id, {
    output: 'old.m4b',
    chapters: [{ title: 'One', status: 'done' }],
  });
  expect(draftOf('audiobook')).toMatchObject({
    output: 'old.m4b',
    outputScript: '',
    outputChapters: [{ title: 'One', status: 'done' }],
  });
});

it('a closing page saves at once', async () => {
  session.editLongform('stories', { lines: [{ id: 'l', text: 'Hi', profileId: null }] });
  window.dispatchEvent(new Event('pagehide'));
  await (await library()).flush();
  await Promise.resolve();
  await (await library()).flush();
  expect(h.state.commits).toBe(1);
  expect(await (await library()).list()).toMatchObject([{ name: 'Untitled story 1' }]);
});

it('a render names its project and saves the book as it starts', async () => {
  h.fetch.mockResolvedValue(
    new Response(
      [
        { type: 'started', chapters: 1 },
        { type: 'chapter', index: 0, title: 'One', duration_s: 1 },
        { type: 'done', output: 'book.m4b', failed_chapters: [] },
      ]
        .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
        .join(''),
    ),
  );
  session.editLongform('audiobook', { script: 'Hello', voice: 'v', language: 'Auto' });
  await session.renderLongform('audiobook');
  const id = draftOf('audiobook').projectId;
  expect(JSON.parse(h.fetch.mock.calls[0][1].body).project_id).toBe(id);
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  // The finished file is the book's, and links its render to it.
  expect((await (await library()).list())[0]).toMatchObject({
    id,
    output: 'book.m4b',
    outputs: ['book.m4b'],
  });
});

it('the working drafts from before the library join it once, without duplicates', async () => {
  const blank = (await import('./longform-session')).blankLongformDraft();
  // Today's stored shapes: the working drafts, and a version 1 library in which
  // the Audiobook draft was saved (and then edited further).
  localStorage.setItem(
    'voicestudio.longform.v1',
    JSON.stringify({
      audiobook: { ...blank, script: 'Newer text', projectId: 'p1' },
      stories: { ...blank, lines: [{ id: 'l', text: 'Never saved', profileId: null }] },
    }),
  );
  h.records.set('workspace', {
    schema: 1,
    payload: {
      projects: [
        {
          id: 'p1',
          name: 'Saved book',
          mode: 'audiobook',
          updatedAt: 5,
          draft: { ...blank, script: 'Older text', projectId: 'p1' },
        },
      ],
    },
  });
  vi.resetModules();
  freshLibrary();
  session = await import('./longform-session');

  const projects = await session.listLongformProjects();
  expect(projects).toHaveLength(2);
  const book = projects.find((p) => p.id === 'p1');
  expect(book?.name).toBe('Saved book');
  expect((await (await library()).get('p1'))?.draft.script).toBe('Newer text');
  const story = projects.find((p) => p.mode === 'stories')!;
  expect(draftOf('stories').projectId).toBe(story.id);
  expect(session.longformSession.state.saving).toEqual({ stories: 'saved', audiobook: 'saved' });
  const commits = h.state.commits;
  expect(await session.listLongformProjects()).toHaveLength(2);
  expect(h.state.commits).toBe(commits);
});

it('deleting the open book starts an empty one and never brings it back', async () => {
  session.editLongform('audiobook', { script: 'Gone soon', voice: 'narrator' });
  await settle();
  const id = draftOf('audiobook').projectId!;
  session.editLongform('audiobook', { script: 'Gone soon, edited' });
  await session.deleteLongformProject(id);
  expect(draftOf('audiobook')).toMatchObject({ script: '', projectId: null, voice: 'narrator' });
  await vi.advanceTimersByTimeAsync(2000);
  await settle();
  expect(await (await library()).list()).toEqual([]);
});

it('a book that replaces the Stories draft keeps the last edits of the old one', async () => {
  session.editLongform('stories', { lines: [{ id: 'a', text: 'Old story', profileId: null }] });
  const old = draftOf('stories').projectId!;
  // What loading a dub into Stories does.
  session.editLongform('stories', {
    lines: [{ id: 'b', text: 'From the dub', profileId: null }],
    projectId: null,
  });
  expect(draftOf('stories').projectId).not.toBe(old);
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  const lib = await library();
  expect((await lib.get(old))?.draft.lines[0].text).toBe('Old story');
  expect((await lib.get(draftOf('stories').projectId!))?.draft.lines[0].text).toBe('From the dub');
  expect(await lib.list()).toHaveLength(2);
});

it('a failed save says so and is retried', async () => {
  session.editLongform('audiobook', { script: 'Text' });
  h.state.fail = new Error('Disk full');
  await expect(session.saveLongformProject('audiobook')).rejects.toThrow('Disk full');
  expect(session.longformSession.state.saving.audiobook).toBe('error');
  expect(session.longformSession.state.saveError.audiobook).toBe('Disk full');
  await session.saveLongformProject('audiobook');
  expect(session.longformSession.state.saving.audiobook).toBe('saved');
});

/** A fresh app start over today's storage: the working copy and the library as they are. */
const restart = async (working: Record<string, unknown>) => {
  await session.flushLongformSessionPersistence();
  await settle();
  localStorage.setItem('voicestudio.longform.v1', JSON.stringify(working));
  vi.resetModules();
  freshLibrary();
  session = await import('./longform-session');
  await session.adoptLongformDrafts();
  await settle();
};

it('a project newer than the working copy is the book at the next start', async () => {
  const blank = session.blankLongformDraft();
  const lib = await library();
  const book = await lib.create(
    'audiobook',
    { ...blank, script: 'Saved later', editedAt: 200 },
    'B',
  );
  await lib.markDraftsAdopted();
  // The working copy kept an older state: a write over the quota failed, or
  // a crash lost it. Restoring it must not overwrite the project.
  await restart({ audiobook: { ...blank, script: 'Older', projectId: book.id, editedAt: 100 } });
  expect(draftOf('audiobook')).toMatchObject({ script: 'Saved later', projectId: book.id });
  expect((await (await library()).get(book.id))?.draft.script).toBe('Saved later');
  expect(session.longformSession.state.saving.audiobook).toBe('saved');
  // A working copy with newer edits (typed after the last save landed) wins.
  await restart({ audiobook: { ...blank, script: 'Typed last', projectId: book.id, editedAt: 900 } });
  expect(draftOf('audiobook').script).toBe('Typed last');
  expect((await (await library()).get(book.id))?.draft.script).toBe('Typed last');
});

it('edits saved while the working copy cannot be written survive a restart', async () => {
  session.editLongform('audiobook', { script: 'First' });
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  await session.flushLongformSessionPersistence();
  const id = draftOf('audiobook').projectId!;
  const stale = localStorage.getItem('voicestudio.longform.v1')!;
  // The book outgrows the storage quota: the working copy stays as it was.
  const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  try {
    session.editLongform('audiobook', { script: 'First and the rest of the novel' });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    await session.flushLongformSessionPersistence();
    expect(session.longformSession.state.saving.audiobook).toBe('saved');
  } finally {
    quota.mockRestore();
  }
  expect(localStorage.getItem('voicestudio.longform.v1')).toBe(stale);
  await restart(JSON.parse(stale));
  expect(draftOf('audiobook')).toMatchObject({
    script: 'First and the rest of the novel',
    projectId: id,
  });
  expect((await (await library()).get(id))?.draft.script).toBe('First and the rest of the novel');
});

const stream = (events: Record<string, unknown>[]) =>
  new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));

it('resuming a render finishes it in its own book, never the open one', async () => {
  const lib = await library();
  const blank = session.blankLongformDraft();
  const a = await lib.create('audiobook', { ...blank, script: 'Book A' }, 'A');
  session.editLongform('audiobook', { script: 'Book B, open now' });
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  const b = draftOf('audiobook').projectId!;
  h.fetch.mockResolvedValue(
    stream([
      { type: 'started', chapters: 1 },
      { type: 'chapter', index: 0, title: 'One', duration_s: 1 },
      { type: 'done', output: 'book_a.m4b', failed_chapters: [] },
    ]),
  );
  await session.resumeLongform('audiobook', { job_id: 'j1', project_id: a.id });
  expect(h.fetch.mock.calls[0][0]).toBe('/audiobook/resume/j1');
  expect(draftOf('audiobook')).toMatchObject({ projectId: a.id, output: 'book_a.m4b' });
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  expect((await lib.get(a.id))?.output).toBe('book_a.m4b');
  expect(await lib.get(b)).toMatchObject({ output: '', draft: { script: 'Book B, open now' } });

  // A render from before the library names no book: it gets one of its own.
  h.fetch.mockResolvedValue(
    stream([
      { type: 'started', chapters: 1 },
      { type: 'chapter', index: 0, title: 'One', duration_s: 1 },
      { type: 'done', output: 'old.m4b', failed_chapters: [] },
    ]),
  );
  await session.resumeLongform('audiobook', { job_id: 'j2', title: 'Old book' });
  expect(draftOf('audiobook')).toMatchObject({ title: 'Old book', output: 'old.m4b', script: '' });
  expect(draftOf('audiobook').projectId).not.toBe(a.id);
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  expect((await lib.get(a.id))?.output).toBe('book_a.m4b');
});

it('opening an older render and the latest again keeps what each was shown with', async () => {
  const lib = await library();
  const latest = {
    output: 'new.m4b',
    outputScript: 'Script of the latest',
    outputChapters: [
      { title: 'One', status: 'done', duration_ms: 1500, suspects: ['heard wrong'] },
      { title: '', untitled: true, status: 'failed', error: 'boom' },
    ],
    outputCachedChapters: 1,
    outputFailedChapters: 1,
  };
  const book = await lib.create(
    'audiobook',
    { ...session.blankLongformDraft(), script: 'x', ...latest },
    'B',
  );
  await session.openLongformProject(book.id, {
    output: 'old.m4b',
    chapters: [{ title: 'One', status: 'done' }],
  });
  expect(draftOf('audiobook')).toMatchObject({
    output: 'old.m4b',
    outputScript: '',
    outputChapters: [{ title: 'One', status: 'done' }],
  });
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  // Back to the latest: its script, lengths, speech check and failures return.
  await session.openLongformProject(book.id, {
    output: 'new.m4b',
    chapters: [{ title: 'One', status: 'done' }],
  });
  expect(draftOf('audiobook')).toMatchObject(latest);
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  expect((await lib.get(book.id))?.draft).toMatchObject(latest);
  // Deleting the project takes what it kept along.
  await session.deleteLongformProject(book.id);
  expect([...h.records.keys()].some((key) => key.includes(book.id))).toBe(false);
});
