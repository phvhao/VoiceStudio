import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@/i18n';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiFetch: fetchMock }));
import { queryClient } from '@/lib/query';
import { refreshRenderSettingsDependents } from '@/lib/render-settings';
import { GenerationProgress, TakeProgressText, renderTimeLeft } from './generation-progress';
import { takeProgress, type TakeProgress } from './take-progress';
import {
  editLongform,
  longformSession,
  outlineQueryKey,
  outlineRequest,
  renderLongform,
  type AudiobookRenderChapter,
  type RenderTiming,
} from './longform-session';

const chapters = (...statuses: string[]): AudiobookRenderChapter[] =>
  statuses.map((status) => ({ title: '', status }));
const timing = (finishedAt: (number | null)[], more: Partial<RenderTiming> = {}): RenderTiming => ({
  startedAt: 0,
  finishedAt,
  words: null,
  cached: null,
  ...more,
});

describe('the time a render has left', () => {
  it('leaves cached chapters out and counts down from the last chapter', () => {
    // A resume: five chapters come from the cache at once, five render 150 s each.
    const cachedAt = [30, 60, 90, 120, 150];
    const first = chapters(
      ...cachedAt.map(() => 'cached'),
      'rendering',
      ...Array(4).fill('pending'),
    );
    const at = timing([...cachedAt, ...Array(5).fill(null)]);
    // Instant chapters say nothing about the time the others take.
    expect(renderTimeLeft(first, at, 60_000)).toBeNull();

    const sixth = chapters(
      ...cachedAt.map(() => 'cached'),
      'done',
      'rendering',
      'pending',
      'pending',
      'pending',
    );
    const after = timing([...cachedAt, 150_150, null, null, null, null]);
    expect(renderTimeLeft(sixth, after, 150_150)).toBe(600);
    // While the next chapter renders, the time left only goes down.
    expect(renderTimeLeft(sixth, after, 180_150)).toBe(570);
    expect(renderTimeLeft(sixth, after, 900_000)).toBe(0);
  });

  it('skips the chapters the outline found cached before the render started', () => {
    // Chapters 1 and 5 were edited; the other eight come from the cache.
    const cached = [false, true, true, true, false, true, true, true, true, true];
    const now = chapters(
      'done',
      'cached',
      'cached',
      'cached',
      'rendering',
      ...Array(5).fill('pending'),
    );
    const at = timing([100_000, 100_030, 100_060, 100_090, ...Array(6).fill(null)], { cached });
    expect(renderTimeLeft(now, at, 100_090)).toBe(100);
    // Not knowing which are cached, every chapter left counts.
    expect(renderTimeLeft(now, { ...at, cached: null }, 100_090)).toBe(600);
  });

  it('weighs the chapters left by their words', () => {
    // A fixed half and a half by words: 100, 100 and 300 words weigh 0.8, 0.8 and 1.4.
    const words = [100, 100, 300];
    const at = timing([60_000, null, null], { words });
    expect(renderTimeLeft(chapters('done', 'rendering', 'pending'), at, 60_000)).toBeCloseTo(165);
    expect(
      renderTimeLeft(chapters('done', 'rendering', 'pending'), { ...at, words: null }, 60_000),
    ).toBe(120);
  });

  const takes = (more: Partial<TakeProgress>): TakeProgress => ({
    index: 0,
    phase: 'rendering',
    done: 0,
    total: 0,
    phrases: true,
    rate: null,
    at: 0,
    ...more,
  });

  it('times a one-chapter book from its takes, counted down between them', () => {
    // 10 of 40 takes done at 6 s each, heard at 70 s: 180 s left then.
    const progress = takes({ done: 10, total: 40, rate: 6, at: 70_000 });
    const one = timing([null], { progress });
    expect(renderTimeLeft(chapters('rendering'), one, 70_000)).toBe(180);
    expect(renderTimeLeft(chapters('rendering'), one, 100_000)).toBe(150);
    // Before a take is timed, or while the model loads, nothing tells it.
    expect(
      renderTimeLeft(chapters('rendering'), timing([null], { progress: takes({ total: 40 }) }), 0),
    ).toBeNull();
    expect(
      renderTimeLeft(
        chapters('rendering'),
        timing([null], { progress: takes({ phase: 'loading' }) }),
        0,
      ),
    ).toBeNull();
  });

  it('times the chapters after it at its pace until one has rendered, then at theirs', () => {
    // Equal chapters; the first is a quarter done 60 s in, 180 s from its end.
    const progress = takes({ done: 10, total: 40, rate: 6, at: 60_000 });
    const first = timing([null, null, null], { progress });
    expect(renderTimeLeft(chapters('rendering', 'pending', 'pending'), first, 60_000)).toBe(
      180 + 2 * 240,
    );
    // Chapter one took 100 s: the other chapter after the second takes as long.
    const second = timing([100_000, null, null], {
      progress: takes({ index: 1, done: 5, total: 10, rate: 10, at: 130_000 }),
    });
    expect(renderTimeLeft(chapters('done', 'rendering', 'pending'), second, 130_000)).toBe(
      50 + 100,
    );
    // A cached chapter takes no time; the takes of a finished chapter tell
    // nothing more: the chapters' own pace times the rest.
    const cached = timing([100_000, null, null], {
      cached: [false, false, true],
      progress: takes({ index: 1, done: 5, total: 10, rate: 10, at: 130_000 }),
    });
    expect(renderTimeLeft(chapters('done', 'rendering', 'pending'), cached, 130_000)).toBe(50);
    const stale = timing([100_000, null], { progress: takes({ done: 5, total: 10, rate: 10 }) });
    expect(renderTimeLeft(chapters('done', 'rendering'), stale, 130_000)).toBe(70);
  });

  it('reads a progress event, and refuses one it cannot read', () => {
    expect(
      takeProgress(
        {
          type: 'progress',
          index: 2,
          phase: 'rendering',
          done: 3,
          total: 9,
          rate: 4.5,
          phrases: true,
        },
        7,
      ),
    ).toEqual({ index: 2, phase: 'rendering', done: 3, total: 9, phrases: true, rate: 4.5, at: 7 });
    expect(takeProgress({ type: 'progress', index: 0, phase: 'queued' }, 1)).toMatchObject({
      phase: 'queued',
      done: 0,
      total: 0,
      rate: null,
    });
    // A count that ran past its estimate grows the total with it.
    expect(takeProgress({ phase: 'rendering', done: 5, total: 4 }, 0)?.total).toBe(5);
    expect(takeProgress({ phase: 'mystery' }, 0)).toBeNull();
    expect(takeProgress({ phase: 'rendering', done: -1, rate: Infinity }, 0)).toMatchObject({
      done: 0,
      rate: null,
    });
  });

  it('tells nothing before a chapter has rendered, or once nothing is left', () => {
    expect(
      renderTimeLeft(chapters('rendering', 'pending'), timing([null, null]), 5_000),
    ).toBeNull();
    expect(
      renderTimeLeft(chapters('failed', 'rendering'), timing([4_000, null]), 5_000),
    ).toBeNull();
    expect(
      renderTimeLeft(
        chapters('done', 'pending'),
        timing([4_000, null], { cached: [false, true] }),
        5_000,
      ),
    ).toBeNull();
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows the time since the render started and the time left', () => {
  vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
  // Mounted two minutes into the render (the page was left and opened again).
  render(
    <GenerationProgress
      chapters={chapters('done', 'rendering', 'pending')}
      assembling={false}
      timing={timing([940_000, null, null], { startedAt: 880_000 })}
    />,
  );
  expect(screen.getByText('2:00 · ~1:00 left')).toBeVisible();
});

it('says how far the chapter rendering now is, and moves the bar inside it', () => {
  vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
  const progress = {
    index: 1,
    phase: 'rendering' as const,
    done: 3,
    total: 4,
    phrases: true,
    rate: 5,
    at: 1_000_000,
  };
  render(
    <GenerationProgress
      chapters={chapters('done', 'rendering')}
      assembling={false}
      timing={timing([940_000, null], { startedAt: 880_000, progress })}
    />,
  );
  expect(screen.getByText('3 of 4 sentences', { exact: false })).toBeVisible();
  // One chapter done, three quarters of the second: 88 %.
  expect(document.querySelector<HTMLElement>('[style]')!.style.width).toBe('88%');
});

it('names what a chapter waits for, and its takes with the time they have left', () => {
  vi.spyOn(performance, 'now').mockReturnValue(10_000);
  const base = { index: 0, done: 0, total: 0, phrases: true, rate: null, at: 10_000 };
  const view = render(<TakeProgressText progress={{ ...base, phase: 'loading' }} />);
  expect(screen.getByText('Loading the voice model…')).toBeVisible();
  view.rerender(<TakeProgressText progress={{ ...base, phase: 'queued' }} />);
  expect(screen.getByText('Waiting for another job to finish…')).toBeVisible();
  view.rerender(
    <TakeProgressText
      timeLeft
      progress={{ ...base, phase: 'rendering', done: 1, total: 1, rate: 2, phrases: false }}
    />,
  );
  expect(screen.getByText('1 of 1 part · ~0:00 left')).toBeVisible();
  view.rerender(
    <TakeProgressText
      timeLeft
      progress={{ ...base, phase: 'rendering', done: 2, total: 12, rate: 5 }}
    />,
  );
  expect(screen.getByText('2 of 12 sentences · ~0:50 left')).toBeVisible();
});

describe('a render keeps its clock', () => {
  const eventResponse = (events: object[]) =>
    new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  beforeEach(() => fetchMock.mockReset());

  it('with the words of each chapter and the ones the outline found cached', async () => {
    editLongform('audiobook', {
      script: '# One\nHello there.\n# Two\nA much longer chapter with seven words.\n# Three\nEnd.',
      voice: 'voice',
      output: 'old.m4b',
    });
    const draft = longformSession.state.drafts.audiobook;
    queryClient.setQueryData(outlineQueryKey(JSON.stringify(outlineRequest(draft))), {
      chapters: [{ cached: false }, { cached: true }, { cached: null }],
      book: true,
    });
    fetchMock.mockResolvedValue(
      eventResponse([
        { type: 'started', chapters: 3 },
        { type: 'chapter', index: 0, title: 'One' },
        { type: 'chapter', index: 1, title: 'Two', cached: true },
        { type: 'chapter', index: 2, title: 'Three' },
        { type: 'done', output: 'new.m4b', failed_chapters: [] },
      ]),
    );
    await renderLongform('audiobook');
    const clock = longformSession.state.timing!;
    expect(clock.words).toEqual([2, 7, 1]);
    expect(clock.cached).toEqual([false, true, null]);
    expect(clock.finishedAt.every((at) => at !== null && at >= clock.startedAt)).toBe(true);
  });

  it('without the cached chapters of an outline a settings change is asking again', async () => {
    editLongform('audiobook', {
      script: '# One\nHello there.\n# Two\nGoodbye now.',
      voice: 'voice',
      output: 'old.m4b',
    });
    const draft = longformSession.state.drafts.audiobook;
    queryClient.setQueryData(outlineQueryKey(JSON.stringify(outlineRequest(draft))), {
      chapters: [{ cached: true }, { cached: true }],
      book: true,
    });
    // The performance preset changed: the chapters' keys hold its steps, so
    // both render again although the outline's last answer had them cached.
    await refreshRenderSettingsDependents(queryClient);
    fetchMock.mockResolvedValue(
      eventResponse([
        { type: 'started', chapters: 2 },
        { type: 'chapter', index: 0, title: 'One' },
        { type: 'chapter', index: 1, title: 'Two' },
        { type: 'done', output: 'new.m4b', failed_chapters: [] },
      ]),
    );
    await renderLongform('audiobook');
    expect(longformSession.state.timing).toMatchObject({ words: [2, 2], cached: null });
  });

  it('counts a story by its lines, and knows neither for a resume', async () => {
    editLongform('stories', {
      voice: 'voice',
      lines: [
        { id: '1', text: '# Opening', profileId: null },
        { id: '2', text: 'One two three.', profileId: null },
        { id: '3', text: '# Next', profileId: null },
        { id: '4', text: 'Four five.', profileId: null },
      ],
    });
    const story = [
      { type: 'started', chapters: 2 },
      { type: 'chapter', index: 0 },
      { type: 'chapter', index: 1 },
      { type: 'done', output: 'story.wav', failed_chapters: [] },
    ];
    fetchMock.mockResolvedValue(eventResponse(story));
    await renderLongform('stories');
    expect(longformSession.state.timing).toMatchObject({ words: [3, 2], cached: null });

    fetchMock.mockResolvedValue(eventResponse(story));
    await renderLongform('stories', 'manifest');
    expect(longformSession.state.timing).toMatchObject({ words: null, cached: null });
  });

  it('with the last word on the chapter rendering now', async () => {
    editLongform('audiobook', { script: '# One\nHello there.', voice: 'voice' });
    fetchMock.mockResolvedValue(
      eventResponse([
        { type: 'started', chapters: 1 },
        { type: 'progress', index: 0, phase: 'loading' },
        {
          type: 'progress',
          index: 0,
          phase: 'rendering',
          done: 2,
          total: 5,
          rate: 4,
          phrases: true,
        },
        // Not a chapter of this render: ignored.
        { type: 'progress', index: 3, phase: 'rendering', done: 1, total: 1 },
        { type: 'done', output: 'one.m4b', failed_chapters: [] },
      ]),
    );
    await renderLongform('audiobook');
    expect(longformSession.state.timing?.progress).toMatchObject({
      index: 0,
      phase: 'rendering',
      done: 2,
      total: 5,
      rate: 4,
    });
  });
});
