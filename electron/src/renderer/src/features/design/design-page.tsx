import { WandSparklesIcon } from 'lucide-react';
import { SecondarySidebar } from '@/components/workspace-sidebar';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { ProfileAvatar } from '@/components/profile-avatar';
import { DemoPresets } from './demo-presets';
import { setCloneSetting, useCloneSetting } from '@/lib/store/clone-settings';
import { PersonalityPresets } from './personality-presets';
import { EditProfile } from '@/features/clone/edit-profile';
import { WorkspacePane } from '@/components/workspace-pane';
import { TakeDetails } from '@/features/clone/take-details';
import { openTake, useSelectedTake } from '@/lib/store/takes';
import {
  DESIGN_DRAFT_EVENT,
  STORAGE,
  applyDescription,
  designInstruct,
  designRecipe,
  designRequestSeed,
  editVoice,
  linkedDesignProfile,
  pickDetail,
  readDraft,
  replaceRecipe,
  restoreDesignProfile,
  type DesignDraft,
} from './design-draft';
import { useDescription } from './use-description';
import { useProfiles } from '@/hooks/use-profiles';
import { useEngines } from '@/hooks/use-engines';
import { AudioPreviewButton } from '@/components/audio-preview-button';
import { apiJson, describeError, profileAudioUrl } from '@/lib/api/client';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { PipelineFailure } from '@/components/pipeline-failure';
import { EngineNotice } from '@/components/engine-notice';
import {
  ChevronDownIcon,
  HistoryIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  SaveIcon,
  ShuffleIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, buttonVariants } from '@/components/ui/button';
