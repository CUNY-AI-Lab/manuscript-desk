import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_TEXT_FILE_BYTES, checkExpected, createCallRules, createRecorder, htmlToText, passes, readCaseFile, rulesPayload, scoreSheet, slotFills } from '../scripts/generality.mjs';
import { createHandler } from '../server/worker.js';
import { ORIGIN, env, signed } from './helpers.mjs';

// Rule sheets and guidelines here are text written for these tests. A sheet rule keeps its
// quotation in source.quote, as mergeExtracted writes it.
const rule = (statement, quote) => ({ id: 'r', category: 'other', slot: null, statement, mode: 'flag', params: {}, source: { kind: 'guidelines', quote, doc: 0 } });
const sheetOf = (...rules) => ({ rules });

test('scoreSheet finds a rule by quote or by statement, ignoring quote style and case', () => {
  const sheet = sheetOf(
    rule('Supply alternative text for every image.', 'Authors must provide “ALT-texts” for all images.'),
    rule('Use Chicago author–date citations.', 'References follow the Chicago style.'),
  );
  const expected = {
    docType: 'monograph',
    rules: [
      { name: 'alt texts for all images', any: ['"alt-texts" for all images'] },
      { name: 'author-date citations', any: ['nothing like this', 'CHICAGO AUTHOR-DATE'] },
    ],
  };
  assert.deepEqual(scoreSheet(sheet, expected), { found: 2, of: 2, missed: [] });
});

test('scoreSheet lists missed rule names', () => {
  const sheet = sheetOf(rule('Use footnotes.', 'Notes should be footnotes rather than endnotes.'));
  const expected = {
    docType: 'article',
    rules: [
      { name: 'footnotes', any: ['footnotes rather than endnotes'] },
      { name: 'abstract length', any: ['250 words'] },
      { name: 'figure credits', any: ['credit line', 'permission to reproduce'] },
      // An empty string must not match every rule.
      { name: 'empty pattern', any: ['', '   '] },
    ],
  };
  assert.deepEqual(scoreSheet(sheet, expected), { found: 1, of: 4, missed: ['abstract length', 'figure credits', 'empty pattern'] });
  assert.deepEqual(scoreSheet(sheetOf(), { docType: 'article', rules: [] }), { found: 0, of: 0, missed: [] });
});

test('passes at 90 percent overall with every document at or above 80', () => {
  assert.equal(passes([{ found: 9, of: 10 }]), true);
  assert.equal(passes([{ found: 10, of: 10 }, { found: 8, of: 10 }]), true);
  // A document with nothing expected is not scored.
  assert.equal(passes([{ found: 9, of: 10 }, { found: 0, of: 0 }]), true);
});

test('fails when one document is below 80 percent even if the total is above 90', () => {
  assert.equal(passes([{ found: 100, of: 100 }, { found: 7, of: 10 }]), false);
});

test('fails at 89 percent overall', () => {
  assert.equal(passes([{ found: 89, of: 100 }]), false);
  assert.equal(passes([{ found: 45, of: 50 }, { found: 44, of: 50 }]), false);
  // No scored document at all is not a pass.
  assert.equal(passes([]), false);
  assert.equal(passes([{ found: 0, of: 0 }]), false);
});

test('htmlToText drops script, style and navigation and keeps paragraph text', () => {
  const html = `<!doctype html><html><head><style>p { color: red; }</style><script>var secret = "menu";</script></head>
<body><header><a href="/">Press home</a></header><nav><ul><li>Books</li><li>Journals</li></ul></nav>
<!-- a comment <p>hidden</p> -->
<main><h1>Preparing your manuscript</h1><p>Use <em>double</em> quotation marks &amp; American spelling.</p>
<p>Notes&nbsp;should be footnotes &#8211; not endnotes&#x2e;</p><script type="module">alert(1)</script></main>
<footer>Copyright notice</footer></body></html>`;
  const text = htmlToText(html);
  for (const kept of ['Preparing your manuscript', 'Use double quotation marks & American spelling.', 'Notes should be footnotes – not endnotes.']) assert.ok(text.includes(kept), kept);
  for (const dropped of ['color: red', 'secret', 'Press home', 'Journals', 'hidden', 'alert', 'Copyright', '<', '>']) assert.ok(!text.includes(dropped), dropped);
  // Paragraphs stay apart.
  assert.match(text, /manuscript\s*\n+\s*Use double/);
});

test('htmlToText is linear on unclosed or stray markup', () => {
  for (const [label, html] of [['<', '<'.repeat(200000)], ['<!--', '<!--'.repeat(50000)], ['<nav>', '<nav>'.repeat(50000)], ['</p', 'a</p'.repeat(50000)]]) {
    const start = performance.now();
    htmlToText(`<p>Kept text before the markup.</p>${html}`);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `${label}: ${elapsed.toFixed(0)} ms`);
  }
});

