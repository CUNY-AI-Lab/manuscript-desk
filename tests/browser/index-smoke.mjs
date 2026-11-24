// Browser smoke test of the built Index Builder page, with the API routes mocked by request
// interception. Not part of `npm test`: it needs a browser and Playwright, which is not a dependency.
//   npm run build
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node tests/browser/index-smoke.mjs
// It uses Playwright's Chromium, or else installed Chrome. The files are the invented fixtures:
// tests/fixtures/manuscript.docx and book-index's tests/fixtures/index-sample.pdf.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { validateDocx } from '../../lib/docx/validate.js';
import { readDocx } from '../../lib/docx/read.js';
import { dropFiles, dropStray } from './drop-files.mjs';

const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const { chromium } = playwright.default ?? playwright;

const ROOT = resolve('dist');
const FIXTURES = resolve('tests/fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const CSP = /const CONTENT_SECURITY_POLICY = "([^"]+)"/.exec(await readFile('server/worker.js', 'utf8'))[1];
const MARKUP = '<img src=x onerror="window.__xss = 1">box';

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  let path = join(ROOT, decodeURIComponent(pathname.replace(/^\/manuscript/, '')));
  if (!path.startsWith(ROOT + sep) && path !== ROOT) { response.statusCode = 404; return response.end(); }
  if (pathname.endsWith('/')) path = join(path, 'index.html');
  try {
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-security-policy': CSP });
    response.end(body);
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const pageUrl = `http://127.0.0.1:${server.address().port}/manuscript/index/`;
const quota = { object: 'quota', unit: 'microdollar', limit: 50000000, estimated_used: 105038, estimated_remaining: 49894962, used_percent: 0, window_seconds: 2592000, window_technique: 'fixed', calculated_at: 1794285677 };
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-should-retry': 'false' }, body: JSON.stringify(body) });

const calls = { terms: [], judge: [], ranges: [] };
async function mock(context) {
  await context.route('**/manuscript/api/session', route => json(route, { authenticated: true }));
  await context.route('**/manuscript/api/quota', route => json(route, quota));
  await context.route('**/manuscript/api/model', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) }));
  await context.route('**/manuscript/api/index/terms', route => {
    const { passage } = JSON.parse(route.request().postData());
    calls.terms.push(passage);
    const entries = [];
    if (passage.includes('Ada Placeholder')) entries.push({ heading: 'Placeholder, Ada', kind: 'person', variants: [], quote: 'Ada Placeholder' });
    if (passage.includes('Keywords: lanterns')) entries.push({ heading: 'lanterns', kind: 'concept', variants: ['lantern'], quote: 'Keywords: lanterns, reading' });
    if (passage.includes('Opening the Box')) entries.push({ heading: MARKUP, kind: 'concept', variants: [], quote: 'Opening the Box' });
    entries.push({ heading: 'Invented Nonsense', kind: 'concept', variants: [], quote: 'words that are nowhere in the passage' });
    return json(route, { request_id: 'r', content: JSON.stringify({ entries }) });
  });
  await context.route('**/manuscript/api/index/ranges', route => {
    calls.ranges.push(JSON.parse(route.request().postData()).pages);
    return json(route, { request_id: 'r', content: JSON.stringify({ ranges: [{ kind: 'front-matter', first: 1, last: 2, heading: 'Title Page' }, { kind: 'notes', first: 3, last: 3, heading: 'Words not on the page' }] }) });
  });
  await context.route('**/manuscript/api/index/judge', route => {
    const { task, text } = JSON.parse(route.request().postData());
    calls.judge.push({ task, text });
    const numbers = [...text.matchAll(/^\[(\d+)\]/gm)].map(match => Number(match[1]));
    // A drop carries evidence: words of its own place, here the marked words themselves.
    const marked = n => /⟦([^⟧]+)⟧/.exec(text.split('\n').find(line => line.startsWith(`[${n}]`)) ?? '')?.[1] ?? '';
    const content = task === 'ambiguous'
      ? { decisions: numbers.map(hit => ({ hit, keep: false, reason: 'an exclamation, not the subject', evidence: marked(hit) })) }
      : { assignments: numbers.map(n => ({ n, subentry: 'S1' })) };
    return json(route, { request_id: 'r', content: JSON.stringify(content) });
  });
}

