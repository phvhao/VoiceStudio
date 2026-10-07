import type { HistoryItem } from '@/lib/api/types';
import { designDraftFromTake, writeDraft } from '@/features/design/design-draft';
import { setCloneSetting } from '@/lib/store/clone-settings';
import { openTake, reuseTake } from '@/lib/store/takes';

/**
 * Put a take's script and settings back where it was made: a Voice Design
 * take becomes the design draft, a cloned take the Clone composer.
 */
export async function reuseHistoryTake(item: HistoryItem): Promise<void> {
  if (item.mode === 'design') {
    writeDraft(designDraftFromTake(item));
    setCloneSetting('language', item.language || 'Auto');
    openTake(null);
    return;
  }
  await reuseTake(item);
}
