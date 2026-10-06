import { CaptureWidget } from './features/transcriptions/capture-widget';
import { SiteBrowserHost } from './features/browser/site-browser-host';
import { installConsoleCapture } from '@shared/utils/consoleBuffer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/globals.css';
import './i18n';
import './hooks/use-appearance';
import { App } from './app';
import { installPreloadRecovery } from './lib/preload-recovery';
import { installGlobalErrorRecovery } from './lib/global-error-recovery';
import { installScriptSpellcheck } from './hooks/use-script-spellcheck';

installConsoleCapture();
installGlobalErrorRecovery();
installPreloadRecovery();
// The dictation widget is a window of its own with no editors to check.
if (window.location.hash !== '#/capture') installScriptSpellcheck();

createRoot(document.getElementById('root')!).render(
  window.location.hash === '#/capture' ? (
    <CaptureWidget />
  ) : (
    <StrictMode>
      <SiteBrowserHost>
        <App />
      </SiteBrowserHost>
    </StrictMode>
  ),
);
