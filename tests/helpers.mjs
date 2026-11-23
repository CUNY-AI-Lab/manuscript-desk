// Shared by the Worker test files: signed identity legs, request builders and the error-envelope check.
import assert from 'node:assert/strict';
import { ORIGIN, createLocalIdentity } from '../scripts/identity.mjs';

export { ORIGIN };
export const { issuer, env, signedHeaders } = await createLocalIdentity();

// The Worker must never reach the Gateway (or anything else) through global fetch.
globalThis.fetch = async input => assert.fail(`global fetch called for ${input instanceof Request ? input.url : input}`);

export const at = (path, init) => new Request(`${ORIGIN}/manuscript${path}`, init);
export const signed = async (path, options = {}, init = {}) => at(path, { headers: await signedHeaders(options), ...init });
export const noGateway = () => assert.fail('Must not contact Gateway');

// Returns [status, error.code] and checks the error envelope: every 401 names the launch path and
// nothing else does; every error carries a request id in body and header.
export async function failure(response) {
  const { error } = await response.json();
  assert.equal(error.launch, response.status === 401 ? '/launch/manuscript' : undefined);
  assert.match(error.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('x-cail-request-id'), error.request_id);
  assert.ok(['true', 'false'].includes(response.headers.get('x-should-retry')));
  return [response.status, error.code];
}
