import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import {
  MarkupEditorContext,
  type MarkupEditorEvents,
  type MarkupEditorHandle,
} from './markup-editor-context';
import { MARKUP_STYLES, MarkupTextarea, laneSegments } from './markup-textarea';
import { DEFAULT_VOICE_ACCENT, VOICE_ACCENTS, VOICE_RESET_CHIP } from './voice-palette';

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
