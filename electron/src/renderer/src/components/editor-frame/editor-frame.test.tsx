import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@/i18n';
import { EditorFrame, FocusToggle } from './editor-frame';
import { isEditorFocused, setEditorFocus } from './editor-focus';
import { ResultsDock } from './results-dock';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  setEditorFocus(false);
  vi.restoreAllMocks();
});

const frame = () =>
  render(
    <EditorFrame composer={<button type="button">Generate</button>} results={<p>takes</p>}>
      <textarea aria-label="Script" />
      <FocusToggle />
    </EditorFrame>,
  );

it('hides the results in focus mode and marks the document for the title bar', () => {
  frame();
  expect(screen.getByText('takes')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  expect(isEditorFocused()).toBe(true);
  expect(screen.getByText('takes')).not.toBeVisible();
  // The editor and the composer stay.
  expect(screen.getByRole('textbox', { name: 'Script' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute('data-editor-focus');
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  expect(screen.getByText('takes')).toBeVisible();
  expect(document.documentElement).not.toHaveAttribute('data-editor-focus');
});

it('keeps the results mounted in focus mode: a take playing in them plays on', () => {
  const life = { mounted: 0, unmounted: 0 };
  function Takes() {
    useEffect(() => {
      life.mounted += 1;
      return () => {
        life.unmounted += 1;
      };
    }, []);
    return <p>takes</p>;
  }
  render(
    <EditorFrame results={<Takes />}>
      <FocusToggle />
    </EditorFrame>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  expect(life).toEqual({ mounted: 1, unmounted: 0 });
});

it('leaves focus mode on Esc, unless a menu or dialog takes that Esc', () => {
  frame();
  act(() => setEditorFocus(true));
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const inside = document.createElement('button');
  dialog.append(inside);
  document.body.append(dialog);
  fireEvent.keyDown(inside, { key: 'Escape' });
  expect(isEditorFocused()).toBe(true);
  // A popup that closed itself on this Esc has claimed it.
  const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  claimed.preventDefault();
  act(() => void window.dispatchEvent(claimed));
  expect(isEditorFocused()).toBe(true);
  const press = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => void screen.getByRole('textbox', { name: 'Script' }).dispatchEvent(press));
  expect(isEditorFocused()).toBe(false);
  // Claimed, so the page's own Esc (closing its panes) waits for the next press.
  expect(press.defaultPrevented).toBe(true);
  dialog.remove();
});

it('restores the full layout when the page goes', () => {
  const view = frame();
  act(() => setEditorFocus(true));
  view.unmount();
  expect(isEditorFocused()).toBe(false);
});

it('folds the results to one line and remembers it per viewer', () => {
  const dock = () =>
    render(
      <ResultsDock title="Recent takes" count={3} line={<span>newest take</span>}>
        <p>list</p>
      </ResultsDock>,
    );
  const view = dock();
  const toggle = screen.getByRole('button', { name: /Recent takes/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('list')).toBeInTheDocument();
  expect(screen.getByRole('separator', { name: 'Recent takes' })).toHaveAttribute(
    'aria-orientation',
    'horizontal',
  );
  expect(screen.queryByText('newest take')).toBeNull();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('list')).toBeNull();
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.getByText('newest take')).toBeInTheDocument();
  view.unmount();
  dock();
  expect(screen.getByRole('button', { name: /Recent takes/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

it('still folds with storage blocked, and stays one line with nothing to list', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const view = render(
    <ResultsDock title="Recent takes">
      <p>list</p>
    </ResultsDock>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Recent takes/ }));
  expect(screen.queryByText('list')).toBeNull();
  view.unmount();
  render(
    <ResultsDock title="Recent takes" empty line={<span>No takes yet.</span>}>
      <p>list</p>
    </ResultsDock>,
  );
  expect(screen.getByRole('button', { name: /Recent takes/ })).toBeDisabled();
  expect(screen.queryByText('list')).toBeNull();
  expect(screen.getByText('No takes yet.')).toBeInTheDocument();
});
