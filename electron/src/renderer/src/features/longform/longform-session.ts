import {
  DEFAULT_OVERRIDES,
  overridesToRequest,
  restoreVoiceGains,
  voiceGainKey,
  voiceGainsToRequest,
  type Overrides,
  type VoiceGains,
} from '@shared/utils/longformOverrides';
import { castVoice } from './cast-map';
import { parseCastNames, scriptStats } from '@shared/utils/audiobookScript';
import { LANG_CODES } from '@shared/utils/languages';
import { restoreBookOptions, lexiconMap, type BookOptions } from './book-options';
import { createCoalescedJsonStorage } from '@shared/utils/coalescedJsonStorage';
import { Store } from '@tanstack/store';
import { useStore } from '@tanstack/react-store';
import { apiFetch } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import { cachedTtsLanguagesSupported } from '@/lib/language-options';
import { tr } from '@/lib/i18n-text';
import { consumeLongformStream } from '@shared/utils/longformStream';
import { isChapterLine } from '@shared/utils/storyExport';
import { storyToSpans } from '@shared/utils/storyToSpans';
import { beginAppActivity } from '@/lib/app-activity';
import { publicFailureFromEvent, type PublicFailure } from '@/lib/api/failure';
import { chapterLevels, type VoiceLevels } from './auto-levels';
import { scriptSize } from './story-clear';
import { normalizeNewlines } from './script-markup';
import { scriptOutline } from './script-outline';
import type { RetakeChapter } from './take-retake';
import { takeProgress, type TakeProgress } from './take-progress';
import { ProjectMissingError, projectLibrary, type LongformProjectMeta } from './project-library';
export type Mode = 'stories' | 'audiobook';
export interface Character {
  id: string;
  name: string;
  profileId: string | null;
}
export interface Line {
  character?: string;
  speed?: number | null;
  id: string;
  text: string;
  profileId: string | null;
}
export interface AudiobookRenderChapter {
  title: string;
  status: string;
  duration_s?: number;
  /** Exact length in the embedded m4b chapters; sent by newer backends only. */
  duration_ms?: number;
  error?: string;
  /** Phrases the speech check still heard differently after its retakes. */
  suspects?: string[];
  /** Phrases the speech check could not listen to (newer backends). */
  unchecked?: number;
  /** They went unheard because no speech recognizer was installed (newer backends). */
  noRecognizer?: boolean;
  /** What voice leveling measured per voice in this chapter (newer backends, leveling on). */
  levels?: VoiceLevels;
  /** The script gave the chapter no title (its `title` is then blank). */
  untitled?: boolean;
}
/** Phrases a render's speech check reported for listening (newer backends). */
export function suspectPhrases(event: Record<string, unknown>): string[] {
  const check = event.speech_check as { suspect?: unknown } | undefined;
  return Array.isArray(check?.suspect)
    ? check.suspect
        .map((item) => (item as { text?: unknown })?.text)
        .filter((text): text is string => typeof text === 'string' && text.length > 0)
        .slice(0, 50)
    : [];
}
/** How many phrases a render's speech check could not listen to (newer backends). */
export function uncheckedPhrases(event: Record<string, unknown>): number {
  const unchecked = (event.speech_check as { unchecked?: unknown } | undefined)?.unchecked;
  return typeof unchecked === 'number' && Number.isInteger(unchecked) && unchecked > 0
    ? unchecked
    : 0;
}
/**
 * Whether the phrases a render's speech check could not listen to went
 * unheard because no speech recognizer was installed — not because the one
 * installed heard no words in them or failed (newer backends).
 */
