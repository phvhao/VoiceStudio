import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiJson } from '@/lib/api/client';
import { SYSTEM_FONT } from './html-design';

/**
 * The reading fonts bundled with the app (`GET /fonts`, from the backend's
 * `assets/fonts`): the export dialog lists them, and the reader shows a book
 * in the body font its design chose. Loaded from the local backend, never the
 * network; through `apiFetch`, so a remote backend's credentials go along.
 */

export interface BookFontFace {
  file: string;
  style: 'normal' | 'italic';
  /** One weight, or a variable font's range. */
  weight: [number, number];
  bytes: number;
}

export interface BookFontFamily {
  id: string;
  family: string;
  category: 'serif' | 'sans' | 'display' | 'rounded' | 'handwriting' | 'mono';
  bytes: number;
  files: BookFontFace[];
}

export const BOOK_FONT_CATEGORIES: readonly BookFontFamily['category'][] = [
  'serif',
  'display',
  'sans',
  'rounded',
  'handwriting',
  'mono',
];

/** The bundled families; they change only with the app. */
export function useBookFonts({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['book-fonts'],
    queryFn: ({ signal }) => apiJson<{ families: BookFontFamily[] }>('/fonts', { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    select: (data) => data.families,
    enabled,
  });
}

/** What the reader names a bundled family: its own name stays the app's fonts'. */
export function bookFontAlias(family: BookFontFamily) {
  return `VoiceStudio Book ${family.family}`;
}

const loading = new Map<string, Promise<string>>();

/**
 * Register `family`'s upright and italic faces with the document, once; the
 * CSS name to set them with, or a rejection when a file could not be read.
 */
export function loadBookFont(family: BookFontFamily): Promise<string> {
  const alias = bookFontAlias(family);
  let pending = loading.get(family.id);
  if (!pending) {
    pending = Promise.all(
      family.files.map(async (face) => {
        const response = await apiFetch(
          `/fonts/${encodeURIComponent(family.id)}/${encodeURIComponent(face.file)}`,
        );
        if (!response.ok) throw new Error(`Font ${face.file}: HTTP ${response.status}`);
        const [low, high] = face.weight;
        const loaded = await new FontFace(alias, await response.arrayBuffer(), {
          style: face.style,
          weight: low === high ? String(low) : `${low} ${high}`,
        }).load();
        document.fonts.add(loaded);
      }),
    ).then(() => alias);
    pending.catch(() => loading.delete(family.id));
    loading.set(family.id, pending);
  }
  return pending;
}

/**
 * The `font-family` to set a book's text in for the bundled family `id`, once
 * it has loaded; `undefined` for system fonts, an unknown id, or until then.
 */
export function useBookFontFamily(id: string | null | undefined): string | undefined {
  const fonts = useBookFonts({ enabled: Boolean(id) && id !== SYSTEM_FONT });
  const family = id && id !== SYSTEM_FONT ? fonts.data?.find((f) => f.id === id) : undefined;
  const [ready, setReady] = useState<{ id: string; css: string } | null>(null);
  useEffect(() => {
    if (!family) return;
    let live = true;
    loadBookFont(family)
      .then((alias) => {
        if (live) setReady({ id: family.id, css: `"${alias}", ${FALLBACK[family.category]}` });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [family]);
  return family && ready?.id === family.id ? ready.css : undefined;
}

const FALLBACK: Record<BookFontFamily['category'], string> = {
  serif: 'serif',
  display: 'serif',
  sans: 'sans-serif',
  rounded: 'sans-serif',
  handwriting: 'cursive',
  mono: 'monospace',
};
