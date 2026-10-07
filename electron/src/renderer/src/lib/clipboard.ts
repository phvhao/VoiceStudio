import { getBridge } from '@/components/bridge';

/**
 * The clipboard's text, for a Paste button. The page's Clipboard API answers
 * first; the desktop shell reads the clipboard when that API is missing or
 * refused (a permission policy, a document without focus). Throws when
 * neither can, so the caller can tell the user to paste with the keyboard.
 */
export async function readClipboardText(): Promise<string> {
  let refusal: unknown = new Error('Clipboard unavailable');
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch (error) {
      refusal = error;
    }
  }
  const desktop = getBridge()?.clipboard;
  if (!desktop) throw refusal;
  return desktop.readText();
}