export function recognizerMissing(event: Record<string, unknown>): boolean {
  return (event.speech_check as { no_recognizer?: unknown } | undefined)?.no_recognizer === true;
}
export interface Draft extends BookOptions {
  importText: string;
  cast: Character[];
  globalSpeed: number;
  projectId: string | null;
  overrides: Overrides;
  voiceCast: Record<string, string>;
  /** Volume per voice in dB, on top of the leveling: cast name → gain, '' = default voice. */
  voiceGains: VoiceGains;
  script: string;
  lines: Line[];
  title: string;
  voice: string | null;
  format: 'mp3' | 'm4b';
  language: string;
  output: string;
  outputScript: string;
  outputChapters: AudiobookRenderChapter[];
  outputCachedChapters: number;
  outputFailedChapters: number;
  /**
   * When an edit last changed this draft (ms), kept with it in the working
   * copy and in its project: the newer of the two copies is the book. 0 for
   * a draft from before this was kept.
   */
  editedAt: number;
}
/** What the progress panel tells a render's time left from (`renderTimeLeft`). */
export interface RenderTiming {
  /** When the render started, on the `performance.now()` clock. */
  startedAt: number;
  /** When each chapter's event arrived (`null` until it has). */
  finishedAt: (number | null)[];
  /** The words each chapter reads; `null` when its chapters are not known here (a resume). */
  words: number[] | null;
  /** Whether the chapter cache held each chapter as the render started (`null`: not known). */
  cached: (boolean | null)[] | null;
  /** The last word on the chapter rendering now: what it waits for, or its takes. */
  progress?: TakeProgress | null;
}
interface Session {
  drafts: Record<Mode, Draft>;
  active: Mode | null;
  stage: string;
  completed: number;
  total: number;
  failed: number;
  error: string | null;
  failure: PublicFailure | null;
  storageError: boolean;
  chapters: AudiobookRenderChapter[];
  /** The running render's clock; `null` before its first event. */
  timing: RenderTiming | null;
  stopped: boolean;
  /** Where the open project of each mode stands in the library. */
  saving: Record<Mode, ProjectSaveState>;
  saveError: Record<Mode, string | null>;
}
/** `idle`: nothing to keep yet (a new, empty draft). */
export type ProjectSaveState = 'idle' | 'saving' | 'saved' | 'error';
export const blankLongformDraft = (): Draft => ({
  projectId: null,
  importText: '',
  cast: [],
  globalSpeed: 1,
  ...restoreBookOptions(null),
  overrides: { ...DEFAULT_OVERRIDES },
  voiceCast: {},
  voiceGains: {},
  script: '',
  lines: [],
  title: '',
  voice: null,
  format: 'm4b',
  language: 'Auto',
  output: '',
  outputScript: '',
  outputChapters: [],
  outputCachedChapters: 0,
  outputFailedChapters: 0,
  editedAt: 0,
});
/**
 * A stored draft as the editor can use it — the working copy in localStorage
 * or a library project — with every field checked and older shapes filled in;
 * `null` when it is not a draft at all.
 */
export function restoreDraft(s: any): Draft | null {
  if (!s || typeof s.script !== 'string' || !Array.isArray(s.lines)) return null;
  return {
    ...restoreBookOptions(s),
    importText: typeof s.importText === 'string' ? s.importText : '',
    cast: Array.isArray(s.cast)
      ? s.cast.filter((c: Character) => c && typeof c.id === 'string' && typeof c.name === 'string')
      : [],
    globalSpeed:
      typeof s.globalSpeed === 'number' && s.globalSpeed >= 0.5 && s.globalSpeed <= 2
        ? s.globalSpeed
        : 1,
    projectId: typeof s.projectId === 'string' ? s.projectId : null,
    overrides: { ...DEFAULT_OVERRIDES, ...s.overrides },
    voiceCast: Object.fromEntries(
      Object.entries(s.voiceCast || {}).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    ),
    voiceGains: restoreVoiceGains(s.voiceGains),
    script: s.script,
    lines: s.lines.filter(
      (line: Line) => line && typeof line.id === 'string' && typeof line.text === 'string',
    ),
    title: typeof s.title === 'string' ? s.title : '',
    voice: typeof s.voice === 'string' ? s.voice : null,
    format: s.format === 'mp3' ? 'mp3' : 'm4b',
    language: typeof s.language === 'string' ? s.language : 'Auto',
    output: typeof s.output === 'string' ? s.output : '',
    outputScript: typeof s.outputScript === 'string' ? s.outputScript : '',
    outputChapters: Array.isArray(s.outputChapters)
      ? s.outputChapters.filter(
          (chapter: AudiobookRenderChapter) =>
            chapter && typeof chapter.title === 'string' && typeof chapter.status === 'string',
        )
      : [],
    outputCachedChapters: typeof s.outputCachedChapters === 'number' ? s.outputCachedChapters : 0,
    outputFailedChapters: typeof s.outputFailedChapters === 'number' ? s.outputFailedChapters : 0,
    editedAt: Number.isFinite(s.editedAt) && s.editedAt > 0 ? s.editedAt : 0,
  };
}
const key = 'voicestudio.longform.v1';
const drafts = {
  stories: blankLongformDraft(),
  audiobook: blankLongformDraft(),
};
try {
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  for (const mode of ['stories', 'audiobook'] as const)
    drafts[mode] = restoreDraft(saved?.[mode]) ?? drafts[mode];
} catch {
  /* Invalid drafts do not prevent opening the editor. */
}
export const longformSession = new Store<Session>({
  drafts,
  active: null,
  stage: '',
  completed: 0,
  total: 0,
  failed: 0,
  error: null,
  failure: null,
  storageError: false,
  chapters: [],
  timing: null,
  stopped: false,
  saving: { stories: 'idle', audiobook: 'idle' },
  saveError: { stories: null, audiobook: null },
});
export const useLongformSession = () => useStore(longformSession);
/** Fences document imports that finish after a new dub replaces the Stories draft. */
export const storiesImportEpoch = { current: 0 };
const patch = (value: Partial<Session>) => longformSession.setState((s) => ({ ...s, ...value }));
export function editLongform(mode: Mode, value: Partial<Draft>) {
  if (longformSession.state.active) return;
  updateDraft(mode, value);
}
const storage = createCoalescedJsonStorage({
  warn: () => patch({ storageError: true }),
});
storage.configurePersistenceRole('main');
/**
 * Writes the working drafts now and saves every open project with edits
 * still waiting for the auto-save; resolves once they are in the library.
 */
