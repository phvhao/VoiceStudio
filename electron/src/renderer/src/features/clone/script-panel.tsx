import { importScript, SCRIPT_ACCEPT } from '@/lib/import-script';
import { readClipboardText } from '@/lib/clipboard';
import {
  AlignLeftIcon,
  ChevronDownIcon,
  ClipboardPasteIcon,
  Undo2Icon,
  FileUpIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  SCRIPT_UNSUPPORTED_TAGS,
  ScriptInsertMenu,
  ScriptTagTools,
  useScriptInsertMenu,
} from '@/components/script-insert-menu';
import { FocusToggle } from '@/components/editor-frame/editor-frame';
import { ScriptEditorFrame } from '@/components/editor-frame/script-editor-frame';
import { MarkupTextarea } from '@/features/longform/markup-textarea';
import { setCloneSetting, useCloneSetting } from '@/lib/store/clone-settings';
import { SectionLabel } from './section-label';
import { SYNTHESIS_TARGET } from './synthesis-gates';

export function ScriptPanel({
  voiceName,
  coachmark,
  onUserEdit,
}: { voiceName?: string; coachmark?: string; onUserEdit?: () => void } = {}) {
  const { t } = useTranslation();
  const text = useCloneSetting('text');
  const speed = useCloneSetting('speed');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLDivElement>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const [pasting, setPasting] = useState(false);
  const insert = useScriptInsertMenu(textareaRef);

  useEffect(() => {
    if (!pasteOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !pasteRef.current?.contains(target)) setPasteOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPasteOpen(false);
        textareaRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [pasteOpen]);

  const edit = (value: string, replace = false) => {
    const field = textareaRef.current;
    if (!field) return;
    const before = field.value;
    const start = replace ? 0 : field.selectionStart;
    const end = replace ? before.length : field.selectionEnd;
    const after = before.slice(0, start) + value + before.slice(end);
    if (after === before) {
      setPasteOpen(false);
      return;
    }
    onUserEdit?.();
    field.focus();
    field.setSelectionRange(start, end);
    // Chromium's native editing transaction preserves Ctrl/Cmd+Z history.
    const native =
      typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, value);
    if (!native) {
      setCloneSetting('text', after);
      requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(start + value.length, start + value.length);
      });
    } else setCloneSetting('text', field.value);
    if (replace) setUndo({ before, after });
    insert.close();
    setPasteOpen(false);
  };

  const paste = async (replace = false) => {
    const before = textareaRef.current?.value;
    setPasting(true);
    setPasteOpen(false);
    try {
      // The desktop shell reads the clipboard when the page's Clipboard API is refused.
      const value = await readClipboardText();
      // Do not overwrite edits made while a clipboard permission prompt was open.
      if (value && textareaRef.current?.value === before) edit(value, replace);
    } catch {
      toast.error(t('clone.paste_failed'));
      textareaRef.current?.focus();
    } finally {
      setPasting(false);
    }
  };

  return (
    <section className="flex min-h-40 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <SectionLabel>
            <AlignLeftIcon aria-hidden="true" />
            {t('clone.text_label')}
          </SectionLabel>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <input
              ref={importRef}
              type="file"
              className="sr-only"
              accept={SCRIPT_ACCEPT}
              aria-label={t('scriptEdit.import')}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                const before = textareaRef.current?.value;
                setPasting(true);
                try {
                  const imported = await importScript(file);
                  if (textareaRef.current?.value === before) edit(imported);
                } catch {
                  toast.error(t('scriptEdit.import_failed'));
                } finally {
                  setPasting(false);
                }
              }}
            />
            <Button
              variant="ghost"
              size="xs"
              className="font-normal text-muted-foreground hover:text-foreground"
              disabled={pasting}
              title="TXT, Markdown, DOC, DOCX, PDF, EPUB"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => importRef.current?.click()}
            >
              <FileUpIcon />
              <span className="@max-lg:sr-only">{t('scriptEdit.import')}</span>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="font-normal text-muted-foreground hover:text-foreground"
              title={t('clone.paste')}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void paste()}
              disabled={pasting}
            >
              <ClipboardPasteIcon data-icon="inline-start" />
              <span className="@max-lg:sr-only">{t('clone.paste')}</span>
            </Button>
            <div className="relative" ref={pasteRef}>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={pasting}
                aria-label={t('scriptEdit.paste_options')}
                aria-haspopup="menu"
                aria-expanded={pasteOpen}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  setPasteOpen(!pasteOpen);
                  insert.close();
                }}
              >
                <ChevronDownIcon />
              </Button>
              {pasteOpen && (
                <div
                  role="menu"
                  aria-label={t('scriptEdit.paste_options')}
                  className="absolute right-0 top-full z-30 mt-2 min-w-44 rounded-lg border border-border bg-popover p-1 shadow-md"
                >
                  <button
                    autoFocus
                    type="button"
                    role="menuitem"
                    className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted outline-none"
                    onClick={() => void paste(true)}
                  >
                    {t('scriptEdit.replace')}
                  </button>
                </div>
              )}
            </div>
            {undo && undo.after === text && (
              <Button
                variant="ghost"
                size="xs"
                title={t('scriptEdit.undo')}
                onClick={() => {
                  const field = textareaRef.current;
                  field?.focus();
                  if (typeof document.execCommand !== 'function' || !document.execCommand('undo'))
                    setCloneSetting('text', undo.before);
                  else if (field) setCloneSetting('text', field.value);
                  setUndo(null);
                }}
              >
                <Undo2Icon />
                <span className="@max-lg:sr-only">{t('scriptEdit.undo')}</span>
              </Button>
            )}
            <ScriptInsertMenu
              menu={insert}
              setText={(value) => setCloneSetting('text', value)}
              onInsert={onUserEdit}
            />
            <FocusToggle />
          </div>
        </div>
        {coachmark ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-muted-foreground"
          >
            <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span>{coachmark}</span>
          </div>
        ) : null}
        <ScriptEditorFrame text={text} speed={speed}>
          {(textStyle) => (
            <ScriptTagTools
              menu={insert}
              setText={(value) => {
                onUserEdit?.();
                setCloneSetting('text', value);
              }}
              className="flex min-h-24 flex-1 flex-col"
            >
              <MarkupTextarea
                data-clone-script
                data-gate-target={SYNTHESIS_TARGET.cloneScript}
                textareaRef={textareaRef}
                value={text}
                unsupported={SCRIPT_UNSUPPORTED_TAGS}
                onValueChange={(value) => {
                  insert.close();
                  onUserEdit?.();
                  setCloneSetting('text', value);
                }}
                placeholder={
                  voiceName
                    ? t('cloneFlow.prompt_named', { name: voiceName })
                    : t('clone.prompt_placeholder')
                }
                aria-label={t('clone.text_label')}
                className="min-h-24 flex-1"
                textClassName="px-4 py-3 text-[length:var(--text-editor)] leading-[var(--text-editor--line-height)] placeholder:text-muted-foreground"
                textStyle={textStyle}
                onKeyDown={insert.onEditorKeyDown}
              />
            </ScriptTagTools>
          )}
        </ScriptEditorFrame>
      </div>
    </section>
  );
}
