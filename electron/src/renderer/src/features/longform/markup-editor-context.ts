import { createContext, type AriaAttributes, type KeyboardEvent } from 'react';
import type { MarkupToken } from './script-markup';

/** What a popup can be anchored to (Floating UI's virtual element). */
export interface VirtualAnchor {
  getBoundingClientRect(): DOMRect;
  contextElement?: Element;
}

/** A script editor, as the tools around it (tag card, suggestions) see it. */
export interface MarkupEditorHandle {
  element: HTMLTextAreaElement;
  /** Whether an IME composition (Vietnamese Telex, CJK) is in progress. */
  readonly composing: boolean;
  /** Viewport rect of text offset range (collapsed → caret rect), null without layout. */
  rectAt(start: number, end?: number): DOMRect | null;
  /** A live anchor for popups at `start…end` (re-measures on every call). */
  anchorAt(start: number, end?: number): VirtualAnchor;
}

/**
 * What the tools around a script editor hear from it. Offsets are positions
 * in `handle.element.value`.
 */
export interface MarkupEditorEvents {
  /** A tag was clicked, or Alt+Enter was pressed with the caret touching it. */
  onTokenActivate?(
    token: MarkupToken,
    handle: MarkupEditorHandle,
    via: 'pointer' | 'keyboard',
  ): void;
  /** Return true to consume the key (the textarea then calls preventDefault). */
  onEditorKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>, handle: MarkupEditorHandle): boolean;
  /**
   * After input, selection change, click, focus, and scroll ('scroll' reason).
   * 'input' follows every change of the text once the editor has rendered it,
   * including changes that were not typed (an undo, a loaded project).
   */
  onEditorChange?(handle: MarkupEditorHandle, reason: 'input' | 'caret' | 'scroll' | 'blur'): void;
  /**
   * Picture files were dropped on the editor (`at`: the start of the line
   * they landed on) or pasted into it (`at`: the caret). Without it the
   * editor ignores them, as on pages that show no pictures.
   */
  onImageFiles?(files: File[], at: number, handle: MarkupEditorHandle): void;
  /** ARIA state for the textarea while a popup listens to it (a suggestion list). */
  textareaAria?: Pick<
    AriaAttributes,
    | 'aria-activedescendant'
    | 'aria-autocomplete'
    | 'aria-controls'
    | 'aria-expanded'
    | 'aria-haspopup'
  >;
}

export const MarkupEditorContext = createContext<MarkupEditorEvents | null>(null);
