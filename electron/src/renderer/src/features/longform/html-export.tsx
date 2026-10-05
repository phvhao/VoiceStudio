import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { FileCodeIcon } from 'lucide-react';
import { getBridge } from '@/components/bridge';
import { Button } from '@/components/ui/button';
import { apiJson, apiPath, describeError } from '@/lib/api/client';
import { saveExport } from '@/lib/export-history';
import type { Draft } from './longform-session';

/** The exported page's own words, in the app's language. */
export function htmlExportLabels(t: TFunction) {
  return {
    play: t('book.html_play'),
    pause: t('book.html_pause'),
    back: t('book.html_back'),
    forward: t('book.html_forward'),
    seek: t('book.html_seek'),
    speed: t('book.html_speed'),
    contents: t('book.contents'),
    narrated_by: t('book.html_narrated_by'),
    player: t('book.html_player'),
    estimated: t('book.html_estimated'),
    keys: t('book.html_keys'),
  };
}

/**
 * `POST /audiobook/export/html` for the draft's finished book. The script and
 * chapter lengths it was rendered from go along: a book rendered before
 * timelines were kept gets one estimated from them.
 */
export function htmlExportBody(draft: Draft, t: TFunction, lang: string) {
  const durations = draft.outputChapters.map((chapter) =>
    chapter.status === 'failed'
      ? null
      : chapter.duration_ms != null
        ? chapter.duration_ms / 1000
        : (chapter.duration_s ?? Number.NaN),
  );
  const timed = durations.length > 0 && durations.every((d) => d === null || Number.isFinite(d));
  return {
    output: draft.output,
    title: draft.title,
    metadata: draft.metadata,
    cover_path: draft.cover?.path ?? null,
    text: draft.outputScript || null,
    chapter_durations: draft.outputScript && timed ? durations : null,
    lang,
    labels: htmlExportLabels(t),
  };
}

/** The ZIP's name in the save dialog: the book's title, else its file name. */
export function htmlExportName(draft: Draft): string {
  const stem = draft.title.trim() || draft.output.replace(/\.[^.]+$/, '') || 'audiobook';
  return `${stem}.zip`;
}

/**
 * Build the book's web-page export and save it like every other export: the
 * native save dialog under Electron, a download in the browser.
 */
export async function exportBookHtml(draft: Draft, t: TFunction, lang: string) {
  const { output } = await apiJson<{ output: string }>('/audiobook/export/html', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(htmlExportBody(draft, t, lang)),
  });
  const url = apiPath('/audio/' + encodeURIComponent(output));
  const name = htmlExportName(draft);
  if (getBridge()) {
    await saveExport(url, name);
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}

/** "Export HTML" beside a finished book's downloads. */
export function ExportHtmlButton({
  draft,
  disabled,
  onError,
}: {
  draft: Draft;
  disabled?: boolean;
  onError: (message: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled || busy}
      title={t('book.export_html_hint')}
      onClick={async () => {
        setBusy(true);
        onError(null);
        try {
          await exportBookHtml(draft, t, i18n.language);
        } catch (cause) {
          onError(describeError(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileCodeIcon />
      {t('book.export_html')}
    </Button>
  );
}