test('htmlToText drops everything after an unterminated tag, comment or dropped element', () => {
  assert.equal(htmlToText('<p>Use footnotes.</p><script>var a = 1; <p>Not text</p>'), 'Use footnotes.');
  assert.equal(htmlToText('<p>Use footnotes.</p><!-- never closed <p>Not text</p>'), 'Use footnotes.');
  assert.equal(htmlToText('<p>Use footnotes.</p><div class="x'), 'Use footnotes.');
  // Tag names match in any case, and a closed dropped element ends at its closing tag.
  assert.equal(htmlToText('<P>Use footnotes.</P><NAV>Menu</NAV ><p>Cite sources.</p>'), 'Use footnotes.\n\nCite sources.');
});

test('readCaseFile refuses an .html or .txt file over the size cap before reading it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'generality-test-'));
  try {
    const sentence = 'Please use double quotation marks for all quotations. ';
    const big = 'x'.repeat(MAX_TEXT_FILE_BYTES + 1);
    await writeFile(path.join(dir, 'big.txt'), big);
    await writeFile(path.join(dir, 'big.html'), big);
    await writeFile(path.join(dir, 'ok.txt'), sentence.repeat(10));
    assert.deepEqual(await readCaseFile(path.join(dir, 'big.txt')), { ok: false, code: 'too_long' });
    assert.deepEqual(await readCaseFile(path.join(dir, 'big.html')), { ok: false, code: 'too_long' });
    assert.deepEqual(await readCaseFile(path.join(dir, 'ok.txt')), { ok: true, text: sentence.repeat(10).trim() });
    assert.deepEqual(await readCaseFile(path.join(dir, 'gone.txt')), { ok: false, code: 'missing' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkExpected refuses files outside the case folder', () => {
  const expected = files => ({ docType: 'monograph', files, rules: [{ name: 'footnotes', any: ['footnotes'] }] });
  assert.deepEqual(checkExpected(expected(['guide.pdf', 'style/notes.docx', './page.html']), 'press'), []);
  for (const file of ['../x', '/etc/hosts', 'sub/..', 'a/../../x']) {
    assert.deepEqual(checkExpected(expected(['guide.pdf', file]), 'press'), ['files[1] must name a file inside the folder'], file);
  }
});

// A Gateway reply in the OpenAI chat shape.
const chat = (content, { finish = 'stop', usage = { prompt_tokens: 1000, completion_tokens: 200 } } = {}) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: finish }], usage });
const REQUEST = { model: 'glm-5.3', docType: 'monograph', group: 'style', text: 'Please use double quotation marks for all quotations.' };
const KEY = 'test-key-not-a-secret';

test('rulesPayload is the chat payload the /api/rules route sends', async () => {
  // Rows in the full catalog shape, which the Worker's catalog reader requires.
  const row = (id, overrides) => ({ id, object: 'model', recommended: false, tier: 'advanced', order: 10, status: 'active', modality: 'text', provider: 'workers-ai', upstream_model: id, pricing_known: 'catalog', streaming: true, sunset: null, capabilities: ['text-generation'], context_length: 131000, registry_url: null, ...overrides });
  const rows = [row('glm-5.3', { capabilities: ['text-generation', 'reasoning'], context_length: 202752 }), row('plain-model', { context_length: 8192 })];
  for (const model of ['glm-5.3', 'plain-model', 'not-in-catalog']) {
    const sent = [];
    const handle = createHandler({
      gatewayFetch: async (url, init) => {
        if (new URL(url).pathname === '/v1/catalog') return Response.json({ object: 'list', data: rows });
        sent.push(JSON.parse(init.body));
        return Response.json(chat('{"rules":[]}'));
      },
    });
    const request = await signed('/api/rules', { headers: { origin: ORIGIN, 'content-type': 'application/json' } }, { method: 'POST', body: JSON.stringify({ ...REQUEST, model }) });
    assert.equal((await handle(request, env)).status, 200);
    assert.deepEqual(rulesPayload({ ...REQUEST, model, row: rows.find(entry => entry.id === model) }), sent[0], model);
  }
});

test('callRules posts to the Gateway with the key, returns the content and counts tokens', async () => {
  const calls = [];
  const usage = { prompt: 0, completion: 0, calls: 0 };
  const callRules = createCallRules({
    key: KEY,
    rows: new Map(),
    usage,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(chat('{"rules":[]}'));
    },
  });
  assert.deepEqual(await callRules(REQUEST), { content: '{"rules":[]}' });
  await callRules(REQUEST);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://tools.ailab.gc.cuny.edu/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), `Bearer ${KEY}`);
  assert.equal(new Headers(calls[0].init.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), rulesPayload({ ...REQUEST, row: undefined }));
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(usage, { prompt: 2000, completion: 400, calls: 2 });
});

