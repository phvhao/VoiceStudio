// Long translations keep each screen's title, its main action's words and the
// dub segment toolbar whole. The title bar gives up the Get Pro and Star words
// before the title, Synthesize widens instead of cutting its label, and the
// segment toolbar drops words, then wraps, before anything overlaps or clips.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { wave } from './test-wave.mjs';

const baseUrl = process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912';
const localeRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
  'src',
  'i18n',
  'locales',
);
const catalog = async (locale) =>
  JSON.parse(await readFile(join(localeRoot, `${locale}.json`), 'utf8'));

const now = Date.now() / 1000;
const fixtures = {
  '/health': { status: 'ok' },
  '/setup/status': { ready: true, models_ready: true, missing: [] },
  '/setup/recommendations': { target: 'local', models: [] },
  '/models/install/status': { jobs: [] },
  '/settings/analytics': { available: false, prompted: true, opted_in: false },
  '/settings/llm-skills': { skills: [] },
  '/engines': {
    tts: {
      active: 'omnivoice',
      active_model: 'tts-model',
      backends: [
        {
          id: 'omnivoice',
          name: 'OmniVoice',
          display_name: 'OmniVoice',
          available: true,
          supports_cloning: true,
        },
      ],
    },
    asr: { backends: [] },
    llm: { backends: [] },
  },
  '/engines/translation': {
    active: 'argos',
    engines: [{ id: 'argos', display_name: 'Argos', installed: true, category: 'offline' }],
  },
  '/engines/translation/argos/packs/status': { pairs: [] },
  '/models': {
    target: 'local',
    models: [
      {
        repo_id: 'tts-model',
        label: 'OmniVoice',
        role: 'tts',
        size_gb: 1,
        installed: true,
        supported: true,
      },
    ],
  },
  '/model/status': { status: 'ready', loading: false },
  '/model/loaded': { models: [], count: 0 },
  '/profiles': [
    {
      id: 'p001',
      name: 'Narrator',
      kind: 'clone',
      ref_audio_path: 'p001.wav',
      audio_url: '/profiles/p001/audio?v=1',
      audio_duration_seconds: 9.4,
      language: 'English',
      created_at: now,
      image_url: null,
    },
  ],
  '/history': [],
  '/batch/jobs': [],
  '/dub/upload': { job_id: 'fixture', task_id: 'prep-fixture' },
};
const transcript = {
  segments: [
    {
      id: '1',
      start: 0,
      end: 2,
      text: 'Hello there. How are you today?',
      speaker_id: 'SPEAKER_00',
    },
    { id: '2', start: 3, end: 5, text: 'Second line', speaker_id: 'SPEAKER_01' },
  ],
  source_lang: 'en',
  cast_sources: { SPEAKER_00: {}, SPEAKER_01: {} },
};

function answer(route) {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^\/api(?:\/api)?/, '');
  if (/^\/profiles\/[^/]+\/audio$/.test(path) || path === '/dub/audio/fixture')
    return route.fulfill({ contentType: 'audio/wav', body: wave });
  if (path === '/tasks/stream/prep-fixture')
    return route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"type":"ready","duration":6}\n\n',
    });
  if (path.startsWith('/dub/transcribe-stream/fixture'))
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `event: final\ndata: ${JSON.stringify(transcript)}\n\nevent: done\ndata: {}\n\n`,
    });
  if (path === '/workers/target')
    return route.fulfill({
      json: {
        target: 'local',
        op: url.searchParams.get('op') || 'tts',
        active: { remote: false, label: 'Local', reason: '' },
        targets: [],
        remote_operations: [],
      },
    });
  return path in fixtures
    ? route.fulfill({ json: fixtures[path] })
    : route.fulfill({ status: 404, json: { detail: 'Not mocked' } });
}

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  headless: true,
});

async function open(locale, viewport, route) {
  const context = await browser.newContext({ viewport });
  // The bundled star count keeps the title bar's width the same offline.
  await context.route(
    (url) => url.hostname === 'api.github.com',
    (request) => request.abort(),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((language) => {
    localStorage.setItem('voicestudio.setup.complete.v1', '1');
    localStorage.setItem('voicestudio.locale', language);
    localStorage.setItem('omnivoice.dubbingDemoDismissed', '1');
  }, locale);
  await page.route((url) => url.pathname.startsWith('/api/'), answer);
  await page.goto(`${baseUrl}/#/${route}`);
  return { context, page, errors };
}

// Text cut short inside `selector`: an element whose content is wider than it.
const clipped = (page, selector) =>
  page.$$eval(selector, (elements) =>
    elements
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map(
        (element) =>
          `${(element.textContent || '').trim().slice(0, 40)} ${element.scrollWidth}>${element.clientWidth}`,
      ),
  );

// Visible controls inside `selector` whose boxes cover one another.
const overlapping = (page, selector) =>
  page.$eval(selector, (root) => {
    const controls = [...root.querySelectorAll('button, [role=combobox]')].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    const pairs = [];
    for (const [index, first] of controls.entries()) {
      const a = first.getBoundingClientRect();
      for (const second of controls.slice(index + 1)) {
        const b = second.getBoundingClientRect();
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (width > 1 && height > 1)
          pairs.push(`${first.getAttribute('aria-label')} × ${second.getAttribute('aria-label')}`);
      }
    }
    return pairs;
  });

try {
  // Clone with the voice sample pane open leaves the title bar its narrowest.
  for (const locale of ['vi', 'ru']) {
    const strings = await catalog(locale);
    const { context, page, errors } = await open(locale, { width: 1280, height: 800 }, 'clone');
    await page.locator('[data-choose]').first().click({ timeout: 30000 });
    await page.locator('[data-clone-script]').fill('Hello there. How are you today?');
    await page.locator(`main button[title="${strings.cloneFlow.voice_sample}"]`).click();
    await page.waitForFunction(
      () => document.querySelector('main header')?.dataset.fit !== undefined,
    );
    await page.waitForTimeout(300);
    assert.deepEqual(await clipped(page, 'main header h1'), [], `${locale}: Clone title cut short`);
    assert.deepEqual(
      await clipped(page, '[data-clone-generate] span.truncate'),
      [],
      `${locale}: Synthesize label cut short`,
    );
    assert.deepEqual(errors, [], `${locale} Clone emitted renderer errors`);
    await context.close();
  }

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 900, height: 700 },
  ]) {
    const { context, page, errors } = await open('vi', viewport, 'dub');
    const toolbar = '[data-slot="dub-segment-toolbar"]';
    await page.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 30000 });
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: wave });
    await page.locator(toolbar).waitFor({ timeout: 30000 });
    await page.waitForTimeout(300);
    const size = `${viewport.width}x${viewport.height}`;
    assert.deepEqual(
      await clipped(page, `${toolbar} [data-fit-part]`),
      [],
      `vi ${size}: toolbar clips`,
    );
    assert.deepEqual(await overlapping(page, toolbar), [], `vi ${size}: toolbar controls overlap`);
    assert.deepEqual(errors, [], `vi ${size} Dub emitted renderer errors`);
    await context.close();
  }
  console.log('Long-locale title bars, Synthesize and the dub toolbar fit.');
} finally {
  await browser.close();
}
