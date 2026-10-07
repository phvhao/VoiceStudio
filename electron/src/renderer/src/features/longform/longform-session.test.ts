import { beforeEach, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiFetch: fetchMock }));
import {
  audiobookRetakeChapter,
  editLongform,
  longformSession,
  renderLongform,
  renderBody,
  chapterPreviewBody,
  outlineRequest,
  clearLongformDraftForReset,
  passageContext,
  stopLongform,
  storyRetakeChapter,
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
it('keeps no English stand-in title for a chapter the script left untitled', async () => {
  fetchMock.mockResolvedValue(
    eventResponse([
      { type: 'started', chapters: 3 },
      { type: 'chapter', index: 0, title: 'Chapter 1', untitled: true },
      { type: 'chapter', index: 1, title: 'Chapter 2' },
      { type: 'chapter_error', index: 2, title: 'Chapter 3', untitled: true, error: 'boom' },
      { type: 'done', output: 'new.m4b', failed_chapters: [2] },
    ]),
  );
  await renderLongform('audiobook');
  // A heading written "Chapter 2" is the user's own title, and stays.
  expect(longformSession.state.drafts.audiobook.outputChapters).toEqual([
    // Marked untitled: the lists name it ("Introduction", "Chapter N") in the app's language.
    { title: '', untitled: true, status: 'done' },
    { title: 'Chapter 2', status: 'done' },
    { title: '', untitled: true, status: 'failed', error: 'boom' },
  ]);
});
it('keeps what voice leveling measured in each chapter, for the Cast panel', async () => {
  fetchMock.mockResolvedValue(
    eventResponse([
      { type: 'started', chapters: 2 },
      {
        type: 'chapter',
        index: 0,
        title: 'One',
        levels: { '': { level_db: -26, auto_db: 6 }, Mara: { level_db: 'x', auto_db: 1 } },
      },
      { type: 'chapter', index: 1, title: 'Two', cached: true },
      { type: 'done', output: 'new.m4b', failed_chapters: [] },
    ]),
  );
  await renderLongform('audiobook');
  expect(longformSession.state.drafts.audiobook.outputChapters).toEqual([
    { title: 'One', status: 'done', levels: { '': { level_db: -26, auto_db: 6 } } },
    { title: 'Two', status: 'cached' },
  ]);
});
it('keeps the phrases to listen to when a chapter comes from the cache', async () => {
  // The speech check's result is kept with the chapter's audio: a cached
  // chapter reports the same phrases as the render that checked it.
  const check = {
    checked: 3,
    retaken: 2,
    unchecked: 0,
    suspect: [{ text: 'The lamp held.', score: 0.4 }],
  };
  fetchMock.mockResolvedValue(
    eventResponse([
      { type: 'started', chapters: 1 },
      { type: 'chapter', index: 0, title: 'One', cached: true, speech_check: check },
      { type: 'done', output: 'new.m4b', failed_chapters: [] },
    ]),
  );
  await renderLongform('audiobook');
  expect(longformSession.state.drafts.audiobook.outputChapters).toEqual([
    { title: 'One', status: 'cached', suspects: ['The lamp held.'] },
  ]);
});
it('keeps how many phrases the speech check could not listen to, and why', async () => {
  const check = { checked: 0, retaken: 0, unchecked: 4, suspect: [], unavailable: true };
  fetchMock.mockResolvedValue(
    eventResponse([
      { type: 'started', chapters: 3 },
      { type: 'chapter', index: 0, title: 'One', speech_check: check },
      { type: 'chapter', index: 1, title: 'Two', speech_check: { ...check, unchecked: 'x' } },
      {
        type: 'chapter',
        index: 2,
        title: 'Three',
        speech_check: { ...check, unchecked: 2, no_recognizer: true },
      },
      { type: 'done', output: 'new.m4b', failed_chapters: [] },
    ]),
  );
  await renderLongform('audiobook');
  expect(longformSession.state.drafts.audiobook.outputChapters).toEqual([
    { title: 'One', status: 'done', unchecked: 4 },
    { title: 'Two', status: 'done' },
    { title: 'Three', status: 'done', unchecked: 2, noRecognizer: true },
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

it('keeps a voice saved for a `[voice:Default]` name, as older versions cast it', () => {
  const draft = {
    ...longformSession.state.drafts.audiobook,
    voice: 'narrator',
    script: 'Intro [voice:Default] Cast before. [voice:default] Reset.',
    voiceCast: { Default: 'actor' },
  };
  // The saved cast still reads; the uncast lowercase reset still returns to the default voice.
  expect(renderBody('audiobook', draft)).toMatchObject({ voice_map: { Default: 'actor' } });
  expect(renderBody('audiobook', { ...draft, voiceCast: {} })).toHaveProperty('voice_map', {});
  const story = { ...draft, lines: [{ id: '1', text: '[voice:Default] Hi', profileId: null }] };
  expect(renderBody('stories', story)).toMatchObject({ voice_map: { Default: 'actor' } });
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

it('describes a book with a pronunciation word listed twice instead of failing on it', () => {
  const draft = {
    ...longformSession.state.drafts.audiobook,
    script: 'SQL',
    lexicon: [
      { word: 'SQL', pronunciation: 'sequel' },
      { word: 'sql', pronunciation: 'letters' },
    ],
  };
  // The outline and an audition's freshness read these on every edit: a
  // throw here took the whole Audiobook tab down, the saved draft with it.
  expect(outlineRequest(draft)).toHaveProperty('lexicon', { SQL: 'sequel' });
  expect(chapterPreviewBody(draft, 0)).toHaveProperty('lexicon', { SQL: 'sequel' });
  // A render still refuses a word with two pronunciations.
  expect(() => renderBody('audiobook', draft)).toThrow();
});

it('retakes an Audiobook sentence in the chapter around it, asked with its preview request', () => {
  const script = '# One\r\nFirst.\r\n# Empty\r\n# Two\r\nSecond. Third.';
  const draft = { ...longformSession.state.drafts.audiobook, script, voice: 'narrator' };
  // The editor's offsets index its text, line breaks as `\n`.
  const text = script.replaceAll('\r\n', '\n');
  expect(audiobookRetakeChapter(draft, text.indexOf('Third'))).toEqual({
    api: 'audiobook',
    // "Empty" renders nothing, so "Two" is the plan's second chapter.
    body: chapterPreviewBody(draft, 1),
    index: 1,
    sources: [{ id: 'script', text, from: text.indexOf('# Two'), to: text.length, headings: true }],
  });
  expect(audiobookRetakeChapter(draft, text.indexOf('# Empty') + 3)).toBeNull();
});

it('sends a passage with the chapter it is read in, so it reads the book’s own takes', () => {
  const script = 'Intro line.\r\n# One\r\nYes.\r\n\r\nNo.\r\n# Two\r\nYes.';
  const text = script.replaceAll('\r\n', '\n');
  const one = text.slice(text.indexOf('# One'), text.indexOf('# Two'));
  const at = text.indexOf('No.');
  expect(passageContext(script, at, at + 3)).toEqual({
    chapter: one,
    start: one.indexOf('No.'),
    end: one.indexOf('No.') + 3,
  });
  // From its heading on, a passage is still read in its chapter.
  expect(passageContext(script, text.indexOf('# Two'), text.length)).toEqual({
    chapter: text.slice(text.indexOf('# Two')),
    start: 0,
    end: text.length - text.indexOf('# Two'),
  });
  expect(passageContext(script, 0, 5)).toEqual({ chapter: 'Intro line.\n', start: 0, end: 5 });
  // Across chapters it is read on its own.
  expect(passageContext(script, at, text.length)).toBeNull();
});

it('retakes a Stories sentence in its chapter, posted as the render posts that chapter', () => {
  const draft = {
    ...longformSession.state.drafts.stories,
    voice: 'narrator',
    globalSpeed: 1.1,
    voiceCast: { Mara: 'actor' },
    lines: [
      { id: 'a', text: 'Opening line.', profileId: 'p1' },
      { id: 'h', text: '# Part two', profileId: null },
      { id: 'b', text: 'Part two opens. [voice:Mara] Her words.', profileId: 'p2' },
      { id: 'c', text: '[pause 1s] After a pause.', profileId: null, speed: 1.2 },
      { id: 'h2', text: '# Part three', profileId: null },
      { id: 'd', text: 'Last.', profileId: null },
    ],
  };
  const chapter = storyRetakeChapter(draft, 'c');
  // The render's request, less what only the finished file reads.
  const {
    chapters,
    format: _format,
    metadata: _metadata,
    loudness: _loudness,
    cover_path: _cover,
    ...inputs
  } = renderBody('stories', draft) as ReturnType<typeof renderBody> & {
    chapters: { spans: unknown[] }[];
  };
  expect(chapter?.api).toBe('longform');
  // Its spans are the whole story's for that chapter: the pause leading line
  // "c" still folds onto line "b".
  expect(chapter?.body.chapter).toMatchObject({ spans: chapters[1].spans });
  expect(chapter?.body).toEqual({ ...inputs, chapter: chapter?.body.chapter });
  expect(chapter?.sources.map((source) => source.id)).toEqual(['b', 'c']);
  expect(storyRetakeChapter(draft, 'a')?.sources.map((source) => source.id)).toEqual(['a']);
  expect(storyRetakeChapter(draft, 'h')).toBeNull();
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
