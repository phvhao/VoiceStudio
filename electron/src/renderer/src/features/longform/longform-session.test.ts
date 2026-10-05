import { beforeEach, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiFetch: fetchMock }));
import {
  editLongform,
  longformSession,
  renderLongform,
  renderBody,
  chapterPreviewBody,
  clearLongformDraftForReset,
  stopLongform,
} from './longform-session';
const eventResponse = (events: object[]) =>
  new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
beforeEach(() => {
  fetchMock.mockReset();
  editLongform('audiobook', { script: 'Hello', voice: 'voice', output: 'old.m4b' });
});
it('preserves the last output when the stream ends without completion', async () => {
  fetchMock.mockResolvedValue(eventResponse([{ type: 'started', chapters: 2 }]));
  await renderLongform('audiobook');
  expect(longformSession.state.error).toContain('before completion');
  expect(longformSession.state.drafts.audiobook.output).toBe('old.m4b');
  expect(longformSession.state.active).toBeNull();
});
it('resumes a manifest without submitting edited script and accepts only terminal output', async () => {
  fetchMock.mockResolvedValue(
    eventResponse([
      { type: 'started', chapters: 1 },
      { type: 'chapter', index: 0 },
      { type: 'done', output: 'new.m4b', failed_chapters: [0] },
    ]),
  );
  await renderLongform('audiobook', 'manifest');
  expect(fetchMock.mock.calls[0][0]).toBe('/audiobook/resume/manifest');
  expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  expect(longformSession.state.drafts.audiobook.output).toBe('new.m4b');
  expect(longformSession.state.failed).toBe(1);
});
it('keeps the exact chapter milliseconds the cue sheet needs', async () => {
  fetchMock.mockResolvedValue(
    eventResponse([
      { type: 'started', chapters: 3 },
      { type: 'chapter', index: 0, title: 'One', duration_s: 60, duration_ms: 59996 },
      { type: 'chapter_error', index: 1, title: 'Two', error: 'boom' },
      { type: 'chapter', index: 2, title: 'Three', duration_s: 1.5, cached: true },
      { type: 'done', output: 'new.m4b', failed_chapters: [1] },
    ]),
  );
  await renderLongform('audiobook');
  expect(longformSession.state.drafts.audiobook.outputChapters).toEqual([
    { title: 'One', status: 'done', duration_s: 60, duration_ms: 59996 },
    { title: 'Two', status: 'failed', error: 'boom' },
    { title: 'Three', status: 'cached', duration_s: 1.5 },
  ]);
});
it('stop aborts the network request and blocks duplicate renders', async () => {
  fetchMock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () =>
          reject(new DOMException('Stopped', 'AbortError')),
        ),
      ),
  );
  const running = renderLongform('audiobook');
  await renderLongform('stories');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  stopLongform();
  await running;
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(longformSession.state.error).toBeNull();
});
it('compiles Stories through the shared chapter and pause parser', () => {
  const draft = {
    ...longformSession.state.drafts.stories,
    voice: 'narrator',
    lines: [
      { id: '1', text: '# Opening', profileId: null },
      { id: '2', text: 'Hello [pause 0.5s]', profileId: 'actor' },
    ],
  };
  const body = renderBody('stories', draft);
  expect(body).toMatchObject({
    default_voice: 'narrator',
    chapters: [
      { title: 'Opening', spans: [{ voice_id: 'actor', text: 'Hello', pause_ms_after: 500 }] },
    ],
  });
});

it('passes book identity and pronunciation to audiobook and shared output options to Stories', () => {
  const draft = {
    ...longformSession.state.drafts.audiobook,
    title: 'Book',
    metadata: { author: 'Writer' },
    loudness: 'acx' as const,
    cover: { path: '/covers/fixture.png', name: 'cover.png' },
    lexicon: [{ word: ' SQL ', pronunciation: ' sequel ' }],
  };
  expect(renderBody('audiobook', draft)).toMatchObject({
    metadata: { title: 'Book', author: 'Writer' },
    loudness: 'acx',
    cover_path: '/covers/fixture.png',
    lexicon: { SQL: 'sequel' },
  });
  expect(renderBody('stories', draft)).not.toHaveProperty('lexicon');
});

it('only sends cast assignments used by the current script', () => {
  const draft = {
    ...longformSession.state.drafts.audiobook,
    script: '[voice:Mara] Hello [voice:] Goodbye',
    voiceCast: { Mara: 'actor', Removed: 'old-profile' },
  };
  expect(renderBody('audiobook', draft)).toMatchObject({ voice_map: { Mara: 'actor' } });
});

it('treats object-property names as ordinary unmapped cast names', () => {
  const draft = {
    ...longformSession.state.drafts.audiobook,
    script: '[voice:constructor] Hello [voice:__proto__] Goodbye',
    voiceCast: {},
  };
  expect(renderBody('audiobook', draft)).toHaveProperty('voice_map', {});
});

