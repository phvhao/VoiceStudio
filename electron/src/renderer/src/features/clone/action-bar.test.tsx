import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import {
  ActionBar,
  ProductionSettings,
  VoiceControls,
  explainBlockedSynthesis,
} from './action-bar';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));

const failure = vi.hoisted(() => ({ error: null as string | null }));
const readiness = vi.hoisted(() => ({
  blocker: null as null | 'reference' | 'text' | 'preparing' | 'engine' | 'cloning' | 'loading',
}));
vi.mock('@/hooks/use-clone-readiness', () => ({ useCloneReadiness: () => readiness.blocker }));
vi.mock('@/hooks/use-clone-demo', () => ({ useCloneDemo: () => false }));
vi.mock('@/hooks/use-tts-languages', () => ({
  useTtsLanguages: () => ({ names: ['English'], modelLabel: 'Test model', state: 'known' }),
}));
const generate = vi.fn(() => Promise.resolve());
const cancel = vi.fn();
const setCloneSetting = vi.fn();
const resetVoiceControls = vi.fn();
const runtime = {
  isGenerating: false,
  elapsedSeconds: 0,
  progress: null as number | null,
  stage: 'preparing',
  modelStage: null as string | null,
  modelProgress: null as number | null,
};

const settings = {
  text: '',
  language: 'Auto',
  refText: '',
  instruct: '',
  steps: 32,
  cfg: 2,
  speed: 1,
  tShift: 0.5,
  posTemp: 1,
  classTemp: 1,
  layerPenalty: 3,
  denoise: false,
  postprocess: true,
  duration: '',
  showOverrides: true,
  selectedProfileId: null,
  autoPlay: true,
};

vi.mock('@/lib/languages', () => ({
  LANGUAGES: ['Auto', 'English'],
  POPULAR_LANGUAGES: ['English'],
  TAGS: [],
}));

vi.mock('@/lib/store/clone-settings', () => ({
  useCloneSettings: () => settings,
  useCloneSetting: (key: keyof typeof settings) => settings[key],
  setCloneSetting: (...args: unknown[]) => setCloneSetting(...args),
  resetAudioQuality: vi.fn(),
  resetVoiceControls: () => resetVoiceControls(),
}));

vi.mock('@/lib/audio/playback', () => ({
  usePlaybackSource: () => 'output',
  stopActivePlayback: vi.fn(),
}));

vi.mock('@/hooks/use-generate', () => ({
  useGenerateClone: () => ({
    generate,
    cancel,
    error: failure.error,
    cloneBlocker: readiness.blocker,
    ...runtime,
  }),
}));