test('callRules rejects with the Gateway code, retrying only when the Gateway says so, and never names the key', async () => {
  const failing = response => createCallRules({ key: KEY, rows: new Map(), usage: { prompt: 0, completion: 0, calls: 0 }, fetchImpl: async () => response() });
  const rejection = async (response, expected) => {
    const error = await failing(response)(REQUEST).then(() => assert.fail('resolved'), error => error);
    assert.ok(error instanceof Error);
    assert.deepEqual({ code: error.code, retry: error.retry }, expected);
    assert.ok(!String(error.message).includes(KEY) && !String(error.stack).includes(KEY));
  };
  await rejection(() => Response.json({ error: { code: 'quota_exceeded', message: 'No budget left.' } }, { status: 429, headers: { 'x-should-retry': 'true' } }), { code: 'quota_exceeded', retry: true });
  await rejection(() => Response.json({ error: { code: 'invalid_model', message: 'Unknown model.' } }, { status: 400, headers: { 'x-should-retry': 'false' } }), { code: 'invalid_model', retry: false });
  await rejection(() => new Response('Bad gateway', { status: 502 }), { code: 'http_502', retry: false });
  await rejection(() => Response.json(chat('{"rules":[', { finish: 'length' })), { code: 'model_output_limit', retry: false });
  await rejection(() => Response.json(chat('  ')), { code: 'invalid_model_response', retry: false });
  await rejection(() => new Response('not json', { status: 200 }), { code: 'invalid_model_response', retry: false });
});

test('callRules counts the tokens of a reply that ran out of room', async () => {
  const usage = { prompt: 0, completion: 0, calls: 0 };
  const callRules = createCallRules({ key: KEY, rows: new Map(), usage, fetchImpl: async () => Response.json(chat('{"rules":[', { finish: 'length', usage: { prompt_tokens: 500, completion_tokens: 6000 } })) });
  await assert.rejects(callRules(REQUEST), { code: 'model_output_limit' });
  assert.deepEqual(usage, { prompt: 500, completion: 6000, calls: 1 });
});

test('slotFills counts the runs that filled each setting, with values, and hides text as labels', () => {
  const rule = (slot, params) => ({ slot, params });
  const sheets = [
    { rules: [rule('notes.restart', { per: 'chapter' }), rule('figures.markers', { example: 'A private example 1.1' }), rule(null, {})] },
    { rules: [rule('notes.restart', { per: 'chapter' }), rule('figures.markers', { example: 'Another private example' }), rule('keywords.count', { min: 6, max: 10 })] },
    { rules: [rule('notes.restart', { per: 'chapter' }), rule('notes.restart', { per: 'none' })] },
    null,
  ];
  const rows = slotFills(sheets);
  assert.deepEqual(rows, [
    { slot: 'notes.restart', filled: 3, runs: 4, values: ['per=chapter x2', 'per=chapter | per=none x1'] },
    { slot: 'figures.markers', filled: 2, runs: 4, values: ['example=text A x1', 'example=text B x1'] },
    { slot: 'keywords.count', filled: 1, runs: 4, values: ['max=10 min=6 x1'] },
  ]);
  assert.ok(!JSON.stringify(rows).includes('private'), 'no text value is shown');
});

test('a recording replays its answers by request; with a new recording too, an unrecorded request is asked and both are kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'recorder-'));
  try {
    const first = path.join(dir, 'first');
    const second = path.join(dir, 'second');
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push(JSON.parse(init.body).messages[1].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"rules":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });
    };
    const ask = async (recorder, texts) => {
      const usage = { prompt: 0, completion: 0, calls: 0, unmetered: 0 };
      const call = createCallRules({ key: 'k', rows: new Map(), usage, fetchImpl, record: recorder });
      await recorder.start('case-run1');
      for (const text of texts) await call({ model: 'm', docType: 'article', group: 'style', text });
      return usage;
    };
    await ask(createRecorder({ record: first }), ['one']);
    assert.deepEqual(sent, ['one']);
    const replayed = await ask(createRecorder({ replay: first }), ['one']);
    assert.deepEqual(sent, ['one'], 'a replay calls nothing');
    assert.equal(replayed.calls, 1);
    await assert.rejects(ask(createRecorder({ replay: first }), ['two']), /not_recorded/);
    const both = await ask(createRecorder({ replay: first, record: second }), ['one', 'two']);
    assert.deepEqual(sent, ['one', 'two'], 'only the request not recorded is asked');
    assert.deepEqual([both.calls, both.replayed, both.prompt], [2, 1, 10]);
    const again = await ask(createRecorder({ replay: second }), ['one', 'two']);
    assert.equal(again.calls, 2, 'the new recording holds both answers');
    assert.deepEqual(sent, ['one', 'two']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
