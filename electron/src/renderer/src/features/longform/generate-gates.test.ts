import { afterEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { GenerateBlocker } from './generate-blocker';
import { LONGFORM_TARGET, describeGenerateBlockers, generateSteps } from './generate-gates';

const t = ((key: string) => key) as unknown as TFunction;
const ALL: GenerateBlocker[] = [
  'busy',
  'importing',
  'previewing',
  'engine_loading',
  'engine',
  'no_lines',
  'no_script',
  'voice',
  'default_voice',
  'cast_voice',
  'lexicon',
];

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it('says each reason in the words the panel already used, with a way to every fixable one', () => {
  const described = describeGenerateBlockers(ALL, { t, openSettings: vi.fn() });
  expect(described.map((blocker) => blocker.message)).toEqual(
    ALL.map((id) => 'audiobook.blocked.' + id),
  );
  const fixable = described.filter((blocker) => blocker.fix).map((blocker) => blocker.id);
  // A wait ends by itself; there is nothing on the page to go to.
  expect(fixable).toEqual([
    'engine',
    'no_lines',
    'no_script',
    'voice',
    'default_voice',
    'cast_voice',
    'lexicon',
  ]);
  for (const blocker of described)
    if (blocker.fix) expect(blocker.fix.label).toBe('gatedAction.show');
});

it('leads the other render to its own page, where it can be stopped', () => {
  const showRender = vi.fn();
  const [busy] = describeGenerateBlockers(['busy'], { t, openSettings: vi.fn(), showRender });
  busy.fix!.onSelect();
  expect(showRender).toHaveBeenCalledOnce();
});

it('goes to the engine notice, or to the engine settings when the page shows none', () => {
  vi.useFakeTimers();
  const openSettings = vi.fn();
  const [engine] = describeGenerateBlockers(['engine'], { t, openSettings });
  engine.fix!.onSelect();
  expect(openSettings).toHaveBeenCalledOnce();
  document.body.innerHTML = `<div data-gate-target="${LONGFORM_TARGET.engine}"><button>Fix</button></div>`;
  engine.fix!.onSelect();
  expect(openSettings).toHaveBeenCalledOnce();
  expect(document.activeElement).toHaveTextContent('Fix');
});

it('focuses the very control that fixes a voice or pronunciation gap', () => {
  vi.useFakeTimers();
  document.body.innerHTML = `
    <div data-gate-target="${LONGFORM_TARGET.defaultVoice}"><button>Default voice</button></div>
    <details data-gate-target="${LONGFORM_TARGET.cast}"><summary>Cast</summary>
      <div><button>Voice for Ann</button></div>
      <div data-gate-target="${LONGFORM_TARGET.castMissing}"><button>Voice for Mara</button></div>
    </details>
    <details><summary>Pronunciation</summary>
      <input aria-label="first" /><input aria-label="copy" data-gate-target="${LONGFORM_TARGET.lexicon}" />
    </details>`;
  const fixes = Object.fromEntries(
    describeGenerateBlockers(['default_voice', 'cast_voice', 'lexicon'], {
      t,
      openSettings: vi.fn(),
    }).map((blocker) => [blocker.id, blocker.fix!]),
  );
  fixes.default_voice.onSelect();
  expect(document.activeElement).toHaveTextContent('Default voice');
  // The name cast to a deleted voice, not merely the first one in the panel.
  fixes.cast_voice.onSelect();
  expect(document.activeElement).toHaveTextContent('Voice for Mara');
  fixes.lexicon.onSelect();
  expect(document.activeElement).toHaveAttribute('aria-label', 'copy');
  expect(document.querySelectorAll('details')[1]).toHaveProperty('open', true);
});

it('checks a book off as voice engine, script, voice and cast, in the order Generate does', () => {
  const setup = {
    engine: null,
    usable: true,
    voiceReady: false,
    casting: true,
    castReady: true,
  } as const;
  const book = generateSteps(t, 'audiobook', setup, { openSettings: vi.fn() });
  expect(book.map((step) => [step.label, step.done])).toEqual([
    ['gatedAction.step_engine', true],
    ['clone.script', true],
    ['audiobook.default_voice', false],
    ['audiobook.cast', true],
  ]);
  // A ready engine has nowhere on the page to go to.
  expect(book[0].onSelect).toBeUndefined();
  const story = generateSteps(
    t,
    'stories',
    { ...setup, casting: false },
    { openSettings: vi.fn() },
  );
  expect(story.map((step) => step.label)).toEqual([
    'gatedAction.step_engine',
    'clone.script',
    'gatedAction.step_voices',
  ]);
  expect(
    generateSteps(t, 'stories', setup, { openSettings: vi.fn() }).map((step) => step.label),
  ).toContain('stories.inline_voices');
});

it('leads an engine that is not set up to its notice or settings, and a starting one nowhere', () => {
  const openSettings = vi.fn();
  const base = { usable: true, voiceReady: true, casting: false, castReady: true };
  const [missing] = generateSteps(t, 'audiobook', { ...base, engine: 'engine' }, { openSettings });
  expect(missing.done).toBe(false);
  missing.onSelect!();
  expect(openSettings).toHaveBeenCalledOnce();
  const [starting] = generateSteps(
    t,
    'audiobook',
    { ...base, engine: 'loading' },
    { openSettings },
  );
  expect(starting.done).toBe(false);
  expect(starting.onSelect).toBeUndefined();
});
