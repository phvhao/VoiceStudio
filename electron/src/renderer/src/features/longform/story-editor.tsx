import { StoryStems } from './story-stems';
import { WaveformPlayer } from '@/components/waveform-player';
import { previewStoryLine } from './story-preview';
import { storyVoicesReady } from './story-inputs';
import {
  DEFAULT_SPLIT_MODE,
  SPLIT_MODES,
  splitStoryText,
  type SplitMode,
} from '@shared/utils/splitStoryText';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildAutoCast } from '@shared/utils/autoCast';
import { parseCastNames } from '@shared/utils/audiobookScript';
import { SAMPLE_STORY_CAST, SAMPLE_STORY_LINES, SAMPLE_STORY_NAME } from '@shared/data/sampleStory';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookOpenTextIcon,
  ChevronRightIcon,
  GaugeIcon,
  HeadingIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  TrashIcon,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/popover';
import { PipelineFailure } from '@/components/pipeline-failure';
import { describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { reorder } from '@shared/utils/storyReorder';
import { MarkupTextarea } from './markup-textarea';
import { MarkupToolbar, type MarkupTarget } from './markup-toolbar';
import { MarkupEditorTools } from './markup-editor-tools';
import { VOICE_ACCENTS } from './voice-palette';
import type { Draft } from './longform-session';
interface Props {
  draft: Draft;
  profiles: { id: string; name: string }[];
  /** The profiles are still loading: a line's voice is unknown, not missing. */
  profilesLoading?: boolean;
  disabled: boolean;
  canSynthesize?: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onBusy?: (busy: boolean) => void;
}
type Line = Draft['lines'][number];

// One accent per cast member, in cast order, so a dialogue scans by speaker;
// the same palette colors voices in the editors.
const CHARACTER_ACCENTS = VOICE_ACCENTS.map(({ border, dot }) => ({ border, dot }));
const NO_ACCENT = { border: 'border-l-border/60', dot: 'bg-muted-foreground/40' };

function characterAccent(cast: Draft['cast'], characterId?: string) {
  const index = cast.findIndex((character) => character.id === characterId);
  return index < 0 ? NO_ACCENT : CHARACTER_ACCENTS[index % CHARACTER_ACCENTS.length];
}

// Select values cannot be empty; these stand for "inherit".
const DEFAULT_CHARACTER = '__default__';
const CHARACTER_VOICE = '__character__';

// A chapter row edits its title; `# ` with no title yet still reads as one so
// the row does not turn into a spoken line while the title is retyped.
const CHAPTER_RE = /^\s*#(?:[ \t]|$)/;
const chapterTitleOf = (text: string) => text.replace(/^\s*#[ \t]?/, '');

export function StoryCast({ draft, profiles, disabled, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer text-sm font-medium">{t('stories.castTitle')}</summary>
      {draft.cast.map((character) => (
        <div key={character.id} className="space-y-2 border-b border-border/40 pb-3">
          <div className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className={cn(
                'size-2.5 shrink-0 rounded-full',
                characterAccent(draft.cast, character.id).dot,
              )}
            />
            <Input
              aria-label={t('stories.characterName')}
              value={character.name}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  cast: draft.cast.map((c) =>
                    c.id === character.id ? { ...c, name: e.target.value } : c,
                  ),
                })
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('stories.removeCharacter')}
              disabled={disabled}
              onClick={() =>
                onChange({
                  cast: draft.cast.filter((c) => c.id !== character.id),
                  lines: draft.lines.map((line) =>
                    line.character === character.id ? { ...line, character: undefined } : line,
                  ),
                })
              }
            >
              <TrashIcon />
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {profiles.find((p) => p.id === character.profileId)?.name ||
                t('stories.defaultVoice')}
            </summary>
            <div className="max-h-40 overflow-y-auto">
              {[{ id: null, name: t('stories.defaultVoice') }, ...profiles].map((profile) => (
                <Button
                  key={profile.id || 'default'}
                  variant={character.profileId === profile.id ? 'secondary' : 'ghost'}
                  size="sm"
                  className="w-full justify-start"
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      cast: draft.cast.map((c) =>
                        c.id === character.id ? { ...c, profileId: profile.id } : c,
                      ),
                    })
                  }
                >
                  {profile.name}
                </Button>
              ))}
            </div>
          </details>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() =>
          onChange({
            cast: [
              ...draft.cast,
              {
                id: crypto.randomUUID(),
                name: t('stories.character'),
                profileId: null,
              },
            ],
          })
        }
      >
        <PlusIcon />
        {t('stories.addCharacter')}
      </Button>
    </details>
  );
}

