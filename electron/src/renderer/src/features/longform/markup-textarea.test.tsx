import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import {
  MarkupEditorContext,
  type MarkupEditorEvents,
  type MarkupEditorHandle,
} from './markup-editor-context';
import {
  HIGHLIGHT_LIMIT,
  LABEL_BOX_EM,
  MARKUP_STYLES,
  MarkupTextarea,
  gutterLabels,
  laneSegments,
  revealOffset,
} from './markup-textarea';
import { EditorStatusBar, createCaretSource } from './editor-status-bar';
import { DEFAULT_VOICE_ACCENT, VOICE_ACCENTS, VOICE_RESET_CHIP } from './voice-palette';

// What the editor reads its text with: the tokenizer (on what) and the voice switches.
const reads = vi.hoisted(() => ({ tokenized: [] as string[], switches: 0 }));
vi.mock('./script-markup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./script-markup')>();
  return {
    ...actual,
    tokenizeMarkup: (...args: Parameters<typeof actual.tokenizeMarkup>) => {
      reads.tokenized.push(args[0]);
      return actual.tokenizeMarkup(...args);
    },
    voiceSwitches: (...args: Parameters<typeof actual.voiceSwitches>) => {
      reads.switches += 1;
      return actual.voiceSwitches(...args);
    },
  };
});

type EditorProps = Omit<ComponentProps<typeof MarkupTextarea>, 'value' | 'onValueChange'>;

function Editor({
  initial,
  events,
  ...props
}: EditorProps & { initial: string; events?: MarkupEditorEvents }) {
  const [text, setText] = useState(initial);
  const editor = (
    <MarkupTextarea aria-label="Script" value={text} onValueChange={setText} {...props} />
  );
  return events ? (
    <MarkupEditorContext.Provider value={events}>{editor}</MarkupEditorContext.Provider>
  ) : (
    editor
  );
}

const script = () => screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
const lines = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-slot="markup-lines"] > div'),
];
// What the overlay shows, read back as the text it mirrors.
const overlayText = (container: HTMLElement) =>
  lines(container)
    .map((line) => line.textContent!.replaceAll('​', ''))
    .join('\n');
const caretAt = (start: number, end = start) => {
  script().setSelectionRange(start, end);
  fireEvent.keyUp(script());
};
const focus = () => act(() => script().focus());
const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

afterEach(() => vi.restoreAllMocks());

