import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CircleAlertIcon,
  ClapperboardIcon,
  DownloadIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { getBridge } from '@/components/bridge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useRadioKeys } from '@/hooks/use-radio-keys';
import { ApiError, apiFetch, apiPath } from '@/lib/api/client';
import { saveExport } from '@/lib/export-history';
import { cn } from '@/lib/utils';
import { consumeLongformStream } from '@shared/utils/longformStream';
import { useBookFontFamily, useBookFonts } from './book-fonts';
import { useLibraryImages } from './image-library';
import { editLongform, type Draft, type Mode } from './longform-session';
import { imageTagParts } from './script-markup';
import { coverUrl, imageUrl, showsWhole, timelineSlides } from './slideshow';
import { fetchAudiobookTimeline } from './synced-audiobook-player';
import {
  CAPTION_SIZES,
  DEFAULT_VIDEO_DESIGN,
  DEFAULT_VIDEO_FONT,
  VIDEO_ACCENTS,
  VIDEO_ASPECTS,
  VIDEO_QUALITIES,
  estimateVideoBytes,
  estimateVideoSeconds,
  scriptPictureNames,
  videoExportName,
  videoRequest,
  type VideoDesign,
} from './video-design';

const IMAGE_TAG_RE = /\[image:[^\][\n]*\]/gi;

/** The picture names a script's `[image:]` tags give (`none` as null). */
function picturesIn(text: string): string[] {
  return Array.from(text.matchAll(IMAGE_TAG_RE), (match) => imageTagParts(match[0])?.name ?? '');
}

/**
 * A refusal or a failed video in the app's words: the backend names why in a
 * code, and its own sentence (English) is never shown — a code this app does
 * not know reads as the plain failure. `fallback` is for failures with no
 * code (the request itself failed).
 */
function videoError(t: TFunction, code: string | undefined, fallback: string): string {
  const known: Record<string, string> = {
    video_needs_timeline: 'videoExport.error_needs_timeline',
    video_no_book: 'videoExport.error_no_book',
    video_no_ffmpeg: 'videoExport.error_no_ffmpeg',
    video_ffmpeg_lacks: 'videoExport.error_ffmpeg_lacks',
    video_busy: 'videoExport.error_busy',
    video_disk_full: 'videoExport.error_disk_full',
    video_encode_failed: 'videoExport.error_encode',
    video_mux_failed: 'videoExport.error_encode',
    video_empty_book: 'videoExport.error_empty',
    video_failed: 'videoExport.error_failed',
  };
  if (code) return t(known[code] ?? 'videoExport.error_failed');
  return fallback || t('videoExport.error_failed');
}

/** Seconds as the app shows a length of time: "45 s", "12 min", "1 h 05 min". */
function duration(t: TFunction, seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return t('videoExport.seconds', { n: total });
  const minutes = Math.round(total / 60);
  if (minutes < 60) return t('videoExport.minutes', { n: minutes });
  return t('videoExport.hours', {
    h: Math.floor(minutes / 60),
    m: String(minutes % 60).padStart(2, '0'),
  });
}

