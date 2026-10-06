import { expect, it } from 'vitest';
import { canRecoverRender, draftFromRender } from './render-recovery';

const ids = () => {
  let n = 0;
  return () => 'id' + ++n;
};

it('rebuilds an audiobook script with its chapters, sections, voices and settings', () => {
  const render = {
    job_id: 'j',
    type: 'audiobook' as const,
    title: 'Dế Mèn',
    output: 'book.m4b',
    timeline: true,
    summary: {
      voices: [
        { id: 'narrator-id', name: 'Narrator' },
        { id: 'mara-id', name: 'Mara' },
      ],
      language: 'vi',
      format: 'mp3',
    },
  };
  const timeline = {
    chapters: [
      {
        title: 'Chapter 1',
        untitled: true,
        start: 0,
        end: 2,
        phrases: [{ text: 'Lời mở đầu.', voice: '' }],
        sections: [],
      },
      {
        title: 'Chương 1',
        start: 2,
        end: 10.5,
        phrases: [
          { text: 'Tôi sống độc lập.', voice: '' },
          { text: 'Xin chào!', voice: 'Mara' },
          { text: 'Câu sau.', voice: 'Mara', break: 'paragraph' },
          { text: 'Một mục.', voice: '' },
          { text: 'Dòng mới.', voice: '', break: 'line' },
        ],
        sections: [{ title: 'Phần A', level: 2, phrase: 3 }],
      },
    ],
  };
  expect(canRecoverRender(render)).toBe(true);
  const draft = draftFromRender(render, timeline, ids());
  expect(draft?.script).toBe(
    [
      // The untitled intro gets no invented heading.
      'Lời mở đầu.',
      '# Chương 1',
      'Tôi sống độc lập. [voice:Mara] Xin chào!',
      'Câu sau.',
      '## Phần A',
      '[voice:] Một mục.\nDòng mới.',
    ].join('\n\n'),
  );
  expect(draft).toMatchObject({
    title: 'Dế Mèn',
    voice: 'narrator-id',
    voiceCast: { Mara: 'mara-id' },
    language: 'Vietnamese',
    format: 'mp3',
    output: 'book.m4b',
    outputChapters: [
      // The render's English stand-in never reaches the rebuilt book's lists.
      { title: '', untitled: true, status: 'done', duration_s: 2 },
      { title: 'Chương 1', status: 'done', duration_s: 8.5 },
    ],
  });
  expect(JSON.stringify(draft?.outputChapters)).not.toContain('Chapter 1');
  expect(draft?.outputScript).toBe(draft?.script);
});

it('does not guess a cast when two names shared one voice', () => {
  const draft = draftFromRender(
    {
      job_id: 'j',
      output: 'b.m4b',
      summary: { voices: [{ id: 'one', name: 'One' }] },
    },
    {
      chapters: [
        {
          phrases: [
            { text: 'A', voice: 'X' },
            { text: 'B', voice: 'Y' },
          ],
        },
      ],
    },
  );
  expect(draft?.voiceCast).toEqual({});
  expect(draft?.voice).toBeNull();
  expect(draft?.language).toBe('Auto');
});

it('rebuilds a story as lines, one per run of a voice', () => {
  const draft = draftFromRender(
    { job_id: 'j', type: 'story', output: 's.mp3', title: 'Story' },
    {
      chapters: [
        {
          title: 'Opening',
          phrases: [
            { text: 'Hello.', voice: '' },
            { text: 'Again.', voice: '' },
            { text: 'Hi!', voice: 'actor' },
          ],
        },
      ],
    },
    ids(),
  );
  expect(draft?.lines).toEqual([
    { id: 'id1', text: '# Opening', profileId: null },
    { id: 'id2', text: 'Hello. Again.', profileId: null },
    { id: 'id3', text: 'Hi!', profileId: 'actor' },
  ]);
  expect(draft?.script).toBeUndefined();
  expect(draft?.outputScript).toBe('');
});

it('a render that kept no text cannot be rebuilt', () => {
  expect(canRecoverRender({ job_id: 'j', output: 'o.m4b' })).toBe(false);
  expect(draftFromRender({ job_id: 'j', output: 'o.m4b' }, { chapters: [] })).toBeNull();
  expect(
    draftFromRender(
      { job_id: 'j', output: 'o.m4b' },
      { chapters: [{ title: 'Only', phrases: [] }] },
    ),
  ).toBeNull();
});
