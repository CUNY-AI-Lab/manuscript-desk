import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, LAUNCH_PATH, createApi } from '../web/shared/api.js';

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

// What the page passes in: a location that records navigations, and sessionStorage.
const memoryStorage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }; };
const PAGE = 'https://tools.ailab.gc.cuny.edu/manuscript/format/';
const launchURL = 'https://tools.ailab.gc.cuny.edu/launch/manuscript';
function setup(answer, extra = {}) {
  const assigned = [];
  const location = { href: PAGE, assign: url => assigned.push(String(url)) };
  const { calls, fetchImpl } = recorder(answer);
  const api = createApi({ fetchImpl, location, storage: memoryStorage(), ...extra });
  return { api, calls, assigned };
}

test('get resolves parsed JSON', async () => {
  const { api, calls, assigned } = setup(() => reply(200, { authenticated: true }));
  assert.deepEqual(await api.get('/api/session'), { authenticated: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/manuscript/api/session');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(assigned, []);
});

test('a lost CAIL session restarts sign-in once at the launch path, with no retry of the request', async () => {
  assert.equal(LAUNCH_PATH, '/launch/manuscript');
  for (const code of ['authentication_required', 'session_invalid']) {
    // Even a 401 marked retryable is not retried.
    const { api, calls, assigned } = setup(() => lostSession(code, { 'x-should-retry': 'true' }));
    assert.equal(await settledWithin(api.post('/api/rules', { text: 'x' })), 'pending', code);
    assert.deepEqual(assigned, [launchURL], code);
    assert.equal(calls.length, 1, 'each call fetches once; nothing is re-issued');
    assert.ok(calls.every(call => !call.url.includes('/launch/')), 'the launch path is not fetched from script');
  }
});

test('a restart runs onLostSession first, then navigates, and the call does not settle', async () => {
  const order = [];
  const { api } = setup(() => lostSession('authentication_required'), {
    location: { href: PAGE, assign: url => order.push(`navigate ${url}`) },
    onLostSession: async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('saved'); },
  });
  assert.equal(await settledWithin(api.get('/api/quota')), 'pending');
  assert.deepEqual(order, ['saved', `navigate ${launchURL}`]);
});

test('calls that find the session lost together navigate once', async () => {
  const order = [];
  const { api, calls } = setup(() => lostSession('authentication_required'), {
    location: { href: PAGE, assign: url => order.push(`navigate ${url}`) },
    onLostSession: () => { order.push('saved'); },
  });
  const results = await Promise.all([1, 2, 3].map(() => settledWithin(api.post('/api/rules', {}))));
  assert.deepEqual(results, ['pending', 'pending', 'pending']);
  assert.equal(calls.length, 3);
  assert.deepEqual(order, ['saved', `navigate ${launchURL}`]);
});

test('sign-in restart is not repeated across a reload within a minute, but the link is still offered', async () => {
  const storage = memoryStorage();
  let clock = 1_000_000;
  const first = setup(() => lostSession('session_invalid'), { storage, now: () => clock });
  assert.equal(await settledWithin(first.api.get('/api/quota')), 'pending');
  clock += 59_000;
  const second = setup(() => lostSession('session_invalid'), { storage, now: () => clock, onLostSession: () => assert.fail('nothing is saved for a navigation that does not happen') });
  await assert.rejects(second.api.get('/api/quota'), error => error instanceof ApiError && error.status === 401 && error.code === 'session_invalid' && error.signInUrl === launchURL);
  clock += 2_000;
  const third = setup(() => lostSession('session_invalid'), { storage, now: () => clock });
  assert.equal(await settledWithin(third.api.get('/api/quota')), 'pending');
  assert.deepEqual([first.assigned.length, second.assigned.length, third.assigned.length], [1, 0, 1]);
});

test('without usable sessionStorage the page never navigates on its own and offers the link instead', async () => {
  const broken = [
    undefined,
    null,
    { getItem() { throw new Error('SecurityError'); }, setItem() {} },
    { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } },
    { getItem: () => null, setItem() {} },
  ];
  for (const storage of broken) {
    const { api, assigned } = setup(() => lostSession('authentication_required'), { storage });
    for (let i = 0; i < 3; i++) await assert.rejects(api.get('/api/quota'), error => error.code === 'authentication_required' && error.signInUrl === launchURL);
    assert.deepEqual(assigned, []);
  }
});

test('the Worker invalid_credential code and other errors only show an error', async () => {
  for (const [status, code] of [[401, 'invalid_credential'], [403, 'authentication_required'], [429, 'quota_exceeded']]) {
    const { api, assigned } = setup(() => reply(status, { error: { code, message: 'No.', request_id: 'r', launch: '/launch/manuscript' } }));
    await assert.rejects(api.post('/api/rules', {}), error => error instanceof ApiError && error.code === code && error.signInUrl === undefined);
    assert.deepEqual(assigned, []);
  }
});

test('a 401 launch value is used only when it is a same-origin /launch/ path', async () => {
  const withLaunch = launch => () => reply(401, { error: { code: 'authentication_required', message: 'x', launch } });
  const good = setup(withLaunch('/launch/manuscript'));
  assert.equal(await settledWithin(good.api.get('/api/session')), 'pending');
  assert.deepEqual(good.assigned, [launchURL]);
  for (const launch of ['//evil.example/launch/x', 'https://evil.example/launch/x', '/launch/../welcome', 'javascript:alert(1)', 42]) {
    const bad = setup(withLaunch(launch));
    assert.equal(await settledWithin(bad.api.get('/api/session')), 'pending');
    assert.deepEqual(bad.assigned, [launchURL]);
    const linked = setup(withLaunch(launch), { storage: null });
    await assert.rejects(linked.api.get('/api/session'), error => error.signInUrl === launchURL);
  }
});

test('a 429 rejects with retry true from x-should-retry', async () => {
  const { calls, fetchImpl } = recorder(() => reply(429, { error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.', request_id: 'abc' } }, { 'x-should-retry': 'true' }));
  const api = createApi({ fetchImpl, location: { href: PAGE, assign: () => assert.fail('must not navigate') } });
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
