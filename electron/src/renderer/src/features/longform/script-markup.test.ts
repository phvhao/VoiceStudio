import { describe, expect, it } from 'vitest';
import { TAGS } from '@shared/utils/constants';
import { validateScript } from '@shared/utils/audiobookScript';
import { storyToSpans } from '@shared/utils/storyToSpans';
import {
  PAUSE_PRESETS,
  applyVoice,
  castNameForProfile,
  classifyToken,
  expressionGroups,
  insertChapter,
  insertToken,
  pauseToken,
  previewPassage,
  pronounceSelection,
  removeToken,
  replaceRange,
  respellingRange,
  tokenAt,
  tokenizeMarkup,
  wrapSelection,
  type MarkupEdit,
} from './script-markup';

// What the render pipeline makes of one Stories line (the canonical parser).
const spans = (text: string) =>
  storyToSpans([{ text, profileId: null }], [], null).flatMap((chapter) => chapter.spans);
const selected = (edit: MarkupEdit) => edit.text.slice(edit.selectionStart, edit.selectionEnd);

describe('tokenizeMarkup', () => {
  const script =
    '# Chapter One\n[voice:Mara]Hello [pause 1.5s] [slow]there[/slow] [laughter][voice:] [whisper]';

  it('returns the text unchanged when its segments are joined', () => {
    for (const headings of [true, false]) {
      const joined = tokenizeMarkup(script, { headings })
        .map((segment) => segment.text)
        .join('');
      expect(joined).toBe(script);
    }
  });

  it('labels every kind of markup', () => {
    const kinds = tokenizeMarkup(script, { headings: true })
      .filter((segment) => segment.kind !== 'text')
      .map((segment) => [segment.text, segment.kind]);
    expect(kinds).toEqual([
      ['# Chapter One', 'heading'],
      ['[voice:Mara]', 'voice'],
      ['[pause 1.5s]', 'pause'],
      ['[slow]', 'delivery'],
      ['[/slow]', 'delivery'],
      ['[laughter]', 'expression'],
      ['[voice:]', 'voiceReset'],
      ['[whisper]', 'unknown'],
    ]);
  });

  it('only treats headings as chapters where the editor asks for it', () => {
    expect(tokenizeMarkup('# Title', { headings: false })).toEqual([
      { text: '# Title', kind: 'text' },
    ]);
  });

  it('agrees with the pre-flight validator on which tags are unknown', () => {
    const tokens = [
      ...TAGS,
      '[pause]',
      '[pause 300]',
      '[PAUSE 2 s]',
      '[voice:Narrator]',
      '[voice:]',
      '[voice:default]',
      '[Emphasis]',
      '[/spell]',
      '[whisper]',
      '[pause 1 minute]',
      '[voice]',
    ];
    const flagged = new Set(
      validateScript(tokens.join(' '))
        .filter((warning) => warning.type === 'unknown_tag')
        .map((warning) => warning.tag),
    );
    for (const token of tokens)
      expect(classifyToken(token) === 'unknown', token).toBe(flagged.has(token));
  });
});

describe('pauses', () => {
  it('writes tokens the render pipeline reads back as the same duration', () => {
    for (const ms of [...PAUSE_PRESETS.map((preset) => preset.ms), 100, 1250, 1500, 9900]) {
      const parsed = spans(`Before ${pauseToken(ms)} after`);
      expect(parsed[0].pause_ms_after, pauseToken(ms)).toBe(ms);
    }
  });

  it('uses readable units and clamps to the engine limit', () => {
    expect(pauseToken(250)).toBe('[pause 250ms]');
    expect(pauseToken(1000)).toBe('[pause 1s]');
    expect(pauseToken(1500)).toBe('[pause 1.5s]');
    expect(pauseToken(1250)).toBe('[pause 1250ms]');
    expect(pauseToken(60_000)).toBe('[pause 10s]');
    expect(pauseToken(-1)).toBe('[pause 0ms]');
  });
});

