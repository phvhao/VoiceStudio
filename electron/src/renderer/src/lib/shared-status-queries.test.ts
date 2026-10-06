import { expect, it } from 'vitest';

const rendererSources = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;
const sources = Object.entries(rendererSources).filter(([path]) => !/\.test\.tsx?$/.test(path));

/**
 * Observers of one query key share one cache entry, and each observer's options
 * (its URL and interval) replace the others' whenever it renders. A status list
 * that several surfaces poll therefore has a single owner they all call: a
 * second definition once fetched the active batch list with `limit=1`, hiding
 * running jobs from the status bar, and per-surface copies of the compute target
 * tripled its polling.
 */
it.each([
  [/\[\s*['"]batch-jobs['"]\s*,\s*['"]active['"]\s*\]/, '/hooks/use-active-batch-jobs.ts'],
  [/\[\s*['"]workers['"]\s*,\s*['"]target['"]/, '/hooks/use-compute-target.ts'],
])('keeps %s in one hook', (key, owner) => {
  const definers = sources.filter(([, source]) => key.test(source)).map(([path]) => path);
  expect(definers).toEqual([expect.stringMatching(new RegExp(`${owner.replace('.', '\\.')}$`))]);
});

/** The option object of every `useQuery({ … })` call in `source`. */
function queryOptionObjects(source: string): string[] {
  const objects: string[] = [];
  for (const call of source.matchAll(/\buseQuery(?:<[^(]*?>)?\(\s*\{/g)) {
    const start = call.index + call[0].length - 1;
    let depth = 0;
    for (let at = start; at < source.length; at++) {
      if (source[at] === '{') depth++;
      else if (source[at] === '}' && --depth === 0) {
        objects.push(source.slice(start, at + 1));
        break;
      }
    }
  }
  return objects;
}

/**
 * A status poll keeps its answer for one poll, so a surface that remounts asks
 * nothing again; but an answer from before a backend restart describes a
 * process that is gone, and the workspace remounts once the new one is up.
 * Every poll of the backend that keeps its answer takes `staleTime` from
 * statusStaleTime, which ends it at a restart.
 */
it('keeps no polled backend status across a backend restart', () => {
  // Polls of something other than the backend.
  const elsewhere = ['/components/app-shell/github-star.tsx'];
  const kept = sources.flatMap(([path, source]) =>
    elsewhere.some((name) => path.endsWith(name))
      ? []
      : queryOptionObjects(source)
          .filter(
            (options) =>
              /\brefetchInterval\s*:/.test(options) &&
              /\bstaleTime\s*:(?!\s*0\s*[,}\n])/.test(options) &&
              !/\bstaleTime\s*:[^,\n]*\bstatusStaleTime\(/.test(options),
          )
          .map((options) => `${path}: ${/\bqueryKey\s*:\s*([^\n]*)/.exec(options)?.[1]}`),
  );
  expect(kept).toEqual([]);
  // The scan sees the polls it guards: the status bar's three.
  const [, statusBar] = sources.find(([path]) => path.endsWith('/app-shell/status-bar.tsx'))!;
  const guarded = queryOptionObjects(statusBar).filter((options) =>
    /statusStaleTime\(/.test(options),
  );
  expect(guarded).toHaveLength(3);
});

/** The native shortcut's preferences are read on change, not polled. */
it('refreshes the dictation shortcut preferences after every change to them', () => {
  const write = /['"]\/dictation\/prefs['"][\s\S]{0,200}?method:\s*['"]POST['"]/;
  const writers = sources.filter(([, source]) => write.test(source));
  expect(writers.length).toBeGreaterThan(0);
  const stale = writers
    .filter(
      ([, source]) => !/dictationPreferencesKey|['"]dictation-shortcut-prefs['"]/.test(source),
    )
    .map(([path]) => path);
  expect(stale).toEqual([]);
});
