import test from 'node:test';
import assert from 'node:assert/strict';
import { cailErrorEnvelope, cailErrorResponse } from '@cuny-ai-lab/cail-client/testing';
import { createHandler } from '../server/worker.js';
import { rulesPrompt } from '../server/prompts.js';
import { ORIGIN, env, at, signed, noGateway, failure } from './helpers.mjs';

const GUIDELINES = 'Contributors must use double quotation marks for all quotations.';
const ok = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const REPLY = '{"rules":[],"manual":{"named":null}}';
const catalogRow = (id, overrides = {}) => ({ id, object: 'model', recommended: false, tier: 'advanced', order: 10, status: 'active', modality: 'text', provider: 'workers-ai', upstream_model: id, pricing_known: 'catalog', streaming: true, sunset: null, capabilities: ['text-generation'], context_length: 131000, registry_url: null, ...overrides });

// A Gateway that serves `rows` as the catalog and answers chat with `reply` (a body or a function
// returning a Response), recording each chat call's headers and parsed payload in `sent`.
function gateway({ rows = [], reply = ok(REPLY), sent = [] } = {}) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/catalog') return Response.json({ object: 'list', data: rows });
    assert.equal(path, '/v1/chat/completions');
    sent.push({ headers: new Headers(init.headers), payload: JSON.parse(init.body) });
    return typeof reply === 'function' ? reply() : Response.json(reply);
  };
}
const rulesRequest = async (body, headers = {}) => signed('/api/rules', { headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers } }, { method: 'POST', body: JSON.stringify(body) });
const body = (overrides = {}) => ({ model: 'glm-5.3', docType: 'article', group: 'style', text: GUIDELINES, ...overrides });

// The controls a model call carried: everything but the fixed fields of the payload.
async function controlsFor(row, model = row?.id ?? 'not-in-catalog') {
  const sent = [];
  const handle = createHandler({ gatewayFetch: gateway({ rows: row ? [row] : [], sent }) });
  assert.equal((await handle(await rulesRequest(body({ model })), env)).status, 200);
  const { model: _, temperature, response_format, messages, ...controls } = sent[0].payload;
  return controls;
}

test('sends system prompt, user text, temperature 0 and json_object', async () => {
  const sent = [];
  const handle = createHandler({ gatewayFetch: gateway({ rows: [catalogRow('glm-5.3')], sent }) });
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = methods.map(name => console[name]);
  methods.forEach(name => { console[name] = (...args) => logged.push(args); });
  let request, response;
  try {
    request = await rulesRequest(body({ docType: 'monograph', group: 'structure' }), { authorization: 'Bearer do-not-forward', cookie: 'do-not-forward' });
    response = await handle(request, env);
  } finally { methods.forEach((name, index) => { console[name] = saved[index]; }); }
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  const { headers, payload } = sent[0];
  assert.equal(payload.model, 'glm-5.3');
  assert.equal(payload.temperature, 0);
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.deepEqual(payload.messages, [
    { role: 'system', content: rulesPrompt({ docType: 'monograph', group: 'structure' }) },
    { role: 'user', content: GUIDELINES },
  ]);
  assert.equal(headers.get('x-cail-identity-jwt'), request.headers.get('x-cail-gateway-identity-jwt'));
  assert.equal(headers.get('x-cail-app'), 'manuscript');
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), null);
  assert.match(headers.get('x-cail-request-id'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(logged, [], 'the Worker logs nothing');
});

test('adds max_tokens for a Workers AI non-reasoning row', async () => {
  // Workers AI would otherwise answer with at most 256 tokens; capped at half the context window.
  assert.deepEqual(await controlsFor(catalogRow('llama-4-scout-17b-16e-instruct', { context_length: 131000 })), { max_tokens: 16000 });
  assert.deepEqual(await controlsFor(catalogRow('gemma-7b-it-lora', { context_length: 8192 })), { max_tokens: 4096 });
  // Unlisted (or catalog unknown): room, but no reasoning controls a plain model would reject.
  assert.deepEqual(await controlsFor(null), { max_tokens: 16000 });
  // Other providers keep their own default.
  assert.deepEqual(await controlsFor(catalogRow('qwen3-vl-235b-a22b-instruct', { provider: 'bedrock-mantle' })), {});
});

