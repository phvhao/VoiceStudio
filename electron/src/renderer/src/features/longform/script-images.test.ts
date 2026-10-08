import { describe, expect, it } from 'vitest';
import { validateScript } from '@shared/utils/audiobookScript';
import { extractImageMarks } from '@shared/utils/longformParser';
import {
  classifyToken,
  imageTagParts,
  imageToken,
  insertImageAtLineStart,
  insertImageLine,
  removeToken,
  tokenizeMarkup,
  type MarkupToken,
} from './script-markup';

const token = (text: string, value: string): MarkupToken => {
  const start = value.indexOf(text);
  return { text, start, end: start + text.length, kind: classifyToken(text) } as MarkupToken;
};

describe('[image:] in the editor', () => {
  it('is a tag of its own kind, read the way the render reads it', () => {
    expect(classifyToken('[image: dawn.jpg]')).toBe('image');
    expect(classifyToken('[IMAGE:Dawn.JPG contain]')).toBe('image');
    expect(classifyToken('[images: x]')).toBe('unknown');
    expect(imageTagParts('[IMAGE:  Dawn.JPG   CONTAIN ]')).toEqual({ name: 'dawn.jpg', fit: 'contain' });
    expect(imageTagParts('[image: none]')).toEqual({ name: null, fit: 'auto' });
    expect(imageTagParts('[image: a.jpg sideways]')).toEqual({ name: 'a.jpg', fit: 'auto' });
    expect(imageTagParts('[pause 1s]')).toBeNull();
    expect(tokenizeMarkup('A. [image: a.jpg] B.').map((s) => s.kind)).toEqual(['text', 'image', 'text']);
    // Clone and Voice Design read no pictures: there the tag is marked unread.
    expect(
      tokenizeMarkup('[image: a.jpg]', { unsupported: ['image'] }).map((s) => s.kind),
    ).toEqual(['unknown']);
  });

  it('writes its fit only when one is chosen', () => {
    expect(imageToken('a.jpg')).toBe('[image: a.jpg]');
    expect(imageToken('a.jpg', 'cover')).toBe('[image: a.jpg cover]');
    expect(imageToken(null)).toBe('[image: none]');
  });

  it('goes on a line of its own (a book) or at the start of its line (a story line)', () => {
    const book = 'One.\nTwo words.\nThree.';
    const caret = book.indexOf('words');
    const own = insertImageLine(book, caret, '[image: a.jpg]');
    expect(own.text).toBe('One.\n[image: a.jpg]\nTwo words.\nThree.');
    // On a blank line it goes above it: the blank line's paragraph break stays.
    expect(insertImageLine('One.\n\nTwo.', 5, '[image: a.jpg]').text).toBe('One.\n[image: a.jpg]\n\nTwo.');
    expect(insertImageAtLineStart('He said hi.', 6, '[image: a.jpg]').text).toBe(
      '[image: a.jpg] He said hi.',
    );
    expect(insertImageAtLineStart('', 0, '[image: a.jpg]').text).toBe('[image: a.jpg]');
  });

  it('never changes what the render reads, wherever it goes', () => {
    const scripts = [
      'A.\n\nB.',
      'One.\nTwo words.\n\n\nThree.\n',
      '# Ch\n\nPara one.\n[image: a.jpg]\nPara two.\n## Part\nEnd [image: c.jpg] here.',
      'X [image: a.jpg]\nY',
      '',
      '\n',
    ];
    for (const script of scripts) {
      for (let caret = 0; caret <= script.length; caret++) {
        for (const tags of ['[image: b.jpg]', '[image: b.jpg]\n[image: none]']) {
          const { text } = insertImageLine(script, caret, tags);
          expect(extractImageMarks(text)[0], JSON.stringify([script, caret, tags])).toBe(
            extractImageMarks(script)[0],
          );
        }
      }
    }
  });

  it('takes the place of a picture already showing from there: two at one point would show one', () => {
    const b = '[image: b.jpg]';
    // The pictures-only line above, the caret on that line, or a blank line below it.
    expect(insertImageLine('One.\n[image: a.jpg]\nTwo.', 21, b).text).toBe('One.\n[image: b.jpg]\nTwo.');
    expect(insertImageLine('One.\n[image: a.jpg]\nTwo.', 7, b).text).toBe('One.\n[image: b.jpg]\nTwo.');
    expect(insertImageLine('[IMAGE: a.jpg]\n\nTwo.', 15, b).text).toBe('[image: b.jpg]\n\nTwo.');
    expect(insertImageLine('One.\n\nTwo.', 5, b).text).toBe('One.\n[image: b.jpg]\n\nTwo.');
    // Of tags at one point the last is the one showing; a tag the words start with counts too.
    expect(insertImageLine('[image: a.jpg] [image: c.jpg]\nTwo.', 30, b).text).toBe(
      '[image: a.jpg] [image: b.jpg]\nTwo.',
    );
    expect(insertImageLine('One.\n[image: a.jpg] Two.', 20, b).text).toBe('One.\n[image: b.jpg] Two.');
    expect(insertImageAtLineStart('[image: a.jpg] He said hi.', 20, b).text).toBe('[image: b.jpg] He said hi.');
    expect(insertImageAtLineStart('[image: a.jpg]\nHe said hi.', 20, b).text).toBe('[image: b.jpg]\nHe said hi.');
    // A picture placed further up shows until here, but from elsewhere: it stays.
    expect(insertImageLine('[image: a.jpg]\nOne.\nTwo.', 20, b).text).toBe(
      '[image: a.jpg]\nOne.\n[image: b.jpg]\nTwo.',
    );
    expect(insertImageLine('One [image: a.jpg] two.\nThree.', 25, b).text).toBe(
      'One [image: a.jpg] two.\n[image: b.jpg]\nThree.',
    );
  });

  it('removed alone on its line, takes its line with it (no paragraph appears)', () => {
    const text = 'One.\n[image: a.jpg]\nTwo.';
    expect(removeToken(text, token('[image: a.jpg]', text)).text).toBe('One.\nTwo.');
    const last = 'One.\n[image: a.jpg]';
    expect(removeToken(last, token('[image: a.jpg]', last)).text).toBe('One.');
    const inline = 'One [image: a.jpg] two.';
    expect(removeToken(inline, token('[image: a.jpg]', inline)).text).toBe('One two.');
  });

  it('is no unknown tag to the script check; the shared parser cases cover the render', () => {
    expect(validateScript('# One\nA.\n[image: a.jpg]\nB.')).toEqual([]);
  });
});
