import { expect, it } from 'vitest';
import en from '@/i18n/locales/en.json';
import routes from '@/routes/index.ts?raw';
import { screenTitle, screenTitleKey } from './history-pages';

/** The paths of the routes that render a screen (redirect-only routes have no component). */
function screenPaths(): string[] {
  return routes
    .split('createRoute({')
    .slice(1)
    .filter((block: string) => /\bcomponent:/.test(block.split('});')[0]))
    .map((block: string) => /path: '([^']+)'/.exec(block)?.[1])
    .filter((path): path is string => Boolean(path));
}

function catalogHas(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  return typeof node === 'string';
}

it('names every screen a route renders, with a title the catalog has', () => {
  const paths = screenPaths();
  expect(paths.length).toBeGreaterThan(30);
  const concrete = (path: string) =>
    path.replace('$family', 'tts').replace('$slug', 'some-integration');
  const missing = paths.filter((path) => !screenTitleKey(concrete(path)));
  expect(missing).toEqual([]);
  const unknownKeys = paths
    .map((path) => screenTitleKey(concrete(path))!)
    .filter((key) => !catalogHas(key));
  expect(unknownKeys).toEqual([]);
});

it('reads settings sections under Settings and leaves unknown routes unnamed', () => {
  const t = ((key: string) => `<${key}>`) as never;
  expect(screenTitle('/settings/general', t)).toBe('<nav.settings> › <preferences.general>');
  expect(screenTitle('/settings/models/asr', t)).toBe('<nav.settings> › <modelSettings.models>');
  expect(screenTitle('/dub', t)).toBe('<dubWorkspace.title>');
  expect(screenTitle('/somewhere-else', t)).toBeNull();
  expect(screenTitle('/settings', t)).toBeNull();
});