describe('overlay', () => {
  it.each([
    '',
    'one line',
    'two\nlines',
    'trailing newline\n',
    '\n\nleading blank lines',
    'a\n\n\nb',
    '# Chapter\n[voice:Mara] Hi [pause 1s]\n[slow]across\nlines[/slow]\n',
    '[a tag\nbroken across lines] and [[gif|jiff]]',
  ])('mirrors %j line for line', (text) => {
    const { container } = render(<Editor initial={text} headings gutter activeLine />);
    expect(overlayText(container)).toBe(text);
    expect(lines(container)).toHaveLength(text.split('\n').length);
  });

  it('counts lines the way the textarea does with Windows line endings', () => {
    const { container } = render(<Editor initial={'one\r\ntwo\rthree'} />);
    expect(overlayText(container)).toBe('one\ntwo\nthree');
  });

  it('numbers every line in the gutter, outside the mirrored text', () => {
    const { container } = render(<Editor initial={'one\n\nthree\n'} gutter />);
    expect(lines(container).map((line) => line.dataset.line)).toEqual(['1', '2', '3', '4']);
    expect(overlayText(container)).toBe('one\n\nthree\n');
  });

  it('marks chapters, sections and the untitled intro in the gutter', () => {
    const text = '\nAn opening.\nMore.\n# One\nText.\n## Part\nx\n### Deep\n# Two\ny';
    const { container } = render(<Editor initial={text} headings gutter />);
    const gutter = lines(container).map((line) => line.dataset.line);
    expect(gutter).toEqual(['1', 'Intro', '3', 'C1', '5', '§', '7', '§', 'C2', '10']);
    const intro = lines(container)[1];
    expect(intro).toHaveAttribute('data-intro');
    expect(lines(container)[3]).toHaveAttribute('data-chapter');
    expect(lines(container)[5]).toHaveAttribute('data-section');
    // The marks are painted from the attribute: the mirrored text is unchanged.
    expect(overlayText(container)).toBe(text);
  });

  it('keeps each gutter label on one row of a box that grows with the zoom', () => {
    const { container } = render(<Editor initial={'Intro.\n# One\nx'} headings gutter />);
    const label = lines(container)[0];
    // A second row would paint over the next line's number.
    for (const name of ['whitespace-nowrap', 'overflow-hidden', 'text-ellipsis'])
      expect(label.className).toContain('before:' + name);
    // Box, lane and gutter are sized in the text's em, as the label's font is.
    expect(label.className).toContain('before:w-[calc(3.25em/0.6875)]');
    expect(label.className).not.toMatch(/before:w-\d/);
    expect(screen.getByRole('textbox', { name: 'Script' }).className).toContain('ps-[4.5em]');
  });

  it("fits every locale's gutter labels in the label box", () => {
    // Inter's advances, rounded up: tabular digits 0.648em, a CJK glyph 1em.
    const advance = (char: string) =>
      /\d/.test(char)
        ? 0.648
        : /\s/.test(char)
          ? 0.28
          : /[.,·]/.test(char)
            ? 0.3
            : /[\u2e80-\u9fff\uac00-\ud7af]/.test(char)
              ? 1
              : char === char.toUpperCase() && char !== char.toLowerCase()
                ? 0.72
                : 0.6;
    const width = (label: string) => [...label].reduce((sum, char) => sum + advance(char), 0);
    const locales = import.meta.glob<{ editor: Record<string, string> }>(
      '../../i18n/locales/*.json',
      { eager: true, import: 'default' },
    );
    expect(Object.keys(locales).length).toBeGreaterThanOrEqual(21);
    for (const [file, catalog] of Object.entries(locales)) {
      const labels = [
        catalog.editor.gutter_intro,
        catalog.editor.gutter_chapter.replace('{{n}}', '99'),
        '99999',
      ];
      for (const label of labels)
        expect(width(label), `${file}: ${label}`).toBeLessThanOrEqual(LABEL_BOX_EM);
    }
  });

  it('labels no intro without chapters, nor without text before the first one', () => {
    const plain = (text: string) =>
      gutterLabels(
        text
          .split('\n')
          .map((line) => [
            { text: line, kind: line.startsWith('# ') ? ('heading' as const) : ('text' as const) },
          ]),
        true,
        { chapter: (n) => `C${n}`, section: '§', intro: 'Intro' },
      ).map((label) => label.text);
    expect(plain('Just text.\nMore.')).toEqual(['1', '2']);
    expect(plain('\n# One\nx')).toEqual(['1', 'C1', '3']);
    expect(plain('# One\nx')).toEqual(['C1', '2']);
  });

  it('turns the spelling check off, which flags every word of a Vietnamese script', () => {
    render(<Editor initial="Xin chào" />);
    expect(script()).toHaveAttribute('spellcheck', 'false');
  });

  it('sizes both layers alike, so the overlay follows a zoom', () => {
    const style = { fontSize: '1.2rem', lineHeight: '2.1rem' };
    const { container, rerender } = render(
      <MarkupTextarea
        aria-label="Script"
        value="Hello"
        onValueChange={() => {}}
        textStyle={style}
      />,
    );
    const overlay = container.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    for (const layer of [overlay, script()]) {
      expect(layer.style.fontSize).toBe('1.2rem');
      expect(layer.style.lineHeight).toBe('2.1rem');
    }
    rerender(
      <MarkupTextarea
        aria-label="Script"
        value="Hello"
        onValueChange={() => {}}
        textStyle={{ fontSize: '0.8rem', lineHeight: '1.4rem' }}
      />,
    );
    expect(overlay.style.fontSize).toBe('0.8rem');
    expect(script().style.lineHeight).toBe('1.4rem');
  });

  it('keeps tags broken across lines highlighted on both lines', () => {
    const { container } = render(<Editor initial={'[slow]\n[a tag\nbroken]'} />);
    const kinds = [...container.querySelectorAll('mark')].map((mark) => [
      mark.textContent,
      mark.dataset.kind,
      mark.dataset.from,
    ]);
    expect(kinds).toEqual([
      ['[slow]', 'delivery', '0'],
      ['[a tag', 'unknown', '0'],
      ['broken]', 'unknown', '0'],
    ]);
  });

  it('reads again only the line a keystroke changes, and draws what a fresh editor draws', () => {
    const book = [
      '# One',
      '[voice:Mara] Hi [pause 1s] there.',
      '## Part [voice:Ben] two',
      '[slow]Slowly[/slow] and [[gif|jiff]].',
      '',
      'Last line.',
    ].join('\n');
    const editor = (text: string, label = 'Script') => (
      <MarkupTextarea
        aria-label={label}
        value={text}
        onValueChange={() => {}}
        headings
        gutter
        activeLine
        voices={['Mara', 'Ben']}
      />
    );
    // Each node with its attributes, in whatever order an update set them.
    const shape = (node: Node): unknown =>
      node instanceof Element
        ? [
            node.tagName,
            Object.fromEntries([...node.attributes].map((attr) => [attr.name, attr.value])),
            [...node.childNodes].map(shape),
          ]
        : node.textContent;
    const drawn = (container: HTMLElement) =>
      shape(container.querySelector('[data-slot="markup-lines"]')!);
    const fresh = (text: string) => {
      const view = render(editor(text, 'Fresh'));
      const html = drawn(view.container);
      view.unmount();
      return html;
    };
    const view = render(editor(book));
    for (const text of [
      book.replace('Hi', 'Hi you'),
      // A tag left open runs into the lines below, and is closed again.
      book.replace('Hi', 'Hi [voi'),
      book.replace('Hi', 'Hi [voice:Ben]'),
      book.replace('Last line.', '# Two\nLast line.'),
      book,
    ]) {
      view.rerender(editor(text));
      expect(drawn(view.container)).toEqual(fresh(text));
    }
    reads.tokenized = [];
    view.rerender(editor(book.replace('there.', 'there!')));
    expect(reads.tokenized).toEqual(['[voice:Mara] Hi [pause 1s] there!']);
  });

  it('reads the voice switches once for the editor and its status bar', () => {
    const text = '[voice:Mara] Once\n# One\n[voice:Ben] read for both';
    reads.switches = 0;
    render(
      <>
        <MarkupTextarea aria-label="Script" value={text} onValueChange={() => {}} headings gutter />
        <EditorStatusBar
          text={text}
          caret={createCaretSource()}
          headings
          names={['Mara', 'Ben']}
          voiceCast={{}}
          profiles={[]}
        />
      </>,
    );
    expect(reads.switches).toBe(1);
  });

  it('colors each voice tag by its name and outlines the way back to the default', () => {
    const { container } = render(
      <Editor
        initial="[voice:Mara] a [voice:Ben] b [voice:Mara] c [voice:Zed] [voice:]"
        voices={['Mara', 'Ben']}
      />,
    );
    const marks = [...container.querySelectorAll('mark')];
    expect(marks[0].className).toContain('bg-sky-500/18');
    expect(marks[1].className).toContain('bg-amber-500/18');
    expect(marks[2].className).toBe(marks[0].className);
    expect(marks[3].className).toContain('bg-muted-foreground/12');
    expect(marks[4].className).toContain('outline-dashed');
  });

  it('gives every voice the same color without a palette', () => {
    const { container } = render(<Editor initial="[voice:Mara] a [voice:Ben] b" />);
    const [mara, ben] = container.querySelectorAll('mark');
    expect(mara.className).toBe(ben.className);
    expect(mara.className).toContain('bg-sky-500/18');
  });

  it('draws chapters as bands and bands the caret line only while editing', () => {
    const { container } = render(<Editor initial={'# One\nText'} headings activeLine gutter />);
    const [heading, body] = lines(container);
    expect(heading).toHaveAttribute('data-chapter');
    expect(heading.querySelector('mark')!.className).not.toContain('ring-1');
    expect(body).not.toHaveAttribute('data-active');
    focus();
    caretAt(8);
    expect(lines(container)[1]).toHaveAttribute('data-active');
    expect(lines(container)[1].querySelector('span')).not.toBeNull();
    act(() => script().blur());
    expect(lines(container)[1]).not.toHaveAttribute('data-active');
  });

  it('draws a section heading as a lighter band, its tags still tags', () => {
    const { container } = render(
      <Editor initial={'# One\n## Part [voice:Mara] two\nText'} headings activeLine gutter />,
    );
    const [chapter, section, body] = lines(container);
    expect(chapter).not.toHaveAttribute('data-section');
    expect(section).toHaveAttribute('data-section');
    expect(section).not.toHaveAttribute('data-chapter');
    expect(body).not.toHaveAttribute('data-section');
    const kinds = [...section.querySelectorAll('mark')].map((mark) => mark.dataset.kind);
    expect(kinds).toEqual(['section', 'voice']);
  });

  it('reveals a line inside the editor, caret included', () => {
    render(<Editor initial={'# One\nText\n## Two\nMore'} headings activeLine gutter />);
    const offset = script().value.indexOf('## Two');
    act(() => revealOffset(script(), offset));
    expect(script()).toHaveFocus();
    expect(script().selectionStart).toBe(offset);
    expect(script().scrollTop).toBe(0); // jsdom has no layout: the top line stays
  });

  it('reveals a line of a book too long to highlight by where it wraps', () => {
    // Long paragraphs wrap over several rows each: counting lines would land
    // chapters away. jsdom has no layout, so the copy that wraps reports a top.
    const paragraph = 'word '.repeat(120).trim();
    const text = Array.from({ length: 400 }, (_, i) => `# Ch ${i}\n${paragraph}`).join('\n');
    expect(text.length).toBeGreaterThan(HIGHLIGHT_LIMIT);
    render(<Editor initial={text} headings />);
    const offset = text.indexOf('# Ch 300');
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        const before = this.parentElement?.textContent ?? '';
        // Six rows of 28px per paragraph, one per heading.
        return before.startsWith('# Ch 0') ? 300 * (6 + 1) * 28 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    act(() => revealOffset(script(), offset));
    expect(script().selectionStart).toBe(offset);
    expect(script().scrollTop).toBe(300 * 7 * 28 - 200);
  });

  it('only paints, so the overlay cannot drift from the caret', () => {
    // Anything that changes glyph metrics would move text under the caret.
    const metric =
      /^-?[pm][xytrblse]?-|^(?:font|tracking|leading|indent)-|^text-(?:xs|sm|base|lg|\d?xl|\[)|^border(?:-[xytrblse])?(?:-\d+)?$/;
    const styles = [
      ...Object.values(MARKUP_STYLES),
      ...[...VOICE_ACCENTS, DEFAULT_VOICE_ACCENT].map((accent) => accent.chip),
      VOICE_RESET_CHIP,
    ];
    for (const style of styles)
      for (const name of style.split(/\s+/))
        expect(name.split(':').pop(), style).not.toMatch(metric);
  });
});

describe('tags as controls', () => {
  it('opens the tag at the caret with Alt+Enter', () => {
    const onTokenActivate = vi.fn();
    render(<Editor initial="Wait [pause 1s] here" events={{ onTokenActivate }} />);
    focus();
    caretAt('Wait '.length);
    expect(fireEvent.keyDown(script(), { key: 'Enter', altKey: true })).toBe(false);
    expect(onTokenActivate).toHaveBeenCalledWith(
      { start: 5, end: 15, text: '[pause 1s]', kind: 'pause' },
      expect.objectContaining({ element: script() }),
      'keyboard',
    );
  });

  it('leaves Alt+Enter alone away from tags, and in a locked editor', () => {
    const onTokenActivate = vi.fn();
    const { rerender } = render(<Editor initial="Plain [pause 1s]" events={{ onTokenActivate }} />);
    caretAt(2);
    expect(fireEvent.keyDown(script(), { key: 'Enter', altKey: true })).toBe(true);
    rerender(<Editor initial="Plain [pause 1s]" events={{ onTokenActivate }} disabled />);
    caretAt(8);
    expect(fireEvent.keyDown(script(), { key: 'Enter', altKey: true })).toBe(true);
    expect(onTokenActivate).not.toHaveBeenCalled();
  });

  it('reads a tag in a chapter heading as part of the title', () => {
    const onTokenActivate = vi.fn();
    render(<Editor initial={'# One [voice:Mara]\nText'} headings events={{ onTokenActivate }} />);
    caretAt(9);
    expect(fireEvent.keyDown(script(), { key: 'Enter', altKey: true })).toBe(true);
    fireEvent.click(script());
    expect(onTokenActivate).not.toHaveBeenCalled();
  });

  it('opens a tag clicked inside it, not one the caret merely lands beside', () => {
    const onTokenActivate = vi.fn();
    render(<Editor initial="Wait [pause 1s] here" events={{ onTokenActivate }} />);
    script().setSelectionRange(5, 5);
    fireEvent.click(script());
    expect(onTokenActivate).not.toHaveBeenCalled();
    script().setSelectionRange(8, 8);
    fireEvent.click(script());
    expect(onTokenActivate).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[pause 1s]' }),
      expect.objectContaining({ element: script() }),
      'pointer',
    );
  });

  it('does not open a tag when the click selects text', () => {
    const onTokenActivate = vi.fn();
    render(<Editor initial="Wait [pause 1s] here" events={{ onTokenActivate }} />);
    script().setSelectionRange(6, 9);
    fireEvent.click(script());
    script().setSelectionRange(8, 8);
    fireEvent.click(script(), { detail: 2 });
    fireEvent.click(script(), { shiftKey: true });
    expect(onTokenActivate).not.toHaveBeenCalled();
  });

  it('lets the tools consume a key before the textarea sees it', () => {
    const onEditorKeyDown = vi.fn(() => true);
    render(<Editor initial="x" events={{ onEditorKeyDown }} />);
    expect(fireEvent.keyDown(script(), { key: 'ArrowDown' })).toBe(false);
    expect(onEditorKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'ArrowDown' }),
      expect.objectContaining({ element: script() }),
    );
  });

  it('tells the tools about input, caret moves, scrolling and leaving', () => {
    const onEditorChange = vi.fn();
    render(<Editor initial="Hello" events={{ onEditorChange }} />);
    focus();
    fireEvent.change(script(), { target: { value: 'Hello!' } });
    caretAt(1);
    caretAt(1);
    fireEvent.scroll(script());
    act(() => script().blur());
    expect(onEditorChange.mock.calls.map(([, reason]) => reason)).toEqual([
      'caret',
      'input',
      'caret',
      'scroll',
      'blur',
    ]);
  });

  it('reports the caret while the editor has focus', () => {
    const onCaretChange = vi.fn();
    render(<Editor initial={'ab\ncd'} onCaretChange={onCaretChange} />);
    caretAt(4);
    expect(onCaretChange).not.toHaveBeenCalled();
    focus();
    expect(onCaretChange).toHaveBeenLastCalledWith(4);
    script().setSelectionRange(1, 1);
    fireEvent.click(script());
    expect(onCaretChange).toHaveBeenLastCalledWith(1);
    fireEvent.change(script(), { target: { value: 'ab\ncd!' } });
    expect(onCaretChange).toHaveBeenLastCalledWith(6);
  });

  it('marks the tag holding the caret while tools listen', () => {
    const { container } = render(
      <Editor initial="a [pause 1s] b" events={{ onTokenActivate: vi.fn() }} />,
    );
    focus();
    caretAt(5);
    expect(container.querySelector('mark')).toHaveAttribute('data-current');
    caretAt(0);
    expect(container.querySelector('mark')).not.toHaveAttribute('data-current');
  });

  it('keeps tags inert without tools around the editor', () => {
    const { container } = render(<Editor initial="a [pause 1s] b" />);
    focus();
    caretAt(5);
    fireEvent.keyDown(script(), { key: 'Enter', altKey: true });
    fireEvent.click(script());
    expect(container.querySelector('mark')).not.toHaveAttribute('data-current');
  });
});

