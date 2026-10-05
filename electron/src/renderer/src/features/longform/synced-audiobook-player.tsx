import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpenTextIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MediaProvider,
  StudioMediaPlayer,
  audioLoaders,
  audioSource,
  useMediaState,
  type MediaPlayerInstance,
} from '@/components/media-player';
import { Button } from '@/components/ui/button';
import { ApiError, apiJson } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { buildLyricsTimeline, type AudiobookTimeline } from '@shared/utils/audiobookLyrics';
import {
  AudiobookReader,
  ChapterStepButton,
  PlayPauseButton,
  PlaybackTime,
  RateMenu,
  SeekBar,
  buildReaderBook,
  chapterTitle,
  followLine,
  sentencePieces,
  usePlayhead,
  type ReaderBook,
} from './audiobook-reader';
import type { AudiobookRenderChapter } from './longform-session';

/**
 * The render's timeline sidecar for `output`: exact phrase timings. Null when
 * the book has none (rendered before timelines, or the file is gone); the
 * reader then estimates.
 */
export async function fetchAudiobookTimeline(
  output: string,
  signal?: AbortSignal,
): Promise<AudiobookTimeline | null> {
  try {
    const timeline = await apiJson<AudiobookTimeline>(
      '/audiobook/timeline/' + encodeURIComponent(output),
      { signal },
    );
    // A sidecar names its book: one naming another file does not time this one.
    return timeline?.output === undefined || timeline.output === output ? timeline : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The finished book on the page: a compact "now playing" card whose reader
 * dialog shares its audio element, so playback carries on as it opens and
 * closes. With `output` (the book's file name) the highlight follows the
 * render's timeline sidecar.
 */
export function SyncedAudiobookPlayer({
  src,
  script,
  chapters,
  output,
  lang = '',
}: {
  src: string;
  script: string;
  chapters: AudiobookRenderChapter[];
  output?: string;
  /** The book's language tag (`bookLanguageTag`); '' when it is not known. */
  lang?: string;
}) {
  const player = useRef<MediaPlayerInstance>(null);
  const timeline = useQuery({
    queryKey: ['audiobook-timeline', output],
    queryFn: ({ signal }) => (output ? fetchAudiobookTimeline(output, signal) : null),
    enabled: Boolean(output),
  });

  return (
    <StudioMediaPlayer
      playerRef={player}
      sourceKey="audiobook-output"
      src={audioSource(src)}
      viewType="audio"
      load="eager"
      className="overflow-hidden rounded-xl border border-border/60 bg-muted/20 shadow-[inset_0_1px_0_rgb(255_255_255/4%)]"
    >
      <MediaProvider loaders={audioLoaders} className="hidden" />
      <NowPlayingCard
        player={player}
        script={script}
        chapters={chapters}
        timeline={timeline.data ?? null}
        lang={lang}
      />
    </StudioMediaPlayer>
  );
}

function NowPlayingCard({
  player,
  script,
  chapters,
  timeline,
  lang,
}: {
  player: RefObject<MediaPlayerInstance | null>;
  script: string;
  chapters: AudiobookRenderChapter[];
  timeline: AudiobookTimeline | null;
  lang: string;
}) {
  const { t } = useTranslation();
  const [reading, setReading] = useState(false);
  const duration = useMediaState('duration');
  const error = useMediaState('error');
  const book = useMemo(
    () => ({
      ...buildReaderBook(script, buildLyricsTimeline(script, { chapters, duration, timeline })),
      lang,
    }),
    [chapters, duration, lang, script, timeline],
  );
  const steps = book.chapters.length > 1;

  return (
    <>
      <div className="@container/card space-y-2 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <PlayPauseButton player={player} />
          <NowPlayingText book={book} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            aria-label={t('reader.open')}
            title={t('reader.open')}
            disabled={!book.words.length}
            onClick={() => setReading(true)}
          >
            <BookOpenTextIcon />
            {/* A narrow card keeps its width for the sentence being read. */}
            <span className="hidden @min-[26rem]/card:inline">{t('reader.open')}</span>
          </Button>
        </div>
        <div className="flex items-center gap-1">
          {steps && (
            <ChapterStepButton direction="previous" player={player} chapters={book.chapters} />
          )}
          <SeekBar player={player} chapters={book.chapters} className="mx-1 flex-1" />
          {steps && <ChapterStepButton direction="next" player={player} chapters={book.chapters} />}
          <PlaybackTime className="ms-1" />
          <RateMenu player={player} />
        </div>
      </div>
      {error && (
        <p role="alert" className="border-t border-border/50 px-3 py-2 text-xs text-destructive">
          {t('player.unavailable')}
        </p>
      )}
      <AudiobookReader open={reading} onOpenChange={setReading} player={player} book={book} />
    </>
  );
}

function NowPlayingText({ book }: { book: ReaderBook }) {
  const { t } = useTranslation();
  const { word, sentence, chapter } = usePlayhead(book);
  return (
    <div className="min-w-0 flex-1">
      <p className="flex h-4 min-w-0 items-baseline gap-1.5 text-xs leading-4">
        {chapter >= 0 && (
          <>
            <span className="truncate font-medium">{chapterTitle(t, book, chapter)}</span>
            {book.chapters.length > 1 && (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {chapter + 1}/{book.chapters.length}
              </span>
            )}
          </>
        )}
      </p>
      <SentenceLine key={sentence} book={book} sentence={sentence} word={word} />
    </div>
  );
}

// One line of the sentence being read. It slides sideways to keep the
// current word in sight; the word is tinted, never re-weighted, so the line
// never reflows. Keyed by sentence, so each new one starts at its beginning.
const SentenceLine = memo(function SentenceLine({
  book,
  sentence,
  word,
}: {
  book: ReaderBook;
  sentence: number;
  word: number;
}) {
  const line = useRef<HTMLParagraphElement>(null);
  const current = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const element = line.current;
    const active = current.current;
    if (!element || !active) return;
    const { left, scrolled } = followLine(
      active,
      element,
      getComputedStyle(element).direction === 'rtl',
    );
    if (left !== null) element.scrollTo({ left });
    element.toggleAttribute('data-scrolled', scrolled);
  }, [word]);

  return (
    // `dir="auto"`: the line runs the way the book's text does, whatever the
    // app's language; the fades follow it.
    <p
      ref={line}
      dir="auto"
      lang={book.lang}
      className="relative h-5 overflow-hidden scroll-smooth text-[13px] leading-5 whitespace-nowrap text-muted-foreground [mask-image:linear-gradient(to_right,black_calc(100%_-_2rem),transparent)] motion-reduce:scroll-auto data-scrolled:[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%_-_2rem),transparent)] rtl:[mask-image:linear-gradient(to_left,black_calc(100%_-_2rem),transparent)] rtl:data-scrolled:[mask-image:linear-gradient(to_left,transparent,black_1.5rem,black_calc(100%_-_2rem),transparent)]"
    >
      {sentence >= 0 &&
        sentencePieces(book, sentence).map(({ word: index, lead, text }) => (
          <Fragment key={index}>
            {lead}
            <span
              ref={index === word ? current : undefined}
              className={cn(
                'transition-colors duration-150 motion-reduce:transition-none',
                index === word && 'text-primary',
              )}
            >
              {text}
            </span>
          </Fragment>
        ))}
    </p>
  );
});
