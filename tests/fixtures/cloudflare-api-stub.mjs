// Preloaded with --import: answers the Cloudflare API reads of `scripts/verify-release.mjs --deployed`
// from a JSON fixture, so the readback runs without network or credentials. Only the cail-manuscript
// script is known; any other path is a 404.
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(process.env.CLOUDFLARE_STUB_FIXTURE, 'utf8'));
globalThis.fetch = async url => {
  const match = /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/cail-manuscript(\/.*)$/.exec(new URL(url).pathname);
  const path = match?.[1];
  const result = path === '/deployments' ? { deployments: fixture.deployments } : path === '/subdomain' ? fixture.subdomain : path?.startsWith('/versions/') ? fixture.version : undefined;
  return result === undefined ? new Response('not found', { status: 404 }) : Response.json({ success: true, result });
};
