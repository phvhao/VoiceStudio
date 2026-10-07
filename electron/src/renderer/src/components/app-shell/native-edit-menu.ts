import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge } from '@/components/bridge';

/**
 * The desktop shell draws the edit menu of text fields natively (Undo, Cut,
 * Paste, spelling suggestions…); it labels it in the app's language, sent
 * again whenever the language or its catalog changes.
 */
export function useNativeEditMenuLabels(): void {
  const { t } = useTranslation();
  useEffect(() => {
    void getBridge()
      ?.editMenu?.labels({
        undo: t('editMenu.undo'),
        redo: t('editMenu.redo'),
        cut: t('context.cut'),
        copy: t('context.copy'),
        paste: t('context.paste'),
        selectAll: t('context.select_all'),
        addToDictionary: t('editMenu.add_to_dictionary'),
        noSuggestions: t('editMenu.no_suggestions'),
      })
      .catch(() => {
        /* The menu keeps its previous labels. */
      });
  }, [t]);
}
