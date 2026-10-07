import { afterEach, expect, it, vi } from 'vitest';
import { apiJson } from '@/lib/api/client';
import { consumeTaskStream } from '@/lib/api/event-stream';
import {
  dubSession,
  dubTimingChanged,
  editDubSegment,
  generateDub,
  mergeDubSegment,
  omissionFor,
  redoDubEdit,
  translateDub,
  translateDubWithAgent,
  undoDubEdit,
  type DubOmission,
  type DubSegment,
} from './dub-session';
import { translationActivity } from './translation-activity';

vi.mock('@/lib/api/client', async (load) => ({
  ...(await load<typeof import('@/lib/api/client')>()),
  apiJson: vi.fn(),
}));
vi.mock('@/lib/api/event-stream', async (load) => ({
  ...(await load<typeof import('@/lib/api/event-stream')>()),
  consumeTaskStream: vi.fn(),
}));

const SHORT: DubOmission = {
  reason: 'short',
  ratio: 0.42,
  source_sentences: 2,
  target_sentences: 1,
};
const SOURCE = 'You forget as much as you learn. But what do you forget?';

function load(segments: DubSegment[]) {
  dubSession.setState((current) => ({
    ...current,
    jobId: 'fit-job',
    phase: 'editing',
    recovery: null,
    sourceLang: 'en',
    quality: 'fast',
    agentCli: undefined,
    segments,
  }));
}

afterEach(() => {
  vi.mocked(apiJson).mockReset();
  delete (window as Partial<Window>).voicestudio;
});

it('translates one flagged row again with the literal pass and keeps the flag per language', async () => {
  load([
    { id: 'a', start: 0, end: 4, text: SOURCE, text_original: SOURCE },
    { id: 'b', start: 4, end: 6, text: 'Hello there.', text_original: 'Hello there.' },
  ]);
  vi.mocked(apiJson)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({
      translated: [
        { id: 'a', text: 'Nhưng bạn quên gì?', omission: SHORT },
        { id: 'b', text: 'Xin chào.' },
      ],
    });
  await expect(translateDub('vi', 'nllb')).resolves.toBe(true);
  const [first, second] = dubSession.state.segments;
  expect(first.omissions).toEqual({ vi: SHORT });
  expect(omissionFor(first, 'vi')).toEqual(SHORT);
  expect(second.omissions).toBeUndefined();

  vi.mocked(apiJson)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({
      translated: [{ id: 'a', text: 'Bạn quên nhiều như bạn học. Nhưng bạn quên gì?' }],
    });
  await expect(
    translateDub('vi', 'nllb', { segmentIds: ['a'], retryIncomplete: true }),
  ).resolves.toBe(true);
  const request = JSON.parse(vi.mocked(apiJson).mock.calls.at(-1)![1]!.body as string);
  expect(request.retry_incomplete).toBe(true);
  expect(request.segments.map((segment: { id: string }) => segment.id)).toEqual(['a']);
  expect(dubSession.state.segments[0]).toMatchObject({
    text: 'Bạn quên nhiều như bạn học. Nhưng bạn quên gì?',
    omissions: undefined,
  });
  // The untouched row keeps its translation.
  expect(dubSession.state.segments[1].text).toBe('Xin chào.');
});

it('a failed retranslation keeps the previous text and its flag', async () => {
  load([
    {
      id: 'a',
      start: 0,
      end: 4,
      text: 'Nhưng bạn quên gì?',
      text_original: SOURCE,
      translations: { vi: 'Nhưng bạn quên gì?' },
      omissions: { vi: SHORT },
    },
  ]);
  vi.mocked(apiJson)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({ translated: [{ id: 'a', text: SOURCE, error: 'offline' }] });
  await translateDub('vi', 'google', { segmentIds: ['a'], retryIncomplete: true });
  expect(dubSession.state.segments[0]).toMatchObject({
    text: 'Nhưng bạn quên gì?',
    omissions: { vi: SHORT },
  });
});

it('editing a flagged translation clears only that language, and merging clears all', () => {
  load([
    {
      id: 'a',
      start: 0,
      end: 4,
      text: 'Nhưng bạn quên gì?',
      text_original: SOURCE,
      translations: { vi: 'Nhưng bạn quên gì?', fr: 'Mais quoi ?' },
      omissions: { vi: SHORT, fr: SHORT },
    },
    { id: 'b', start: 4, end: 6, text: 'Xin chào.', text_original: 'Hello.' },
  ]);
  editDubSegment('a', {
    text: 'Bạn quên nhiều như bạn học. Nhưng bạn quên gì?',
    translations: { vi: 'Bạn quên nhiều như bạn học. Nhưng bạn quên gì?', fr: 'Mais quoi ?' },
  });
  expect(dubSession.state.segments[0].omissions).toEqual({ fr: SHORT });
  // The row no longer shows the French text, so no French flag is shown either.
  expect(omissionFor(dubSession.state.segments[0], 'fr')).toBeUndefined();
  mergeDubSegment('a');
  expect(dubSession.state.segments[0].omissions).toBeUndefined();
});