test('adds reasoning_effort low for a reasoning row', async () => {
  const thinkingOff = { reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } };
  // 4,000 headroom + 6,000 expected output, never above 10,000 or half the context window.
  assert.deepEqual(await controlsFor(catalogRow('glm-5.3', { capabilities: ['text-generation', 'reasoning'], context_length: 202752 })), { max_tokens: 10000, ...thinkingOff });
  assert.deepEqual(await controlsFor(catalogRow('qwq-32b', { capabilities: ['text-generation', 'reasoning'], context_length: 12000 })), { max_tokens: 6000, ...thinkingOff });
  // enable_thinking is a Workers AI chat-template switch only.
  assert.deepEqual(await controlsFor(catalogRow('kimi-k2.5', { capabilities: ['text-generation', 'reasoning'], provider: 'bedrock-mantle' })), { max_tokens: 10000, reasoning_effort: 'low' });
});

test('returns the model content and a request id', async () => {
  const content = '{"rules":[{"category":"quotations","slot":"quotes.primary","statement":"Use double quotation marks.","quote":"use double quotation marks","mode":"fix","params":{"style":"double"}}],"manual":{"named":null}}';
  const handle = createHandler({ gatewayFetch: gateway({ reply: ok(content) }) });
  const requestId = crypto.randomUUID();
  const response = await handle(await rulesRequest(body(), { 'x-cail-request-id': requestId }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { content, request_id: requestId });
  const fresh = await (await handle(await rulesRequest(body()), env)).json();
  assert.match(fresh.request_id, /^[0-9a-f-]{36}$/);
});

test('rejects text over 60000 characters, unknown docType, unknown group, bad model id', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  const secret = 'Private guidelines sentence that must never be echoed. ';
  const long = secret.repeat(Math.ceil(60001 / secret.length)).slice(0, 60001);
  const cases = [
    [body({ text: long }), 'invalid_request'],
    [body({ docType: 'novel' }), 'invalid_request'],
    [body({ group: 'layout' }), 'invalid_request'],
    [body({ model: 'openrouter/glm-5.3' }), 'invalid_model'],
  ];
  for (const [request, code] of cases) {
    const response = await handle(await rulesRequest(request), env);
    const text = await response.clone().text();
    assert.deepEqual(await failure(response), [400, code], JSON.stringify(request).slice(0, 80));
    assert.equal(text.includes('Private guidelines'), false, 'the error does not echo the guidelines');
  }
  // The edges: empty or blank text, text that is not a string, a body that is not an object.
  for (const request of [body({ text: '' }), body({ text: '  \n ' }), body({ text: 42 }), [], null]) {
    assert.deepEqual(await failure(await handle(await rulesRequest(request), env)), [400, 'invalid_request'], JSON.stringify(request));
  }
  // Exactly 60,000 characters is accepted.
  const handleOk = createHandler({ gatewayFetch: gateway() });
  assert.equal((await handleOk(await rulesRequest(body({ text: long.slice(0, 60000) })), env)).status, 200);
});

test('maps finish_reason length to 502 model_output_limit', async () => {
  const handle = createHandler({ gatewayFetch: gateway({ reply: { choices: [{ message: { content: '{"rules":[{"cat' }, finish_reason: 'length' }] } }) });
  const response = await handle(await rulesRequest(body()), env);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  const message = (await response.clone().json()).error.message;
  assert.deepEqual(await failure(response), [502, 'model_output_limit']);
  assert.equal(message, 'The model ran out of room before it finished reading this part of the guidelines. Try again, or choose another model.');
});

test('maps empty content to 502 invalid_model_response', async () => {
  for (const reply of [ok(''), ok('  \n'), { choices: [{ message: { content: null }, finish_reason: 'stop' }] }, { choices: [] }, null]) {
    const handle = createHandler({ gatewayFetch: gateway({ reply }) });
    assert.deepEqual(await failure(await handle(await rulesRequest(body()), env)), [502, 'invalid_model_response'], JSON.stringify(reply));
  }
  const unreadable = createHandler({ gatewayFetch: gateway({ reply: () => new Response('not json', { headers: { 'content-type': 'application/json' } }) }) });
  assert.deepEqual(await failure(await unreadable(await rulesRequest(body()), env)), [502, 'invalid_model_response']);
});

test('requires sign-in', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  const request = at('/api/rules', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body()) });
  assert.deepEqual(await failure(await handle(request, env)), [401, 'authentication_required']);
});

test('passes a Gateway 429 through with x-should-retry true', async () => {
  const limited = () => cailErrorResponse(429, cailErrorEnvelope({ code: 'rate_limited', type: 'rate_limit_error', message: 'Too many requests right now.', cail: { retry_after_seconds: 5 } }), { 'x-should-retry': 'true', 'retry-after': '5' });
  const handle = createHandler({ gatewayFetch: gateway({ reply: limited }) });
  const response = await handle(await rulesRequest(body()), env);
  assert.equal(response.headers.get('x-should-retry'), 'true');
  assert.equal(response.headers.get('retry-after'), '5');
  assert.deepEqual(await failure(response), [429, 'rate_limited']);
});
