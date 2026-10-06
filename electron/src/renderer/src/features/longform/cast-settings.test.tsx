import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { CastSettings, VoiceGainControl, showsCastPanel } from './cast-settings';

const profiles = [
  { id: 'p-hao', name: 'Hao PV' },
  { id: 'p-mai', name: 'Mai' },
];
const renderCast = (props: Partial<Parameters<typeof CastSettings>[0]> = {}) => {
  const onVoiceGains = vi.fn();
  render(
    <CastSettings
      names={['Mara', 'default']}
      cast={{ Mara: 'p-mai' }}
      profiles={profiles}
      disabled={false}
      onChange={vi.fn()}
      voiceGains={{ Mara: 3 }}
      onVoiceGains={onVoiceGains}
      defaultVoiceName="Hao PV"
      {...props}
    />,
  );
  return onVoiceGains;
};
const volumeOf = (name: string) =>
  screen.getByRole('slider', { name: i18n.t('leveling.volume_of', { name }) });
const pickerOf = (name: string) =>
  screen.getByRole('combobox', { name: i18n.t('editor.voice_for', { name }) });
const resetOf = (name: string) =>
  screen.getByRole('button', { name: i18n.t('leveling.reset_volume_of', { name }) });

it('sets a volume for the default voice and every cast name', () => {
  const onVoiceGains = renderCast();
  const defaultVoice = i18n.t('audiobook.default_voice');
  expect(screen.getByText(defaultVoice).parentElement).toHaveTextContent('Hao PV');
  expect(volumeOf(defaultVoice)).toHaveValue('0');
  expect(volumeOf('Mara')).toHaveValue('3');
  expect(volumeOf('Mara')).toHaveAttribute('aria-valuetext', '+3 dB');
  fireEvent.change(volumeOf(defaultVoice), { target: { value: '-4' } });
  expect(onVoiceGains).toHaveBeenLastCalledWith({ Mara: 3, '': -4 });
  fireEvent.change(volumeOf('Mara'), { target: { value: '0' } });
  expect(onVoiceGains).toHaveBeenLastCalledWith({});
});

it('gives [voice:default] the default voice’s volume', () => {
  const onVoiceGains = renderCast({ voiceGains: { '': -2 } });
  expect(volumeOf('default')).toHaveValue('-2');
  fireEvent.change(volumeOf('default'), { target: { value: '5' } });
  expect(onVoiceGains).toHaveBeenLastCalledWith({ '': 5 });
});

it('resets one voice to 0 dB', () => {
  const onVoiceGains = renderCast({ voiceGains: { Mara: 3, '': -1 } });
  fireEvent.click(resetOf('Mara'));
  expect(onVoiceGains).toHaveBeenLastCalledWith({ '': -1 });
});

it('has nothing to reset at 0 dB', () => {
  renderCast({ voiceGains: {} });
  expect(resetOf('Mara')).toBeDisabled();
});

it('keeps the plain cast picker when no volumes are wired', () => {
  render(
    <CastSettings
      names={['Mara']}
      cast={{}}
      profiles={profiles}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole('slider')).toBeNull();
  expect(pickerOf('Mara')).toHaveTextContent(i18n.t('audiobook.cast_uses_default'));
});

it('casts a name through the searchable voice picker, the default voice first', async () => {
  const onChange = vi.fn();
  renderCast({ onChange });
  // Each name shows what reads it; the default option names the default voice.
  expect(pickerOf('Mara')).toHaveTextContent('Mai');
  expect(pickerOf('default')).toHaveTextContent(i18n.t('audiobook.cast_uses_default'));
  fireEvent.click(pickerOf('Mara'));
  const [inherit] = await screen.findAllByRole('option');
  expect(inherit).toHaveTextContent(i18n.t('audiobook.cast_uses_default') + 'Hao PV');
  fireEvent.click(screen.getByRole('option', { name: 'Hao PV' }));
  expect(onChange).toHaveBeenLastCalledWith({ Mara: 'p-hao' });
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  fireEvent.click(pickerOf('Mara'));
  fireEvent.click((await screen.findAllByRole('option'))[0]);
  // Back to the default voice: the name leaves the cast instead of mapping to ''.
  expect(onChange).toHaveBeenLastCalledWith({});
});

it('flags a deleted cast voice, but not while the profiles are still loading', () => {
  const props = {
    names: ['Mara'],
    cast: { Mara: 'p-gone' },
    disabled: false,
    onChange: vi.fn(),
  };
  const { rerender } = render(<CastSettings {...props} profiles={[]} loading />);
  expect(pickerOf('Mara')).toHaveTextContent(i18n.t('common.loading'));
  expect(pickerOf('Mara')).not.toHaveTextContent(i18n.t('voiceSelector.missingVoice'));
  rerender(<CastSettings {...props} profiles={profiles} />);
  expect(pickerOf('Mara')).toHaveTextContent(i18n.t('voiceSelector.missingVoice'));
});

it('colors every voice as the editor colors its tags and lane', () => {
  render(
    <CastSettings
      names={['Ben', 'default']}
      voices={['Mara', 'Ben', 'default']}
      cast={{}}
      profiles={profiles}
      disabled={false}
      onChange={vi.fn()}
      voiceGains={{}}
      onVoiceGains={vi.fn()}
    />,
  );
  const swatch = (text: string) => screen.getByText(text).previousElementSibling;
  // Colors follow the whole script's order, even where the panel lists only some names.
  expect(swatch('Ben')).toHaveClass('bg-amber-400');
  // `[voice:default]` reads in the default voice, which is neutral.
  expect(swatch('default')).toHaveClass('bg-muted-foreground/50');
  expect(swatch(i18n.t('audiobook.default_voice'))).toHaveClass('bg-muted-foreground/50');
});

it('locks the volume while rendering', () => {
  render(<VoiceGainControl name="Mara" value={2} disabled onChange={vi.fn()} />);
  expect(volumeOf('Mara')).toBeDisabled();
  expect(resetOf('Mara')).toBeDisabled();
});

it('keeps the Stories cast panel while the default voice has a volume only it sets', () => {
  expect(showsCastPanel('audiobook', [], {})).toBe(true);
  expect(showsCastPanel('stories', [], {})).toBe(false);
  expect(showsCastPanel('stories', ['Mara'], {})).toBe(true);
  // The inline name that showed the panel is gone; its default-voice volume still renders.
  expect(showsCastPanel('stories', [], { '': -6 })).toBe(true);
  expect(showsCastPanel('stories', [], { '': 0, Mara: 3 })).toBe(false);
});

it('shows what leveling added in the last render, and the total with the voice’s volume', () => {
  renderCast({ names: ['Mara'], autoLevels: { '': -1.5, Mara: 5.2 } });
  expect(screen.getByText('Auto: +5.2 dB · Total: +8.2 dB')).toBeVisible();
  expect(screen.getByText('Auto: -1.5 dB · Total: -1.5 dB')).toHaveAttribute(
    'title',
    'In the last render, automatic leveling moved this voice by -1.5 dB; with your volume it plays at -1.5 dB.',
  );
  // The [volume] tag is the way to change one passage.
  expect(screen.getByText(/wrap it in \[volume -6dB\]…\[\/volume\]/)).toBeVisible();
});

it('shows no automatic level before a leveled render', () => {
  renderCast({ names: ['Mara'] });
  expect(screen.queryByText(/^Auto:/)).toBeNull();
  renderCast({ names: ['Mara'], autoLevels: { Mara: 2 } });
  // Only the voices the render measured.
  expect(screen.getAllByText(/^Auto:/)).toHaveLength(1);
});
