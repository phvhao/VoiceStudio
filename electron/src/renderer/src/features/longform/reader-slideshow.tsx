import { useRef, useState, type CSSProperties, type RefObject } from 'react';
import { MaximizeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMediaState, useMediaTime } from '@/components/media-player';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePlayhead, type ReaderBook } from './audiobook-reader';
import {
  captionWords,
  imageUrl,
  showsWhole,
  slideIndexAt,
  type ImageFit,
  type Slide,
} from './slideshow';
import './slideshow.css';

/** A picture zooms over the time it shows, at least this long and at most that. */
const ZOOM_MIN_S = 6;
const ZOOM_MAX_S = 30;

interface Layer {
  id: number;
  src?: string;
  fit: ImageFit;
  /** Odd slides zoom out, even ones in, so a run of pictures never feels mechanical. */
  out: boolean;
  seconds: number;
}

/**
 * The reader's slideshow: the picture the script shows at the playhead
 * (`slides`; before the first, `cover`) with a slow zoom and a crossfade
 * from the one before, and the sentence being read as a caption whose words
 * fill as they are heard. Render it inside the `StudioMediaPlayer` that
 * plays the book. Re-renders when the slide or the word changes, never on
 * a clock tick that changes neither.
 */
export function ReaderSlideshow({
  book,
  slides,
  cover,
}: {
  book: ReaderBook;
  slides: readonly Slide[];
  cover?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const slide = useMediaTime((time) => slideIndexAt(slides, time));
  const paused = useMediaState('paused');
  return (
    <div
      ref={stage}
      className="slideshow relative min-h-0 flex-1 overflow-hidden"
      data-paused={paused ? '' : undefined}
      data-testid="reader-slideshow"
    >
      <SlideLayers slides={slides} index={slide} cover={cover} stage={stage} />
      <div className="slideshow-shade" aria-hidden="true" />
      <SlideCaption book={book} />
      <FullscreenButton target={stage} />
    </div>
  );
}

function SlideLayers({
  slides,
  index,
  cover,
  stage,
}: {
  slides: readonly Slide[];
  index: number;
  cover?: string;
  stage: RefObject<HTMLDivElement | null>;
}) {
  const duration = useMediaState('duration');
  const layerFor = (id: number): Layer => {
    const slide = index >= 0 ? slides[index] : null;
    const until = index + 1 < slides.length ? slides[index + 1].start : duration || 0;
    const span = until - (slide?.start ?? 0);
    return {
      id,
      src: slide?.name ? imageUrl(slide.name) : cover,
      fit: slide?.fit ?? 'auto',
      out: index % 2 !== 0,
      seconds: Math.max(ZOOM_MIN_S, Math.min(ZOOM_MAX_S, span > 0 ? span : 20)),
    };
  };
  // Which slide each of the two layers holds, and the one on top. Adjusted
  // while rendering, so the frame that moves past a picture's time shows it.
  const [shown, setShown] = useState(() => ({
    slides,
    index,
    cover,
    active: 0,
    layers: [layerFor(0), null] as [Layer | null, Layer | null],
  }));
  if (shown.index !== index || shown.slides !== slides || shown.cover !== cover) {
    const active = shown.active === 0 ? 1 : 0;
    const layers: [Layer | null, Layer | null] = [...shown.layers];
    layers[active] = layerFor(Math.max(layers[0]?.id ?? 0, layers[1]?.id ?? 0) + 1);
    setShown({ slides, index, cover, active, layers });
  }
  return (
    <>
      {shown.layers.map((layer, slot) =>
        layer ? (
          <SlideLayer key={layer.id} layer={layer} on={slot === shown.active} stage={stage} />
        ) : null,
      )}
    </>
  );
}

function SlideLayer({
  layer,
  on,
  stage,
}: {
  layer: Layer;
  on: boolean;
  stage: RefObject<HTMLDivElement | null>;
}) {
  const [whole, setWhole] = useState(layer.fit === 'contain');
  return (
    <div
      className={cn(
        'slideshow-layer',
        on && 'is-on',
        layer.out && 'is-out',
        !layer.src && 'is-empty',
        whole && 'is-whole',
      )}
      style={{ '--slideshow-zoom': `${layer.seconds}s` } as CSSProperties}
      data-testid={on ? 'slideshow-current' : undefined}
    >
      {layer.src && (
        <>
          <img className="slideshow-backdrop" src={layer.src} alt="" aria-hidden="true" />
          <img
            className="slideshow-picture"
            src={layer.src}
            alt=""
            onLoad={(event) => {
              const picture = event.currentTarget;
              const frame = stage.current;
              setWhole(
                showsWhole(
                  layer.fit,
                  { width: picture.naturalWidth, height: picture.naturalHeight },
                  { width: frame?.clientWidth ?? 0, height: frame?.clientHeight ?? 0 },
                ),
              );
            }}
          />
        </>
      )}
    </div>
  );
}

/** The words of the sentence being read, each filled as it is heard. */
function SlideCaption({ book }: { book: ReaderBook }) {
  const { word, sentence } = usePlayhead(book);
  const rate = useMediaState('playbackRate') || 1;
  const range = captionWords(book, sentence, word);
  if (!range) return null;
  const pieces = [];
  for (let i = range[0]; i <= range[1]; i++) {
    const current = book.words[i];
    if (!current.display) continue;
    if (pieces.length) pieces.push(' ');
    pieces.push(
      <span
        key={i}
        className={cn('slideshow-word', i < word && 'is-read', i === word && 'is-on')}
        style={
          i === word
            ? ({
                '--slideshow-word': `${Math.max(0.05, (current.end - current.start) / rate)}s`,
              } as CSSProperties)
            : undefined
        }
      >
        {current.display}
      </span>,
    );
  }
  return (
    <p className="slideshow-caption" lang={book.lang || undefined} dir="auto">
      {pieces}
    </p>
  );
}

function FullscreenButton({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation();
  if (typeof document === 'undefined' || !document.fullscreenEnabled) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="absolute end-3 top-3 z-10 rounded-full bg-black/35 text-white hover:bg-black/55 hover:text-white"
      aria-label={t('reader.fullscreen')}
      title={t('reader.fullscreen')}
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void target.current?.requestFullscreen();
      }}
    >
      <MaximizeIcon />
    </Button>
  );
}
