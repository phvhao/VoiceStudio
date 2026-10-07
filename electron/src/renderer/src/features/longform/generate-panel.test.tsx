import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@/i18n';
import { GeneratePanel, type GenerateSession } from './generate-panel';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const idle: GenerateSession = {
  active: null,
  stage: 'idle',
  completed: 0,
  total: 0,
  failed: 0,
  stopped: false,
  chapters: [],
};

afterEach(() => {
  cleanup();
  navigate.mockClear();
  document.body.innerHTML = '';
});

it('says why Generate is unavailable, and pressing it explains instead of doing nothing', async () => {
  const onGenerate = vi.fn();
  render(
    <GeneratePanel
      mode="stories"
      session={idle}
      blockers={['voice']}
      onGenerate={onGenerate}
      onStop={vi.fn()}
    />,
  );
  const button = screen.getByRole('button', { name: 'Generate' });
  // Not greyed out and unfocusable: it stays a control that can explain itself.
  expect(button).not.toBeDisabled();
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(button).toHaveAccessibleDescription(
    'Not ready yet: Choose a default voice, or give every line a voice.',
  );
  expect(screen.getByText('Choose a default voice, or give every line a voice.')).toBeVisible();
  fireEvent.click(button);
  expect(onGenerate).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('dialog', { name: 'Not ready yet' });
  expect(dialog).toHaveTextContent('Choose a default voice, or give every line a voice.');
  expect(screen.getByRole('button', { name: 'Show me' })).toBeVisible();
});

it('lists every missing piece under the book checklist, each leading to its control', async () => {
  // The page marks where each fix leads.
  const target = document.createElement('div');
  target.dataset.gateTarget = 'longform-default-voice';
  target.innerHTML = '<button type="button">Default voice picker</button>';
  document.body.append(target);
  render(
    <GeneratePanel
      mode="audiobook"
      session={idle}
      blockers={['no_script', 'default_voice']}
      setup={{ engine: null, usable: false, voiceReady: false, casting: false, castReady: true }}
      onGenerate={vi.fn()}
      onStop={vi.fn()}
    />,
  );
  // The first reason stays in view; the button holds all of them.
  expect(screen.getByRole('status')).toHaveTextContent('Write or import a script to generate.');
  fireEvent.click(screen.getByRole('button', { name: 'Create audiobook' }));
  const dialog = await screen.findByRole('dialog', { name: 'Not ready yet' });
  expect(dialog).toHaveTextContent('Write or import a script to generate.');
  expect(dialog).toHaveTextContent(
    'Pick a default voice in the left panel to create the audiobook.',
  );
  const steps = [...screen.getByRole('list', { name: 'Steps' }).querySelectorAll('button')];
  expect(steps.map((step) => step.textContent)).toEqual([
    'Voice engineDone',
    '2Script',
    '3Default voice',
  ]);
  expect(steps[1]).toHaveAttribute('aria-current', 'step');
  fireEvent.click(screen.getAllByRole('button', { name: 'Show me' })[1]);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Default voice picker' }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('generates when nothing blocks it and swaps to Stop with the tracker while rendering', () => {
  const onGenerate = vi.fn();
  const onStop = vi.fn();
  const view = render(
    <GeneratePanel
      mode="stories"
      session={idle}
      blockers={[]}
      onGenerate={onGenerate}
      onStop={onStop}
    />,
  );
  const button = screen.getByRole('button', { name: 'Generate' });
  expect(button).not.toHaveAttribute('aria-disabled');
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(button);
  expect(onGenerate).toHaveBeenCalledOnce();

  view.rerender(
    <GeneratePanel
      mode="stories"
      session={{
        ...idle,
        active: 'stories',
        stage: 'rendering',
        total: 2,
        chapters: [
          { title: 'One', status: 'done' },
          { title: 'Two', status: 'rendering' },
        ] as GenerateSession['chapters'],
      }}
      blockers={[]}
      onGenerate={onGenerate}
      onStop={onStop}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(onStop).toHaveBeenCalledOnce();
  expect(screen.getByText('Two')).toBeVisible();
});

it('explains that the other longform mode is rendering, and leads to it', async () => {
  render(
    <GeneratePanel
      mode="stories"
      session={{ ...idle, active: 'audiobook', stage: 'rendering' }}
      blockers={['busy']}
      onGenerate={vi.fn()}
      onStop={vi.fn()}
    />,
  );
  const button = screen.getByRole('button', { name: 'Generate' });
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('status')).toHaveTextContent(/already rendering/i);
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole('button', { name: 'Show me' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/audiobook' }));
});
