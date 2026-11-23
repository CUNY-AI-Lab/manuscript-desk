// A throwaway identity issuer standing in for Doorway, shared by the Worker tests and the local dev
// server. Its key pair is generated in memory per process and never written anywhere; the Worker
// accepts its tokens only because the `env` built here hands the Worker this issuer's public keys.
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';

export const ORIGIN = 'https://tools.ailab.gc.cuny.edu';

export async function createLocalIdentity() {
  const issuer = await createTestIdentityIssuer();
  // The identity configuration the Worker reads from its environment.
  const env = { CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer };
  // Both identity legs as Doorway sends them: the app leg for cail:manuscript, the gateway leg for
  // cail:gateway, both for the same person unless the caller says otherwise.
  async function signedHeaders({ audience = 'cail:manuscript', subject = TEST_SUBJECTS.alice, gatewaySubject = subject, headers = {} } = {}) {
    const app = await issuer.mintIdentityJwt({ audience, subject, expiresInSeconds: 3600 });
    const gateway = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: gatewaySubject });
    return new Headers({ 'x-cail-identity-jwt': app, 'x-cail-gateway-identity-jwt': gateway, ...headers });
  }
  return { issuer, env, signedHeaders };
}
