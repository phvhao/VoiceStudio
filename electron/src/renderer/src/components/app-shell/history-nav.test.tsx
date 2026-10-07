import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { page?: string }) => (values?.page ? `${key}:${values.page}` : key),
  }),
}));
vi.mock('@/components/bridge', () => ({ isMac: () => platform.mac, getBridge: () => null }));

import { HistoryNav } from './history-nav';
import { useInstallHistoryNavigation } from './history-navigation';

function Shell({
  history,
  screenKey,
}: {
  history: ReturnType<typeof createMemoryHistory>;
  screenKey: string;
}) {
  useInstallHistoryNavigation(history);
  // Each screen brings its own title bar, as the pages do.
  return <HistoryNav key={screenKey} />;
}

afterEach(() => {
  platform.mac = false;
});

it('is disabled with no history and names where Back and Forward lead', () => {
  const history = createMemoryHistory({ initialEntries: ['/'] });
  const view = render(<Shell history={history} screenKey="/" />);
  expect(screen.getByRole('button', { name: 'historyNav.back' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'historyNav.forward' })).toBeDisabled();

  act(() => history.push('/dub'));
  const back = screen.getByRole('button', { name: 'historyNav.back_to:nav.home' });
  expect(back).toBeEnabled();
  expect(back).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft');

  fireEvent.click(back);
  expect(history.location.pathname).toBe('/');
  expect(
    screen.getByRole('button', { name: 'historyNav.forward_to:dubWorkspace.title' }),
  ).toBeEnabled();
  view.unmount();
});

it('names the shortcut a Mac uses', () => {
  platform.mac = true;
  const history = createMemoryHistory({ initialEntries: ['/'] });
  render(<Shell history={history} screenKey="/" />);
  expect(screen.getByRole('button', { name: 'historyNav.back' })).toHaveAttribute(
    'aria-keyshortcuts',
    'Meta+[',
  );
});

it("hands the keyboard focus to the next screen's button after Back", () => {
  const history = createMemoryHistory({ initialEntries: ['/'] });
  const view = render(<Shell history={history} screenKey="/" />);
  act(() => history.push('/stories'));
  view.rerender(<Shell history={history} screenKey="/stories" />);
  const back = screen.getByRole('button', { name: 'historyNav.back_to:nav.home' });
  back.focus();
  fireEvent.click(back);
  // The pressed button leaves with its screen; the first screen has no Back,
  // so its Forward takes the focus.
  view.rerender(<Shell history={history} screenKey="/" />);
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'historyNav.forward_to:nav.stories' }),
  );
});
