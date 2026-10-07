import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { reasons?: string }) =>
      params?.reasons ? `${key}: ${params.reasons}` : key,
  }),
}));
import { GatedAction, revealGateTarget, type ActionBlocker } from './gated-action';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const missingDub: ActionBlocker = {
  id: 'no_dub',
  message: 'Generate the dub first.',
  fix: { label: 'Go to step 3', onSelect: vi.fn() },
};

it('is a plain button that runs its action when nothing is missing', () => {
  const run = vi.fn();
  render(<GatedAction onClick={run}>Export</GatedAction>);
  const button = screen.getByRole('button', { name: 'Export' });
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute('aria-disabled');
  expect(button).not.toHaveAttribute('data-blocked');
  expect(button).not.toHaveAccessibleDescription();
  fireEvent.click(button);
  expect(run).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('stays pressable while blocked, says why, and leads to the fix instead of running', async () => {
  const run = vi.fn();
  const fix = vi.fn();
  render(
    <GatedAction
      blockers={[{ ...missingDub, fix: { label: 'Go to step 3', onSelect: fix } }]}
      onClick={run}
    >
      Export
    </GatedAction>,
  );
  // Not greyed out and unfocusable: the reason is part of the control.
  const button = screen.getByRole('button', { name: 'Export' });
  expect(button).not.toBeDisabled();
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(button).toHaveAttribute('data-blocked');
  expect(button).toHaveAccessibleDescription('gatedAction.summary: Generate the dub first.');
  fireEvent.click(button);
  expect(run).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('dialog', { name: 'gatedAction.title' });
  expect(dialog).toHaveTextContent('Generate the dub first.');
  // Focus goes to the fix; the dialog's description still reads what is missing.
  expect(dialog).toHaveAccessibleDescription(/Generate the dub first\./);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go to step 3' })),
  );
  expect(button).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Go to step 3' }));
  await waitFor(() => expect(fix).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(run).not.toHaveBeenCalled();
});

it('lists every blocker and shows where the flow stands', async () => {
  const toUpload = vi.fn();
  render(
    <GatedAction
      blockers={[
        { id: 'tts', message: 'The voice engine is still starting.' },
        { id: 'empty', message: 'Segments without text: 2.' },
      ]}
      steps={[
        { id: 'upload', label: 'Upload & Transcribe', done: true, onSelect: toUpload },
        { id: 'translate', label: 'Translate', done: false },
        { id: 'generate', label: 'Generate Dub', done: false },
      ]}
    >
      Generate Dub
    </GatedAction>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Generate Dub' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('The voice engine is still starting.');
  expect(dialog).toHaveTextContent('Segments without text: 2.');
  const steps = screen.getByRole('list', { name: 'gatedAction.steps' });
  const items = [...steps.querySelectorAll('button')];
  expect(items).toHaveLength(3);
  expect(items[0]).toHaveTextContent('Upload & Transcribe');
  expect(items[0]).toHaveTextContent('gatedAction.step_done');
  expect(items[1]).toHaveTextContent('Translate');
  expect(items[1]).not.toHaveTextContent('gatedAction.step_done');
  // The first unfinished step is the current one.
  expect(items[1]).toHaveAttribute('aria-current', 'step');
  expect(items[0]).not.toHaveAttribute('aria-current');
  expect(items[2]).toBeDisabled();
  fireEvent.click(items[0]);
  await waitFor(() => expect(toUpload).toHaveBeenCalledOnce());
});

it('keeps work in progress truly disabled', () => {
  const run = vi.fn();
  render(
    <GatedAction disabled blockers={[missingDub]} onClick={run}>
      Export
    </GatedAction>,
  );
  const button = screen.getByRole('button', { name: 'Export' });
  expect(button).toBeDisabled();
  expect(button).not.toHaveAttribute('aria-disabled');
  fireEvent.click(button);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it('drops the explanation once nothing is missing, and does not reopen it by itself', async () => {
  const run = vi.fn();
  const view = render(
    <GatedAction blockers={[missingDub]} onClick={run}>
      Export
    </GatedAction>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
  view.rerender(
    <GatedAction blockers={[]} onClick={run}>
      Export
    </GatedAction>,
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  view.rerender(
    <GatedAction blockers={[missingDub]} onClick={run}>
      Export
    </GatedAction>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<GatedAction onClick={run}>Export</GatedAction>);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  expect(run).toHaveBeenCalledOnce();
});

it('reveals the control that fixes a blocker: opens, focuses and flashes it', () => {
  vi.useFakeTimers();
  // jsdom has no layout; model the one visibility rule the reveal relies on.
  HTMLElement.prototype.checkVisibility = function (this: HTMLElement) {
    return this.style.display !== 'none';
  };
  document.body.innerHTML = `
    <details><summary>Options</summary>
      <section data-gate-target="other dub-upload">
        <input type="file" style="display:none" />
        <button type="button">Choose file</button>
      </section>
    </details>`;
  const section = document.querySelector('section')!;
  expect(revealGateTarget('missing')).toBe(false);
  expect(revealGateTarget('dub-upload')).toBe(true);
  expect(document.querySelector('details')!.open).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose file' }));
  expect(section).toHaveAttribute('data-gate-highlight');
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(section).not.toHaveAttribute('data-gate-highlight');
  // @ts-expect-error restore jsdom's (absent) implementation
  delete HTMLElement.prototype.checkVisibility;
});

it('expands a collapsed workspace sidebar before revealing inside it', () => {
  const expand = vi.fn();
  document.body.innerHTML = `
    <aside data-slot="secondary-sidebar" data-collapsed="true">
      <div data-slot="secondary-sidebar-header"><button aria-expanded="false">Expand</button></div>
      <div hidden><button data-gate-target="dub-language">Spanish</button></div>
    </aside>`;
  document.querySelector('[aria-expanded]')!.addEventListener('click', expand);
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 0;
  });
  expect(revealGateTarget('dub-language')).toBe(true);
  expect(expand).toHaveBeenCalledOnce();
  expect(raf).toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByText('Spanish'));
});