it('sends the video override and never-speed-up flag with Smart Fit generation', async () => {
  load([
    {
      id: 'a',
      start: 0,
      end: 4,
      text: 'Nhưng bạn quên gì?',
      text_original: SOURCE,
      translations: { vi: 'Nhưng bạn quên gì?' },
      omissions: { vi: SHORT },
      video_fit: 'shrink',
    },
    {
      id: 'b',
      start: 4,
      end: 6,
      text: 'Xin chào.',
      text_original: 'Hello.',
      translations: { vi: 'Xin chào.' },
      video_fit: 'faster' as never, // a value restored from elsewhere
    },
  ]);
  dubSession.setState((current) => ({ ...current, timingStrategy: 'smart_fit' }));
  vi.mocked(apiJson).mockResolvedValueOnce({ task_id: 'fit-task' });
  vi.mocked(consumeTaskStream).mockImplementationOnce(async (_path, emit) => {
    emit({
      type: 'done',
      tracks: ['vi'],
      fit_status: [
        { status: 'audio_slowed', audio_rate: 0.85 },
        { status: 'video_shrunk', audio_rate: 0.9, video_ratio: 0.85 },
      ],
    });
  });
  await generateDub('Vietnamese', 'vi');
  const request = JSON.parse(vi.mocked(apiJson).mock.calls[0][1]!.body as string);
  expect(request.segments[0]).toMatchObject({ video_fit: 'shrink', may_be_incomplete: true });
  expect(request.segments[1].video_fit).toBeUndefined();
  expect(request.segments[1].may_be_incomplete).toBeUndefined();
  expect(dubSession.state.segments[1].fit_status).toEqual({
    status: 'video_shrunk',
    audio_rate: 0.9,
    video_ratio: 0.85,
  });
});