async function launch() {
  try { return await chromium.launch(); } catch { return chromium.launch({ channel: 'chrome' }); }
}
const log = (...line) => console.log('ok -', ...line);
const savedKeys = page => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('manuscript-desk-index', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('jobs');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const keys = request.result.transaction('jobs').objectStore('jobs').getAllKeys();
    keys.onsuccess = () => { request.result.close(); resolve(keys.result); };
    keys.onerror = () => reject(keys.error);
  };
}));
async function until(test, what) {
  for (let tries = 0; tries < 60; tries += 1) { if (await test()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`never: ${what}`);
}

const browser = await launch();
console.log(`# browser: ${browser.browserType().name()} ${browser.version()}`);
const scratch = await mkdtemp(join(tmpdir(), 'index-smoke-'));
const problems = [];
const dialogs = [];
try {
  const context = await browser.newContext({ acceptDownloads: true });
  await mock(context);
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.accept(); });
  await page.goto(pageUrl);
  await page.locator('#session-status', { hasText: 'Signed in with CUNY' }).waitFor();
  assert.equal(await page.locator('#model-select').count(), 0, 'no model menu');
  assert.equal(await page.locator('#session-status').textContent(), 'Signed in with CUNY');
  assert.match(await page.locator('#beta-notice').textContent(), /^Beta, under test\./);
  log('page opened: signed in, no model menu, beta line shown');

  // ---- Stage 1: propose terms from the invented manuscript ----
  assert.equal(await dropFiles(page, '#manuscript-drop', [join(FIXTURES, 'manuscript.docx')]), true, 'the drop area is marked while the file is over it');
  await page.locator('#manuscript-status', { hasText: '1 model call' }).waitFor();
  assert.equal(await page.locator('#manuscript-file').evaluate(input => input.files[0]?.name), 'manuscript.docx', 'the dropped file shows in the input as a chosen one does');
  assert.match(await page.locator('#manuscript-status').textContent(), /paragraphs? of bibliography left out.*by their headings/);
  await page.getByRole('button', { name: 'Propose terms' }).click();
  await page.locator('.term-row').first().waitFor();
  assert.ok(dialogs.some(message => /This makes 1 model call/.test(message)), 'the number of calls is said before the run');
  assert.equal(calls.terms.length, 1);
  assert.equal(calls.terms[0].includes('Placeholder, Ada. Invented Things.'), false, 'the bibliography is not sent');
  const headingsShown = () => page.locator('.term-heading').evaluateAll(inputs => inputs.map(input => input.value));
  const groupHeadings = group => page.locator(`#group-${group} .term-heading`).evaluateAll(inputs => inputs.map(input => input.value));
  // The default threshold hides concepts found on one page only; the name stays, in its own group.
  assert.deepEqual(await headingsShown(), ['Placeholder, Ada']);
  assert.deepEqual(await groupHeadings('names'), ['Placeholder, Ada']);
  assert.equal(await page.locator('#group-title-names').textContent(), 'Names (1)');
  assert.equal(await page.locator('#group-title-terms').textContent(), 'Subjects (2)');
  assert.equal(await page.locator('#group-names .group-counts').textContent(), '1 name: 0 accepted, 1 to review, 0 dropped.');
  assert.equal(await page.locator('#threshold-status-names').textContent(), 'Every proposal passes this.');
  assert.equal(await page.locator('#threshold-people').inputValue(), '1');
  assert.match(await page.locator('#threshold-status-terms').textContent(), /^2 proposals are below this and not shown\. They stay in the list\./);
  assert.equal(await page.locator('#threshold-concepts').inputValue(), '2');
  await page.getByRole('button', { name: 'Show the 2 proposals below the thresholds' }).click();
  assert.deepEqual((await headingsShown()).sort(), [MARKUP, 'Placeholder, Ada', 'lanterns'].sort());
  await page.getByRole('button', { name: 'Hide the proposals below the thresholds' }).click();
  assert.deepEqual(await headingsShown(), ['Placeholder, Ada']);
  await page.selectOption('#threshold-concepts', '1');
  assert.deepEqual((await headingsShown()).sort(), [MARKUP, 'Placeholder, Ada', 'lanterns'].sort());
  assert.deepEqual((await groupHeadings('terms')).sort(), [MARKUP, 'lanterns'].sort());
  assert.equal(await page.locator('#threshold-status-terms').textContent(), 'Every proposal passes this.');
  assert.match(await page.locator('.term-row', { has: page.locator('input[value="lanterns"]') }).textContent(), /on about 1 page/);
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'model text is never parsed as HTML');
  assert.match(await page.locator('.term-counts').textContent(), /3 entries: 0 accepted, 3 to review/);
  log('stage 1: one passage asked, bibliography not sent, an unverified quotation dropped, markup shown as text');
  log('two groups: the person under Names, the concepts under Subjects, each with its counts and its own threshold');
  log('threshold: concepts on one page hidden by default and shown on request; the author lowers it to every proposal');

  // Drop the odd one, accept the rest, merge nothing, download the list.
  await page.locator('.term-row', { has: page.locator(`input[value="${MARKUP.replaceAll('"', '\\"')}"]`) }).getByRole('button', { name: 'Drop' }).click();
  await page.getByRole('button', { name: /^Accept the 1 name shown$/ }).click();
  await page.getByRole('button', { name: /^Accept the 2 subjects shown$/ }).click();
  assert.match(await page.locator('.term-counts').textContent(), /3 entries: 3 accepted/);
  await page.locator('.term-row', { has: page.locator('input[value="lanterns"]') }).getByRole('button', { name: 'Drop' }).click();
  await page.locator('.term-row', { has: page.locator(`input[value="${MARKUP.replaceAll('"', '\\"')}"]`) }).getByRole('button', { name: 'Drop' }).click();
  const [listDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download the term list' }).click()]);
  const listText = await readFile(await listDownload.path(), 'utf8');
  assert.equal(listText, 'Names:\nPlaceholder, Ada\n');
  log('author review: drop, accept the shown, download the accepted list in book-index syntax');

  // ---- Stage 2: a term list for the invented PDF, matched with no model ----
  const listFile = join(scratch, 'terms.txt');
  await writeFile(listFile, 'Terms:\nintelligence\n  reports (report)\nfinancial\nhelp [ambiguous]\nContents\nNames:\nBush, George W.\nObama, Barack\n');
  await dropFiles(page, '#list-drop', [listFile]);
  await page.locator('.term-counts', { hasText: '9 entries' }).waitFor();
  assert.equal(await page.locator('#group-title-names').textContent(), 'Names (3)', 'the list\'s Names: line sorts its people into Names');
  await dropFiles(page, '#pdf-drop', [join(FIXTURES, 'index-sample.pdf')]);
  await page.locator('#match-status', { hasText: 'found on' }).waitFor({ timeout: 60000 });
  const preview = async () => (await page.locator('#index-preview p').allTextContents()).join('\n');
  let index = await preview();
  for (const line of ['Bush, George W., 2', 'Contents, ii', 'financial, 3', 'help, 4', 'intelligence, 4', 'reports, 1', 'Obama, Barack, 3']) assert.ok(index.includes(line), `${line} in:\n${index}`);
  assert.match(await page.locator('#output-status').textContent(), /Placeholder, Ada/, 'a term not in the proofs is named');
  log('stage 2 with no model: the list and the PDF dropped on their boxes, the PDF read in the worker, terms found with the PDF\'s page labels, a subentry by its own words');

  // ---- Pages the index does not cover ----
  await page.getByRole('button', { name: /Find these pages with a model \(1 call\)/ }).click();
  await page.locator('#ranges-area li').first().waitFor();
  assert.equal(await page.locator('#ranges-area li').count(), 1, 'a range whose heading is not on its first page is not shown');
  assert.match(calls.ranges[0], /^Pages 1 to 6 of the 6 in the PDF\.\n\[1\] \(printed i\) Title Page/);
  await page.locator('#ranges-area input[type=checkbox]').check();
  assert.match(await page.locator('#match-status').textContent(), /Find the terms in the proofs again/);
  await page.getByRole('button', { name: 'Find the terms in the proofs' }).click();
  await page.locator('#match-status', { hasText: '2 pages left out' }).waitFor();
  index = await preview();
  assert.equal(index.includes('Contents, ii'), false);
  log('page ranges: one call, the unverified range dropped, the confirmed range left out after finding again');

  // ---- Ambiguous hits ----
  const scopes = await page.locator('#judge-scope option').allTextContents();
  assert.deepEqual(scopes, ['The entries you marked ambiguous: 1 entry, 1 call', 'The entries the tool flags: 0 entries, 0 calls', 'Both: 1 entry, 1 call']);
  assert.equal(await page.locator('#judge-scope').inputValue(), 'marked', 'the author\'s marks first');
  await page.selectOption('#judge-scope', 'flagged');
  assert.equal(await page.locator('#judge-button').isDisabled(), true);
  assert.match(await page.locator('#judge-area').textContent(), /The tool flags no entry with hits\./);
  await page.selectOption('#judge-scope', 'marked');
  await page.getByRole('button', { name: /Judge 1 hit of 1 entry in context \(1 call\)/ }).click();
  await page.locator('#judge-area summary', { hasText: 'the model proposes dropping 1' }).waitFor();
  assert.ok((await preview()).includes('help, 4'), 'nothing is dropped before the author applies it');
  await page.locator('#judge-area summary').first().click();
  assert.match(await page.locator('#judge-area .review-note').first().textContent(), /^Model: drop \(an exclamation, not the subject\), because of “Help”$/);
  await page.getByRole('button', { name: 'Apply the model’s decisions' }).click();
  assert.equal((await preview()).includes('help, 4'), false);
  await page.locator('#judge-area input[type=checkbox]').first().check();
  assert.ok((await preview()).includes('help, 4'), 'a single decision can be reversed');
  log('judge: the scope chosen with its calls said first, 1 call, each drop with its verified evidence, applied on request, one reversed');

  // ---- Subentries ----
  await page.getByRole('button', { name: /Sort 2 hits into subentries \(1 call\)/ }).click();
  await page.locator('#sort-area summary', { hasText: 'reports: 2' }).waitFor();
  await page.locator('#sort-area summary').first().click();
  await page.getByRole('button', { name: 'Apply the sorting' }).click();
  index = await preview();
  assert.ok(index.includes('reports, 1, 4'), index);
  log('subentries: 1 call, sorting applied');

  // ---- Conventions and downloads ----
  await page.selectOption('#layout-select', 'run-in');
  assert.ok((await preview()).includes('intelligence: reports, 1, 4'));
  const [text] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download the index (.txt)' }).click()]);
  assert.match(await readFile(await text.path(), 'utf8'), /^B\nBush, George W\., 2\n/);
  const [word] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download the index (.docx)' }).click()]);
  const bytes = new Uint8Array(await readFile(await word.path()));
  assert.equal(validateDocx(bytes).ok, true);
  assert.ok(readDocx(bytes).paragraphs.some(paragraph => paragraph.text === 'intelligence: reports, 1, 4'));
  const [plain] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /as book-index gives it/ }).click()]);
  assert.match(await readFile(await plain.path(), 'utf8'), /^Bush, George W\.: 2\n/);
  log('run-in layout; .txt, a valid .docx and book-index\'s own list downloaded');

  // ---- Saved work ----
  await until(async () => (await savedKeys(page)).includes('index'), 'saved');
  await page.reload();
  await page.locator('.term-counts', { hasText: '9 entries' }).waitFor();
  assert.match(await page.locator('#match-status').textContent(), /Choose the same PDF/);
  assert.equal(await page.locator('#layout-select').inputValue(), 'run-in');
  const kept = await page.evaluate(() => new Promise(done => { const request = indexedDB.open('manuscript-desk-index', 1); request.onsuccess = () => { const get = request.result.transaction('jobs').objectStore('jobs').get('index'); get.onsuccess = () => done(JSON.stringify(get.result)); }; }));
  for (const secret of ['Title Page', 'an exclamation', 'Ada Placeholder']) assert.equal(kept.includes(secret), false, `${secret} is not kept`);
  await page.getByRole('button', { name: 'Delete saved work now' }).click();
  await until(async () => (await savedKeys(page)).length === 0, 'deleted');
  log('reload keeps the list and the settings, never text from the files; Delete saved work now empties the store');

  // ---- The two boxes, moving between them, and drops that are refused ----
  const fresh = await context.newPage();
  fresh.on('pageerror', error => problems.push(`page error: ${error.message}`));
  fresh.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  await fresh.goto(pageUrl);
  await fresh.locator('#session-status', { hasText: 'Signed in with CUNY' }).waitFor();
  await fresh.getByRole('textbox', { name: 'Names', exact: true }).fill('Mary Shelley\nSimone de Beauvoir\nShelley, Percy Bysshe\nPlato');
  assert.deepEqual(await fresh.locator('#names-preview-list li').allTextContents(), [
    'Mary Shelley →  becomes Shelley, Mary',
    'Simone de Beauvoir →  becomes Beauvoir, Simone de',
    'Shelley, Percy Bysshe →  becomes Shelley, Percy Bysshe (kept as you typed it)',
    'Plato →  becomes Plato (a single name, kept as it is)',
  ]);
  await fresh.getByRole('button', { name: 'Add these names' }).click();
  assert.equal(await fresh.getByRole('textbox', { name: 'Names', exact: true }).inputValue(), '', 'the box empties once its names are in the list');
  assert.equal(await fresh.locator('#names-preview').isHidden(), true);
  await fresh.getByRole('textbox', { name: 'Subjects', exact: true }).fill('artificial intelligence (AI)\nLisbon');
  await fresh.getByRole('button', { name: 'Add these subjects' }).click();
  const freshGroup = group => fresh.locator(`#group-${group} .term-heading`).evaluateAll(inputs => inputs.map(input => input.value));
  assert.deepEqual(await freshGroup('names'), ['Beauvoir, Simone de', 'Plato', 'Shelley, Mary', 'Shelley, Percy Bysshe']);
  assert.deepEqual(await freshGroup('terms'), ['artificial intelligence', 'Lisbon']);
  assert.match(await fresh.locator('.term-row', { has: fresh.locator('input[value="Shelley, Mary"]') }).textContent(), /found in the text as “Mary Shelley”/);
  // The model, or the author, put something in the wrong group: one button moves it.
  await fresh.getByRole('button', { name: 'Move Plato to Subjects' }).click();
  assert.deepEqual(await freshGroup('terms'), ['artificial intelligence', 'Lisbon', 'Plato']);
  await fresh.getByRole('button', { name: 'Move Lisbon to Names' }).focus();
  await fresh.keyboard.press('Enter');
  assert.ok((await freshGroup('names')).includes('Lisbon'), 'the move works from the keyboard');
  // A list without a Names: line is all subjects; the page offers to move what reads like a person.
  await dropFiles(fresh, '#list-drop', [{ name: 'old-list.txt', mimeType: 'text/plain', buffer: Buffer.from('Wollstonecraft, Mary\nharbours\nLong Night, The\n') }]);
  await fresh.locator('#inverted-notice').waitFor();
  assert.match(await fresh.locator('#inverted-notice').textContent(), /^1 subject reads like a person's name written surname first, such as “Wollstonecraft, Mary”\./);
  await fresh.getByRole('button', { name: 'Move it to Names' }).click();
  assert.ok((await freshGroup('names')).includes('Wollstonecraft, Mary'));
  assert.equal(await fresh.locator('#inverted-notice').count(), 0);
  const [freshList] = await Promise.all([fresh.waitForEvent('download'), fresh.getByRole('button', { name: 'Download the term list' }).click()]);
  assert.equal(await readFile(await freshList.path(), 'utf8'), 'Terms:\nPlato\nartificial intelligence (AI)\nharbours\nLong Night, The\nNames:\nShelley, Mary\nBeauvoir, Simone de\nShelley, Percy Bysshe\nLisbon\nWollstonecraft, Mary\n');
  log('Names box: typed as said, shown surname first before adding; Subjects box; one button moves an entry either way; an old list\'s surname-first subjects offered to Names; the download keeps book-index\'s syntax');
  // Drops that are refused say why; a drop outside the boxes is ignored with a hint.
  await dropFiles(fresh, '#pdf-drop', [join(FIXTURES, 'manuscript.docx')]);
  await fresh.locator('#error-banner', { hasText: 'manuscript.docx is not a PDF file (.pdf).' }).waitFor();
  await dropFiles(fresh, '#pdf-drop', [join(FIXTURES, 'index-sample.pdf'), join(FIXTURES, 'index-sample.pdf')]);
  await fresh.locator('#error-banner', { hasText: 'This takes one file at a time, and 2 were given. Drag a PDF file (.pdf) on its own.' }).waitFor();
  await dropFiles(fresh, '#sheet-drop', [{ name: 'notes.docx', mimeType: '', buffer: Buffer.from('x') }]);
  await fresh.locator('#error-banner', { hasText: 'notes.docx is not a rule sheet file (.json).' }).waitFor();
  assert.deepEqual(await dropStray(fresh, '#names-box'), [true, true], 'a file dropped on a text box does not open in place of the page');
  await fresh.locator('#drop-hint', { hasText: 'To add a file, drop it on one of the boxes marked “Drag a file here”.' }).waitFor();
  assert.equal(new URL(fresh.url()).pathname, '/manuscript/index/');
  await fresh.getByLabel('Choose the proofs (PDF)').focus();
  assert.equal(await fresh.evaluate(() => document.activeElement.id), 'pdf-file', 'the file input keeps its label and its place in the tab order');
  log('drops: a wrong type and two files refused with their message; a stray drop ignored with a hint; the input stays labelled and focusable');
  await fresh.close();

  assert.deepEqual(problems, []);
  log('no page errors and no console errors');
  await context.close();
} finally {
  await browser.close();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