describe('pointer', () => {
  // jsdom has no layout: give the overlay, its line and the tag boxes.
  function layOut(container: HTMLElement) {
    const overlay = container.querySelector<HTMLElement>('[data-slot="markup-textarea"] > div')!;
    overlay.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
    const [line] = lines(container);
    Object.defineProperty(line, 'offsetTop', { configurable: true, value: 12 });
    Object.defineProperty(line, 'offsetHeight', { configurable: true, value: 28 });
    const mark = container.querySelector('mark')!;
    mark.getClientRects = () => [new DOMRect(30, 16, 90, 20)] as unknown as DOMRectList;
    return mark;
  }

  it('shows a pointer and a hint over a tag, and clears them on leaving', async () => {
    const { container } = render(
      <Editor initial="Hi [voice:Mara] there" events={{ onTokenActivate: vi.fn() }} />,
    );
    const mark = layOut(container);
    fireEvent.pointerMove(script(), { clientX: 50, clientY: 20 });
    await nextFrame();
    expect(mark).toHaveAttribute('data-hover');
    expect(script().style.cursor).toBe('pointer');
    expect(script().title).toBe('Voice “Mara” — click to edit, right-click for more');
    fireEvent.pointerMove(script(), { clientX: 200, clientY: 20 });
    await nextFrame();
    expect(mark).not.toHaveAttribute('data-hover');
    fireEvent.pointerMove(script(), { clientX: 50, clientY: 20 });
    await nextFrame();
    fireEvent.pointerLeave(script());
    expect(mark).not.toHaveAttribute('data-hover');
    expect(script().style.cursor).toBe('');
    expect(script()).not.toHaveAttribute('title');
  });

  it('warns about tags the page does not read, without tools and without a pointer', async () => {
    for (const [initial, hint] of [
      [
        'Hi [voice:Mara] there',
        'Not used on this page: voice, delivery and volume tags work in Audiobook and Stories. Here the tag is read aloud as written.',
      ],
      ['Hi [whisper] there', 'Unrecognized tag, read aloud as written'],
    ]) {
      const { container, unmount } = render(
        <Editor initial={initial} unsupported={['voice', 'voiceReset', 'delivery', 'volume']} />,
      );
      const mark = layOut(container);
      expect(mark.dataset.kind).toBe('unknown');
      expect(mark.className).toContain('decoration-wavy');
      fireEvent.pointerMove(script(), { clientX: 50, clientY: 20 });
      await nextFrame();
      expect(script().title).toBe(hint);
      expect(script().style.cursor).toBe('');
      unmount();
    }
  });

  it('gives no hover hint over a tag the page reads when nothing opens it', async () => {
    const { container } = render(
      <Editor initial="Hi [pause 1s] there" unsupported={['voice', 'voiceReset']} />,
    );
    const mark = layOut(container);
    expect(mark.dataset.kind).toBe('pause');
    fireEvent.pointerMove(script(), { clientX: 50, clientY: 20 });
    await nextFrame();
    expect(script()).not.toHaveAttribute('title');
  });

  it('says how loud a [volume] passage reads, and where it ends', async () => {
    for (const [initial, hint] of [
      ['Hi [volume -6dB]there', 'Volume -6 dB — click to edit, right-click for more'],
      ['Hi [/volume] there', 'End of a volume change — click to edit, right-click for more'],
    ]) {
      const { container, unmount } = render(
        <Editor initial={initial} events={{ onTokenActivate: vi.fn() }} />,
      );
      const mark = layOut(container);
      expect(mark.dataset.kind).toBe('volume');
      fireEvent.pointerMove(script(), { clientX: 50, clientY: 20 });
      await nextFrame();
      expect(script().title).toBe(hint);
      unmount();
    }
  });

  it('opens the tag under the pointer on a click, but not after a drag', () => {
    const onTokenActivate = vi.fn();
    const { container } = render(
      <Editor initial="Hi [voice:Mara] there" events={{ onTokenActivate }} />,
    );
    layOut(container);
    // Clicking the tag's last half puts the caret after it: the pointer decides.
    script().setSelectionRange(15, 15);
    fireEvent.pointerDown(script(), { clientX: 110, clientY: 20, button: 0 });
    fireEvent.click(script(), { clientX: 111, clientY: 20 });
    expect(onTokenActivate).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[voice:Mara]', start: 3 }),
      expect.anything(),
      'pointer',
    );
    onTokenActivate.mockClear();
    fireEvent.pointerDown(script(), { clientX: 50, clientY: 20, button: 0 });
    fireEvent.click(script(), { clientX: 80, clientY: 20 });
    // A press beside the tag never opens it, even with the caret inside.
    script().setSelectionRange(5, 5);
    fireEvent.pointerDown(script(), { clientX: 200, clientY: 20, button: 0 });
    fireEvent.click(script(), { clientX: 200, clientY: 20 });
    expect(onTokenActivate).not.toHaveBeenCalled();
  });
});

