import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';

const mock = vi.hoisted(() => ({ api: vi.fn(), toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/api/client', async (original) => ({
  ...(await original<typeof import('@/lib/api/client')>()),
  apiJson: mock.api,
}));
vi.mock('sonner', () => ({ toast: mock.toast }));

import { ApiError } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import { ImageLibraryDialog } from './image-library';

let library: Array<{ name: string; width: number; height: number; bytes: number; version: number }>;

beforeEach(() => {
  library = [
    { name: 'dawn.jpg', width: 1600, height: 900, bytes: 1000, version: 2 },
    { name: 'rung-dem.png', width: 800, height: 1200, bytes: 2000, version: 1 },
  ];
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/longform/images' && !init?.method) return { images: library };
    if (path === '/longform/images' && init?.method === 'POST') {
      const file = (init.body as FormData).get('file') as File;
      if (file.name === 'bad.heic')
        throw new ApiError(415, '{}', {
          detail: { code: 'image_unsupported', message: 'nope' },
        } as never);
      const image = { name: 'new-one.jpg', width: 10, height: 10, bytes: 1, version: 3 };
      library = [image, ...library];
      return { image: { ...image, reused: false } };
    }
    if (init?.method === 'DELETE') {
      library = library.filter((image) => !path.endsWith(encodeURIComponent(image.name)));
      return { deleted: path };
    }
    throw new Error('unexpected ' + path);
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

function open(props: Partial<Parameters<typeof ImageLibraryDialog>[0]> = {}) {
  const onChoose = vi.fn();
  const onOpenChange = vi.fn();
  render(<ImageLibraryDialog open onOpenChange={onOpenChange} onChoose={onChoose} {...props} />);
  return { onChoose, onOpenChange };
}

it('lists the library and chooses the picture picked, or none', async () => {
  const { onChoose } = open({ current: 'dawn.jpg' });
  const list = await screen.findByRole('listbox', { name: 'Picture library' });
  const options = within(list).getAllByRole('option');
  expect(options.map((option) => option.title)).toEqual(['dawn.jpg', 'rung-dem.png']);
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  expect(options[0].querySelector('img')?.getAttribute('src')).toMatch(
    /\/longform\/images\/dawn\.jpg\?thumb=1&v=2$/,
  );
  fireEvent.click(options[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Use picture' }));
  expect(onChoose).toHaveBeenLastCalledWith('rung-dem.png');
  fireEvent.click(screen.getByRole('button', { name: 'No picture (backdrop)' }));
  expect(onChoose).toHaveBeenLastCalledWith(null);
});

it('finds a picture by its name, accents aside', async () => {
  open();
  await screen.findByRole('listbox');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search pictures' }), {
    target: { value: 'rừng' },
  });
  expect(screen.getAllByRole('option').map((option) => option.title)).toEqual(['rung-dem.png']);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search pictures' }), {
    target: { value: 'zzz' },
  });
  expect(screen.getByText('No picture matches.')).toBeInTheDocument();
});

it('takes new pictures in and picks the one added; a refusal says why', async () => {
  open();
  await screen.findByRole('listbox');
  const input = screen.getByTestId('image-upload-input');
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'new one.jpg', { type: 'image/jpeg' })] },
    });
  });
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /new-one\.jpg/ })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(['x'], 'bad.heic', { type: 'image/heic' })] } });
  });
  await waitFor(() => expect(mock.toast.error).toHaveBeenCalled());
  expect(String(mock.toast.error.mock.calls[0][0])).toContain('bad.heic');
  expect(String(mock.toast.error.mock.calls[0][0])).toContain('JPEG, PNG');
});

it('removes a picture only on a second click', async () => {
  open();
  await screen.findByRole('listbox');
  fireEvent.click(screen.getByRole('button', { name: 'Remove dawn.jpg' }));
  expect(mock.api).not.toHaveBeenCalledWith(expect.stringMatching(/dawn/), expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Click again to remove dawn.jpg' }));
  await waitFor(() =>
    expect(screen.getAllByRole('option').map((option) => option.title)).toEqual(['rung-dem.png']),
  );
});
