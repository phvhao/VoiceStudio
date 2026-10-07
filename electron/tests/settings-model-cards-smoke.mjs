// Settings → Models cards: a gated model's access panel stays inside its card
// at every width, its text wraps instead of being cut off, a short card is not
// stretched to its tall neighbour, and backend reason codes show in the app's
// language rather than as the backend's English sentence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const catalog = async (locale) =>
  JSON.parse(
    await readFile(
      new URL(`../src/renderer/src/i18n/locales/${locale}.json`, import.meta.url),
      'utf8',
    ),
  );

const diarisation = {
  active: 'pyannote',
  label: 'pyannote 3.1',
  model: 'pyannote/speaker-diarization-3.1',
  installed: false,
  loaded: false,
  reason: 'Install the pyannote model bundle',
  reason_code: 'pyannote_not_installed',
  options: [
    {
      id: 'pyannote',
      label: 'pyannote 3.1',
      model: 'pyannote/speaker-diarization-3.1',
      installed: false,
      reason: 'Install the pyannote model bundle',
      reason_code: 'pyannote_not_installed',
    },
  ],
};
const models = {
  target: 'local',
  disk_free_gb: 100,
  disk_headroom_gb: 10,
  models: [
    {
      repo_id: 'audio-cpp/audio.cpp-gguf',
      label: 'audio.cpp native bundle (Breeze-TTS-2 + Sortformer diarisation)',
      role: 'TTS',
      families: ['tts', 'diarisation'],
      size_gb: 4.98,
      installed: false,
      supported: true,
    },
    {
      repo_id: 'pyannote/speaker-diarization-3.1',
      label: 'pyannote speaker diarisation (multi-speaker videos)',
      role: 'Diarisation',
      size_gb: 0.8,
      installed: false,
      supported: true,
      gated: true,
      requires_hf_token: true,
      access_url: 'https://huggingface.co/pyannote/speaker-diarization-3.1',
      prerequisite_access_url: 'https://huggingface.co/pyannote/segmentation-3.0',
      incomplete: true,
      size_on_disk_bytes: 10985,
    },
  ],
};
const fixtures = {
  '/api/health': { status: 'ok' },
  '/api/setup/status': { ready: true },
  '/api/engines/diarisation': diarisation,
  '/api/engines/audiocpp/runtime/install/status': {
    installed: false,
    supported: false,
    job: { state: 'idle', progress: 0 },
  },
  '/api/models': models,
  '/api/models/install/status': { jobs: [] },
  '/api/model/loaded': { models: [], count: 0 },
  '/api/workers/target': {
    target: 'local',
    op: 'tts',
    active: { remote: false, label: 'Local', reason: '' },
    targets: [],
    remote_operations: [],
  },
  '/api/profiles': [],
};

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  headless: true,
});
try {
  for (const locale of ['vi', 'de']) {
    const strings = await catalog(locale);
    for (const [width, height] of [
      [1280, 800],
      [1920, 1080],
      [900, 700],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((selected) => {
        localStorage.setItem('voicestudio.setup.complete.v1', '1');
        localStorage.setItem('voicestudio.locale', selected);
      }, locale);
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => {
          const path = new URL(route.request().url()).pathname;
          return path in fixtures
            ? route.fulfill({ json: fixtures[path] })
            : route.fulfill({ status: 404, json: { detail: 'Not mocked' } });
        },
      );
      await page.goto(
        (process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912') +
          '/#/settings/models/diarisation',
      );
      const context = `${locale} at ${width}px`;

      const reason = strings.engineReason.diarisation.pyannote_not_installed;
      await page.getByText(reason, { exact: true }).waitFor({ timeout: 30_000 });
      assert.equal(
        await page.getByText(diarisation.reason, { exact: true }).count(),
        0,
        `${context}: the backend's English reason is shown`,
      );

      const summary = page.getByText(strings.modelMaintenance.gatedAccessRequired, {
        exact: true,
      });
      await summary.click();
      await page.getByText(strings.modelMaintenance.requestModelAccess).waitFor();

      const layout = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-slot="settings-row"].min-h-40')];
        const escapes = [];
        for (const card of cards) {
          const box = card.getBoundingClientRect();
          for (const child of card.querySelectorAll('*')) {
            const r = child.getBoundingClientRect();
            if (r.width && r.height && (r.right > box.right + 1 || r.left < box.left - 1))
              escapes.push(`${child.tagName} "${(child.textContent || '').trim().slice(0, 40)}"`);
          }
        }
        const text = document.querySelector('details summary span');
        return {
          escapes,
          clipped: text ? text.scrollWidth > text.clientWidth + 1 : true,
          heights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),
          tops: cards.map((card) => Math.round(card.getBoundingClientRect().top)),
        };
      });
      assert.deepEqual(layout.escapes, [], `${context}: content escapes its card`);
      assert.equal(layout.clipped, false, `${context}: the access summary is cut off`);
      const [bundle, gated] = layout.heights;
      if (layout.tops[0] === layout.tops[1])
        assert.ok(bundle < gated, `${context}: the short card stretched to ${bundle}px`);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${context}: the page scrolls sideways`,
      );
      assert.deepEqual(errors, [], `${context}: renderer errors`);
      await page.close();
    }
  }
  console.log('PASS: model cards keep their access panel inside, wrap, and localize reasons');
} finally {
  await browser.close();
}
