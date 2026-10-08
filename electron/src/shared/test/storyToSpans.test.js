import { describe, it, expect } from 'vitest';
import { storyToSpans } from '../utils/storyToSpans';
import { applyPassageGain } from '../utils/storyExport';
import { SAMPLE_STORY_CAST, SAMPLE_STORY_LINES } from '../data/sampleStory';

const CAST = [
  { id: 'narrator', name: 'Narrator', profileId: 'p_narr' },
  { id: 'c_fox', name: 'Fox', profileId: 'p_fox' },
];

describe('storyToSpans', () => {
  it('compiles the bundled Stories demo through the real render plan', () => {
    const cast = SAMPLE_STORY_CAST.map((member) => ({
      ...member,
      profileId: `profile-${member.id}`,
    }));
    const chapters = storyToSpans(SAMPLE_STORY_LINES, cast);
    const spans = chapters.flatMap((chapter) => chapter.spans);

    expect(chapters.map((chapter) => chapter.title)).toEqual(['The Lamp', 'The Radio']);
    expect(spans.length).toBeGreaterThan(9);
    expect(spans.every((span) => span.text.trim())).toBe(true);
    expect(new Set(spans.map((span) => span.voice_id))).toEqual(
      new Set(['profile-narrator', 'profile-mara', 'profile-cole']),
    );
    expect(spans.some((span) => span.pause_ms_after > 0)).toBe(true);
  });

  it('resolves each line to its cast voice', () => {
    const tracks = [
      { character: 'narrator', text: 'Once upon a time.' },
      { character: 'c_fox', text: 'Hello there.' },
    ];
    const chapters = storyToSpans(tracks, CAST);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].spans).toEqual([
      { voice_id: 'p_narr', text: 'Once upon a time.', pause_ms_after: 0, speed: null },
      { voice_id: 'p_fox', text: 'Hello there.', pause_ms_after: 0, speed: null },
    ]);
  });

  it('opens a new chapter on a "# " line', () => {
    const tracks = [
      { character: 'narrator', text: '# Chapter One' },
      { character: 'narrator', text: 'Intro.' },
      { character: 'narrator', text: '# Chapter Two' },
      { character: 'c_fox', text: 'More.' },
    ];
    const chapters = storyToSpans(tracks, CAST);
    expect(chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(chapters[1].spans[0]).toEqual({
      voice_id: 'p_fox',
      text: 'More.',
      pause_ms_after: 0,
      speed: null,
    });
  });

  it('honors a per-line voice override', () => {
    const tracks = [{ character: 'narrator', profileId: 'p_override', text: 'Hi.' }];
    expect(storyToSpans(tracks, CAST)[0].spans[0].voice_id).toBe('p_override');
  });

  it('carries the per-line speed onto its spans', () => {
    const tracks = [{ character: 'narrator', text: 'Slow. [pause 0.2s] down.', speed: 0.8 }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans.every((s) => s.speed === 0.8)).toBe(true);
  });

  it('applies inline SSML-lite prosody (overriding the line speed)', () => {
    const tracks = [
      { character: 'narrator', text: 'calm [fast]rush[/fast] [spell]USA[/spell]', speed: 0.9 },
    ];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    const calm = spans.find((s) => s.text === 'calm');
    const rush = spans.find((s) => s.text === 'rush');
    const usa = spans.find((s) => s.text === 'U S A');
    expect(calm.speed).toBe(0.9); // plain → falls back to the line slider
    expect(rush.speed).toBe(1.15); // [fast] overrides the line slider
    expect(usa).toBeTruthy(); // [spell] spelled the letters out
  });

  it('folds [pause] into the previous span', () => {
    const tracks = [{ character: 'narrator', text: 'Wait. [pause 0.5s] Done.' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans[0]).toEqual({
      voice_id: 'p_narr',
      text: 'Wait.',
      pause_ms_after: 500,
      speed: null,
    });
    expect(spans[1]).toEqual({ voice_id: 'p_narr', text: 'Done.', pause_ms_after: 0, speed: null });
  });

  it('switches voice mid-line on [voice:]', () => {
    const tracks = [{ character: 'narrator', text: 'A [voice:p_fox] B' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans[0].voice_id).toBe('p_narr');
    expect(spans[1].voice_id).toBe('p_fox');
  });

  it('drops empty lines and empty chapters', () => {
    const tracks = [
      { character: 'narrator', text: '# Empty' },
      { character: 'narrator', text: '   ' },
      { character: 'narrator', text: '# Real' },
      { character: 'narrator', text: 'Here.' },
    ];
    const chapters = storyToSpans(tracks, CAST);
    expect(chapters.map((c) => c.title)).toEqual(['Real']);
  });

  it('a leading pause becomes a silent span', () => {
    const tracks = [{ character: 'narrator', text: '[pause 1s] Go.' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans[0]).toEqual({ voice_id: 'p_narr', text: '', pause_ms_after: 1000, speed: null });
    expect(spans[1].text).toBe('Go.');
  });

  // ── §H adapter-specific cases (#27) ──

  it('returns [] for empty / null track lists', () => {
    expect(storyToSpans([], CAST)).toEqual([]);
    expect(storyToSpans(null, CAST)).toEqual([]);
    expect(storyToSpans(undefined, CAST)).toEqual([]);
  });

  it('honors the canonical pause dialect ([pause], Nms) — never spoken', () => {
    const tracks = [{ character: 'narrator', text: 'A [pause] B [pause 500ms] C' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans.map((s) => s.text)).toEqual(['A', 'B', 'C']);
    expect(spans[0].pause_ms_after).toBe(350); // bare [pause]
    expect(spans[1].pause_ms_after).toBe(500); // [pause 500ms]
  });

  it('## inside a multi-line track text does NOT re-chapter', () => {
    const tracks = [{ character: 'narrator', text: 'line one\n# not a chapter\nline two' }];
    const chapters = storyToSpans(tracks, CAST);
    expect(chapters).toHaveLength(1);
    // the embedded `#` stays literal in the span text (single chapter body)
    expect(chapters[0].spans[0].text).toContain('# not a chapter');
  });

  it('folds a leading pause across tracks into the previous span', () => {
    const tracks = [
      { character: 'narrator', text: 'First.' },
      { character: 'narrator', text: '[pause 1s] Second.' },
    ];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans[0]).toEqual({
      voice_id: 'p_narr',
      text: 'First.',
      pause_ms_after: 1000,
      speed: null,
    });
    expect(spans[1].text).toBe('Second.');
    expect(spans).toHaveLength(2); // no standalone silent span between tracks
  });

  it('treats per-track speed 0 as null (engine default, not 0×)', () => {
    const tracks = [{ character: 'narrator', text: 'Hi.', speed: 0 }];
    expect(storyToSpans(tracks, CAST)[0].spans[0].speed).toBeNull();
  });

  // ── #415 global speed ──

  it('applies a global speed to lines without a per-track override', () => {
    const tracks = [
      { character: 'narrator', text: 'one' }, // no per-track speed
      { character: 'narrator', text: 'two', speed: 1.5 }, // per-track override
    ];
    const spans = storyToSpans(tracks, CAST, 0.8)[0].spans;
    expect(spans.find((s) => s.text === 'one').speed).toBe(0.8); // inherits global
    expect(spans.find((s) => s.text === 'two').speed).toBe(1.5); // override wins
  });

  it('treats global speed 1.0× (and null) as no override', () => {
    const tracks = [{ character: 'narrator', text: 'hi' }];
    expect(storyToSpans(tracks, CAST, 1)[0].spans[0].speed).toBeNull();
    expect(storyToSpans(tracks, CAST, null)[0].spans[0].speed).toBeNull();
    expect(storyToSpans(tracks, CAST)[0].spans[0].speed).toBeNull(); // default arg
  });

  it('with layout, says where each line starts and who says it', () => {
    const tracks = [
      { character: 'narrator', text: '# One' },
      { character: 'narrator', text: 'Once.' },
      { character: 'c_fox', text: '[pause 1s] Hi [slow]there[/slow].' },
      { text: 'Nobody cast.' },
      { character: 'narrator', text: '# Two' },
      { character: 'c_fox', text: 'Again.' },
    ];
    const chapters = storyToSpans(tracks, CAST, null, { layout: true });
    const fox = { name: 'Fox', accent: 1 };
    expect(chapters[0].spans.map((s) => [s.text, s.break_before, s.speaker])).toEqual([
      ['Once.', undefined, { name: 'Narrator', accent: 0 }],
      // The leading pause folds into the line before; the line's first span opens it.
      ['Hi', 'paragraph', fox],
      ['there', undefined, fox],
      ['.', undefined, fox],
      ['Nobody cast.', 'paragraph', undefined],
    ]);
    // A chapter's first line opens nothing; a character with no name is nobody.
    expect(chapters[1].spans[0]).toMatchObject({ text: 'Again.', speaker: fox });
    expect(chapters[1].spans[0]).not.toHaveProperty('break_before');
    const unnamed = storyToSpans(
      [{ character: 'c_fox', text: 'Hm.' }],
      [{ id: 'c_fox', name: '  ', profileId: null }],
      null,
      { layout: true },
    );
    expect(unnamed[0].spans[0]).not.toHaveProperty('speaker');
    // Without layout (takes, retakes, previews) the plan is as before.
    expect(storyToSpans(tracks, CAST)[0].spans.some((s) => s.break_before || s.speaker)).toBe(
      false,
    );
  });

  it('never speaks an [image:] tag and shows each picture from where it stood', () => {
    const tracks = [
      { character: 'narrator', text: '[image: dawn.jpg]' },
      { character: 'narrator', text: 'Once.' },
      { character: 'c_fox', text: 'Hi [image: fox.png contain] there.' },
      { character: 'narrator', text: '# Two [image: night.jpg]' },
      { character: 'narrator', text: '[image: none]' },
      { character: 'c_fox', text: 'Again.' },
    ];
    const chapters = storyToSpans(tracks, CAST, null, { layout: true });
    const spans = chapters.flatMap((chapter) => chapter.spans);
    expect(spans.map((s) => s.text)).toEqual(['Once.', 'Hi there.', 'Again.']);
    expect(chapters.map((chapter) => chapter.title)).toEqual(['', 'Two']);
    // A line holding only a picture gives it to the next line read, from its start.
    expect(spans[0].images).toEqual([{ at: 0, name: 'dawn.jpg', fit: 'auto' }]);
    expect(spans[1].images).toEqual([{ at: 3, name: 'fox.png', fit: 'contain' }]);
    // A chapter line's picture opens its chapter; `none` goes back to the backdrop.
    expect(spans[2].images).toEqual([
      { at: 0, name: 'night.jpg', fit: 'auto' },
      { at: 0, name: null, fit: 'auto' },
    ]);
    // The plan is otherwise exactly the one without pictures: no take moves.
    const bare = storyToSpans(
      tracks.map((track) => ({ ...track, text: track.text.replace(/ ?\[image:[^\]]*\]/g, '') })),
      CAST,
      null,
      { layout: true },
    );
    const strip = (list) => list.flatMap((c) => c.spans).map(({ images: _images, ...rest }) => rest);
    expect(strip(chapters)).toEqual(strip(bare));
  });

  it('[voice:] reverts to the resolved cast voice, not null', () => {
    const tracks = [{ character: 'c_fox', text: 'hi [voice:p_bob] there [voice:] back' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans.map((s) => [s.voice_id, s.text])).toEqual([
      ['p_fox', 'hi'],
      ['p_bob', 'there'],
      ['p_fox', 'back'], // reverts to the cast voice (p_fox), NOT null
    ]);
  });
});

describe('[volume] in Stories', () => {
  it('carries a passage gain into the posted plan', () => {
    const [chapter] = storyToSpans(
      [{ character: 'c_fox', text: 'Psst. [volume -6dB]quiet now[/volume] Done.' }],
      CAST,
    );
    expect(chapter.spans.map((s) => [s.text, s.gain_db])).toEqual([
      ['Psst.', undefined],
      ['quiet now', -6],
      ['Done.', undefined],
    ]);
  });

  it('moves a previewed passage like the server render, peak-guarded', () => {
    const buffer = (values) => {
      const data = Float32Array.from(values);
      return { numberOfChannels: 1, length: data.length, getChannelData: () => data };
    };
    expect(Array.from(applyPassageGain(buffer([0.5, -0.5]), -6).getChannelData(0))).toEqual([
      expect.closeTo(0.2506, 4),
      expect.closeTo(-0.2506, 4),
    ]);
    // +12 dB would clip: the boost stops at the 0.97 ceiling.
    expect(applyPassageGain(buffer([0.5, 0.1]), 12).getChannelData(0)[0]).toBeCloseTo(0.97, 5);
    const untouched = buffer([0.5]);
    expect(applyPassageGain(untouched, undefined).getChannelData(0)[0]).toBe(0.5);
  });
});
