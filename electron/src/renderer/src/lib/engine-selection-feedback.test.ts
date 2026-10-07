import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { engineSelectionFeedback } from './engine-selection-feedback';

describe('engineSelectionFeedback', () => {
  it('warns when the selected engine loses acceleration', () => {
    expect(
      engineSelectionFeedback(
        {
          active: 'omnivoice',
          routing_status: 'cpu_fallback',
          routing_reason: 'CUDA is unavailable',
        },
        'tts',
      ),
    ).toEqual({
      tone: 'warning',
      key: 'engines.selectCpuFallback',
      values: { family: 'TTS', engine: 'omnivoice', reason: 'CUDA is unavailable' },
    });
  });

  it('surfaces an accelerated hardware caveat before generation', () => {
    expect(
      engineSelectionFeedback(
        {
          active: 'omnivoice',
          routing_status: 'accelerated',
          routing_reason: 'Long clips may exceed available VRAM',
        },
        'tts',
      ).key,
    ).toBe('engines.selectWithCaveat');
  });

  it('names the caveat in the app language when the backend sends its code', () => {
    const t = ((key: string) => `t:${key}`) as unknown as TFunction;
    expect(
      engineSelectionFeedback(
        {
          active: 'omnivoice',
          routing_status: 'cpu_fallback',
          routing_reason: 'GPU acceleration is unavailable; this engine will use CPU.',
          routing_reason_code: 'cpu_fallback',
        },
        'tts',
        t,
      ).values.reason,
    ).toBe('t:engineReason.routing.cpu_fallback');
  });

  it('keeps ordinary CPU-only selections as success', () => {
    expect(
      engineSelectionFeedback(
        { active: 'faster-whisper', routing_status: 'cpu_only', routing_reason: 'CPU engine' },
        'asr',
      ),
    ).toEqual({
      tone: 'success',
      key: 'settings.engine_switched',
      values: { family: 'ASR', engine: 'faster-whisper' },
    });
  });
});
