import type { TFunction } from 'i18next';

/** Catalog groups under `engineReason`, one per backend reason family. */
export type EngineReasonGroup = 'unavailable' | 'routing' | 'diarisation' | 'unload';

const CODE = /^[a-z][a-z0-9_]*$/;

/**
 * Localized text for a backend status reason.
 *
 * The backend sends a stable `*_code` beside each English sentence. The code
 * selects this app's translation; the sentence is kept for API clients and is
 * what a code this renderer does not know (a newer backend) falls back to.
 */
export function reasonText(
  t: TFunction,
  group: EngineReasonGroup,
  code: string | null | undefined,
  sentence: string | null | undefined,
): string | undefined {
  const fallback = sentence?.trim() || undefined;
  if (!code || !CODE.test(code)) return fallback;
  return t(`engineReason.${group}.${code}`, { defaultValue: fallback ?? '' }) || fallback;
}

/** Why an engine row is unavailable (`reason` / `reason_code`). */
export function engineUnavailableText(
  t: TFunction,
  engine: { reason?: string | null; reason_code?: string | null } | null | undefined,
): string | undefined {
  return reasonText(t, 'unavailable', engine?.reason_code, engine?.reason);
}

/** The caveat on an engine's compute routing (`routing_reason` / its code). */
export function engineRoutingText(
  t: TFunction,
  engine:
    | { routing_reason?: string | null; routing_reason_code?: string | null }
    | null
    | undefined,
): string | undefined {
  return reasonText(t, 'routing', engine?.routing_reason_code, engine?.routing_reason);
}

/** Why a translation provider is not ready (`availability_reason` / its code). */
export function providerUnavailableText(
  t: TFunction,
  provider:
    | { availability_reason?: string | null; availability_reason_code?: string | null }
    | null
    | undefined,
): string | undefined {
  return reasonText(
    t,
    'unavailable',
    provider?.availability_reason_code,
    provider?.availability_reason,
  );
}
