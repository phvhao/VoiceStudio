import { useEffect, useRef } from 'react';
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isMac } from '@/components/bridge';
import {
  goThroughHistory,
  useHistoryState,
  type HistoryDirection,
  type HistoryPage,
} from './history-navigation';
import { screenTitle } from './history-pages';

/**
 * The title bar sits inside each screen, so the screen Back opens brings its
 * own buttons: the button pressed hands the keyboard focus to its successor,
 * as long as nothing else took it meanwhile.
 */
let handOff: { direction: HistoryDirection; at: number } | null = null;

function takeHandOff(): HistoryDirection | null {
  const pending = handOff;
  handOff = null;
  const unfocused = !document.activeElement || document.activeElement === document.body;
  return pending && unfocused && Date.now() - pending.at < 2000 ? pending.direction : null;
}

function HistoryButton({
  direction,
  page,
  enabled,
}: {
  direction: HistoryDirection;
  page: HistoryPage | null;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const mac = isMac();
  const title = page && screenTitle(page.pathname, t);
  const label =
    direction === 'back'
      ? title
        ? t('historyNav.back_to', { page: title })
        : t('historyNav.back')
      : title
        ? t('historyNav.forward_to', { page: title })
        : t('historyNav.forward');
  const Icon = direction === 'back' ? ArrowLeftIcon : ArrowRightIcon;
  // An arrow glyph at key-cap size reads as a dash; the icon stays an arrow.
  const keys = mac
    ? ['⌘', direction === 'back' ? '[' : ']']
    : ['Alt', <Icon key="arrow" aria-hidden="true" />];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-history={direction}
            className="shrink-0 text-foreground/70 hover:text-foreground"
            aria-label={label}
            aria-keyshortcuts={
              mac
                ? `Meta+${direction === 'back' ? '[' : ']'}`
                : `Alt+${direction === 'back' ? 'ArrowLeft' : 'ArrowRight'}`
            }
            disabled={!enabled}
            onClick={() => {
              if (goThroughHistory(direction)) handOff = { direction, at: Date.now() };
            }}
          >
            <Icon className="rtl:-scale-x-100" aria-hidden="true" />
          </Button>
        }
      />
      <TooltipContent side="bottom">
        {label}
        <KbdGroup>
          {keys.map((key, index) => (
            <Kbd key={index}>{key}</Kbd>
          ))}
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

/** ← → before the screen's title: through the screens visited, like a browser. */
export function HistoryNav() {
  const state = useHistoryState();
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const direction = takeHandOff();
    if (!direction) return;
    const button = (name: HistoryDirection) =>
      group.current?.querySelector<HTMLButtonElement>(`[data-history="${name}"]:not(:disabled)`);
    (button(direction) ?? button(direction === 'back' ? 'forward' : 'back'))?.focus();
  }, []);
  return (
    <div ref={group} data-slot="history-nav" className="flex shrink-0 items-center gap-0.5">
      <HistoryButton direction="back" page={state.back} enabled={state.canGoBack} />
      <HistoryButton direction="forward" page={state.forward} enabled={state.canGoForward} />
    </div>
  );
}
