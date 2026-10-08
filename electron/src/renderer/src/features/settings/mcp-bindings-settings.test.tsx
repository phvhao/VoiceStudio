import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ json: vi.fn(), fetch: vi.fn() }));

vi.mock('@/lib/api/client', async (load) => {
  const actual = await load<typeof import('@/lib/api/client')>();
  return { ...actual, apiJson: mock.json, apiFetch: mock.fetch };
});
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({ data: [{ id: 'p1', name: 'Narrator' }], isPending: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { McpBindingsSettings } from './mcp-bindings-settings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel() {
  mock.json.mockImplementation((path: string, init?: RequestInit) =>
    Promise.resolve(path === '/api/mcp/bindings' && !init?.method ? [] : {}),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <McpBindingsSettings />
    </QueryClientProvider>,
  );
  return screen.getByRole('group', { name: 'settings.mcp_add_title' });
}

it('gives the add-binding form the full width under its label', () => {
  const add = renderPanel();

  // Beside its label the four controls were squeezed until placeholders clipped.
  expect(add.closest('[data-slot="settings-row"]')).toHaveAttribute('data-variant', 'stacked');
  expect(within(add).getByRole('textbox', { name: 'settings.mcp_client_id' })).toBeEnabled();
  expect(within(add).getByRole('textbox', { name: 'settings.mcp_label' })).toBeEnabled();
  expect(
    within(add).getByRole('combobox', { name: 'settings.mcp_voice_profile' }),
  ).toBeInTheDocument();
  expect(within(add).getByRole('button', { name: 'settings.mcp_add' })).toBeDisabled();
});

it('saves a binding with Enter and clears the form', async () => {
  const add = renderPanel();
  const clientId = within(add).getByRole('textbox', { name: 'settings.mcp_client_id' });

  fireEvent.change(clientId, { target: { value: '  claude-code ' } });
  fireEvent.keyDown(clientId, { key: 'Enter' });

  await waitFor(() => expect(clientId).toHaveValue(''));
  expect(mock.json).toHaveBeenCalledWith('/api/mcp/bindings', {
    method: 'PUT',
    body: JSON.stringify({ client_id: 'claude-code', label: null, profile_id: null }),
  });
});
