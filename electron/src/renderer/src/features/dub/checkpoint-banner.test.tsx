import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { reasons?: string }) =>
      params?.reasons ? `${key}: ${params.reasons}` : key,
  }),
}));
import { CheckpointBanner } from './checkpoint-banner';

afterEach(cleanup);

it('lets the next step explain what it still needs instead of greying out', async () => {
  const onContinue = vi.fn();
  const view = render(
    <CheckpointBanner
      stage="asr"
      timingWarnings={0}
      blockers={[{ id: 'translator', message: 'Set up the translation engine first.' }]}
      onContinue={onContinue}
      onDismiss={vi.fn()}
    />,
  );
  const next = screen.getByRole('button', { name: 'checkpoint.asr_cta' });
  expect(next).not.toBeDisabled();
  expect(next).toHaveAccessibleDescription(/Set up the translation engine first\./);
  fireEvent.click(next);
  expect(onContinue).not.toHaveBeenCalled();
  await screen.findByRole('dialog');
  view.rerender(
    <CheckpointBanner stage="asr" timingWarnings={0} onContinue={onContinue} onDismiss={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'checkpoint.asr_cta' }));
  expect(onContinue).toHaveBeenCalledOnce();
});
