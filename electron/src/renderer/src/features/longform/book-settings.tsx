import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlusIcon, TrashIcon, PlusIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PipelineFailure } from '@/components/pipeline-failure';
import { apiJson, describeError } from '@/lib/api/client';
import { metadataFields, repeatedWords, type BookOptions } from './book-options';
import { LONGFORM_TARGET } from './generate-gates';
export function BookSettings({
  draft,
  disabled,
  pronunciation,
  onChange,
  onBusy,
}: {
  /** The book's options alone: the page passes these, not a whole draft it would have to keep current. */
  draft: BookOptions;
  disabled: boolean;
  pronunciation: boolean;
  onChange: (value: Partial<BookOptions>) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const repeated = repeatedWords(draft.lexicon);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const upload = async (file: File) => {
    if (disabled || controller.current) return;
    const current = new AbortController();
    controller.current = current;
    onBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('cover', file);
      const result = await apiJson<{ path: string }>('/audiobook/cover', {
        method: 'POST',
        body,
        signal: current.signal,
      });
      if (!current.signal.aborted) {
        onChange({ cover: { path: result.path, name: file.name } });
        setPreview(URL.createObjectURL(file));
      }
    } catch (cause) {
      if (!current.signal.aborted) setError(describeError(cause));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        onBusy(false);
      }
    }
  };
  return (
    <div className="space-y-5">
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">{t('audiobook.details')}</summary>
        {metadataFields.map((field) => (
          <label key={field} className="block space-y-1 text-xs text-muted-foreground">
            {t('audiobook.meta_' + field)}
            <Input
              disabled={disabled}
              value={draft.metadata[field] || ''}
              onChange={(e) =>
                onChange({
                  metadata: { ...draft.metadata, [field]: e.target.value },
                })
              }
            />
          </label>
        ))}
        <input
          ref={input}
          type="file"
          className="hidden"
          accept="image/png,image/jpeg"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
        {preview && draft.cover && (
          <img
            src={preview}
            alt={t('audiobook.cover')}
            className="h-32 w-24 rounded-md object-cover"
          />
        )}
        {draft.cover && (
          <p className="break-all text-xs text-muted-foreground">{draft.cover.name}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            <ImagePlusIcon />
            {t('audiobook.cover_add')}
          </Button>
          {draft.cover && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                onChange({ cover: null });
                setPreview('');
              }}
            >
              {t('audiobook.cover_remove')}
            </Button>
          )}
        </div>
        {error && <PipelineFailure fallback={error} onDismiss={() => setError(null)} />}
      </details>
      <details className="space-y-2">
        <summary className="cursor-pointer text-sm font-medium">{t('audiobook.loudness')}</summary>
        {(['off', 'acx', 'podcast'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            className="w-full justify-start"
            disabled={disabled}
            variant={draft.loudness === value ? 'secondary' : 'ghost'}
            onClick={() => onChange({ loudness: value })}
          >
            {t('audiobook.loudness_' + value)}
          </Button>
        ))}
      </details>
      {pronunciation && (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium">{t('audiobook.lexicon')}</summary>
          {draft.lexicon.map((row, index) => (
            <div key={index} className="space-y-1">
              <Input
                aria-label={t('audiobook.lex_word')}
                placeholder={t('audiobook.lex_word')}
                value={row.word}
                // The repeat is what to remove, and where Generate's fix leads.
                aria-invalid={repeated[index] || undefined}
                data-gate-target={repeated[index] ? LONGFORM_TARGET.lexicon : undefined}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    lexicon: draft.lexicon.map((item, i) =>
                      i === index ? { ...item, word: e.target.value } : item,
                    ),
                  })
                }
              />
              <div className="flex gap-1">
                <Input
                  aria-label={t('audiobook.lex_say')}
                  placeholder={t('audiobook.lex_say')}
                  value={row.pronunciation}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({
                      lexicon: draft.lexicon.map((item, i) =>
                        i === index ? { ...item, pronunciation: e.target.value } : item,
                      ),
                    })
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('audiobook.lex_remove')}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      lexicon: draft.lexicon.filter((_, i) => i !== index),
                    })
                  }
                >
                  <TrashIcon />
                </Button>
              </div>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              onChange({
                lexicon: [...draft.lexicon, { word: '', pronunciation: '' }],
              })
            }
          >
            <PlusIcon />
            {t('audiobook.lex_add')}
          </Button>
          {repeated.includes(true) && (
            <p role="alert" className="text-xs text-destructive">
              {t('audiobook.lex_duplicate')}
            </p>
          )}
        </details>
      )}
    </div>
  );
}
