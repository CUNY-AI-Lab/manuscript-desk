// Model output and guideline text are drawn with textContent only. This check fails if any file
// under web/ (the vendored MuPDF build aside) names an API that parses HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const WEB = new URL('../web/', import.meta.url).pathname;
const VENDOR = join(WEB, 'vendor');
const SINKS = /innerHTML|insertAdjacentHTML|outerHTML|document\.write/;

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path === VENDOR) continue;
    if (entry.isDirectory()) found.push(...await files(path));
    else found.push(path);
  }
  return found;
}

test('no file under web/ uses an HTML sink', async () => {
  const checked = await files(WEB);
  assert.ok(checked.some(path => path.endsWith('format/app.js')) && checked.some(path => path.endsWith('format/rules-view.js')), 'the page scripts are checked');
  const offenders = [];
  for (const path of checked) {
    (await readFile(path, 'utf8')).split('\n').forEach((line, index) => {
      if (SINKS.test(line)) offenders.push(`${relative(WEB, path)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
