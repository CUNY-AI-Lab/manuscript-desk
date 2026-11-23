import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../web/shared/api.js';

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const lostSession = (code, headers = {}) => reply(401, { error: { code, message: 'Sign in with CUNY to continue.', request_id: '00000000-0000-4000-8000-000000000000', launch: '/launch/manuscript' } }, { 'x-should-retry': 'false', ...headers });

// A fetch double that records every call and answers from `answer`.
function recorder(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return answer(url, init); };
  return { calls, fetchImpl };
}

// 'pending' if the promise has neither resolved nor rejected after a short wait.
const settledWithin = (promise, ms = 50) => Promise.race([
  promise.then(() => 'resolved', () => 'rejected'),
  new Promise(resolve => setTimeout(() => resolve('pending'), ms)),
]);

test('get resolves parsed JSON', async () => {
  const { calls, fetchImpl } = recorder(() => reply(200, { authenticated: true }));
  const api = createApi({ fetchImpl, navigate: () => assert.fail('must not navigate') });
  assert.deepEqual(await api.get('/api/session'), { authenticated: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/manuscript/api/session');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
});

test('a 401 authentication_required runs onLostSession then navigates to the launch path and does not settle', async () => {
  const order = [];
  const { fetchImpl } = recorder(() => lostSession('authentication_required'));
  const api = createApi({
    fetchImpl,
    navigate: url => order.push(`navigate ${url}`),
    onLostSession: async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('saved'); },
  });
  assert.equal(await settledWithin(api.get('/api/quota')), 'pending');
  assert.deepEqual(order, ['saved', 'navigate /launch/manuscript']);
});

test('a 401 does not retry and does not fetch the launch path from script', async () => {
  for (const code of ['authentication_required', 'invalid_credential', 'session_invalid']) {
    const navigated = [];
    // Even a 401 marked retryable is not retried.
    const { calls, fetchImpl } = recorder(() => lostSession(code, { 'x-should-retry': 'true' }));
    const api = createApi({ fetchImpl, navigate: url => navigated.push(url) });
    assert.equal(await settledWithin(api.post('/api/rules', { text: 'x' })), 'pending', code);
    assert.equal(calls.length, 1, code);
    assert.ok(calls.every(call => !call.url.includes('/launch/')), code);
    assert.deepEqual(navigated, ['/launch/manuscript'], code);
  }
});

test('calls that find the session lost together navigate once', async () => {
  const order = [];
  const { calls, fetchImpl } = recorder(() => lostSession('authentication_required'));
  const api = createApi({ fetchImpl, navigate: url => order.push(`navigate ${url}`), onLostSession: () => { order.push('saved'); } });
  const results = await Promise.all([1, 2, 3].map(() => settledWithin(api.post('/api/rules', {}))));
  assert.deepEqual(results, ['pending', 'pending', 'pending']);
  assert.equal(calls.length, 3);
  assert.deepEqual(order, ['saved', 'navigate /launch/manuscript']);
});

test('a 401 with an unexpected launch value navigates to the tool launch path', async () => {
  const navigated = [];
  const { fetchImpl } = recorder(() => reply(401, { error: { code: 'authentication_required', message: 'x', launch: 'https://elsewhere.example/' } }));
  const api = createApi({ fetchImpl, navigate: url => navigated.push(url) });
  assert.equal(await settledWithin(api.get('/api/session')), 'pending');
  assert.deepEqual(navigated, ['/launch/manuscript']);
});

test('a 429 rejects with retry true from x-should-retry', async () => {
  const { calls, fetchImpl } = recorder(() => reply(429, { error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.', request_id: 'abc' } }, { 'x-should-retry': 'true' }));
  const api = createApi({ fetchImpl, navigate: () => assert.fail('must not navigate') });
  const error = await api.post('/api/rules', {}).then(() => assert.fail('must reject'), error => error);
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'rate_limited');
  assert.equal(error.message, 'Too many requests. Try again shortly.');
  assert.equal(error.retry, true);
  assert.equal(calls.length, 1, 'the client itself never retries');
});

test('an error without x-should-retry true rejects with retry false', async () => {
  const { fetchImpl } = recorder(() => reply(502, { error: { code: 'invalid_model_response', message: 'The model returned an empty answer.' } }, { 'x-should-retry': 'false' }));
  const error = await createApi({ fetchImpl }).post('/api/rules', {}).catch(error => error);
  assert.equal(error.code, 'invalid_model_response');
  assert.equal(error.retry, false);
});

test('a network failure rejects with code network_error and retry false', async () => {
  const api = createApi({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const error = await api.get('/api/catalog').catch(error => error);
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'network_error');
  assert.equal(error.retry, false);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
});

test('an aborted request rejects with the abort, not an ApiError', async () => {
  const controller = new AbortController();
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const pending = createApi({ fetchImpl }).post('/api/rules', {}, { signal: controller.signal });
  controller.abort();
  const error = await pending.catch(error => error);
  assert.ok(!(error instanceof ApiError));
  assert.equal(error.name, 'AbortError');
});

test('post sends JSON with content-type application/json', async () => {
  const { calls, fetchImpl } = recorder(() => reply(200, { content: '{"rules":[]}', request_id: 'r' }));
  const controller = new AbortController();
  const body = { model: 'glm-5.3', docType: 'monograph', group: 'style', text: 'Use double quotation marks.' };
  const result = await createApi({ fetchImpl }).post('/api/rules', body, { signal: controller.signal });
  assert.deepEqual(result, { content: '{"rules":[]}', request_id: 'r' });
  const { url, init } = calls[0];
  assert.equal(url, '/manuscript/api/rules');
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(init.body), body);
  assert.equal(init.credentials, 'same-origin');
  // The caller's signal reaches the request.
  assert.equal(init.signal.aborted, false);
  controller.abort();
  assert.equal(init.signal.aborted, true);
});
