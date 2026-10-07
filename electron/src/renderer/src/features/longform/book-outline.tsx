import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  BookPlusIcon,
  EllipsisIcon,
  HeadingIcon,
  ListTreeIcon,
  PanelLeftCloseIcon,
  PencilLineIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react';
import { formatRuntimeClock } from '@shared/utils/audiobookScript';
import { buttonVariants, Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiJson } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { ChapterPreview, useChapterPreview, type RetakenChapter } from './chapter-previews';
import { outlineQueryKey, outlineRequest, type Draft } from './longform-session';
import type { PreviewLock } from './preview-run';
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
import { useScriptSpellcheck } from '@/hooks/use-script-spellcheck';

export type ChapterStatus = 'rendered' | 'changed' | 'not_rendered';

/** How many phrase takes a chapter reads, and how many a render would reuse. */
interface ChapterTakes {
  total: number;
  cached: number;
}

interface OutlineStatus {
  chapters: Array<{
    title: string;
    untitled?: boolean;
    status: ChapterStatus;
    cached: boolean | null;
    /** Read sentence by sentence and not cached whole (newer backends). */
    takes?: ChapterTakes;
  }>;
  book: boolean;
}

// Typing settles before the chapters are looked up again.
const STATUS_DELAY_MS = 700;

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

/**
 * Why a chapter has its status, as the key of its tooltip. "Changed" means
 * the last audiobook holds another version of the chapter: its script or the
 * settings it is read with changed since. When that new version is already
 * rendered on its own (cached), the next audiobook reuses it; otherwise the
 * chapter renders again.
 */
export function statusHint(status: ChapterStatus, cached: boolean | null): string {
  return status === 'changed' && cached ? 'book.hint_changed_ready' : STATUS_LABELS[status][1];
}

/**
 * What a chapter that must render again has left to render, read sentence by
 * sentence: how many of its takes (0: every take is rendered, so the book only
 * joins them again). `null` when the outline cannot tell, or while none of
 * its takes is rendered yet — its status says as much.
 */
export function takesLeft(status: ChapterStatus, takes?: ChapterTakes): number | null {
  if (status === 'rendered' || !takes || takes.cached <= 0) return null;
  return Math.max(0, takes.total - takes.cached);
}

const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50';

/**
 * What a row does, by its place in the outline: chapter `chapter`, and
 * `section` of it (-1: the chapter itself). Each acts on the outline as it
 * is when used — never as it was when the row last rendered, which an edit
 * elsewhere in the script moved on since — so the rows can skip rendering
 * while nothing they show changes.
 */
interface RowActions {
  reveal(chapter: number, section: number): void;
  rename(chapter: number, section: number): void;
  /** Close the rename field with `title` (Enter), or with nothing done (`null`: Escape). */
  stopRenaming(chapter: number, section: number, title: string | null): void;
  /** The rename field lost the focus. */
  leaveRename(): void;
  /** Whether the row's title takes the focus back (its rename field just closed). */
  takeFocus(chapter: number, section: number): boolean;
  addTitle(chapter: number): void;
  addChapter(chapter: number): void;
  addSection(chapter: number, section: number): void;
  removeHeading(chapter: number, section: number): void;
  render(chapter: number): void;
}

const rowKey = (chapter: number, section: number) => `${chapter}.${section}`;

/**
 * The book's table of contents, a rail inside the Audiobook editor: chapters
 * and their sections, each with its length and — for chapters — whether its
 * audio is rendered for the script and settings as they are now, or changed
 * since the last book, and, read sentence by sentence, how many of its
 * sentences a render has left to read. A row moves the editor's caret to its
 * heading and scrolls the editor, never the page; its menu renames, adds or
 * removes headings (undoable edits in the editor), and a chapter renders on
 * its own, filling the caches the full book reuses — under the page's
 * preview lock (`previews`), with the editor open meanwhile. The untitled
 * text before the first heading is the intro, never a "Chapter 1": its menu
 * gives it a heading.
 */
