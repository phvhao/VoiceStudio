import { useMemo } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CornerDownRightIcon,
  SearchIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api/client';
import type { Profile } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/** A profile as the picker needs it; a row without `kind` reads as a clone, as the backend reads it. */
export type VoiceProfile = Pick<Profile, 'id' | 'name'> &
  Partial<Pick<Profile, 'kind' | 'image_url'>>;

interface ProfilesQuery<T> {
  data: T[] | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch(): unknown;
}

/**
 * The profile list as the voice pickers read it: still loading only while it
 * is on its way. A failed load is not loading — `ProfilesFailure` says so.
 */
// No list yet (or none at all) is one empty list, not a new one every render:
// what is worked out from it, and passed on, stays the same.
const NO_PROFILES: never[] = [];
export function profileListState<T>(query: ProfilesQuery<T>): { profiles: T[]; loading: boolean } {
  return { profiles: query.data ?? NO_PROFILES, loading: query.isPending };
}

/** Why the voice list could not load, and a retry; nothing while it has not failed. */
export function ProfilesFailure({ query }: { query: ProfilesQuery<unknown> }) {
  const { t } = useTranslation();
  if (!query.isError) return null;
  return (
    <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
      <CircleAlertIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{describeError(query.error)}</span>
      <Button
        size="xs"
        variant="ghost"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {t('common.retry')}
      </Button>
    </p>
  );
}

interface VoiceOption {
  value: string;
  label: string;
  detail?: string;
  profile?: VoiceProfile;
}

interface VoiceGroup {
  key: 'default' | 'clone' | 'design';
  items: VoiceOption[];
}

// Base UI reserves null for "nothing selected", so the inherit option takes
// '', which no profile id can be (VoiceSelector marks its default the same way).
const DEFAULT_VALUE = '';

/** Lower-cased and accent-free, so "giong" finds "Giọng" and "dao" finds "Đào". */
function searchKey(text: string) {
  // NFD splits most accents into combining marks; đ is a letter of its own.
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd');
}

