import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({
  labels: vi.fn(async () => {}),
  language: 'en',
}));
vi.mock('react-i18next', async () => {
  const { useMemo } = await import('react');
  return {
    // A new `t` per language, like react-i18next's.
    useTranslation: () => {
      const language = desktop.language;
      return { t: useMemo(() => (key: string) => `${language}:${key}`, [language]) };
    },
  };
});
vi.mock('@/components/bridge', () => ({
  getBridge: () => ({ editMenu: { labels: desktop.labels } }),
}));

import { useNativeEditMenuLabels } from './native-edit-menu';

function Probe() {
  useNativeEditMenuLabels();
  return null;
}

it('labels the native edit menu in the app language and again when it changes', () => {
  const view = render(<Probe />);
  expect(desktop.labels).toHaveBeenLastCalledWith({
    undo: 'en:editMenu.undo',
    redo: 'en:editMenu.redo',
    cut: 'en:context.cut',
    copy: 'en:context.copy',
    paste: 'en:context.paste',
    selectAll: 'en:context.select_all',
    addToDictionary: 'en:editMenu.add_to_dictionary',
    noSuggestions: 'en:editMenu.no_suggestions',
  });
  desktop.language = 'vi';
  view.rerender(<Probe />);
  expect(desktop.labels).toHaveBeenCalledTimes(2);
  expect(desktop.labels).toHaveBeenLastCalledWith(
    expect.objectContaining({ paste: 'vi:context.paste' }),
  );
  view.rerender(<Probe />);
  expect(desktop.labels).toHaveBeenCalledTimes(2);
});
