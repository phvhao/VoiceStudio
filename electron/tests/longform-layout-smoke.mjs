import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  headless: true,
});
try {
  const page = await browser.newPage({ bypassCSP: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('voicestudio.setup.complete.v1', '1'));
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      const fixtures = {
        '/api/health': { status: 'ok' },
        '/api/setup/status': { ready: true },
        '/api/models/install/status': { jobs: [] },
        '/api/workers/target': {
          target: 'local',
          op: 'tts',
          active: { remote: false, label: 'Local', reason: '' },
          targets: [],
          remote_operations: [],
        },
        '/api/profiles': [],
      };
      return path in fixtures
        ? route.fulfill({ json: fixtures[path] })
        : route.fulfill({ status: 404, json: { detail: 'Not mocked' } });
    },
  );
  await page.goto((process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912') + '/#/stories');
  await page.locator('[data-slot=generate-panel]').waitFor({ timeout: 30000 });
  await page.evaluate(async () => {
    const { longformSession } = await import('/src/features/longform/longform-session.ts');
    longformSession.setState((state) => ({
      ...state,
      active: 'stories',
      stage: 'rendering',
      total: 100,
      drafts: {
        ...state.drafts,
        stories: {
          ...state.drafts.stories,
          lines: Array.from({ length: 50 }, (_, i) => ({
            id: String(i),
            text: `Line ${i + 1}`,
            profileId: null,
          })),
        },
      },
      chapters: Array.from({ length: 100 }, (_, i) => ({
        title: `Chapter ${i + 1}`,
        status: 'pending',
      })),
    }));
  });
  for (const width of [1400, 640]) {
    await page.setViewportSize({ width, height: 720 });
    await page.waitForTimeout(200);
    const button = page.getByRole('button', { name: 'Stop', exact: true });
    const box = await button.boundingBox();
    const sidebar = await page.locator('[data-slot=secondary-sidebar]').boundingBox();
    assert(
      box && box.y >= sidebar.y && box.y + box.height <= sidebar.y + sidebar.height + 1,
      `Stop escapes the setup pane at ${width}px`,
    );
    await page.locator('[data-slot=secondary-sidebar-header] button').click();
    const editor = page
      .locator('[data-slot=secondary-sidebar]')
      .locator('xpath=following-sibling::section');
    for (const atEnd of [false, true]) {
      await editor.evaluate((element, end) => {
        element.scrollTop = end ? element.scrollHeight : 0;
      }, atEnd);
      const collapsedBox = await button.boundingBox();
      const editorBox = await editor.boundingBox();
      assert(
        collapsedBox &&
          collapsedBox.y >= editorBox.y &&
          collapsedBox.y + collapsedBox.height <= editorBox.y + editorBox.height + 1,
        `Stop is unreachable with collapsed setup at ${width}px (end=${atEnd})`,
      );
    }
    await page.locator('[data-slot=secondary-sidebar-header] button').click();
  }
  // The title bar — Back/Forward, the title, the book's name and the link to
  // the other mode — keeps its controls apart and the title on one line.
  for (const screen of ['stories', 'audiobook']) {
    await page.goto((process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912') + '/#/' + screen);
    await page.locator('header.workspace-titlebar h1').waitFor();
    for (const width of [900, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(200);
      const crowding = await page.evaluate(() => {
        const header = document.querySelector('header.workspace-titlebar');
        const items = [...header.querySelectorAll('h1, a, button')]
          .map((element) => ({ element, box: element.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.height > 0);
        const problems = [];
        for (const [index, a] of items.entries())
          for (const b of items.slice(index + 1)) {
            if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
            const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
            const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
            if (x > 1 && y > 1)
              problems.push(`${a.element.textContent} overlaps ${b.element.textContent}`);
          }
        const title = document.createRange();
        title.selectNodeContents(header.querySelector('h1'));
        if (title.getClientRects().length > 1) problems.push('the title wraps');
        return problems;
      });
      assert.deepEqual(crowding, [], `the ${screen} title bar is crowded at ${width}px`);
    }
  }
  // A very wide window: the editor frame fills the column beside the setup
  // pane (no centred cap leaving empty margins), and its text keeps to the
  // reading measure — about 100ch, centred, on both layers alike — until the
  // viewer chooses to fit the frame.
  await page.setViewportSize({ width: 2304, height: 1296 });
  await page.goto((process.env.VOICESTUDIO_UI_URL || 'http://localhost:3912') + '/#/audiobook');
  await page.locator('[data-slot=audiobook-editor]').waitFor();
  await page.evaluate(async () => {
    const { longformSession } = await import('/src/features/longform/longform-session.ts');
    const paragraph =
      'The rain had not stopped for three days, and the river beneath the old bridge had risen until it licked the arches. '.repeat(
        6,
      );
    longformSession.setState((state) => ({
      ...state,
      active: 'audiobook',
      stage: 'idle',
      drafts: {
        ...state.drafts,
        audiobook: {
          ...state.drafts.audiobook,
          script: `# Chapter One

[voice:Mara] ${paragraph}

# Chapter Two

${paragraph}`,
        },
      },
    }));
  });
  const wide = () =>
    page.evaluate(() => {
      const frame = document.querySelector('[data-slot=audiobook-editor]').getBoundingClientRect();
      const column = document
        .querySelector('[data-slot=audiobook-editor]')
        .closest('section')
        .getBoundingClientRect();
      const textarea = document.querySelector('[data-slot=audiobook-editor] textarea');
      const overlay = textarea.parentElement.querySelector('[aria-hidden=true]');
      const style = getComputedStyle(textarea);
      const ruler = document.createElement('span');
      ruler.textContent = '0'.repeat(100);
      Object.assign(ruler.style, { font: style.font, position: 'absolute', whiteSpace: 'pre' });
      document.body.append(ruler);
      const measure = ruler.getBoundingClientRect().width;
      ruler.remove();
      const padding = (element) =>
        ['paddingLeft', 'paddingRight'].map((side) =>
          Math.round(parseFloat(getComputedStyle(element)[side])),
        );
      const [start, end] = padding(textarea);
      return {
        margins: [frame.left - column.left, column.right - frame.right],
        text: textarea.clientWidth - start - end,
        measure,
        padding: [start, end],
        overlay: padding(overlay),
        rail: document.querySelector('[data-slot=contents-rail]')?.getBoundingClientRect().width,
        stored: localStorage.getItem('voicestudio.editor-measure'),
      };
    });
  const measureButton = (name) =>
    page
      .locator('[data-slot=audiobook-editor] [data-slot=editor-measure]')
      .getByRole('button', { name, exact: true });
  for (const mode of ['Fit frame', 'Reading width']) {
    await measureButton(mode).click();
    await page.waitForTimeout(200);
    assert.equal(await measureButton(mode).getAttribute('aria-pressed'), 'true');
    const layout = await wide();
    assert(
      layout.margins.every((margin) => margin <= 48),
      `the editor frame leaves empty margins in a wide window: ${JSON.stringify(layout)}`,
    );
    assert(layout.rail > 256, `the contents rail keeps its narrow width: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.overlay, layout.padding, 'the overlay is padded unlike the editor');
    if (mode === 'Fit frame') {
      assert.equal(layout.stored, 'fit');
      assert(layout.text > layout.measure, `Fit frame keeps to the measure: ${JSON.stringify(layout)}`);
    } else {
      assert.equal(layout.stored, 'reading');
      assert(
        layout.text <= layout.measure + 1,
        `Reading width runs past 100ch: ${JSON.stringify(layout)}`,
      );
      assert(
        Math.abs(layout.padding[0] - layout.padding[1]) <= 1,
        `the reading column is off centre: ${JSON.stringify(layout)}`,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Longform Stop stays inside the setup pane, the title bar keeps its controls apart, and a wide window fills the editor frame with the text at its reading measure.',
  );
} finally {
  await browser.close();
}