describe('handle', () => {
  function captureHandle(initial: string) {
    let handle: MarkupEditorHandle | null = null;
    render(
      <Editor
        initial={initial}
        events={{
          onEditorChange: (editor) => {
            handle = editor;
          },
        }}
      />,
    );
    focus();
    return handle!;
  }

  it('measures nothing without layout and anchors to the textarea instead', () => {
    const handle = captureHandle('Hi [pause 1s]');
    expect(handle.rectAt(3)).toBeNull();
    script().getBoundingClientRect = () => new DOMRect(1, 2, 300, 200);
    const anchor = handle.anchorAt(3, 13);
    expect(anchor.contextElement).toBe(script());
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 1, y: 2, width: 300, height: 200 });
  });

  it('measures a range on the overlay text under it', () => {
    const handle = captureHandle('First line\nSay [pause 1s] now\n\nEnd');
    const points: [string, string, number][] = [];
    const box = { x: 10, y: 20, width: 30, height: 16 };
    vi.spyOn(document, 'createRange').mockImplementation(
      () =>
        ({
          setStart: (node: Node, offset: number) =>
            points.push(['start', node.textContent!, offset]),
          setEnd: (node: Node, offset: number) => points.push(['end', node.textContent!, offset]),
          getClientRects: () => [new DOMRect(box.x, box.y, box.width, box.height)],
        }) as unknown as Range,
    );
    const start = 'First line\nSay '.length;
    expect(handle.rectAt(start, start + '[pause 1s]'.length)).toMatchObject(box);
    expect(points).toEqual([
      ['start', '[pause 1s]', 0],
      ['end', '[pause 1s]', 10],
    ]);
    points.length = 0;
    // An empty line measures its placeholder glyph.
    const empty = 'First line\nSay [pause 1s] now\n'.length;
    expect(handle.anchorAt(empty).getBoundingClientRect()).toMatchObject(box);
    expect(points).toEqual([
      ['start', '​', 0],
      ['end', '​', 0],
    ]);
  });
});

