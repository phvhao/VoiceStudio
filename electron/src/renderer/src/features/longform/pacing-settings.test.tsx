import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import '@/i18n';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_PUNCTUATION_PAUSES,
  DEFAULT_READING,
  overridesToRequest,
} from '@shared/utils/longformOverrides';

const shared = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@/lib/reading-settings', async () => {
  const overrides = await import('@shared/utils/longformOverrides');
  return {
    useReadingSettings: () => ({
      reading: { ...overrides.DEFAULT_READING, verifySpeech: true },
      loaded: true,
      error: null,
      save: shared.save,
    }),
  };
});

import { ReadingForm } from '@/components/reading-settings';
import {
  blankLongformDraft,
  recognizerMissing,
  suspectPhrases,
  uncheckedPhrases,
} from './longform-session';
import { PacingSettings, SpeechCheckReport } from './pacing-settings';
import { storyChunkBody } from './story-preview';

it('follows Settings → Reading unless the project has its own', () => {
  // Only the flag: the server applies the app-wide setting.
  expect(overridesToRequest(DEFAULT_OVERRIDES, 'Auto')).toEqual({
    use_app_reading: true,
    level_voices: true,
  });
});

it('sends a project’s own reading explicitly, clamped, including "off"', () => {
  const reading = {
    phraseRendering: true,
    punctuationPauses: { comma: 80, sentence: 99999, colon: Number.NaN },
    splitCommas: true,
    verifySpeech: true,
  };
  expect(overridesToRequest({ ...DEFAULT_OVERRIDES, reading }, 'Auto')).toEqual({
    punctuation_pauses: { ...DEFAULT_PUNCTUATION_PAUSES, comma: 80, sentence: 5000 },
    split_commas: true,
    verify_speech: true,
    level_voices: true,
  });
  expect(
    overridesToRequest(
      { ...DEFAULT_OVERRIDES, reading: { ...reading, phraseRendering: false } },
      'Auto',
    ),
  ).toEqual({
    punctuation_pauses: null,
    split_commas: false,
    verify_speech: true,
    level_voices: true,
  });
});

it('summarises the app setting and copies it when the project takes its own', () => {
  const onChange = vi.fn();
  render(<PacingSettings value={DEFAULT_OVERRIDES} disabled={false} onChange={onChange} />);
  fireEvent.click(screen.getByText('Pauses & phrasing'));
  expect(
    screen.getByText('Sentence by sentence · 300 ms after a sentence · speech check on'),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'This project only' }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ reading: { ...DEFAULT_READING, verifySpeech: true } }),
  );
});

it('edits one mark, keeps the others at their defaults, and restores them', () => {
  const onChange = vi.fn();
  render(<ReadingForm value={DEFAULT_READING} disabled={false} onChange={onChange} />);
  const comma = screen.getByRole('spinbutton', { name: 'Comma' });
  expect(comma).toHaveValue(DEFAULT_PUNCTUATION_PAUSES.comma);
  fireEvent.change(comma, { target: { value: '400' } });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ punctuationPauses: { comma: 400 } }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Restore default pauses' }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ punctuationPauses: {}, splitCommas: false }),
  );
});

it('hides the pause table when sentence-by-sentence reading is off', () => {
  render(
    <ReadingForm
      value={{ ...DEFAULT_READING, phraseRendering: false }}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole('spinbutton', { name: 'Comma' })).toBeNull();
  expect(screen.getByText('Check the reading and redo mistakes')).toBeVisible();
});

it('sends a single-line preview the same reading as the book, as one field', () => {
  const own = { ...DEFAULT_READING, verifySpeech: true };
  const draft = { ...blankLongformDraft(), overrides: { ...DEFAULT_OVERRIDES, reading: own } };
  const body = storyChunkBody(draft, 'Hello.', null, null, []);
  expect(body.has('punctuation_pauses')).toBe(false);
  expect(JSON.parse(String(body.get('reading')))).toEqual({
    punctuation_pauses: DEFAULT_PUNCTUATION_PAUSES,
    split_commas: false,
    verify_speech: true,
  });
  const shared = storyChunkBody(blankLongformDraft(), 'Hello.', null, null, []);
  expect(shared.get('reading')).toBe('app');
  expect(shared.has('use_app_reading')).toBe(false);
});

it('reads the phrases a render still heard differently', () => {
  expect(
    suspectPhrases({ speech_check: { suspect: [{ text: 'Mùa Thu', score: 0.4 }, { text: 3 }] } }),
  ).toEqual(['Mùa Thu']);
  expect(suspectPhrases({})).toEqual([]);
  render(
    <SpeechCheckReport
      chapters={[
        { title: 'One', status: 'done' },
        { title: 'Two', status: 'done', suspects: ['Mùa Thu là vụ thu hoạch'] },
      ]}
    />,
  );
  expect(screen.getByText('Sentences to listen to again: 1')).toBeVisible();
  expect(screen.getByText(/Mùa Thu là vụ thu hoạch/)).toBeVisible();
});

it('says how many sentences the check could not listen to, and why', () => {
  expect(uncheckedPhrases({ speech_check: { unchecked: 3, suspect: [] } })).toBe(3);
  expect(uncheckedPhrases({ speech_check: { unchecked: '3' } })).toBe(0);
  expect(uncheckedPhrases({})).toBe(0);
  expect(recognizerMissing({ speech_check: { unchecked: 3, no_recognizer: true } })).toBe(true);
  // Older backends never said why: no install advice is made up for them.
  expect(recognizerMissing({ speech_check: { unchecked: 3, unavailable: true } })).toBe(false);
  const install = /No speech recognizer is installed/;
  const listen = /heard no words in them or could not run/;
  // No recognizer installed: install one; nothing to listen for.
  const { unmount } = render(
    <SpeechCheckReport
      chapters={[
        { title: 'One', status: 'done', unchecked: 2, noRecognizer: true },
        { title: 'Two', status: 'cached', unchecked: 3, noRecognizer: true },
      ]}
    />,
  );
  expect(screen.getByText('Sentences not checked: 5')).toBeVisible();
  expect(screen.getByText(install)).toBeVisible();
  expect(screen.queryByText(listen)).toBeNull();
  expect(screen.queryByText(/Sentences to listen to again/)).toBeNull();
  unmount();
  // A recognizer is installed and heard no words (a near-silent take): no
  // install advice, but where to listen.
  const heard = render(
    <SpeechCheckReport
      chapters={[
        { title: 'One', status: 'done' },
        { title: 'Two', status: 'cached', unchecked: 1 },
      ]}
    />,
  );
  expect(screen.getByText('Sentences not checked: 1')).toBeVisible();
  expect(screen.getByText(listen)).toBeVisible();
  expect(screen.getByText('Two · 1')).toBeVisible();
  expect(screen.queryByText(install)).toBeNull();
  heard.unmount();
  // A passage preview: its own count, beside what still sounded different.
  render(<SpeechCheckReport suspects={['The lamp held for forty years.']} unchecked={1} />);
  expect(screen.getByText('Sentences to listen to again: 1')).toBeVisible();
  expect(screen.getByText('Sentences not checked: 1')).toBeVisible();
  expect(screen.getByText(listen)).toBeVisible();
});
