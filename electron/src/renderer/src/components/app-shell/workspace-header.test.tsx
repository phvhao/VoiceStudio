import { fireEvent, render, screen } from '@testing-library/react';
import { HistoryIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={`#${to}`} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/bridge', () => ({ isMac: () => false, getBridge: () => null }));
vi.mock('./sidebar-toggle', () => ({ SidebarToggle: () => null }));
vi.mock('./history-nav', () => ({ HistoryNav: () => null }));
vi.mock('./support-shortcut', () => ({ SupportShortcut: () => <span>support-shortcut</span> }));

import { WorkspaceHeader } from './workspace-header';
import { TITLEBAR_FIT_STEPS } from './titlebar-fit';

it('moves the screen’s buttons, Search, Get Pro and Star into its menu as the last step', async () => {
  // The last step hides the buttons and shows the menu, by CSS alone, so the
  // bar can measure the result before it paints.
  expect(TITLEBAR_FIT_STEPS.at(-1)).toBe('overflow');
  const showTakes = vi.fn();
  const commands = vi.fn();
  window.addEventListener('voicestudio:commands', commands);
  render(
    <WorkspaceHeader
      actions={[{ label: 'clone.history_title', icon: HistoryIcon, onSelect: showTakes }]}
    >
      <h1>clone.title</h1>
    </WorkspaceHeader>,
  );
  const inline = screen.getByRole('button', { name: 'clone.history_title' });
  expect(inline.closest('div')).toHaveClass('group-data-[fit~=overflow]/titlebar:hidden');
  const more = screen.getByRole('button', { name: 'common.more_actions' });
  expect(more).toHaveClass('hidden', 'group-data-[fit~=overflow]/titlebar:inline-flex');

  fireEvent.click(more);
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((item) => item.textContent)).toEqual([
    'clone.history_title',
    'preferences.searchCtrl K',
    'supportPlans.get_pro',
    'support.star_github',
  ]);
  expect(items[2]).toHaveAttribute('href', '#/pro');
  expect(items[3]).toHaveAttribute('target', '_blank');

  fireEvent.click(items[0]);
  expect(showTakes).toHaveBeenCalledOnce();
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole('menuitem', { name: /preferences.search/ }));
  expect(commands).toHaveBeenCalledOnce();
  window.removeEventListener('voicestudio:commands', commands);
});

it('reports the room its title needs to whoever shares its row', () => {
  const onRoom = vi.fn();
  render(
    <WorkspaceHeader onRoom={onRoom}>
      <h1>clone.title</h1>
    </WorkspaceHeader>,
  );
  expect(onRoom).toHaveBeenCalledWith(expect.any(Number));
  // The bar is not left measuring with every step taken.
  expect(screen.getByRole('banner').style.width).toBe('');
});