function voiceGroups(
  profiles: VoiceProfile[],
  locale: string,
  defaultLabel?: string,
  defaultDetail?: string,
): VoiceGroup[] {
  const option = (profile: VoiceProfile) => ({ value: profile.id, label: profile.name, profile });
  // A–Z in the interface language ("đ" after "d" in Vietnamese), numbers by
  // value so "voice 2" comes before "voice 10".
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  profiles = [...profiles].sort((a, b) => collator.compare(a.name, b.name));
  // `kind` is authoritative; the backend reads a legacy row without one as a clone.
  const designed = (profile: VoiceProfile) => profile.kind === 'design';
  const groups: VoiceGroup[] = [
    {
      key: 'default',
      items:
        defaultLabel === undefined
          ? []
          : [{ value: DEFAULT_VALUE, label: defaultLabel, detail: defaultDetail }],
    },
    { key: 'clone', items: profiles.filter((profile) => !designed(profile)).map(option) },
    { key: 'design', items: profiles.filter(designed).map(option) },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** Avatar (or the inherit arrow), name and detail: shared by the trigger and the rows. */
function OptionContent({ option }: { option: VoiceOption }) {
  return (
    <>
      {option.profile ? (
        <ProfileAvatar
          name={option.profile.name}
          imageUrl={option.profile.image_url}
          className="size-6"
        />
      ) : (
        <CornerDownRightIcon className="mx-1 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={option.label}>
        {option.label}
      </span>
      {option.detail && (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
          {option.detail}
        </span>
      )}
    </>
  );
}

export function VoicePicker({
  value,
  onChange,
  profiles,
  disabled = false,
  loading = false,
  defaultOption,
  attention = false,
  placeholder,
  'aria-label': ariaLabel,
  className,
}: {
  /** Profile id; null is no voice, or the default voice when `defaultOption` is set. */
  value: string | null;
  onChange(id: string | null): void;
  profiles: VoiceProfile[];
  disabled?: boolean;
  /**
   * The profiles are still loading: the chosen voice cannot be looked up yet,
   * so the trigger waits instead of calling it missing.
   */
  loading?: boolean;
  /** Offer a first option meaning "inherit the default voice" (value null). */
  defaultOption?: { label: string; detail?: string };
  /** Nothing chosen and a choice is required: amber attention ring on the trigger. */
  attention?: boolean;
  placeholder?: string;
  'aria-label'?: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  // Callers pass `defaultOption` inline; key the list on its strings, not its identity.
  const defaultLabel = defaultOption?.label;
  const defaultDetail = defaultOption?.detail;
  const groups = useMemo(
    () => voiceGroups(profiles, i18n.language, defaultLabel, defaultDetail),
    [profiles, i18n.language, defaultLabel, defaultDetail],
  );
  const items = useMemo(
    () =>
      Combobox.createItems(groups, {
        getValue: (option) => option.value,
        getLabel: (option) => option.label,
      }),
    [groups],
  );
  const selectedValue = value ?? (defaultLabel === undefined ? null : DEFAULT_VALUE);
  const current = groups
    .flatMap((group) => group.items)
    .find((option) => option.value === selectedValue);
  // Kind headings only help once both kinds are there.
  const headings = groups.filter((group) => group.key !== 'default').length > 1;
  const placeholderText = placeholder ?? t('convert.pick_voice');
  const label = ariaLabel ?? placeholderText;

  return (
    <Combobox.Root
      items={items}
      value={selectedValue}
      onValueChange={(next) => {
        const id = next === DEFAULT_VALUE ? null : next;
        // Picking the current voice again is not a change.
        if (id !== value) onChange(id);
      }}
      filter={(option, query) => searchKey(option.label).includes(searchKey(query))}
      // The search box sits in the popup: start it empty, not seeded with the
      // selected name, which would filter the list while it is closed.
      defaultInputValue=""
      autoHighlight
      disabled={disabled || loading}
    >
      <Combobox.Trigger
        aria-label={label}
        aria-busy={loading || undefined}
        data-attention={attention ? '' : undefined}
        className={cn(
          'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-input/20 px-2 text-start text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 data-attention:border-amber-500/70 data-attention:ring-2 data-attention:ring-amber-500/25 dark:bg-input/30 dark:hover:bg-input/50',
          !current?.profile && 'text-muted-foreground',
          className,
        )}
      >
        {current ? (
          <OptionContent option={current} />
        ) : value === null || loading ? (
          <>
            <span
              aria-hidden="true"
              className="size-6 shrink-0 rounded-full border border-dashed border-muted-foreground/50"
            />
            <span className="min-w-0 flex-1 truncate">
              {loading ? t('common.loading') : placeholderText}
            </span>
          </>
        ) : (
          <>
            <CircleAlertIcon className="mx-1 size-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate text-destructive">
              {t('voiceSelector.missingVoice')}
            </span>
          </>
        )}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={4} className="isolate z-50 outline-none">
          <Combobox.Popup
            aria-label={label}
            className="flex max-h-[min(60vh,22rem,var(--available-height))] w-(--anchor-width) max-w-(--available-width) min-w-60 origin-(--transform-origin) flex-col overflow-hidden rounded-lg surface-glass text-popover-foreground shadow-md ring-1 ring-border outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2.5">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Combobox.Input
                placeholder={t('markup.voice_search')}
                aria-label={t('markup.voice_search')}
                className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Combobox.Empty>
              {profiles.length > 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {t('markup.voice_none')}
                </p>
              )}
            </Combobox.Empty>
            <Combobox.List className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 empty:p-0">
              {(group: VoiceGroup) => (
                <Combobox.Group
                  key={group.key}
                  items={group.items}
                  className={cn(
                    group.key === 'default' &&
                      'mb-1 border-b border-border/50 pb-1 last:mb-0 last:border-0 last:pb-0',
                  )}
                >
                  {headings && group.key !== 'default' && (
                    <Combobox.GroupLabel className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {group.key === 'clone'
                        ? t('voiceSelector.clone')
                        : t('voiceSelector.designed')}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(option: VoiceOption) => (
                      <Combobox.Item
                        key={option.value}
                        value={option.value}
                        className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium"
                      >
                        <OptionContent option={option} />
                        <span className="flex w-4 shrink-0 justify-center">
                          <Combobox.ItemIndicator>
                            <CheckIcon className="size-3.5" />
                          </Combobox.ItemIndicator>
                        </span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
            {!profiles.length && (
              <p className="px-3 py-3 text-center text-xs text-muted-foreground">
                {t('stories.noProfiles')}
              </p>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