describe('ActionBar', () => {
  beforeEach(() => {
    readiness.blocker = null;
    failure.error = null;
    settings.text = '';
    generate.mockClear();
    navigate.mockClear();
  });
  beforeEach(() => {
    Object.assign(runtime, {
      isGenerating: false,
      elapsedSeconds: 0,
      progress: null,
      stage: 'preparing',
      modelStage: null,
      modelProgress: null,
    });
  });
  it.each([
    ['reference', 'Choose a voice first: upload a reference clip or pick a saved voice.'],
    ['text', 'Write the script first.'],
    ['preparing', 'The voice sample is still recording or loading. Wait a moment.'],
    ['loading', 'The voice engine is still starting. Wait a moment.'],
    ['cloning', 'Choose a ready text-to-speech model that supports voice cloning.'],
  ] as const)('explains instead of synthesizing while %s blocks it', async (blocker, reason) => {
    readiness.blocker = blocker;
    if (blocker !== 'text') settings.text = 'Hello there';
    render(<ActionBar />);
    const button = screen.getByRole('button', { name: 'Synthesize audio' });
    // Not greyed out and unfocusable: the reason is part of the control.
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(`Not ready yet: ${reason}`);
    expect(screen.getByRole('status')).toHaveTextContent(reason);
    // The shortcut hint gives way to the not-ready mark.
    expect(button.querySelector('[data-slot="kbd"]')).toBeNull();
    fireEvent.click(button);
    expect(generate).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Not ready yet' })).toHaveTextContent(reason);
  });

  it('lists every missing piece at once, each leading to its fix', async () => {
    readiness.blocker = 'engine';
    const script = document.createElement('textarea');
    script.dataset.gateTarget = 'clone-script';
    document.body.append(script);
    render(<ActionBar />);
    const button = screen.getByRole('button', { name: 'Synthesize audio' });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Not ready yet' });
    expect(dialog).toHaveTextContent('Set up a text-to-speech engine first.');
    expect(dialog).toHaveTextContent('Write the script first.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Show me' })[1]);
    await waitFor(() => expect(document.activeElement).toBe(script));
    // No engine notice on the page: the engine's fix opens the engine settings.
    fireEvent.click(button);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Show me' }))[0]);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/settings/models/$family',
        params: { family: 'tts' },
      }),
    );
    script.remove();
  });

  it('lets the Ctrl+Enter shortcut explain a blocked Synthesize instead of doing nothing', async () => {
    readiness.blocker = 'text';
    const view = render(<ActionBar />);
    act(() => {
      expect(explainBlockedSynthesis()).toBe(true);
    });
    expect(await screen.findByRole('dialog', { name: 'Not ready yet' })).toHaveTextContent(
      'Write the script first.',
    );
    expect(generate).not.toHaveBeenCalled();
    view.unmount();
    // Ready, the shortcut synthesizes: there is nothing to explain.
    readiness.blocker = null;
    render(<ActionBar />);
    expect(explainBlockedSynthesis()).toBe(false);
  });
  it('renders a short backend error once without duplicate diagnostics', () => {
    failure.error = 'LibsndfileError: C:\\private\\outputs\\take.wav';
    const view = render(<ActionBar />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('LibsndfileError');
    expect(screen.getByRole('alert').querySelector('details')).not.toBeInTheDocument();
    expect(view.container.querySelector('pre')).not.toBeInTheDocument();
  });
  it('keeps synthesis available while the latest take is playing', () => {
    render(<ActionBar />);
    const button = screen.getByRole('button', { name: 'Synthesize audio' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Stop playback' })).not.toBeInTheDocument();
  });
  it('keeps everyday controls clear and advanced tuning collapsed', () => {
    const { container } = render(<ProductionSettings />);
    expect(screen.getByRole('switch', { name: 'Polish generated audio' })).toBeChecked();
    expect(screen.getByText('1.0×')).toBeInTheDocument();
    expect(screen.getByText(/1× is normal speed/)).toBeVisible();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Advanced model tuning'));
    expect(screen.getByText('Prompt guidance')).toBeVisible();
    expect(screen.getByText('Sound variation')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(resetVoiceControls).toHaveBeenCalled();
  });

  it('offers an icon-only reset in the Voice controls header', () => {
    render(<VoiceControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Voice controls' }));
    const reset = screen.getByRole('button', { name: 'Reset to defaults' });
    expect(reset.textContent).toBe('');
    expect(reset.querySelector('svg')).not.toBeNull();
    resetVoiceControls.mockClear();
    fireEvent.click(reset);
    expect(resetVoiceControls).toHaveBeenCalledTimes(1);
  });

  it('calls generate from the primary action', () => {
    render(<ActionBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Synthesize audio' }));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('shows the keyboard shortcut inside the primary action, not as loose text', () => {
    render(<ActionBar />);
    const button = screen.getByRole('button', { name: 'Synthesize audio' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    expect(button.querySelectorAll('[data-slot="kbd"]')).toHaveLength(2);
    expect(button).toHaveTextContent('↵');
  });

  it('keeps the action fixed while showing the real model-loading phase and progress', () => {
    Object.assign(runtime, {
      isGenerating: true,
      elapsedSeconds: 3.4,
      stage: 'loading',
      modelStage: 'compiling',
      modelProgress: 62,
    });
    render(<ActionBar />);

    expect(screen.getByRole('button', { name: 'Optimizing model…' })).toHaveClass('w-60');
    expect(screen.getByText('62% · 3.4s')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
  });
});

vi.mock('@/hooks/use-engines', () => ({ useEngines: () => ({ activeTts: null }) }));
// Settings → Reading has its own tests; this suite renders without a QueryClient.
vi.mock('@/components/reading-settings', () => ({ ReadingSettingsButton: () => null }));
