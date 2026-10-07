import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { ArrowRightIcon, CheckIcon, CircleDashedIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent } from '@/components/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import './gated-action.css';

/** One thing standing between the user and an action. */
export interface ActionBlocker {
  /** Stable key within one action's list. */
  id: string;
  /** What is missing, said as the next thing to do: "Generate the dub first." */
  message: string;
  /** Takes the user to whatever clears it — usually `revealGateTarget`, or a route. */
  fix?: { label: string; onSelect: () => void };
}

/** One step of a multi-step flow, for the checklist shown above the blockers. */
export interface ActionStep {
  id: string;
  label: string;
  done: boolean;
  /** Takes the user to the step. */
  onSelect?: () => void;
}

type GatedActionProps = ComponentProps<typeof Button> & {
  /** What is missing, most fundamental first. Empty or absent: a normal button. */
  blockers?: readonly ActionBlocker[] | null;
  /** The flow's steps, when the action ends one (Upload → Translate → Generate). */
  steps?: readonly ActionStep[];
  /** Heading of the explanation; defaults to "Not ready yet". */
  heading?: string;
  side?: ComponentProps<typeof PopoverContent>['side'];
  align?: ComponentProps<typeof PopoverContent>['align'];
};

// Muted and dashed whatever the variant: "not ready", yet still a control.
const BLOCKED =
  'border-dashed border-border bg-muted/50 text-muted-foreground shadow-none inset-shadow-none hover:bg-muted hover:text-foreground dark:bg-muted/40 dark:hover:bg-muted';

const FOCUSABLE =
  'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
const highlightTimers = new WeakMap<HTMLElement, number>();

/**
 * A primary action that explains itself instead of greying out. While
 * `blockers` lists anything, the button stays focusable and clickable but
 * looks not-ready, screen readers hear the reasons as its description, and
 * pressing it lists what is missing with a way to each fix. With nothing
 * missing it is the plain Button and `onClick` runs.
 *
 * `disabled` still disables outright — keep it for work already in progress.
 */
