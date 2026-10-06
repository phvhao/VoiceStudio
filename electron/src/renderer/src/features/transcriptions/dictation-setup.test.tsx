import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiJson: mock.api, describeError: String }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({ Link: (props: any) => <a>{props.children}</a> }));
import { DictationSetup } from './dictation-setup';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(onReady = vi.fn(), client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <DictationSetup onReady={onReady} />
    </QueryClientProvider>,
  );
  return onReady;
}

it('refreshes the native shortcut and status after turning dictation on', async () => {
  mock.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/dictation/models'
        ? {
            engine_available: true,
            models: [
              {
                id: 'installed',
                repo_id: 'owner/installed',
                label: 'Installed ASR',
                tag: 'offline',
                recommended: true,
                size_gb: 0.1,
                installed: true,
              },
            ],
          }
        : {},
    ),
  );
  const client = new QueryClient();
  // The shortcut's preferences are no longer polled, so a missed refresh would
  // leave the native shortcut off until the app restarts.
  for (const key of [['dictation-shortcut-prefs'], ['sidebar-dictation']])
    client.setQueryData(key, { enabled: false });
  const onReady = mount(vi.fn(), client);

  fireEvent.click(await screen.findByRole('button', { name: 'asr_missing.use' }));
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(client.getQueryState(['dictation-shortcut-prefs'])?.isInvalidated).toBe(true);
  expect(client.getQueryState(['sidebar-dictation'])?.isInvalidated).toBe(true);
});

it('selects an installed model inline without starting a download', async () => {
  mock.api.mockImplementation((path: string) => {
    if (path === '/dictation/models')
      return Promise.resolve({
        engine_available: true,
        models: [
          {
            id: 'installed',
            repo_id: 'owner/installed',
            label: 'Installed ASR',
            tag: 'offline',
            recommended: false,
            size_gb: 0.1,
            installed: true,
          },
        ],
      });
    return Promise.resolve({});
  });
  const onReady = mount();

  fireEvent.click(await screen.findByRole('button', { name: 'asr_missing.use' }));
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(mock.api).toHaveBeenCalledWith(
    '/dictation/prefs',
    expect.objectContaining({ body: JSON.stringify({ model_id: 'installed', enabled: true }) }),
  );
  expect(mock.api.mock.calls.some(([path]) => path === '/models/install')).toBe(false);
});

it('starts only the recommended model after an explicit click', async () => {
  mock.api.mockImplementation((path: string) => {
    if (path === '/dictation/models')
      return Promise.resolve({
        engine_available: true,
        models: [
          {
            id: 'recommended',
            repo_id: 'owner/recommended',
            label: 'Recommended ASR',
            tag: 'streaming',
            recommended: true,
            size_gb: 0.04,
            installed: false,
          },
        ],
      });
    if (path === '/models/install/status') return Promise.resolve({ jobs: [] });
    return Promise.resolve({});
  });
  mount();

  fireEvent.click(await screen.findByRole('button', { name: 'asr_missing.download' }));
  await waitFor(() =>
    expect(mock.api).toHaveBeenCalledWith(
      '/models/install',
      expect.objectContaining({
        body: JSON.stringify({ repo_id: 'owner/recommended', target: 'local' }),
      }),
    ),
  );
  expect(screen.getByRole('status')).toHaveTextContent('asr_missing.started');
});
