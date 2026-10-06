import {
  createIndexedDbLongformStore,
  type LongformKeyedStore,
} from '@shared/utils/indexedDbLongformStore';
import { scriptStats } from '@shared/utils/audiobookScript';
import type { Draft, Mode } from './longform-session';

/**
 * The book/story library: every Audiobook and Stories draft belongs to a
 * project here. Version 2 keeps each project in records of its own — a small
 * `meta:<id>` the lists read and the `draft:<id>` it opens — so saving one book
 * rewrites that book only, and a record that cannot be read costs that project
 * alone, never the library. Version 1 kept every project in one `workspace`
 * record; it is moved over once, on first use (see `migrateLegacyLibrary`).
 */
export const LIBRARY_VERSION = 2;
const META = 'meta:';
const DRAFT = 'draft:';
const WORKSPACE = 'workspace';
/** What a project's earlier renders were read from: `renders:<id>`. */
const RENDERS = 'renders:';
/** Set once the working drafts kept from before the library have joined it. */
const ADOPTED = 'drafts-adopted';
/** Finished files a project remembers, to link older renders to it. */
const MAX_OUTPUTS = 200;
/** Earlier renders whose details a project keeps (each holds its script). */
export const MAX_RENDER_DETAILS = 12;

export interface LongformProjectMeta {
  id: string;
  name: string;
  mode: Mode;
  /** The name follows the book title until the project is renamed. */
  autoName: boolean;
  createdAt: number;
  updatedAt: number;
  words: number;
  chapters: number;
  /** The finished file the project shows; '' before its first render. */
  output: string;
  /** Every finished file the project has shown, oldest first. */
  outputs: string[];
}

export interface LongformProject extends LongformProjectMeta {
  draft: Draft;
}

/**
 * What the editor shows with a finished file besides the file itself: the
 * script it was read from and its chapters (lengths, speech check, levels).
 * Values come back unchecked; the editor restores them.
 */
export interface RenderDetails {
  outputScript: unknown;
  outputChapters: unknown;
  outputCachedChapters: unknown;
  outputFailedChapters: unknown;
}

export class ProjectMissingError extends Error {
  constructor() {
    super('Project no longer exists');
    this.name = 'ProjectMissingError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isMode = (value: unknown): value is Mode => value === 'stories' || value === 'audiobook';
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** The least a stored draft needs to open: the editor restores the rest. */
export function isStoredDraft(value: unknown): value is Draft {
  return isRecord(value) && typeof value.script === 'string' && Array.isArray(value.lines);
}

function readMeta(key: string, value: unknown): LongformProjectMeta | null {
  if (!isRecord(value)) return null;
  const { id, name, mode } = value;
  if (typeof id !== 'string' || !id || key !== META + id) return null;
  if (typeof name !== 'string' || !isMode(mode)) return null;
  const outputs = Array.isArray(value.outputs)
    ? value.outputs.filter((item): item is string => typeof item === 'string' && !!item)
    : [];
  return {
    id,
    name,
    mode,
    autoName: value.autoName === true,
    createdAt: count(value.createdAt) || count(value.updatedAt),
    updatedAt: count(value.updatedAt),
    words: count(value.words),
    chapters: count(value.chapters),
    output: typeof value.output === 'string' ? value.output : '',
    outputs,
  };
}

/** What the lists show about a draft, and the files that link renders to it. */
function describe(mode: Mode, draft: Draft, previous: string[] = []) {
  const text =
    mode === 'audiobook'
      ? draft.script
      : draft.lines.map((line) => (typeof line?.text === 'string' ? line.text : '')).join('\n');
  const stats = scriptStats(text);
  const output = typeof draft.output === 'string' ? draft.output : '';
  const outputs =
    output && !previous.includes(output) ? [...previous, output].slice(-MAX_OUTPUTS) : previous;
  return { words: stats.words, chapters: stats.words > 0 ? stats.chapters : 0, output, outputs };
}

const metaRecord = (meta: LongformProjectMeta) =>
  [META + meta.id, { ...meta }] as [string, unknown];
const draftRecord = (id: string, draft: Draft) =>
  [DRAFT + id, { version: LIBRARY_VERSION, draft: { ...draft, projectId: id } }] as [
    string,
    unknown,
  ];

/**
 * Move a version 1 library — every project inside the `workspace` record —
 * into records of their own, in one transaction. Entries that cannot be read
 * are kept aside in the workspace record (`unreadable`), never dropped, and
 * an entry already moved (same id) is not moved twice.
 */
async function migrateLegacyLibrary(store: LongformKeyedStore): Promise<void> {
  const record = await store.get(WORKSPACE);
  if (!isRecord(record) || !isRecord(record.payload)) return;
  const payload = record.payload;
  const legacy = Array.isArray(payload.projects) ? payload.projects : [];
  if (!legacy.length) return;
  const existing = new Set((await store.entries(META)).map(([key]) => key.slice(META.length)));
  const unreadable: unknown[] = Array.isArray(payload.unreadable) ? [...payload.unreadable] : [];
  const put: [string, unknown][] = [];
  for (const entry of legacy) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.name !== 'string' ||
      !isMode(entry.mode) ||
      !isStoredDraft(entry.draft)
    ) {
      unreadable.push(entry);
      continue;
    }
    if (existing.has(entry.id)) continue;
    existing.add(entry.id);
    const updatedAt = count(entry.updatedAt) || Date.now();
    const draft = entry.draft;
    put.push(
      metaRecord({
        id: entry.id,
        name: entry.name.trim() || entry.id,
        mode: entry.mode,
        autoName: false,
        createdAt: updatedAt,
        updatedAt,
        ...describe(entry.mode, draft),
      }),
      draftRecord(entry.id, draft),
    );
  }
  put.push([
    WORKSPACE,
    {
      ...record,
      payload: {
        ...payload,
        projects: [],
        version: LIBRARY_VERSION,
        ...(unreadable.length ? { unreadable } : {}),
      },
    },
  ]);
  await store.commit({ put });
}