export function BookOutline({
  draft,
  disabled,
  canPreview,
  previews,
  getTarget,
  retaken,
  previewSettings = null,
  onCollapse,
  onReveal,
  className,
}: {
  draft: Draft;
  disabled: boolean;
  canPreview: boolean;
  /** One preview renders at a time: a chapter's waits while another renders. */
  previews: PreviewLock;
  getTarget: () => MarkupTarget | null;
  /** The last retake of a sentence: a preview of its chapter is out of date. */
  retaken?: RetakenChapter | null;
  /** The engine, preset and reading a preview renders under (`usePreviewSettings`). */
  previewSettings?: string | null;
  /** Fold the rail away. */
  onCollapse?: () => void;
  /** A row moved the editor's caret to its heading. */
  onReveal?: () => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const spellcheck = useScriptSpellcheck();
  const queryClient = useQueryClient();
  const outline = useMemo(() => scriptOutline(draft.script), [draft.script]);
  const request = JSON.stringify(outlineRequest(draft));
  const [settled, setSettled] = useState(request);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(request), STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [request]);
  const status = useQuery({
    // The render reads it too, for the chapters it will find cached (renderTiming).
    queryKey: outlineQueryKey(settled),
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
    previews,
    onRendered: () => void queryClient.invalidateQueries({ queryKey: ['audiobook-outline'] }),
    retaken,
    outline,
    settings: previewSettings,
  });
  // The row being renamed, by its place (`rowKey`).
  const [renaming, setRenaming] = useState<string | null>(null);
  // The row whose title takes the focus back once its rename field is gone.
  const refocus = useRef<string | null>(null);
  const chapterCount = outline.filter((chapter) => chapter.title !== null).length;
  // Only the text before the first heading has no title: the intro when
  // chapters follow it, else the book's one chapter (no heading at all).
  const untitledName =
    chapterCount > 0 ? t('book.intro_untitled') : t('audiobook.chapter_n', { n: 1 });
  const titleOf = (node: OutlineNode) =>
    node.title !== null ? displayTitle(node.title) || node.title : untitledName;
  // Named as the outline names it now — unless its chapter changed since,
  // and another may stand at its place: then as it was named when rendered.
  const previewed = preview.outdated
    ? undefined
    : outline.find((chapter) => chapter.plan === preview.output?.index);

  // The rows act through `actions`, which read what they act on from here
  // when used: the outline, the editor and the preview of the latest render.
  const latest = useRef({ outline, getTarget, disabled, chapterCount, titleOf, preview, onReveal });
  useLayoutEffect(() => {
    latest.current = { outline, getTarget, disabled, chapterCount, titleOf, preview, onReveal };
  });
  const actions = useMemo<RowActions>(() => {
    const find = (chapter: number, section: number) => {
      const owner = latest.current.outline[chapter];
      const node = section < 0 ? owner : owner?.sections[section];
      return owner && node ? { owner, node } : null;
    };
    /** Make an edit in the editor, which then has the focus; false when there is none to make. */
    const edit = (make: (text: string) => MarkupEdit | null) => {
      const target = latest.current.getTarget();
      if (!target || latest.current.disabled) return false;
      const result = make(target.element.value);
      if (result) applyMarkupEdit(target, () => result);
      return result !== null;
    };
    return {
      reveal(chapter, section) {
        const found = find(chapter, section);
        const element = latest.current.getTarget()?.element;
        if (!found || !element) return;
        revealOffset(element, found.node.titleStart ?? found.node.start);
        latest.current.onReveal?.();
      },
      rename: (chapter, section) => setRenaming(rowKey(chapter, section)),
      stopRenaming(chapter, section, title) {
        const found = find(chapter, section);
        const edited =
          title !== null &&
          found !== null &&
          edit((text) => renameHeading(text, found.node.start, title));
        // Unless an edit took the focus, the row's title gets it back.
        if (!edited) refocus.current = rowKey(chapter, section);
        setRenaming(null);
      },
      leaveRename: () => setRenaming(null),
      takeFocus(chapter, section) {
        if (refocus.current !== rowKey(chapter, section)) return false;
        refocus.current = null;
        return true;
      },
      addTitle(chapter) {
        const found = find(chapter, -1);
        const titled = latest.current.chapterCount > 0;
        // A `# ` heading above the intro, its title selected to type over.
        if (found)
          edit((text) =>
            insertHeading(
              text,
              found.node.start,
              1,
              titled ? t('book.intro_heading') : t('audiobook.chapter_n', { n: 1 }),
            ),
          );
      },
      addChapter(chapter) {
        const found = find(chapter, -1);
        const n = latest.current.chapterCount + 1;
        // A new chapter goes after this whole chapter, sections included.
        if (found)
          edit((text) => insertHeading(text, found.owner.end, 1, t('audiobook.chapter_n', { n })));
      },
      addSection(chapter, section) {
        const found = find(chapter, section);
        if (found)
          edit((text) =>
            insertHeading(
              text,
              found.node.end,
              found.node.level === 3 ? 3 : 2,
              t('book.new_section'),
            ),
          );
      },
      removeHeading(chapter, section) {
        const found = find(chapter, section);
        if (found) edit((text) => removeHeading(text, found.node.start));
      },
      render(chapter) {
        const found = find(chapter, -1);
        if (found?.owner.plan != null)
          void latest.current.preview.render(found.owner.plan, latest.current.titleOf(found.owner));
      },
    };
    // `t` changes with the language, and the menu actions name what they add in it.
  }, [t]);
  const canRender = !disabled && canPreview && !previews.busy;
  const row = (node: OutlineNode, chapter: OutlineChapter, at: number, section: number) => {
    const state = section < 0 && chapter.plan !== null ? statuses?.[chapter.plan] : undefined;
    return (
      <OutlineRow
        chapter={at}
        section={section}
        title={titleOf(node)}
        heading={node.title}
        level={node.level}
        words={node.words}
        runtimeSec={node.runtimeSec}
        plan={section < 0 ? chapter.plan : undefined}
        status={state?.status}
        cached={state?.cached}
        left={state ? takesLeft(state.status, state.takes) : null}
        editing={renaming === rowKey(at, section) && node.title !== null}
        disabled={disabled}
        canRender={canRender}
        spellcheck={spellcheck}
        t={t}
        language={language}
        actions={actions}
      />
    );
  };

  return (
    <section
      data-slot="book-outline"
      aria-label={t('book.contents')}
      className={cn('flex min-h-0 flex-col gap-2', className)}
    >
      <div className="flex shrink-0 items-center gap-2 ps-1">
        <ListTreeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t('book.contents')}</h2>
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('book.hide_contents')}
            title={t('book.hide_contents')}
            onClick={onCollapse}
          >
            <PanelLeftCloseIcon />
          </Button>
        )}
      </div>
      {outline.length ? (
        <nav aria-label={t('book.contents')} className="min-h-0 flex-1 overflow-y-auto">
          {/* Rows go by their place, not their offset into the text, which
              every keystroke above them moves: typing re-renders the row it
              changes, never the rows after it. */}
          <ol className="space-y-0.5">
            {outline.map((chapter, at) => (
              <li key={at}>
                {row(chapter, chapter, at, -1)}
                {chapter.sections.length > 0 && (
                  <ol>
                    {chapter.sections.map((section, index) => (
                      <li key={index}>{row(section, chapter, at, index)}</li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : (
        <p className="min-h-0 flex-1 px-1 text-xs text-muted-foreground">{t('book.empty')}</p>
      )}
      <div className="shrink-0 space-y-2 empty:hidden">
        <ChapterPreview preview={preview} label={previewed && titleOf(previewed)} />
      </div>
    </section>
  );
}

/**
 * One row of the contents: a chapter (`section` -1) or a section of it, by
 * its place. It shows only what its props say — never an offset into the
 * text — so typing elsewhere leaves it as it is, and it skips rendering;
 * its actions find the node they act on when used.
 */
const OutlineRow = memo(function OutlineRow({
  chapter,
  section,
  title,
  heading,
  level,
  words,
  runtimeSec,
  plan,
  status,
  cached,
  left,
  editing,
  disabled,
  canRender,
  spellcheck,
  t,
  language,
  actions,
}: {
  chapter: number;
  section: number;
  /** The name shown: the heading as the listener reads it, or the untitled opening's. */
  title: string;
  /** The heading as written; `null` for the untitled opening. */
  heading: string | null;
  level: 1 | 2 | 3;
  words: number;
  runtimeSec: number;
  /** A chapter's index in the render's plan (`null`: nothing to render); none for a section. */
  plan?: number | null;
  status?: ChapterStatus;
  cached?: boolean | null;
  /** Its sentences left to render (`takesLeft`). */
  left: number | null;
  /** Its rename field is open. */
  editing: boolean;
  disabled: boolean;
  /** Its chapter can render on its own now. */
  canRender: boolean;
  spellcheck: boolean;
  /**
   * The app's language: its words (`t`, another one in another language) and
   * how the counts are written. Handed down from the contents, not
   * subscribed to by each of hundreds of rows.
   */
  t: TFunction;
  language: string;
  actions: RowActions;
}) {
  const formatCount = (value: number) => value.toLocaleString(language);
  const menu: NodeAction[] = [];
  if (heading !== null)
    menu.push({
      key: 'rename',
      icon: <PencilLineIcon />,
      label: t('book.rename'),
      run: () => actions.rename(chapter, section),
    });
  else
    menu.push({
      key: 'title',
      icon: <PencilLineIcon />,
      label: t('book.add_title'),
      run: () => actions.addTitle(chapter),
    });
  menu.push(
    {
      key: 'chapter',
      icon: <BookPlusIcon />,
      label: t('book.add_chapter'),
      run: () => actions.addChapter(chapter),
    },
    {
      key: 'section',
      icon: <HeadingIcon />,
      label: t('book.add_section'),
      run: () => actions.addSection(chapter, section),
    },
  );
  if (heading !== null)
    menu.push({
      key: 'remove',
      icon: <Trash2Icon />,
      label: t('book.remove_heading'),
      run: () => actions.removeHeading(chapter, section),
    });
  return (
    <div
      className={cn(
        'group flex min-w-0 items-center gap-1 rounded-md py-0.5 ps-1 pe-0.5 hover:bg-muted/50',
        level === 2 && 'ps-4',
        level === 3 && 'ps-7',
      )}
    >
      {/* The title takes the row's width; its length and status sit on a
          line of their own under it, so a narrow rail still shows it. */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            spellCheck={spellcheck}
            defaultValue={heading ?? ''}
            aria-label={t('book.rename_title', { title })}
            className="h-7 w-full text-sm"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // Handled: it ends the rename, not the contents around it.
                event.preventDefault();
                actions.stopRenaming(chapter, section, null);
              }
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              actions.stopRenaming(chapter, section, event.currentTarget.value);
            }}
            onBlur={actions.leaveRename}
          />
        ) : (
          <button
            ref={(element) => {
              if (element && actions.takeFocus(chapter, section)) element.focus();
            }}
            type="button"
            className={cn(
              'block w-full truncate rounded-sm px-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              level === 1 ? 'text-sm font-medium' : 'text-[13px] text-foreground/85',
              heading === null && 'text-muted-foreground italic',
            )}
            title={title}
            onClick={() => actions.reveal(chapter, section)}
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
              count: words,
              words: formatCount(words),
              runtime: formatRuntimeClock(runtimeSec),
            })}
          </span>
          {plan !== undefined &&
            (plan === null ? (
              <StatusBadge className={STATUS_CLASSES.not_rendered}>
                {t('book.status_empty')}
              </StatusBadge>
            ) : (
              status && (
                <StatusBadge
                  className={STATUS_CLASSES[status]}
                  title={t(statusHint(status, cached ?? null))}
                >
                  {t(STATUS_LABELS[status][0])}
                </StatusBadge>
              )
            ))}
          {left !== null && (
            <span
              data-slot="outline-takes"
              title={t(left ? 'book.hint_takes_to_render' : 'book.hint_takes_ready')}
            >
              {left
                ? t('book.takes_to_render', { count: left, number: formatCount(left) })
                : t('book.takes_ready')}
            </span>
          )}
        </p>
      </div>
      {plan != null && (
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={!canRender}
          aria-label={t('audiobook.preview_chapter', { title })}
          title={t('book.render_chapter')}
          onClick={() => actions.render(chapter)}
        >
          <PlayIcon />
        </Button>
      )}
      <NodeMenu label={t('book.more', { title })} disabled={disabled} actions={menu} />
    </div>
  );
});

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
