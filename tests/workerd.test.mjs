import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';

// Runs the bundled Worker in real workerd with the production compatibility date and flags. The
// Gateway is a second workerd Worker reached through the GATEWAY service binding; nothing leaves
// the machine.
const toml = await readFile('wrangler.toml', 'utf8');
const compatibilityDate = JSON.parse(toml.match(/^compatibility_date = (".*")$/m)[1]);
const compatibilityFlags = JSON.parse(toml.match(/^compatibility_flags = (\[.*\])$/m)[1]);
const HEALTH = 'https://tools.ailab.gc.cuny.edu/manuscript/health';

const gatewayScript = `
let catalogReads = 0;
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/__status') return Response.json({ catalogReads });
  if (url.pathname === '/v1/catalog') { catalogReads++; return Response.json({ object: 'list', data: [] }); }
  return new Response('unexpected', { status: 500 });
} };`;

// Starts the Worker built from `entry` (the real server/worker.js unless a test says otherwise).
// Every global fetch() is answered as production answers a global fetch() to the tool's own zone:
// by the zone origin, with a 404, not by the Gateway Worker.
// `assetsDirectory` serves a real build (dist/) instead of a one-page stand-in.
async function startWorker({ entry = resolve('server/worker.js'), gatewayBinding = true, assetsDirectory = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'manuscript-workerd-'));
  const outfile = join(directory, 'worker.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:*'], logLevel: 'silent' });
  let assets = assetsDirectory;
  if (!assets) {
    assets = join(directory, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'index.html'), '<!doctype html><title>Manuscript Desk</title>');
  }
  const issuer = await createTestIdentityIssuer();
  const outbound = [];
  const base = { modules: true, modulesRoot: '/', compatibilityDate, compatibilityFlags };
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
    { ...base, name: 'manuscript', scriptPath: outfile,
      bindings: { CAIL_IDENTITY_ISSUER: issuer.issuer, CAIL_IDENTITY_JWKS: issuer.jwksJson },
      serviceBindings: gatewayBinding ? { GATEWAY: 'gateway' } : {},
      assets: { directory: assets, binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true } },
      outboundService: async request => {
        outbound.push(request.url);
        return new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
      } },
    { ...base, name: 'gateway', script: gatewayScript },
  ] }));
  const gatewayStatus = async () => (await (await runtime.getWorker('gateway')).fetch('https://gateway/__status')).json();
  return { runtime, issuer, outbound, gatewayStatus, dispose: async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('health reads the catalog through the GATEWAY binding', async () => {
  const worker = await startWorker();
  try {
    const response = await worker.runtime.dispatchFetch(HEALTH);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(JSON.parse(text).status, 'ready');
    assert.deepEqual(await worker.gatewayStatus(), { catalogReads: 1 });
    assert.deepEqual(worker.outbound, [], 'no global fetch');
  } finally { await worker.dispose(); }
});

test('a global fetch to the tools hostname would fail health', async () => {
  // With the binding removed, the Worker reports the Gateway unreachable; it does not fall back to
  // a global fetch.
  const unbound = await startWorker({ gatewayBinding: false });
  try {
    const response = await unbound.runtime.dispatchFetch(HEALTH);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'gateway_unavailable');
    assert.deepEqual(unbound.outbound, []);
  } finally { await unbound.dispose(); }
  // A Worker that did use global fetch() would reach the zone origin, get its 404, and fail health
  // too, although the binding is present.
  const directory = await mkdtemp(join(tmpdir(), 'manuscript-entry-'));
  const entry = join(directory, 'global-fetch.mjs');
  await writeFile(entry, `import { createHandler } from ${JSON.stringify(resolve('server/worker.js'))};
export default { fetch: createHandler({ fetchImpl: (input, init) => fetch(input, init) }) };`);
  const global = await startWorker({ entry });
  try {
    const response = await global.runtime.dispatchFetch(HEALTH);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'gateway_unavailable');
    assert.deepEqual(global.outbound, ['https://tools.ailab.gc.cuny.edu/v1/catalog?modality=all']);
    assert.deepEqual(await global.gatewayStatus(), { catalogReads: 0 });
  } finally { await global.dispose(); await rm(directory, { recursive: true, force: true }); }
});

// dist/ as `npm run build` writes it; built here only when it is missing.
async function builtAssets() {
  const page = resolve('dist/format/index.html');
  try {
    await access(page);
  } catch {
    await promisify(execFile)(process.execPath, ['scripts/build.mjs']);
    await access(page);
  }
  return resolve('dist');
}

test('the Formatter page is served from the real build, with the slash-less path redirected to it', async t => {
  let assetsDirectory;
  try {
    assetsDirectory = await builtAssets();
  } catch (error) {
    t.skip(`dist/ is missing and could not be built (run npm run vendor, then npm run build): ${error.message.split('\n')[0]}`);
    return;
  }
  const worker = await startWorker({ assetsDirectory });
  try {
    const headers = {
      'x-cail-identity-jwt': await worker.issuer.mintIdentityJwt({ audience: 'cail:manuscript', expiresInSeconds: 3600 }),
      'x-cail-gateway-identity-jwt': await worker.issuer.mintIdentityJwt({ audience: 'cail:gateway' }),
    };
    const base = 'https://tools.ailab.gc.cuny.edu/manuscript';
    const redirect = await worker.runtime.dispatchFetch(`${base}/format?from=menu`, { headers, redirect: 'manual' });
    await redirect.arrayBuffer();
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), `${base}/format/?from=menu`);
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    const page = await worker.runtime.dispatchFetch(`${base}/format/`, { headers, redirect: 'manual' });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(html, /<title>Formatter \| Manuscript Desk \| CUNY AI Lab<\/title>/);
    // The page's relative links resolve inside the folder and are served.
    for (const [path, type] of [['/format/app.js', /javascript/], ['/shared/styles.css', /text\/css/]]) {
      const asset = await worker.runtime.dispatchFetch(`${base}${path}`, { headers, redirect: 'manual' });
      await asset.arrayBuffer();
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get('content-type'), type, path);
    }
    // The MuPDF licence is a file with no extension; it is served, not redirected.
    const licence = await worker.runtime.dispatchFetch(`${base}/vendor/mupdf/LICENSE`, { headers, redirect: 'manual' });
    const licenceText = await licence.text();
    assert.equal(licence.status, 200);
    assert.ok(licenceText.includes('GNU AFFERO'), 'the licence text is served');
    assert.deepEqual(worker.outbound, [], 'no global fetch');
  } finally { await worker.dispose(); }
});
