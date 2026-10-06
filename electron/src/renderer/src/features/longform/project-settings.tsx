import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AudioLinesIcon,
  BookOpenTextIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeError } from '@/lib/api/client';
import { isImeComposing } from '@/lib/ime';
import { cn } from '@/lib/utils';
import {
  deleteLongformProject,
  duplicateLongformProject,
  listLongformProjects,
  newLongformProject,
  openLongformProject,
  renameLongformProject,
  saveLongformProject,
  switchBlocker,
  useLongformSession,
  type Mode,
} from './longform-session';
import type { LongformProjectMeta } from './project-library';

function edited(value: number): string {
  if (!value) return '';
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

/**
 * The open book in the page header — its name and whether it is saved — and
 * the library of this mode's books behind it: search, open, new, rename,
 * duplicate, delete. Every book saves itself as it is edited.
 */
export function ProjectSwitcher({ mode }: { mode: Mode }) {
  const { t } = useTranslation();
  const session = useLongformSession();
  const draft = session.drafts[mode];
  const state = session.saving[mode];
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['longform-projects'], queryFn: listLongformProjects });
  const current = query.data?.find((project) => project.id === draft.projectId);
  const name =
    current?.name ||
    draft.title.trim() ||
    t(mode === 'audiobook' ? 'library.new_book' : 'library.new_story');
  const Icon = mode === 'audiobook' ? BookOpenTextIcon : AudioLinesIcon;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="min-w-0 gap-1.5 px-2"
        aria-haspopup="dialog"
        aria-label={name + ' — ' + t('library.open_library')}
        title={t('library.open_library')}
        onClick={() => setOpen(true)}
      >
        <Icon className="text-muted-foreground" />
        <span className="max-w-[18rem] truncate">{name}</span>
        <ChevronDownIcon className="text-muted-foreground" />
      </Button>
      <SaveState mode={mode} state={state} error={session.saveError[mode]} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl" style={{ background: 'var(--popover)' }}>
          {open && (
            <LibraryPanel
              mode={mode}
              projects={query.data}
              loading={query.isPending}
              loadError={query.isError ? describeError(query.error) : null}
              onRetry={() => void query.refetch()}
              currentId={draft.projectId}
              onClose={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SaveState({ mode, state, error }: { mode: Mode; state: string; error: string | null }) {
  const { t } = useTranslation();
  if (state === 'error')
    return (
      <Button
        size="xs"
        variant="ghost"
        className="text-destructive"
        title={t('library.save_failed_detail', { reason: error || t('common.error') })}
        onClick={() => void saveLongformProject(mode).catch(() => {})}
      >
        {t('library.save_failed')}
      </Button>
    );
  if (state !== 'saving' && state !== 'saved') return null;
  return (
    <span
      role="status"
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
    >
      {state === 'saving' ? (
        <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" />
      ) : (
        <CheckIcon className="size-3" />
      )}
      {t(state === 'saving' ? 'common.saving' : 'library.saved')}
    </span>
  );
}

export function LibraryPanel({
  mode,
  projects,
  loading,
  loadError,
  onRetry,
  currentId,
  onClose,
}: {
  mode: Mode;
  projects: LongformProjectMeta[] | undefined;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  currentId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Subscribed to the session, so a render starting or ending here locks and
  // unlocks switching at once.
  useLongformSession();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const blocker = switchBlocker(mode);
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (projects || []).filter(
      (project) =>
        project.mode === mode && (!term || project.name.toLocaleLowerCase().includes(term)),
    );
  }, [mode, projects, search]);
  useEffect(() => setDeleting(null), [search]);
  const run = async (work: () => Promise<unknown>, close = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      if (close) onClose();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const openProject = (id: string) =>
    id === currentId ? onClose() : void run(() => openLongformProject(id), true);
  // Arrow keys move between the books, as in a list box.
  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-library-open]') || [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? items[Math.min(items.length - 1, at + 1)]
        : items[Math.max(0, at < 0 ? 0 : at - 1)];
    next?.focus();
  };
  const remove = visible.find((project) => project.id === deleting);
  return (
    <div className="flex min-h-0 flex-col gap-3" onKeyDown={moveFocus}>
      <DialogHeader>
        <DialogTitle>{t(mode === 'audiobook' ? 'library.books' : 'library.stories')}</DialogTitle>
        <DialogDescription className="sr-only">{t('library.open_library')}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            autoFocus
            className="ps-9"
            aria-label={t('library.search')}
            placeholder={t('library.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (event.key === 'Enter' && visible[0]) openProject(visible[0].id);
            }}
          />
        </div>
        <Button
          variant="outline"
          disabled={busy || !!blocker}
          onClick={() => void run(() => newLongformProject(mode), true)}
        >
          <PlusIcon />
          {t(mode === 'audiobook' ? 'library.new_book' : 'library.new_story')}
        </Button>
      </div>
      {blocker && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {blocker}
        </p>
      )}
      {(error || loadError) && (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">{error || loadError}</span>
          {loadError && !error && (
            <Button size="xs" variant="ghost" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          )}
        </div>
      )}
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      {!loading && !visible.length && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {search.trim() ? t('common.no_matches') : t('library.empty')}
        </p>
      )}
      <ul ref={list} className="-mx-2 max-h-[min(60vh,28rem)] space-y-0.5 overflow-y-auto px-2">
        {visible.map((project) => {
          const isCurrent = project.id === currentId;
          const details = [
            t('library.words', { count: project.words }),
            t('library.chapters', { count: project.chapters }),
            project.updatedAt ? t('library.edited', { when: edited(project.updatedAt) }) : '',
          ].filter(Boolean);
          return (
            <li key={project.id} className="rounded-lg">
              {renaming?.id === project.id ? (
                <form
                  className="flex items-center gap-2 p-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!renaming.name.trim()) return;
                    void run(async () => {
                      await renameLongformProject(project.id, renaming.name);
                      setRenaming(null);
                    });
                  }}
                >
                  <Input
                    autoFocus
                    className="min-w-0 flex-1"
                    aria-label={t('stories.projectName')}
                    value={renaming.name}
                    disabled={busy}
                    onChange={(event) => setRenaming({ id: project.id, name: event.target.value })}
                    onKeyDown={(event) => {
                      if (isImeComposing(event)) {
                        event.stopPropagation();
                        return;
                      }
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                  />
                  <Button type="submit" size="sm" disabled={busy || !renaming.name.trim()}>
                    {t('sidebar.rename_save')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                    {t('common.cancel')}
                  </Button>
                </form>
              ) : (
                <div
                  className={cn(
                    'group flex items-center gap-1 rounded-lg pe-1 hover:bg-muted/50 focus-within:bg-muted/50',
                    isCurrent && 'bg-muted/40',
                  )}
                >
                  <button
                    type="button"
                    data-library-open=""
                    className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    aria-current={isCurrent ? 'true' : undefined}
                    disabled={busy || (!isCurrent && !!blocker)}
                    onClick={() => openProject(project.id)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{project.name}</span>
                      {isCurrent && (
                        <span className="shrink-0 rounded bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
                          {t('library.open_now')}
                        </span>
                      )}
                      {project.output && (
                        <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                          {t('library.has_audio')}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {details.join(' · ')}
                    </span>
                  </button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('sidebar.rename') + ' ' + project.name}
                    disabled={busy}
                    onClick={() => setRenaming({ id: project.id, name: project.name })}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('library.duplicate') + ' ' + project.name}
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        duplicateLongformProject(
                          project.id,
                          t('library.copy_name', { name: project.name }),
                        ),
                      )
                    }
                  >
                    <CopyIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('common.delete') + ' ' + project.name}
                    disabled={busy || (isCurrent && !!blocker)}
                    onClick={() => setDeleting(project.id)}
                  >
                    <TrashIcon />
                  </Button>
                </div>
              )}
              {remove?.id === project.id && (
                <div
                  role="alertdialog"
                  aria-label={t('library.delete_title', { name: project.name })}
                  className="m-1 space-y-2 rounded-lg bg-destructive/10 p-3 text-xs"
                >
                  <p className="font-medium">{t('library.delete_title', { name: project.name })}</p>
                  <p className="text-muted-foreground">{t('library.delete_body')}</p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      autoFocus
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await deleteLongformProject(project.id);
                          setDeleting(null);
                        })
                      }
                    >
                      {t('common.delete')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setDeleting(null)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
