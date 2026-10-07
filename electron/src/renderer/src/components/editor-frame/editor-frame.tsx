import type { ReactNode } from 'react';
import { Maximize2Icon, Minimize2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { setEditorFocus, useEditorFocus, useEditorFocusMode } from './editor-focus';

/**
 * The script workspace shared by Clone and Voice Design: a column that widens
 * with the window up to 72rem and gives the editor the height left over, the
 * composer anchored under it, and the results below in their own dock. Focus
 * mode leaves the column and the composer alone on the page: the results are
 * hidden, not unmounted, so a take playing in them plays on and the dock is
 * as it was when Esc brings it back.
 */
export function EditorFrame({
  children,
  composer,
  results,
}: {
  children: ReactNode;
  composer?: ReactNode;
  results?: ReactNode;
}) {
  const focused = useEditorFocus();
  useEditorFocusMode();
  return (
    <div
      data-slot="editor-frame"
      data-focus={focused || undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* A container: beside an open pane the column narrows to 20rem, and
            the script toolbar's labels give way to their icons (the names stay
            for screen readers and tooltips) instead of running past it. */}
        <div className="@container mx-auto flex w-full max-w-[72rem] flex-1 flex-col gap-4 px-6 pt-5 pb-3">
          {children}
        </div>
      </div>
      {composer ? (
        <div className="mx-auto w-full max-w-[72rem] shrink-0 px-6 pb-3">{composer}</div>
      ) : null}
      {results ? (
        <div data-slot="editor-results-frame" hidden={focused} className="contents">
          {results}
        </div>
      ) : null}
    </div>
  );
}

/** Enters or leaves focus mode; Esc leaves it too. */
export function FocusToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const focused = useEditorFocus();
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={focused}
      aria-keyshortcuts={focused ? 'Escape' : undefined}
      title={t('editor.focus_hint')}
      className={cn(
        'font-normal text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground',
        className,
      )}
      // Keep the caret in the script.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => setEditorFocus(!focused)}
    >
      {focused ? <Minimize2Icon /> : <Maximize2Icon />}
      {/* A narrow editor column (a container) keeps the icon. */}
      <span className="@max-lg:sr-only">{t('editor.focus')}</span>
    </Button>
  );
}
