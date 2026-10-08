import { readTextFile } from '@shared/utils/readTextFile';
import {
  BookOpenTextIcon,
  FileAudioIcon,
  FingerprintIcon,
  ImportIcon,
  LanguagesIcon,
  Trash2Icon,
} from 'lucide-react';
import { AudioLinesIcon } from 'lucide-react';
import { SecondarySidebar } from '@/components/workspace-sidebar';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { PipelineFailure } from '@/components/pipeline-failure';
import { importToText } from '@shared/utils/importStory';
import { cueSheetFor } from './cue-sheet';
import { saveLocalFile } from '@/lib/local-export';
import { StoryCast, StoryEditor } from './story-editor';
import { clearedScriptPatch, scriptSize } from './story-clear';
import { ConfirmDialog } from '../clone/confirm-dialog';
import { MarkupToolbar } from './markup-toolbar';
import { MarkupTextarea } from './markup-textarea';
import { MarkupEditorTools } from './markup-editor-tools';
import { measureWidth, useEditorMeasure } from './editor-measure';
import { EditorStatusBar, MeasureToggle, createCaretSource } from './editor-status-bar';
import { insertImageLine, passageBounds, previewPassage } from './script-markup';
import { useImagePicker } from './image-library';
import { usePassagePreview } from './passage-preview';
import { usePreviewLock, usePreviewSettings, useRetakeHearing } from './preview-run';
import { TakeProgressText } from './generation-progress';
import { paragraphsAround, useRetakes } from './take-retake';
import type { RetakenChapter } from './chapter-previews';
import { storyVoicesReady } from './story-inputs';
import { StorySpeed } from './story-speed';
import { ProjectSwitcher } from './project-settings';
import { ProductionSettings } from './production-settings';
import { PacingSettings, SpeechCheckReport } from './pacing-settings';
import { BookOutline } from './book-outline';
import { ContentsRail } from './contents-rail';
import { outlineStats, scriptOutline } from './script-outline';
import { useEditorZoom, useEditorZoomInput, zoomedText } from './editor-zoom';
import { ExportHtmlButton } from './html-export-dialog';
import { ExportVideoButton } from './video-export-dialog';
import { castVoice } from './cast-map';
import { CastSettings, showsCastPanel } from './cast-settings';
import { bookAutoLevels } from './auto-levels';
import { ProfilesFailure, VoicePicker, profileListState } from './voice-picker';
import {
  parseCastNames,
  scriptStats,
  formatRuntimeClock,
  validateScript,
} from '@shared/utils/audiobookScript';
import { BookSettings } from './book-settings';
import { duplicateWords } from './book-options';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DownloadIcon, ListIcon, PlayIcon, SparklesIcon, SquareIcon, XIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { WaveformPlayer } from '@/components/waveform-player';
import { SyncedAudiobookPlayer } from './synced-audiobook-player';
import { StoryReaderButton } from './story-reader';
import { coverUrl } from './slideshow';
import { LongformGeneratePanel } from './generate-panel';
import { generateBlockers } from './generate-blocker';
import { LONGFORM_TARGET } from './generate-gates';
import { EngineNotice } from '@/components/engine-notice';
import { ValidationWarnings, type ScriptWarning } from './validation-warnings';
import { getBridge } from '@/components/bridge';
import { useProfiles } from '@/hooks/use-profiles';
import { useSettledText } from '@/hooks/use-settled-text';
import { apiJson, apiPath, describeError } from '@/lib/api/client';
import { saveExport } from '@/lib/export-history';
import { EngineLanguagePicker } from '@/features/clone/engine-language-picker';
import { LANG_CODES } from '@shared/utils/languages';
import {
  audiobookRetakeChapter,
  bookLanguageTag,
  editLongform,
  dismissLongformError,
  passageContext,
  renderLongform,
  resumeLongform,
  stopLongform,
  storyRetakeChapter,
  storiesImportEpoch,
  useDraftField,
  useLongformActive,
  useLongformDraft,
  useLongformState,
  type Draft,
  type Mode,
} from './longform-session';
import { SAMPLE_AUDIOBOOK_SCRIPT } from '@shared/data/sampleAudiobook';
import { useTtsReadiness } from '@/hooks/use-tts-readiness';
import { useReadingSettings } from '@/lib/reading-settings';
/** Built once: the page re-renders on every keystroke in the script. */
const BOOK_LANGUAGES = ['Auto', ...LANG_CODES.map((item) => item.label)];
/** How long typing pauses before the script's warnings are read again. */
const WARNINGS_DELAY_MS = 500;

