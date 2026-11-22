import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { quotaSnapshotBody } from '@cuny-ai-lab/cail-client/testing';
import { createHandler } from '../server/worker.js';

const ORIGIN = 'https://tools.ailab.gc.cuny.edu';
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const issuer = await createTestIdentityIssuer();
const env = { CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer };

// The Worker must never reach the Gateway (or anything else) through global fetch.
globalThis.fetch = async input => assert.fail(`global fetch called for ${input instanceof Request ? input.url : input}`);

// Both identity legs as Doorway sends them: the app leg for cail:manuscript, the gateway leg for
// cail:gateway, both for the same person unless a test says otherwise.
async function signedHeaders({ audience = 'cail:manuscript', gatewaySubject = TEST_SUBJECTS.alice, headers = {} } = {}) {
  const app = await issuer.mintIdentityJwt({ audience, expiresInSeconds: 3600 });
  const gateway = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: gatewaySubject });
  return new Headers({ 'x-cail-identity-jwt': app, 'x-cail-gateway-identity-jwt': gateway, ...headers });
}
const at = (path, init) => new Request(`${ORIGIN}/manuscript${path}`, init);
const signed = async (path, options = {}, init = {}) => at(path, { headers: await signedHeaders(options), ...init });
const noGateway = () => assert.fail('Must not contact Gateway');
const catalog = () => Response.json({ object: 'list', data: [] });
const htmlAssets = (seen = []) => ({ fetch: async request => {
  seen.push(new URL(request.url).pathname);
  return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
} });

// Returns [status, error.code] and checks the error envelope: every 401 names the launch path and
// nothing else does; every error carries a request id in body and header.
async function failure(response) {
  const { error } = await response.json();
  assert.equal(error.launch, response.status === 401 ? '/launch/manuscript' : undefined);
  assert.match(error.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('x-cail-request-id'), error.request_id);
  assert.ok(['true', 'false'].includes(response.headers.get('x-should-retry')));
  return [response.status, error.code];
}

test('foreign origin is 404', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  const response = await handle(new Request('https://example.org/manuscript/api/session', { headers: await signedHeaders() }), env);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'not_found');
});

test('no identity leg is 401 with launch path', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  assert.deepEqual(await failure(await handle(at('/api/session'), env)), [401, 'authentication_required']);
});

test('malformed identity leg is 401 invalid_credential', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  for (const headers of [{ 'x-cail-identity-jwt': 'not-a-jwt' }, { 'x-cail-gateway-identity-jwt': 'not-a-jwt' }, { 'x-cail-gateway-identity-jwt': '' }]) {
    assert.deepEqual(await failure(await handle(await signed('/api/session', { headers }), env)), [401, 'invalid_credential'], JSON.stringify(headers));
  }
  const appOnly = await signed('/api/session');
  appOnly.headers.delete('x-cail-gateway-identity-jwt');
  assert.deepEqual(await failure(await handle(appOnly, env)), [401, 'invalid_credential']);
});

test('identity for another audience is 401', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  assert.deepEqual(await failure(await handle(await signed('/api/session', { audience: 'cail:bibliography' }), env)), [401, 'invalid_credential']);
});

test('gateway leg for a different subject is 401', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  assert.deepEqual(await failure(await handle(await signed('/api/session', { gatewaySubject: TEST_SUBJECTS.bob }), env)), [401, 'invalid_credential']);
});

test('session returns authenticated for valid legs', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  const response = await handle(await signed('/api/session'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { authenticated: true });
});

test('POST without the tools origin header is 403 invalid_origin', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  for (const headers of [{}, { origin: 'https://evil.example' }]) {
    const request = await signed('/api/session', { headers: { 'content-type': 'application/json', ...headers } }, { method: 'POST', body: '{}' });
    assert.deepEqual(await failure(await handle(request, env)), [403, 'invalid_origin'], JSON.stringify(headers));
  }
});

