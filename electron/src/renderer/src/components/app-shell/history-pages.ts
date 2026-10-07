import type { TFunction } from 'i18next';

/**
 * Each screen's title, as its own heading shows it, for "Back to: …". Settings
 * sections read "Settings › Appearance". Kept beside the routes it names by a
 * test that fails when a route has no title here.
 */
const SCREEN_TITLES: Record<string, string> = {
  '/': 'nav.home',
  '/clone': 'clone.title',
  '/personas': 'clone.saved_profiles',
  '/design': 'designWorkspace.title',
  '/gallery': 'nav.gallery',
  '/stories': 'nav.stories',
  '/audiobook': 'audiobook.title',
  '/dub': 'dubWorkspace.title',
  '/batch': 'nav.batch_dub',
  '/transcriptions': 'nav.transcribe',
  '/calls': 'workflows.title',
  '/projects': 'projects.title',
  '/tools': 'tools.title',
  '/integrations': 'integrationCatalog.title',
  '/pro': 'proPage.title',
};

const SETTINGS_TITLES: Record<string, string> = {
  appearance: 'preferences.appearance',
  general: 'preferences.general',
  models: 'modelSettings.models',
  media: 'settings.audio_tools',
  logs: 'settings.logs',
  pronunciation: 'pronunciation.title',
  reading: 'pacing.settings_title',
  updates: 'updates.tab',
  support: 'donate.title',
  network: 'settings.network',
  sharing: 'sharing.title',
  credentials: 'settings.credentials',
  performance: 'settings.compute_device_title',
  usage: 'settings.usage',
  workers: 'settings.workers_title',
  privacy: 'settings.privacy',
  permissions: 'permissions.title',
  storage: 'settings.storage',
  diagnostics: 'about.diagnostics',
  openapi: 'openapi.title',
};

/** The catalog key of a screen's title; null for a route this list does not know. */
export function screenTitleKey(pathname: string): string | null {
  if (pathname in SCREEN_TITLES) return SCREEN_TITLES[pathname];
  const [, root, section] = pathname.split('/');
  if (root === 'integrations' && section) return SCREEN_TITLES['/integrations'];
  if (root === 'settings' && section) return SETTINGS_TITLES[section] ?? null;
  return null;
}

/** A screen's title in the app's language, or null when it has none. */
export function screenTitle(pathname: string, t: TFunction): string | null {
  const key = screenTitleKey(pathname);
  if (!key) return null;
  return pathname.startsWith('/settings/') ? `${t('nav.settings')} › ${t(key)}` : t(key);
}
