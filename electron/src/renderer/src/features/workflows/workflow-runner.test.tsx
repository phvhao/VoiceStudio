import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  data: undefined as object | undefined,
  tts: 'not-installed' as string | null,
}));
vi.mock('@/hooks/use-engines', () => ({ useEngines: () => ({ data: state.data }) }));
vi.mock('@/hooks/use-tts-readiness', () => ({ useTtsReadiness: () => state.tts }));
vi.mock('@/components/engine-notice', () => ({ EngineNotice: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { reasons?: string }) =>
      params?.reasons ? `${key}: ${params.reasons}` : key,
  }),
}));
vi.mock('./workflow-run-store', () => ({ readWorkflowRun: async () => null, writeWorkflowRun: vi.fn() }));
vi.mock('./workflow-operations', () => ({ workflowOperations: {} }));
import { WorkflowRunner } from './workflow-runner';
import { makeProcessingWorkflow, makeSpeechWorkflow } from './workflow-model';
afterEach(() => {
  cleanup();
  state.data = undefined;
  state.tts = 'not-installed';
});
const run = () => screen.getByRole('button', { name: 'workflowRun.run' });

it('waits for engine identities before starting an ASR-only run without requiring TTS', async () => {
  const document = makeProcessingWorkflow('Transcript', ['audio', 'transcribe', 'end']);
  document.steps[0].media = [{ id: 'source', name: 'audio.wav', type: 'audio/wav', size: 10 }];
  const onBusy = vi.fn(); const onClose = vi.fn();
  const view = render(<WorkflowRunner document={document} onBusy={onBusy} onClose={onClose} />);
  // Not greyed out without a word: Run says what it is waiting for.
  await waitFor(() => expect(run()).toHaveAccessibleDescription(/gatedAction\.engines_loading/));
  expect(run()).toHaveAttribute('aria-disabled', 'true');
  expect(run()).not.toBeDisabled();
  state.data = { asr: { active: 'whisper', active_model: 'small' } };
  view.rerender(<WorkflowRunner document={document} onBusy={onBusy} onClose={onClose} />);
  await waitFor(() => expect(run()).not.toHaveAttribute('aria-disabled'));
  expect(run()).not.toHaveAccessibleDescription();
});

it('names the step a draft must fix and takes the user to it', async () => {
  state.data = { tts: { active: 'omnivoice' } };
  state.tts = null;
  const document = makeSpeechWorkflow('Lessons', 'First lesson', false);
  const speak = document.steps.find((step) => step.kind === 'speak')!;
  speak.voiceId = '';
  const onShowStep = vi.fn();
  render(<WorkflowRunner document={document} onBusy={vi.fn()} onClose={vi.fn()} onShowStep={onShowStep} />);
  await waitFor(() => expect(run()).toHaveAccessibleDescription(/workflowRun\.invalid_voice/));
  fireEvent.click(run());
  fireEvent.click(await screen.findByRole('button', { name: 'gatedAction.show_step' }));
  await waitFor(() => expect(onShowStep).toHaveBeenCalledWith(speak.id, 'voice'));
});

it('explains a speech run waiting on the voice engine', async () => {
  state.data = { tts: { active: 'omnivoice' } };
  state.tts = 'loading';
  const document = makeSpeechWorkflow('Lessons', 'First lesson', false);
  document.steps.find((step) => step.kind === 'speak')!.voiceId = 'voice';
  render(<WorkflowRunner document={document} onBusy={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(run()).toHaveAccessibleDescription(/gatedAction\.tts_loading/));
  expect(run()).not.toHaveAccessibleDescription(/invalid/);
});