export function GatedAction({
  blockers,
  steps,
  heading,
  side = 'top',
  align = 'center',
  disabled,
  size,
  className,
  children,
  onClick,
  'aria-describedby': describedBy,
  ...props
}: GatedActionProps) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLButtonElement>(null);
  const firstFix = useRef<HTMLButtonElement>(null);
  // A fix moves focus to the control it reveals; returning focus to this
  // button as the popup closes would take it straight back.
  const leaving = useRef(false);
  const summaryId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const missing = !disabled && blockers?.length ? blockers : null;
  const blocked = missing !== null;
  const firstFixId = missing?.find((blocker) => blocker.fix)?.id;
  // Once everything is in place the explanation goes, and it must not come
  // back by itself if something goes missing again later.
  useEffect(() => {
    if (!blocked) setOpen(false);
  }, [blocked]);
  const go = (run?: () => void) => {
    leaving.current = true;
    setOpen(false);
    if (run) requestAnimationFrame(run);
  };
  return (
    <>
      <Button
        {...props}
        ref={anchor}
        size={size}
        disabled={disabled}
        data-blocked={blocked ? '' : undefined}
        aria-disabled={blocked || undefined}
        aria-haspopup={blocked ? 'dialog' : undefined}
        aria-expanded={blocked ? open : undefined}
        aria-describedby={
          [describedBy, blocked && summaryId].filter(Boolean).join(' ') || undefined
        }
        className={cn(className, blocked && BLOCKED)}
        onClick={(event) => {
          if (!blocked) return onClick?.(event);
          event.preventDefault();
          leaving.current = false;
          setOpen((value) => !value);
        }}
      >
        {children}
        {missing && (
          <>
            {/* An icon-only button has no room for a second icon; the dashed border says it. */}
            {!size?.startsWith('icon') && (
              <CircleDashedIcon
                aria-hidden="true"
                data-slot="gate-indicator"
                className="opacity-70"
              />
            )}
            {/* Hidden, yet still the button's description: aria-describedby reads hidden nodes. */}
            <span id={summaryId} hidden>
              {t('gatedAction.summary', {
                reasons: missing.map((blocker) => blocker.message).join(' '),
              })}
            </span>
          </>
        )}
      </Button>
      <Popover
        open={open && blocked}
        onOpenChange={(next, details) => {
          // The button is not a Popover.Trigger, so pressing it reads as an
          // outside press; its own click toggles instead.
          if (
            !next &&
            details.reason === 'outside-press' &&
            anchor.current?.contains(details.event.target as Node)
          )
            return;
          setOpen(next);
        }}
      >
        <PopoverContent
          anchor={anchor}
          side={side}
          align={align}
          initialFocus={() => firstFix.current ?? true}
          finalFocus={() => !leaving.current}
          // Focus lands on the first fix; the dialog's description reads what is missing.
          aria-describedby={listId}
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-3"
        >
          <PopoverPrimitive.Title className="text-sm font-medium">
            {heading ?? t('gatedAction.title')}
          </PopoverPrimitive.Title>
          {steps?.length ? (
            <StepChecklist steps={steps} onSelect={(step) => go(step.onSelect)} />
          ) : null}
          <ul id={listId} className="space-y-2">
            {missing?.map((blocker) => (
              <li
                key={blocker.id}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 text-xs leading-5"
              >
                <CircleDashedIcon aria-hidden="true" className="mt-0.5 size-3.5 text-warning" />
                <span>{blocker.message}</span>
                {/* Under the message, so a long label never squeezes it. */}
                {blocker.fix && (
                  <Button
                    ref={blocker.id === firstFixId ? firstFix : undefined}
                    size="xs"
                    variant="outline"
                    className="col-start-2 h-auto min-h-6 max-w-full justify-self-start py-0.5 text-start whitespace-normal"
                    onClick={() => go(blocker.fix!.onSelect)}
                  >
                    {blocker.fix.label}
                    <ArrowRightIcon aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </>
  );
}

function StepChecklist({
  steps,
  onSelect,
}: {
  steps: readonly ActionStep[];
  onSelect: (step: ActionStep) => void;
}) {
  const { t } = useTranslation();
  const current = steps.findIndex((step) => !step.done);
  return (
    <ol aria-label={t('gatedAction.steps')} className="space-y-0.5 border-b border-border/60 pb-2">
      {steps.map((step, index) => (
        <li key={step.id}>
          <button
            type="button"
            disabled={!step.onSelect}
            aria-current={index === current ? 'step' : undefined}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none',
              index === current ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
            onClick={() => onSelect(step)}
          >
            <span
              aria-hidden="true"
              className={cn(
                'grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums',
                step.done
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : index === current
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {step.done ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
            {step.done && <span className="sr-only">{t('gatedAction.step_done')}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * Bring what clears a blocker into view: the element marked
 * `data-gate-target="<id>"` (a space-separated list may name several). Expands
 * a collapsed workspace sidebar and any closed <details> around it, scrolls
 * it into view, focuses its first visible control and flashes it. Returns
 * false when nothing on the page carries the id, so a caller can fall back.
 */
export function revealGateTarget(id: string): boolean {
  const target = document.querySelector<HTMLElement>(`[data-gate-target~="${id}"]`);
  if (!target) return false;
  const sidebar = target.closest<HTMLElement>('[data-slot="secondary-sidebar"][data-collapsed]');
  const expand = sidebar?.querySelector<HTMLElement>(
    '[data-slot="secondary-sidebar-header"] [aria-expanded="false"]',
  );
  if (expand) {
    expand.click();
    requestAnimationFrame(() => highlight(target));
  } else highlight(target);
  return true;
}

function highlight(target: HTMLElement) {
  for (let node: HTMLElement | null = target; node; node = node.parentElement)
    if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  // jsdom has no checkVisibility; there everything counts as visible.
  const visible = (element: HTMLElement) => element.checkVisibility?.() ?? true;
  const control = [target, ...target.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
    (element) => element.matches(FOCUSABLE) && visible(element),
  );
  (control ?? target).focus({ preventScroll: true });
  window.clearTimeout(highlightTimers.get(target));
  // Re-adding the attribute restarts the flash when the same fix is chosen twice.
  target.removeAttribute('data-gate-highlight');
  void target.offsetWidth;
  target.setAttribute('data-gate-highlight', '');
  highlightTimers.set(
    target,
    window.setTimeout(() => target.removeAttribute('data-gate-highlight'), 1800),
  );
}
