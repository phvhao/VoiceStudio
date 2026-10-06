import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ registerSchemesAsPrivileged: vi.fn() }));
vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: electron.registerSchemesAsPrivileged, handle: vi.fn() },
}));

import { APP_V8_CACHE_OPTIONS, registerAppScheme } from './protocol';

it('registers app:// with exactly the privileges the renderer relies on', () => {
  registerAppScheme();
  // Any change here changes what the renderer may do (fetch, CORS, media
  // streaming, CSP) or whether V8 may cache its scripts: review it as such.
  expect(electron.registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
        bypassCSP: false,
      },
    },
  ]);
});

it('lets every app:// window use the code cache from its second launch on', () => {
  expect(APP_V8_CACHE_OPTIONS).toBe('bypassHeatCheck');
  const main = join(process.cwd(), 'src/main');
  let windows = 0;
  for (const file of readdirSync(main).filter((name) => /(?<!\.test)\.ts$/.test(name))) {
    const source = readFileSync(join(main, file), 'utf8');
    const created = source.split('new BrowserWindow(').length - 1;
    windows += created;
    expect(source.split('v8CacheOptions: APP_V8_CACHE_OPTIONS').length - 1, file).toBe(created);
  }
  // The main window and the dictation recorder.
  expect(windows).toBeGreaterThanOrEqual(2);
});