describe('edits', () => {
  it('inserts a token after the selection without replacing it', () => {
    const edit = insertToken('Hello world', 0, 5, '[sigh]');
    expect(edit.text).toBe('Hello [sigh] world');
    expect(edit.text.slice(0, edit.selectionStart)).toBe('Hello [sigh]');
  });

  it('does not add spaces that are already there', () => {
    expect(insertToken('Hello ', 6, 6, '[sigh]').text).toBe('Hello [sigh]');
    expect(insertToken('', 0, 0, '[sigh]').text).toBe('[sigh]');
  });

  it('wraps the trimmed selection and keeps it selected', () => {
    const edit = wrapSelection('say hello world', 3, 10, '[slow]', '[/slow]');
    expect(edit.text).toBe('say [slow]hello[/slow] world');
    expect(selected(edit)).toBe('hello');
    expect(spans(edit.text).map((span) => [span.text, span.speed])).toEqual([
      ['say', null],
      ['hello', 0.85],
      ['world', null],
    ]);
  });

  it('puts the caret between an empty pair', () => {
    const edit = wrapSelection('ab', 1, 1, '[spell]', '[/spell]');
    expect(edit.text).toBe('a[spell][/spell]b');
    expect(edit.text.slice(0, edit.selectionStart)).toBe('a[spell]');
  });

  it('voices only the selected words and then returns to the default voice', () => {
    const edit = applyVoice('He said hello there.', 8, 13, 'Mara');
    expect(edit.text).toBe('He said [voice:Mara]hello[voice:] there.');
    expect(spans(edit.text).map((span) => [span.text, span.voice_id])).toEqual([
      ['He said', null],
      ['hello', 'Mara'],
      ['there.', null],
    ]);
  });

  it('switches the voice from the caret on when nothing is selected', () => {
    expect(applyVoice('One. Two.', 5, 5, 'Mara').text).toBe('One. [voice:Mara] Two.');
  });

  it('starts a chapter on its own line with the title selected', () => {
    const edit = insertChapter('First line\nSecond line', 3, 'Chapter 2');
    expect(edit.text).toBe('First line\n\n# Chapter 2\n\nSecond line');
    expect(selected(edit)).toBe('Chapter 2');
  });

  it('reuses an empty line for the chapter heading', () => {
    const edit = insertChapter('Intro\n\n', 7, 'Chapter 1');
    expect(edit.text).toBe('Intro\n\n# Chapter 1\n');
    expect(selected(edit)).toBe('Chapter 1');
  });
});

describe('castNameForProfile', () => {
  const profile = { id: 'p1', name: 'Ms [Nhu]  Voice' };

  it('uses the readable profile name without brackets', () => {
    expect(castNameForProfile(profile, {})).toBe('Ms Nhu Voice');
  });

  it('keeps the name already cast to the same profile', () => {
    expect(castNameForProfile(profile, { 'Ms Nhu Voice': 'p1' })).toBe('Ms Nhu Voice');
  });

  it('numbers the name when another voice holds it', () => {
    expect(castNameForProfile(profile, { 'Ms Nhu Voice': 'p2' })).toBe('Ms Nhu Voice 2');
    expect(castNameForProfile(profile, { 'Ms Nhu Voice': 'p2', Nhu: 'p1' })).toBe('Nhu');
  });

  it('never produces the reserved default name', () => {
    expect(castNameForProfile({ id: 'p3', name: 'Default' }, {})).toBe('Default 2');
  });
});

it('offers every expression tag exactly once', () => {
  const offered = expressionGroups().flatMap((group) => group.tags);
  expect([...offered].sort()).toEqual([...TAGS].sort());
  expect(expressionGroups().some((group) => group.key === 'other')).toBe(false);
});

