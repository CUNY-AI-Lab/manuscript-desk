import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { quotaSnapshotBody } from '@cuny-ai-lab/cail-client/testing';
import { NO_KEY_MESSAGE, startDevServer } from '../scripts/dev-server.mjs';
import { builtAssets } from './built-assets.mjs';

// The local test mode of `npm run dev`, with a fake key and an injected upstream: nothing leaves
// the machine.
const KEY = `sk-cail-fake-${randomUUID()}`;
const REPLY = '{"rules":[],"manual":{"named":null}}';
const MODEL = 'glm-5.3';
const catalog = { object: 'list', data: [{ id: MODEL, object: 'model', recommended: false, tier: 'advanced', order: 10, status: 'active', modality: 'text', provider: 'workers-ai', upstream_model: MODEL, pricing_known: 'catalog', streaming: true, sunset: null, capabilities: ['text-generation'], context_length: 131000, registry_url: null }] };

const upstream = [];
async function upstreamFetch(url, init) {
  const { pathname } = new URL(url);
  upstream.push({ url, pathname, headers: new Headers(init.headers), body: init.body });
  if (pathname === '/v1/catalog') return Response.json(catalog);
  if (pathname === '/v1/quota') return Response.json(quotaSnapshotBody());
  if (pathname === '/v1/chat/completions') return Response.json({ choices: [{ message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] });
  return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
}

// Its log lines, anything written to stdout or stderr during the test, and everything it answers.
const logged = [];
const written = [];
const answered = [];
let apiRequests = 0;
let local, restore;
before(async () => {
  const saved = [process.stdout.write, process.stderr.write];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    stream.write = function (chunk, ...rest) { written.push(String(chunk)); return original.call(this, chunk, ...rest); };
  }
  restore = () => { [process.stdout.write, process.stderr.write] = saved; };
  local = await startDevServer({ port: 0, key: KEY, upstreamFetch, log: line => logged.push(line) });
});
after(async () => {
  await local?.close();
  restore?.();
});

// A raw HTTP request (fetch would not let a test set Host), resolving { status, headers, body }.
function send(path, { method = 'GET', headers = {}, body } = {}) {
  if (path.startsWith('/manuscript/api/')) apiRequests += 1;
  return new Promise((done, fail) => {
    const call = httpRequest({ host: '127.0.0.1', port: local.port, path, method, headers: { host: `127.0.0.1:${local.port}`, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const result = { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') };
        answered.push(JSON.stringify(response.rawHeaders) + result.body);
        done(result);
      });
    });
    call.on('error', fail);
    call.end(body);
  });
}
const rules = (headers = {}) => send('/manuscript/api/rules', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ model: MODEL, docType: 'article', group: 'style', text: 'Use double quotation marks for all quotations.' }),
});
const chatCalls = () => upstream.filter(call => call.pathname === '/v1/chat/completions').length;

test('session is signed in without any browser credential', async () => {
  const response = await send('/manuscript/api/session');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { authenticated: true });
});

test('catalog reaches the upstream with the key and without identity headers or browser credentials', async () => {
  const before = upstream.length;
  const response = await send('/manuscript/api/catalog', { headers: { authorization: 'Bearer browser-token', cookie: 'session=browser', 'x-cail-identity-jwt': 'browser-jwt' } });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).data.length, catalog.data.length);
  const calls = upstream.slice(before);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://tools.ailab.gc.cuny.edu/v1/catalog?modality=all');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(calls[0].headers.get('cookie'), null);
  for (const [name] of calls[0].headers) assert.doesNotMatch(name, /^x-cail-(gateway-)?identity/);
});

test('quota reaches the upstream /v1/quota with the key in place of the gateway leg', async () => {
  const before = upstream.length;
  const response = await send('/manuscript/api/quota');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), quotaSnapshotBody());
  const [call] = upstream.slice(before);
  assert.equal(call.pathname, '/v1/quota');
  assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(call.headers.get('x-cail-identity-jwt'), null);
});

test('rules with the local Origin call the upstream chat path once and return the model content', async () => {
  const before = chatCalls();
  const response = await rules({ origin: local.origin });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).content, REPLY);
  assert.equal(chatCalls() - before, 1);
  const chat = upstream.findLast(call => call.pathname === '/v1/chat/completions');
  assert.equal(chat.headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(chat.headers.get('x-cail-identity-jwt'), null);
  assert.equal(JSON.parse(chat.body).model, MODEL);
});

test('a POST without Origin, or from another site, is refused before the upstream', async () => {
  const before = upstream.length;
  for (const headers of [{}, { origin: 'https://evil.example' }, { origin: 'https://tools.ailab.gc.cuny.edu' }]) {
    const response = await rules(headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(JSON.parse(response.body).error.code, 'invalid_origin');
  }
  assert.equal(upstream.length, before);
});

test('a request for another host name is refused with 403', async () => {
  const before = upstream.length;
  for (const path of ['/manuscript/api/catalog', '/manuscript/format/']) {
    const response = await send(path, { headers: { host: 'evil.example' } });
    assert.equal(response.status, 403, path);
  }
  const post = await rules({ host: `evil.example:${local.port}`, origin: `http://evil.example:${local.port}` });
  assert.equal(post.status, 403);
  assert.equal(upstream.length, before);
});

test('a page asked for without its slash redirects to the local origin', async () => {
  const response = await send('/manuscript/format?from=menu');
  assert.equal(response.status, 308);
  assert.equal(response.headers.location, `${local.origin}/manuscript/format/?from=menu`);
  const named = await send('/manuscript/format', { headers: { host: `localhost:${local.port}` } });
  assert.equal(named.headers.location, `http://localhost:${local.port}/manuscript/format/`);
});

test('the built Formatter page is served', async t => {
  try {
    await builtAssets();
  } catch (error) {
    t.skip(`dist/ is missing and could not be built (run npm run vendor, then npm run build): ${error.message.split('\n')[0]}`);
    return;
  }
  const response = await send('/manuscript/format/');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /<title>Formatter \| Manuscript Desk \| CUNY AI Lab<\/title>/);
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
});

test('one log line per API request, and the key never appears in any answer or output', async () => {
  assert.equal(logged.length, apiRequests, logged.join('\n'));
  for (const line of logged) assert.match(line, /^(GET|POST) \/manuscript\/api\/[a-z]+ \d{3} \d+ ms$/);
  for (const text of [...answered, ...written, ...logged]) assert.ok(!text.includes(KEY), 'the key leaked');
});

test('without a key the session works but model calls fail without reaching the upstream', async () => {
  const keyless = await startDevServer({ port: 0, upstreamFetch: () => assert.fail('no upstream without a key'), log: () => {} });
  try {
    const get = path => fetch(`${keyless.origin}${path}`);
    assert.equal((await get('/manuscript/api/session')).status, 200);
    const quota = await get('/manuscript/api/quota');
    assert.equal(quota.status, 503);
    const { error } = await quota.json();
    assert.equal(error.code, 'local_api_key_missing');
    assert.equal(error.message, NO_KEY_MESSAGE);
  } finally { await keyless.close(); }
});
