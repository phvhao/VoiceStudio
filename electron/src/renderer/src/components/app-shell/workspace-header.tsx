import { SupportShortcut } from './support-shortcut';
import { SidebarToggle } from './sidebar-toggle';
import { HistoryNav } from './history-nav';
import { GithubIcon, openRepository } from './github-star';
import { useTitlebarFit } from './titlebar-fit';
import type { ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Link } from '@tanstack/react-router';
import { EllipsisIcon, GemIcon, SearchIcon, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isMac } from '@/components/bridge';
import { REPO_URL } from '@shared/utils/contactLinks';

/** A screen's own title-bar button, which a crowded bar moves into its menu. */
export type TitlebarAction = {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
};

const openCommands = () => window.dispatchEvent(new Event('voicestudio:commands'));
const searchKeys = () => (isMac() ? '⌘K' : 'Ctrl K');
const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-highlighted:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

export function WorkspaceHeader({
  children,
  actions = [],
  nativeControls = true,
  onRoom,
  className,
}: {
  children: ReactNode;
  actions?: readonly TitlebarAction[];
  /** Whether the window's own caption buttons sit over this bar's right end. */
  nativeControls?: boolean;
  /** Hears the width the bar needs to show the title in full (`useTitlebarFit`). */
  onRoom?: (room: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const fit = useTitlebarFit(onRoom);
  return (
    <header
      ref={fit}
      className={cn(
        // A crowded bar keeps each screen's title on one line; what sits
        // beside it (a book or file name) shortens instead, and the
        // buttons on the right give up their words, then move into the
        // "More actions" menu (titlebar-fit.ts). Only past all of that does
        // the title itself end in an ellipsis.
        'group/titlebar workspace-titlebar flex shrink-0 items-center gap-3 border-b border-border/50 px-5 [&>h1]:truncate',
        nativeControls && !isMac() && 'native-controls-right',
        className,
      )}
    >
      <SidebarToggle />
      <HistoryNav />
      {children}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <div className="flex shrink-0 items-center gap-1 group-data-[fit~=overflow]/titlebar:hidden">
          <SupportShortcut />
          <Button
            variant="ghost"
            size="sm"
            className="group h-8 shrink-0 gap-2 rounded-lg border border-transparent px-2.5 text-muted-foreground transition-[color,background-color,border-color,box-shadow] duration-150 hover:border-white/10 hover:bg-white/[0.07] hover:text-foreground hover:shadow-[0_6px_18px_-12px_hsl(var(--foreground)/0.4),inset_0_1px_0_hsl(0_0%_100%/0.08)]"
            aria-label={t('preferences.search')}
            title={isMac() ? 'Command + K' : 'Ctrl + K'}
            onClick={openCommands}
          >
            <SearchIcon className="transition-colors duration-150" />
            <span className="text-xs group-data-[fit~=labels]/titlebar:hidden">{searchKeys()}</span>
          </Button>
          {actions.map(({ label, icon: Icon, onSelect }) => (
            <Button key={label} variant="ghost" size="sm" title={label} onClick={onSelect}>
              <Icon data-icon="inline-start" />
              {/* Screen readers keep the words the bar no longer shows. */}
              <span className="group-data-[fit~=controls]/titlebar:sr-only">{label}</span>
            </Button>
          ))}
        </div>
        <Menu.Root>
          <Menu.Trigger
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
              'hidden group-data-[fit~=overflow]/titlebar:inline-flex',
            )}
            aria-label={t('common.more_actions')}
            title={t('common.more_actions')}
          >
            <EllipsisIcon />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={6} align="end" className="z-50">
              <Menu.Popup className="min-w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
                {actions.map(({ label, icon: Icon, onSelect }) => (
                  <Menu.Item key={label} className={MENU_ITEM} onClick={onSelect}>
                    <Icon aria-hidden="true" />
                    {label}
                  </Menu.Item>
                ))}
                <Menu.Item className={MENU_ITEM} onClick={openCommands}>
                  <SearchIcon aria-hidden="true" />
                  {t('preferences.search')}
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">{searchKeys()}</span>
                </Menu.Item>
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.LinkItem className={MENU_ITEM} closeOnClick render={<Link to="/pro" />}>
                  <GemIcon aria-hidden="true" />
                  {t('supportPlans.get_pro')}
                </Menu.LinkItem>
                <Menu.LinkItem
                  className={MENU_ITEM}
                  closeOnClick
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={openRepository}
                >
                  <GithubIcon />
                  {t('support.star_github')}
                </Menu.LinkItem>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </header>
  );
}