describe('laneSegments', () => {
  it('gives each stretch of the lane to the voice reading it', () => {
    expect(
      laneSegments(
        [
          { y: 40, voice: 'Mara' },
          { y: 96, voice: null },
        ],
        12,
        152,
      ),
    ).toEqual([
      { top: 12, height: 28, voice: null },
      { top: 40, height: 56, voice: 'Mara' },
      { top: 96, height: 56, voice: null },
    ]);
  });

  it('breaks the lane at a chapter heading, where the voice starts over', () => {
    expect(
      laneSegments(
        [
          { y: 12, voice: 'Mara' },
          { y: 40, voice: undefined },
          { y: 68, voice: null },
          { y: 96, voice: 'Mara' },
        ],
        0,
        124,
      ),
    ).toEqual([
      { top: 0, height: 12, voice: null },
      { top: 12, height: 28, voice: 'Mara' },
      // 40–68: the heading's row, no lane.
      { top: 68, height: 28, voice: null },
      { top: 96, height: 28, voice: 'Mara' },
    ]);
    // A default voice on both sides still shows the break.
    expect(
      laneSegments(
        [
          { y: 40, voice: undefined },
          { y: 68, voice: null },
        ],
        0,
        100,
      ),
    ).toEqual([
      { top: 0, height: 40, voice: null },
      { top: 68, height: 32, voice: null },
    ]);
  });

  it('leaves a shared row to its last switch and joins a voice to itself', () => {
    expect(
      laneSegments(
        [
          { y: 12, voice: 'Mara' },
          { y: 12, voice: 'Ben' },
          { y: 40, voice: 'Ben' },
        ],
        12,
        100,
      ),
    ).toEqual([{ top: 12, height: 88, voice: 'Ben' }]);
  });
});
