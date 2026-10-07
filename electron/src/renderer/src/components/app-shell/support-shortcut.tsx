import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon, GemIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import './support-shortcut.css';
import { GithubStar } from './github-star';

export function SupportShortcut() {
  const { t } = useTranslation();
  return (
    // A title bar too narrow for its screen's own title and controls keeps
    // them, dropping these words first and these shortcuts last (titlebar-fit.ts).
    <div className="flex shrink-0 items-center gap-2 group-data-[fit~=shortcuts]/titlebar:hidden">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/pro"
              aria-label={t('supportPlans.get_pro')}
              className="support-shortcut app-no-drag flex h-8 items-center gap-1.5 px-2.5 focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          <GemIcon aria-hidden="true" className="size-3.5" />
          <span className="text-xs font-semibold group-data-[fit~=labels]/titlebar:hidden">
            {t('supportPlans.get_pro')}
          </span>
          <ArrowUpRightIcon aria-hidden="true" className="size-3" />
        </TooltipTrigger>
        <TooltipContent surface="theme" side="bottom">
          {t('supportPlans.get_pro')}
        </TooltipContent>
      </Tooltip>
      <GithubStar />
    </div>
  );
}
