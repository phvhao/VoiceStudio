import { describe, expect, it } from 'vitest';
import { TAGS } from '@shared/utils/constants';
import { parseCastNames, validateScript } from '@shared/utils/audiobookScript';
import { storyToSpans } from '@shared/utils/storyToSpans';
import {
  PAUSE_PRESETS,
  applyVoice,
  caretPosition,
  castNameForProfile,
  changeDeliveryKind,
  classifyToken,
  cleanRespelling,
  completeTag,
  deliveryKind,
  expressionGroups,
  insertChapter,
  insertToken,
  normalizeNewlines,
  pauseMs,
  pauseToken,
  previewPassage,
  pronounceSelection,
  removeToken,
  replaceRange,
  respellingParts,
  respellingRange,
  setRespelling,
  tokenAt,
  tokenizeMarkup,
  typedTagAt,
  voiceAt,
  voiceName,
  voiceSection,
  voiceSwitches,
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
    expect(tokenizeMarkup('## Part', { headings: false })).toEqual([
      { text: '## Part', kind: 'text' },
    ]);
  });

  it('marks a section line by its marks, its spoken title keeping its tags', () => {
    const text = '# One\n  ## Part [voice:Mara] two\n### Deep\n#### body\n##body';
    const segments = tokenizeMarkup(text, { headings: true });
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(segments).toEqual([
      { text: '# One', kind: 'heading' },
      { text: '\n', kind: 'text' },
      { text: '  ## ', kind: 'section' },
      { text: 'Part ', kind: 'text' },
      { text: '[voice:Mara]', kind: 'voice' },
      { text: ' two\n', kind: 'text' },
      { text: '### ', kind: 'section' },
      { text: 'Deep\n#### body\n##body', kind: 'text' },
    ]);
    // A section's tags are tags, unlike a chapter heading's.
    expect(tokenAt(text, text.indexOf('[voice:Mara]') + 2, { headings: true })?.kind).toBe('voice');
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

  it('reads a tag back as long as the render pipeline pauses', () => {
    for (const token of ['[pause]', '[pause 300]', '[PAUSE 2 s]', '[pause 1.5s]', '[pause 60s]']) {
      expect(pauseMs(token), token).toBe(spans(`Before ${token} after`)[0].pause_ms_after);
    }
    expect(pauseMs('[sigh]')).toBeNull();
  });
});

describe('voice switches', () => {
  const book = [
    'Narrated intro.',
    '[voice:Mara] Hello. [voice: Ben ] Hi.',
    '[voice:default] Back.',
    '# Two [voice:Title]',
    'Narrated [voice:] again.',
  ].join('\n');

  it('lists every change of reader in order, a heading included', () => {
    const switches = voiceSwitches(book, { headings: true });
    expect(switches.map((change) => [change.kind, change.voice])).toEqual([
      ['voice', 'Mara'],
      ['voice', 'Ben'],
      ['reset', null],
      ['chapter', null],
      ['reset', null],
    ]);
    expect(book.slice(switches[0].offset, switches[0].end)).toBe('[voice:Mara]');
    // A tag in a heading is part of the chapter's title.
    expect(book.slice(switches[3].offset, switches[3].end)).toBe('# Two [voice:Title]');
  });

  it('reads # lines as narration where there are no chapters', () => {
    expect(voiceSwitches('# One [voice:Mara] x').map((change) => change.voice)).toEqual(['Mara']);
  });

  it('agrees with the render pipeline on who reads each phrase', () => {
    const text = 'Narrator first. [voice:Mara] Mara speaks. [voice:Ben]Ben now. [voice:] Narrator.';
    const phrases = spans(text);
    expect(phrases).toHaveLength(4);
    for (const span of phrases)
      expect(voiceAt(text, text.indexOf(span.text)), span.text).toBe(span.voice_id);
  });

  it('starts every chapter on the default voice, from its heading line on', () => {
    const text = '[voice:Mara] One.\n# Two\nNarrated.';
    expect(voiceAt(text, text.indexOf('One'), { headings: true })).toBe('Mara');
    expect(voiceAt(text, text.indexOf('# Two'), { headings: true })).toBeNull();
    expect(voiceAt(text, text.indexOf('Narrated'), { headings: true })).toBeNull();
    // Stories has no chapters inside a line: the voice carries on.
    expect(voiceAt(text, text.indexOf('Narrated'))).toBe('Mara');
  });

  it('gives the caret on a tag that tag’s voice, and the one before it ahead of it', () => {
    const text = 'a [voice:Mara] b [voice:default] c';
    expect(voiceAt(text, text.indexOf('[voice:Mara]'))).toBeNull();
    expect(voiceAt(text, text.indexOf('[voice:Mara]') + 3)).toBe('Mara');
    expect(voiceAt(text, text.indexOf(' c'))).toBeNull();
  });

  it('names the voice in a tag, never the resets', () => {
    expect(voiceName('[voice: Mara ]')).toBe('Mara');
    expect(voiceName('[voice:]')).toBeNull();
    expect(voiceName('[voice:default]')).toBeNull();
    expect(voiceName('Mara')).toBeNull();
  });

  it('reads [voice:Default] in any case as the default voice, as Cast and the render do', () => {
    const text = '[voice:Mara] a [voice: Default ] b [voice:DEFAULT] c';
    expect(parseCastNames(text)).toEqual(['Mara']);
    expect(voiceName('[voice:Default]')).toBeNull();
    expect(classifyToken('[voice:DEFAULT]')).toBe('voiceReset');
    expect(voiceSwitches(text).map((change) => [change.kind, change.voice])).toEqual([
      ['voice', 'Mara'],
      ['reset', null],
      ['reset', null],
    ]);
    expect(voiceAt(text, text.indexOf(' b'))).toBeNull();
  });
});

