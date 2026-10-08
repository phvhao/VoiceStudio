import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ json: vi.fn() }));

vi.mock('@/lib/api/client', async (load) => {
  const actual = await load<typeof import('@/lib/api/client')>();
  return { ...actual, apiJson: mock.json };
});
vi.mock('@tanstack/react-router', async (load) => ({
  ...(await load<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CredentialSettings } from './credential-settings';
import { NetworkSettings } from './network-settings';
import { WorkersSettings } from './workers-settings';

const RESPONSES: Record<string, unknown> = {
  '/system/info': { proxy_url: '' },
  '/api/settings/hf-token/state': { active: null, sources: [] },
  '/workers': { enabled: true, running: true, queue_depth: 0, workers: [] },
  '/workers/agent': { running: false, enrolled: false },
  '/workers/inbound': {
    enabled: false,
    running: false,
    bind: '127.0.0.1',
    port: 3911,
    exposed: false,
    keys: [],
    sessions: [],
    connections: [],
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each<[string, () => ReactElement, string, string[]]>([
  ['proxy', () => <NetworkSettings />, 'settings.proxy', ['common.save', 'settings.proxy_clear']],
  ['translation key', () => <CredentialSettings />, 'credentials.deepl_key', ['common.save']],
  ['join code', () => <WorkersSettings />, 'settings.worker_join_code', ['settings.worker_join']],
  [
    'connection string',
    () => <WorkersSettings />,
    'settings.inbound_connect_row',
    ['settings.inbound_connect'],
  ],
])('keeps the %s field on one line with its buttons', async (_, panel, label, buttons) => {
  mock.json.mockImplementation((path: string) =>
    path in RESPONSES ? Promise.resolve(RESPONSES[path]) : Promise.reject(new Error('offline')),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {panel()}
    </QueryClientProvider>,
  );

  const field = await screen.findByLabelText(label, { selector: 'input' });
  // A settings row sizes its controls to their content, so the Input's own
  // w-full took that whole width and pushed the buttons to a second line. The
  // field flexes from a floor instead, and its line fills the row once stacked.
  expect(field).toHaveClass('flex-1');
  expect(field.className).toMatch(/(?:^|\s)min-w-(?!0(?:\s|$))\S+/);
  const line = field.parentElement!;
  expect(line).toHaveClass('flex-wrap');
  if (line.tagName === 'FORM') expect(line).toHaveClass('flex-1');
  for (const name of buttons) expect(within(line).getByRole('button', { name })).toBeVisible();
});