it('chapter preview uses the same synthesis inputs as the full book', () => {
  const draft = {
    ...longformSession.state.drafts.audiobook,
    script: '[voice:Mara] SQL',
    voiceCast: { Mara: 'actor' },
    language: 'English',
    lexicon: [{ word: 'SQL', pronunciation: 'sequel' }],
  };
  const full = renderBody('audiobook', draft);
  const preview = chapterPreviewBody(draft, 2);
  expect(preview).toMatchObject({
    chapter_index: 2,
    text: draft.script,
    voice_map: full.voice_map,
    default_voice: full.default_voice,
    language: full.language,
    lexicon: { SQL: 'sequel' },
  });
  expect(preview).not.toHaveProperty('cover_path');
});

it('sends identical explicit production overrides to preview and full render', () => {
  const draft = {
    ...longformSession.state.drafts.audiobook,
    overrides: {
      ...longformSession.state.drafts.audiobook.overrides,
      numStep: 24,
      seed: 0,
      postprocess: false,
      varyRepeats: true,
    },
  };
  for (const body of [
    renderBody('audiobook', draft),
    chapterPreviewBody(draft, 0),
    renderBody('stories', draft),
  ]) {
    expect(body).toMatchObject({
      num_step: 24,
      seed: 0,
      postprocess_output: false,
      vary_repeats: true,
    });
  }
});

it('seamless-join gaps reach preview and full render only once touched', () => {
  const base = longformSession.state.drafts.audiobook;
  for (const body of [renderBody('audiobook', base), chapterPreviewBody(base, 0)]) {
    expect(body).not.toHaveProperty('line_gap_ms');
    expect(body).not.toHaveProperty('trim_edges');
  }
  const draft = {
    ...base,
    overrides: { ...base.overrides, lineGapMs: 0, paragraphGapMs: 900, trimEdges: false },
  };
  for (const body of [renderBody('audiobook', draft), chapterPreviewBody(draft, 0)]) {
    expect(body).toMatchObject({ line_gap_ms: 0, paragraph_gap_ms: 900, trim_edges: false });
  }
});

it('evens out the voices of preview and full render alike unless turned off', () => {
  const base = longformSession.state.drafts.audiobook;
  for (const body of [renderBody('audiobook', base), chapterPreviewBody(base, 0)])
    expect(body).toMatchObject({ level_voices: true });
  const off = { ...base, overrides: { ...base.overrides, levelVoices: false } };
  for (const body of [renderBody('audiobook', off), chapterPreviewBody(off, 0)])
    expect(body).not.toHaveProperty('level_voices');
});

it('sends the volume of each voice the script uses, and nothing untouched', () => {
  const base = longformSession.state.drafts.audiobook;
  const untouched = { ...base, script: '[voice:Mara] Hi', voiceGains: {} };
  for (const body of [renderBody('audiobook', untouched), chapterPreviewBody(untouched, 0)])
    expect(body).not.toHaveProperty('voice_gains');
  const draft = {
    ...base,
    script: 'Intro [voice:Mara] Hi [voice:default] Back',
    voiceCast: { Mara: 'actor' },
    voiceGains: { '': -2, Mara: 3, Removed: 6 },
  };
  const full = renderBody('audiobook', draft);
  expect(full.voice_gains).toEqual({ '': -2, Mara: 3 });
  expect(chapterPreviewBody(draft, 0).voice_gains).toEqual(full.voice_gains);
  const story = {
    ...draft,
    lines: [{ id: '1', text: '[voice:Mara] Hi', profileId: null }],
  };
  expect(renderBody('stories', story).voice_gains).toEqual({ '': -2, Mara: 3 });
});

it('does not recreate a cleared draft during pagehide persistence', async () => {
  editLongform('stories', { script: 'Must stay deleted' });
  localStorage.setItem('voicestudio.longform.v1', 'old');
  clearLongformDraftForReset();
  window.dispatchEvent(new Event('pagehide'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(localStorage.getItem('voicestudio.longform.v1')).toBeNull();
});

it('restores drafts saved before voice volumes and leveling existed', async () => {
  localStorage.setItem(
    'voicestudio.longform.v1',
    JSON.stringify({
      audiobook: { script: 'Hi', lines: [], overrides: { numStep: 24 }, voiceCast: {} },
      stories: { script: '', lines: [], voiceGains: { Mara: 3, '': 'loud', Cole: 99 } },
    }),
  );
  vi.resetModules();
  try {
    const restored = await import('./longform-session');
    const { audiobook, stories } = restored.longformSession.state.drafts;
    expect(audiobook.voiceGains).toEqual({});
    expect(audiobook.overrides).toMatchObject({ numStep: 24, levelVoices: true });
    expect(restored.renderBody('audiobook', audiobook)).toMatchObject({ level_voices: true });
    expect(stories.voiceGains).toEqual({ Mara: 3, Cole: 12 });
  } finally {
    localStorage.removeItem('voicestudio.longform.v1');
  }
});
