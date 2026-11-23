// Browser smoke test of the built Formatter page, with the API routes mocked by request
// interception. Not part of `npm test`: it needs a browser and Playwright, which is not a dependency.
//   npm run build
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node tests/browser/formatter-smoke.mjs
// (or with `playwright` resolvable from here). It uses Playwright's Chromium, or else installed Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { DEFAULT_MODEL } from '../../web/shared/models.js';
import { LOADED_NOTICE } from '../../web/format/app.js';
import { readDocx } from '../../lib/docx/read.js';
import { validateDocx } from '../../lib/docx/validate.js';
import { buildOutputs } from '../../web/format/output-state.js';
import { RULES, manuscript, sheetWith } from '../manuscript-fixture.mjs';

const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const { chromium } = playwright.default ?? playwright;

const ROOT = resolve('dist');
const FIXTURES = resolve('tests/fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };
// The Worker's own Content-Security-Policy, so the page is tested under the rules it ships with.
const CSP = /const CONTENT_SECURITY_POLICY = "([^"]+)"/.exec(await readFile('server/worker.js', 'utf8'))[1];
const SENTENCE = 'Use double quotation marks throughout the manuscript.';
const MARKUP = '<img src=x onerror="window.__xss = 1">Use <b>double</b> marks.';

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  let path = join(ROOT, decodeURIComponent(pathname.replace(/^\/manuscript/, '')));
  if (!path.startsWith(ROOT + sep) && path !== ROOT) { response.statusCode = 404; return response.end(); }
  if (pathname.endsWith('/')) path = join(path, 'index.html');
  try {
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-security-policy': CSP });
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${origin}/manuscript/format/`;

const catalog = await readFile(join(FIXTURES, 'catalog-2026-11-09.json'), 'utf8');
const quota = { object: 'quota', unit: 'microdollar', limit: 50000000, estimated_used: 105038, estimated_remaining: 49894962, used_percent: 0, window_seconds: 2592000, window_technique: 'fixed', calculated_at: 1794285677 };
const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'x-should-retry': 'false', ...headers }, body: JSON.stringify(body) });

// Mocks the routes; `rules` answers POST /api/rules from the request body, and POST /api/settings
// (the focused question about settings the reading missed) answers that no setting is stated.
async function mock(context, rules) {
  const calls = [];
  calls.settings = [];
  await context.route('**/manuscript/api/settings', route => {
    calls.settings.push(JSON.parse(route.request().postData()));
    return json(route, { request_id: 'r', content: JSON.stringify({ rules: [] }) });
  });
  await context.route('**/manuscript/api/session', route => json(route, { authenticated: true }));
  await context.route('**/manuscript/api/quota', route => json(route, quota));
  await context.route('**/manuscript/api/catalog', route => route.fulfill({ status: 200, contentType: 'application/json', body: catalog }));
  await context.route('**/manuscript/api/rules', route => {
    const body = JSON.parse(route.request().postData());
    calls.push({ body, headers: route.request().headers() });
    return rules(route, body);
  });
  await context.route('**/launch/manuscript', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Launch</title><p>Launch page</p>' }));
  return calls;
}

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: 'chrome' });
  }
}

const log = (...line) => console.log('ok -', ...line);
const browser = await launch();
console.log(`# browser: ${browser.browserType().name()} ${browser.version()}`);
const scratch = await mkdtemp(join(tmpdir(), 'formatter-smoke-'));
const problems = [];
const dialogs = [];
function watch(page) {
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  page.on('console', message => {
    // The mocked 401, 429 and 502 are reported by the browser as failed resources; nothing else may log an error.
    if (message.type() === 'error' && !/status of (401|429|502)/.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.accept(); });
}

try {
  // ---- The main flow ----
  const context = await browser.newContext({ acceptDownloads: true });
  const calls = await mock(context, (route, body) => json(route, { request_id: 'r', content: JSON.stringify(body.group === 'style' ? { rules: [
    { category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.', quote: SENTENCE, mode: 'fix', params: { style: 'double' } },
    { category: 'other', slot: null, statement: 'Print on blue paper.', quote: 'All copies must be printed on blue paper.', mode: 'flag', params: {} },
  ] } : { rules: [] }) }));
  const page = await context.newPage();
  watch(page);
  const requested = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  await page.goto(pageUrl);
  await page.waitForFunction(model => document.getElementById('model-select').value === model, DEFAULT_MODEL);
  assert.equal(await page.locator('#session-status').textContent(), 'Signed in with CUNY');
  assert.match(await page.locator('.quota-number').textContent(), /\$49\.89 remaining/);
  assert.ok(!requested.some(path => path.endsWith('guidelines-extractors.js')), 'the file readers are not loaded on page open');
  log('page opened: signed in, usage shown, model menu defaults to deepseek-v4.1-flash-1017, file readers not loaded yet');

  await page.getByLabel('Monograph').check();
  await page.setInputFiles('#guideline-files', join(FIXTURES, 'guidelines.docx'));
  await page.locator('#sources li', { hasText: 'guidelines.docx' }).waitFor();
  assert.equal(requested.filter(path => path.endsWith('/shared/guidelines-extractors.js')).length, 1, 'the file readers load once, when the first file is added');
  log('Monograph chosen; guidelines.docx added to the list; file readers loaded on demand');

  await page.getByRole('button', { name: 'Read the guidelines' }).click();
  const rule = page.locator('.rule', { hasText: 'Use double quotation marks.' });
  await rule.waitFor();
  assert.equal(await rule.locator('.rule-source').textContent(), `“${SENTENCE}”`);
  assert.equal(await page.locator('.rule').count(), 1, 'the invented rule is not shown');
  assert.equal(await page.locator('#sheet-notices').textContent(), '1 rule was left out because the tool could not confirm it against the guidelines.');
  assert.deepEqual(await rule.locator('.rule-settings li').allTextContents(), ['Quotation marks: Double (“ ”)']);
  assert.equal(await page.locator('#category-quotations').textContent(), 'Quotations');
  assert.equal(await rule.getByLabel('What to do').inputValue(), 'fix');
  assert.equal(calls.length, 3, 'one reading per group of a monograph');
  // The settings question; any other call to /api/settings is the question about left-out sentences (no slots).
  const settingsQuestions = calls.settings.filter(body => body.slots.length > 0);
  assert.equal(settingsQuestions.length, 1, 'then one question about the settings no reading filled');
  assert.ok(calls.settings.every(body => body.slots.length > 0 || Array.isArray(body.unreported)));
  assert.ok(!settingsQuestions[0].slots.includes('quotes.primary') && settingsQuestions[0].slots.includes('notes.kind'));
  for (const { body, headers } of calls) {
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(body.docType, 'monograph');
    assert.ok(body.text.includes(SENTENCE) && !body.text.includes('\r'));
    assert.equal(headers['content-type'], 'application/json');
  }
  log('read: 3 reading calls (style, references, structure) and 1 settings question; the traced rule shows once with its quotation and its setting in words; notice counts the left-out one');

  const toggle = rule.getByRole('switch', { name: 'Use this rule' });
  await toggle.uncheck();
  assert.equal(await rule.getAttribute('class'), 'rule off');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download rule sheet' }).click()]);
  assert.equal(download.suggestedFilename(), 'rule-sheet.json');
  const saved = join(scratch, 'rule-sheet.json');
  await download.saveAs(saved);
  const file = JSON.parse(await readFile(saved, 'utf8'));
  assert.equal(file.rules.length, 1);
  assert.equal(file.rules[0].enabled, false);
  assert.equal(file.docType, 'monograph');
  log('rule switched off; downloaded rule-sheet.json holds it with enabled false');

  await page.reload();
  await page.locator('.rule', { hasText: 'Use double quotation marks.' }).waitFor();
  assert.equal(await page.getByRole('switch', { name: 'Use this rule' }).isChecked(), false);
  assert.equal(await page.locator('#sources li').count(), 1);
  log('after a reload the saved work is restored from this browser, rule still off');

  await page.getByRole('button', { name: 'Start over' }).click();
  assert.equal(await page.locator('.rule').count(), 0);
  assert.equal(await page.locator('#sources li').count(), 0);
  assert.equal(await page.getByLabel('Monograph').isChecked(), false);
  await page.reload();
  await page.waitForFunction(model => document.getElementById('model-select').value === model, DEFAULT_MODEL);
  assert.equal(await page.locator('.rule').count(), 0, 'nothing comes back after Start over');
  log('Start over cleared the page and the saved copy (nothing restored after a reload)');

  const PASTED = `${SENTENCE} ${'Authors should read these instructions in full before they submit. '.repeat(4)}`;
  await page.getByLabel('Monograph').check();
  await page.locator('#paste-box').fill(PASTED);
  await page.getByRole('button', { name: 'Add pasted text' }).click();
  await page.locator('#sources li', { hasText: 'Pasted text 1' }).waitFor();
  await page.setInputFiles('#sheet-file', saved);
  const loaded = page.locator('.rule', { hasText: 'Use double quotation marks.' });
  await loaded.waitFor();
  assert.equal(dialogs.at(-1), 'Loading a rule sheet clears the guidelines you added, because its rules were not read from them. Continue?');
  assert.equal(await loaded.getByRole('switch', { name: 'Use this rule' }).isChecked(), false);
  assert.equal(await page.getByLabel('Monograph').isChecked(), true);
  assert.equal(await page.locator('#sources li').count(), 0, 'the guidelines list is empty after a load');
  assert.equal(await page.locator('#no-sources').isVisible(), true);
  assert.equal(await page.locator('#loaded-notice').textContent(), LOADED_NOTICE);
  assert.equal(await page.locator('#sheet-notices > *').first().getAttribute('id'), 'loaded-notice', 'the notice stands above the rules, first');
  assert.ok((await page.locator('#announcer').textContent()).endsWith(LOADED_NOTICE), 'the notice is announced');
  log('the downloaded sheet loads back (rule still off, Monograph chosen); the guidelines were cleared, after a question saying so; the not-checked notice is shown and announced');

  await page.reload();
  await loaded.waitFor();
  assert.equal(await page.locator('#loaded-notice').textContent(), LOADED_NOTICE);
  await page.locator('#paste-box').fill(PASTED);
  await page.getByRole('button', { name: 'Add pasted text' }).click();
  await page.locator('#sources li', { hasText: 'Pasted text 1' }).waitFor();
  const asked = dialogs.length;
  await page.getByRole('button', { name: 'Remove Pasted text 1' }).click();
  await page.locator('#no-sources').waitFor();
  assert.equal(dialogs.length, asked, 'no question claims rules were read from the new guidelines');
  assert.equal(await page.locator('.rule').count(), 1, 'removing the new guidelines leaves the loaded rules');
  assert.equal(await page.locator('#loaded-notice').textContent(), LOADED_NOTICE);
  log('after a reload the notice is still there; adding and removing new guidelines leaves the loaded rules alone');

  // A rule filed under a category a monograph does not have is shown under "Other requirements".
  const stray = { ...file, rules: [...file.rules, { id: 'anonymization-1', category: 'anonymization', slot: 'anonymize', statement: 'Remove your name from the manuscript.', mode: 'fix', source: { kind: 'author' }, params: { required: true }, enabled: true }] };
  await page.setInputFiles('#sheet-file', { name: 'stray.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(stray)) });
  const strayRow = page.locator('.category', { has: page.locator('#category-other', { hasText: 'Other requirements' }) }).locator('.rule', { hasText: 'Remove your name from the manuscript.' });
  await strayRow.waitFor();
  assert.equal(await page.locator('.rule').count(), stray.rules.length, 'every rule in the loaded sheet is visible');
  await strayRow.getByRole('switch', { name: 'Use this rule' }).uncheck();
  assert.equal(await strayRow.getAttribute('class'), 'rule off');
  log('a loaded rule in a category a monograph does not have shows under "Other requirements" and can be switched off');

  // A conflict mark on a rule with no setting is refused as damaged, and the page keeps working.
  const unsettled = { ...file, rules: [{ ...file.rules[0], slot: null, params: {}, mode: 'flag', conflict: true }] };
  await page.setInputFiles('#sheet-file', { name: 'unsettled.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsettled)) });
  await page.locator('#error-banner', { hasText: 'This rule sheet file is damaged and cannot be used.' }).waitFor();
  assert.equal(await page.locator('.rule').count(), stray.rules.length, 'the sheet on the page is unchanged');
  log('a sheet with a disagreement mark on a rule with no setting is refused as damaged; the page is unchanged');

  // Markup in a loaded sheet is shown as text.
  const hostile = { ...file, rules: [{ ...file.rules[0], statement: MARKUP }] };
  await page.setInputFiles('#sheet-file', { name: 'hostile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostile)) });
  await page.locator('.rule-statement', { hasText: 'onerror' }).waitFor();
  assert.equal(await page.locator('.rule-statement').first().textContent(), MARKUP);
  assert.equal(await page.locator('#rules img, #rules b').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  log('a loaded statement with <img onerror> renders as literal text; no element created, no script ran');

  // Editing a rule with settings: a bad value is refused in plain words.
  await page.getByRole('button', { name: 'Edit' }).first().click();
  assert.equal(await page.getByLabel('Quotation marks').inputValue(), 'double');
  await page.getByLabel('Rule', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  assert.equal(await page.locator('.rule-edit .field-error').textContent(), 'Write the rule in 1 to 500 characters.');
  await page.getByLabel('Rule', { exact: true }).fill('Use single quotation marks.');
  await page.getByLabel('Quotation marks').selectOption('single');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.rule-statement', { hasText: 'Use single quotation marks.' }).waitFor();
  log('Edit offers a menu for the setting; an empty rule is refused with a plain reason; a valid edit is saved');

  // Adding a rule of one's own.
  await page.getByRole('button', { name: 'Add a rule' }).click();
  await page.getByLabel('Kind of rule').selectOption('other');
  await page.locator('#add-rule-statement').fill('Send the manuscript as one file.');
  assert.equal(await page.locator('#add-rule-mode option[value="fix"]').isDisabled(), true);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#category-other', { hasText: 'Other requirements' }).waitFor();
  assert.equal(await page.locator('.rule', { hasText: 'Send the manuscript as one file.' }).locator('.rule-source').textContent(), 'Added by you');
  assert.equal(await page.locator('.rule', { hasText: 'Send the manuscript as one file.' }).locator('.rule-settings').count(), 0, 'a rule with no settings lists none');
  assert.equal(await page.locator('#loaded-notice').textContent(), LOADED_NOTICE, 'adding a rule by hand leaves the notice');
  log('Add a rule: shown under "Other requirements" as "Added by you"; "Fix automatically" not offered');

  // Reading guidelines again replaces the loaded sheet, and the notice goes.
  await page.locator('#paste-box').fill(PASTED);
  await page.getByRole('button', { name: 'Add pasted text' }).click();
  await page.getByRole('button', { name: 'Read the guidelines' }).click();
  await page.locator('#announcer', { hasText: 'Finished reading the guidelines.' }).waitFor();
  assert.equal(await page.locator('#loaded-notice').count(), 0);
  log('reading the guidelines again replaced the loaded sheet and the not-checked notice went away');
  await context.close();

  // ---- Markup in a model's reply is shown as text too ----
  const context2 = await browser.newContext();
  await mock(context2, (route, body) => json(route, { request_id: 'r', content: JSON.stringify({ rules: body.group === 'style'
    ? [{ category: 'quotations', slot: 'quotes.primary', statement: MARKUP, quote: SENTENCE, mode: 'fix', params: { style: 'double' } }] : [] }) }));
  const page2 = await context2.newPage();
  watch(page2);
  await page2.goto(pageUrl);
  await page2.waitForFunction(model => document.getElementById('model-select').value === model, DEFAULT_MODEL);
  await page2.getByLabel('Article').check();
  await page2.locator('#paste-box').fill(`Manuscript preparation\r\n${SENTENCE}\r\n${'Authors should read these instructions in full before they submit. '.repeat(4)}`);
  await page2.getByRole('button', { name: 'Add pasted text' }).click();
  await page2.getByRole('button', { name: 'Read the guidelines' }).click();
  await page2.locator('.rule-statement', { hasText: 'onerror' }).waitFor();
  assert.equal(await page2.locator('.rule-statement').textContent(), MARKUP);
  assert.equal(await page2.locator('#rules img').count(), 0);
  assert.equal(await page2.evaluate(() => window.__xss), undefined);
  log('a statement with <img onerror> from the (mocked) model renders as literal text');
  await context2.close();

  // ---- A lost session: the work is saved, then the page goes to the launch path ----
  const context3 = await browser.newContext();
  let lost = true;
  await mock(context3, (route, body) => (lost
    ? json(route, { error: { code: 'authentication_required', message: 'Sign in with CUNY to continue.', request_id: 'r', launch: '/launch/manuscript' } }, 401)
    : json(route, { request_id: 'r', content: '{"rules":[]}' })));
  // The session check answers as signed in until the page has been sent to sign-in once.
  let sessionLost = false;
  await context3.route('**/manuscript/api/session', route => (sessionLost
    ? json(route, { error: { code: 'session_invalid', message: 'Sign in with CUNY to continue.', request_id: 'r', launch: '/launch/manuscript' } }, 401)
    : json(route, { authenticated: true })));
  const page3 = await context3.newPage();
  watch(page3);
  await page3.goto(pageUrl);
  await page3.waitForFunction(model => document.getElementById('model-select').value === model, DEFAULT_MODEL);
  await page3.getByLabel('Edited collection').check();
  await page3.locator('#paste-box').fill(`${SENTENCE} ${'Contributors follow the same rules as the volume editors. '.repeat(4)}`);
  await page3.getByRole('button', { name: 'Add pasted text' }).click();
  await Promise.all([page3.waitForURL(`${origin}/launch/manuscript`), page3.getByRole('button', { name: 'Read the guidelines' }).click()]);
  log('a mocked 401 navigated the page to /launch/manuscript');
  // Sign-in did not cure the session: the page's own session check is refused too. Within a minute
  // the page does not go to sign-in again, on opening or on a call; it offers the link instead.
  sessionLost = true;
  await page3.goto(pageUrl);
  await page3.locator('#sources li', { hasText: 'Pasted text 1' }).waitFor();
  assert.equal(await page3.getByLabel('Edited collection').isChecked(), true);
  log('back on the page after the 401, the pasted guidelines and the choice were restored');
  const signIn = page3.locator('#signin-notice a', { hasText: 'Sign in with CUNY' });
  await signIn.waitFor();
  assert.equal(page3.url(), pageUrl, 'opening the page with the session still lost does not navigate');
  await page3.getByRole('button', { name: 'Read the guidelines' }).click();
  await page3.locator('#failure-notice').waitFor();
  assert.equal(page3.url(), pageUrl, 'a second lost session within a minute does not navigate');
  assert.equal(await signIn.isVisible(), true);
  assert.equal(await signIn.getAttribute('href'), `${origin}/launch/manuscript`);
  assert.equal(await page3.locator('#session-status a').getAttribute('href'), `${origin}/launch/manuscript`);
  log('with the session still lost, opening the page and reading again left it where it was and offered "Sign in with CUNY" instead');
  lost = false;
  await Promise.all([page3.waitForURL(`${origin}/launch/manuscript`), signIn.click()]);
  log('the offered link goes to /launch/manuscript');
  await context3.close();

  // ---- A failed group, "Try again", and two rules that disagree ----
  const SINGLE = 'Single quotation marks are kept for quotations within quotations.';
  const context4 = await browser.newContext();
  // The references group fails on the first reading of the guidelines.
  let referencesFail = 1;
  const calls4 = await mock(context4, (route, body) => {
    if (body.group === 'references' && referencesFail > 0) {
      referencesFail -= 1;
      return json(route, { error: { code: 'invalid_model_response', message: 'The model returned an empty answer.', request_id: 'r' } }, 502);
    }
    return json(route, { request_id: 'r', content: JSON.stringify({ rules: body.group === 'style' ? [
      { category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.', quote: SENTENCE, mode: 'fix', params: { style: 'double' } },
      { category: 'quotations', slot: 'quotes.primary', statement: 'Use single quotation marks.', quote: SINGLE, mode: 'fix', params: { style: 'single' } },
    ] : body.group === 'references' ? [
      { category: 'notes', slot: 'notes.kind', statement: 'Use endnotes.', quote: 'place them as endnotes', mode: 'fix', params: { kind: 'endnotes' } },
    ] : [] }) });
  });
  const page4 = await context4.newPage();
  watch(page4);
  await page4.goto(pageUrl);
  await page4.waitForFunction(model => document.getElementById('model-select').value === model, DEFAULT_MODEL);
  await page4.getByLabel('Article').check();
  await page4.locator('#paste-box').fill(`${SENTENCE} ${SINGLE} Number the notes from 1 in each chapter and place them as endnotes. ${'Read all of this before you submit. '.repeat(3)}`);
  await page4.getByRole('button', { name: 'Add pasted text' }).click();
  await page4.getByRole('button', { name: 'Read the guidelines' }).click();
  await page4.getByRole('button', { name: 'Try again' }).waitFor();
  assert.match(await page4.locator('#sheet-notices').textContent(), /could not be read, so rules may be missing about citations, references and notes\./);
  const failureLine = 'Citations, references and notes in Pasted text 1: The model\'s answer could not be used. Try again, or choose another model.';
  assert.deepEqual(await page4.locator('#failure-notice li').allTextContents(), [failureLine]);
  assert.equal(await page4.locator('.conflicts h3').textContent(), 'The guidelines say two different things');
  assert.equal(await page4.locator('.conflicts .rule').count(), 2);
  assert.deepEqual(await page4.locator('.conflicts .rule-settings').allTextContents(), ['Quotation marks: Double (“ ”)', 'Quotation marks: Single (‘ ’)'], 'each side shows its own setting');
  log('a failed group is named, with what happened, and a "Try again" button; two disagreeing rules are shown together, each with its setting');
  await page4.reload();
  await page4.getByRole('button', { name: 'Try again' }).waitFor();
  assert.deepEqual(await page4.locator('#failure-notice li').allTextContents(), [failureLine]);
  log('after a reload the failed part is still named and "Try again" is still offered');
  const before = calls4.length;
  await page4.getByRole('button', { name: 'Try again' }).click();
  await page4.locator('.rule', { hasText: 'Use endnotes.' }).waitFor();
  assert.equal(calls4.length - before, 1, 'only the failed part is read again');
  assert.equal(await page4.getByRole('button', { name: 'Try again' }).count(), 0);
  await page4.locator('.conflicts .rule', { hasText: 'Use single quotation marks.' }).getByRole('button', { name: 'Keep this rule' }).click();
  assert.equal(await page4.locator('.conflicts').count(), 0);
  assert.equal(await page4.locator('.category .rule-statement').allTextContents().then(texts => texts.join(' | ')), 'Use single quotation marks. | Use endnotes.');
  log('"Try again" read only the failed part and added its rule; "Keep this rule" resolved the disagreement');
  await context4.close();

  // ---- A reading that fails everywhere keeps the edited sheet ----
  const context6 = await browser.newContext();
  let quotaGone = false;
  const calls6 = await mock(context6, (route, body) => (quotaGone
    ? json(route, { error: { code: 'quota_exceeded', message: 'You have used your allowance.', request_id: 'r' } }, 429)
    : json(route, { request_id: 'r', content: JSON.stringify({ rules: body.group === 'style' ? [
      { category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.', quote: SENTENCE, mode: 'fix', params: { style: 'double' } },
    ] : [] }) })));
  const page6 = await context6.newPage();
  watch(page6);
  await page6.goto(pageUrl);
  await page6.waitForFunction(model => document.getElementById('model-select').value === model, DEFAULT_MODEL);
  await page6.getByLabel('Article').check();
  await page6.locator('#paste-box').fill(`${SENTENCE} ${'Read all of this before you submit. '.repeat(6)}`);
  await page6.getByRole('button', { name: 'Add pasted text' }).click();
  await page6.getByRole('button', { name: 'Read the guidelines' }).click();
  await page6.getByRole('button', { name: 'Edit' }).waitFor();
  await page6.getByRole('button', { name: 'Edit' }).click();
  await page6.getByLabel('Rule', { exact: true }).fill('My own wording for quotation marks.');
  await page6.getByRole('button', { name: 'Save' }).click();
  await page6.locator('.rule-statement', { hasText: 'My own wording for quotation marks.' }).waitFor();
  await page6.getByRole('switch', { name: 'Use this rule' }).uncheck();
  quotaGone = true;
  const before6 = calls6.length;
  await page6.getByRole('button', { name: 'Read the guidelines' }).click();
  await page6.locator('#error-banner', { hasText: 'The guidelines could not be read, so the rule sheet below was not changed.' }).waitFor();
  assert.equal(calls6.length - before6, 3, 'every reading failed');
  assert.deepEqual(await page6.locator('#error-banner p').allTextContents(), [
    'The guidelines could not be read, so the rule sheet below was not changed.',
    'Your model allowance is used up, so this part was not read.',
  ]);
  const edited = async () => {
    assert.deepEqual(await page6.locator('.rule-statement').allTextContents(), ['My own wording for quotation marks.']);
    assert.equal(await page6.getByRole('switch', { name: 'Use this rule' }).isChecked(), false);
  };
  await edited();
  await page6.reload();
  await page6.locator('.rule-statement', { hasText: 'My own wording for quotation marks.' }).waitFor();
  await edited();
  log('with every call failing, the edited sheet stays on the page and in this browser, and the reason is given');
  await context6.close();

  // ---- Stop ----
  const context5 = await browser.newContext();
  await mock(context5, async route => { await new Promise(done => setTimeout(done, 3000)); return json(route, { request_id: 'r', content: '{"rules":[]}' }).catch(() => {}); });
  const page5 = await context5.newPage();
  watch(page5);
  await page5.goto(pageUrl);
  await page5.waitForFunction(model => document.getElementById('model-select').value === model, DEFAULT_MODEL);
  await page5.getByLabel('Article').check();
  await page5.locator('#paste-box').fill(`${SENTENCE} ${'Read all of this before you submit. '.repeat(6)}`);
  await page5.getByRole('button', { name: 'Add pasted text' }).click();
  await page5.getByRole('button', { name: 'Read the guidelines' }).click();
  assert.equal(await page5.locator('#progress-text').textContent(), 'Reading the guidelines…');
  await page5.getByRole('button', { name: 'Stop' }).click();
  await page5.getByRole('button', { name: 'Read the guidelines' }).waitFor();
  assert.equal(await page5.locator('#announcer').textContent(), 'Stopped. The rule sheet was not changed.');
  log('"Stop" ended a running read and said so');
  await context5.close();


  // ---- Steps 4 to 6: the manuscript, its labels, formatting and the downloads ----
  // tests/fixtures/manuscript.docx and manuscript-other.docx are written by tests/fixtures/make-manuscripts.mjs.
  const { roles: GOLD } = manuscript();
  const MANUSCRIPT = join(FIXTURES, 'manuscript.docx');
  const OTHER = join(FIXTURES, 'manuscript-other.docx');
  const source = new Uint8Array(await readFile(MANUSCRIPT));
  const { paragraphs } = readDocx(source);
  // The mocked model labels every paragraph as the fixture says (body where it says nothing), except
  // that it calls the first block quotation verse: the one label the scholar corrects.
  const wrong = Number(Object.keys(GOLD).find(index => GOLD[index] === 'block-quotation'));
  const labelLines = passage => [...passage.split('Label these:')[1].split('\n\n')[0].matchAll(/^\[(\d+)\]/gm)].map(match => Number(match[1]));
  const sheet7 = sheetWith([RULES.restart, RULES.numbered, RULES.split, RULES.markers, ['running-title.length', 'length', { max: 30 }]]);
  const TITLES = JSON.stringify({ titles: { 1: 'Paper Lanterns', 2: 'Glass Bells' } });
  const context7 = await browser.newContext({ acceptDownloads: true });
  await mock(context7, route => json(route, { request_id: 'r', content: '{"rules":[]}' }));
  const roleCalls = [];
  const titleCalls = [];
  await context7.route('**/manuscript/api/roles', route => {
    const body = JSON.parse(route.request().postData());
    roleCalls.push(body);
    return json(route, { request_id: 'r', content: JSON.stringify({ roles: Object.fromEntries(labelLines(body.passage).map(index => [index, index === wrong ? 'verse' : GOLD[index] ?? 'body'])) }) });
  });
  await context7.route('**/manuscript/api/running-titles', route => { titleCalls.push(JSON.parse(route.request().postData())); return json(route, { request_id: 'r', content: TITLES }); });
  // The mocked reading check queries the first words of the first text line of each chapter it is
  // sent, and invents one quotation, which the page must drop.
  const readingCalls = [];
  await context7.route('**/manuscript/api/reading', route => {
    const body = JSON.parse(route.request().postData());
    readingCalls.push(body);
    const [, index, text] = /^\[(\d+)\] \([^)]*\) (.{12,})$/mu.exec(body.unit);
    return json(route, { request_id: 'r', content: JSON.stringify({ findings: [
      { kind: 'typo', paragraph: Number(index), quote: text.split(' ').slice(0, 4).join(' '), note: 'Check this <b>word</b>.' },
      { kind: 'typo', paragraph: Number(index), quote: 'words the chapter does not have', note: 'Invented.' },
    ] }) });
  });
  const page7 = await context7.newPage();
  watch(page7);
  await page7.goto(pageUrl);
  await page7.waitForFunction(model => document.getElementById('roles-model-select').value === model, DEFAULT_MODEL);
  assert.match(await page7.locator('#privacy').textContent(), /passages of their text are sent .* not the manuscript or its text/);
  assert.equal(await page7.locator('#format-button').isDisabled(), true, 'nothing to format yet');
  await page7.setInputFiles('#sheet-file', { name: 'sheet.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sheet7)) });
  await page7.locator('.rule').first().waitFor();
  await page7.setInputFiles('#manuscript-file', MANUSCRIPT);
  await page7.locator('#manuscript-status', { hasText: '33 paragraphs' }).waitFor();
  assert.match(await page7.locator('#manuscript-status').textContent(), /manuscript\.docx\d[\d,]* words in 33 paragraphs/);
  assert.match(await page7.locator('#roles-plan').textContent(), /^Labelling sends 33 paragraphs to the model in 1 passage, one model call each/);
  log('step 4: the manuscript is read in the page, with its size; step 5 states the model calls before any is made');

  await page7.getByRole('button', { name: 'Read the manuscript' }).click();
  await page7.locator('#review .review-item').first().waitFor();
  assert.equal(roleCalls.length, 1);
  assert.equal(roleCalls[0].model, DEFAULT_MODEL);
  assert.match(await page7.locator('#damaging-notice').textContent(), /most damaging mistake/);
  const selects = page7.locator('#review .review-item select');
  const shownRoles = await selects.evaluateAll(list => list.map(select => select.value));
  assert.ok(shownRoles.length > 10 && !shownRoles.includes('body') && !shownRoles.includes('bibliography-entry'), 'by default only paragraphs that are not body text or bibliography entries');
  assert.equal(await page7.locator('#review details.review-chapter').count(), 2, 'two chapters (the front matter is all body text here, so it has nothing to check)');
  assert.match(await page7.locator('#role-counts').textContent(), /Verse: 4/);
  const row = page7.locator(`#para-${wrong}`);
  assert.equal(await row.locator('select').inputValue(), 'verse');
  await row.getByRole('button', { name: 'Show neighbours' }).click();
  assert.equal(await page7.locator(`#para-${wrong}-near li`).count(), 4);
  await row.getByLabel('What it is').selectOption('block-quotation');
  assert.match(await row.locator('.review-note').textContent(), /^Changed by you\. The model said: Verse\.$/);
  assert.match(await page7.locator('#role-counts').textContent(), /Verse: 3/);
  await page7.getByLabel('Show').selectOption('all');
  assert.equal(await page7.locator('#review .review-item').count(), 33, 'the filter shows every paragraph');
  await page7.getByLabel('Show').selectOption('check');
  log('step 5: one call labelled the paragraphs; the review shows what is not body text by chapter, with the warning, counts, neighbours and an "everything" filter; one label corrected');

  await page7.getByRole('button', { name: 'Format the manuscript' }).click();
  await page7.locator('#output .downloads button').first().waitFor();
  assert.equal(titleCalls.length, 1, 'running titles asked once, because a rule asks for them');
  const corrected = { ...Object.fromEntries(Object.keys(GOLD).concat(paragraphs.filter(entry => entry.text.trim()).map(entry => String(entry.index))).map(index => [index, GOLD[index] ?? 'body'])) };
  const expected = await buildOutputs({ bytes: source, paragraphs, roles: corrected, sheet: sheet7, name: 'manuscript.docx', proposeTitles: async () => TITLES });
  assert.equal(expected.ok, true);
  const buttons = page7.locator('#output .downloads button');
  assert.deepEqual(await buttons.allTextContents(), expected.files.map(file => `Download ${file.name}`));
  for (let at = 0; at < expected.files.length; at += 1) {
    const [file] = await Promise.all([page7.waitForEvent('download'), buttons.nth(at).click()]);
    assert.equal(file.suggestedFilename(), expected.files[at].name);
    const path = join(scratch, file.suggestedFilename());
    await file.saveAs(path);
    const got = new Uint8Array(await readFile(path));
    const validity = validateDocx(got);
    assert.equal(validity.ok, true, `${file.suggestedFilename()} passes the structural validator`);
    if (expected.files[at].id === 'manuscript') {
      assert.equal(validity.counts.comments, validateDocx(expected.files[at].bytes).counts.comments);
      assert.ok(validity.counts.comments > 1 && validity.counts.revisions > 0);
    }
  }
  assert.match(await page7.locator('#output-status').textContent(), /^Formatted\. \d+ comments in the file/);
  assert.ok((await page7.locator('#summary-changed + ul li').count()) > 3);
  log(`step 6: formatted in the page; ${expected.files.length} downloads (${expected.files.map(file => file.id).join(', ')}), each a valid Word file; the manuscript has the expected ${validateDocx(expected.files[0].bytes).counts.comments} comments`);

  assert.equal(readingCalls.length, 0, 'the reading check is not run unless chosen');
  assert.match(await page7.locator('#reading-plan').textContent(), /^Optional, 2 model calls, one per chapter/);
  const itemsBefore = Number(/(\d+) items? on the To-dos list/.exec(await page7.locator('#output-status').textContent())[1]);
  await page7.getByLabel('Also read the opening of each chapter, and the front matter, for queries an editor would make').check();
  await page7.locator('#output-stale').waitFor();
  await page7.getByRole('button', { name: 'Format the manuscript' }).click();
  await page7.locator('#summary-flagged + ul li', { hasText: 'The reading check read the opening of 2 chapters and proposed 2 queries' }).waitFor();
  assert.equal(readingCalls.length, 2);
  assert.equal(readingCalls[0].model, DEFAULT_MODEL);
  const itemsAfter = Number(/(\d+) items? on the To-dos list/.exec(await page7.locator('#output-status').textContent())[1]);
  assert.equal(itemsAfter, itemsBefore + 2, 'the two verified queries are To-dos; the invented one is dropped');
  log('step 6: the reading check states its 2 calls, runs only when ticked, and adds only the queries whose quotation is in the text');

  await page7.reload();
  await page7.locator('#file-notice', { hasText: 'Labels for manuscript.docx are kept in this browser' }).waitFor();
  await page7.setInputFiles('#manuscript-file', MANUSCRIPT);
  await page7.locator('#file-notice', { hasText: 'This is the file labelled before' }).waitFor();
  await page7.locator(`#para-${wrong}`).waitFor();
  assert.equal(await page7.locator(`#para-${wrong} select`).inputValue(), 'block-quotation', 'the correction came back');
  assert.equal(roleCalls.length, 1, 'labelling is not repeated after a reload');
  assert.equal(await page7.locator('#format-button').isDisabled(), false);
  log('after a reload the same file is chosen again: its labels and the correction come back, and no labelling call is made');

  await page7.setInputFiles('#manuscript-file', OTHER);
  await page7.locator('#file-notice', { hasText: 'The labels kept in this browser are for another file' }).waitFor();
  assert.equal(await page7.locator('#review .review-item').count(), 0, 'no labels are shown for another file');
  assert.equal(await page7.locator('#format-button').isDisabled(), true);
  const asked7 = dialogs.length;
  await page7.getByRole('button', { name: 'Read the manuscript' }).click();
  await page7.locator('#review .review-item').first().waitFor();
  assert.equal(dialogs.length, asked7 + 1, 'a question before replacing the saved labels');
  assert.equal(roleCalls.length, 2, 'another file is labelled from the start');
  log('a different file is said to be another file and is labelled from the start, after a question');
  await context7.close();

  // ---- A manuscript that cannot be read gets the reader's message ----
  const context8 = await browser.newContext();
  await mock(context8, route => json(route, { request_id: 'r', content: '{"rules":[]}' }));
  const page8 = await context8.newPage();
  watch(page8);
  await page8.goto(pageUrl);
  await page8.setInputFiles('#manuscript-file', { name: 'notes.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('plain text, not a Word file') });
  await page8.locator('#error-banner', { hasText: 'notes.docx: This is not a Word (.docx) file.' }).waitFor();
  log('a file that is not a Word file gets the reader\'s plain message');
  await context8.close();

  assert.deepEqual(problems, [], 'no page errors or console errors');
  log('no page errors and no console errors');
} finally {
  await browser.close();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
