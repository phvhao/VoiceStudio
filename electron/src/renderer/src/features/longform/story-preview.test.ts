import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiJson: api, apiFetch: vi.fn() }));
import { exportStoryAudio } from '@shared/utils/storyExport';
import { queryClient } from '@/lib/query';
import { linePreviewKey, storyChunkBody, storySteps } from './story-preview';
import { blankLongformDraft } from './longform-session';
afterEach(() => {
  vi.unstubAllGlobals();
  api.mockReset();
  queryClient.clear();
});

it('reads a line at the steps the story renders at, not at a fixed 32', async () => {
  const draft = blankLongformDraft();
  // The performance preset's steps, as the steps slider shows them.
  api.mockResolvedValue({ num_step: 16 });
  expect(await storySteps(draft)).toBe(16);
  expect(api).toHaveBeenCalledWith('/audiobook/sampling', expect.anything());
  expect(storyChunkBody(draft, 'Hello', null, null, [], 16).get('num_step')).toBe('16');
  // An engine that keeps its own steps is sent none.
  queryClient.clear();
  api.mockResolvedValue({ num_step: null });
  expect(await storySteps(draft)).toBeNull();
  expect(storyChunkBody(draft, 'Hello', null, null, [], null).has('num_step')).toBe(false);
  // The draft's own steps win, without asking.
  api.mockClear();
  const own = { ...draft, overrides: { ...draft.overrides, numStep: 48 } };
  expect(await storySteps(own)).toBe(48);
  expect(api).not.toHaveBeenCalled();
  // Unreadable: a book's steps without a preset.
  queryClient.clear();
  api.mockRejectedValue(new Error('offline'));
  expect(await storySteps(draft)).toBe(32);
});

it('dates a line audition by its own line and the settings, not by another line', () => {
  const lines = [
    { id: 'a', text: 'Hello.', profileId: null },
    { id: 'b', text: 'Again.', profileId: null },
  ];
  const draft = { ...blankLongformDraft(), voice: 'narrator', lines };
  const key = linePreviewKey(draft, lines[0]);
  const typed = { ...draft, lines: [lines[0], { ...lines[1], text: 'Again and again.' }] };
  expect(linePreviewKey(typed, typed.lines[0])).toBe(key);
  expect(linePreviewKey(draft, { ...lines[0], text: 'Hello there.' })).not.toBe(key);
  expect(linePreviewKey({ ...draft, voice: 'other' }, lines[0])).not.toBe(key);
  // Its pictures change no audio.
  expect(linePreviewKey(draft, { ...lines[0], text: '[image: a.jpg] Hello.' })).toBe(key);
});
it('assembles canonical voice, pause and speed spans for auditions', async () => {
  const close = vi.fn();
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 10;
      close = close;
      async decodeAudioData() {
        return { length: 10, getChannelData: () => new Float32Array(10) };
      }
    },
  );
  const chunks = vi.fn(
    async (_text: string, _voice: string | null, _speed: number | null) => new Blob(['audio']),
  );
  const result = await exportStoryAudio(
    [{ text: '[slow]Hello[/slow][pause 0.5s][voice:actor]Again' }],
    () => ({ profileId: 'narrator', speed: 1.2 }),
    chunks,
  );
  expect(chunks.mock.calls).toEqual([
    ['Hello', 'narrator', 0.85],
    ['Again', 'actor', 1.2],
  ]);
  expect(result.durationSec).toBe(2.5);
  expect(close).toHaveBeenCalledOnce();
});
it('reads no picture aloud and names no chapter after one', async () => {
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 10;
      async decodeAudioData() {
        return { length: 10, getChannelData: () => new Float32Array(10) };
      }
    },
  );
  const chunks = vi.fn(async (_text: string) => new Blob(['audio']));
  const result = await exportStoryAudio(
    [{ text: '# Chapter one [image: a.jpg]' }, { text: '[image: b.jpg] Hello there.' }],
    () => ({ profileId: 'narrator', speed: null }),
    chunks,
  );
  expect(result.chapters.map((chapter) => chapter.title)).toEqual(['Chapter one']);
  expect(chunks.mock.calls.map(([text]) => text)).toEqual(['Hello there.']);
});
it('preserves default longform steps and resolves named inline voices', () => {
  const draft = { ...blankLongformDraft(), voice: 'narrator', voiceCast: { Mara: 'actor' } };
  const body = storyChunkBody(draft, 'Hello', 'Mara', 0.8, [{ id: 'actor' }]);
  expect(body.get('profile_id')).toBe('actor');
  expect(body.get('num_step')).toBe('32');
  expect(body.get('speed')).toBe('0.8');
});

it('uses the full-render default for an unassigned inline name', () => {
  const draft = { ...blankLongformDraft(), voice: 'narrator' };
  expect(
    storyChunkBody(draft, 'Hello', 'Unassigned', null, [{ id: 'narrator' }]).get('profile_id'),
  ).toBe('narrator');
});
