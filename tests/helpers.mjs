// Shared by the Worker test files: signed identity legs, request builders and the error-envelope check.
import assert from 'node:assert/strict';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';

export const ORIGIN = 'https://tools.ailab.gc.cuny.edu';
export const issuer = await createTestIdentityIssuer();
export const env = { CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer };

// The Worker must never reach the Gateway (or anything else) through global fetch.
globalThis.fetch = async input => assert.fail(`global fetch called for ${input instanceof Request ? input.url : input}`);

// Both identity legs as Doorway sends them: the app leg for cail:manuscript, the gateway leg for
// cail:gateway, both for the same person unless a test says otherwise.
export async function signedHeaders({ audience = 'cail:manuscript', gatewaySubject = TEST_SUBJECTS.alice, headers = {} } = {}) {
  const app = await issuer.mintIdentityJwt({ audience, expiresInSeconds: 3600 });
  const gateway = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: gatewaySubject });
  return new Headers({ 'x-cail-identity-jwt': app, 'x-cail-gateway-identity-jwt': gateway, ...headers });
}
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
