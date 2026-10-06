import { createPortal } from 'react-dom';
import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { applyMarkupEdit } from '@/features/longform/markup-toolbar';
import {
  PAUSE_MAX_MS,
  PAUSE_PRESETS,
  formatPauseSeconds,
  insertToken,
  pauseToken,
  secondsUnit,
} from '@/features/longform/script-markup';
import { TAGS } from '@/lib/languages';
import { textareaCaret } from '@/lib/textarea-caret';
import { cn } from '@/lib/utils';

// The popup's size, for keeping it inside the window at the caret.
const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 320;
const NAVIGATION_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

/**
 * The state of a script editor's Insert menu: the popup opens at the caret
 * (Alt+/ in the editor, or the trigger) and closes on a click outside, Escape,
 * a resize or a scroll, or as soon as the editor is typed in.
 */
export function useScriptInsertMenu(textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  const show = () => {
    const field = textareaRef.current;
    if (!field) return;
    const point = textareaCaret(field);
    setAnchor({
      left: Math.max(8, Math.min(point.left, window.innerWidth - POPUP_WIDTH - 8)),
      top: Math.max(8, Math.min(point.top + 6, window.innerHeight - POPUP_HEIGHT - 8)),
    });
    setOpen(true);
    requestAnimationFrame(() =>
      popupRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true }),
    );
  };

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      !(target instanceof Node) ||
      (!popupRef.current?.contains(target) && !triggerRef.current?.contains(target));
    const close = (event: Event) => {
      if (outside(event.target)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      textareaRef.current?.focus();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, textareaRef]);

  return {
    open,
    anchor,
    id,
    popupRef,
    triggerRef,
    textareaRef,
    show,
    close: () => setOpen(false),
    /** For the editor's `onKeyDown`: Alt+/ opens the menu, any other key but Escape closes it. */
    onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (event.altKey && event.key === '/') {
        event.preventDefault();
        show();
      } else if (event.key !== 'Escape') setOpen(false);
    },
  };
}

export type ScriptInsertMenuState = ReturnType<typeof useScriptInsertMenu>;

/**
 * The Insert trigger and its popup for a single-voice script editor: the
 * Audiobook toolbar's pause lengths plus a custom one, then the expression
 * tags. A tag goes in at the caret as one undoable edit, spaced from the
 * words around it.
 */
export function ScriptInsertMenu({
  menu,
  setText,
  onInsert,
  disabled,
}: {
  menu: ScriptInsertMenuState;
  /** Commits the text where the browser cannot insert natively. */
  setText(value: string): void;
  /** Just before a tag goes in. */
  onInsert?(): void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const [customSeconds, setCustomSeconds] = useState('1.5');
  const customMs = Math.round(Number(customSeconds) * 1000);
  const customValid = Number.isFinite(customMs) && customMs > 0 && customMs <= PAUSE_MAX_MS;
  const { open, anchor, id, popupRef, triggerRef } = menu;

  const insert = (token: string) => {
    const element = menu.textareaRef.current;
    menu.close();
    if (!element) return;
    onInsert?.();
    applyMarkupEdit({ element, setText }, (value, start, end) =>
      insertToken(value, start, end, token),
    );
  };

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    // A number field keeps its own arrows.
    if (event.target instanceof HTMLInputElement || !NAVIGATION_KEYS.includes(event.key)) return;
    const items = Array.from(
      popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + step + items.length) % items.length;
    items[next]?.focus();
  };

  // Tabbing out of the popup puts it away.
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) menu.close();
  };

  const groupLabel = 'px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase';
  const chip =
    'rounded-full px-2 py-0.5 text-[length:var(--text-caption)] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50';
  return (
    <div>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        className="font-normal text-muted-foreground hover:text-foreground"
        disabled={disabled}
        title={t('clone.insert_token')}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => (open ? menu.close() : menu.show())}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        aria-label={t('clone.insert_token')}
      >
        <PlusIcon data-icon="inline-start" />
        {t('clone.insert')}
        <ChevronDownIcon className={cn('transition-transform', open && 'rotate-180')} />
      </Button>
      {open
        ? createPortal(
            <div
              ref={popupRef}
              id={id}
              role="dialog"
              aria-label={t('clone.insert_token')}
              style={{ left: anchor.left, top: anchor.top }}
              onKeyDown={navigate}
              onBlur={leave}
              className="fixed z-50 flex max-h-80 w-[min(360px,calc(100vw-16px))] flex-col gap-2 overflow-y-auto rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none"
            >
              <div className="flex flex-col gap-1">
                <p aria-hidden="true" className={groupLabel}>
                  {t('audiobook.insert_pause')}
                </p>
                <div
                  role="menu"
                  aria-label={t('audiobook.insert_pause')}
                  className="flex flex-wrap gap-1"
                >
                  {PAUSE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitem"
                      title={pauseToken(preset.ms)}
                      className={cn(chip, 'flex items-center gap-1.5')}
                      onClick={() => insert(pauseToken(preset.ms))}
                    >
                      {t(`markup.pause_${preset.id}`)}{' '}
                      <span className="font-mono tabular-nums opacity-70">
                        {formatPauseSeconds(preset.ms, locale)}
                      </span>
                    </button>
                  ))}
                </div>
                <form
                  className="flex items-center gap-1.5 px-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (customValid) insert(pauseToken(customMs));
                  }}
                >
                  <label className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                    {t('markup.pause_custom')}
                    <Input
                      type="number"
                      min="0.1"
                      max={PAUSE_MAX_MS / 1000}
                      step="0.1"
                      value={customSeconds}
                      aria-invalid={!customValid}
                      aria-label={t('editor.pause_custom_seconds')}
                      className="h-7 w-16 px-2 text-xs"
                      onChange={(event) => setCustomSeconds(event.target.value)}
                    />
                    <span aria-hidden="true">{secondsUnit(locale)}</span>
                  </label>
                  <Button type="submit" size="xs" variant="secondary" disabled={!customValid}>
                    {t('markup.insert')}
                  </Button>
                </form>
              </div>
              <div className="flex flex-col gap-1 border-t border-border/50 pt-2">
                <p aria-hidden="true" className={groupLabel}>
                  {t('audiobook.insert_reactions')}
                </p>
                <div
                  role="menu"
                  aria-label={t('audiobook.insert_reactions')}
                  className="flex flex-wrap gap-1"
                >
                  {TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      role="menuitem"
                      className={chip}
                      onClick={() => insert(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
