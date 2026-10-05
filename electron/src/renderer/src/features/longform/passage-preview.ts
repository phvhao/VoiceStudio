import { useEffect, useRef, useState } from 'react';
import { apiJson, describeError } from '@/lib/api/client';
import { beginAppActivity } from '@/lib/app-activity';
import { chapterPreviewBody, type Draft } from './longform-session';

/**
 * Audition a passage of the manuscript on the chapter-preview endpoint: the
 * passage is sent as a one-chapter script with the book's voices, cast,
 * lexicon and production settings, so it sounds as it will in the render.
 */
export function usePassagePreview(draft: Draft, onBusy: (busy: boolean) => void) {
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The caret sat somewhere with nothing to speak (a heading, a lone tag).
  const [empty, setEmpty] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const preview = async (passage: string | null) => {
    if (controller.current) return;
    setEmpty(!passage);
    if (!passage) {
      setOutput(null);
      setError(null);
      return;
    }
    const current = new AbortController();
    controller.current = current;
    const finishActivity = beginAppActivity('synthesis');
    onBusy(true);
    setPending(true);
    setError(null);
    setOutput(null);
    try {
      const result = await apiJson<{ output: string }>('/audiobook/preview', {
        method: 'POST',
        body: JSON.stringify(chapterPreviewBody({ ...draft, script: passage }, 0)),
        signal: current.signal,
      });
      if (!current.signal.aborted) setOutput(result.output);
    } catch (cause) {
      if (!current.signal.aborted) setError(describeError(cause));
    } finally {
      finishActivity();
      if (controller.current === current) {
        controller.current = null;
        setPending(false);
        onBusy(false);
      }
    }
  };
  return {
    output,
    error,
    pending,
    empty,
    preview,
    stop: () => controller.current?.abort(),
    dismiss: () => {
      setOutput(null);
      setError(null);
      setEmpty(false);
    },
  };
}