function LineSpeed({
  line,
  globalSpeed,
  disabled,
  onSpeed,
}: {
  line: Line;
  globalSpeed: number;
  disabled: boolean;
  onSpeed: (speed: number | null) => void;
}) {
  const { t } = useTranslation();
  const speed = line.speed ?? globalSpeed;
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        title={t('stories.speed')}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'xs' }),
          'font-mono tabular-nums',
          line.speed != null && 'bg-primary/10 text-primary',
        )}
      >
        <GaugeIcon />
        {speed.toFixed(2)}×
      </PopoverTrigger>
      <PopoverContent className="w-60 space-y-2 p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">{t('stories.speed')}</span>
          <span className="font-mono tabular-nums">{speed.toFixed(2)}×</span>
        </div>
        <input
          className="w-full accent-primary"
          aria-label={t('stories.speed')}
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          value={speed}
          disabled={disabled}
          onChange={(e) => onSpeed(Number(e.target.value))}
        />
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || line.speed == null}
          onClick={() => onSpeed(null)}
        >
          {t('stories.reset')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function StoryEditor({
  draft,
  profiles,
  profilesLoading = false,
  disabled,
  canSynthesize = true,
  onChange,
  onBusy,
}: Props) {
  const { t } = useTranslation();
  const controller = useRef<AbortController | null>(null);
  const lineInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const chapterInputs = useRef(new Map<string, HTMLInputElement>());
  const [activeLine, setActiveLine] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  useEffect(() => {
    setPreview(null);
  }, [
    draft.lines,
    draft.cast,
    draft.voice,
    draft.language,
    draft.voiceCast,
    draft.overrides,
    draft.globalSpeed,
  ]);
  const scriptNames = useMemo(
    () => parseCastNames(draft.lines.map((line) => line.text).join('\n'), draft.voiceCast),
    [draft.lines, draft.voiceCast],
  );
  const defaultVoiceName = profiles.find((profile) => profile.id === draft.voice)?.name;
  const audition = async (line: Line) => {
    if (disabled || !canSynthesize || controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setPreviewing(line.id);
    setPreviewError(null);
    onBusy?.(true);
    try {
      const blob = await previewStoryLine(draft, line, current.signal, profiles);
      if (!current.signal.aborted) setPreview({ id: line.id, url: URL.createObjectURL(blob) });
    } catch (cause) {
      if (!current.signal.aborted) setPreviewError(describeError(cause));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setPreviewing(null);
        onBusy?.(false);
      }
    }
  };
  const script = draft.importText;
  const setScript = (importText: string) => onChange({ importText });
  const [splitMode, setSplitMode] = useState<SplitMode>(DEFAULT_SPLIT_MODE);
  // Electron's Sentences preset keeps its established 500-char ceiling.
  const [maximum, setMaximum] = useState(500);
  const [inputOpen, setInputOpen] = useState(Boolean(script));
  useEffect(() => {
    if (script) setInputOpen(true);
  }, [script]);
  const [notice, setNotice] = useState('');
  const autoCast = () => {
    const result = buildAutoCast(script, draft.cast, profiles);
    if (!result.tracks.length) {
      setNotice(t('stories.autocastEmpty'));
      return;
    }
    onChange({
      cast: result.cast,
      lines: [
        ...draft.lines,
        ...result.tracks.map((line) => ({
          ...line,
          id: crypto.randomUUID(),
          profileId: null,
        })),
      ],
    });
    setScript('');
    setNotice(
      t('stories.autocastDone', {
        lines: result.tracks.length,
        voices: result.speakers.length,
      }),
    );
  };
  const update = (id: string, patch: Partial<Line>) =>
    onChange({
      lines: draft.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    });
  const spoken = draft.lines.filter((line) => !CHAPTER_RE.test(line.text));
  // The toolbar writes into the line last focused, else the last spoken line.
  const targetLine =
    spoken.find((line) => line.id === activeLine) ?? spoken[spoken.length - 1] ?? null;
  const getTarget = (): MarkupTarget | null => {
    const element = targetLine && lineInputs.current.get(targetLine.id);
    return element && targetLine
      ? { element, setText: (text) => update(targetLine.id, { text }) }
      : null;
  };
  const insertAfter = (anchor: string | null, line: Line) => {
    const index = anchor ? draft.lines.findIndex((l) => l.id === anchor) : -1;
    const lines = [...draft.lines];
    lines.splice(index < 0 ? lines.length : index + 1, 0, line);
    onChange({ lines });
  };
  const nextChapterTitle = () =>
    t('stories.chapterN', {
      n: draft.lines.filter((line) => CHAPTER_RE.test(line.text)).length + 1,
    });
  const addChapter = (anchor: string | null) => {
    const title = nextChapterTitle();
    const id = crypto.randomUUID();
    insertAfter(anchor, { id, text: `# ${title}`, profileId: null });
    requestAnimationFrame(() => {
      const input = chapterInputs.current.get(id);
      input?.focus();
      input?.select();
    });
  };
  const add = (text = '') =>
    onChange({
      lines: [...draft.lines, { id: crypto.randomUUID(), text, profileId: null }],
    });
  const loadSample = () =>
    onChange({
      title: SAMPLE_STORY_NAME,
      projectId: null,
      cast: SAMPLE_STORY_CAST.map((character, index) => ({
        id: character.id,
        name: character.name,
        profileId: profiles.length ? profiles[index % profiles.length].id : null,
      })),
      lines: SAMPLE_STORY_LINES.map((line) => ({
        id: crypto.randomUUID(),
        character: line.character,
        text: line.text,
        profileId: null,
      })),
    });
  const move = (line: Line, index: number, offset: -1 | 1) =>
    onChange({
      lines:
        offset < 0
          ? reorder(draft.lines, line.id, draft.lines[index - 1].id)
          : reorder(draft.lines, draft.lines[index + 1].id, line.id),
    });
  const lineActions = (line: Line, index: number) => (
    <div className="ml-auto flex items-center opacity-70 transition-opacity group-hover/line:opacity-100 group-focus-within/line:opacity-100">
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('stories.moveUp')}
        title={t('stories.moveUp')}
        disabled={disabled || index === 0}
        onClick={() => move(line, index, -1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('stories.moveDown')}
        title={t('stories.moveDown')}
        disabled={disabled || index === draft.lines.length - 1}
        onClick={() => move(line, index, 1)}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('stories.removeLine')}
        title={t('stories.removeLine')}
        disabled={disabled}
        onClick={() =>
          onChange({
            lines: draft.lines.filter((l) => l.id !== line.id),
          })
        }
      >
        <TrashIcon />
      </Button>
    </div>
  );
  const characterItems = [
    { value: DEFAULT_CHARACTER, label: t('stories.defaultVoice') },
    ...draft.cast.map((character) => ({ value: character.id, label: character.name })),
  ];
  const voiceItems = [
    { value: CHARACTER_VOICE, label: t('markup.character_voice') },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
  ];
  let spokenNumber = 0;
  return (
    // No `min-h-0` here: the page column is the scroll container, and a
    // shrinkable flex item let a long script paint over the generation
    // progress panel and the footer instead of pushing them down.
    <div data-slot="story-editor" className="flex-1 space-y-3">
      {previewError && (
        <PipelineFailure fallback={previewError} onDismiss={() => setPreviewError(null)} />
      )}
      <details
        className="group rounded-xl border border-border/60 bg-muted/20 p-3"
        open={inputOpen}
        onToggle={(event) => setInputOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
          {t('stories.autocast')}
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('stories.autocastHint')}
          </p>
          <textarea
            aria-label={t('stories.autocast')}
            placeholder={t('stories.splitPlaceholder')}
            className="min-h-32 w-full rounded-lg border border-border/60 bg-background/40 p-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={script}
            disabled={disabled}
            onChange={(e) => setScript(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !script.trim()}
              onClick={autoCast}
            >
              {t('stories.autocast')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || !script.trim()}
              onClick={() => {
                const parts = splitStoryText(script, splitMode, maximum);
                onChange({
                  lines: [
                    ...draft.lines,
                    ...parts.map((text) => ({
                      id: crypto.randomUUID(),
                      text,
                      profileId: null,
                    })),
                  ],
                  importText: '',
                });
                setNotice(t('stories.lines', { count: parts.length }));
              }}
            >
              {t('stories.splitIntoTracks')}
            </Button>
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {t('stories.splitMode')}
              <Select
                items={SPLIT_MODES.map((mode) => ({
                  value: mode,
                  label: t(`stories.split_${mode}`),
                }))}
                value={splitMode}
                disabled={disabled}
                onValueChange={(value) => setSplitMode(value as SplitMode)}
              >
                <SelectTrigger aria-label={t('stories.splitMode')} className="h-8 min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {SPLIT_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`stories.split_${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {splitMode === 'sentences' && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                {t('stories.maxChars')}
                <Input
                  type="number"
                  min="40"
                  max="2000"
                  step="10"
                  className="h-8 w-20"
                  disabled={disabled}
                  value={maximum}
                  onChange={(e) =>
                    setMaximum(Math.max(40, Math.min(2000, Number(e.target.value) || 40)))
                  }
                />
              </label>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('stories.splitModeHint')}</p>
          {notice && (
            <p role="status" className="text-xs text-muted-foreground">
              {notice}
            </p>
          )}
        </div>
      </details>

      {draft.lines.length === 0 && (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 px-6 text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <BookOpenTextIcon className="size-5" />
          </div>
          <h3 className="text-sm font-semibold">{t('stories.newStory')}</h3>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {t('stories.emptyText')}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button
              disabled={disabled}
              title={t('audiobook.load_sample_hint')}
              onClick={loadSample}
            >
              <SparklesIcon />
              {t('audiobook.load_sample')}
            </Button>
            <Button variant="outline" disabled={disabled} onClick={() => add()}>
              <PlusIcon />
              {t('stories.addFirst')}
            </Button>
          </div>
        </div>
      )}

      {draft.lines.length > 0 && (
        <MarkupToolbar
          className="sticky top-0 z-20 shadow-sm"
          getTarget={getTarget}
          disabled={disabled || !targetLine}
          profiles={profiles}
          loading={profilesLoading}
          scriptNames={scriptNames}
          voiceCast={draft.voiceCast}
          onVoiceCast={(voiceCast) => onChange({ voiceCast })}
          onChapter={() => addChapter(targetLine?.id ?? null)}
        />
      )}

      {draft.lines.map((line, index) => {
        if (CHAPTER_RE.test(line.text))
          return (
            <div
              key={line.id}
              className="group/line flex items-center gap-2 border-b border-border/60 pt-4 pb-1.5"
            >
              <span className="flex items-center gap-1 rounded-md bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                <HeadingIcon className="size-3" />
                {t('markup.chapter')}
              </span>
              <input
                ref={(node) => {
                  if (node) chapterInputs.current.set(line.id, node);
                  else chapterInputs.current.delete(line.id);
                }}
                aria-label={t('markup.chapter')}
                className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground/60"
                value={chapterTitleOf(line.text)}
                placeholder={nextChapterTitle()}
                disabled={disabled}
                onChange={(e) => update(line.id, { text: `# ${e.target.value}` })}
              />
              {lineActions(line, index)}
            </div>
          );
        spokenNumber += 1;
        const accent = characterAccent(draft.cast, line.character);
        const profileMissing =
          !profilesLoading &&
          line.profileId != null &&
          !profiles.some((profile) => profile.id === line.profileId);
        return (
          <div
            key={line.id}
            data-active={line.id === targetLine?.id ? '' : undefined}
            className={cn(
              'group/line rounded-xl border border-l-4 border-border/60 bg-muted/15 transition-colors focus-within:bg-muted/30 data-active:ring-1 data-active:ring-ring/40',
              accent.border,
            )}
            onFocusCapture={() => setActiveLine(line.id)}
          >
            <div className="flex flex-wrap items-center gap-1 px-2 pt-1.5">
              <span className="w-6 text-end font-mono text-[11px] text-muted-foreground tabular-nums">
                {spokenNumber}
              </span>
              <Select
                items={characterItems}
                value={line.character || DEFAULT_CHARACTER}
                disabled={disabled}
                onValueChange={(value) =>
                  update(line.id, {
                    character: value === DEFAULT_CHARACTER ? undefined : String(value),
                  })
                }
              >
                <SelectTrigger
                  aria-label={t('stories.character')}
                  className="h-6 max-w-44 border-transparent bg-transparent px-1.5 text-xs dark:bg-transparent"
                >
                  <span aria-hidden="true" className={cn('size-2 rounded-full', accent.dot)} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {characterItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                items={
                  profileMissing
                    ? [
                        ...voiceItems,
                        { value: line.profileId!, label: t('modelSettings.unavailable') },
                      ]
                    : voiceItems
                }
                value={line.profileId ?? CHARACTER_VOICE}
                disabled={disabled}
                onValueChange={(value) =>
                  update(line.id, {
                    profileId: value === CHARACTER_VOICE ? null : String(value),
                  })
                }
              >
                <SelectTrigger
                  aria-label={t('markup.line_voice')}
                  title={t('markup.line_voice')}
                  className={cn(
                    'h-6 max-w-48 border-transparent bg-transparent px-1.5 text-xs dark:bg-transparent',
                    line.profileId ? 'text-foreground' : 'text-muted-foreground',
                    profileMissing && 'text-destructive',
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {voiceItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <LineSpeed
                line={line}
                globalSpeed={draft.globalSpeed}
                disabled={disabled}
                onSpeed={(speed) => update(line.id, { speed })}
              />
              {previewing === line.id ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={t('common.stop')}
                  onClick={() => controller.current?.abort()}
                >
                  <SquareIcon className="fill-current" />
                  <span role="status">{t('common.loading')}</span>
                </Button>
              ) : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('stories.preview')}
                  title={t('stories.preview')}
                  disabled={
                    disabled ||
                    !canSynthesize ||
                    previewing !== null ||
                    !storyVoicesReady({ ...draft, lines: [line] }, profiles)
                  }
                  onClick={() => void audition(line)}
                >
                  <PlayIcon />
                </Button>
              )}
              {lineActions(line, index)}
            </div>
            <MarkupEditorTools
              getTarget={() => {
                const element = lineInputs.current.get(line.id);
                return element ? { element, setText: (text) => update(line.id, { text }) } : null;
              }}
              disabled={disabled}
              lineVoices
              profiles={profiles}
              loading={profilesLoading}
              scriptNames={scriptNames}
              voiceCast={draft.voiceCast}
              onVoiceCast={(voiceCast) => onChange({ voiceCast })}
              voiceGains={draft.voiceGains}
              onVoiceGains={(voiceGains) => onChange({ voiceGains })}
              defaultVoiceName={defaultVoiceName}
              onChapter={() => addChapter(line.id)}
            >
              <MarkupTextarea
                textareaRef={(node) => {
                  if (node) lineInputs.current.set(line.id, node);
                  else lineInputs.current.delete(line.id);
                }}
                autoGrow
                rows={2}
                voices={scriptNames}
                aria-label={t('stories.linePlaceholder')}
                placeholder={t('stories.linePlaceholder')}
                textClassName="px-3 pt-1 pb-3 text-sm leading-6 placeholder:text-muted-foreground/50"
                value={line.text}
                disabled={disabled}
                onValueChange={(text) => update(line.id, { text })}
              />
            </MarkupEditorTools>
            {preview?.id === line.id && (
              <div className="px-3 pb-3">
                <WaveformPlayer
                  showWaveform={false}
                  src={preview.url}
                  source="story-line-preview"
                />
              </div>
            )}
          </div>
        );
      })}
      {draft.lines.length > 0 && (
        <div className="flex gap-2">
          <Button variant="ghost" disabled={disabled} onClick={() => add()}>
            <PlusIcon />
            {t('stories.addLine')}
          </Button>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => addChapter(draft.lines[draft.lines.length - 1]?.id ?? null)}
          >
            <HeadingIcon />
            {t('stories.addChapter')}
          </Button>
        </div>
      )}
      <StoryStems
        draft={draft}
        profiles={profiles}
        disabled={disabled || !canSynthesize}
        onBusy={onBusy}
      />
    </div>
  );
}
