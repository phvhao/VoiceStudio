import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const setEnabled = vi.fn(async (enabled: boolean) => ({
  languages: enabled ? ['vi', 'en-US'] : [],
  available: false,
}));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  setEnabled.mockClear();
  Object.defineProperty(window, 'voicestudio', {
    configurable: true,
    value: { spellcheck: { setEnabled } },
  });
});
afterEach(() => {
  delete (window as { voicestudio?: unknown }).voicestudio;
});

it('is off by default, persists a choice and tells the desktop checker', async () => {
  const store = await import('./use-script-spellcheck');
  const hook = renderHook(() => [store.useScriptSpellcheck(), store.useSpellcheckState()] as const);
  expect(hook.result.current).toEqual([false, null]);

  await act(async () => store.setScriptSpellcheck(true));
  expect(localStorage.getItem('voicestudio.script-spellcheck.v1')).toBe('on');
  expect(setEnabled).toHaveBeenLastCalledWith(true);
  expect(hook.result.current).toEqual([true, { languages: ['vi', 'en-US'], available: false }]);

  await act(async () => store.setScriptSpellcheck(false));
  expect(setEnabled).toHaveBeenLastCalledWith(false);
  expect(hook.result.current[0]).toBe(false);
});

it('sets the checker languages at startup only when it was left on', async () => {
  (await import('./use-script-spellcheck')).installScriptSpellcheck();
  expect(setEnabled).not.toHaveBeenCalled();

  localStorage.setItem('voicestudio.script-spellcheck.v1', 'on');
  vi.resetModules();
  (await import('./use-script-spellcheck')).installScriptSpellcheck();
  expect(setEnabled).toHaveBeenCalledWith(true);
});

it('works without the desktop bridge (browser tab, tests)', async () => {
  delete (window as { voicestudio?: unknown }).voicestudio;
  const store = await import('./use-script-spellcheck');
  expect(() => store.setScriptSpellcheck(true)).not.toThrow();
});

it('drives the spellcheck of the script editor', async () => {
  const store = await import('./use-script-spellcheck');
  const { MarkupTextarea } = await import('@/features/longform/markup-textarea');
  render(<MarkupTextarea aria-label="script" value="xin chào" onValueChange={() => {}} />);
  expect(screen.getByRole('textbox', { name: 'script' })).toHaveAttribute('spellcheck', 'false');
  await act(async () => store.setScriptSpellcheck(true));
  expect(screen.getByRole('textbox', { name: 'script' })).toHaveAttribute('spellcheck', 'true');
});

const sources = import.meta.glob('../features/**/*.tsx', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

// Every field whose text is spoken follows the setting; none decides on its own.
const SPOKEN_FIELDS = [
  'features/longform/markup-textarea.tsx',
  'features/longform/story-editor.tsx',
  'features/longform/book-outline.tsx',
  'features/clone/reference-panel.tsx',
  'features/clone/edit-profile.tsx',
  'features/clone/profile-preview.tsx',
  'features/tools/compare-voices.tsx',
  'features/tools/tools-page.tsx',
  'features/workflows/workflow-inputs.tsx',
  'features/integrations/twilio-setup.tsx',
  'features/calls/new-call-form.tsx',
  'features/settings/pronunciation-settings.tsx',
  'features/dub/dub-page.tsx',
  'features/dub/dubbing-demo.tsx',
  'features/dub/paste-translation.tsx',
];

it.each(SPOKEN_FIELDS)('%s takes its spellcheck from the setting', (file) => {
  const source = sources[`../${file}`];
  expect(source).toContain('useScriptSpellcheck()');
  expect(source).toMatch(/spellCheck=\{[^}]*spellcheck/);
  // A bare `spellCheck` forces it on.
  expect(source).not.toMatch(/\sspellCheck\s*\n/);
});
