import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  BookPlusIcon,
  EllipsisIcon,
  HeadingIcon,
  ListTreeIcon,
  PencilLineIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react';
import { formatRuntimeClock } from '@shared/utils/audiobookScript';
import { buttonVariants, Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiJson } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { ChapterPreview, useChapterPreview } from './chapter-previews';
import { chapterPreviewBody, type Draft } from './longform-session';
import { applyMarkupEdit, type MarkupTarget } from './markup-toolbar';
import { revealOffset } from './markup-textarea';
import {
  displayTitle,
  insertHeading,
  removeHeading,
  renameHeading,
  scriptOutline,
  type OutlineChapter,
  type OutlineNode,
} from './script-outline';
import type { MarkupEdit } from './script-markup';

export type ChapterStatus = 'rendered' | 'changed' | 'not_rendered';

interface OutlineStatus {
  chapters: Array<{ title: string; status: ChapterStatus; cached: boolean | null }>;
  book: boolean;
}

// Typing settles before the chapters are looked up again.
const STATUS_DELAY_MS = 700;

/** `/audiobook/outline`'s request: the chapter preview's inputs, and the last book. */
export function outlineRequest(draft: Draft) {
  const { chapter_index: _index, ...body } = chapterPreviewBody(draft, 0);
  return { ...body, output: draft.output || null };
}

const STATUS_CLASSES: Record<ChapterStatus, string> = {
  rendered: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  changed: 'bg-amber-500/14 text-amber-700 dark:text-amber-300',
  not_rendered: 'bg-muted text-muted-foreground',
};
const STATUS_LABELS: Record<ChapterStatus, [label: string, hint: string]> = {
  rendered: ['book.status_rendered', 'book.hint_rendered'],
  changed: ['book.status_changed', 'book.hint_changed'],
  not_rendered: ['book.status_not_rendered', 'book.hint_not_rendered'],
};

const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50';

/**
 * The book's table of contents beside the Audiobook editor: chapters and
 * their sections, each with its length and — for chapters — whether its audio
 * is rendered for the script and settings as they are now, or changed since
 * the last book. A row moves the editor's caret to its heading; its menu
 * renames, adds or removes headings (undoable edits in the editor), and a
 * chapter renders on its own, filling the caches the full book reuses.
 */
