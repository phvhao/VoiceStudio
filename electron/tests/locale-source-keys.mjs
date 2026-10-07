import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const sourceDirectory = new URL('../src/renderer/src/', import.meta.url);
const englishPath = new URL('../src/renderer/src/i18n/locales/en.json', import.meta.url);

function flatten(value, prefix = '', output = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output.add(path);
    else if (child && typeof child === 'object') flatten(child, path, output);
  }
  return output;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...(await sourceFiles(url)));
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name))
      files.push(url);
  }
  return files;
}

const catalog = flatten(JSON.parse(await readFile(englishPath, 'utf8')));
const used = new Map();
const callPattern = /\b(?:t|tr)\(\s*(['"])([A-Za-z0-9_.:-]+)\1/g;
const transPattern = /\bi18nKey\s*=\s*(['"])([A-Za-z0-9_.:-]+)\1/g;

// A key chosen by a condition, t(open ? 'paneActions.collapse' : 'paneActions.expand'),
// is as literal as one passed directly: both branches must exist.
const callStart = /\b(?:t|tr)\(/g;
const keyLiteral = /(['"])([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\1/g;

/** The call's first argument, up to its top-level comma or closing parenthesis. */
function firstArgument(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char) || (char === ',' && depth === 0)) {
      if (depth === 0) return source.slice(start, index);
      depth--;
    }
  }
  return '';
}

function* conditionalKeys(source) {
  for (const call of source.matchAll(callStart)) {
    const start = call.index + call[0].length;
    const argument = firstArgument(source, start);
    // A ternary (not ?. or ??) choosing between whole keys; a concatenated
    // key ('prefix.' + (a ? 'b' : c)) is checked through its catalog entries.
    if (!/\?[^.?]/.test(argument) || !argument.includes(':') || argument.includes('+')) continue;
    for (const literal of argument.matchAll(keyLiteral)) {
      // Not a key: half of a concatenation, or the value a condition compares.
      const before = argument.slice(0, literal.index).trimEnd().at(-1);
      const after = argument.slice(literal.index + literal[0].length).trimStart()[0];
      if (before === '+' || before === '=' || after === '+' || after === '=') continue;
      yield { key: literal[2], index: start + literal.index };
    }
  }
}

const sharedControls = ['SearchableSelect', 'VoiceSelector'].map((name) =>
  new URL(`../src/shared/components/${name}.jsx`, import.meta.url));
for (const file of [...await sourceFiles(sourceDirectory), ...sharedControls]) {
  const source = await readFile(file, 'utf8');
  const record = (key, index) => {
    // Concatenated prefixes such as t('batch.status_' + status) are checked
    // through their concrete catalog entries, not as literal keys.
    if (/[._:]$/.test(key)) return;
    const line = source.slice(0, index).split('\n').length;
    const locations = used.get(key) ?? [];
    const location = `${file.pathname.split('/src/renderer/src/')[1] ?? file.pathname}:${line}`;
    if (!locations.includes(location)) locations.push(location);
    used.set(key, locations);
  };
  for (const pattern of [callPattern, transPattern]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) record(match[2], match.index);
  }
  for (const { key, index } of conditionalKeys(source)) record(key, index);
}

const missing = [...used].filter(
  ([key]) => !catalog.has(key) && !(catalog.has(`${key}_one`) && catalog.has(`${key}_other`)),
);
assert.deepEqual(
  missing,
  [],
  `Renderer uses ${missing.length} i18n key(s) absent from en.json:\n${missing
    .map(([key, locations]) => `  ${key} (${locations.join(', ')})`)
    .join('\n')}`,
);
console.log(`Locale source keys: ${used.size} static renderer keys exist in en.json`);
