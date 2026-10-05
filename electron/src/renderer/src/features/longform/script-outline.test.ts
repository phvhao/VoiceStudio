import { describe, expect, it } from 'vitest';
import { scriptChapters } from '@shared/utils/audiobookLyrics';
import {
  displayTitle,
  insertHeading,
  outlineNodeAt,
  removeHeading,
  renameHeading,
  scriptOutline,
} from './script-outline';

const SCRIPT = [
  'An opening line.',
  '# One',
  'First words here.',
  '## Part [voice:Mara] two',
  'Mara speaks.',
  '### Deeper',
  'x',
  '#### not a section',
  '# Empty',
  '[pause 1s]',
  '# [voice:x]',
  '# Two',
  'Last.',
].join('\n');

describe('scriptOutline', () => {
  it('reads chapters and their sections the way the render does', () => {
    const outline = scriptOutline(SCRIPT);
    expect(
      outline.map((c) => [c.title, c.plan, c.sections.map((s) => [s.title, s.level])]),
    ).toEqual([
      [null, 0, []],
      [
        'One',
        1,
        [
          ['Part [voice:Mara] two', 2],
          ['Deeper', 3],
        ],
      ],
      // A pause alone still renders; a heading with nothing under it does not.
      ['Empty', 2, []],
      ['[voice:x]', null, []],
      ['Two', 3, []],
    ]);
    // Plan indexes match the parser's chapters.
    expect(scriptChapters(SCRIPT).map((c) => c.title)).toEqual(['', 'One', 'Empty', 'Two']);
  });

  it('gives offsets into the text and counts the spoken words', () => {
    const outline = scriptOutline(SCRIPT);
    const one = outline[1];
    const part = one.sections[0];
    expect(SCRIPT.slice(one.start, one.lineEnd ?? 0)).toBe('# One');
    expect(SCRIPT.slice(part.titleStart ?? 0, part.lineEnd ?? 0)).toBe('Part [voice:Mara] two');
    // The `##` section holds its `###` subsection.
    expect(part.end).toBe(one.end);
    expect(one.sections[1].end).toBe(one.end);
    // "First words here." (3), "Part two" (2), "Mara speaks." (2), "Deeper", "x",
    // "#### not a section" (4).
    expect(one.words).toBe(13);
    expect(part.words).toBe(10);
    expect(one.sections[1].words).toBe(6);
    expect(outline[0]).toMatchObject({ title: null, start: 0, titleStart: null, words: 3 });
  });

  it('ends a section at the next heading of its level or above', () => {
    const text = '# Ch\n## A\ntext a\n### A.1\nmore\n## B\nb';
    const [a, a1, b] = scriptOutline(text)[0].sections;
    expect(a.end).toBe(text.indexOf('## B'));
    expect(a1.end).toBe(text.indexOf('## B'));
    expect(b.end).toBe(text.length);
    // "A", "text a", "A.1", "more": the subsection counts toward its section.
    expect(a.words).toBe(5);
    // A section added after A lands after its subsections, which stay A's.
    const added = insertHeading(text, a.end, 2, 'New').text;
    expect(added).toBe('# Ch\n## A\ntext a\n### A.1\nmore\n\n## New\n\n## B\nb');
  });

  it('reads CRLF text by its newline-normalized offsets', () => {
    const outline = scriptOutline('# A\r\n## B\r\nbody');
    expect(outline[0].sections[0]).toMatchObject({ title: 'B', start: 4, titleStart: 7 });
  });

  it('finds the node holding an offset', () => {
    const outline = scriptOutline(SCRIPT);
    expect(outlineNodeAt(outline, SCRIPT.indexOf('Mara speaks'))?.title).toBe(
      'Part [voice:Mara] two',
    );
    expect(outlineNodeAt(outline, SCRIPT.indexOf('First'))?.title).toBe('One');
    expect(outlineNodeAt(outline, 0)?.title).toBeNull();
  });
});

describe('displayTitle', () => {
  it('drops tags and reads respellings as their word', () => {
    expect(displayTitle('Part [voice:Mara]  two')).toBe('Part two');
    expect(displayTitle('The [[gif|jiff]] war')).toBe('The gif war');
  });
});

describe('heading edits', () => {
  it('renames a heading and selects the new title', () => {
    const text = '# One\nbody\n  ## Old title  \nmore';
    const at = text.indexOf('  ##');
    const result = renameHeading(text, at, '  New\ntitle ');
    expect(result?.text).toBe('# One\nbody\n  ## New title\nmore');
    expect(result && result.text.slice(result.selectionStart, result.selectionEnd)).toBe(
      'New title',
    );
    expect(renameHeading(text, text.indexOf('body'), 'x')).toBeNull();
    expect(renameHeading(text, at, '  ')).toBeNull();
    expect(renameHeading(text, at + 1, 'x')).toBeNull();
  });

  it('adds a heading on a paragraph of its own and selects its title', () => {
    const text = '# One\nbody\n# Two\nlast';
    const after = insertHeading(text, text.indexOf('# Two'), 2, 'New section');
    expect(after.text).toBe('# One\nbody\n\n## New section\n\n# Two\nlast');
    expect(after.text.slice(after.selectionStart, after.selectionEnd)).toBe('New section');
    expect(insertHeading(text, text.length, 1, 'Three').text).toBe(
      '# One\nbody\n# Two\nlast\n\n# Three\n',
    );
    expect(insertHeading('', 0, 1, 'First').text).toBe('# First\n');
    expect(insertHeading('a\n\n', 3, 3, 'S').text).toBe('a\n\n### S\n');
  });

  it('removes a heading line and keeps the text under it', () => {
    const text = '# One\nbody\n## Part\nmore';
    const result = removeHeading(text, text.indexOf('## Part'));
    expect(result?.text).toBe('# One\nbody\nmore');
    expect(removeHeading('x\n# Last', 2)?.text).toBe('x\n');
    expect(removeHeading(text, text.indexOf('body'))).toBeNull();
  });
});
