import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STATIC_IMPORT =
  /(?:^|[;\n])\s*(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?["']\.\/([^"']+\.js)["']/g;
const REGION = /^\/\/#region (.+)$/gm;

/**
 * The source modules of a built renderer (`out/renderer`), as its chunks'
 * `//#region` comments name them. `startup` holds what index.html loads before
 * the first render (the entry chunk and every chunk it imports statically);
 * `all` holds every chunk's.
 */
export function rendererModules(rendererDir) {
  const assets = join(rendererDir, 'assets');
  const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
  const entry = /<script[^>]+type="module"[^>]+src="\.\/assets\/([^"]+)"/.exec(html)?.[1];
  if (!entry) throw new Error('The renderer index.html loads no module entry');
  const source = (chunk) => readFileSync(join(assets, chunk), 'utf8');
  const regions = (chunk) =>
    [...source(chunk).matchAll(REGION)].map(([, path]) => path.replaceAll('\\', '/'));
  const startup = new Set();
  const pending = [entry];
  while (pending.length) {
    const chunk = pending.pop();
    if (startup.has(chunk)) continue;
    startup.add(chunk);
    for (const [, imported] of source(chunk).matchAll(STATIC_IMPORT)) pending.push(imported);
  }
  return {
    startup: [...startup].flatMap(regions),
    all: readdirSync(assets)
      .filter((file) => file.endsWith('.js'))
      .flatMap(regions),
  };
}

/** The modules in `modules` that come from the npm package `name`. */
export function fromPackage(modules, name) {
  return modules.filter((path) => path.includes(`node_modules/${name}/`));
}
