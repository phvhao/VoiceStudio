import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ImageIcon,
  ImageOffIcon,
  ImagePlusIcon,
  LoaderCircleIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, apiJson, describeError } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import { cn } from '@/lib/utils';
import type { MarkupEdit } from './script-markup';
import { imageUrl } from './slideshow';

/**
 * The picture library long-form scripts show with `[image: NAME]`
 * (`/longform/images`): the pictures kept on this computer, the dialog that
 * chooses one (and takes new ones in), and the tools the script editors use
 * to insert, change and drop pictures.
 */

export interface LibraryImage {
  name: string;
  width: number;
  height: number;
  bytes: number;
  /** Changes when the file does (a cache key for its thumbnail). */
  version: number;
}

/** File types the picker offers; the backend reads more and rewrites every one. */
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/tiff';
export const IMAGES_QUERY_KEY = ['longform-images'] as const;
const NO_IMAGES: LibraryImage[] = [];

/**
 * The library's pictures, asked for only where they are shown (`enabled`):
 * a script editor holds a tool per line in Stories, and none of them should
 * fetch, or re-render, for pictures nobody is looking at. The app's own query
 * client, so a page without a provider (a test) needs none.
 */
export function useLibraryImages({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery(
    {
      queryKey: IMAGES_QUERY_KEY,
      queryFn: ({ signal }) =>
        apiJson<{ images: LibraryImage[] }>('/longform/images', { signal }).then(
          (result) => result.images,
        ),
      staleTime: 30_000,
      enabled,
    },
    queryClient,
  );
}

/** Case- and accent-blind text to search names in ("rung" finds "rừng"). */
function plain(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd');
}

/** The image files among dropped or pasted ones. */
export function imageFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
}

/** What an upload refusal means to the user (the backend names why in `detail.code`). */
function uploadError(t: TFunction, error: unknown, name: string): string {
  const detail = error instanceof ApiError ? error.payload?.detail : null;
  const code =
    detail && typeof detail === 'object' && 'code' in detail ? String(detail.code) : '';
  const known: Record<string, string> = {
    image_too_large: 'images.error_too_large',
    image_unsupported: 'images.error_unsupported',
    image_too_many_pixels: 'images.error_too_many_pixels',
  };
  return t('images.upload_failed', {
    name,
    reason: known[code] ? t(known[code]) : describeError(error),
  });
}

/** Keep `files` in the library, one at a time: their names, in order; refusals are toasted. */
async function uploadAll(t: TFunction, files: readonly File[]): Promise<string[]> {
  const names: string[] = [];
  for (const file of files) {
    const body = new FormData();
    body.set('file', file);
    try {
      const { image } = await apiJson<{ image: LibraryImage & { reused: boolean } }>(
        '/longform/images',
        { method: 'POST', body },
      );
      names.push(image.name);
    } catch (error) {
      toast.error(uploadError(t, error, file.name));
    }
  }
  return names;
}

/**
 * What the script editors (toolbar, tag card, context menu, suggestions) can
 * do with pictures. The pictures themselves come from `useLibraryImages`,
 * where they are shown.
 */
export interface ImageTools {
  /** Open the library to choose a picture (`null`: back to the book's backdrop). */
  pick(options: { current?: string | null; onChoose(name: string | null): void }): void;
  /** Keep dropped or pasted files in the library: their names, in order. */
  upload(files: readonly File[]): Promise<string[]>;
  /** Put a picture's tag at `caret`: on a line of its own, or at the start of its line. */
  insert(value: string, caret: number, token: string): MarkupEdit;
}

/**
 * The picture tools of one page and the library dialog they open: render
 * `dialog` once, hand `tools` to the editor's toolbar and tools. `insert`
 * says where a chosen picture's tag goes (Audiobook: a line of its own;
 * Stories: the start of the line, each line being its own text).
 */
export function useImagePicker(insert: ImageTools['insert']): {
  tools: ImageTools;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const [request, setRequest] = useState<Parameters<ImageTools['pick']>[0] | null>(null);
  const tools = useMemo<ImageTools>(
    () => ({
      pick: (options) => setRequest(options),
      async upload(files) {
        const names = await uploadAll(t, files);
        if (names.length) await queryClient.invalidateQueries({ queryKey: IMAGES_QUERY_KEY });
        return names;
      },
      insert,
    }),
    [insert, t],
  );
  const dialog = (
    <ImageLibraryDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
      current={request?.current ?? null}
      onChoose={(name) => {
        request?.onChoose(name);
        setRequest(null);
      }}
    />
  );
  return { tools, dialog };
}

/**
 * The picture library: choose one for a script (or none: the book's own
 * backdrop), take new ones in by the button or by dropping them, remove ones
 * no longer wanted.
 */
