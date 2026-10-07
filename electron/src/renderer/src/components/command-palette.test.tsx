import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de' } }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/hooks/use-history', () => ({ useHistory: () => ({ data: [] }) }));
vi.mock('@/hooks/use-profiles', () => ({ useProfiles: () => ({ data: [] }) }));
vi.mock('@/hooks/use-generate', () => ({
  useGenerateClone: () => ({ generate: vi.fn(), isGenerating: false }),
}));
vi.mock('@/components/keyboard-cheatsheet', () => ({
  KeyboardCheatsheet: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="keyboard.title" /> : null,
}));
import { CommandPalette } from './command-palette';

afterEach(cleanup);

const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};

it("leaves `/` typed with Shift to a search box: on German, French or Russian keys that is `/`", () => {
  render(<CommandPalette />);
  // Shift+7 on a German layout, Shift+: on AZERTY, Shift+\ on Russian.
  const slash = press({ key: '/', shiftKey: true });
  expect(slash.defaultPrevented).toBe(false);
  expect(screen.queryByRole('dialog', { name: 'keyboard.title' })).toBeNull();
  // `?` still opens the shortcuts, on every layout.
  press({ key: '?', shiftKey: true });
  expect(screen.getByRole('dialog', { name: 'keyboard.title' })).toBeInTheDocument();
});
