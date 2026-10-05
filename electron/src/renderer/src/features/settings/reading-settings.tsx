import { useTranslation } from 'react-i18next';
import { TextQuoteIcon } from 'lucide-react';
import { GlobalReadingForm } from '@/components/reading-settings';
import { PipelineFailure } from '@/components/pipeline-failure';
import { describeError } from '@/lib/api/client';
import { useReadingSettings } from '@/lib/reading-settings';
import { SettingsRow, SettingsSection } from './settings-layout';

/** Settings → Reading: sentence-by-sentence reading, pauses, speech check. */
export function ReadingSettings() {
  const { t } = useTranslation();
  const { error } = useReadingSettings();
  return (
    <SettingsSection icon={TextQuoteIcon} title={t('pacing.settings_title')}>
      <SettingsRow
        id="reading-overview"
        title={t('pacing.title')}
        description={t('pacing.applies_to')}
      >
        <span />
      </SettingsRow>
      {error && (
        <div className="p-4">
          <PipelineFailure fallback={describeError(error)} />
        </div>
      )}
      <div className="max-w-xl p-4">
        <GlobalReadingForm />
      </div>
    </SettingsSection>
  );
}
