import { useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import {
  AudioLinesIcon,
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
  WandSparklesIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { applyMarkupEdit, castProfileVoice, type MarkupTarget } from './markup-toolbar';
import {
  DELIVERY_TAGS,
  PAUSE_PRESETS,
  VOICE_RESET_TOKEN,
  applyVoice,
  countHeadings,
  expressionGroups,
  expressionVariant,
  formatPauseSeconds,
  insertChapter,
  insertToken,
  pauseToken,
  pronounceSelection,
  removeToken,
  replaceRange,
  respellingRange,
  tokenAt,
  voiceToken,
  wrapSelection,
  type MarkupEdit,
  type MarkupToken,
} from './script-markup';

type Profile = { id: string; name: string };

const POPUP =
  'z-50 max-h-[min(70vh,28rem)] min-w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none';
const ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
const SEPARATOR = 'my-1 h-px bg-border';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

const DELIVERY_LABELS = {
  slow: 'audiobook.insert_slow',
  fast: 'audiobook.insert_fast',
  emphasis: 'audiobook.insert_emphasis',
  spell: 'audiobook.insert_spell',
} as const;

function Item({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <ContextMenu.Item className={ITEM} disabled={disabled} onClick={onClick}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </ContextMenu.Item>
  );
}

function Submenu({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className={ITEM}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
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

/**
 * Right-click menu for a script editor: the usual cut/copy/paste, every
 * markup the toolbar inserts, and — when the click lands on a tag — changing
 * or removing that tag. Chromium moves the caret to the clicked spot before
 * the menu opens, so the caret says what was clicked.
 */
export function MarkupContextMenu({
  children,
  getTarget,
  disabled,
  profiles,
  scriptNames,
  voiceCast,
  onVoiceCast,
  onChapter,
  onListen,
  className,
}: {
  children: ReactNode;
  getTarget(): MarkupTarget | null;
  disabled: boolean;
  profiles: Profile[];
  scriptNames: string[];
  voiceCast: Record<string, string>;
  onVoiceCast(cast: Record<string, string>): void;
  /** Replaces inserting a `# Chapter` heading into the text. */
  onChapter?(): void;
  /** Audition the passage at the caret. */
  onListen?(): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [token, setToken] = useState<MarkupToken | null>(null);
  const [selection, setSelection] = useState(false);
  const capture = () => {
    const element = getTarget()?.element;
    if (!element) return;
    setSelection(element.selectionStart !== element.selectionEnd);
    setToken(
      element.selectionStart === element.selectionEnd
        ? tokenAt(element.value, element.selectionStart)
        : null,
    );
  };
  const run = (make: (value: string, start: number, end: number) => MarkupEdit) => {
    const target = getTarget();
    if (target) applyMarkupEdit(target, make);
  };
  // Edit the clicked tag only while it is still where it was.
  const onToken = (make: (value: string, token: MarkupToken) => MarkupEdit) => {
    const clicked = token;
    if (!clicked) return;
    run((value, start, end) =>
      value.slice(clicked.start, clicked.end) === clicked.text
        ? make(value, clicked)
        : replaceRange(value, start, end, value.slice(start, end), { select: true }),
    );
  };
  const replaceToken = (insert: string) =>
    onToken((value, clicked) => replaceRange(value, clicked.start, clicked.end, insert));
  const selectRespelling = () => {
    const target = getTarget();
    if (!target || !token) return;
    const [start, end] = respellingRange(token);
    requestAnimationFrame(() => {
      target.element.focus();
      target.element.setSelectionRange(start, end);
    });
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
  const voiceItems = (choose: (name: string) => void) => (
    <>
      {scriptNames.map((name) => (
        <Item
          key={`name-${name}`}
          label={profiles.find((profile) => profile.id === name)?.name ?? name}
          onClick={() => choose(name)}
        />
      ))}
      {scriptNames.length > 0 && profiles.length > 0 && (
        <ContextMenu.Separator className={SEPARATOR} />
      )}
      {profiles.map((profile) => (
        <Item
          key={profile.id}
          label={profile.name}
          onClick={() => choose(castProfileVoice(profile, voiceCast, onVoiceCast))}
        />
      ))}
    </>
  );
  const pauseItems = (choose: (ms: number) => void) =>
    PAUSE_PRESETS.map((preset) => (
      <Item
        key={preset.id}
        label={t(`markup.pause_${preset.id}`)}
        hint={formatPauseSeconds(preset.ms)}
        onClick={() => choose(preset.ms)}
      />
    ));
  const expressionItems = (choose: (tag: string) => void) =>
    expressionGroups().map((group) => {
      const label =
        group.key === 'other' ? t('audiobook.insert_reactions') : t(`stories.tones.${group.key}`);
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

  if (disabled) return <div className={className}>{children}</div>;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className={className} onContextMenu={capture}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className={POPUP} finalFocus={() => getTarget()?.element ?? true}>
            {token && (
              <>
                <p className="truncate px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {token.text}
                </p>
                {token.kind === 'pause' && (
                  <Submenu icon={<PauseIcon />} label={t('context.change_pause')}>
                    {pauseItems((ms) => replaceToken(pauseToken(ms)))}
                  </Submenu>
                )}
                {token.kind === 'voice' && (
                  <Submenu icon={<AudioLinesIcon />} label={t('context.change_voice')}>
                    {voiceItems((name) => replaceToken(voiceToken(name)))}
                  </Submenu>
                )}
                {token.kind === 'expression' && (
                  <Submenu icon={<SmileIcon />} label={t('context.change_sound')}>
                    {expressionItems((tag) => replaceToken(tag))}
                  </Submenu>
                )}
                {token.kind === 'pronunciation' && (
                  <Item
                    icon={<PencilLineIcon />}
                    label={t('context.edit_respelling')}
                    onClick={selectRespelling}
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
                  onClick={() => onToken(removeToken)}
                />
                <ContextMenu.Separator className={SEPARATOR} />
              </>
            )}
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
              {pauseItems((ms) =>
                run((value, start, end) => insertToken(value, start, end, pauseToken(ms))),
              )}
            </Submenu>
            <Submenu icon={<AudioLinesIcon />} label={t('audiobook.insert_voice')}>
              {voiceItems((name) =>
                run((value, start, end) => applyVoice(value, start, end, name)),
              )}
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
              {expressionItems((tag) =>
                run((value, start, end) => insertToken(value, start, end, tag)),
              )}
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
