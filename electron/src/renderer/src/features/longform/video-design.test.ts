import { describe, expect, it } from 'vitest';
import { blankLongformDraft } from './longform-session';
import { restoreHtmlDesign, designRequest } from './html-design';
import {
  DEFAULT_VIDEO_DESIGN,
  estimateVideoSeconds,
  restoreVideoDesign,
  scriptPictureNames,
  videoExportName,
  videoRequest,
} from './video-design';

describe('restoreVideoDesign', () => {
  it('keeps each known choice and replaces each unknown one on its own', () => {
    expect(restoreVideoDesign(null)).toBeNull();
    expect(
      restoreVideoDesign({
        aspect: '9:16',
        quality: 4320,
        motion: false,
        karaoke: 'yes',
        font: '../evil',
        size: 'l',
        accent: '#ABCDEF',
      }),
    ).toEqual({
      ...DEFAULT_VIDEO_DESIGN,
      aspect: '9:16',
      motion: false,
      size: 'l',
      accent: '#abcdef',
    });
  });
});

describe('videoRequest', () => {
  it('posts the finished book with its title, author and cover', () => {
    const draft = {
      ...blankLongformDraft(),
      output: 'story_ab.m4b',
      title: '  Book  ',
      metadata: { author: ' An ' },
      cover: { path: 'C:/x/audiobook_covers/ab12cd34ef56.png', name: 'cover.png' },
    };
    expect(videoRequest(draft as never, DEFAULT_VIDEO_DESIGN)).toMatchObject({
      output: 'story_ab.m4b',
      title: 'Book',
      author: 'An',
      cover_path: 'C:/x/audiobook_covers/ab12cd34ef56.png',
      aspect: '16:9',
      quality: 1080,
      font: null,
    });
    expect(videoExportName(draft as never)).toBe('Book.mp4');
    expect(videoExportName({ ...draft, title: '' } as never)).toBe('story_ab.mp4');
  });
});

it('estimates longer for 1080p and motion, never under ten seconds', () => {
  const still720 = estimateVideoSeconds(3600, { ...DEFAULT_VIDEO_DESIGN, quality: 720, motion: false });
  const moving1080 = estimateVideoSeconds(3600, DEFAULT_VIDEO_DESIGN);
  expect(moving1080).toBeGreaterThan(still720);
  expect(estimateVideoSeconds(1, DEFAULT_VIDEO_DESIGN)).toBe(10);
});

it('lists the pictures a book or story names now', () => {
  const draft = {
    ...blankLongformDraft(),
    script: '[image: a.jpg]\nText [image: b.png contain]',
    lines: [{ id: '1', text: '[image: c.jpg] Hi', character: '', profileId: null, speed: null }],
  };
  const names = (text: string) => Array.from(text.matchAll(/\[image:\s*([^\s\]]+)/g), (m) => m[1]);
  expect(scriptPictureNames(draft as never, 'audiobook', names)).toEqual(['a.jpg', 'b.png']);
  expect(scriptPictureNames(draft as never, 'stories', names)).toEqual(['c.jpg']);
});

describe('the HTML book opens in its slideshow on request', () => {
  const base = {
    template: 'classic',
    accent: '#8a2f1b',
    bodyFont: 'literata',
    headingFont: 'eb-garamond',
    showNames: false,
    numbering: 'words',
  };
  it('keeps the view only when it is the slideshow', () => {
    expect(restoreHtmlDesign(base)).toEqual(base);
    expect(restoreHtmlDesign({ ...base, view: 'show' })).toEqual({ ...base, view: 'show' });
    expect(restoreHtmlDesign({ ...base, view: 'weird' })).toEqual(base);
    expect(designRequest({ ...base, view: 'show' } as never)).toMatchObject({ view: 'show' });
    expect(designRequest(base as never)).not.toHaveProperty('view');
  });
});
