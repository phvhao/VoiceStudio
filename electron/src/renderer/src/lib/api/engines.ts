import type { TFunction } from 'i18next';
import { reasonText } from '@/lib/engine-reasons';
import { apiJson } from './client';
import type { EnginesResponse, SystemInfo } from './types';

export async function getEngines(): Promise<EnginesResponse> {
  return apiJson<EnginesResponse>('/engines');
}

export async function getSystemInfo(): Promise<SystemInfo> {
  return apiJson<SystemInfo>('/system/info');
}

/**
 * Unload resident model `id` (`POST /model/unload/{id}`). The backend answers
 * a refusal — in use by dictation or a speech check, busy, already gone — as
 * HTTP 200 with `success: false`; that rejects, with its reason in the app's
 * language, so no caller reports a model still loaded as unloaded.
 */
export async function unloadModel(id: string, t: TFunction): Promise<void> {
  const result = await apiJson<{ success?: boolean; reason?: string; reason_code?: string }>(
    `/model/unload/${encodeURIComponent(id)}`,
    { method: 'POST' },
  );
  if (result.success === false)
    throw new Error(reasonText(t, 'unload', result.reason_code, result.reason) || t('common.error'));
}
