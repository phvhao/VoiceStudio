import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api/client', async (original) => ({
  ...(await original<typeof import('@/lib/api/client')>()),
  apiJson: mock.api,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { queryClient } from '@/lib/query';
import type { ImageTools } from './image-library';
import { MarkupEditorTools } from './markup-editor-tools';
import { MarkupTextarea } from './markup-textarea';
import { insertImageLine, type MarkupKind } from './script-markup';

beforeEach(() => {
  mock.api.mockImplementation(async (path: string) => {
    if (path === '/longform/images')
      return {
        images: [
          { name: 'dawn.jpg', width: 1600, height: 900, bytes: 1, version: 1 },
          { name: 'night.png', width: 900, height: 1400, bytes: 1, version: 1 },
        ],
      };
    throw new Error('unexpected ' + path);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

function Editor({ initial, images, unsupported }: {
  initial: string;
  images: ImageTools;
  unsupported?: readonly MarkupKind[];
}) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <MarkupEditorTools
      getTarget={() => input.current && { element: input.current, setText }}
      disabled={false}
      headings
      profiles={[]}
      scriptNames={[]}
      voiceCast={{}}
      onVoiceCast={() => {}}
      images={images}
      unsupported={unsupported}
    >
      <MarkupTextarea textareaRef={input} aria-label="Script" headings value={text} onValueChange={setText} />
    </MarkupEditorTools>
  );
}

const tools = (upload = vi.fn(async (files: readonly File[]) => files.map(() => 'dropped.jpg'))) => ({
  pick: vi.fn(),
  upload,
  insert: insertImageLine,
});

it('takes a dropped picture into the library and puts its tag on the line it landed on', async () => {
  const images = tools();
  render(<Editor initial={'One.\nTwo.'} images={images} />);
  const script = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
  script.setSelectionRange(6, 6); // on "Two."
  const file = new File(['x'], 'photo.png', { type: 'image/png' });
  await act(async () => {
    fireEvent.drop(script, { dataTransfer: { files: [file], types: ['Files'] } });
  });
  await waitFor(() => expect(script.value).toBe('One.\n[image: dropped.jpg]\nTwo.'));
  expect(images.upload).toHaveBeenCalledWith([file]);
});

it('takes a pasted picture, and leaves ordinary text pastes alone', async () => {
  const images = tools();
  render(<Editor initial="Hello." images={images} />);
  const script = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
  script.setSelectionRange(0, 0);
  await act(async () => {
    fireEvent.paste(script, { clipboardData: { files: [], getData: () => 'words' } });
  });
  expect(images.upload).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.paste(script, {
      clipboardData: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
    });
  });
  await waitFor(() => expect(script.value).toBe('[image: dropped.jpg]\nHello.'));
});

it('offers the library while "[im" is typed, and nothing of it on pages that show no pictures', async () => {
  const { unmount } = render(<Editor initial="" images={tools()} />);
  const script = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
  // Typed as the editor sees typing: the value, the caret, then input.
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  script.focus();
  setValue.call(script, '[im');
  script.setSelectionRange(3, 3);
  fireEvent.input(script);
  const list = await screen.findByRole('listbox');
  await waitFor(() =>
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('dawn.jpg'), expect.stringContaining('night.png')]),
    ),
  );
  unmount();
  render(<Editor initial="" images={tools()} unsupported={['image']} />);
  const other = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.drop(other, {
      dataTransfer: { files: [new File(['x'], 'p.png', { type: 'image/png' })], types: ['Files'] },
    });
  });
  expect(other.value).toBe('');
});

it('previews a picture tag as the frame will show it: filled, or whole on a blurred copy', async () => {
  render(<Editor initial={'[image: dawn.jpg]\nA.\n[image: night.png]\nB.'} images={tools()} />);
  const script = screen.getByRole('textbox', { name: 'Script' }) as HTMLTextAreaElement;
  const open = async (offset: number) => {
    script.setSelectionRange(offset, offset);
    fireEvent.keyUp(script);
    fireEvent.keyDown(script, { key: 'Enter', altKey: true });
    return screen.findByRole('dialog', { name: /^Tag \[image:/ });
  };
  const fit = async (card: HTMLElement) =>
    (
      await waitFor(() => {
        const preview = card.querySelector('[data-fit]');
        if (!preview) throw new Error('no preview yet');
        return preview;
      })
    ).getAttribute('data-fit');
  // Auto: a 16:9 picture fills the 16:9 frame, a tall one shows whole.
  expect(await fit(await open(3))).toBe('fill');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const night = script.value.indexOf('[image: night') + 3;
  const card = await open(night);
  expect(await fit(card)).toBe('whole');
  fireEvent.click(within(card).getByRole('radio', { name: 'Fill' }));
  await waitFor(() => expect(script.value).toContain('[image: night.png cover]'));
  expect(await fit(await open(night))).toBe('fill');
});
