import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { isMac } from '@/components/bridge';
import { useEditorFocus } from '@/components/editor-frame/editor-focus';
import { useWorkspaceSidebarState } from './use-workspace-sidebar';

export function SidebarToggle() {
  const { t } = useTranslation();
  const { compact, setOpen } = useWorkspaceSidebarState();
  // Focus mode hides the sidebar whatever this toggle says; Esc brings it back.
  const editorFocused = useEditorFocus();
  if (isMac() || editorFocused) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-foreground/70 hover:text-foreground"
      aria-label={t('clone.toggle_sidebar')}
      title={t('clone.toggle_sidebar')}
      aria-expanded={!compact}
      onClick={() => setOpen(compact)}
    >
      {compact ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
    </Button>
  );
}
