import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import {
  DEFAULT_OVERRIDES,
  overridesToRequest,
  type Overrides,
} from '@shared/utils/longformOverrides';
import { ProductionSettings } from './production-settings';
const apiJson = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ apiJson }));
beforeEach(() => {
  apiJson.mockReset();
  apiJson.mockImplementation(async (path: string) =>
    path === '/audiobook/sampling'
      ? { num_step: 64, guidance_scale: 2, postprocess_output: false }
      : { active: 'omnivoice', backends: [] },
  );
});
const renderSettings = (value: Overrides, onChange = vi.fn()) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductionSettings value={value} disabled={false} onChange={onChange} />
    </QueryClientProvider>,
  );
const openSettings = (container: HTMLElement) => {
  const details = container.querySelector('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
};
it('shows the steps and postprocessing a render takes when they are left unset', async () => {
  const { container } = renderSettings(DEFAULT_OVERRIDES);
  const steps = screen.getByLabelText(i18n.t('clone.steps'));
  // Closed: nothing asked yet, the model's own default.
  expect(steps).toHaveValue('32');
  expect(apiJson).not.toHaveBeenCalled();
  openSettings(container);
  // The performance preset renders at 64 steps without postprocessing.
  await waitFor(() => expect(steps).toHaveValue('64'));
  const postprocess = screen
    .getByText(i18n.t('clone.postprocess'))
    .querySelector('[role="switch"]');
  expect(postprocess).toHaveAttribute('aria-checked', 'false');
  // Untouched controls still send nothing: the server applies the preset.
  expect(overridesToRequest(DEFAULT_OVERRIDES, 'Auto')).not.toHaveProperty('num_step');
});
it('shows a book its own steps over the preset', async () => {
  const { container } = renderSettings({ ...DEFAULT_OVERRIDES, numStep: 20, postprocess: true });
  openSettings(container);
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith('/audiobook/sampling', expect.anything()),
  );
  expect(screen.getByLabelText(i18n.t('clone.steps'))).toHaveValue('20');
  const postprocess = screen
    .getByText(i18n.t('clone.postprocess'))
    .querySelector('[role="switch"]');
  expect(postprocess).toHaveAttribute('aria-checked', 'true');
});
it('shows effective legacy joins for untouched and reset drafts', () => {
  renderSettings(DEFAULT_OVERRIDES);
  expect(screen.getByLabelText(i18n.t('audiobook.line_gap'))).toHaveValue('0');
  expect(screen.getByLabelText(i18n.t('audiobook.paragraph_gap'))).toHaveValue('0');
  const trim = screen.getByText(i18n.t('audiobook.trim_edges')).querySelector('[role="switch"]');
  expect(trim).toHaveAttribute('aria-checked', 'false');
  // Untouched joins send nothing; reading follows Settings → Reading, and the
  // voices are evened out.
  expect(overridesToRequest(DEFAULT_OVERRIDES, 'Auto')).toEqual({
    use_app_reading: true,
    level_voices: true,
  });
});
it('evens out voice volume unless the book turns it off', () => {
  const onChange = vi.fn();
  // Overrides saved before leveling existed carry no field: they level too.
  const { levelVoices: _, ...legacy } = DEFAULT_OVERRIDES;
  renderSettings(legacy as Overrides, onChange);
  const toggle = screen.getByRole('switch', { name: i18n.t('leveling.auto') });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(toggle).toHaveAccessibleDescription(i18n.t('leveling.auto_hint'));
  expect(overridesToRequest(legacy as Overrides, 'Auto')).toHaveProperty('level_voices', true);
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith({ ...legacy, levelVoices: false });
  // Off sends nothing: the server's default is the un-leveled render.
  expect(
    overridesToRequest({ ...DEFAULT_OVERRIDES, levelVoices: false }, 'Auto'),
  ).not.toHaveProperty('level_voices');
});