function megabytes(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 2 ** 20))} MB`;
}

type Run =
  | { phase: 'idle' }
  | { phase: 'making'; percent: number; started: number; missing: string[] }
  | { phase: 'finishing'; started: number; missing: string[] }
  | { phase: 'ready'; id: string; bytes: number }
  | { phase: 'failed'; message: string };

function Segmented<T extends string | number>({
  label,
  values,
  value,
  onChange,
  name,
}: {
  label: string;
  values: readonly T[];
  value: T;
  onChange(value: T): void;
  name(value: T): string;
}) {
  const keys = useRadioKeys(values, value, onChange);
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div
        role="radiogroup"
        aria-label={label}
        {...keys.group}
        className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5 ring-1 ring-border/50 ring-inset"
      >
        {values.map((option, index) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={value === option}
            {...keys.option(index)}
            onClick={() => onChange(option)}
            className={cn(
              'h-8 min-w-0 flex-1 truncate rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
              value === option
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {name(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
  children,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-start justify-between gap-3 text-sm">
        <span className="min-w-0">
          <span className="block font-medium">{label}</span>
          {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
        </span>
        <Switch checked={checked} disabled={disabled} onCheckedChange={(next) => onChange(next)} />
      </label>
      {checked && children}
    </div>
  );
}

/**
 * The video's first frame as it will look: its first picture (or the cover,
 * or the plain backdrop), the title card, and a caption with its first words
 * filled — at the frame's shape, its text sized as the video sizes it.
 */
function VideoPreview({
  design,
  picture,
  fit,
  caption,
  title,
}: {
  design: VideoDesign;
  picture?: string;
  fit: 'auto' | 'cover' | 'contain';
  caption: string;
  title: string;
}) {
  const font = useBookFontFamily(design.font ?? DEFAULT_VIDEO_FONT);
  const [whole, setWhole] = useState(fit === 'contain');
  const [w, h] = design.aspect.split(':').map(Number);
  const words = caption.split(/\s+/).filter(Boolean).slice(0, design.aspect === '9:16' ? 9 : 14);
  const filled = Math.max(1, Math.round(words.length * 0.4));
  // Sizes as shares of the frame's short side, as the video sets them.
  const share = { s: 0.046, m: 0.056, l: 0.068 }[design.size];
  return (
    <div
      className="relative mx-auto max-h-full max-w-full overflow-hidden rounded-lg bg-[radial-gradient(120%_90%_at_50%_35%,#272b38_0,#0e0f14_70%)] shadow-lg ring-1 ring-border/50 [container-type:size]"
      style={{ aspectRatio: `${w} / ${h}`, height: w >= h ? undefined : '100%', width: w >= h ? '100%' : undefined }}
      data-testid="video-preview"
    >
      {picture && (
        <>
          {whole && (
            <img
              src={picture}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 size-full scale-110 object-cover blur-xl brightness-50"
            />
          )}
          <img
            src={picture}
            alt=""
            className={cn('absolute inset-0 size-full', whole ? 'object-contain' : 'object-cover')}
            onLoad={(event) => {
              const image = event.currentTarget;
              setWhole(
                showsWhole(fit, { width: image.naturalWidth, height: image.naturalHeight }, { width: w, height: h }),
              );
            }}
          />
        </>
      )}
      {design.captions && (
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-transparent to-black/60" />
      )}
      {design.titles && title && (
        <p
          className="absolute inset-x-[7%] top-1/2 -translate-y-1/2 text-center font-bold text-white [text-shadow:0_2px_8px_rgb(0_0_0/0.7)]"
          style={{ fontFamily: font, fontSize: `calc(${share * 1.8 * 100}cqmin)` } as CSSProperties}
        >
          {title}
        </p>
      )}
      {design.captions && words.length > 0 && (
        <p
          className="absolute inset-x-[7%] text-center leading-snug font-bold text-white [text-shadow:0_2px_6px_rgb(0_0_0/0.8)]"
          style={
            {
              fontFamily: font,
              fontSize: `calc(${share * 100}cqmin)`,
              bottom: design.aspect === '9:16' ? '17%' : design.aspect === '1:1' ? '9%' : '7.5%',
            } as CSSProperties
          }
        >
          {words.map((word, index) => (
            <span
              key={index}
              style={design.karaoke && index < filled ? { color: design.accent } : undefined}
            >
              {index ? ' ' : ''}
              {word}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function VideoExportDialog({
  open,
  onOpenChange,
  draft,
  mode,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  draft: Draft;
  mode: Mode;
}) {
  const { t } = useTranslation();
  const fonts = useBookFonts({ enabled: open });
  const families = fonts.data ?? [];
  const library = useLibraryImages({ enabled: open });
  const timeline = useQuery({
    queryKey: ['audiobook-timeline', draft.output],
    queryFn: ({ signal }) => fetchAudiobookTimeline(draft.output, signal),
    enabled: open && Boolean(draft.output),
  });
  const design = draft.videoExport ?? DEFAULT_VIDEO_DESIGN;
  const patch = (value: Partial<VideoDesign>) =>
    editLongform(mode, { videoExport: { ...design, ...value } });
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const slides = useMemo(() => timelineSlides(timeline.data), [timeline.data]);
  const length = timeline.data?.duration ?? 0;
  const first = slides.find((slide) => slide.start < 1) ?? null;
  const preview = first?.name ? imageUrl(first.name) : coverUrl(draft.cover);
  const caption =
    timeline.data?.chapters.flatMap((chapter) => chapter.phrases).find((phrase) => phrase.text)
      ?.text ?? '';
  const known = new Set((library.data ?? []).map((image) => image.name));
  const shown = new Set(slides.map((slide) => slide.name).filter((name): name is string => !!name));
  const missing = library.isSuccess ? [...shown].filter((name) => !known.has(name)) : [];
  const written = new Set(scriptPictureNames(draft, mode, picturesIn).filter(Boolean));
  const changed =
    timeline.isSuccess &&
    (written.size !== shown.size || [...written].some((name) => !shown.has(name)));
  const busy = run.phase === 'making' || run.phase === 'finishing';
  const noTimeline = timeline.isSuccess && !timeline.data;

  const stop = () => {
    controller.current?.abort();
    controller.current = null;
    setRun({ phase: 'idle' });
  };
  const close = (next: boolean) => {
    if (!next && busy) stop();
    onOpenChange(next);
  };
  const discard = (id: string) =>
    void apiFetch('/audiobook/export/video/' + encodeURIComponent(id), { method: 'DELETE' }).catch(
      () => undefined,
    );
  const save = async (id: string) => {
    const path = '/audiobook/export/video/' + encodeURIComponent(id);
    const name = videoExportName(draft);
    if (!getBridge()) {
      const link = document.createElement('a');
      link.href = apiPath(path);
      link.download = name;
      link.click();
      return;
    }
    try {
      const saved = await saveExport(apiPath(path), name);
      if (!saved || saved.canceled) return; // kept: "Save video" tries again
      discard(id);
      setRun({ phase: 'idle' });
      toast.success(t('videoExport.saved'));
      onOpenChange(false);
    } catch (cause) {
      toast.error(t('videoExport.save_failed', { error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const make = async () => {
    const current = new AbortController();
    controller.current = current;
    const started = Date.now();
    setRun({ phase: 'making', percent: 0, started, missing: [] });
    let finished: { id: string; bytes: number } | null = null;
    let failure: string | null = null;
    try {
      const response = await apiFetch('/audiobook/export/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(videoRequest(draft, design)),
        signal: current.signal,
      });
      let gone: string[] = [];
      await consumeLongformStream(
        response,
        (event) => {
          if (event.type === 'start') {
            gone = Array.isArray(event.missing) ? (event.missing as string[]) : [];
            setRun({ phase: 'making', percent: 0, started, missing: gone });
          } else if (event.type === 'progress') {
            setRun({ phase: 'making', percent: Number(event.percent) || 0, started, missing: gone });
          } else if (event.type === 'finishing') {
            setRun({ phase: 'finishing', started, missing: gone });
          } else if (event.type === 'done') {
            finished = { id: String(event.id), bytes: Number(event.bytes) || 0 };
          } else if (event.type === 'error') {
            failure = videoError(t, String(event.error_code ?? ''), String(event.error ?? ''));
          }
        },
        { signal: current.signal },
      );
    } catch (cause) {
      if (current.signal.aborted) return;
      const detail = cause instanceof ApiError ? cause.payload?.detail : null;
      const code = detail && typeof detail === 'object' && 'code' in detail ? String(detail.code) : '';
      failure = videoError(t, code, cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (controller.current === current) controller.current = null;
    }
    if (current.signal.aborted) return;
    const result = finished as { id: string; bytes: number } | null;
    if (result) {
      setRun({ phase: 'ready', ...result });
      await save(result.id);
    } else {
      setRun({ phase: 'failed', message: failure ?? t('videoExport.error_failed') });
    }
  };

  const progress = run.phase === 'making' ? run.percent : run.phase === 'finishing' ? 100 : 0;
  const elapsed = busy ? (Date.now() - run.started) / 1000 : 0;
  const remaining =
    run.phase === 'making' && run.percent > 2 ? (elapsed * (100 - run.percent)) / run.percent : null;
  const blocked = noTimeline || !draft.output;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(92vh,48rem)] w-[min(96vw,64rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <div className="flex items-start gap-3 border-b border-border/50 py-3 pe-3 ps-5">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ClapperboardIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base">{t('videoExport.title')}</DialogTitle>
            <DialogDescription className="text-xs">{t('videoExport.description')}</DialogDescription>
          </div>
          <DialogClose
            render={
              <Button variant="ghost" size="icon-sm" aria-label={t('common.close')} title={t('common.close')} />
            }
          >
            <XIcon />
          </DialogClose>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(19rem,22rem)_1fr] md:overflow-hidden">
          <fieldset
            disabled={busy}
            className="min-w-0 space-y-4 overflow-y-auto border-border/50 p-5 md:border-e"
          >
            <Segmented
              label={t('videoExport.frame')}
              values={VIDEO_ASPECTS}
              value={design.aspect}
              onChange={(aspect) => patch({ aspect })}
              name={(aspect) => t(`videoExport.frame_${aspect.replace(':', 'x')}`)}
            />
            <Segmented
              label={t('videoExport.quality')}
              values={VIDEO_QUALITIES}
              value={design.quality}
              onChange={(quality) => patch({ quality })}
              name={(quality) => `${quality}p`}
            />
            <Toggle
              label={t('videoExport.motion')}
              hint={t('videoExport.motion_hint')}
              checked={design.motion}
              onChange={(motion) => patch({ motion })}
            />
            <Toggle
              label={t('videoExport.transitions')}
              checked={design.transitions}
              onChange={(transitions) => patch({ transitions })}
            />
            <Toggle
              label={t('videoExport.titles')}
              hint={t('videoExport.titles_hint')}
              checked={design.titles}
              onChange={(titles) => patch({ titles })}
            />
            <Toggle
              label={t('videoExport.captions')}
              hint={t('videoExport.captions_hint')}
              checked={design.captions}
              onChange={(captions) => patch({ captions })}
            >
              <div className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3">
                <Toggle
                  label={t('videoExport.karaoke')}
                  checked={design.karaoke}
                  onChange={(karaoke) => patch({ karaoke })}
                />
                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  <span>{t('videoExport.font')}</span>
                  <Select
                    items={families.map((family) => ({ value: family.id, label: family.family }))}
                    value={design.font ?? DEFAULT_VIDEO_FONT}
                    onValueChange={(font) => patch({ font: String(font) })}
                  >
                    <SelectTrigger aria-label={t('videoExport.font')} className="w-full text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false} className="max-h-80">
                      {families.map((family) => (
                        <SelectItem key={family.id} value={family.id}>
                          {family.family}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <Segmented
                  label={t('videoExport.size')}
                  values={CAPTION_SIZES}
                  value={design.size}
                  onChange={(size) => patch({ size })}
                  name={(size) => t(`videoExport.size_${size}`)}
                />
                {design.karaoke && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">{t('videoExport.accent')}</p>
                    <div role="radiogroup" aria-label={t('videoExport.accent')} className="flex flex-wrap items-center gap-1.5">
                      {VIDEO_ACCENTS.map((accent) => (
                        <button
                          key={accent}
                          type="button"
                          role="radio"
                          aria-checked={design.accent === accent}
                          aria-label={accent}
                          title={accent}
                          onClick={() => patch({ accent })}
                          className={cn(
                            'size-6 rounded-full ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            design.accent === accent && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                          )}
                          style={{ background: accent }}
                        />
                      ))}
                      <input
                        type="color"
                        value={design.accent}
                        aria-label={t('videoExport.accent_custom')}
                        title={t('videoExport.accent_custom')}
                        onChange={(event) => patch({ accent: event.target.value.toLowerCase() })}
                        className="size-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
                      />
                    </div>
                  </div>
                )}
              </div>
            </Toggle>
          </fieldset>
          <div className="flex min-h-72 min-w-0 flex-col gap-3 bg-muted/25 p-4">
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <VideoPreview
                design={design}
                picture={preview}
                fit={first?.fit ?? 'auto'}
                caption={caption || t('videoExport.sample_caption')}
                title={draft.title.trim()}
              />
            </div>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              {length > 0 && (
                <p>
                  {t('videoExport.estimate', {
                    time: duration(t, estimateVideoSeconds(length, design)),
                    size: megabytes(estimateVideoBytes(length, design)),
                    length: duration(t, length),
                  })}
                </p>
              )}
              {changed && (
                <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  {t('videoExport.pictures_changed')}
                </p>
              )}
              {missing.length > 0 && (
                <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  {t('videoExport.pictures_missing', { names: missing.join(', ') })}
                </p>
              )}
              {noTimeline && (
                <p className="flex items-start gap-1.5 text-destructive">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  {t('videoExport.error_needs_timeline')}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border/50 px-5 py-3">
          <div className="min-w-0 flex-1" aria-live="polite">
            {busy && (
              <div className="space-y-1.5">
                <div
                  role="progressbar"
                  aria-label={t('videoExport.making')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {run.phase === 'finishing'
                    ? t('videoExport.finishing')
                    : remaining !== null
                      ? t('videoExport.making_left', {
                          percent: Math.round(progress),
                          left: duration(t, remaining),
                        })
                      : t('videoExport.making_percent', { percent: Math.round(progress) })}
                </p>
              </div>
            )}
            {run.phase === 'failed' && (
              <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {run.message}
              </p>
            )}
            {run.phase === 'ready' && (
              <p className="text-xs text-muted-foreground">
                {t('videoExport.ready', { size: megabytes(run.bytes) })}
              </p>
            )}
          </div>
          {busy ? (
            <Button variant="secondary" onClick={stop}>
              <SquareIcon className="fill-current" />
              {t('common.stop')}
            </Button>
          ) : run.phase === 'ready' ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  discard(run.id);
                  setRun({ phase: 'idle' });
                }}
              >
                <Trash2Icon />
                {t('videoExport.discard')}
              </Button>
              <Button onClick={() => void save(run.id)}>
                <DownloadIcon />
                {t('videoExport.save')}
              </Button>
            </>
          ) : (
            <Button disabled={blocked} onClick={() => void make()}>
              <ClapperboardIcon />
              {t('videoExport.make')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Export video" beside a finished book's or story's downloads. */
export function ExportVideoButton({
  draft,
  mode,
  disabled,
}: {
  draft: Draft;
  mode: Mode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={t('videoExport.button_hint')}
        onClick={() => setOpen(true)}
      >
        <ClapperboardIcon />
        {t('videoExport.button')}
      </Button>
      <VideoExportDialog open={open} onOpenChange={setOpen} draft={draft} mode={mode} />
    </>
  );
}
