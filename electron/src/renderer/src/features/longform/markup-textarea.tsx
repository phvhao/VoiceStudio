import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type Ref,
  type UIEvent,
} from 'react';
import { cn } from '@/lib/utils';
import { tokenizeMarkup, type MarkupKind } from './script-markup';

// Past this size the overlay costs more per keystroke than it is worth; the
// textarea keeps working as plain text.
export const HIGHLIGHT_LIMIT = 200_000;

// Highlights may only paint (background, ring, decoration): anything that
// changes glyph width (weight, padding, letter-spacing) would drift the
// overlay away from the caret.
export const MARKUP_STYLES: Record<Exclude<MarkupKind, 'text'>, string> = {
  heading: 'rounded-sm bg-primary/12 ring-1 ring-primary/25',
  voice: 'rounded-sm bg-sky-500/18 ring-1 ring-sky-500/40',
  voiceReset: 'rounded-sm bg-sky-500/8 ring-1 ring-sky-500/25',
  pause: 'rounded-sm bg-amber-500/18 ring-1 ring-amber-500/40',
  delivery: 'rounded-sm bg-violet-500/18 ring-1 ring-violet-500/40',
  expression: 'rounded-sm bg-emerald-500/18 ring-1 ring-emerald-500/40',
  unknown: 'underline decoration-destructive decoration-wavy underline-offset-4',
};

// Zero-width space: a trailing newline needs a glyph after it to take up its line.
const TRAILING_GLYPH = String.fromCharCode(0x200b);

// Shared by the textarea and its overlay so both wrap identically.
const LAYER = 'm-0 block w-full border-0 whitespace-pre-wrap [overflow-wrap:break-word]';

type TextareaProps = Omit<ComponentProps<'textarea'>, 'value' | 'onChange' | 'ref'>;

/**
 * A native textarea with markup highlighted behind the text. The textarea
 * stays the editing surface, so IME composition (Vietnamese Telex, CJK),
 * undo and selection behave exactly as before; the overlay only paints
 * token backgrounds at the same positions.
 */
export function MarkupTextarea({
  value,
  onValueChange,
  textareaRef,
  headings = false,
  autoGrow = false,
  className,
  textClassName,
  onScroll,
  ...props
}: TextareaProps & {
  value: string;
  onValueChange(value: string): void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Highlight `# Chapter` lines (Audiobook manuscripts). */
  headings?: boolean;
  /** Grow with the content instead of scrolling inside. */
  autoGrow?: boolean;
  /** Typography and padding, applied to both layers. */
  textClassName?: string;
}) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const highlight = value.length <= HIGHLIGHT_LIMIT;
  const segments = useMemo(
    () => (highlight ? tokenizeMarkup(value, { headings }) : []),
    [value, headings, highlight],
  );
  const setInput = useCallback(
    (node: HTMLTextAreaElement | null) => {
      input.current = node;
      if (typeof textareaRef === 'function') textareaRef(node);
      else if (textareaRef) textareaRef.current = node;
    },
    [textareaRef],
  );
  const syncScroll = useCallback(() => {
    if (overlay.current && input.current) overlay.current.scrollTop = input.current.scrollTop;
  }, []);
  const fit = useCallback(() => {
    const node = input.current;
    if (!autoGrow || !node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [autoGrow]);
  useLayoutEffect(() => {
    fit();
    syncScroll();
  }, [value, fit, syncScroll]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!autoGrow || !node || typeof ResizeObserver === 'undefined') return;
    // Wrapping, and so the height, changes with the editor's width.
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoGrow, fit]);
  const gutter = autoGrow ? '' : '[scrollbar-gutter:stable]';
  return (
    <div data-slot="markup-textarea" className={cn('relative', className)}>
      {highlight && (
        <div
          ref={overlay}
          aria-hidden="true"
          className={cn(
            LAYER,
            textClassName,
            gutter,
            'pointer-events-none absolute inset-0 overflow-hidden text-transparent select-none',
          )}
        >
          {segments.map((segment, index) =>
            segment.kind === 'text' ? (
              segment.text
            ) : (
              <mark
                key={index}
                data-kind={segment.kind}
                className={cn(
                  'box-decoration-clone text-transparent',
                  segment.kind === 'unknown' ? 'bg-transparent' : '',
                  MARKUP_STYLES[segment.kind],
                )}
              >
                {segment.text}
              </mark>
            ),
          )}
          {TRAILING_GLYPH}
        </div>
      )}
      <textarea
        ref={setInput}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onScroll={(event: UIEvent<HTMLTextAreaElement>) => {
          syncScroll();
          onScroll?.(event);
        }}
        className={cn(
          LAYER,
          textClassName,
          gutter,
          'resize-none bg-transparent outline-none',
          // Fixed-height editors fill the wrapper (which the caller sizes)
          // and scroll inside; the overlay follows that scroll.
          autoGrow ? 'relative overflow-hidden' : 'absolute inset-0 h-full overflow-y-auto',
        )}
        {...props}
      />
    </div>
  );
}
