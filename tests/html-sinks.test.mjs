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
  for (const script of ['app.js', 'rules-view.js', 'manuscript-step.js', 'manuscript-state.js', 'output-step.js', 'output-state.js']) {
    assert.ok(checked.some(path => path.endsWith(`format/${script}`)), `format/${script} is checked`);
  }
  const offenders = [];
  for (const path of checked) {
    (await readFile(path, 'utf8')).split('\n').forEach((line, index) => {
      if (SINKS.test(line)) offenders.push(`${relative(WEB, path)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('both pages say, in their markup, that this is a beta under test, that results must be checked, and where feedback goes', async () => {
  for (const page of ['index.html', 'format/index.html']) {
    const html = await readFile(join(WEB, page), 'utf8');
    const line = /<p id="beta-notice" class="notice info">(.*?)<\/p>/.exec(html)?.[1];
    assert.ok(line, `${page} has the beta line`);
    const text = line.replace(/<[^>]+>/g, '');
    assert.match(text, /^Beta, under test\. /, page);
    assert.match(text, /Check every result yourself before you submit/, page);
    assert.match(text, /Send feedback to the CUNY AI Lab\.$/, page);
    assert.ok(line.includes('<a href="https://ailab.gc.cuny.edu/">CUNY AI Lab</a>'), `${page} links the Lab as the Bibliography Converter's pages do`);
    // Right under the page's title, before the tools or the steps, and not hidden.
    const at = html.indexOf('id="beta-notice"');
    assert.ok(at > html.indexOf('<h1>') && at < Math.min(...['<section', '<ul class="tool-list"'].map(tag => html.indexOf(tag)).filter(index => index >= 0)), `${page} shows it before the tools or the steps`);
  }
});
