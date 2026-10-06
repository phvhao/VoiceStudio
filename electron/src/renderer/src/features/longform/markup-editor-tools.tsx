import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  MarkupAutocomplete,
  SUGGESTION_GROUPS,
  useMarkupAutocomplete,
} from './markup-autocomplete';
import { MarkupContextMenu } from './markup-context-menu';
import { MarkupEditorContext, type MarkupEditorEvents } from './markup-editor-context';
import { MarkupTagCard, type TagActivation, type TagToolProps } from './markup-tag-card';

/**
 * What makes the tags of a script editor interactive: the right-click menu
 * around it, the card a clicked tag opens (or Alt+Enter on it), and the
 * suggestions shown while a tag is typed after `[`. Wrap a `MarkupTextarea`
 * in it; the textarea finds the tools through `MarkupEditorContext`. With
 * `unsupported`, a page offers only the markup it reads (Clone and Voice
 * Design: pauses, reactions and respellings).
 */
export function MarkupEditorTools({
  children,
  disabled,
  onChapter,
  onListen,
  otherPopupOpen = false,
  onOpen,
  className,
  ...tools
}: TagToolProps & {
  children: ReactNode;
  disabled: boolean;
  /** Replaces inserting a `# Chapter` heading into the text. */
  onChapter?(): void;
  /** Audition the passage at the caret. */
  onListen?(): void;
  /** A popup of the page's own is open at the editor (an Insert menu): the card makes way. */
  otherPopupOpen?: boolean;
  /** The card, the menu or the suggestions opened: the page puts its own popups away. */
  onOpen?(): void;
  className?: string;
}) {
  const [card, setCard] = useState<TagActivation | null>(null);
  if ((disabled || otherPopupOpen) && card) setCard(null);
  const activations = useRef(0);
  const { unsupported } = tools;
  const groups = useMemo(
    () => unsupported && SUGGESTION_GROUPS.filter((group) => !unsupported.includes(group)),
    [unsupported],
  );
  const suggestions = useMarkupAutocomplete({
    ...tools,
    groups,
    disabled,
    // One popup at a time: typing a new tag puts the card away.
    onOpen: () => {
      setCard(null);
      onOpen?.();
    },
  });
  // The editor calls these between renders: they read the latest state.
  const latest = useRef({ card, suggestions, onOpen });
  useLayoutEffect(() => {
    latest.current = { card, suggestions, onOpen };
  });
  const events = useMemo<MarkupEditorEvents>(
    () => ({
      onTokenActivate(token, handle, via) {
        latest.current.suggestions.close();
        latest.current.onOpen?.();
        setCard({ token, handle, via, id: ++activations.current });
      },
      onEditorKeyDown: (event, handle) => latest.current.suggestions.onKeyDown(event, handle),
      onEditorChange(handle, reason) {
        const open = latest.current.card;
        // The card points at a tag in place: scrolling the tag away, or
        // typing that changes it, leaves it nothing to describe.
        if (
          open?.handle === handle &&
          (reason === 'scroll' ||
            (reason === 'input' &&
              handle.element.value.slice(open.token.start, open.token.end) !== open.token.text))
        )
          setCard(null);
        latest.current.suggestions.onChange(handle, reason);
      },
      textareaAria: suggestions.aria,
    }),
    [suggestions.aria],
  );
  return (
    <>
      <MarkupContextMenu
        {...tools}
        disabled={disabled}
        onChapter={onChapter}
        onListen={onListen}
        className={className}
        onOpenChange={(open) => {
          if (!open) return;
          setCard(null);
          suggestions.close();
          onOpen?.();
        }}
      >
        <MarkupEditorContext.Provider value={events}>{children}</MarkupEditorContext.Provider>
      </MarkupContextMenu>
      {/* Outside the menu's trigger, so a right-click in a popup is not one in
          the editor; right after it, so Tab and Shift+Tab move between the
          editor and the card. */}
      <MarkupTagCard {...tools} activation={card} onClose={() => setCard(null)} />
      <MarkupAutocomplete suggestions={suggestions} voices={tools.voices ?? tools.scriptNames} />
    </>
  );
}
