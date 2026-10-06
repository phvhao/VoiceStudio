import { useEffect, useRef, useState } from 'react';
import { apiJson, describeError } from '@/lib/api/client';
import { beginAppActivity } from '@/lib/app-activity';
import {
  chapterPreviewBody,
  recognizerMissing,
  suspectPhrases,
  uncheckedPhrases,
  type Draft,
} from './longform-session';

/** No phrase the speech check could not listen to. */
const ALL_HEARD = { unchecked: 0, noRecognizer: false };

/**
 * Audition a passage of the manuscript on the chapter-preview endpoint: the
 * passage is sent as a one-chapter script with the book's voices, cast,
 * lexicon and production settings, so it sounds as it will in the render.
 */
export function usePassagePreview(draft: Draft, onBusy: (busy: boolean) => void) {
  const [output, setOutput] = useState<string | null>(null);
  // What the speech check (when on) still heard differently in this passage,
  // and how many of its phrases it could not listen to (and whether that was
  // for want of a speech recognizer).
  const [suspects, setSuspects] = useState<string[]>([]);
  const [unheard, setUnheard] = useState(ALL_HEARD);
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
    setSuspects([]);
    setUnheard(ALL_HEARD);
    try {
      const result = await apiJson<{ output: string; speech_check?: unknown }>(
        '/audiobook/preview',
        {
          method: 'POST',
          body: JSON.stringify(chapterPreviewBody({ ...draft, script: passage }, 0)),
          signal: current.signal,
        },
      );
      if (!current.signal.aborted) {
        setOutput(result.output);
        setSuspects(suspectPhrases(result));
        setUnheard({
          unchecked: uncheckedPhrases(result),
          noRecognizer: recognizerMissing(result),
        });
      }
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
    suspects,
    unchecked: unheard.unchecked,
    noRecognizer: unheard.noRecognizer,
    preview,
    stop: () => controller.current?.abort(),
    dismiss: () => {
      setOutput(null);
      setError(null);
      setEmpty(false);
      setSuspects([]);
      setUnheard(ALL_HEARD);
    },
  };
}