describe('voiceSection', () => {
  it('runs from the tag to the next switch, without the space around it', () => {
    const text = 'Intro [voice:Mara]  Hello there.\n\n [voice:Ben] Bye.';
    const [from, to] = voiceSection(text, tokenAt(text, text.indexOf('[voice:Mara]') + 1)!);
    expect(text.slice(from, to)).toBe('Hello there.');
  });

  it('ends with the chapter, or with the text', () => {
    const text = '[voice:Mara] One.\n# Two\nTwo.';
    const token = tokenAt(text, 1)!;
    const [from, to] = voiceSection(text, token, { headings: true });
    expect(text.slice(from, to)).toBe('One.');
    const [start, end] = voiceSection(text, token);
    expect(text.slice(start, end)).toBe('One.\n# Two\nTwo.');
  });

  it('is empty when the tag reads nothing', () => {
    const text = 'x [voice:Mara] ';
    const [from, to] = voiceSection(text, tokenAt(text, 3)!);
    expect(from).toBe(to);
  });
});

describe('caretPosition', () => {
  it('counts lines and columns from 1, like an editor', () => {
    const text = 'ab\ncd\n\nef';
    expect(caretPosition(text, 0)).toEqual({ line: 1, column: 1 });
    expect(caretPosition(text, 2)).toEqual({ line: 1, column: 3 });
    expect(caretPosition(text, 3)).toEqual({ line: 2, column: 1 });
    expect(caretPosition(text, 6)).toEqual({ line: 3, column: 1 });
    expect(caretPosition(text, text.length)).toEqual({ line: 4, column: 3 });
    expect(caretPosition(text, 99)).toEqual({ line: 4, column: 3 });
    expect(caretPosition('', 0)).toEqual({ line: 1, column: 1 });
  });

  it('counts the way the textarea does once line endings are normalized', () => {
    expect(normalizeNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    const plain = 'no carriage returns';
    expect(normalizeNewlines(plain)).toBe(plain);
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

  it('reads a tag on a chapter heading as part of the title where there are chapters', () => {
    const book = '# One [voice:Mara]\n[pause 1s] Text';
    expect(tokenAt(book, 8, { headings: true })).toBeNull();
    expect(tokenAt(book, 8)?.text).toBe('[voice:Mara]');
    expect(tokenAt(book, book.indexOf('[pause') + 1, { headings: true })?.kind).toBe('pause');
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

  it('switches a delivery pair from either end in one edit and keeps the words', () => {
    const open = tokenAt(text, text.indexOf('[slow]') + 1)!;
    const close = tokenAt(text, text.indexOf('[/slow]') + 1)!;
    const fromOpen = changeDeliveryKind(text, open, 'emphasis');
    expect(fromOpen.text).toBe(
      'Say [pause 1s] then [emphasis]softly now[/emphasis] and [[gif|jiff]] [huh] ok',
    );
    expect(fromOpen.text.slice(0, fromOpen.selectionStart)).toMatch(/\[emphasis\]$/);
    const fromClose = changeDeliveryKind(text, close, 'fast');
    expect(fromClose.text).toContain('[fast]softly now[/fast] and');
    expect(fromClose.text.slice(0, fromClose.selectionStart)).toMatch(/\[\/fast\]$/);
    // One replacement covers both halves, so one undo restores both.
    expect(text.slice(fromClose.from, fromClose.to)).toBe('[slow]softly now[/slow]');
  });

  it('switches an unpaired delivery tag alone, and reads mixed-case kinds', () => {
    const lone = 'a [SLOW]b';
    expect(changeDeliveryKind(lone, tokenAt(lone, 3)!, 'spell').text).toBe('a [spell]b');
    expect(deliveryKind('[/Emphasis]')).toBe('emphasis');
    expect(deliveryKind('[pause 1s]')).toBeNull();
  });

  it('agrees with the render pipeline after switching a pair', () => {
    const line = 'Then [slow]very softly[/slow] done.';
    const edit = changeDeliveryKind(line, tokenAt(line, 6)!, 'fast');
    expect(spans(edit.text).map((span) => span.text)).toEqual(spans(line).map((s) => s.text));
    expect(spans(edit.text).map((span) => span.speed)).not.toEqual(
      spans(line).map((span) => span.speed),
    );
  });

  it('respells an override in place and keeps the word it respells', () => {
    const token = tokenAt(text, text.indexOf('[[') + 2)!;
    expect(respellingParts(token)).toEqual({ word: 'gif', respelling: 'jiff' });
    const edit = setRespelling(text, token, '  ghif ');
    expect(edit.text).toContain('and [[gif|ghif]] [huh]');
    expect(edit.selectionStart).toBe(text.indexOf('[[') + '[[gif|ghif]]'.length);
    const bare = 'Say [[Nuh-VAD-uh]] now';
    const bareToken = tokenAt(bare, 6)!;
    expect(respellingParts(bareToken)).toEqual({ word: null, respelling: 'Nuh-VAD-uh' });
    expect(setRespelling(bare, bareToken, 'nuh VAH da').text).toBe('Say [[nuh VAH da]] now');
  });

  it('keeps a respelling from closing or splitting its override', () => {
    expect(cleanRespelling('a]b [c|d]\ne')).toBe('a b c d e');
    const token = tokenAt(text, text.indexOf('[[') + 2)!;
    const edit = setRespelling(text, token, 'x'.repeat(400));
    const written = tokenAt(edit.text, text.indexOf('[[') + 2)!;
    expect(written.kind).toBe('pronunciation');
    expect(written.text.length).toBe(256 + 4);
  });
});

describe('typing a tag', () => {
  it('finds the tag being typed back to its bracket on the same line', () => {
    expect(typedTagAt('Hello [pa', 9)).toEqual({ start: 6, end: 9, query: 'pa' });
    expect(typedTagAt('[', 1)).toEqual({ start: 0, end: 1, query: '' });
    // The rest of a tag the caret sits in is part of it.
    expect(typedTagAt('a [pa|use 1s] b'.replace('|', ''), 5)).toEqual({
      start: 2,
      end: 12,
      query: 'pa',
    });
  });

  it('stays out of closed tags, other lines, respellings and long runs', () => {
    expect(typedTagAt('[pause 1s] x', 12)).toBeNull();
    expect(typedTagAt('[pa\nuse', 6)).toBeNull();
    expect(typedTagAt('[[gif|ji', 8)).toBeNull();
    expect(typedTagAt('[[', 1)).toBeNull();
    expect(typedTagAt('[' + 'a'.repeat(41), 42)).toBeNull();
    expect(typedTagAt('[' + 'a'.repeat(40), 41)?.query).toHaveLength(40);
    expect(typedTagAt('no bracket', 4)).toBeNull();
  });

  it('reads a bracket on a chapter heading as part of the title where there are chapters', () => {
    const book = '# One [voi\n[pa';
    expect(typedTagAt(book, 10, { headings: true })).toBeNull();
    expect(typedTagAt(book, 10)?.query).toBe('voi');
    expect(typedTagAt(book, book.length, { headings: true })?.query).toBe('pa');
  });

  it('does not swallow text after the caret that is not a tag’s tail', () => {
    expect(typedTagAt('[pa words [pause 1s]', 3)?.end).toBe(3);
    expect(typedTagAt('[pa words\n]', 3)?.end).toBe(3);
  });

  it('completes the tag being typed, spacing it off the next word', () => {
    const text = 'Wait [pa then';
    const edit = completeTag(text, typedTagAt(text, 8)!, '[pause 1s]');
    expect(edit.text).toBe('Wait [pause 1s] then');
    expect(edit.selectionStart).toBe('Wait [pause 1s]'.length);
    const word = 'Wait [|then'.replace('|', '');
    expect(completeTag(word, typedTagAt(word, 6)!, '[sigh]').text).toBe('Wait [sigh] then');
    const inside = 'a [pa|use 1s] b'.replace('|', '');
    expect(completeTag(inside, typedTagAt(inside, 5)!, '[pause 2s]').text).toBe('a [pause 2s] b');
  });

  it('puts the caret between the halves of a completed pair', () => {
    const text = 'Say [sl';
    const edit = completeTag(text, typedTagAt(text, 7)!, '[slow]', '[/slow]');
    expect(edit.text).toBe('Say [slow][/slow]');
    expect(edit.selectionStart).toBe('Say [slow]'.length);
    expect(edit.selectionEnd).toBe(edit.selectionStart);
  });
});
