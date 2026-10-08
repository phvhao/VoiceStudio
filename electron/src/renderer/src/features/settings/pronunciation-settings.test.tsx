import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ json: vi.fn(), fetch: vi.fn() }));

vi.mock('@/lib/api/client', async (load) => {
  const actual = await load<typeof import('@/lib/api/client')>();
  return { ...actual, apiJson: mock.json, apiFetch: mock.fetch };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PronunciationSettings } from './pronunciation-settings';

const ENTRIES = [
  { id: 'a', term: 'GIF', replacement: 'jiff', type: 'respelling', language: '*', enabled: true },
  {
    id: 'b',
    term: 'SQL',
    replacement: 'sequel',
    type: 'respelling',
    language: 'en',
    scope: 'en',
    enabled: true,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel(
  preview: () => Promise<unknown> = () => Promise.resolve({ substituted: 'jiff', changed: true }),
) {
  mock.json.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/pronunciation' && !init?.method) return Promise.resolve(ENTRIES);
    if (path === '/pronunciation/test') return preview();
    return Promise.resolve({});
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PronunciationSettings />
    </QueryClientProvider>,
  );
}

it('gives the add form and the sentence test the full width, under their labels', async () => {
  renderPanel();

  // A label column beside a five-control form was squeezed to a sliver, so
  // both multi-control rows stack their label above the controls.
  const add = screen.getByRole('group', { name: 'pronunciation.add' });
  expect(add.closest('[data-slot="settings-row"]')).toHaveAttribute('data-variant', 'stacked');
  for (const name of [
    'pronunciation.term',
    'pronunciation.replacement',
    'pronunciation.lang_label',
  ])
    expect(within(add).getByRole('textbox', { name })).toBeEnabled();
  expect(within(add).getByRole('combobox', { name: 'pronunciation.type' })).toBeInTheDocument();
  expect(within(add).getByRole('button', { name: 'pronunciation.add' })).toBeDisabled();

  const test = screen.getByRole('group', { name: 'pronunciation.test_label' });
  expect(test.closest('[data-slot="settings-row"]')).toHaveAttribute('data-variant', 'stacked');
  expect(
    within(test).getByRole('combobox', { name: 'pronunciation.test_language' }),
  ).toBeInTheDocument();
  expect(await screen.findByText('pronunciation.test_global_hint')).toBeInTheDocument();

  fireEvent.change(within(test).getByRole('textbox', { name: 'pronunciation.test_label' }), {
    target: { value: 'GIF' },
  });
  // The preview stays in the same block, below its field.
  expect(await within(test).findByText('jiff')).toBeInTheDocument();
  expect(within(test).getByText('pronunciation.test_result')).toBeInTheDocument();
  expect(mock.json).toHaveBeenCalledWith(
    '/pronunciation/test',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'GIF' }) }),
  );
});

it('adds an entry with Enter in the language field or the Add button, then clears the form', async () => {
  renderPanel();
  const add = screen.getByRole('group', { name: 'pronunciation.add' });
  const term = within(add).getByRole('textbox', { name: 'pronunciation.term' });
  const reading = within(add).getByRole('textbox', { name: 'pronunciation.replacement' });
  const language = within(add).getByRole('textbox', { name: 'pronunciation.lang_label' });
  const posted = () =>
    mock.json.mock.calls.filter(
      ([path, init]) => path === '/pronunciation' && init?.method === 'POST',
    );

  fireEvent.keyDown(language, { key: 'Enter' });
  expect(posted()).toHaveLength(0);

  fireEvent.change(term, { target: { value: '  GIF ' } });
  fireEvent.change(reading, { target: { value: 'jiff' } });
  fireEvent.change(language, { target: { value: ' en ' } });
  fireEvent.keyDown(language, { key: 'Enter' });
  await waitFor(() => expect(term).toHaveValue(''));
  expect(reading).toHaveValue('');
  expect(language).toHaveValue('');
  expect(posted()[0]?.[1]).toEqual({
    method: 'POST',
    body: JSON.stringify({
      term: 'GIF',
      replacement: 'jiff',
      type: 'respelling',
      language: 'en',
      enabled: true,
    }),
  });

  // A blank language applies the entry to every language.
  fireEvent.change(term, { target: { value: 'SQL' } });
  fireEvent.click(within(add).getByRole('button', { name: 'pronunciation.add' }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(JSON.parse(String(posted()[1]?.[1]?.body))).toMatchObject({ term: 'SQL', language: '*' });
});

it('reports a failed preview inside the sentence test block', async () => {
  renderPanel(() => Promise.reject(new Error('offline')));
  const test = screen.getByRole('group', { name: 'pronunciation.test_label' });

  fireEvent.change(within(test).getByRole('textbox', { name: 'pronunciation.test_label' }), {
    target: { value: 'GIF' },
  });

  expect(await within(test).findByRole('alert')).toHaveTextContent('pronunciation.test_error');
});