it('checks Translate with Agent rows for omissions too', async () => {
  const translate = vi.fn(async (request: { segments: Array<{ id: string }> }) => ({
    agent: 'codex',
    translations: request.segments.map((segment) => ({
      id: segment.id,
      text: 'Nhưng bạn quên gì?',
    })),
  }));
  Object.defineProperty(window, 'voicestudio', {
    configurable: true,
    value: {
      repair: { translate, stopTranslation: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Window['voicestudio'],
  });
  load([
    { id: 'a', start: 0, end: 4, text: SOURCE, text_original: SOURCE },
    { id: 'b', start: 4, end: 6, text: 'Hello.', text_original: 'Hello.' },
  ]);
  vi.mocked(apiJson)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({ omissions: { a: SHORT } });
  await expect(
    translateDubWithAgent('vi', 'codex', 'Vietnamese', { segmentIds: ['a'] }),
  ).resolves.toBe(true);
  expect(translate.mock.calls[0][0].segments.map((segment) => segment.id)).toEqual(['a']);
  const [path, init] = vi.mocked(apiJson).mock.calls[1];
  expect(path).toBe('/dub/translation-check');
  expect(JSON.parse(init!.body as string)).toMatchObject({
    job_id: 'fit-job',
    target_lang: 'vi',
    rows: [{ id: 'a', source: SOURCE, text: 'Nhưng bạn quên gì?' }],
  });
  expect(dubSession.state.segments[0].omissions).toEqual({ vi: SHORT });
  expect(dubSession.state.segments[1].text).toBe('Hello.');
});

it("Retry after a failed one-line Translate again retries that line, literally, never the whole transcript", async () => {
  load([
    {
      id: 'a',
      start: 0,
      end: 4,
      text: 'Nhưng bạn quên gì?',
      text_original: SOURCE,
      translations: { vi: 'Nhưng bạn quên gì?' },
      omissions: { vi: SHORT },
    },
    {
      id: 'b',
      start: 4,
      end: 6,
      text: 'Xin chào bạn.',
      text_original: 'Hello there.',
      translations: { vi: 'Xin chào bạn.' },
    },
  ]);
  // The backend was restarting: the request itself failed, so no row says why.
  vi.mocked(apiJson).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'));
  await translateDub('vi', 'google', { segmentIds: ['a'], retryIncomplete: true });
  const run = translationActivity.state.runs.at(-1)!;
  expect(run.status).toBe('failed');

  vi.mocked(apiJson)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({ translated: [{ id: 'a', text: 'Bạn quên gì? Bạn học gì?' }] });
  await run.retry!();
  const request = JSON.parse(vi.mocked(apiJson).mock.calls.at(-1)![1]!.body as string);
  expect(request.segments.map((segment: { id: string }) => segment.id)).toEqual(['a']);
  expect(request.retry_incomplete).toBe(true);
  // The hand-made translation of the other line is untouched.
  expect(dubSession.state.segments[1].text).toBe('Xin chào bạn.');
});

it('Translate again on one line is one edit Undo takes back, and earlier edits keep their Undo', async () => {
  load([
    {
      id: 'a',
      start: 0,
      end: 4,
      text: 'Nhưng bạn quên gì?',
      text_original: SOURCE,
      translations: { vi: 'Nhưng bạn quên gì?' },
      omissions: { vi: SHORT },
    },
    {
      id: 'b',
      start: 4,
      end: 6,
      text: 'Xin chào.',
      text_original: 'Hello there.',
      translations: { vi: 'Xin chào.' },
    },
  ]);
  editDubSegment('b', { text: 'Xin chào bạn.', translations: { vi: 'Xin chào bạn.' } });
  vi.mocked(apiJson)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({ translated: [{ id: 'a', text: 'Bạn quên gì? Bạn học gì?' }] });
  await translateDub('vi', 'nllb', { segmentIds: ['a'], retryIncomplete: true });
  expect(dubSession.state.segments[0].text).toBe('Bạn quên gì? Bạn học gì?');

  undoDubEdit();
  expect(dubSession.state.segments[0]).toMatchObject({
    text: 'Nhưng bạn quên gì?',
    omissions: { vi: SHORT },
  });
  expect(dubSession.state.segments[1].text).toBe('Xin chào bạn.');
  undoDubEdit();
  expect(dubSession.state.segments[1].text).toBe('Xin chào.');
  redoDubEdit();
  redoDubEdit();
  expect(dubSession.state.segments[0].text).toBe('Bạn quên gì? Bạn học gì?');
});

it('a line whose video timing changed after a render is re-fitted without new speech', async () => {
  load([
    { id: 'a', start: 0, end: 4, text: 'Một.', text_original: 'One.', translations: { vi: 'Một.' } },
    { id: 'b', start: 4, end: 6, text: 'Hai.', text_original: 'Two.', translations: { vi: 'Hai.' } },
  ]);
  dubSession.setState((current) => ({
    ...current,
    inputType: 'video',
    timingStrategy: 'smart_fit',
    timingByLang: undefined,
  }));
  const render = () => {
    vi.mocked(apiJson).mockResolvedValueOnce({ task_id: 'fit-task' });
    vi.mocked(consumeTaskStream).mockImplementationOnce(async (_path, emit) => {
      emit({ type: 'done', tracks: ['vi'], language_code: 'vi', seg_hashes: { a: '1', b: '2' } });
    });
  };
  render();
  await generateDub('Vietnamese', 'vi');
  expect(dubTimingChanged(dubSession.state, 'vi')).toBe(false);

  editDubSegment('a', { video_fit: 'keep' });
  // Nothing about its speech changed, only where its video goes.
  expect(dubTimingChanged(dubSession.state, 'vi')).toBe(true);
  render();
  await generateDub('Vietnamese', 'vi', { regenOnly: [] });
  const request = JSON.parse(vi.mocked(apiJson).mock.calls.at(-1)![1]!.body as string);
  expect(request.regen_only).toEqual([]);
  expect(request.segments[0].video_fit).toBe('keep');
  expect(dubTimingChanged(dubSession.state, 'vi')).toBe(false);

  // So does a change of the timing mode itself.
  dubSession.setState((current) => ({ ...current, timingStrategy: 'concise' }));
  expect(dubTimingChanged(dubSession.state, 'vi')).toBe(true);
  // An audio file has no picture: a line's video choice is no timing change there.
  dubSession.setState((current) => ({ ...current, inputType: 'audio', timingStrategy: 'smart_fit' }));
  render();
  await generateDub('Vietnamese', 'vi', { regenOnly: [] });
  editDubSegment('b', { video_fit: 'stretch' });
  expect(dubTimingChanged(dubSession.state, 'vi')).toBe(false);
});
