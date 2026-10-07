import { useCallback, useId, useRef, useState } from 'react';
import { ClipboardPasteIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readClipboardText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { isDubUrl } from './dub-session';

/** A copied web link, trimmed; null when the text is anything else. */
export function copiedLink(text: string): string | null {
  const link = text.trim();
  return link && !/\s/.test(link) && isDubUrl(link) ? link : null;
}

let draft = '';

/** The link being typed, still there when the user comes Back from another screen. */
export function useDubUrlDraft(): [string, (value: string) => void] {
  const [value, setValue] = useState(draft);
  const update = useCallback((next: string) => {
    draft = next;
    setValue(next);
  }, []);
  return [value, update];
}

/**
 * The Dub source's link field: type a video's address, or Paste it from the
 * clipboard in one click. Paste takes only a web link — anything else leaves
 * the field as it was and says why.
 */
export function DubUrlField({
  value,
  onChange,
  onClear,
  disabled,
}: {
  value: string;
  onChange(value: string): void;
  onClear(): void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const field = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const [note, setNote] = useState<'not_link' | 'blocked' | null>(null);
  // One read at a time; the button stays enabled so it keeps the keyboard focus.
  const pasting = useRef(false);
  const paste = async () => {
    if (pasting.current) return;
    const before = field.current?.value ?? value;
    setNote(null);
    pasting.current = true;
    let text: string;
    try {
      text = await readClipboardText();
    } catch {
      setNote('blocked');
      return;
    } finally {
      pasting.current = false;
    }
    // Typing during a clipboard prompt wins over what the clipboard held.
    if ((field.current?.value ?? value) !== before) return;
    const link = copiedLink(text);
    if (!link) {
      setNote('not_link');
      return;
    }
    onChange(link);
    field.current?.focus();
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            ref={field}
            type="url"
            value={value}
            onChange={(event) => {
              setNote(null);
              onChange(event.target.value);
            }}
            aria-label={t('dub.paste_url')}
            aria-describedby={note ? noteId : undefined}
            placeholder={t('dub.paste_url')}
            disabled={disabled}
          />
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => void paste()}
        >
          <ClipboardPasteIcon aria-hidden="true" />
          {t('context.paste')}
        </Button>
        {value && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={t('common.clear')}
            disabled={disabled}
            onClick={() => {
              setNote(null);
              onClear();
            }}
          >
            {t('common.clear')}
          </Button>
        )}
      </div>
      {/* Mounted while empty, so assistive technology announces the note when it appears. */}
      <p
        id={noteId}
        role="status"
        className={cn('text-xs text-muted-foreground', !note && 'sr-only')}
      >
        {note === 'not_link'
          ? t('dubUrl.not_link')
          : note === 'blocked'
            ? t('clone.paste_failed')
            : ''}
      </p>
    </div>
  );
}
