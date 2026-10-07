import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A story built from a dub or subtitles runs to hundreds of lines. Typing in
// one re-renders that line's card alone, and a page render that changes
// nothing re-renders none: every card that renders again costs a keystroke
// over a millisecond.

const seen = vi.hoisted(() => ({ rows: 0 }));
vi.mock('react-i18next', () => {
  // One `t` throughout, as react-i18next keeps one until the language changes.
  const t = (key: string) => key;
  const i18n = { language: 'en', resolvedLanguage: 'en' };
  return { useTranslation: () => ({ t, i18n }) };
});
vi.mock('@/components/ui/button', async (importActual) => {
  const actual = await importActual<typeof import('@/components/ui/button')>();
  return {
    ...actual,
    // Every line, spoken or a chapter heading, renders one Move up button.
    Button: (props: ComponentProps<typeof actual.Button>) => {
      if (props['aria-label'] === 'stories.moveUp') seen.rows++;
      return <actual.Button {...props} />;
    },
  };
});
// Which cards render is the card's own doing: the editor, pickers and player
// under it are stand-ins, so 300 cards mount quickly.
vi.mock('./markup-editor-tools', () => ({
  MarkupEditorTools: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./markup-textarea', () => ({
  MarkupTextarea: (props: {
    value: string;
    onValueChange(value: string): void;
    textareaRef?: Ref<HTMLTextAreaElement>;
    'aria-label'?: string;
  }) => (
    <textarea
      ref={props.textareaRef}
      aria-label={props['aria-label']}
      value={props.value}
      onChange={(event) => props.onValueChange(event.target.value)}
    />
  ),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: ({ children, ...props }: { children: ReactNode; 'aria-label'?: string }) => (
    <button type="button" aria-label={props['aria-label']}>
      {children}
    </button>
  ),
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));
vi.mock('@/components/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  PopoverContent: () => null,
}));
vi.mock('@/components/waveform-player', () => ({ WaveformPlayer: () => null }));
vi.mock('./story-stems', () => ({ StoryStems: () => null }));
vi.mock('@/components/pipeline-failure', () => ({ PipelineFailure: () => null }));
import { StoryEditor } from './story-editor';
import { blankLongformDraft, type Draft } from './longform-session';

const LINES = 300;
// A chapter heading every 50 lines, as an imported book has them.
const story = (count: number): Draft => ({
  ...blankLongformDraft(),
  voice: 'narrator',
  lines: Array.from({ length: count }, (_, index) => ({
    id: `line-${index}`,
    text: index % 50 === 0 ? `# Chapter ${index / 50 + 1}` : `Line ${index} of the story.`,
    profileId: null,
  })),
});

let draft: Draft;
let renderPage: () => void;
// Like the page: a new `onChange` and, while the profiles load, a fresh `[]` on every render.
function Page({ count = LINES }: { count?: number }) {
  const [current, setCurrent] = useState(() => story(count));
  const [, setRenders] = useState(0);
  draft = current;
  renderPage = () => setRenders((count) => count + 1);
  return (
    <StoryEditor
      draft={current}
      profiles={[]}
      profilesLoading
      disabled={false}
      onChange={(patch) => setCurrent((last) => ({ ...last, ...patch }))}
    />
  );
}

// Selectors, not role queries: these lists run to hundreds of rows.
const lines = () => [
  ...document.querySelectorAll<HTMLElement>('textarea[aria-label="stories.linePlaceholder"]'),
];
const chapters = () => [
  ...document.querySelectorAll<HTMLElement>('input[aria-label="markup.chapter"]'),
];
const row = (line: HTMLElement) => within(line.closest<HTMLElement>('[class*="group/line"]')!);
const order = (count: number) => draft.lines.slice(0, count).map((line) => line.id);
const textOf = (id: string) => draft.lines.find((line) => line.id === id)?.text;

beforeEach(() => {
  seen.rows = 0;
});
afterEach(cleanup);

it('re-renders only the line typed in', () => {
  render(<Page />);
  expect(seen.rows).toBe(LINES);
  const line = lines()[150];
  fireEvent.focus(line);
  seen.rows = 0;
  fireEvent.change(line, { target: { value: 'Typed into one line.' } });
  fireEvent.change(line, { target: { value: 'Typed into one line, twice.' } });
  expect(seen.rows).toBe(2);
  expect(line).toHaveValue('Typed into one line, twice.');
});

it('re-renders no line when the page renders with nothing changed', () => {
  render(<Page />);
  seen.rows = 0;
  act(() => renderPage());
  expect(seen.rows).toBe(0);
});

it('keeps every edit when lines are typed in one after another', () => {
  render(<Page count={120} />);
  fireEvent.change(lines()[0], { target: { value: 'The first edit.' } });
  fireEvent.change(lines()[110], { target: { value: 'The second edit.' } });
  fireEvent.change(chapters()[2], { target: { value: 'Renamed' } });
  expect(textOf('line-1')).toBe('The first edit.');
  expect(textOf('line-113')).toBe('The second edit.');
  expect(textOf('line-100')).toBe('# Renamed');
});

it('moves and removes the line clicked', () => {
  render(<Page count={10} />);
  fireEvent.click(row(lines()[0]).getByRole('button', { name: 'stories.moveDown' }));
  expect(order(3)).toEqual(['line-0', 'line-2', 'line-1']);
  fireEvent.click(row(lines()[0]).getByRole('button', { name: 'stories.removeLine' }));
  expect(draft.lines).toHaveLength(9);
  expect(textOf('line-2')).toBeUndefined();
  fireEvent.click(row(lines()[0]).getByRole('button', { name: 'stories.moveUp' }));
  expect(order(2)).toEqual(['line-1', 'line-0']);
});
