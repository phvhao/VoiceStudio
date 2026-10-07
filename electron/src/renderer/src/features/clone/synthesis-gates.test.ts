import { afterEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import {
  SYNTHESIS_TARGET,
  cloneBlockers,
  describeSynthesisBlockers,
  designBlockers,
} from './synthesis-gates';

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as unknown as TFunction;

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it('names what Clone lacks, with an empty script beside whatever else blocks it', () => {
  expect(cloneBlockers(null, '')).toEqual([]);
  expect(cloneBlockers('text', '')).toEqual(['no_text']);
  expect(cloneBlockers('engine', '')).toEqual(['tts_engine', 'no_text']);
  expect(cloneBlockers('engine', 'Hello')).toEqual(['tts_engine']);
  expect(cloneBlockers('loading', ' ')).toEqual(['tts_loading', 'no_text']);
  expect(cloneBlockers('cloning', 'Hello')).toEqual(['clone_unsupported']);
  expect(cloneBlockers('reference', '')).toEqual(['no_voice', 'no_text']);
  expect(cloneBlockers('preparing', 'Hello')).toEqual(['voice_sample_busy']);
});

it('names what Voice Design lacks, engine first', () => {
  expect(designBlockers(null, 'Hello')).toEqual([]);
  expect(designBlockers(null, '')).toEqual(['no_text']);
  expect(designBlockers('engine', '')).toEqual(['tts_engine', 'no_text']);
  expect(designBlockers('loading', 'Hello')).toEqual(['tts_loading']);
  expect(designBlockers('design', 'Hello')).toEqual(['design_unsupported']);
  expect(designBlockers('cloning', '')).toEqual(['reuse_unsupported', 'no_text']);
});

it('says each reason as what to do and gives a way to every fix the user can make', () => {
  const described = describeSynthesisBlockers(
    [
      'voice_sample_busy',
      'tts_loading',
      'tts_engine',
      'clone_unsupported',
      'design_unsupported',
      'reuse_unsupported',
      'no_voice',
      'no_text',
    ],
    { t, engine: 'IndexTTS2', script: SYNTHESIS_TARGET.designScript, openSettings: vi.fn() },
  );
  expect(described.map((blocker) => blocker.message)).toEqual([
    'gatedAction.voice_sample_busy',
    'gatedAction.tts_loading',
    'gatedAction.tts_engine',
    'convert.cloning_required',
    'designWorkspace.engine_cannot_design {"engine":"IndexTTS2"}',
    'designWorkspace.engine_cannot_reuse_sample {"engine":"IndexTTS2"}',
    'gatedAction.no_voice',
    'gatedAction.no_text',
  ]);
  // A recording or a starting engine ends by itself.
  expect(described.filter((blocker) => !blocker.fix).map((blocker) => blocker.id)).toEqual([
    'voice_sample_busy',
    'tts_loading',
  ]);
  expect(described.find((blocker) => blocker.id === 'design_unsupported')?.fix?.label).toBe(
    'gatedAction.open_settings',
  );
});

it('leads to the control on the page, or somewhere that fixes it when the page has none', () => {
  vi.useFakeTimers();
  const openSettings = vi.fn();
  const chooseVoice = vi.fn();
  const fixes = Object.fromEntries(
    describeSynthesisBlockers(['tts_engine', 'no_voice', 'no_text', 'clone_unsupported'], {
      t,
      script: SYNTHESIS_TARGET.cloneScript,
      openSettings,
      chooseVoice,
    }).map((blocker) => [blocker.id, blocker.fix!]),
  );
  fixes.tts_engine.onSelect();
  fixes.no_voice.onSelect();
  expect(openSettings).toHaveBeenCalledOnce();
  expect(chooseVoice).toHaveBeenCalledOnce();
  document.body.innerHTML = `
    <div data-gate-target="${SYNTHESIS_TARGET.engine}"><button>Fix</button></div>
    <button data-gate-target="${SYNTHESIS_TARGET.cloneVoice}">Voice · Mara</button>
    <textarea aria-label="Script" data-gate-target="${SYNTHESIS_TARGET.cloneScript}"></textarea>`;
  fixes.tts_engine.onSelect();
  expect(document.activeElement).toHaveTextContent('Fix');
  fixes.no_voice.onSelect();
  expect(document.activeElement).toHaveTextContent('Voice · Mara');
  fixes.no_text.onSelect();
  expect(document.activeElement).toHaveAttribute('aria-label', 'Script');
  expect(openSettings).toHaveBeenCalledOnce();
  expect(chooseVoice).toHaveBeenCalledOnce();
  // An engine that cannot clone has nothing on the page to fix it: its settings.
  fixes.clone_unsupported.onSelect();
  expect(openSettings).toHaveBeenCalledTimes(2);
});
