import {
  CircleAlertIcon,
  InfoIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  Redo2Icon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ResultsDock } from '@/components/editor-frame/results-dock';
import { SaveAudioButton } from '@/components/save-audio-button';
import { WaveformPlayer } from '@/components/waveform-player';
import { Button } from '@/components/ui/button';
import { useGenerateClone } from '@/hooks/use-generate';
import { useDeleteHistoryItem, useHistory, useToggleStarred } from '@/hooks/use-history';
import { useProfiles } from '@/hooks/use-profiles';
import { audioUrl } from '@/lib/api/client';
import type { HistoryItem } from '@/lib/api/types';
import { activePlaybackSource, stopActivePlayback } from '@/lib/audio/playback';
import { formatClock } from '@/lib/format-clock';
import { clearLatestOutput, useLatestOutput, type OutputState } from '@/lib/store/output';
import { openTake } from '@/lib/store/takes';
import { cn } from '@/lib/utils';
import { AudioFileDetails } from './audio-file-details';
import { AudioQuality } from './audio-quality';
import { stopAudition, toggleAudition, useAudition } from './audition';
import { displayTitle, formatRelative, formatSeconds } from './format';
import { reuseHistoryTake } from './reuse-take';

/** A take in the list: a history row, or this session's newest output before history lists it. */
export interface Take {
  id: string;
  text: string;
  /** What plays it: the output's own bytes when it is this session's, else its file. */
  src: string;
  audioPath: string | null;
  duration: number | null;
  genTime: number | null;
  createdAt: number | string | null;
  profileId: string | null;
  starred: boolean;
  item: HistoryItem | null;
  blob: Blob | null;
  /** This session's newest output (the "Latest take"). */
  latest: boolean;
}

const LATEST = 'latest';

function madeIn(mode: 'clone' | 'design', item: HistoryItem): boolean {
  return mode === 'design' ? item.mode === 'design' : !item.mode || item.mode === 'clone';
}

/**
 * The workspace's takes, newest first: the session's newest output on top
 * (unless history says another workspace made it), then the history rows
 * this workspace made.
 */
export function listTakes(
  mode: 'clone' | 'design',
  items: readonly HistoryItem[] | undefined,
  latest: OutputState,
): Take[] {
  const output = latest.objectUrl ? latest.result : null;
  const listed = output?.id ? items?.find((item) => item.id === output.id) : undefined;
  const takes: Take[] = [];
  if (output && latest.objectUrl && (!listed || madeIn(mode, listed)))
    takes.push({
      id: output.id ?? LATEST,
      text: latest.text,
      src: latest.objectUrl,
      audioPath: output.audioPath,
      duration: output.durationSeconds,
      genTime: output.genTimeSeconds,
      createdAt: listed?.created_at ?? null,
      profileId: listed?.profile_id ?? null,
      starred: Boolean(listed?.starred),
      item: listed ?? null,
      blob: output.blob,
      latest: true,
    });
  for (const item of items ?? []) {
    if (item.id === output?.id || !item.audio_path || !madeIn(mode, item)) continue;
    takes.push({
      id: item.id,
      text: item.text,
      src: audioUrl(item.audio_path),
      audioPath: item.audio_path,
      duration: item.duration_seconds,
      genTime: item.generation_time,
      createdAt: item.created_at,
      profileId: item.profile_id,
      starred: Boolean(item.starred),
      item,
      blob: null,
      latest: false,
    });
  }
  return takes;
}

function stopTake(take: Take) {
  stopAudition();
  if (take.latest && activePlaybackSource() === 'output') stopActivePlayback();
}

/** Plays a take through the shared audition player, without opening it. */
function TakeAudition({ take, className }: { take: Take; className?: string }) {
  const { t } = useTranslation();
  const key = `take:${take.id}`;
  const status = useAudition(key);
  const action = t(
    status === 'failed' ? 'player.unavailable' : status === 'idle' ? 'player.play' : 'player.pause',
  );
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`${action}: ${displayTitle(take.text).slice(0, 80)}`}
      title={action}
      className={cn('shrink-0', className)}
      onClick={() => void toggleAudition(key, take.src)}
    >
      {status === 'loading' ? (
        <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
      ) : status === 'playing' ? (
        <PauseIcon />
      ) : status === 'failed' ? (
        <CircleAlertIcon className="text-destructive" />
      ) : (
        <PlayIcon />
      )}
    </Button>
  );
}

function TakeDetail({ id, take }: { id: string; take: Take }) {
  const { t } = useTranslation();
  const { isGenerating } = useGenerateClone();
  const source = take.latest ? 'output' : `take-${take.id}`;
  const item = take.item;
  return (
    <section
      id={id}
      aria-label={t(take.latest ? 'clone.output_title' : 'editor.selected_take')}
      className="flex flex-col gap-2 px-1.5 pt-0.5 pb-2.5"
    >
      <WaveformPlayer key={take.src} src={take.src} source={source} height={44} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {take.blob ? <AudioFileDetails blob={take.blob} /> : null}
        {take.duration != null && take.genTime != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('clone.output_meta', {
              duration: formatSeconds(take.duration),
              gen: formatSeconds(take.genTime),
            })}
          </span>
        ) : null}
        <span className="ms-auto flex flex-wrap items-center gap-0.5">
          <SaveAudioButton
            url={take.audioPath ? audioUrl(take.audioPath) : undefined}
            suggestedName={`voicestudio-${take.id}.wav`}
          />
          {item ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={isGenerating}
              onClick={() => void reuseHistoryTake(item)}
            >
              <Redo2Icon />
              {t('clone.history_reuse')}
            </Button>
          ) : null}
          {item ? (
            <Button variant="ghost" size="sm" onClick={() => openTake(item)}>
              <InfoIcon />
              {t('clone.details')}
            </Button>
          ) : null}
          {take.latest ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={() => {
                stopTake(take);
                clearLatestOutput();
              }}
            >
              <XIcon />
            </Button>
          ) : null}
        </span>
      </div>
      {take.audioPath ? (
        <AudioQuality key={take.src} audioPath={take.audioPath} source={source} />
      ) : null}
      {take.text ? (
        <details className="group text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded px-1 py-0.5 outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            {t('clone.text_label')}
          </summary>
          <p className="mt-1 px-1 text-sm leading-6 break-words whitespace-pre-wrap">{take.text}</p>
        </details>
      ) : null}
    </section>
  );
}