export function ImageLibraryDialog({
  open,
  onOpenChange,
  current = null,
  onChoose,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The picture the tag being changed shows, if any. */
  current?: string | null;
  onChoose(name: string | null): void;
}) {
  const { t } = useTranslation();
  const library = useLibraryImages({ enabled: open });
  const images = library.data ?? NO_IMAGES;
  const [selected, setSelected] = useState<string | null>(current);
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Every opening starts from the tag's own picture. Adjusted while rendering.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(current);
      setQuery('');
      setConfirming(null);
    }
  }
  const shown = query.trim()
    ? images.filter((image) => plain(image.name).includes(plain(query.trim())))
    : images;

  const take = async (files: File[]) => {
    if (!files.length) return;
    setUploading((count) => count + files.length);
    try {
      const names = await uploadAll(t, files);
      if (names.length) {
        await queryClient.invalidateQueries({ queryKey: IMAGES_QUERY_KEY });
        setSelected(names[names.length - 1]);
        setQuery('');
      }
    } finally {
      setUploading((count) => count - files.length);
    }
  };
  const remove = async (name: string) => {
    setConfirming(null);
    try {
      await apiJson(`/longform/images/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (selected === name) setSelected(null);
      await queryClient.invalidateQueries({ queryKey: IMAGES_QUERY_KEY });
    } catch (error) {
      toast.error(describeError(error));
    }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = imageFiles(event.dataTransfer?.files);
    setDropping(false);
    if (!files.length) return;
    event.preventDefault();
    void take(files);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(88vh,46rem)] w-[min(94vw,52rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="space-y-1 border-b border-border/50 px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="size-4 text-teal-500" aria-hidden="true" />
            {t('images.title')}
          </DialogTitle>
          <DialogDescription>{t('images.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 px-5 pt-3">
          <label className="relative min-w-40 flex-1">
            <SearchIcon
              className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('images.search')}
              aria-label={t('images.search')}
              className="h-8 ps-8 text-sm"
            />
          </label>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            data-testid="image-upload-input"
            onChange={(event) => {
              const files = imageFiles(event.target.files);
              event.target.value = '';
              void take(files);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={uploading > 0}
            onClick={() => fileInput.current?.click()}
          >
            {uploading > 0 ? <LoaderCircleIcon className="animate-spin" /> : <ImagePlusIcon />}
            {uploading > 0 ? t('images.uploading') : t('images.upload')}
          </Button>
        </div>
        <div
          className={cn(
            'relative m-5 mt-3 min-h-48 flex-1 overflow-y-auto rounded-xl border border-dashed border-border/70 p-2 transition-colors',
            dropping && 'border-teal-500/70 bg-teal-500/5',
          )}
          onDragOver={(event) => {
            if (!event.dataTransfer?.types.includes('Files')) return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          {library.isPending ? (
            <p className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t('common.loading')}
            </p>
          ) : library.isError ? (
            <p role="alert" className="flex h-40 items-center justify-center text-sm text-destructive">
              {describeError(library.error)}
            </p>
          ) : shown.length ? (
            <div
              role="listbox"
              aria-label={t('images.title')}
              className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2"
            >
              {shown.map((image) => (
                <div key={image.name} className="group relative">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected === image.name}
                    title={image.name}
                    onClick={() => setSelected(image.name)}
                    onDoubleClick={() => onChoose(image.name)}
                    className={cn(
                      'flex w-full flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/30 text-start outline-none transition focus-visible:ring-2 focus-visible:ring-ring',
                      selected === image.name && 'border-teal-500 ring-2 ring-teal-500/40',
                    )}
                  >
                    <img
                      src={imageUrl(image.name, { thumb: true, version: image.version })}
                      alt=""
                      loading="lazy"
                      className="aspect-video w-full bg-black/40 object-cover"
                    />
                    <span className="flex min-w-0 items-baseline gap-1.5 px-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{image.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {image.width}×{image.height}
                      </span>
                    </span>
                  </button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={confirming === image.name ? 'destructive' : 'secondary'}
                    className={cn(
                      'absolute end-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
                      confirming === image.name && 'opacity-100',
                    )}
                    aria-label={
                      confirming === image.name
                        ? t('images.delete_confirm', { name: image.name })
                        : t('images.delete', { name: image.name })
                    }
                    title={
                      confirming === image.name
                        ? t('images.delete_confirm', { name: image.name })
                        : t('images.delete', { name: image.name })
                    }
                    onClick={() =>
                      confirming === image.name ? void remove(image.name) : setConfirming(image.name)
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <ImagePlusIcon className="size-6 opacity-70" aria-hidden="true" />
              <p>{images.length ? t('images.no_match') : t('images.empty')}</p>
            </div>
          )}
          {dropping && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 text-sm font-medium text-teal-600 dark:text-teal-400">
              {t('images.drop')}
            </div>
          )}
        </div>
        <DialogFooter className="flex-wrap items-center gap-2 border-t border-border/50 px-5 py-3 sm:justify-between">
          <Button type="button" variant="ghost" size="sm" onClick={() => onChoose(null)}>
            <ImageOffIcon />
            {t('images.none')}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!selected || !images.some((image) => image.name === selected)}
              onClick={() => onChoose(selected)}
            >
              {t('images.choose')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
