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
import { EditorStatusBar, createCaretSource } from './editor-status-bar';
import { passageBounds, previewPassage } from './script-markup';
import { usePassagePreview } from './passage-preview';
import { paragraphsAround, useRetakes } from './take-retake';
import type { RetakenChapter } from './chapter-previews';
import { storyVoicesReady } from './story-inputs';
import { StorySpeed } from './story-speed';
import { ProjectSwitcher } from './project-settings';
import { ProductionSettings } from './production-settings';
import { PacingSettings, SpeechCheckReport } from './pacing-settings';
import { BookOutline } from './book-outline';
import { ContentsRail } from './contents-rail';
import { useEditorZoom, useEditorZoomInput, zoomedText } from './editor-zoom';
import { ExportHtmlButton } from './html-export';
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
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { GeneratePanel } from './generate-panel';
import { generateBlocker } from './generate-blocker';
import { EngineNotice } from '@/components/engine-notice';
import { ValidationWarnings, type ScriptWarning } from './validation-warnings';
import { getBridge } from '@/components/bridge';
import { useProfiles } from '@/hooks/use-profiles';
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
  useLongformSession,
  storiesImportEpoch,
  type Mode,
} from './longform-session';
import { SAMPLE_AUDIOBOOK_SCRIPT } from '@shared/data/sampleAudiobook';
import { useTtsReadiness } from '@/hooks/use-tts-readiness';
import { useReadingSettings } from '@/lib/reading-settings';
/** Built once: the page re-renders on every keystroke in the script. */
const BOOK_LANGUAGES = ['Auto', ...LANG_CODES.map((item) => item.label)];
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
  const session = useLongformSession();
  const ttsOperation = mode === 'stories' ? 'longform' : 'audiobook';
  const ttsBlocker = useTtsReadiness(ttsOperation);
  const draft = session.drafts[mode];
  const text =
    mode === 'audiobook' ? draft.script : draft.lines.map((line) => line.text).join('\n');
  const names = useMemo(() => parseCastNames(text, draft.voiceCast), [text, draft.voiceCast]);
  const stats = useMemo(() => scriptStats(text), [text]);
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
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const audiobookInput = useRef<HTMLTextAreaElement>(null);
  const [caret] = useState(() => createCaretSource());
  // Ctrl/⌘ +, −, 0 and Ctrl+wheel size the script's text while in its frame.
  const editorFrame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useEditorZoom();
  useEditorZoomInput(editorFrame);
  const locked = !!session.active || importing;
  const scriptLines = scriptSize(mode, draft);
  const query = useQuery({
    queryKey: ['longform-recovery'],
    queryFn: ({ signal }) => apiJson<{ jobs: Recovery[] }>('/audiobook/jobs', { signal }),
  });
  useEffect(() => {
    if (!session.active) void query.refetch();
  }, [session.active]);
  const set = (value: Parameters<typeof editLongform>[1]) => editLongform(mode, value);
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
  const voicesReady =
    castReady && (mode === 'stories' ? storyVoicesReady(draft, profiles) : Boolean(defaultVoice));
  // Stories reads a profile id inside [voice:…] directly; only readable names
  // need a mapping, so only those are listed for casting.
  const inlineNames = useMemo(
    () => names.filter((name) => !profiles.some((profile) => profile.id === name)),
    [names, profiles],
  );
  const warnings = useMemo(
    () =>
      mode === 'audiobook'
        ? (validateScript(draft.script, {
            mappedNames: Object.keys(draft.voiceCast).filter((name) =>
              Boolean(draft.voiceCast[name]),
            ),
            profileIds: profiles.map((profile) => profile.id),
          }) as ScriptWarning[])
        : [],
    [draft.script, draft.voiceCast, mode, profiles],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const blocker = generateBlocker({
    mode,
    busyElsewhere: Boolean(session.active) && session.active !== mode,
    importing,
    tts: ttsBlocker,
    usable,
    voicesReady,
    defaultVoiceReady: Boolean(defaultVoice),
    castReady,
    duplicateLexicon: duplicateWords(draft.lexicon),
  });
  const canPreview = ttsBlocker === null && voicesReady && !duplicateWords(draft.lexicon);
  const passage = usePassagePreview(draft, setImporting);
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
  const retakes = useRetakes({
    chapterAt: (editor, offset) =>
      mode === 'audiobook'
        ? audiobookRetakeChapter(draft, offset)
        : storyRetakeChapter(draft, editor),
    onRetaken: ({ chapter, takes }) => {
      if (mode === 'stories') {
        // A story is heard from its render, which reads them anew.
        toast.success(
          takes.length > 1
            ? t('editor.retaken_many', { count: takes.length })
            : t('editor.retaken'),
        );
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['audiobook-outline'] });
      const index = chapter.index;
      if (index !== undefined) setRetaken((last) => ({ chapter: index, id: (last?.id ?? 0) + 1 }));
      // Heard at once, where they are read: the paragraphs holding them —
      // unless the script was edited meanwhile, and they are elsewhere now.
      const input = audiobookInput.current;
      if (input && input.value === chapter.sources[0]?.text)
        previewRange(...paragraphsAround(input.value, takes));
    },
  });
  const canRetake = phrases && (mode === 'audiobook' ? canPreview : ttsBlocker === null);
  const generatePanel = (
    <GeneratePanel
      mode={mode}
      session={session}
      blocker={blocker}
      onGenerate={() => void renderLongform(mode)}
      onStop={stopLongform}
    />
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
        <SecondarySidebar
          title={t(mode === 'stories' ? 'nav.stories' : 'audiobook.title')}
          icon={mode === 'stories' ? AudioLinesIcon : BookOpenTextIcon}
          size="wide"
          variant="controls"
          footer={generatePanel}
          onCollapsedChange={setSidebarCollapsed}
          className="space-y-3 [&>details]:rounded-xl [&>details]:border [&>details]:border-border/60 [&>details]:bg-muted/20 [&>details]:p-3 [&>section]:rounded-xl [&>section]:border [&>section]:border-border/60 [&>section]:bg-muted/20 [&>section]:p-3"
        >
          <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-3">
            <label className="block space-y-2 text-xs font-medium text-muted-foreground">
              <span className="flex items-center gap-2">
                <BookOpenTextIcon className="size-4" aria-hidden="true" />
                {t('audiobook.meta_title')}
              </span>
              <Input
                value={draft.title}
                spellCheck={false}
                disabled={locked}
                placeholder={t(mode === 'stories' ? 'stories.untitled' : 'audiobook.untitled')}
                onChange={(e) => set({ title: e.target.value })}
              />
            </label>
            <div
              role="group"
              aria-labelledby="longform-default-voice"
              data-attention={blocker === 'default_voice' ? '' : undefined}
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
                  blocker === 'default_voice'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground',
                )}
              >
                {t(
                  mode === 'audiobook'
                    ? 'audiobook.default_voice_hint'
                    : 'stories.default_voice_hint',
                )}
              </p>
              <VoicePicker
                value={draft.voice || null}
                onChange={(voice) => set({ voice })}
                profiles={profiles}
                disabled={locked}
                loading={profilesLoading}
                attention={blocker === 'default_voice'}
                aria-label={t('audiobook.default_voice')}
              />
              <ProfilesFailure query={profilesQuery} />
            </div>
            {mode === 'stories' && <StorySpeed draft={draft} disabled={locked} onChange={set} />}
            <div className="space-y-2">
              <h2 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <LanguagesIcon className="size-4" aria-hidden="true" />
                {t('clone.language')}
              </h2>
              <EngineLanguagePicker
                operation={ttsOperation}
                value={draft.language}
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
                {(['m4b', 'mp3'] as const).map((format) => (
                  <Button
                    key={format}
                    variant={draft.format === format ? 'secondary' : 'ghost'}
                    disabled={locked}
                    onClick={() => set({ format })}
                  >
                    {t('audiobook.format_' + format)}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          {mode === 'stories' && (
            <StoryCast draft={draft} profiles={profiles} disabled={locked} onChange={set} />
          )}
          {showsCastPanel(mode, inlineNames, draft.voiceGains) && (
            <CastSettings
              title={mode === 'stories' ? t('stories.inline_voices') : undefined}
              names={mode === 'audiobook' ? names : inlineNames}
              voices={names}
              cast={draft.voiceCast}
              profiles={profiles}
              disabled={locked}
              loading={profilesLoading}
              onChange={(voiceCast) => set({ voiceCast })}
              voiceGains={draft.voiceGains}
              onVoiceGains={(voiceGains) => set({ voiceGains })}
              defaultVoiceName={defaultVoice?.name}
              autoLevels={
                draft.overrides.levelVoices !== false
                  ? bookAutoLevels(draft.outputChapters)
                  : undefined
              }
            />
          )}
          <PacingSettings
            value={draft.overrides}
            disabled={locked}
            onChange={(overrides) => set({ overrides })}
          />
          <ProductionSettings
            value={draft.overrides}
            disabled={locked}
            onChange={(overrides) => set({ overrides })}
          />
          <BookSettings
            draft={draft}
            disabled={locked}
            pronunciation={mode === 'audiobook'}
            onChange={set}
            onBusy={setImporting}
          />
          {(query.data?.jobs || [])
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
                  disabled={locked || ttsBlocker !== null}
                  // Into the book it belongs to, never the one that happens to be open.
                  onClick={() => void resumeLongform(mode, job)}
                >
                  {t('common.resume')}
                </Button>
              </div>
            ))}
        </SecondarySidebar>
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col gap-4 px-6 py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
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
                <MarkupToolbar
                  className="shrink-0 rounded-none border-0 border-b border-border/50"
                  getTarget={() =>
                    audiobookInput.current && {
                      element: audiobookInput.current,
                      setText: (script) => set({ script }),
                    }
                  }
                  disabled={locked}
                  profiles={profiles}
                  loading={profilesLoading}
                  scriptNames={names}
                  voiceCast={draft.voiceCast}
                  onVoiceCast={(voiceCast) => set({ voiceCast })}
                  allowNewCharacter
                  actions={
                    passage.pending ? (
                      <Button size="xs" variant="secondary" onClick={passage.stop}>
                        <SquareIcon className="fill-current" />
                        {t('common.stop')}
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={locked || !canPreview}
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
                      <PipelineFailure fallback={passage.error} onDismiss={passage.dismiss} />
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
                  outline={(rail) => (
                    <BookOutline
                      {...rail}
                      draft={draft}
                      disabled={locked}
                      canPreview={canPreview}
                      onBusy={setImporting}
                      retaken={retaken}
                      getTarget={() =>
                        audiobookInput.current && {
                          element: audiobookInput.current,
                          setText: (script) => set({ script }),
                        }
                      }
                    />
                  )}
                >
                  <MarkupEditorTools
                    className="flex min-h-96 min-w-0 flex-1 flex-col"
                    getTarget={() =>
                      audiobookInput.current && {
                        element: audiobookInput.current,
                        setText: (script) => set({ script }),
                      }
                    }
                    disabled={locked}
                    headings
                    profiles={profiles}
                    loading={profilesLoading}
                    scriptNames={names}
                    voiceCast={draft.voiceCast}
                    onVoiceCast={(voiceCast) => set({ voiceCast })}
                    voiceGains={draft.voiceGains}
                    onVoiceGains={(voiceGains) => set({ voiceGains })}
                    defaultVoiceName={defaultVoice?.name}
                    onListen={canPreview ? previewSelection : undefined}
                    onListenRange={canPreview ? previewRange : undefined}
                    retakes={canRetake ? retakes.tools('script') : undefined}
                  >
                    <MarkupTextarea
                      textareaRef={audiobookInput}
                      headings
                      gutter
                      activeLine
                      voices={names}
                      aria-label={t('clone.script')}
                      className="min-h-96 flex-1"
                      textClassName="px-4 py-3"
                      textStyle={zoomedText(zoom, 1, 1.75)}
                      value={draft.script}
                      placeholder={t('audiobook.script_placeholder')}
                      disabled={locked}
                      onCaretChange={caret.set}
                      onValueChange={(script) => {
                        set({ script });
                        if (warningsDismissed) setWarningsDismissed(false);
                      }}
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
                  zoom={zoom}
                  onZoomChange={setZoom}
                />
              </div>
            ) : (
              <StoryEditor
                draft={draft}
                profiles={profiles}
                profilesLoading={profilesLoading}
                disabled={locked}
                canSynthesize={ttsBlocker === null}
                retakes={canRetake ? retakes : undefined}
                onChange={set}
                onBusy={setImporting}
              />
            )}
            {/* Audiobook shows these in its editor's status bar. */}
            {mode === 'stories' && <p className="text-xs text-muted-foreground">{statsLine}</p>}
            {!warningsDismissed && warnings.length > 0 && !session.active && (
              <ValidationWarnings
                warnings={warnings}
                onDismiss={() => setWarningsDismissed(true)}
              />
            )}
            {session.error && (
              <PipelineFailure
                failure={session.failure}
                fallback={session.error}
                onDismiss={dismissLongformError}
              />
            )}
            {localError && (
              <PipelineFailure fallback={localError} onDismiss={() => setLocalError(null)} />
            )}
            <EngineNotice operation={ttsOperation} />
            {session.storageError && (
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
                    {mode === 'audiobook' && (
                      <ExportHtmlButton
                        draft={draft}
                        disabled={exporting}
                        onError={setLocalError}
                      />
                    )}
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
                  />
                ) : (
                  <WaveformPlayer
                    showWaveform={false}
                    src={apiPath('/audio/' + encodeURIComponent(draft.output))}
                    source={'longform-' + mode}
                  />
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

export function StoriesPage() {
  return <LongformPage key="stories" mode="stories" />;
}
export function AudiobookPage() {
  return <LongformPage key="audiobook" mode="audiobook" />;
}
