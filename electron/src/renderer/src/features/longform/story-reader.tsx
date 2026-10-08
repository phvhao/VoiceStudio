import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpenTextIcon, ImagesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MediaProvider,
  StudioMediaPlayer,
  audioLoaders,
  audioSource,
  type MediaPlayerInstance,
} from '@/components/media-player';
import { Button } from '@/components/ui/button';
import { buildLyricsTimeline } from '@shared/utils/audiobookLyrics';
import { AudiobookReader, buildReaderBook, type ReaderView } from './audiobook-reader';
import { timelineSlides } from './slideshow';
import { fetchAudiobookTimeline } from './synced-audiobook-player';

/**
 * A finished story's reader: its lines as the render timed them (the
 * timeline sidecar; a story has no script of its own to read them from) and
 * its slideshow, in a dialog that plays the story itself. The page's own
 * player stops when this one plays (one player at a time).
 */
export function StoryReaderButton({
  src,
  output,
  lang = '',
  cover,
}: {
  src: string;
  output: string;
  lang?: string;
  cover?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ReaderView>('show');
  const player = useRef<MediaPlayerInstance>(null);
  const timeline = useQuery({
    queryKey: ['audiobook-timeline', output],
    queryFn: ({ signal }) => fetchAudiobookTimeline(output, signal),
  });
  const book = useMemo(
    () => ({
      ...buildReaderBook('', buildLyricsTimeline('', { timeline: timeline.data ?? null })),
      lang,
    }),
    [lang, timeline.data],
  );
  const slides = useMemo(() => timelineSlides(timeline.data), [timeline.data]);
  const ready = book.words.length > 0;
  const openIn = (next: ReaderView) => {
    setView(next);
    setOpen(true);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        disabled={!ready}
        onClick={() => openIn('show')}
      >
        <ImagesIcon />
        {t('reader.open_slideshow')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        disabled={!ready}
        onClick={() => openIn('read')}
      >
        <BookOpenTextIcon />
        {t('reader.open')}
      </Button>
      {timeline.isSuccess && !ready && (
        <p className="text-xs text-muted-foreground">{t('reader.needs_timeline')}</p>
      )}
      {open && (
        <StudioMediaPlayer
          playerRef={player}
          sourceKey="story-reader"
          src={audioSource(src)}
          viewType="audio"
          load="eager"
          className="hidden"
        >
          <MediaProvider loaders={audioLoaders} className="hidden" />
          <AudiobookReader
            open
            onOpenChange={setOpen}
            player={player}
            book={book}
            slides={slides}
            cover={cover}
            view={view}
          />
        </StudioMediaPlayer>
      )}
    </div>
  );
}