export function createProjectLibrary(store: LongformKeyedStore) {
  let queue: Promise<unknown> = Promise.resolve();
  let migrated: Promise<void> | null = null;
  const ready = () =>
    (migrated ??= migrateLegacyLibrary(store).catch((error) => {
      migrated = null;
      throw error;
    }));
  /** One operation at a time, in call order, each after the migration. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(async () => {
      await ready();
      return work();
    });
    queue = next.catch(() => {});
    return next;
  };
  const readOne = async (id: string) => {
    const meta = readMeta(META + id, await store.get(META + id));
    if (!meta) throw new ProjectMissingError();
    return meta;
  };
  const list = () =>
    serial(async () =>
      (await store.entries(META))
        .map(([key, value]) => readMeta(key, value))
        .filter((meta): meta is LongformProjectMeta => meta !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  const get = (id: string) =>
    serial(async (): Promise<LongformProject | null> => {
      const meta = readMeta(META + id, await store.get(META + id));
      if (!meta) return null;
      const stored = await store.get(DRAFT + id);
      const draft = isRecord(stored) ? stored.draft : undefined;
      if (!isStoredDraft(draft)) throw new Error('Project data could not be read');
      return { ...meta, draft: structuredClone({ ...draft, projectId: id }) };
    });
  const create = (
    mode: Mode,
    draft: Draft,
    name: string,
    options: { autoName?: boolean; id?: string } = {},
  ) => {
    const snapshot = structuredClone(draft);
    return serial(async () => {
      if (!name.trim()) throw new Error('Project name is required');
      const now = Date.now();
      const meta: LongformProjectMeta = {
        id: options.id || crypto.randomUUID(),
        name: name.trim(),
        mode,
        autoName: options.autoName === true,
        createdAt: now,
        updatedAt: now,
        ...describe(mode, snapshot),
      };
      await store.commit({ put: [metaRecord(meta), draftRecord(meta.id, snapshot)] });
      return meta;
    });
  };
  /** Write the draft of an existing project; ProjectMissingError if it is gone. */
  const save = (id: string, draft: Draft) => {
    const snapshot = structuredClone(draft);
    return serial(async () => {
      const previous = await readOne(id);
      const title = typeof snapshot.title === 'string' ? snapshot.title.trim() : '';
      const meta: LongformProjectMeta = {
        ...previous,
        name: previous.autoName && title ? title : previous.name,
        updatedAt: Date.now(),
        ...describe(previous.mode, snapshot, previous.outputs),
      };
      await store.commit({ put: [metaRecord(meta), draftRecord(id, snapshot)] });
      return meta;
    });
  };
  /** The stored draft of a project, compared as data (no write). */
  const sameDraft = (id: string, draft: Draft) =>
    serial(async () => {
      const stored = await store.get(DRAFT + id);
      return (
        isRecord(stored) &&
        JSON.stringify(stored.draft) === JSON.stringify({ ...draft, projectId: id })
      );
    });
  /** The details of each earlier render, by file, oldest first. */
  const renderMap = async (id: string): Promise<Record<string, RenderDetails>> => {
    const stored = await store.get(RENDERS + id);
    return isRecord(stored) && isRecord(stored.renders)
      ? (stored.renders as Record<string, RenderDetails>)
      : {};
  };
  return {
    list,
    get,
    create,
    save,
    sameDraft,
    /**
     * Keep what `output` was shown with, so opening that render again later
     * brings back its script and chapters (the newest renders are kept).
     */
    keepRender: (id: string, output: string, details: RenderDetails) => {
      const snapshot = structuredClone(details);
      return serial(async () => {
        const renders = await renderMap(id);
        delete renders[output];
        const kept = Object.entries({ ...renders, [output]: snapshot }).slice(-MAX_RENDER_DETAILS);
        await store.commit({
          put: [[RENDERS + id, { version: LIBRARY_VERSION, renders: Object.fromEntries(kept) }]],
        });
      });
    },
    /** What an earlier render of the project was shown with, or null when it was not kept. */
    renderDetails: (id: string, output: string) =>
      serial(async (): Promise<RenderDetails | null> => {
        const details = (await renderMap(id))[output];
        return isRecord(details) ? details : null;
      }),
    /** Whether the working drafts from before the library have joined it. */
    draftsAdopted: () => serial(async () => isRecord(await store.get(ADOPTED))),
    markDraftsAdopted: () =>
      serial(() => store.commit({ put: [[ADOPTED, { version: LIBRARY_VERSION, at: Date.now() }]] })),
    rename: (id: string, name: string) =>
      serial(async () => {
        if (!name.trim()) throw new Error('Project name is required');
        const meta = { ...(await readOne(id)), name: name.trim(), autoName: false };
        await store.commit({ put: [metaRecord(meta)] });
        return meta;
      }),
    duplicate: (id: string, name: string) =>
      serial(async () => {
        if (!name.trim()) throw new Error('Project name is required');
        const source = await readOne(id);
        const stored = await store.get(DRAFT + id);
        const draft = isRecord(stored) ? stored.draft : undefined;
        if (!isStoredDraft(draft)) throw new Error('Project data could not be read');
        const now = Date.now();
        const meta: LongformProjectMeta = {
          ...source,
          id: crypto.randomUUID(),
          name: name.trim(),
          autoName: false,
          createdAt: now,
          updatedAt: now,
          // Renders made before the copy belong to the original.
          outputs: source.output ? [source.output] : [],
        };
        await store.commit({ put: [metaRecord(meta), draftRecord(meta.id, draft)] });
        return meta;
      }),
    /** Removes the project's records only: rendered audio files stay where they are. */
    remove: (id: string) =>
      serial(() => store.commit({ remove: [META + id, DRAFT + id, RENDERS + id] })),
    flush: () => queue.then(() => undefined),
    clear: () => {
      const next = queue.then(() => store.clearAll());
      queue = next.catch(() => {});
      return next;
    },
  };
}

export type ProjectLibrary = ReturnType<typeof createProjectLibrary>;

/** A distinct DB keeps Electron records from overwriting Tauri's workspace envelope. */
export const projectLibrary = createProjectLibrary(
  createIndexedDbLongformStore(undefined, 'voicestudio.electron.longform.projects'),
);