describe('previewPassage', () => {
  const book = [
    '# One',
    '[voice:Mara] First paragraph.',
    '',
    'Second paragraph, still Mara.',
    '',
    '# Two',
    'Narrated again.',
  ].join('\n');

  it('previews the paragraph at the caret in the voice in effect there', () => {
    const caret = book.indexOf('still');
    expect(previewPassage(book, caret, caret)).toBe('[voice:Mara] Second paragraph, still Mara.');
  });

  it('previews exactly the selection', () => {
    const start = book.indexOf('First');
    expect(previewPassage(book, start, start + 'First paragraph.'.length)).toBe(
      '[voice:Mara] First paragraph.',
    );
  });

  it('starts every chapter on the default voice', () => {
    const caret = book.indexOf('Narrated');
    expect(previewPassage(book, caret, caret)).toBe('Narrated again.');
  });

  it('drops headings and refuses passages with nothing to say', () => {
    expect(previewPassage('# Title\nBody.', 0, 13)).toBe('Body.');
    expect(previewPassage('# Title\n[pause 1s]', 0, 0)).toBeNull();
    expect(previewPassage('', 0, 0)).toBeNull();
  });

  it('respects a voice reset before the passage', () => {
    const text = '[voice:Mara] Hi. [voice:] Back to narration.';
    const start = text.indexOf('Back');
    expect(previewPassage(text, start, text.length)).toBe('Back to narration.');
  });
});

describe('pronunciation overrides', () => {
  it('highlights [[word|respelling]] as one pronunciation token', () => {
    const kinds = tokenizeMarkup('Open [[gif|jiff]] and [[Nuh-VAD-uh]] [x]')
      .filter((segment) => segment.kind !== 'text')
      .map((segment) => [segment.text, segment.kind]);
    expect(kinds).toEqual([
      ['[[gif|jiff]]', 'pronunciation'],
      ['[[Nuh-VAD-uh]]', 'pronunciation'],
      ['[x]', 'unknown'],
    ]);
  });

  it('respells the selected word with the respelling half selected', () => {
    const edit = pronounceSelection('Open gif now', 4, 9);
    expect(edit.text).toBe('Open [[gif|gif]] now');
    expect(selected(edit)).toBe('gif');
    expect(edit.selectionStart).toBe('Open [[gif|'.length);
  });

  it('inserts an empty override with the caret on the word half', () => {
    const edit = pronounceSelection('ab', 1, 1);
    expect(edit.text).toBe('a[[|]]b');
    expect(edit.selectionStart).toBe('a[['.length);
  });
});

describe('editing existing markup', () => {
  const text = 'Say [pause 1s] then [slow]softly now[/slow] and [[gif|jiff]] [huh] ok';

  it('finds the token under the caret, edges included', () => {
    const start = text.indexOf('[pause');
    expect(tokenAt(text, start)?.text).toBe('[pause 1s]');
    expect(tokenAt(text, start + 4)?.kind).toBe('pause');
    expect(tokenAt(text, start + '[pause 1s]'.length)?.text).toBe('[pause 1s]');
    expect(tokenAt(text, 1)).toBeNull();
  });

  it('removes a delivery pair from either end and keeps its words selected', () => {
    for (const tag of ['[slow]', '[/slow]']) {
      const edit = removeToken(text, tokenAt(text, text.indexOf(tag) + 1)!);
      expect(edit.text).toBe('Say [pause 1s] then softly now and [[gif|jiff]] [huh] ok');
      expect(selected(edit)).toBe('softly now');
    }
  });

  it('removes a respelling but keeps the word', () => {
    const edit = removeToken(text, tokenAt(text, text.indexOf('[[') + 3)!);
    expect(edit.text).toContain('and gif [huh]');
  });

  it('removes a plain tag with one neighbouring space', () => {
    const edit = removeToken(text, tokenAt(text, text.indexOf('[huh]') + 1)!);
    expect(edit.text).toBe('Say [pause 1s] then [slow]softly now[/slow] and [[gif|jiff]] ok');
  });

  it('replaces a token in place', () => {
    const token = tokenAt(text, text.indexOf('[pause') + 2)!;
    expect(replaceRange(text, token.start, token.end, pauseToken(250)).text).toContain(
      'Say [pause 250ms] then',
    );
    expect(respellingRange(tokenAt(text, text.indexOf('[[') + 2)!)).toEqual([
      text.indexOf('jiff'),
      text.indexOf('jiff') + 4,
    ]);
  });
});