/**
 * The takes under the Clone or Voice Design editor: one row each, newest
 * first; the chosen one opens with its waveform, file details, actions and
 * the (folded) audio check. A new take opens chosen.
 */
export function TakesPanel({ mode }: { mode: 'clone' | 'design' }) {
  const { t, i18n } = useTranslation();
  const history = useHistory();
  const latest = useLatestOutput();
  const profiles = useProfiles();
  const toggleStarred = useToggleStarred();
  const deleteItem = useDeleteHistoryItem();
  const detailId = useId();
  const takes = useMemo(() => listTakes(mode, history.data, latest), [mode, history.data, latest]);
  const latestId = latest.objectUrl ? (latest.result?.id ?? LATEST) : null;
  const [selectedId, setSelectedId] = useState<string | null>(latestId);
  useEffect(() => {
    if (latestId) setSelectedId(latestId);
  }, [latest.objectUrl, latestId]);
  useEffect(() => stopAudition, []);
  const selected = takes.find((take) => take.id === selectedId) ?? null;
  const voices = new Set(takes.map((take) => take.profileId)).size > 1;
  const voiceName = (take: Take) =>
    profiles.data?.find((profile) => profile.id === take.profileId)?.name ?? '';
  const newest = takes[0];
  const remove = (take: Take) => {
    stopTake(take);
    if (take.latest) clearLatestOutput();
    deleteItem.mutate(take.id);
  };

  return (
    <ResultsDock
      title={t('clone.history_title')}
      count={takes.length}
      empty={takes.length === 0}
      line={
        newest ? (
          <>
            <TakeAudition take={newest} />
            <span className="min-w-0 truncate text-[length:var(--text-label)]" title={newest.text}>
              {displayTitle(newest.text)}
            </span>
            {newest.duration != null ? (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatClock(newest.duration)}
              </span>
            ) : null}
          </>
        ) : history.isSuccess ? (
          <span className="text-xs text-muted-foreground">{t('clone.history_empty')}</span>
        ) : null
      }
    >
      {/* A container: rows size by their own width, not the window's — beside
          an open pane the dock is 20rem wide in a wide window. */}
      <ul className="@container flex flex-col gap-0.5">
        {takes.map((take) => {
          const open = take.id === selected?.id;
          const voice = voices ? voiceName(take) : '';
          return (
            <li
              key={take.id}
              data-slot="take-row"
              className={cn(
                'rounded-lg transition-colors motion-reduce:transition-none',
                open ? 'bg-muted/45 ring-1 ring-inset ring-border/60' : 'hover:bg-muted/30',
              )}
            >
              <div className="group/take flex h-9 min-w-0 items-center gap-1 ps-1 pe-1">
                {open ? (
                  <span aria-hidden="true" className="size-6 shrink-0" />
                ) : (
                  <TakeAudition take={take} />
                )}
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={open ? detailId : undefined}
                  title={take.text}
                  onClick={() => setSelectedId(open ? null : take.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-3 overflow-hidden rounded px-1.5 text-start text-[length:var(--text-label)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* The title keeps its room; the voice and the date give way
                      first, then go, as the row narrows. */}
                  <span className={cn('min-w-16 flex-1 truncate', open && 'font-medium')}>
                    {displayTitle(take.text)}
                  </span>
                  {voice ? (
                    <span className="min-w-0 max-w-36 shrink truncate text-xs text-muted-foreground @max-lg:hidden">
                      {voice}
                    </span>
                  ) : null}
                  {take.duration != null ? (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatClock(take.duration)}
                    </span>
                  ) : null}
                  {take.createdAt != null ? (
                    <span className="w-24 shrink-0 truncate text-end text-xs text-muted-foreground @max-sm:hidden">
                      {formatRelative(take.createdAt, i18n.language)}
                    </span>
                  ) : null}
                </button>
                {take.item ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-pressed={take.starred}
                      aria-label={t(take.starred ? 'clone.history_unstar' : 'clone.history_star')}
                      title={t(take.starred ? 'clone.history_unstar' : 'clone.history_star')}
                      className={cn(
                        'shrink-0',
                        take.starred
                          ? 'text-warning hover:text-warning'
                          : 'opacity-0 group-focus-within/take:opacity-100 group-hover/take:opacity-100 focus-visible:opacity-100 max-md:opacity-100',
                      )}
                      onClick={() => toggleStarred.mutate({ id: take.id, starred: !take.starred })}
                    >
                      <StarIcon className={cn(take.starred && 'fill-current')} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('clone.history_delete')}
                      title={t('clone.history_delete')}
                      className="shrink-0 text-muted-foreground opacity-0 group-focus-within/take:opacity-100 group-hover/take:opacity-100 hover:text-destructive focus-visible:opacity-100 max-md:opacity-100"
                      onClick={() => remove(take)}
                    >
                      <Trash2Icon />
                    </Button>
                  </>
                ) : null}
              </div>
              {open ? <TakeDetail id={detailId} take={take} /> : null}
            </li>
          );
        })}
      </ul>
    </ResultsDock>
  );
}
