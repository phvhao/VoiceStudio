import { useId, useState, type ReactNode } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { useDockResize } from '@/hooks/use-dock-resize';
import { cn } from '@/lib/utils';

const HEIGHT_KEY = 'voicestudio.editor-results-height';
const COLLAPSED_KEY = 'voicestudio.editor-results-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The results under a script editor (Clone, Voice Design): a drag of its top
 * edge (or ↑/↓ on it) sets its height, its title folds it to one line, and
 * both are remembered per viewer. The editor keeps the rest of the height.
 */
export function ResultsDock({
  title,
  count,
  line,
  empty = false,
  children,
}: {
  title: string;
  count?: number;
  /** Beside the title while folded: the newest result at a glance. */
  line?: ReactNode;
  /** Nothing to list yet: one line, without changing the viewer's choice. */
  empty?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const open = !collapsed && !empty;
  const resize = useDockResize({
    storageKey: HEIGHT_KEY,
    minimum: 112,
    initial: 248,
    maximum: 640,
    // The voice row, the toolbar, the editor's smallest useful size, its
    // status line and the composer: a short window keeps the editor usable.
    reserve: 440,
    enabled: open,
  });
  const bodyId = useId();
  const setCollapsed = (next: boolean) => {
    setCollapsedState(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Folding still applies for this session.
    }
  };
  return (
    <section
      ref={resize.host}
      aria-label={title}
      data-slot="editor-results"
      data-open={open || undefined}
      style={open ? { height: resize.height } : undefined}
      className="relative flex shrink-0 flex-col border-t border-border/60 bg-muted/15"
    >
      {open && (
        <div
          {...resize.separatorProps}
          aria-label={title}
          aria-controls={bodyId}
          className="group/resize absolute inset-x-0 -top-1 z-10 flex h-2 cursor-row-resize touch-none items-center justify-center outline-none"
        >
          <span className="h-px w-10 rounded-full bg-border/0 transition-[width,background-color,box-shadow] duration-150 group-hover/resize:w-16 group-hover/resize:bg-primary/45 group-hover/resize:shadow-[0_0_8px_var(--primary)] group-focus-visible/resize:w-16 group-focus-visible/resize:bg-primary motion-reduce:transition-none" />
        </div>
      )}
      <div className="mx-auto flex h-9 w-full max-w-[72rem] shrink-0 items-center gap-3 px-6">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          disabled={empty}
          onClick={() => setCollapsed(open)}
          className="-ms-1.5 flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[length:var(--text-label)] font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              'size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none',
              !open && '-rotate-90 rtl:rotate-90',
            )}
          />
          {title}
          {count ? (
            <span className="rounded-full bg-muted px-1.5 text-[11px] font-normal text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </button>
        {!open && line ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">{line}</div>
        ) : null}
      </div>
      {open && (
        <div
          id={bodyId}
          className="studio-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          <div className="mx-auto w-full max-w-[72rem] px-6 pb-3">{children}</div>
        </div>
      )}
    </section>
  );
}