export function flushLongformSessionPersistence(): Promise<void> {
  storage.flushPendingWrites();
  return flushLongformProjects();
}
const removeLifecycle = storage.installPersistenceLifecycleFlush();
// A closing or hidden page saves the open books at once, not a second later.
const flushOnHide = () => void flushLongformProjects();
const flushWhenHidden = () => {
  if (document.visibilityState === 'hidden') flushOnHide();
};
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushOnHide);
  document.addEventListener('visibilitychange', flushWhenHidden);
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    storage.flushPendingWrites();
    void flushLongformProjects();
    removeLifecycle();
    window.removeEventListener('pagehide', flushOnHide);
    document.removeEventListener('visibilitychange', flushWhenHidden);
    controller?.abort();
  });
function updateDraft(mode: Mode, value: Partial<Draft>, autosave = true) {
  const current = longformSession.state.drafts[mode];
  if ('projectId' in value && value.projectId !== current.projectId) {
    // Another book takes this one's place (a dub loaded into Stories, a
    // project opened): what was typed in the last second is saved to the
    // book it belongs to before it is gone.
    if (autosaveTimers[mode] || (!current.projectId && hasContent(mode, current))) {
      cancelAutosave(mode);
      void queueProjectSave(mode, current).catch(() => {});
    }
    lineage[mode] += 1;
  }
  // An edit stamps the draft; a book opened from the library keeps its stamp.
  const edited = autosave ? { editedAt: Math.max(Date.now(), current.editedAt + 1) } : {};
  const next = {
    ...longformSession.state.drafts,
    [mode]: { ...current, ...value, ...edited },
  };
  patch({ drafts: next });
  storage.queueJsonWrite(key, () => longformSession.state.drafts);
  if (autosave && !autosaveSuspended) scheduleAutosave(mode);
}

/** Prevent queued and pagehide writes from recreating a draft during a confirmed data reset. */
export function clearLongformDraftForReset(): void {
  autosaveSuspended = true;
  for (const mode of MODES) cancelAutosave(mode);
  storage.suspendJsonWrites((candidate) => candidate === key);
  localStorage.removeItem(key);
}

// ── The library: auto-save and switching books ──────────────────────────────

const MODES = ['stories', 'audiobook'] as const;
/** How long the editor waits after the last edit before saving the book. */
export const AUTOSAVE_DELAY_MS = 1000;
const autosaveTimers: Record<Mode, ReturnType<typeof setTimeout> | null> = {
  stories: null,
  audiobook: null,
};
const saveChains: Record<Mode, Promise<unknown>> = {
  stories: Promise.resolve(),
  audiobook: Promise.resolve(),
};
/** Bumped whenever another book replaces a mode's draft. */
const lineage: Record<Mode, number> = { stories: 0, audiobook: 0 };
let autosaveSuspended = false;
let adoption: Promise<void> | null = null;

/** Whether a draft holds anything worth a project: text, a title or a finished file. */
export function hasContent(mode: Mode, draft: Draft): boolean {
  return scriptSize(mode, draft) > 0 || !!draft.title.trim() || !!draft.output;
}

function setSaveState(mode: Mode, state: ProjectSaveState, error: string | null = null) {
  const s = longformSession.state;
  if (s.saving[mode] === state && s.saveError[mode] === error) return;
  patch({ saving: { ...s.saving, [mode]: state }, saveError: { ...s.saveError, [mode]: error } });
}

function cancelAutosave(mode: Mode) {
  const timer = autosaveTimers[mode];
  if (timer) clearTimeout(timer);
  autosaveTimers[mode] = null;
}

function scheduleAutosave(mode: Mode) {
  cancelAutosave(mode);
  if (!claimProjectId(mode)) return;
  setSaveState(mode, 'saving');
  autosaveTimers[mode] = setTimeout(() => {
    autosaveTimers[mode] = null;
    void saveLongformProject(mode).catch(() => {});
  }, AUTOSAVE_DELAY_MS);
}

/** "Untitled book 3": the first number no project of this mode is named with. */
function untitledName(mode: Mode, taken: string[]): string {
  const names = new Set(taken);
  const label = (n: number) =>
    tr(mode === 'audiobook' ? 'library.untitled_book' : 'library.untitled_story', { n });
  let n = 1;
  while (n <= taken.length && names.has(label(n))) n += 1;
  return label(n);
}

function linkDraft(mode: Mode, projectId: string | null) {
  const drafts = longformSession.state.drafts;
  patch({ drafts: { ...drafts, [mode]: { ...drafts[mode], projectId } } });
  storage.queueJsonWrite(key, () => longformSession.state.drafts);
}

/**
 * The id of the open book's project — given at once, on the first edit that
 * puts something in a new book, so a render started a moment later already
 * names its project; the project itself is written by the save. Null while
 * the draft is empty and has none.
 */
function claimProjectId(mode: Mode): string | null {
  const draft = longformSession.state.drafts[mode];
  if (draft.projectId) return draft.projectId;
  if (!hasContent(mode, draft)) return null;
  const id = crypto.randomUUID();
  linkDraft(mode, id);
  return id;
}

