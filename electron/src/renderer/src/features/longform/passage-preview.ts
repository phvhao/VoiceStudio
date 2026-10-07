import { useEffect, useRef, useState } from 'react';
import { describeError } from '@/lib/api/client';
import type { PublicFailure } from '@/lib/api/failure';
import { beginAppActivity } from '@/lib/app-activity';
import { queryClient } from '@/lib/query';
import {
  chapterPreviewBody,
  recognizerMissing,
  suspectPhrases,
  uncheckedPhrases,
  type Draft,
  type PassageContext,
} from './longform-session';
import { PreviewFailure, requestPreview, type PreviewLock } from './preview-run';
import type { TakeProgress } from './take-progress';

/** No phrase the speech check could not listen to. */
const ALL_HEARD = { unchecked: 0, noRecognizer: false };

/**
 * Audition a passage of the manuscript on the chapter-preview endpoint: the
 * passage is sent as a one-chapter script with the book's voices, cast,
 * lexicon and production settings, so it sounds as it will in the render,
 * and with where it is read (`passageContext`): read sentence by sentence,
 * its takes are the book's own there — a repeated sentence the repeat it
 * is, a retake the one asked for. Once it renders, the Contents rail counts
 * again what its chapters have left to render.
 *
 * It renders under the page's preview lock (`previews`): one preview at a
 * time, the editor open meanwhile. Its progress is heard as it renders, and
 * Stop ends the render on the backend after the take in progress.
 */
export function usePassagePreview(draft: Draft, previews: PreviewLock) {
  const [output, setOutput] = useState<string | null>(null);
  // What the speech check (when on) still heard differently in this passage,
  // and how many of its phrases it could not listen to (and whether that was
  // for want of a speech recognizer).
  const [suspects, setSuspects] = useState<string[]>([]);
  const [unheard, setUnheard] = useState(ALL_HEARD);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<PublicFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<TakeProgress | null>(null);
  // The caret sat somewhere with nothing to speak (a heading, a lone tag).
  const [empty, setEmpty] = useState(false);
  const controller = useRef<AbortController | null>(null);
  // Another book opened (or the page left): its passage is not this book's.
  useEffect(() => {
    setOutput(null);
    setError(null);
    setFailure(null);
    setSuspects([]);
    setUnheard(ALL_HEARD);
    return () => controller.current?.abort();
  }, [draft.projectId]);
  const preview = async (passage: string | null, context: PassageContext | null = null) => {
    if (controller.current) return;
    setEmpty(!passage);
    if (!passage) {
      setOutput(null);
      setError(null);
      setFailure(null);
      return;
    }
    if (!previews.acquire('passage')) return;
    const current = new AbortController();
    controller.current = current;
    const finishActivity = beginAppActivity('synthesis');
    setPending(true);
    setProgress(null);
    setError(null);
    setFailure(null);
    setOutput(null);
    setSuspects([]);
    setUnheard(ALL_HEARD);
    try {
      const result = await requestPreview(
        {
          ...chapterPreviewBody({ ...draft, script: passage }, 0),
          ...(context ? { context } : {}),
        },
        {
          signal: current.signal,
          onProgress: (heard) => {
            if (!current.signal.aborted) setProgress(heard);
          },
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
      if (!current.signal.aborted) {
        setError(describeError(cause));
        setFailure(cause instanceof PreviewFailure ? cause.failure : null);
      }
    } finally {
      finishActivity();
      // Takes it rendered before a Stop are cached too.
      void queryClient.invalidateQueries({ queryKey: ['audiobook-outline'] });
      if (controller.current === current) {
        controller.current = null;
        setPending(false);
        setProgress(null);
        previews.release();
      }
    }
  };
  return {
    output,
    error,
    failure,
    pending,
    progress,
    empty,
    suspects,
    unchecked: unheard.unchecked,
    noRecognizer: unheard.noRecognizer,
    preview,
    stop: () => controller.current?.abort(),
    dismiss: () => {
      setOutput(null);
      setError(null);
      setFailure(null);
      setEmpty(false);
      setSuspects([]);
      setUnheard(ALL_HEARD);
    },
  };
}