export function BookOutline({
  draft,
  disabled,
  canPreview,
  onBusy,
  getTarget,
}: {
  draft: Draft;
  disabled: boolean;
  canPreview: boolean;
  onBusy: (busy: boolean) => void;
  getTarget: () => MarkupTarget | null;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const formatCount = (value: number) =>
    value.toLocaleString(i18n.resolvedLanguage || i18n.language);
  const outline = useMemo(() => scriptOutline(draft.script), [draft.script]);
  const request = JSON.stringify(outlineRequest(draft));
  const [settled, setSettled] = useState(request);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(request), STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [request]);
  const status = useQuery({
    queryKey: ['audiobook-outline', settled],
    queryFn: ({ signal }) =>
      apiJson<OutlineStatus>('/audiobook/outline', { method: 'POST', body: settled, signal }),
    enabled: Boolean(draft.script.trim()),
    // The key holds the whole script and only the latest one is shown: an
    // answer for an earlier draft is never needed again, so none is kept.
    gcTime: 0,
  });
  // Statuses are index-aligned with the plan of the request they answered.
  const statuses = settled === request ? status.data?.chapters : undefined;
  const preview = useChapterPreview(draft, {
    disabled,
    canPreview,
    onBusy,
    onRendered: () => void queryClient.invalidateQueries({ queryKey: ['audiobook-outline'] }),
  });
  const [renaming, setRenaming] = useState<number | null>(null);
  // The row whose title takes the focus back once its rename field is gone.
  const refocus = useRef<number | null>(null);

  /** Make an edit in the editor, which then has the focus; false when there is none to make. */
  const edit = (make: (text: string) => MarkupEdit | null) => {
    const target = getTarget();
    if (!target || disabled) return false;
    const result = make(target.element.value);
    if (result) applyMarkupEdit(target, () => result);
    return result !== null;
  };
  /** Close the rename field; unless an edit took the focus, its row's title gets it back. */
  const stopRenaming = (start: number, edited = false) => {
    if (!edited) refocus.current = start;
    setRenaming(null);
  };
  const reveal = (node: OutlineNode) => {
    const element = getTarget()?.element;
    if (element) revealOffset(element, node.titleStart ?? node.start);
  };
  const titleOf = (node: OutlineNode, chapter: OutlineChapter, index: number) =>
    node.title !== null
      ? displayTitle(node.title) || node.title
      : t('audiobook.chapter_n', { n: (chapter.plan ?? index) + 1 });
  const chapterCount = outline.filter((chapter) => chapter.title !== null).length;

  const row = (node: OutlineNode, chapter: OutlineChapter, index: number) => {
    const title = titleOf(node, chapter, index);
    const state = node.level === 1 && chapter.plan !== null ? statuses?.[chapter.plan] : undefined;
    const editing = renaming === node.start && node.title !== null;
    const actions: NodeAction[] = [];
    if (node.title !== null)
      actions.push({
        key: 'rename',
        icon: <PencilLineIcon />,
        label: t('book.rename'),
        run: () => setRenaming(node.start),
      });
    actions.push(
      {
        key: 'chapter',
        icon: <BookPlusIcon />,
        label: t('book.add_chapter'),
        // A new chapter goes after this whole chapter, sections included.
        run: () =>
          edit((text) =>
            insertHeading(text, chapter.end, 1, t('audiobook.chapter_n', { n: chapterCount + 1 })),
          ),
      },
      {
        key: 'section',
        icon: <HeadingIcon />,
        label: t('book.add_section'),
        run: () =>
          edit((text) =>
            insertHeading(text, node.end, node.level === 3 ? 3 : 2, t('book.new_section')),
          ),
      },
    );
    if (node.title !== null)
      actions.push({
        key: 'remove',
        icon: <Trash2Icon />,
        label: t('book.remove_heading'),
        run: () => edit((text) => removeHeading(text, node.start)),
      });
    return (
      <div
        className={cn(
          'group flex min-w-0 items-center gap-1 rounded-md py-0.5 ps-1 pe-0.5 hover:bg-muted/50',
          node.level === 2 && 'ps-4',
          node.level === 3 && 'ps-7',
        )}
      >
        {/* The title takes the row's width; its length and status sit on a
            line of their own under it, so a narrow sidebar still shows it. */}
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              autoFocus
              defaultValue={node.title ?? ''}
              aria-label={t('book.rename_title', { title })}
              className="h-7 w-full text-sm"
              onKeyDown={(event) => {
                if (event.key === 'Escape') stopRenaming(node.start);
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                const value = event.currentTarget.value;
                stopRenaming(
                  node.start,
                  edit((text) => renameHeading(text, node.start, value)),
                );
              }}
              onBlur={() => setRenaming(null)}
            />
          ) : (
            <button
              ref={(element) => {
                if (!element || refocus.current !== node.start) return;
                refocus.current = null;
                element.focus();
              }}
              type="button"
              className={cn(
                'block w-full truncate rounded-sm px-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                node.level === 1 ? 'text-sm font-medium' : 'text-[13px] text-foreground/85',
              )}
              title={title}
              onClick={() => reveal(node)}
            >
              {title}
            </button>
          )}
          <p
            data-slot="outline-meta"
            className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-[11px] text-muted-foreground tabular-nums"
          >
            <span>
              {t('book.node_meta', {
                count: node.words,
                words: formatCount(node.words),
                runtime: formatRuntimeClock(node.runtimeSec),
              })}
            </span>
            {node.level === 1 &&
              (chapter.plan === null ? (
                <StatusBadge className={STATUS_CLASSES.not_rendered}>
                  {t('book.status_empty')}
                </StatusBadge>
              ) : (
                state && (
                  <StatusBadge
                    className={STATUS_CLASSES[state.status]}
                    title={t(STATUS_LABELS[state.status][1])}
                  >
                    {t(STATUS_LABELS[state.status][0])}
                  </StatusBadge>
                )
              ))}
          </p>
        </div>
        {node.level === 1 && chapter.plan !== null && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled || !canPreview || preview.pending}
            aria-label={t('audiobook.preview_chapter', { title })}
            title={t('book.render_chapter')}
            onClick={() => void preview.render(chapter.plan as number)}
          >
            <PlayIcon />
          </Button>
        )}
        <NodeMenu label={t('book.more', { title })} disabled={disabled} actions={actions} />
      </div>
    );
  };

  return (
    <details open className="space-y-2">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <ListTreeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('book.contents')}
      </summary>
      {outline.length ? (
        <nav aria-label={t('book.contents')} className="max-h-80 overflow-y-auto">
          <ol className="space-y-0.5">
            {outline.map((chapter, index) => (
              <li key={chapter.start}>
                {row(chapter, chapter, index)}
                {chapter.sections.length > 0 && (
                  <ol>
                    {chapter.sections.map((section) => (
                      <li key={section.start}>{row(section, chapter, index)}</li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : (
        <p className="text-xs text-muted-foreground">{t('book.empty')}</p>
      )}
      <ChapterPreview preview={preview} />
    </details>
  );
}

interface NodeAction {
  key: string;
  icon: ReactNode;
  label: string;
  run(): void;
}

/** A row's "…" menu of heading edits. */
function NodeMenu({
  label,
  disabled,
  actions,
}: {
  label: string;
  disabled: boolean;
  actions: NodeAction[];
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
        aria-label={label}
      >
        <EllipsisIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup
            ref={popupRef}
            // An action that moved the focus on (to the editor, or the title
            // field) keeps it there; a close that would lose it (Escape, or an
            // edit with nothing to change) hands it back to the trigger.
            finalFocus={() => {
              const active = document.activeElement;
              return !active || active === document.body || !!popupRef.current?.contains(active);
            }}
            className="min-w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
          >
            {actions.map((action) => (
              <Menu.Item key={action.key} className={MENU_ITEM} onClick={action.run}>
                <span className="[&>svg]:size-4">{action.icon}</span>
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function StatusBadge({
  className,
  title,
  children,
}: {
  className: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn('shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium', className)}
    >
      {children}
    </span>
  );
}