/**
 * Saves `snapshot` into its project, creating the project the first time
 * (named from the title, or "Untitled book N"). One save at a time per mode.
 */
function queueProjectSave(mode: Mode, snapshot: Draft): Promise<void> {
  // A save started for a book that another book has replaced since then
  // still lands in its own project, but no longer speaks for the editor.
  const generation = lineage[mode];
  const current = () => lineage[mode] === generation;
  const run = saveChains[mode].then(async () => {
    try {
      const id = snapshot.projectId ?? crypto.randomUUID();
      const draft = { ...snapshot, projectId: id };
      try {
        await projectLibrary.save(id, draft);
      } catch (error) {
        if (!(error instanceof ProjectMissingError)) throw error;
        // New (or removed elsewhere while open): the text is kept as a project.
        if (!hasContent(mode, draft)) {
          if (current()) {
            linkDraft(mode, null);
            if (!autosaveTimers[mode]) setSaveState(mode, 'idle');
          }
          return;
        }
        const taken = (await projectLibrary.list()).map((project) => project.name);
        const name = draft.title.trim() || untitledName(mode, taken);
        await projectLibrary.create(mode, draft, name, { autoName: true, id });
      }
      if (current() && !autosaveTimers[mode]) setSaveState(mode, 'saved');
      void queryClient.invalidateQueries({ queryKey: ['longform-projects'] });
    } catch (error) {
      if (current())
        setSaveState(mode, 'error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
  saveChains[mode] = run.catch(() => {});
  return run;
}

/** Saves the open project of `mode` now; rejects when it could not be saved. */
export function saveLongformProject(mode: Mode): Promise<void> {
  cancelAutosave(mode);
  claimProjectId(mode);
  return queueProjectSave(mode, longformSession.state.drafts[mode]);
}

/** Saves every open project with edits still waiting for the auto-save. */
export function flushLongformProjects(): Promise<void> {
  return Promise.all(
    MODES.map((mode) =>
      autosaveTimers[mode] ? saveLongformProject(mode).catch(() => {}) : saveChains[mode],
    ),
  ).then(() => undefined);
}

/**
 * Bring the working copy of each open book (kept in localStorage) and its
 * project together, once per app start. The library is the durable copy and
 * the working copy can lag behind it — a write over the storage quota fails
 * and leaves the old value, a crash loses writes the library already has —
 * so the working copy wins only with an edit newer than the project's.
 *
 * Once, the drafts kept from before the library join it: a draft opened from
 * (or saved as) a project updates that project — never a duplicate — and one
 * that never was becomes a new project. Afterwards a working copy never
 * overwrites a project on its own say.
 */
export function adoptLongformDrafts(): Promise<void> {
  return (adoption ??= (async () => {
    const adopted = await projectLibrary.draftsAdopted();
    let legacy = false;
    for (const mode of MODES) if (await reconcileDraft(mode, adopted)) legacy = true;
    if (legacy) await projectLibrary.markDraftsAdopted();
  })().catch((error) => {
    adoption = null;
    throw error;
  }));
}

/** One mode's half of `adoptLongformDrafts`; true when a draft from before the library joined it. */
async function reconcileDraft(mode: Mode, adopted: boolean): Promise<boolean> {
  const draft = longformSession.state.drafts[mode];
  // Edits made since the app started are on their way to the library already.
  if (autosaveTimers[mode]) return false;
  const legacy = !adopted && draft.editedAt === 0;
  const id = draft.projectId;
  if (!id) {
    if (!legacy || !hasContent(mode, draft)) return false;
    await saveLongformProject(mode);
    return true;
  }
  const project = await projectLibrary.get(id).catch(() => null);
  // Edited or replaced while the library was read: that edit is the newest.
  if (longformSession.state.drafts[mode] !== draft || autosaveTimers[mode]) return false;
  const stored = project && !legacy ? restoreDraft(project.draft) : null;
  if (stored && stored.editedAt >= draft.editedAt) {
    // The project is as new as the working copy, or newer: it is the book.
    const same = await projectLibrary.sameDraft(id, draft);
    if (!same && longformSession.state.drafts[mode] === draft)
      updateDraft(mode, { ...stored, projectId: id }, false);
    setSaveState(mode, 'saved');
    return false;
  }
  if (legacy && project && (await projectLibrary.sameDraft(id, draft))) setSaveState(mode, 'saved');
  // Newer edits than the project's, or a book whose project was never written.
  else await saveLongformProject(mode);
  return legacy;
}
// As the app starts, before the open books are shown for editing.
void adoptLongformDrafts().catch(() => {});

/** Every project of the library, newest edit first, after the working drafts joined it. */
export async function listLongformProjects(): Promise<LongformProjectMeta[]> {
  await adoptLongformDrafts();
  return projectLibrary.list();
}

/** Why the open book of `mode` cannot be switched now, or null. */
export function switchBlocker(mode: Mode): string | null {
  return longformSession.state.active === mode ? tr('library.busy_rendering') : null;
}

function assertCanSwitch(mode: Mode) {
  const reason = switchBlocker(mode);
  if (reason) throw new Error(reason);
}

/** Settings a new book starts with: how the last one was read, not what it said. */
function newDraft(mode: Mode): Draft {
  const current = longformSession.state.drafts[mode];
  return {
    ...blankLongformDraft(),
    voice: current.voice,
    language: current.language,
    format: current.format,
    overrides: { ...current.overrides },
    globalSpeed: current.globalSpeed,
  };
}

/** A finished render to show with a book it is opened in. */
export interface RenderOutput {
  output: string;
  /** Its chapters, when the project did not keep what it was shown with. */
  chapters?: AudiobookRenderChapter[];
}

type OutputDetails = Pick<
  Draft,
  'outputScript' | 'outputChapters' | 'outputCachedChapters' | 'outputFailedChapters'
>;
const outputDetails = (draft: Draft): OutputDetails => ({
  outputScript: draft.outputScript,
  outputChapters: draft.outputChapters,
  outputCachedChapters: draft.outputCachedChapters,
  outputFailedChapters: draft.outputFailedChapters,
});

/**
 * Before another finished file takes the place of the one `draft` shows, the
 * project keeps what that one was shown with (script, chapters), so opening
 * it again brings them back. Best-effort: losing them costs no audio.
 */
function keepShownRender(draft: Draft): Promise<void> {
  if (!draft.projectId || !draft.output) return Promise.resolve();
  return projectLibrary
    .keepRender(draft.projectId, draft.output, outputDetails(draft))
    .catch(() => {});
}

/** What a project kept about one of its renders, checked; null when it kept nothing usable. */
async function keptRender(id: string, output: string): Promise<OutputDetails | null> {
  const kept = await projectLibrary.renderDetails(id, output).catch(() => null);
  const draft = kept && restoreDraft({ ...kept, script: '', lines: [] });
  return draft ? outputDetails(draft) : null;
}

/**
 * Open a library project in its editor, after the open book of that mode is
 * saved; with `render`, that finished file is the one shown. Refused (with
 * the reason) while that mode renders. Resolves to the project's mode.
 */
export async function openLongformProject(id: string, render?: RenderOutput): Promise<Mode> {
  await adoptLongformDrafts();
  const project = await projectLibrary.get(id);
  if (!project) throw new Error(tr('library.missing'));
  const mode = project.mode;
  assertCanSwitch(mode);
  if (longformSession.state.drafts[mode].projectId !== id) {
    const draft = restoreDraft(project.draft);
    if (!draft) throw new Error(tr('library.unreadable'));
    await saveLongformProject(mode);
    assertCanSwitch(mode);
    updateDraft(mode, { ...draft, projectId: id }, false);
    setSaveState(mode, 'saved');
  }
  const open = longformSession.state.drafts[mode];
  if (render?.output && render.output !== open.output) {
    // The render shown until now, and the one opened, each keep their details.
    const kept = await keptRender(id, render.output);
    await keepShownRender(open);
    if (longformSession.state.drafts[mode].projectId === id)
      updateDraft(mode, {
        output: render.output,
        ...(kept ?? {
          outputScript: '',
          outputChapters: render.chapters ?? [],
          outputCachedChapters: 0,
          outputFailedChapters: 0,
        }),
      });
  }
  return mode;
}

/** Start a new, empty book in `mode`; it becomes a project on its first edit. */
export async function newLongformProject(mode: Mode): Promise<void> {
  assertCanSwitch(mode);
  await saveLongformProject(mode);
  assertCanSwitch(mode);
  updateDraft(mode, { ...newDraft(mode), projectId: null }, false);
  setSaveState(mode, 'idle');
}

/** Create a project from a draft that is not in the library (a render's book) and open it. */
export async function createLongformProject(
  mode: Mode,
  draft: Partial<Draft>,
  name: string,
): Promise<Mode> {
  assertCanSwitch(mode);
  const taken = (await listLongformProjects()).map((project) => project.name);
  const meta = await projectLibrary.create(
    mode,
    { ...blankLongformDraft(), ...draft, projectId: null },
    name.trim() || untitledName(mode, taken),
  );
  return openLongformProject(meta.id);
}

export async function renameLongformProject(id: string, name: string): Promise<void> {
  await projectLibrary.rename(id, name);
  void queryClient.invalidateQueries({ queryKey: ['longform-projects'] });
}

/** Copy a project (the open one as it stands now) under a new name; the copy is not opened. */
export async function duplicateLongformProject(id: string, name: string) {
  for (const mode of MODES)
    if (longformSession.state.drafts[mode].projectId === id) await saveLongformProject(mode);
  const meta = await projectLibrary.duplicate(id, name);
  void queryClient.invalidateQueries({ queryKey: ['longform-projects'] });
  return meta;
}

/**
 * Delete a project from the library. Its rendered audio files are not
 * touched. The open book of a mode, once deleted, gives way to a new empty one.
 */
export async function deleteLongformProject(id: string): Promise<void> {
  const mode = MODES.find((m) => longformSession.state.drafts[m].projectId === id);
  if (mode) {
    assertCanSwitch(mode);
    cancelAutosave(mode);
    lineage[mode] += 1;
    await saveChains[mode];
  }
  await projectLibrary.remove(id);
  if (mode && longformSession.state.drafts[mode].projectId === id) {
    cancelAutosave(mode);
    updateDraft(mode, { ...newDraft(mode), projectId: null }, false);
    setSaveState(mode, 'idle');
  }
  void queryClient.invalidateQueries({ queryKey: ['longform-projects'] });
}
let controller: AbortController | null = null;
export function stopLongform() {
  if (controller) patch({ stopped: true });
  controller?.abort();
}
/**
 * The language tag of a book read in `language` (a picker label such as
 * "Vietnamese"): its text's own language, which the app's may not be. ''
 * for "Auto" or a name it does not know — in HTML, a language not known.
 */
export function bookLanguageTag(language: string): string {
  return LANG_CODES.find((entry) => entry.label === language)?.code ?? '';
}

/** What a render of `draft` reads its text with: the options, voices, cast and language. */
function readingInputs(mode: Mode, draft: Draft) {
  const names = parseCastNames(
    mode === 'audiobook' ? draft.script : draft.lines.map((line) => line.text).join('\n'),
    draft.voiceCast,
  );
  const voice_map = Object.fromEntries(
    names
      .filter((name) => castVoice(draft.voiceCast, name))
      .map((name) => [name, castVoice(draft.voiceCast, name)]),
  );
  // Like the cast, only the voices this script uses: a volume left on a
  // removed name must not move the cache key.
  const voice_gains = voiceGainsToRequest(draft.voiceGains, [
    '',
    ...names.map((name) => voiceGainKey(name)),
  ]);
  return {
    ...overridesToRequest(draft.overrides, draft.language),
    ...(voice_gains ? { voice_gains } : {}),
    default_voice: draft.voice,
    voice_map,
    language: draft.language,
  };
}

export function renderBody(mode: Mode, draft: Draft) {
  const common = {
    ...readingInputs(mode, draft),
    format: draft.format,
    metadata: { ...draft.metadata, title: draft.title },
    loudness: draft.loudness,
    cover_path: draft.cover?.path ?? null,
  };
  return mode === 'audiobook'
    ? { ...common, text: draft.script, lexicon: lexiconMap(draft.lexicon) }
    : {
        ...common,
        chapters: storyToSpans(draft.lines, draft.cast, draft.globalSpeed),
      };
}
export async function renderLongform(mode: Mode, resumeId?: string) {
  if (controller) return;
  const current = new AbortController();
  controller = current;
  const finishActivity = beginAppActivity('longform');
  patch({
    active: mode,
    stage: 'starting',
    completed: 0,
    total: 0,
    failed: 0,
    error: null,
    failure: null,
    chapters: [],
    timing: null,
    stopped: false,
  });
  let done = false;
  let outputChapters: AudiobookRenderChapter[] = [];
  let timing: RenderTiming | null = null;
  try {
    // The book is saved as it starts rendering, and the render names its project.
    if (!resumeId) void saveLongformProject(mode).catch(() => {});
    const draft = longformSession.state.drafts[mode];
    // The book this render belongs to: its file goes to that book only.
    const owner = draft.projectId;
    if (
      !resumeId &&
      !cachedTtsLanguagesSupported(queryClient, mode === 'stories' ? 'longform' : 'audiobook', [
        draft.language,
      ])
    ) {
      throw new Error(tr('languagePicker.chooseSupported'));
    }
    const response = await apiFetch(
      resumeId
        ? '/audiobook/resume/' + encodeURIComponent(resumeId)
        : mode === 'stories'
          ? '/longform/render'
          : '/audiobook',
      {
        method: 'POST',
        signal: current.signal,
        ...(resumeId
          ? {}
          : {
              body: JSON.stringify({
                ...renderBody(mode, draft),
                ...(draft.projectId ? { project_id: draft.projectId } : {}),
              }),
              headers: { 'Content-Type': 'application/json' },
            }),
      },
    );
    await consumeLongformStream(
      response,
      (event) => {
        if (event.type === 'error') {
          const failure = publicFailureFromEvent(event, 'Render failed');
          patch({ failure });
          throw new Error(failure.reason);
        }
        if (event.type === 'started') {
          outputChapters = Array.from({ length: Number(event.chapters) || 0 }, () => ({
            title: '',
            status: 'pending',
          }));
          timing = renderTiming(mode, resumeId ? null : draft, outputChapters.length);
          patch({
            stage: 'rendering',
            total: Number(event.chapters) || 0,
            chapters: outputChapters.map((chapter, index) => ({
              ...chapter,
              status: index === 0 ? 'rendering' : 'pending',
            })),
            timing,
          });
        }
        if (event.type === 'chapter' || event.type === 'chapter_error') {
          const index = Number(event.index);
          if (Number.isInteger(index) && index >= 0 && index < outputChapters.length)
            outputChapters[index] = {
              // An untitled chapter's title is the render's English "Chapter N":
              // left blank, every list names it in the app's language.
              title: typeof event.title === 'string' && event.untitled !== true ? event.title : '',
              ...(event.untitled === true ? { untitled: true } : {}),
              status: event.type === 'chapter_error' ? 'failed' : event.cached ? 'cached' : 'done',
              ...(Number.isFinite(Number(event.duration_s))
                ? { duration_s: Number(event.duration_s) }
                : {}),
              ...(event.duration_ms != null && Number.isFinite(Number(event.duration_ms))
                ? { duration_ms: Number(event.duration_ms) }
                : {}),
              ...(suspectPhrases(event).length ? { suspects: suspectPhrases(event) } : {}),
              ...(uncheckedPhrases(event)
                ? {
                    unchecked: uncheckedPhrases(event),
                    ...(recognizerMissing(event) ? { noRecognizer: true } : {}),
                  }
                : {}),
              ...(chapterLevels(event) ? { levels: chapterLevels(event) } : {}),
              ...(event.type === 'chapter_error'
                ? {
                    error:
                      typeof event.reason === 'string'
                        ? event.reason
                        : typeof event.error === 'string'
                          ? event.error
                          : '',
                  }
                : {}),
            };
          if (timing && Number.isInteger(index) && index >= 0 && index < outputChapters.length) {
            const at = performance.now();
            timing = {
              ...timing,
              finishedAt: timing.finishedAt.map((time, chapterIndex) =>
                chapterIndex === index ? at : time,
              ),
            };
          }
          patch({
            completed: Number(event.index) + 1,
            chapters: outputChapters.map((chapter, chapterIndex) => ({
              ...chapter,
              status:
                chapterIndex === index + 1 && chapter.status === 'pending'
                  ? 'rendering'
                  : chapter.status,
            })),
            timing,
          });
        }
        if (event.type === 'progress' && timing) {
          // Inside a chapter: what it waits for, then take by take (newer backends).
          const progress = takeProgress(event, performance.now());
          if (progress && progress.index < outputChapters.length) {
            timing = { ...timing, progress };
            patch({ timing });
          }
        }
        if (event.type === 'assembling') patch({ stage: 'assembling' });
        if (event.type === 'stopped') {
          done = true;
          patch({ stopped: true });
        }
        if (event.type === 'done' && typeof event.output === 'string' && event.output) {
          done = true;
          const failed = Array.isArray(event.failed_chapters)
            ? event.failed_chapters.length
            : Number(event.failed_chapters) || 0;
          const shown = longformSession.state.drafts[mode];
          if (shown.projectId === owner) {
            void keepShownRender(shown);
            updateDraft(mode, {
              output: event.output,
              outputScript: mode === 'audiobook' && !resumeId ? draft.script : '',
              outputChapters: outputChapters.map((chapter) => ({ ...chapter })),
              outputCachedChapters: Number(event.cached_chapters) || 0,
              outputFailedChapters: failed,
            });
          }
          patch({
            failed,
          });
        }
      },
      { signal: current.signal },
    );
    if (!done && !current.signal.aborted) throw new Error('Render stream ended before completion');
  } catch (error) {
    if (!current.signal.aborted)
      patch({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    finishActivity();
    if (controller === current) {
      controller = null;
      patch({ active: null, stage: '' });
    }
  }
}

/** An interrupted render as `GET /audiobook/jobs` lists it (the fields resuming reads). */
export interface ResumableRender {
  job_id: string;
  title?: string;
  /** The library project it renders; renders started before the library name none. */
  project_id?: string | null;
}

/**
 * Resume an interrupted render into the book it belongs to: its project is
 * opened first (the open book saved), so the finished file never lands in
 * another book. A render that names no project (started before the library,
 * or its project since deleted) finishes in a new book of its own.
 */
export async function resumeLongform(mode: Mode, job: ResumableRender): Promise<void> {
  if (controller) return;
  patch({ error: null, failure: null });
  try {
    const owner = job.project_id || null;
    const isOpen = owner !== null && longformSession.state.drafts[mode].projectId === owner;
    let target = mode;
    if (!isOpen && owner && (await projectLibrary.get(owner).catch(() => null)))
      target = await openLongformProject(owner);
    else if (!isOpen) {
      await newLongformProject(mode);
      if (job.title?.trim()) updateDraft(mode, { title: job.title.trim() });
    }
    await renderLongform(target, job.job_id);
  } catch (error) {
    patch({ error: error instanceof Error ? error.message : String(error) });
  }
}

export function dismissLongformError(): void {
  patch({ error: null, failure: null });
}

export function chapterPreviewBody(draft: Draft, chapter_index: number) {
  const body = readingInputs('audiobook', draft);
  return {
    ...overridesToRequest(draft.overrides, draft.language),
    ...(body.voice_gains ? { voice_gains: body.voice_gains } : {}),
    text: draft.script,
    chapter_index,
    default_voice: body.default_voice,
    voice_map: body.voice_map,
    language: body.language,
    // Not strict: the outline and audition freshness read this on every edit,
    // and a word typed twice must not take the page down (previews wait for it).
    lexicon: lexiconMap(draft.lexicon, { strict: false }),
  };
}

/** `/audiobook/outline`'s request: the chapter preview's inputs, and the last book. */
export function outlineRequest(draft: Draft) {
  const { chapter_index: _index, ...body } = chapterPreviewBody(draft, 0);
  return { ...body, output: draft.output || null };
}

/** Where a passage preview is read in its book: `/audiobook/preview`'s `context`. */
export interface PassageContext {
  /** The script text of the chapter the passage is part of, its `# Title` line included. */
  chapter: string;
  /** Where the passage starts and ends in that text. */
  start: number;
  end: number;
}

/**
 * Where the passage `from…to` of the script is read: its chapter's text and
 * its place in it. A passage preview sends it, so its sentences are the
 * book's own takes there — a sentence the chapter said before it is the
 * repeat it is in the book, and a retake asked for in the chapter is what
 * plays. `null` when the passage runs across chapters, or reads none.
 */
export function passageContext(script: string, from: number, to: number): PassageContext | null {
  const text = normalizeNewlines(script);
  const chapter = scriptOutline(text).findLast((node) => node.start <= from);
  if (!chapter || chapter.plan === null || to > chapter.end) return null;
  return {
    chapter: text.slice(chapter.start, chapter.end),
    start: from - chapter.start,
    end: to - chapter.start,
  };
}

/**
 * The Audiobook chapter at `offset` of the script, as "Retake this sentence"
 * reaches it: the chapter preview's request, and its stretch of the script
 * (offsets into the editor's text). `null` where nothing is read.
 */
export function audiobookRetakeChapter(draft: Draft, offset: number): RetakeChapter | null {
  const text = normalizeNewlines(draft.script);
  const chapter = scriptOutline(text).findLast((node) => node.start <= offset);
  if (!chapter || chapter.plan === null) return null;
  return {
    api: 'audiobook',
    body: chapterPreviewBody(draft, chapter.plan),
    index: chapter.plan,
    sources: [{ id: 'script', text, from: chapter.start, to: chapter.end, headings: true }],
  };
}

/**
 * The Stories chapter holding line `lineId`, as "Retake this sentence"
 * reaches it: its lines, from the chapter line before it (or the story's
 * start) to the next one, posted as the render posts that chapter. `null` on
 * a chapter line, or in a chapter with nothing to read.
 */
export function storyRetakeChapter(draft: Draft, lineId: string): RetakeChapter | null {
  const at = draft.lines.findIndex((line) => line.id === lineId);
  if (at < 0 || isChapterLine(draft.lines[at].text)) return null;
  let from = at;
  while (from > 0 && !isChapterLine(draft.lines[from - 1].text)) from -= 1;
  let to = at + 1;
  while (to < draft.lines.length && !isChapterLine(draft.lines[to].text)) to += 1;
  const lines = draft.lines.slice(from, to);
  // A chapter starts over at every chapter line, so this one compiles alone
  // exactly as it does inside the whole story.
  const [chapter] = storyToSpans(lines, draft.cast, draft.globalSpeed);
  if (!chapter) return null;
  return {
    api: 'longform',
    body: { ...readingInputs('stories', draft), chapter },
    sources: lines.map((line) => ({ id: line.id, text: normalizeNewlines(line.text) })),
  };
}

/** Where the Contents outline keeps its answer to `request` (the request's JSON). */
export function outlineQueryKey(request: string) {
  return ['audiobook-outline', request] as const;
}

/**
 * The clock of a render of `count` chapters that starts now, with what tells
 * its chapters apart: the words of each, as `draft` plans them, and for a
 * book which ones the Contents outline last found cached — it asks with the
 * render's own inputs. A resume (`draft` null) renders a book this editor may
 * no longer hold, so neither is known; nor is what is cached once a settings
 * change (the performance preset, say) has the outline asking again.
 */
function renderTiming(mode: Mode, draft: Draft | null, count: number): RenderTiming {
  const words = draft && chapterWords(mode, draft);
  const asked =
    draft && mode === 'audiobook'
      ? queryClient.getQueryState<{ chapters?: { cached?: boolean | null }[] }>(
          outlineQueryKey(JSON.stringify(outlineRequest(draft))),
        )
      : undefined;
  const outline = asked?.isInvalidated ? undefined : asked?.data;
  const cached = outline?.chapters?.map((chapter) => chapter.cached ?? null);
  return {
    startedAt: performance.now(),
    finishedAt: Array.from({ length: count }, () => null),
    // Counted here the way the render splits the chapters; on any mismatch, unknown.
    words: words?.length === count ? words : null,
    cached: cached?.length === count ? cached : null,
    progress: null,
  };
}

/** The words each chapter of `draft`'s render reads, in the render's chapter order. */
function chapterWords(mode: Mode, draft: Draft): number[] {
  return mode === 'audiobook'
    ? scriptOutline(draft.script).flatMap((chapter) =>
        chapter.plan === null ? [] : [chapter.words],
      )
    : storyToSpans(draft.lines, draft.cast, draft.globalSpeed).map(
        (chapter) => scriptStats(chapter.spans.map((span) => span.text).join('\n')).words,
      );
}
