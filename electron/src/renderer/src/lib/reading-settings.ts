import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '@/lib/api/client';
import {
  DEFAULT_READING,
  punctuationPauses,
  readingFromSettings,
  type Reading,
  type ReadingSettingsBody,
} from '@shared/utils/longformOverrides';

const KEY = ['reading-settings'];

/**
 * Settings → Reading, shared by every surface that reads text aloud (Audiobook,
 * Stories, Clone, Voice Design). The server applies it to any request
 * that does not carry its own values.
 */
export function useReadingSettings() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => apiJson<ReadingSettingsBody>('/api/settings/reading', { signal }),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (reading: Reading) =>
      apiJson<ReadingSettingsBody>('/api/settings/reading', {
        method: 'PUT',
        body: JSON.stringify({
          phrase_rendering: reading.phraseRendering,
          punctuation_pauses: punctuationPauses(reading),
          split_commas: reading.splitCommas,
          verify_speech: reading.verifySpeech,
        }),
      }),
    onMutate: async (reading) => {
      // Inputs stay responsive while the save is in flight.
      await client.cancelQueries({ queryKey: KEY });
      client.setQueryData<ReadingSettingsBody>(KEY, {
        phrase_rendering: reading.phraseRendering,
        punctuation_pauses: punctuationPauses(reading),
        split_commas: reading.splitCommas,
        verify_speech: reading.verifySpeech,
      });
    },
    onSuccess: (saved) => client.setQueryData(KEY, saved),
    onError: () => void client.invalidateQueries({ queryKey: KEY }),
  });
  return {
    reading: query.data ? readingFromSettings(query.data) : DEFAULT_READING,
    loaded: query.isSuccess,
    error: query.error ?? mutation.error,
    save: (reading: Reading) => mutation.mutate(reading),
  };
}