test('quota is read through the injected gateway fetch with the gateway leg', async () => {
  const calls = [];
  const snapshot = quotaSnapshotBody();
  const handle = createHandler({ gatewayFetch: async (url, init) => { calls.push({ url: String(url), headers: new Headers(init.headers) }); return Response.json(snapshot); } });
  const request = await signed('/api/quota', { headers: { authorization: 'Bearer do-not-forward', cookie: 'do-not-forward' } });
  const response = await handle(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/v1/quota`);
  // A JWT credential travels as x-cail-identity-jwt; ambient Authorization and cookies are stripped.
  assert.equal(calls[0].headers.get('x-cail-identity-jwt'), request.headers.get('x-cail-gateway-identity-jwt'));
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.equal(calls[0].headers.get('cookie'), null);
  assert.equal(calls[0].headers.get('x-cail-app'), 'manuscript');
});

test('health is 503 gateway_unavailable when the catalog cannot be read', async () => {
  const handle = createHandler({ gatewayFetch: async () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }) });
  const response = await handle(at('/health'), { ...env, ASSETS: htmlAssets() });
  assert.deepEqual(await failure(response), [503, 'gateway_unavailable']);
  assert.equal(response.headers.get('x-should-retry'), 'true');
});

test('health is 200 ready without credentials when catalog and assets answer', async () => {
  const paths = [], assets = [];
  const handle = createHandler({ gatewayFetch: async url => { paths.push(new URL(url).pathname); return catalog(); } });
  for (const method of ['GET', 'HEAD']) {
    const response = await handle(at('/health', { method }), { ...env, ASSETS: htmlAssets(assets), CF_VERSION_METADATA: { id: 'tested-version', tag: 'tested-release' } });
    assert.equal(response.status, 200, method);
    if (method === 'GET') assert.deepEqual(await response.json(), { status: 'ready', version_id: 'tested-version', tag: 'tested-release' });
  }
  assert.deepEqual(paths, ['/v1/catalog', '/v1/catalog']);
  assert.deepEqual(assets, ['/', '/']);
});

test('missing verifier key set is 503 identity_unavailable', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  const { CAIL_IDENTITY_JWKS, ...withoutKeys } = env;
  assert.deepEqual(await failure(await handle(await signed('/api/session'), withoutKeys)), [503, 'identity_unavailable']);
  assert.deepEqual(await failure(await handle(at('/health'), { ...withoutKeys, ASSETS: htmlAssets() })), [503, 'identity_unavailable']);
});

test('unknown api path is 404', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  const assets = [];
  const configured = { ...env, ASSETS: htmlAssets(assets) };
  assert.deepEqual(await failure(await handle(await signed('/api/nothing-here'), configured)), [404, 'not_found']);
  // A path that only shares the mount's prefix is not under the mount.
  const outside = new Request(`${ORIGIN}/manuscriptx/index.html`, { headers: await signedHeaders() });
  assert.deepEqual(await failure(await handle(outside, configured)), [404, 'not_found']);
  assert.deepEqual(assets, [], 'neither request reached the assets');
});

test('static asset is served with the path prefix stripped and the CSP header', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  const assets = [];
  const response = await handle(await signed('/format/'), { ...env, ASSETS: htmlAssets(assets) });
  assert.equal(response.status, 200);
  assert.deepEqual(assets, ['/format/']);
  assert.equal(response.headers.get('content-security-policy'), CSP);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await response.text(), '<!doctype html>');
  // Assets sit behind sign-in like everything except health.
  assert.deepEqual(await failure(await handle(at('/format/'), { ...env, ASSETS: htmlAssets(assets) })), [401, 'authentication_required']);
  assert.equal(assets.length, 1);
});

test('GET /manuscript redirects 308 to /manuscript/', async () => {
  const handle = createHandler({ gatewayFetch: noGateway });
  for (const method of ['GET', 'HEAD']) {
    const response = await handle(new Request(`${ORIGIN}/manuscript?example=1`, { method, headers: await signedHeaders() }), env);
    assert.equal(response.status, 308, method);
    assert.equal(response.headers.get('location'), `${ORIGIN}/manuscript/?example=1`);
  }
  assert.equal((await handle(new Request(`${ORIGIN}/manuscript`), env)).status, 401);
});
