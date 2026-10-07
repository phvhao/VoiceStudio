import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ListTreeIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'voicestudio.audiobook-contents';
// Below this the editor would be too narrow beside the rail: the contents
// open over the editor instead, from the toggle.
export const RAIL_MIN_WIDTH = 720;

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // Storage blocked: the choice lasts for this session.
  }
}

/** Whether `element` is wide enough for the rail; true until it has a width. */
function useWide(element: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => setWide(node.clientWidth === 0 || node.clientWidth >= min);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [element, min]);
  return wide;
}

export interface RailOutlineProps {
  onCollapse(): void;
  onReveal?(): void;
  className: string;
}

/**
 * The editor with its table of contents beside it: a rail on the left of the
 * editor frame, folded away to a toggle when the reader wants the room (kept
 * per viewer). Where the frame is narrow the rail stays folded, and the
 * toggle opens the contents over the editor until an entry is chosen.
 * `outline` renders the contents; it stays mounted while folded, so a chapter
 * preview rendering in it carries on — and the folded toggle says so
 * (`previewing`), since its progress and Stop are in the contents.
 */
export function ContentsRail({
  outline,
  previewing = false,
  children,
}: {
  outline(props: RailOutlineProps): ReactNode;
  /** A chapter preview renders in the contents. */
  previewing?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const row = useRef<HTMLDivElement>(null);
  const wide = useWide(row, RAIL_MIN_WIDTH);
  const [open, setOpenState] = useState(readOpen);
  const [over, setOver] = useState(false);
  const shown = wide ? open : over;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    writeOpen(next);
  };
  const show = () => (wide ? setOpen(true) : setOver(true));
  const hide = () => (wide ? setOpen(false) : setOver(false));
  const overlay = !wide && shown;
  const aside = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // A press in the contents — or in a menu they opened, portaled elsewhere
  // in the page but inside them in React's tree — is no press outside.
  const pressedInside = useRef(false);
  useEffect(() => {
    if (!overlay) return;
    // The contents cover the toggle: the focus goes into them.
    aside.current
      ?.querySelector<HTMLElement>('button:not(:disabled), input, [tabindex]:not([tabindex="-1"])')
      ?.focus({ preventScroll: true });
    const onPointerDown = () => {
      if (!pressedInside.current) setOver(false);
      pressedInside.current = false;
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [overlay]);
  return (
    <div
      ref={row}
      data-slot="editor-with-contents"
      className="relative flex min-h-96 min-w-0 flex-1"
      onKeyDown={(event) => {
        // Escape anywhere in the editor closes the contents over it — unless
        // something already handled it (a rename field, the editor's own
        // popups) or it comes from a menu portaled out of this frame.
        if (event.key !== 'Escape' || !overlay || event.defaultPrevented) return;
        const target = event.target;
        if (!(target instanceof Node) || !event.currentTarget.contains(target)) return;
        setOver(false);
        if (aside.current?.contains(target)) toggle.current?.focus({ preventScroll: true });
      }}
    >
      {!(wide && shown) && (
        <div className="flex w-9 shrink-0 flex-col items-center border-e border-border/50 py-2">
          <Button
            ref={toggle}
            variant="ghost"
            size="icon-xs"
            className="relative"
            aria-label={t(previewing ? 'audiobook.contents_previewing' : 'book.show_contents')}
            title={t(previewing ? 'audiobook.contents_previewing' : 'book.show_contents')}
            aria-expanded={shown}
            onClick={show}
          >
            <ListTreeIcon />
            {previewing && (
              <span
                aria-hidden="true"
                data-slot="contents-previewing"
                className="absolute end-0.5 top-0.5 size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
              />
            )}
          </Button>
        </div>
      )}
      <aside
        ref={aside}
        data-slot="contents-rail"
        data-overlay={overlay ? '' : undefined}
        className={cn(
          !shown && 'hidden',
          shown &&
            (wide
              ? 'relative w-64 shrink-0 border-e border-border/50 bg-muted/10'
              : 'absolute inset-y-0 start-0 z-20 w-72 max-w-[85%] border-e border-border/60 bg-background shadow-lg'),
        )}
        onPointerDownCapture={() => {
          if (overlay) pressedInside.current = true;
        }}
      >
        {/* Out of the flow: the rail is as tall as the editor, never taller. */}
        <div className="absolute inset-0 flex flex-col p-2">
          {outline({
            onCollapse: hide,
            // Over the editor, the contents give way once an entry is chosen.
            onReveal: wide ? undefined : () => setOver(false),
            className: 'min-h-0 flex-1',
          })}
        </div>
      </aside>
      {children}
    </div>
  );
}