/**
 * `next`, or the array equal to it item by item that this hook returned last:
 * an array worked out anew on every keystroke keeps one identity while its
 * items stay, so what it is passed to can skip rendering.
 */
function useSameArray<T extends readonly unknown[]>(next: T): T {
  const [kept, setKept] = useState(next);
  const same =
    kept === next ||
    (kept.length === next.length && kept.every((item, index) => Object.is(item, next[index])));
  if (!same) setKept(next);
  return same ? kept : next;
}

interface Recovery {
  job_id: string;
  /** `audiobook` or `story`. */
  type: string;
  title: string;
  chapters_done: number;
  total_chapters: number;
  /** The library project it renders (newer backends; none before the library). */
  project_id?: string | null;
}
export function LongformPage({ mode }: { mode: Mode }) {
  const { t } = useTranslation();
  // The session a field at a time: a keystroke changes the draft alone.
  const draft = useLongformDraft(mode);
  const active = useLongformActive();
  const renderError = useLongformState((session) => session.error);
  const renderFailure = useLongformState((session) => session.failure);
  const storageError = useLongformState((session) => session.storageError);
  const ttsOperation = mode === 'stories' ? 'longform' : 'audiobook';
  const ttsBlocker = useTtsReadiness(ttsOperation);
  const text =
    mode === 'audiobook' ? draft.script : draft.lines.map((line) => line.text).join('\n');
  // One array while the script names the same voices, as most edits leave it.
  const names = useSameArray(
    useMemo(() => parseCastNames(text, draft.voiceCast), [text, draft.voiceCast]),
  );
  // A book is counted from its outline, as its Contents are: an edit counts
  // again the one chapter it is in.
  const stats = useMemo(
    () => (mode === 'audiobook' ? outlineStats(scriptOutline(text)) : scriptStats(text)),
    [mode, text],
  );
  const statsLine = t('audiobook.stats', {
    chapters: stats.chapters,
    words: stats.words,
    runtime: formatRuntimeClock(stats.runtimeSec),
  });
  const profilesQuery = useProfiles();
  // Until the profiles arrive, a chosen voice is unknown, not missing; a
  // failed load says so, with a retry, instead of loading for ever.
  const { profiles, loading: profilesLoading } = profileListState(profilesQuery);
  const [importing, setImporting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // The script whose warnings were dismissed: they stay hidden until the
  // script they describe changes.
  const [warningsDismissedFor, setWarningsDismissedFor] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const audiobookInput = useRef<HTMLTextAreaElement>(null);
  const [caret] = useState(() => createCaretSource());
  // Ctrl/⌘ +, −, 0 and Ctrl+wheel size the script's text while in its frame.
  const editorFrame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useEditorZoom();
  const [measure, setMeasure] = useEditorMeasure();
  useEditorZoomInput(editorFrame);
  const locked = !!active || importing;
  const scriptLines = scriptSize(mode, draft);
  const query = useQuery({
    queryKey: ['longform-recovery'],
    queryFn: ({ signal }) => apiJson<{ jobs: Recovery[] }>('/audiobook/jobs', { signal }),
  });
  useEffect(() => {
    if (!active) void query.refetch();
  }, [active]);
  const set = useCallback((value: Partial<Draft>) => editLongform(mode, value), [mode]);
  // The script editor, for the tools that edit it: the toolbar, the contents.
  const scriptTarget = useCallback(
    () =>
      audiobookInput.current && {
        element: audiobookInput.current,
        setText: (script: string) => set({ script }),
      },
    [set],
  );
  // The book's pictures: each tag on a line of its own.
  const imagePicker = useImagePicker(insertImageLine);
  const usable =
    mode === 'audiobook'
      ? draft.script.trim().length > 0
      : draft.lines.some((line) => line.text.trim() && !line.text.trim().startsWith('#'));
  const castReady = names.every(
    (name) =>
      !castVoice(draft.voiceCast, name) ||
      profiles.some((profile) => profile.id === castVoice(draft.voiceCast, name)),
  );
  const defaultVoice = profiles.find((profile) => profile.id === draft.voice);
  // Audiobook: its narrator. Stories: a voice for every spoken line.
  const voiceReady = mode === 'stories' ? storyVoicesReady(draft, profiles) : Boolean(defaultVoice);
  const voicesReady = castReady && voiceReady;
  // Stories reads a profile id inside [voice:…] directly; only readable names
  // need a mapping, so only those are listed for casting.
  const inlineNames = useMemo(
    () => names.filter((name) => !profiles.some((profile) => profile.id === name)),
    [names, profiles],
  );
  // Hints about the script, not checks on it: read once typing pauses, and
  // at once for a script replaced (another book, Clear, an import).
  const settledScript = useSettledText(draft.script, WARNINGS_DELAY_MS);
  const warnings = useMemo(
    () =>
      mode === 'audiobook'
        ? (validateScript(settledScript, {
            mappedNames: Object.keys(draft.voiceCast).filter((name) =>
              Boolean(draft.voiceCast[name]),
            ),
            profileIds: profiles.map((profile) => profile.id),
          }) as ScriptWarning[])
        : [],
    [settledScript, draft.voiceCast, mode, profiles],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // One preview (a passage, a chapter, a Stories line) renders at a time and
  // Generate waits for it; the editor, cast and settings stay open meanwhile.
  const previews = usePreviewLock();
  const blockers = useSameArray(
    generateBlockers({
      mode,
      busyElsewhere: Boolean(active) && active !== mode,
      importing,
      previewing: previews.busy,
      tts: ttsBlocker,
      usable,
      voicesReady,
      defaultVoiceReady: Boolean(defaultVoice),
      castReady,
      duplicateLexicon: duplicateWords(draft.lexicon),
    }),
  );
  const needsDefaultVoice = blockers.includes('default_voice');
  const canPreview = ttsBlocker === null && voicesReady && !duplicateWords(draft.lexicon);
  // The engine, preset and reading a preview renders under: one rendered
  // under others is outdated.
  const previewSettings = usePreviewSettings(draft.overrides.reading);
  const passage = usePassagePreview(draft, previews);
  // Offsets come from the editor, so they index its (newline-normalized)
  // value. The passage goes with where it is read, so it reads the book's
  // own takes there.
  const previewRange = (from: number, to: number) => {
    const input = audiobookInput.current;
    if (!input) return;
    const [start, end] = passageBounds(input.value, from, to);
    void passage.preview(
      previewPassage(input.value, from, to),
      passageContext(input.value, start, end),
    );
  };
  const previewSelection = () => {
    const input = audiobookInput.current;
    if (input) previewRange(input.selectionStart ?? 0, input.selectionEnd ?? 0);
  };
  // "Retake this sentence" needs the takes kept one by one: the book (or
  // Settings → Reading) reads sentence by sentence.
  const { reading: appReading } = useReadingSettings();
  const phrases = (draft.overrides.reading ?? appReading).phraseRendering !== false;
  const queryClient = useQueryClient();
  const [retaken, setRetaken] = useState<RetakenChapter | null>(null);
  const retakenNotice = (takes: number) =>
    takes > 1 ? t('editor.retaken_many', { count: takes }) : t('editor.retaken');
  const hearRetake = useRetakeHearing(previews, passage.stop);
  const retakes = useRetakes({
    chapterAt: (editor, offset) =>
      mode === 'audiobook'
        ? audiobookRetakeChapter(draft, offset)
        : storyRetakeChapter(draft, editor),
    onRetaken: ({ chapter, takes }) => {
      if (mode === 'stories') {
        // A story is heard from its render, which reads them anew.
        toast.success(retakenNotice(takes.length));
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['audiobook-outline'] });
      const index = chapter.index;
      if (index !== undefined) setRetaken((last) => ({ chapter: index, id: (last?.id ?? 0) + 1 }));
      // Heard where they are read: the paragraphs holding them — at once, or
      // once a preview reading the old take has stopped — unless the script
      // was edited meanwhile, and they are elsewhere now.
      const input = audiobookInput.current;
      if (!input || input.value !== chapter.sources[0]?.text) return;
      const text = input.value;
      const range = paragraphsAround(text, takes);
      hearRetake(index, {
        play: () => {
          if (audiobookInput.current?.value === text) previewRange(...range);
        },
        // Another chapter's preview renders on: the next render reads it.
        later: () => toast.success(retakenNotice(takes.length)),
      });
    },
  });
  const canRetake = phrases && (mode === 'audiobook' ? canPreview : ttsBlocker === null);
  // The Cast panel lists these names; Stories reads a profile id inline as is.
  const casting = (mode === 'audiobook' ? names : inlineNames).length > 0;
  const setup = useMemo(
    () => ({ engine: ttsBlocker, usable, voiceReady, casting, castReady }),
    [ttsBlocker, usable, voiceReady, casting, castReady],
  );
  const generate = useCallback(() => void renderLongform(mode), [mode]);
  // The same element while what it shows stays: typing leaves it be.
  const generatePanel = useMemo(
    () => (
      <LongformGeneratePanel
        mode={mode}
        blockers={blockers}
        setup={setup}
        onGenerate={generate}
        onStop={stopLongform}
      />
    ),
    [mode, blockers, setup, generate],
  );
  const importFile = async (file: File) => {
    const importEpoch = storiesImportEpoch.current;
    setImporting(true);
    setLocalError(null);
    try {
      let text: string;
      if (mode === 'stories' && /\.(txt|md|srt|vtt)$/i.test(file.name))
        text = importToText(file.name, await readTextFile(file));
      else {
        const body = new FormData();
        body.set('file', file);
        const data = await apiJson<{ text: string }>('/audiobook/import', {
          method: 'POST',
          body,
        });
        text = data.text;
      }
      if (mode === 'stories' && importEpoch !== storiesImportEpoch.current) return;
      set(mode === 'audiobook' ? { script: text } : { importText: text });
    } catch (cause) {
      if (mode === 'stories' && importEpoch !== storiesImportEpoch.current) return;
      setLocalError(describeError(cause));
    } finally {
      setImporting(false);
    }
  };
  const download = async () => {
    setExporting(true);
    setLocalError(null);
    try {
      const url = apiPath('/audio/' + encodeURIComponent(draft.output));
      const bridge = getBridge();
      if (bridge) await saveExport(url, draft.output.split('/').pop() || 'audiobook.m4b');
      else {
        const link = document.createElement('a');
        link.href = url;
        link.download = draft.output;
        link.click();
      }
    } catch (cause) {
      setLocalError(describeError(cause));
    } finally {
      setExporting(false);
    }
  };
  // The m4b embeds its chapters, but mp3 has no portable way to carry them, and
  // players, podcast hosts and show-notes want the timestamps as text. What
  // belongs in the sheet is decided in cue-sheet.ts; this only saves it.
  const cueSheet = cueSheetFor(draft.outputChapters, draft.output, (n) =>
    t('audiobook.chapter_n', { n }),
  );
  const downloadCueSheet = async () => {
    if (!cueSheet) return;
    setLocalError(null);
    try {
      // Native save dialog under Electron, like every other local export.
      await saveLocalFile(
        new Blob([cueSheet.body], { type: 'text/plain;charset=utf-8' }),
        cueSheet.filename,
      );
    } catch (cause) {
      setLocalError(describeError(cause));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader>
        <h1 className="text-sm font-medium">
          {t(mode === 'stories' ? 'nav.stories' : 'audiobook.title')}
        </h1>
        <ProjectSwitcher mode={mode} />
        <Link
          to={mode === 'stories' ? '/audiobook' : '/stories'}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          {t(mode === 'stories' ? 'audiobook.title' : 'nav.stories')}
        </Link>
      </WorkspaceHeader>
      <div className="flex min-h-0 flex-1 @max-[40rem]:flex-col">
        <BookSetup
          mode={mode}
          locked={locked}
          names={names}
          inlineNames={inlineNames}
          needsDefaultVoice={needsDefaultVoice}
          jobs={query.data?.jobs}
          resumeBlocked={locked || ttsBlocker !== null || previews.busy}
          onBusy={setImporting}
          footer={generatePanel}
          onCollapsedChange={setSidebarCollapsed}
        />
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* The column fills the room beside the setup pane: the editor's
              text keeps to its reading measure inside the frame, and the
              contents rail takes a share of a wide one. */}
          <div className="flex w-full min-h-0 flex-1 flex-col gap-4 px-6 py-5">
            <div className="flex items-center justify-between gap-3">
              {/* The actions keep together at the end of a wide column. */}
              <div className="me-auto">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <BookOpenTextIcon className="size-4 text-muted-foreground" />
                  {t('clone.script')}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">{t(mode + '.subtitle')}</p>
              </div>
              <label className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <ImportIcon />
                {t('audiobook.import')}
                <input
                  aria-label={t('audiobook.import')}
                  type="file"
                  accept={
                    mode === 'stories' ? '.txt,.md,.srt,.vtt,.epub,.pdf' : '.txt,.md,.epub,.pdf'
                  }
                  disabled={locked}
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void importFile(file);
                  }}
                />
              </label>
              <Button
                variant="ghost"
                size="sm"
                title={t('stories.clearScriptHint')}
                disabled={locked || scriptLines === 0}
                onClick={() => setClearOpen(true)}
              >
                <Trash2Icon />
                {t('stories.clearScript')}
              </Button>
              <ConfirmDialog
                open={clearOpen}
                onOpenChange={setClearOpen}
                title={t('stories.clearScript')}
                description={
                  mode === 'audiobook'
                    ? t('stories.clearConfirmScript')
                    : t('stories.clearConfirm', { count: scriptLines })
                }
                confirmLabel={t('stories.clearScript')}
                onConfirm={() => set(clearedScriptPatch(mode))}
              />
              {mode === 'audiobook' && !draft.script.trim() && (
                <Button
                  variant="ghost"
                  size="sm"
                  title={t('audiobook.load_sample_hint')}
                  disabled={locked}
                  onClick={() => set({ script: SAMPLE_AUDIOBOOK_SCRIPT })}
                >
                  <SparklesIcon />
                  {t('audiobook.load_sample')}
                </Button>
              )}
            </div>
            {mode === 'audiobook' ? (
              // No explicit min-height: the default (content size) keeps this
              // box from shrinking below the toolbar + editor in a short
              // window, so the page column scrolls instead of the editor
              // painting over the status bar and the finished-audiobook
              // player. `overflow-clip`, not `overflow-hidden`: a scroll
              // container would lose that content-size minimum.
              <div
                ref={editorFrame}
                data-slot="audiobook-editor"
                className="flex flex-1 flex-col overflow-clip rounded-xl border border-border/50 bg-background/30 focus-within:border-border"
              >
                {imagePicker.dialog}
                <MarkupToolbar
                  className="shrink-0 rounded-none border-0 border-b border-border/50"
                  getTarget={scriptTarget}
                  disabled={locked}
                  images={imagePicker.tools}
                  profiles={profiles}
                  loading={profilesLoading}
                  scriptNames={names}
                  voiceCast={draft.voiceCast}
                  onVoiceCast={(voiceCast) => set({ voiceCast })}
                  allowNewCharacter
                  actions={
                    passage.pending ? (
                      <>
                        {passage.progress && (
                          <span
                            role="status"
                            data-slot="passage-progress"
                            className="truncate text-xs text-muted-foreground tabular-nums"
                          >
                            <TakeProgressText progress={passage.progress} timeLeft />
                          </span>
                        )}
                        <Button size="xs" variant="secondary" onClick={passage.stop}>
                          <SquareIcon className="fill-current" />
                          {t('common.stop')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={locked || !canPreview || previews.busy}
                        title={t('markup.preview_hint')}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={previewSelection}
                      >
                        <PlayIcon />
                        {t('markup.preview')}
                      </Button>
                    )
                  }
                />
                {passage.output && (
                  <div className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-muted/20 py-1 ps-3 pe-1">
                    <div className="min-w-0 flex-1">
                      <WaveformPlayer
                        autoPlay
                        showWaveform={false}
                        src={apiPath('/audio/' + encodeURIComponent(passage.output))}
                        source="passage-preview"
                      />
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('common.close')}
                      onClick={passage.dismiss}
                    >
                      <XIcon />
                    </Button>
                  </div>
                )}
                {(passage.error ||
                  passage.suspects.length > 0 ||
                  passage.unchecked > 0 ||
                  passage.empty) && (
                  <div className="shrink-0 space-y-2 border-b border-border/50 p-2">
                    {passage.error && (
                      <PipelineFailure
                        failure={passage.failure}
                        fallback={passage.error}
                        onDismiss={passage.dismiss}
                      />
                    )}
                    <SpeechCheckReport
                      suspects={passage.suspects}
                      unchecked={passage.unchecked}
                      noRecognizer={passage.noRecognizer}
                    />
                    {passage.empty && (
                      <p role="status" className="px-1 text-xs text-muted-foreground">
                        {t('markup.preview_empty')}
                      </p>
                    )}
                  </div>
                )}
                <ContentsRail
                  previewing={previews.holder === 'chapter'}
                  outline={(rail) => (
                    <BookOutline
                      {...rail}
                      draft={draft}
                      disabled={locked}
                      canPreview={canPreview}
                      previews={previews}
                      retaken={retaken}
                      previewSettings={previewSettings}
                      getTarget={scriptTarget}
                    />
                  )}
                >
                  <MarkupEditorTools
                    className="flex min-h-96 min-w-0 flex-1 flex-col"
                    getTarget={scriptTarget}
                    disabled={locked}
                    images={imagePicker.tools}
                    headings
                    profiles={profiles}
                    loading={profilesLoading}
                    scriptNames={names}
                    voiceCast={draft.voiceCast}
                    onVoiceCast={(voiceCast) => set({ voiceCast })}
                    voiceGains={draft.voiceGains}
                    onVoiceGains={(voiceGains) => set({ voiceGains })}
                    defaultVoiceName={defaultVoice?.name}
                    onListen={canPreview && !previews.busy ? previewSelection : undefined}
                    onListenRange={canPreview && !previews.busy ? previewRange : undefined}
                    retakes={canRetake ? retakes.tools('script') : undefined}
                  >
                    <MarkupTextarea
                      textareaRef={audiobookInput}
                      data-gate-target={LONGFORM_TARGET.script}
                      headings
                      gutter
                      activeLine
                      voices={names}
                      aria-label={t('clone.script')}
                      className="min-h-96 flex-1"
                      textClassName="px-4 py-3"
                      textStyle={zoomedText(zoom, 1, 1.75)}
                      measure={measureWidth(measure)}
                      value={draft.script}
                      placeholder={t('audiobook.script_placeholder')}
                      disabled={locked}
                      onCaretChange={caret.set}
                      onValueChange={(script) => set({ script })}
                    />
                  </MarkupEditorTools>
                </ContentsRail>
                <EditorStatusBar
                  className="shrink-0"
                  text={draft.script}
                  caret={caret}
                  headings
                  names={names}
                  voiceCast={draft.voiceCast}
                  profiles={profiles}
                  loading={profilesLoading}
                  defaultVoiceName={defaultVoice?.name}
                  stats={statsLine}
                  measure={measure}
                  onMeasureChange={setMeasure}
                  zoom={zoom}
                  onZoomChange={setZoom}
                />
              </div>
            ) : (
              // A story's lines are cards: at the reading width their column
              // keeps to the measure, centred, instead of each card's text.
              <div
                data-slot="story-measure"
                data-measure={measure}
                className={cn(
                  'flex w-full flex-1 flex-col',
                  measure === 'reading' && 'mx-auto max-w-[calc(100ch+4rem)]',
                )}
              >
                <StoryEditor
                  draft={draft}
                  profiles={profiles}
                  profilesLoading={profilesLoading}
                  disabled={locked}
                  canSynthesize={ttsBlocker === null}
                  retakes={canRetake ? retakes : undefined}
                  onChange={set}
                  onBusy={setImporting}
                  previews={previews}
                  previewSettings={previewSettings}
                />
              </div>
            )}
            {/* Audiobook shows these in its editor's status bar. */}
            {mode === 'stories' && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <p className="min-w-0">{statsLine}</p>
                <MeasureToggle measure={measure} onChange={setMeasure} className="ms-auto" />
              </div>
            )}
            {warningsDismissedFor !== settledScript && warnings.length > 0 && !active && (
              <ValidationWarnings
                warnings={warnings}
                onDismiss={() => setWarningsDismissedFor(settledScript)}
              />
            )}
            {renderError && (
              <PipelineFailure
                failure={renderFailure}
                fallback={renderError}
                onDismiss={dismissLongformError}
              />
            )}
            {localError && (
              <PipelineFailure fallback={localError} onDismiss={() => setLocalError(null)} />
            )}
            <EngineNotice operation={ttsOperation} />
            {storageError && (
              <div role="alert" className="text-sm text-destructive">
                {t('common.error')}
                <Link to="/settings/logs" className="ms-3 underline">
                  {t('settings.logs')}
                </Link>
              </div>
            )}
            {sidebarCollapsed && (
              // The setup pane is collapsed: keep Generate and the tracker in reach.
              <div className="sticky bottom-0 z-10 -mx-2 shrink-0 rounded-xl border border-border/60 bg-background/90 p-3 backdrop-blur-xl">
                {generatePanel}
              </div>
            )}
            {draft.output && (
              <section className="shrink-0 space-y-3 border-t border-border/50 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-medium">{t('audiobook.ready')}</h2>
                    {mode === 'audiobook' && draft.outputCachedChapters > 0 && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('audiobook.cached_note', {
                          count: draft.outputCachedChapters,
                        })}
                      </p>
                    )}
                    {draft.outputFailedChapters > 0 && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('audiobook.failed_note', {
                          count: draft.outputFailedChapters,
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {cueSheet && (
                      <Button variant="ghost" size="sm" onClick={() => void downloadCueSheet()}>
                        <ListIcon />
                        {t('audiobook.download_cues')}
                      </Button>
                    )}
                    <ExportHtmlButton draft={draft} mode={mode} disabled={exporting} />
                    <ExportVideoButton draft={draft} mode={mode} disabled={exporting} />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={exporting}
                      onClick={() => void download()}
                    >
                      <DownloadIcon />
                      {t('audiobook.download')}
                    </Button>
                  </div>
                </div>
                {mode === 'audiobook' ? (
                  <SyncedAudiobookPlayer
                    src={apiPath('/audio/' + encodeURIComponent(draft.output))}
                    script={draft.outputScript}
                    chapters={draft.outputChapters}
                    output={draft.output}
                    lang={bookLanguageTag(draft.language)}
                    cover={coverUrl(draft.cover)}
                  />
                ) : (
                  <div className="space-y-2">
                    <WaveformPlayer
                      showWaveform={false}
                      src={apiPath('/audio/' + encodeURIComponent(draft.output))}
                      source={'longform-' + mode}
                    />
                    <StoryReaderButton
                      src={apiPath('/audio/' + encodeURIComponent(draft.output))}
                      output={draft.output}
                      lang={bookLanguageTag(draft.language)}
                      cover={coverUrl(draft.cover)}
                    />
                  </div>
                )}
                <SpeechCheckReport chapters={draft.outputChapters} />
              </section>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The book's setup in the side column: its title, voices, language, format,
 * cast and settings, and the renders it can resume, with Generate (`footer`)
 * pinned under them. It reads the fields of the draft it shows itself, one
 * at a time, so an edit to the script — every keystroke — renders none of
 * it; and every change it makes is worked out from those fields as they are
 * now, never from a copy of the draft an earlier render held.
 */
const BookSetup = memo(function BookSetup({
  mode,
  locked,
  names,
  inlineNames,
  needsDefaultVoice,
  jobs,
  resumeBlocked,
  onBusy,
  footer,
  onCollapsedChange,
}: {
  mode: Mode;
  locked: boolean;
  /** The script's voice names, in the order they take their colors. */
  names: string[];
  /** Stories: the names it reads inline that are no profile id. */
  inlineNames: string[];
  needsDefaultVoice: boolean;
  /** Interrupted renders, of either mode (`GET /audiobook/jobs`). */
  jobs: Recovery[] | undefined;
  /** Why a render cannot resume now: locked, the engine, a preview. */
  resumeBlocked: boolean;
  onBusy(busy: boolean): void;
  footer: ReactNode;
  onCollapsedChange(collapsed: boolean): void;
}) {
  const { t } = useTranslation();
  const title = useDraftField(mode, 'title');
  const voice = useDraftField(mode, 'voice');
  const language = useDraftField(mode, 'language');
  const format = useDraftField(mode, 'format');
  const voiceCast = useDraftField(mode, 'voiceCast');
  const voiceGains = useDraftField(mode, 'voiceGains');
  const overrides = useDraftField(mode, 'overrides');
  const outputChapters = useDraftField(mode, 'outputChapters');
  const metadata = useDraftField(mode, 'metadata');
  const loudness = useDraftField(mode, 'loudness');
  const cover = useDraftField(mode, 'cover');
  const lexicon = useDraftField(mode, 'lexicon');
  // Stories' speed and cast read and write its lines: there, the whole draft.
  const story = useLongformState((session) => (mode === 'stories' ? session.drafts.stories : null));
  const set = useCallback((value: Partial<Draft>) => editLongform(mode, value), [mode]);
  const profilesQuery = useProfiles();
  const { profiles, loading: profilesLoading } = profileListState(profilesQuery);
  const defaultVoiceName = profiles.find((profile) => profile.id === voice)?.name;
  const book = useMemo(
    () => ({ metadata, loudness, cover, lexicon }),
    [metadata, loudness, cover, lexicon],
  );
  const autoLevels = useMemo(
    () => (overrides.levelVoices !== false ? bookAutoLevels(outputChapters) : undefined),
    [overrides.levelVoices, outputChapters],
  );
  return (
    <SecondarySidebar
      title={t(mode === 'stories' ? 'nav.stories' : 'audiobook.title')}
      icon={mode === 'stories' ? AudioLinesIcon : BookOpenTextIcon}
      size="wide"
      variant="controls"
      footer={footer}
      onCollapsedChange={onCollapsedChange}
      className="space-y-3 [&>details]:rounded-xl [&>details]:border [&>details]:border-border/60 [&>details]:bg-muted/20 [&>details]:p-3 [&>section]:rounded-xl [&>section]:border [&>section]:border-border/60 [&>section]:bg-muted/20 [&>section]:p-3"
    >
      <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-3">
        <label className="block space-y-2 text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-2">
            <BookOpenTextIcon className="size-4" aria-hidden="true" />
            {t('audiobook.meta_title')}
          </span>
          <Input
            value={title}
            spellCheck={false}
            disabled={locked}
            placeholder={t(mode === 'stories' ? 'stories.untitled' : 'audiobook.untitled')}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <div
          role="group"
          aria-labelledby="longform-default-voice"
          data-gate-target={LONGFORM_TARGET.defaultVoice}
          data-attention={needsDefaultVoice ? '' : undefined}
          className="-mx-1.5 space-y-1 rounded-lg p-1.5 data-attention:bg-amber-500/8 data-attention:ring-1 data-attention:ring-amber-500/60"
        >
          <h2
            id="longform-default-voice"
            className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
          >
            <FingerprintIcon className="size-4 shrink-0" aria-hidden="true" />
            {t('audiobook.default_voice')}
          </h2>
          <p
            className={cn(
              'pb-1 text-[11px] leading-snug',
              needsDefaultVoice ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
            )}
          >
            {t(
              mode === 'audiobook' ? 'audiobook.default_voice_hint' : 'stories.default_voice_hint',
            )}
          </p>
          <VoicePicker
            value={voice || null}
            onChange={(voice) => set({ voice })}
            profiles={profiles}
            disabled={locked}
            loading={profilesLoading}
            attention={needsDefaultVoice}
            aria-label={t('audiobook.default_voice')}
          />
          <ProfilesFailure query={profilesQuery} />
        </div>
        {story && <StorySpeed draft={story} disabled={locked} onChange={set} />}
        <div className="space-y-2">
          <h2 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <LanguagesIcon className="size-4" aria-hidden="true" />
            {t('clone.language')}
          </h2>
          <EngineLanguagePicker
            operation={mode === 'stories' ? 'longform' : 'audiobook'}
            value={language}
            options={BOOK_LANGUAGES}
            disabled={locked}
            onValueChange={(language) => set({ language })}
          />
        </div>
        <div className="space-y-2">
          <h2 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <FileAudioIcon className="size-4" aria-hidden="true" />
            {t('audiobook.format')}
          </h2>
          <div className="flex gap-1 rounded-lg bg-background/40 p-1">
            {(['m4b', 'mp3'] as const).map((value) => (
              <Button
                key={value}
                variant={format === value ? 'secondary' : 'ghost'}
                disabled={locked}
                onClick={() => set({ format: value })}
              >
                {t('audiobook.format_' + value)}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {story && <StoryCast draft={story} profiles={profiles} disabled={locked} onChange={set} />}
      {showsCastPanel(mode, inlineNames, voiceGains) && (
        <CastSettings
          title={mode === 'stories' ? t('stories.inline_voices') : undefined}
          names={mode === 'audiobook' ? names : inlineNames}
          voices={names}
          cast={voiceCast}
          profiles={profiles}
          disabled={locked}
          loading={profilesLoading}
          onChange={(voiceCast) => set({ voiceCast })}
          voiceGains={voiceGains}
          onVoiceGains={(voiceGains) => set({ voiceGains })}
          defaultVoiceName={defaultVoiceName}
          autoLevels={autoLevels}
        />
      )}
      <PacingSettings
        value={overrides}
        disabled={locked}
        onChange={(overrides) => set({ overrides })}
      />
      <ProductionSettings
        value={overrides}
        disabled={locked}
        onChange={(overrides) => set({ overrides })}
      />
      <BookSettings
        draft={book}
        disabled={locked}
        pronunciation={mode === 'audiobook'}
        onChange={set}
        onBusy={onBusy}
      />
      {(jobs || [])
        .filter((job) => job.type === (mode === 'stories' ? 'story' : 'audiobook'))
        .map((job) => (
          <div key={job.job_id} className="space-y-2 border-t border-border/50 pt-4 text-xs">
            <h2 className="font-medium">{t('audiobook.recovery_title')}</h2>
            <p>{job.title || t('audiobook.untitled')}</p>
            <p>
              {t('audiobook.recovery_progress', {
                done: job.chapters_done,
                total: job.total_chapters,
              })}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={resumeBlocked}
              // Into the book it belongs to, never the one that happens to be open.
              onClick={() => void resumeLongform(mode, job)}
            >
              {t('common.resume')}
            </Button>
          </div>
        ))}
    </SecondarySidebar>
  );
});

export function StoriesPage() {
  return <LongformPage key="stories" mode="stories" />;
}
export function AudiobookPage() {
  return <LongformPage key="audiobook" mode="audiobook" />;
}