import { GatedAction } from '@/components/gated-action';
import { runRendererTask } from '@/lib/global-error-recovery';
import {
  SYNTHESIS_TARGET,
  describeSynthesisBlockers,
  designBlockers,
} from '@/features/clone/synthesis-gates';
import { Input } from '@/components/ui/input';
import {
  SCRIPT_UNSUPPORTED_TAGS,
  ScriptInsertMenu,
  ScriptTagTools,
  useScriptInsertMenu,
} from '@/components/script-insert-menu';
import { MarkupTextarea } from '@/features/longform/markup-textarea';
import { useGenerateClone } from '@/hooks/use-generate';
import { EditorFrame, FocusToggle } from '@/components/editor-frame/editor-frame';
import { setEditorFocus, useEditorFocus } from '@/components/editor-frame/editor-focus';
import { ScriptEditorFrame } from '@/components/editor-frame/script-editor-frame';
import { TakesPanel } from '@/features/clone/takes-panel';
import { QualityControls } from '@/features/clone/quality-controls';
import { ReadingSettingsButton } from '@/components/reading-settings';
import { VoiceControls } from '@/features/clone/action-bar';
import { EngineLanguagePicker } from '@/features/clone/engine-language-picker';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';
import { cloneSettingsStore } from '@/lib/store/clone-settings';
import type { Profile } from '@/lib/api/types';
import { CATEGORIES, PRESETS } from '@shared/utils/constants';
import { buildDesignInstruct, mergeDescribedAttrs } from '@shared/utils/voiceInstruct';
import { pickDesignSeed } from '@shared/utils/seed';
export function DesignPage() {
  const { t } = useTranslation();
  const selectedTake = useSelectedTake();
  const [draft, setDraft] = useState(readDraft);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [startingOpen, setStartingOpen] = useState(true);
  const mapper = useDescription((mapped, described) =>
    // A mapping that lands after the description changed (edited, or the
    // recipe was replaced from another view) no longer describes this voice.
    setDraft((current) =>
      current.description.trim() === described
        ? applyDescription(current, mapped, described)
        : current,
    ),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const generation = useGenerateClone();
  const activeEngine = useEngines().activeTts;
  const freeform = generation.instructVocabulary === 'freeform';
  const description = draft.description;
  const client = useQueryClient();
  const profiles = useProfiles();
  const savedProfilesRef = useRef<HTMLDetailsElement>(null);
  const scriptRef = useRef<HTMLTextAreaElement>(null);
  const insert = useScriptInsertMenu(scriptRef);
  const setScript = (text: string) => setDraft((current) => ({ ...current, text }));
  const designProfiles = profiles.data?.filter((profile) => profile.kind === 'design') ?? [];
  // The saved voice this draft still is; any edit turns it into a new design.
  const activeProfile = linkedDesignProfile(draft, profiles.data);
  // Re-rendering a saved sample is cloning, which any ready engine can do.
  const designBlocker = generation.designBlockerFor(activeProfile);
  const navigate = useNavigate();
  // What Synthesize still needs, each with the way to its fix (see GatedAction).
  const blockers = describeSynthesisBlockers(designBlockers(designBlocker, draft.text), {
    t,
    engine: activeEngine?.display_name ?? '',
    script: SYNTHESIS_TARGET.designScript,
    openSettings: () =>
      runRendererTask('Open model settings', () =>
        navigate({ to: '/settings/models/$family', params: { family: 'tts' } }),
      ),
  });
  const editingProfile = profiles.data?.find((profile) => profile.id === editingId);
  const focused = useEditorFocus();
  const speed = useCloneSetting('speed');
  // Opening the profile editor or a take's details leaves focus mode.
  useEffect(() => {
    if (editingId || selectedTake?.mode === 'design') setEditorFocus(false);
  }, [editingId, selectedTake]);
  useEffect(() => {
    const restore = (event: Event) => {
      setDraft((event as CustomEvent<DesignDraft>).detail ?? readDraft());
    };
    window.addEventListener(DESIGN_DRAFT_EVENT, restore);
    return () => window.removeEventListener(DESIGN_DRAFT_EVENT, restore);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE, JSON.stringify(draft));
      } catch {
        /* Keep the in-memory draft. */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [draft]);
  const change = (category: string, value: string) => {
    // No mapper.cancel(): a mapping still in flight lands under this pick.
    const { clearedCategory } = pickDetail(draft, category, value);
    setDraft((current) => pickDetail(current, category, value).draft);
    if (clearedCategory) {
      toast(
        t('clone.vd_exclusive_cleared', {
          cleared: t(`clone.cat_${clearedCategory}`),
        }),
      );
    }
  };
  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = new FormData();
      body.set('name', name.trim());
      body.set('kind', 'design');
      body.set('seed', String(draft.seed));
      body.set('vd_states', JSON.stringify(draft.attrs));
      body.set('instruct', buildDesignInstruct(draft.attrs, '').instruct);
      body.set('language', cloneSettingsStore.state.language);
      const created = await apiJson<Profile>('/profiles', {
        method: 'POST',
        body,
      });
      await client.invalidateQueries({ queryKey: queryKeys.profiles });
      setDraft((current) => ({ ...current, profileId: created.id }));
      setCloneSetting('language', created.language || 'Auto');
      setName('');
    } catch (error) {
      setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  };
  const generationLabel = generation.isGenerating
    ? t(
        generation.stage === 'loading'
          ? generation.modelStage
            ? `synthesisState.${generation.modelStage}`
            : 'synthesisState.loading'
          : generation.stage === 'receiving'
            ? 'synthesisState.receiving'
            : generation.stage === 'preparing'
              ? 'synthesisState.preparing'
              : 'clone.generating_status',
      )
    : t('clone.synthesize');
  const generationProgress =
    generation.stage === 'loading' ? generation.modelProgress : generation.progress;
  const identityRecipe =
    Object.values(draft.attrs)
      .filter((value) => value && value !== 'Auto')
      .join(' · ') || t('clone.identity_auto');
  const composer = (
    <>
      {designBlocker === 'engine' && !generation.isGenerating && (
        <div className="mb-3">
          <EngineNotice operation="design" compact />
        </div>
      )}
      {/* The first thing Synthesize still needs; the engine notice says its own. */}
      {blockers.length > 0 && designBlocker !== 'engine' && !generation.isGenerating && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-muted-foreground">
          <p role="status">{blockers[0].message}</p>
          {(designBlocker === 'design' || designBlocker === 'cloning') && (
            <Link
              to="/settings/models/$family"
              params={{ family: 'tts' }}
              className={buttonVariants({ variant: 'ghost', size: 'xs' })}
            >
              {t('engineSidebar.tts')}
            </Link>
          )}
        </div>
      )}
      {generation.error && (
        <PipelineFailure
          className="mb-3"
          fallback={generation.error}
          onDismiss={generation.clearError}
        />
      )}
      {/* Wraps instead of overlapping: the controls stay whole beside or above the button. */}
      <div className="glass-panel relative flex min-h-16 flex-wrap items-center gap-3 overflow-hidden rounded-xl border border-border/60 bg-muted/30 p-3">
        <div className="flex min-w-0 items-center gap-1">
          <EngineLanguagePicker operation="tts" />
          <QualityControls size="sm" disabled={generation.isGenerating} />
          <ReadingSettingsButton
            side="top"
            disabled={generation.isGenerating}
            className="font-normal text-muted-foreground hover:text-foreground"
          />
          <VoiceControls size="icon-sm" />
        </div>
        <div className="ms-auto flex shrink-0 items-center justify-end gap-2">
          <span
            role={generation.isGenerating ? 'status' : undefined}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {generation.isGenerating
              ? `${generationProgress == null ? '' : `${Math.round(generationProgress)}% · `}${generation.elapsedSeconds.toFixed(1)}s`
              : null}
          </span>
          {/* Pressable while blocked: it lists what is missing, with the way to each. */}
          <GatedAction
            align="end"
            className="h-10 w-52 shrink-0 overflow-hidden rounded-lg px-4"
            disabled={
              generation.isGenerating ||
              // Free-form engines take the description itself, not its mapping,
              // and a mapping on its way lands in a moment.
              (!freeform && mapper.pending)
            }
            blockers={blockers}
            aria-busy={generation.isGenerating}
            aria-label={generationLabel}
            onClick={() =>
              void generation.generateDesign({
                text: draft.text,
                instruct: designInstruct(draft, generation.instructVocabulary),
                recipe: designRecipe(draft),
                seed: designRequestSeed(draft, activeProfile),
                profileId: activeProfile?.id ?? null,
              })
            }
          >
            {generation.isGenerating ? (
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <PlayIcon />
            )}
            <span className="truncate">{generationLabel}</span>
          </GatedAction>
          <Button
            size="icon-lg"
            className={cn('size-10 shrink-0', !generation.isGenerating && 'invisible')}
            variant="outline"
            disabled={!generation.isGenerating}
            onClick={generation.cancel}
            aria-label={t('clone.cancel_generation')}
          >
            <XIcon />
          </Button>
        </div>
        {generation.isGenerating && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
            <div
              className={
                generationProgress == null
                  ? 'h-full w-full animate-pulse bg-primary motion-reduce:animate-none'
                  : 'h-full bg-primary transition-[width] duration-200'
              }
              style={
                generationProgress == null ? undefined : { width: `${generationProgress}%` }
              }
            />
          </div>
        )}
      </div>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader>
        <h1 className="text-sm font-medium">{t('designWorkspace.title')}</h1>
      </WorkspaceHeader>
      <div className="flex min-h-0 flex-1 @max-[40rem]:flex-col">
        {/* Hidden, not unmounted, in focus mode: its folds stay as they were. */}
        <div hidden={focused} className="contents">
          <SecondarySidebar
            title={t('designWorkspace.title')}
            icon={WandSparklesIcon}
            size="wide"
            variant="controls"
            className="space-y-3"
          >
            <section className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="voice-description"
                  className="flex min-w-0 items-center gap-2 text-sm font-medium"
                >
                  <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  {t('clone.describe_label')}
                </label>
                {(description.trim() ||
                  Object.values(draft.attrs).some((value) => value !== 'Auto')) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={generation.isGenerating || mapper.pending}
                    onClick={() => {
                      // Reset drops the picks so the description alone decides again.
                      setDraft((current) => ({ ...current, picks: {}, profileId: null }));
                      mapper.reset(description);
                    }}
                  >
                    <RotateCcwIcon />
                    {t('clone.reset_to_description')}
                  </Button>
                )}
              </div>
              <textarea
                id="voice-description"
                maxLength={2000}
                disabled={generation.isGenerating}
                className="min-h-24 w-full resize-y rounded-lg border border-input bg-background/35 p-3 text-sm leading-5 outline-none transition-[border-color,background-color,box-shadow] focus-visible:border-primary/30 focus-visible:bg-background/50 focus-visible:ring-2 focus-visible:ring-ring/30"
                value={description}
                placeholder={t('clone.describe_placeholder')}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((current) => editVoice(current, { description: value }));
                  // Mapping runs for every engine so the details stay in step
                  // with the description when switching back to OmniVoice.
                  mapper.describe(value);
                }}
              />
              <p role="status" className="text-xs text-muted-foreground">
                {freeform
                  ? t('clone.describe_freeform')
                  : mapper.pending
                    ? t('preferences.loading')
                    : !mapper.matched
                      ? t('clone.describe_no_match')
                      : mapper.unmatched.length
                        ? t('clone.describe_unmatched', {
                            items: mapper.unmatched.join(', '),
                          })
                        : t('clone.describe_hint')}
              </p>
              {!freeform && mapper.failed && (
                <Button variant="ghost" size="xs" onClick={() => mapper.describe(description)}>
                  {t('backend.retry')}
                </Button>
              )}
            </section>
            <details
              ref={savedProfilesRef}
              className="group rounded-xl border border-border/60 bg-muted/20 p-3 text-sm"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
                {t('clone.saved_profiles')}
                <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2 space-y-1">
                {designProfiles.map((profile) => (
                  <div key={profile.id} className="flex items-center gap-1">
                    <Button
                      className="min-w-0 flex-1 justify-start truncate"
                      variant={activeProfile?.id === profile.id ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={activeProfile?.id === profile.id}
                      disabled={generation.isGenerating}
                      onClick={() => {
                        mapper.cancel();
                        const restored = restoreDesignProfile(profile, draft.seed);
                        setDraft((current) =>
                          replaceRecipe(current, {
                            attrs: restored.attrs,
                            seed: restored.seed,
                            profileId: restored.profileId,
                          }),
                        );
                        setCloneSetting('language', restored.language);
                      }}
                    >
                      {profile.name}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('paneActions.edit') + ': ' + profile.name}
                      onClick={() => {
                        setEditingId(profile.id);
                      }}
                    >
                      <PencilIcon />
                    </Button>
                    <AudioPreviewButton
                      src={profileAudioUrl(profile.id, profile.audio_url)}
                      source={'design-profile-' + profile.id}
                      activity={!profile.ref_audio_path ? 'synthesis' : undefined}
                      disabled={!profile.ref_audio_path && Boolean(generation.designBlocker)}
                      disabledLabel={
                        generation.designBlocker === 'design'
                          ? t('designWorkspace.engine_cannot_design', {
                              engine: activeEngine?.display_name ?? '',
                            })
                          : t('engines.none_ready_title')
                      }
                      onReady={
                        !profile.ref_audio_path
                          ? () =>
                              void client.invalidateQueries({
                                queryKey: queryKeys.profiles,
                              })
                          : undefined
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
            <details
              open={startingOpen}
              onToggle={(event) => setStartingOpen(event.currentTarget.open)}
              className="group rounded-xl border border-border/60 bg-muted/20 p-3 text-sm"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
                <SparklesIcon className="size-4 text-muted-foreground" />
                {t('clone.starting_points')}
                <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-2">
                <PersonalityPresets
                  disabled={generation.isGenerating}
                  attrs={draft.attrs}
                  onSelect={(attrs) => {
                    mapper.cancel();
                    setDraft((current) =>
                      replaceRecipe(current, { attrs: mergeDescribedAttrs(attrs) }),
                    );
                  }}
                />
                <div className="flex flex-wrap gap-1">
                  {PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      size="xs"
                      variant="ghost"
                      disabled={generation.isGenerating}
                      onClick={() => {
                        mapper.cancel();
                        setDraft((current) =>
                          replaceRecipe(current, { attrs: mergeDescribedAttrs(preset.attrs) }),
                        );
                      }}
                    >
                      {t('clone.preset_' + preset.id)
                        .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
                        .trim()}
                    </Button>
                  ))}
                </div>
              </div>
            </details>
            <details className="group rounded-xl border border-border/60 bg-muted/20 p-3 text-sm">
              <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
                <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
                {t('clone.details')}
                <span
                  className="ml-auto min-w-0 truncate text-xs font-normal text-muted-foreground"
                  title={identityRecipe}
                >
                  {identityRecipe}
                </span>
                <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-4 space-y-4">
                {Object.entries(CATEGORIES).map(([category, values]) => (
                  <fieldset key={category} disabled={generation.isGenerating} className="space-y-2">
                    <legend className="text-xs font-medium text-muted-foreground">
                      {t('clone.cat_' + category)}
                    </legend>
                    <div className="flex flex-wrap gap-1">
                      {values.map((value) => (
                        <Button
                          key={value}
                          size="xs"
                          variant={draft.attrs[category] === value ? 'secondary' : 'ghost'}
                          aria-pressed={draft.attrs[category] === value}
                          onClick={() => change(category, value)}
                        >
                          {value === 'Auto'
                            ? t('clone.auto')
                            : t('clone.opt_' + value.replaceAll(' ', '_').replaceAll('-', '_'), {
                                defaultValue: value,
                              })}
                        </Button>
                      ))}
                    </div>
                  </fieldset>
                ))}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t('clone.seed_label')}</span>
                  <Input
                    className="min-w-0"
                    type="number"
                    min={0}
                    max={2147483647}
                    aria-label={t('clone.seed_label')}
                    disabled={generation.isGenerating}
                    value={draft.seed}
                    onChange={(event) => {
                      const seed = Number(event.target.value);
                      if (Number.isInteger(seed) && seed >= 0 && seed <= 2147483647)
                        setDraft((current) => editVoice(current, { seed }));
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={generation.isGenerating}
                    aria-label={t('clone.seed_reroll')}
                    onClick={() =>
                      setDraft((current) => editVoice(current, { seed: pickDesignSeed(false, null) }))
                    }
                  >
                    <ShuffleIcon />
                  </Button>
                </div>
              </div>
            </details>
            <form
              className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label={t('clone.profile_name')}
                placeholder={`${t('clone.profile_name')}…`}
              />
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || saving || mapper.pending || generation.isGenerating}
              >
                <SaveIcon />
                {t('clone.save_as_profile')}
              </Button>
              {saveError && (
                <p role="alert" className="text-xs text-destructive">
                  {t('clone.save_failed', { message: saveError })}
                </p>
              )}
            </form>
          </SecondarySidebar>
        </div>
        <section className="flex min-w-0 flex-1 flex-col">
          <EditorFrame composer={composer} results={<TakesPanel mode="design" />}>
            <Button
              variant="ghost"
              disabled={generation.isGenerating || designProfiles.length === 0}
              aria-label={t('cloneFlow.change_voice')}
              className="h-12 w-fit max-w-full shrink-0 justify-start gap-2.5 px-0 hover:bg-transparent"
              onClick={() => {
                // The saved voices live in the controls, which focus mode hides.
                setEditorFocus(false);
                const control = savedProfilesRef.current;
                if (!control) return;
                control.open = true;
                requestAnimationFrame(() => {
                  control.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                  });
                  control.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
                });
              }}
            >
              {activeProfile ? (
                <ProfileAvatar name={activeProfile.name} imageUrl={activeProfile.image_url} />
              ) : (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary ring-1 ring-foreground/15">
                  <WandSparklesIcon className="size-4" />
                </span>
              )}
              <span className="shrink-0 font-normal text-muted-foreground">
                {t('clone.voice_kicker')} <span aria-hidden="true">·</span>
              </span>
              <span className="max-w-60 truncate font-semibold">
                {activeProfile?.name ?? t('nav.design')}
              </span>
              {designProfiles.length > 0 && <ChevronDownIcon className="text-muted-foreground" />}
            </Button>
            <DemoPresets
              initialOpen={!draft.text.trim()}
              disabled={generation.isGenerating}
              onUse={(preset) => {
                mapper.cancel();
                setDraft((current) =>
                  replaceRecipe(current, {
                    text: preset.script || current.text,
                    attrs: mergeDescribedAttrs(preset.attrs),
                  }),
                );
                setCloneSetting('language', preset.language || 'Auto');
              }}
            />
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <label htmlFor="design-script" className="text-sm font-medium">
                {t('clone.text_label')}
              </label>
              <div className="flex flex-wrap items-center justify-end gap-1">
                <ScriptInsertMenu menu={insert} setText={setScript} />
                <FocusToggle />
              </div>
            </div>
            <ScriptEditorFrame className="min-h-32" text={draft.text} speed={speed}>
              {(textStyle) => (
                <ScriptTagTools
                  menu={insert}
                  setText={setScript}
                  className="flex min-h-24 flex-1 flex-col"
                >
                  <MarkupTextarea
                    id="design-script"
                    data-gate-target={SYNTHESIS_TARGET.designScript}
                    textareaRef={scriptRef}
                    className="min-h-24 flex-1"
                    textClassName="px-4 py-3 text-base leading-7 placeholder:text-muted-foreground"
                    textStyle={textStyle}
                    value={draft.text}
                    unsupported={SCRIPT_UNSUPPORTED_TAGS}
                    placeholder={t('clone.prompt_placeholder')}
                    onValueChange={(text) => {
                      insert.close();
                      setScript(text);
                    }}
                    onKeyDown={insert.onEditorKeyDown}
                  />
                </ScriptTagTools>
              )}
            </ScriptEditorFrame>
          </EditorFrame>
        </section>
        {/* Hidden, not unmounted, in focus mode: a profile edit keeps its
            unsaved name and clip until Esc. */}
        <div hidden={focused} className="contents">
          {editingProfile && (
            <WorkspacePane
              layout="editor"
              title={t('paneActions.edit')}
              icon={PencilIcon}
              onClose={() => setEditingId(null)}
            >
              <EditProfile
                key={editingProfile.id}
                profile={editingProfile}
                onDone={() => setEditingId(null)}
              />
            </WorkspacePane>
          )}
          {!editingProfile && selectedTake?.mode === 'design' && (
            <WorkspacePane
              title={t('clone.history_title')}
              icon={HistoryIcon}
              onClose={() => openTake(null)}
            >
              <TakeDetails item={selectedTake} />
            </WorkspacePane>
          )}
        </div>
      </div>
    </div>
  );
}
