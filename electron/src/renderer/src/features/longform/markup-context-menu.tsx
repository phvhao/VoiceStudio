import { useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import {
  AudioLinesIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  CopyIcon,
  HeadingIcon,
  PauseIcon,
  PencilLineIcon,
  PlayIcon,
  RotateCcwIcon,
  ScissorsIcon,
  SmileIcon,
  SpeechIcon,
  TextSelectIcon,
  Trash2Icon,
  UserRoundIcon,
  Volume2Icon,
  WandSparklesIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MAX_VOICE_GAIN_DB } from '@shared/utils/longformOverrides';
import { useVoiceGainText } from './cast-settings';
import { applyMarkupEdit, castProfileVoice } from './markup-toolbar';
import {
  DELIVERY_LABELS,
  ResetDot,
  VoiceDot,
  expressionGroupLabel,
  tagActions,
  type TagActions,
  type TagProfile,
  type TagToolProps,
} from './markup-tag-card';
import {
  DELIVERY_TAGS,
  PAUSE_PRESETS,
  VOICE_RESET_TOKEN,
  applyVoice,
  countHeadings,
  deliveryKind,
  expressionGroups,
  expressionVariant,
  formatPauseSeconds,
  insertChapter,
  insertToken,
  pauseToken,
  pronounceSelection,
  replaceRange,
  tokenAt,
  wrapSelection,
  type DeliveryTag,
  type MarkupEdit,
  type MarkupToken,
} from './script-markup';
import { voiceAccent } from './voice-palette';

const POPUP =
  'z-50 max-h-[min(70vh,28rem)] min-w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none';
const ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
const SEPARATOR = 'my-1 h-px bg-border';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

function Item({
  icon,
  label,
  hint,
  disabled,
  closeOnClick,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
  /** `false` keeps the menu open, for a step taken again and again (louder, louder). */
  closeOnClick?: boolean;
  onClick: () => void;
}) {
  return (
    <ContextMenu.Item
      className={ITEM}
      disabled={disabled}
      closeOnClick={closeOnClick}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </ContextMenu.Item>
  );
}

/** One option of a radio group; the current one is checked. */
function Choice({ value, icon, label }: { value: string; icon?: ReactNode; label: ReactNode }) {
  return (
    <ContextMenu.RadioItem value={value} closeOnClick className={ITEM}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ContextMenu.RadioItemIndicator className="flex">
        <CheckIcon />
      </ContextMenu.RadioItemIndicator>
    </ContextMenu.RadioItem>
  );
}

function Submenu({
  icon,
  label,
  hint,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  /** The current value, shown before the arrow. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className={ITEM}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint && <span className="max-w-32 truncate text-xs text-muted-foreground">{hint}</span>}
        <ChevronRightIcon />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50" sideOffset={4}>
          <ContextMenu.Popup className={POPUP}>{children}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}

/** The script's voices, then the profiles (cast under a readable name when chosen). */
function VoiceItems({
  tools,
  choose,
  chooseProfile,
}: {
  tools: TagToolProps;
  choose(name: string): void;
  chooseProfile(profile: TagProfile): void;
}) {
  const { profiles, scriptNames } = tools;
  const voices = tools.voices ?? scriptNames;
  return (
    <>
      {scriptNames.map((name) => (
        <Item
          key={`name-${name}`}
          icon={<VoiceDot className={voiceAccent(name, voices).dot} />}
          // Older Stories scripts put a profile id in the tag.
          label={profiles.find((profile) => profile.id === name)?.name ?? name}
          onClick={() => choose(name)}
        />
      ))}
      {scriptNames.length > 0 && profiles.length > 0 && (
        <ContextMenu.Separator className={SEPARATOR} />
      )}
      {profiles.map((profile) => (
        <Item key={profile.id} label={profile.name} onClick={() => chooseProfile(profile)} />
      ))}
    </>
  );
}

function PauseItems({ choose }: { choose(ms: number): void }) {
  const { t } = useTranslation();
  return PAUSE_PRESETS.map((preset) => (
    <Item
      key={preset.id}
      label={t(`markup.pause_${preset.id}`)}
      hint={formatPauseSeconds(preset.ms)}
      onClick={() => choose(preset.ms)}
    />
  ));
}

function ExpressionItems({ choose }: { choose(tag: string): void }) {
  const { t } = useTranslation();
  return expressionGroups().map((group) => {
    const label = t(expressionGroupLabel(group.key));
    return group.tags.length === 1 ? (
      <Item
        key={group.key}
        label={label}
        hint={group.tags[0]}
        onClick={() => choose(group.tags[0])}
      />
    ) : (
      <Submenu key={group.key} icon={<SmileIcon />} label={label}>
        {group.tags.map((tag) => (
          <Item
            key={tag}
            label={expressionVariant(tag) || tag}
            hint={tag}
            onClick={() => choose(tag)}
          />
        ))}
      </Submenu>
    );
  });
}

/** A voice's volume in 1 dB steps, the menu kept open between them. */
function VolumeSubmenu({
  gain,
  setGain,
}: Pick<TagActions, 'gain'> & { setGain(db: number): void }) {
  const { t } = useTranslation();
  const gainText = useVoiceGainText();
  return (
    <Submenu icon={<Volume2Icon />} label={t('leveling.volume')} hint={gainText(gain)}>
      <Item
        label={t('editor.louder')}
        hint={gainText(1)}
        closeOnClick={false}
        disabled={gain >= MAX_VOICE_GAIN_DB}
        onClick={() => setGain(gain + 1)}
      />
      <Item
        label={t('editor.quieter')}
        hint={gainText(-1)}
        closeOnClick={false}
        disabled={gain <= -MAX_VOICE_GAIN_DB}
        onClick={() => setGain(gain - 1)}
      />
      <Item
        icon={<RotateCcwIcon />}
        label={t('editor.volume_reset')}
        disabled={gain === 0}
        onClick={() => setGain(0)}
      />
    </Submenu>
  );
}

/** What the tag card offers for the right-clicked tag, as menu items. */
function TagItems({ token, tools }: { token: MarkupToken; tools: TagToolProps }) {
  const { t } = useTranslation();
  const { profiles, scriptNames, defaultVoiceName, lineVoices = false } = tools;
  const voices = tools.voices ?? scriptNames;
  const act = tagActions(tools, token);
  const { name, setGain } = act;
  const profileName = (id: string) => profiles.find((profile) => profile.id === id)?.name;
  const section = name === null ? null : act.section();
  const reads = section !== null && section[0] < section[1];
  const kind = deliveryKind(token.text);
  // A voice tag has its voice's volume; `[voice:]` the default voice's, except
  // in Stories, where it returns to each line's own voice.
  const volume = token.kind === 'voice' || (token.kind === 'voiceReset' && !lineVoices);
  return (
    <>
      <p className="flex min-w-0 items-center gap-1.5 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        {name !== null && <VoiceDot className={voiceAccent(name, voices).dot} />}
        {token.kind === 'voiceReset' && <ResetDot />}
        <span className="truncate">{token.text}</span>
      </p>
      {token.kind === 'pause' && (
        <Submenu icon={<PauseIcon />} label={t('context.change_pause')}>
          <PauseItems choose={act.setPause} />
        </Submenu>
      )}
      {(token.kind === 'voice' || token.kind === 'voiceReset') && (
        <Submenu icon={<AudioLinesIcon />} label={t('context.change_voice')}>
          <VoiceItems tools={tools} choose={act.switchTo} chooseProfile={act.switchToProfile} />
          {name !== null && (
            <>
              <ContextMenu.Separator className={SEPARATOR} />
              <Item
                icon={<RotateCcwIcon />}
                label={t('markup.voice_reset')}
                onClick={() => act.switchTo(null)}
              />
            </>
          )}
        </Submenu>
      )}
      {name !== null && (
        <Submenu
          icon={<UserRoundIcon />}
          label={t('editor.read_by')}
          hint={
            act.castTo
              ? (profileName(act.castTo) ?? t('modelSettings.unavailable'))
              : (profileName(name) ?? t('audiobook.default_voice'))
          }
        >
          <ContextMenu.RadioGroup
            value={act.castTo}
            onValueChange={(profileId: string) => act.cast(profileId)}
          >
            <Choice
              value=""
              icon={<ResetDot />}
              label={
                defaultVoiceName
                  ? t('editor.status_default', { name: defaultVoiceName })
                  : t('editor.status_default_none')
              }
            />
            {profiles.map((profile) => (
              <Choice key={profile.id} value={profile.id} label={profile.name} />
            ))}
          </ContextMenu.RadioGroup>
        </Submenu>
      )}
      {volume && setGain && <VolumeSubmenu gain={act.gain} setGain={setGain} />}
      {name !== null && act.listen && (
        <Item
          icon={<PlayIcon />}
          label={t('editor.listen_part')}
          disabled={!reads}
          onClick={act.listen}
        />
      )}
      {name !== null && (
        <Item
          icon={<TextSelectIcon />}
          label={t('editor.select_part')}
          disabled={!reads}
          onClick={act.selectSection}
        />
      )}
      {token.kind === 'expression' && (
        <Submenu icon={<SmileIcon />} label={t('context.change_sound')}>
          <ExpressionItems choose={act.replace} />
        </Submenu>
      )}
      {kind && (
        <Submenu
          icon={<WandSparklesIcon />}
          label={t('editor.change_delivery')}
          hint={t(DELIVERY_LABELS[kind])}
        >
          <ContextMenu.RadioGroup
            value={kind}
            onValueChange={(next: DeliveryTag) => {
              if (next !== kind) act.setDelivery(next);
            }}
          >
            {DELIVERY_TAGS.map((tag) => (
              <Choice key={tag} value={tag} label={t(DELIVERY_LABELS[tag])} />
            ))}
          </ContextMenu.RadioGroup>
        </Submenu>
      )}
      {token.kind === 'pronunciation' && (
        <Item
          icon={<PencilLineIcon />}
          label={t('context.edit_respelling')}
          onClick={act.selectRespelling}
        />
      )}
      <Item
        icon={<Trash2Icon />}
        label={
          token.kind === 'delivery'
            ? t('context.remove_markup')
            : token.kind === 'pronunciation'
              ? t('context.keep_word')
              : t('context.remove_tag')
        }
        onClick={act.remove}
      />
      <ContextMenu.Separator className={SEPARATOR} />
    </>
  );
}

/**
 * Right-click menu for a script editor: the usual cut/copy/paste, every
 * markup the toolbar inserts, and — when the click lands on a tag — what the
 * tag card offers for it, in menu form. Chromium moves the caret to the
 * clicked spot before the menu opens, so the caret says what was clicked.
 */
export function MarkupContextMenu({
  children,
  disabled,
  onChapter,
  onListen,
  onOpenChange,
  className,
  ...tools
}: TagToolProps & {
  children: ReactNode;
  disabled: boolean;
  /** Replaces inserting a `# Chapter` heading into the text. */
  onChapter?(): void;
  /** Audition the passage at the caret. */
  onListen?(): void;
  onOpenChange?(open: boolean): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { getTarget, headings = false, voiceCast, onVoiceCast } = tools;
  const [token, setToken] = useState<MarkupToken | null>(null);
  const [selection, setSelection] = useState(false);
  const capture = () => {
    const element = getTarget()?.element;
    if (!element) return;
    setSelection(element.selectionStart !== element.selectionEnd);
    setToken(
      element.selectionStart === element.selectionEnd
        ? tokenAt(element.value, element.selectionStart, { headings })
        : null,
    );
  };
  const run = (make: (value: string, start: number, end: number) => MarkupEdit) => {
    const target = getTarget();
    if (target) applyMarkupEdit(target, make);
  };
  const selectedText = () => {
    const element = getTarget()?.element;
    return element ? element.value.slice(element.selectionStart, element.selectionEnd) : '';
  };
  const copy = () => void navigator.clipboard?.writeText(selectedText());
  const cut = () => {
    void navigator.clipboard?.writeText(selectedText());
    run((value, start, end) => replaceRange(value, start, end, ''));
  };
  const paste = () =>
    void navigator.clipboard
      ?.readText()
      .then((clip) => run((value, start, end) => replaceRange(value, start, end, clip)));
  const selectAll = () => {
    const element = getTarget()?.element;
    element?.focus();
    element?.select();
  };

  if (disabled) return <div className={className}>{children}</div>;
  return (
    <ContextMenu.Root onOpenChange={(open) => onOpenChange?.(open)}>
      <ContextMenu.Trigger className={className} onContextMenu={capture}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className={POPUP} finalFocus={() => getTarget()?.element ?? true}>
            {token && <TagItems token={token} tools={tools} />}
            <Item
              icon={<ScissorsIcon />}
              label={t('context.cut')}
              hint={shortcut('X')}
              disabled={!selection}
              onClick={cut}
            />
            <Item
              icon={<CopyIcon />}
              label={t('context.copy')}
              hint={shortcut('C')}
              disabled={!selection}
              onClick={copy}
            />
            <Item
              icon={<ClipboardPasteIcon />}
              label={t('context.paste')}
              hint={shortcut('V')}
              onClick={paste}
            />
            <Item
              icon={<TextSelectIcon />}
              label={t('context.select_all')}
              hint={shortcut('A')}
              onClick={selectAll}
            />
            <ContextMenu.Separator className={SEPARATOR} />
            <Submenu icon={<PauseIcon />} label={t('audiobook.insert_pause')}>
              <PauseItems
                choose={(ms) =>
                  run((value, start, end) => insertToken(value, start, end, pauseToken(ms)))
                }
              />
            </Submenu>
            <Submenu icon={<AudioLinesIcon />} label={t('audiobook.insert_voice')}>
              <VoiceItems
                tools={tools}
                choose={(name) => run((value, start, end) => applyVoice(value, start, end, name))}
                chooseProfile={(profile) =>
                  run((value, start, end) =>
                    applyVoice(
                      value,
                      start,
                      end,
                      castProfileVoice(profile, voiceCast, onVoiceCast),
                    ),
                  )
                }
              />
              <ContextMenu.Separator className={SEPARATOR} />
              <Item
                icon={<RotateCcwIcon />}
                label={t('markup.voice_reset')}
                onClick={() =>
                  run((value, start, end) => insertToken(value, start, end, VOICE_RESET_TOKEN))
                }
              />
            </Submenu>
            <Submenu icon={<WandSparklesIcon />} label={t('context.delivery')}>
              {DELIVERY_TAGS.map((tag) => (
                <Item
                  key={tag}
                  label={t(DELIVERY_LABELS[tag])}
                  hint={`[${tag}]`}
                  onClick={() =>
                    run((value, start, end) =>
                      wrapSelection(value, start, end, `[${tag}]`, `[/${tag}]`),
                    )
                  }
                />
              ))}
            </Submenu>
            <Item
              icon={<SpeechIcon />}
              label={t('markup.pronounce')}
              onClick={() => run(pronounceSelection)}
            />
            <Submenu icon={<SmileIcon />} label={t('audiobook.insert_reactions')}>
              <ExpressionItems
                choose={(tag) => run((value, start, end) => insertToken(value, start, end, tag))}
              />
            </Submenu>
            <Item
              icon={<HeadingIcon />}
              label={t('markup.chapter')}
              onClick={() =>
                onChapter
                  ? onChapter()
                  : run((value, start) =>
                      insertChapter(
                        value,
                        start,
                        t('stories.chapterN', { n: countHeadings(value) + 1 }),
                      ),
                    )
              }
            />
            {onListen && (
              <>
                <ContextMenu.Separator className={SEPARATOR} />
                <Item icon={<PlayIcon />} label={t('markup.preview')} onClick={onListen} />
              </>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
