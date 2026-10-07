import type { TFunction } from 'i18next';
import { engineRoutingText } from './engine-reasons';

export interface EngineSelectionResult {
  active: string;
  routing_status?: string;
  routing_reason?: string | null;
  routing_reason_code?: string | null;
}

export interface EngineSelectionFeedback {
  tone: 'success' | 'warning';
  key: 'settings.engine_switched' | 'engines.selectCpuFallback' | 'engines.selectWithCaveat';
  values: { family: string; engine: string; reason?: string };
}

/**
 * Interpret the backend's host-routing verdict exactly once for every engine
 * picker. With `t`, the caveat is the app's translation of its code.
 */
export function engineSelectionFeedback(
  result: EngineSelectionResult,
  family: string,
  t?: TFunction,
): EngineSelectionFeedback {
  const reason = (t ? engineRoutingText(t, result) : result.routing_reason)?.trim();
  if (result.routing_status === 'cpu_fallback') {
    return {
      tone: 'warning',
      key: 'engines.selectCpuFallback',
      values: { family: family.toUpperCase(), engine: result.active, reason: reason || '' },
    };
  }
  if (result.routing_status === 'accelerated' && reason) {
    return {
      tone: 'warning',
      key: 'engines.selectWithCaveat',
      values: { family: family.toUpperCase(), engine: result.active, reason },
    };
  }
  return {
    tone: 'success',
    key: 'settings.engine_switched',
    values: { family: family.toUpperCase(), engine: result.active },
  };
}
