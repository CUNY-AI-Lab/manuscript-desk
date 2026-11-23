import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyConfig, verifyDeployed } from '../scripts/verify-release.mjs';

const toml = readFileSync('wrangler.toml', 'utf8');
// The checked-in config with one exact piece of text replaced; fails if that text is not there, so a
// test cannot pass by mutating nothing.
function edited(from, to) {
  assert.ok(toml.includes(from), `wrangler.toml no longer contains ${JSON.stringify(from)}`);
  return toml.replace(from, to);
}
const rejects = (config, message) => {
  const problems = verifyConfig(config);
  assert.ok(problems.some(problem => message.test(problem)), `expected a problem matching ${message}, got ${JSON.stringify(problems)}`);
};

test('accepts the checked-in wrangler.toml', () => {
  assert.deepEqual(verifyConfig(toml), []);
});

test('rejects a config without the GATEWAY binding to cail-model-api', () => {
  rejects(edited('[[services]]\nbinding = "GATEWAY"\nservice = "cail-model-api"\n', ''), /GATEWAY/);
  rejects(edited('service = "cail-model-api"', 'service = "cail-gateway"'), /GATEWAY/);
  rejects(edited('binding = "GATEWAY"', 'binding = "MODELS"'), /GATEWAY/);
});

test('rejects workers_dev = true', () => {
  rejects(edited('workers_dev = false', 'workers_dev = true'), /workers_dev/);
  rejects(edited('workers_dev = false\n', ''), /workers_dev/);
});

test('rejects preview_urls = true', () => {
  rejects(edited('preview_urls = false', 'preview_urls = true'), /preview_urls/);
  rejects(edited('preview_urls = false\n', ''), /preview_urls/);
});

test('rejects a config whose name is not cail-manuscript', () => {
  rejects(edited('name = "cail-manuscript"', 'name = "cail-bibliography"'), /name/);
});

test('rejects drift in the runtime, assets, issuer and version metadata', () => {
  const cases = [
    ['compatibility_date = "2026-09-07"', 'compatibility_date = "2026-11-17"', /compatibility_date/],
    ['compatibility_flags = ["enable_request_signal"]', 'compatibility_flags = []', /compatibility_flags/],
    ['compatibility_flags = ["enable_request_signal"]', 'compatibility_flags = ["enable_request_signal", "nodejs_compat"]', /compatibility_flags/],
    ['main = "server/worker.js"', 'main = "worker.js"', /main/],
    ['directory = "./dist"', 'directory = "./web"', /\[assets\]/],
    ['run_worker_first = true', 'run_worker_first = false', /\[assets\]/],
    ['CAIL_IDENTITY_ISSUER = "https://tools.ailab.gc.cuny.edu/cail-sso"', 'CAIL_IDENTITY_ISSUER = "https://example.org/sso"', /CAIL_IDENTITY_ISSUER/],
    ['[vars]\n', '[vars]\nCAIL_IDENTITY_JWKS = "{}"\n', /CAIL_IDENTITY_JWKS/],
    ['binding = "CF_VERSION_METADATA"', 'binding = "VERSION"', /version_metadata/],
  ];
  for (const [from, to, message] of cases) rejects(edited(from, to), message);
});

test('rejects text it cannot read instead of passing it', () => {
  rejects(`${toml}\nroutes = [{ pattern = "tools.ailab.gc.cuny.edu/*" }]\n`, /line \d+/);
  rejects(edited('workers_dev = false', 'workers_dev = false\nworkers_dev = true'), /workers_dev/);
});

// ---- The readback after a release, against what Cloudflare reports ----
const sha = 'a'.repeat(40);
const good = () => ({
  deployments: [{ id: 'deployment-1', versions: [{ version_id: 'version-1', percentage: 100 }] }],
  subdomain: { enabled: false, previews_enabled: false },
  version: {
    id: 'version-1',
    annotations: { 'workers/tag': sha, 'workers/message': `commit ${sha}` },
    resources: {
      bindings: [
        { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
        { name: 'CAIL_IDENTITY_JWKS', type: 'secret_text' },
        { name: 'CAIL_IDENTITY_ISSUER', type: 'plain_text', text: 'https://tools.ailab.gc.cuny.edu/cail-sso' },
        { name: 'ASSETS', type: 'assets' },
        { name: 'GATEWAY', type: 'service', service: 'cail-model-api' },
      ],
      script_runtime: { compatibility_date: '2026-09-07', compatibility_flags: ['enable_request_signal'] },
    },
  },
});
// The Cloudflare API as the stub module answers it, recording the paths read.
function cloudflare(fixture) {
  const paths = [];
  const fetchImpl = async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer stub-token');
    const { pathname } = new URL(url);
    paths.push(pathname);
    const path = /^\/client\/v4\/accounts\/account\/workers\/scripts\/cail-manuscript(\/.*)$/.exec(pathname)?.[1];
    const result = path === '/deployments' ? { deployments: fixture.deployments } : path === '/subdomain' ? fixture.subdomain : path?.startsWith('/versions/') ? fixture.version : undefined;
    return result === undefined ? new Response('not found', { status: 404 }) : Response.json({ success: true, result });
  };
  return { paths, fetchImpl };
}
const readBack = (fixture, extra = {}) => verifyDeployed({ account: 'account', token: 'stub-token', sha, fetchImpl: cloudflare(fixture).fetchImpl, ...extra });

test('release readback passes for the pinned configuration of cail-manuscript', async () => {
  const { paths, fetchImpl } = cloudflare(good());
  assert.deepEqual(await verifyDeployed({ account: 'account', token: 'stub-token', sha, fetchImpl }), { version: 'version-1' });
  assert.ok(paths.length >= 4 && paths.every(path => path.startsWith('/client/v4/accounts/account/workers/scripts/cail-manuscript/')), 'it reads this Worker, by name, and nothing else');
  assert.ok(paths.includes('/client/v4/accounts/account/workers/scripts/cail-manuscript/subdomain'));
});

test('release readback fails when the deployed Worker drifts from the private, Gateway-bound release asked for', async () => {
  const binding = (fixture, name) => fixture.version.resources.bindings.find(entry => entry.name === name);
  const without = (fixture, name) => { fixture.version.resources.bindings = fixture.version.resources.bindings.filter(entry => entry.name !== name); };
  const cases = [
    [fixture => { fixture.subdomain.enabled = true; }, /workers\.dev and previews disabled/],
    [fixture => { fixture.subdomain.previews_enabled = true; }, /workers\.dev and previews disabled/],
    [fixture => { without(fixture, 'GATEWAY'); }, /GATEWAY service binding/],
    [fixture => { binding(fixture, 'GATEWAY').service = 'cail-gateway'; }, /GATEWAY service binding/],
    [fixture => { binding(fixture, 'GATEWAY').type = 'plain_text'; }, /GATEWAY service binding/],
    [fixture => { without(fixture, 'CAIL_IDENTITY_JWKS'); }, /verifier secret is absent/],
    [fixture => { binding(fixture, 'CAIL_IDENTITY_JWKS').type = 'plain_text'; }, /verifier secret is absent/],
    [fixture => { binding(fixture, 'CAIL_IDENTITY_ISSUER').text = 'https://example.org/sso'; }, /Issuer/],
    [fixture => { without(fixture, 'ASSETS'); }, /Assets binding/],
    [fixture => { without(fixture, 'CF_VERSION_METADATA'); }, /version metadata binding/],
    [fixture => { fixture.version.annotations['workers/tag'] = 'b'.repeat(40); }, /not the requested commit/],
    [fixture => { fixture.version.annotations['workers/message'] = 'commit something else'; }, /not the requested commit/],
    [fixture => { delete fixture.version.annotations; }, /not the requested commit/],
    [fixture => { fixture.deployments[0].versions[0].percentage = 90; }, /one version at 100%/],
    [fixture => { fixture.deployments[0].versions.push({ version_id: 'version-2', percentage: 0 }); }, /one version at 100%/],
    [fixture => { fixture.version.id = 'version-9'; }, /differs from deployment/],
    [fixture => { fixture.version.resources.script_runtime.compatibility_flags = []; }, /compatibility flags/],
    [fixture => { delete fixture.version.resources.script_runtime.compatibility_flags; }, /compatibility flags/],
    [fixture => { fixture.version.resources.script_runtime.compatibility_flags.push('nodejs_compat'); }, /compatibility flags/],
    [fixture => { fixture.version.resources.script_runtime.compatibility_date = '2026-11-17'; }, /compatibility date/],
  ];
  for (const [mutate, message] of cases) {
    const fixture = good();
    mutate(fixture);
    await assert.rejects(readBack(fixture), message);
  }
});

test('release readback needs the account, the token and a full commit sha, and fails on an unsuccessful read', async () => {
  for (const extra of [{ account: '' }, { token: undefined }, { sha: 'a'.repeat(39) }, { sha: 'main' }, { sha: 'A'.repeat(40) }]) {
    await assert.rejects(readBack(good(), extra), /environment is incomplete/);
  }
  await assert.rejects(readBack(good(), { fetchImpl: async () => new Response('denied', { status: 403 }) }), /readback failed \(403\)/);
  await assert.rejects(readBack(good(), { fetchImpl: async () => Response.json({ success: false, result: null }) }), /unsuccessful/);
});

// Runs the script as the release job does, with the Cloudflare API stubbed.
async function verifyScript(fixture, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'manuscript-verify-'));
  try {
    const path = join(directory, 'fixture.json');
    await writeFile(path, JSON.stringify(fixture));
    return spawnSync(process.execPath, ['--import', './tests/fixtures/cloudflare-api-stub.mjs', 'scripts/verify-release.mjs', '--deployed'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'stub-token', RELEASE_SHA: sha, CLOUDFLARE_STUB_FIXTURE: path, ...env },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('scripts/verify-release.mjs --deployed checks wrangler.toml, then reads the release back, as the release job runs it', async () => {
  const passed = await verifyScript(good());
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /wrangler\.toml passes the release check\.\n/);
  assert.match(passed.stdout, new RegExp(`control-plane readback passed: commit ${sha}, version version-1, 100% traffic`));
  const drifted = good();
  drifted.subdomain.enabled = true;
  const failed = await verifyScript(drifted);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /workers\.dev and previews disabled/);
  const incomplete = await verifyScript(good(), { RELEASE_SHA: '' });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /environment is incomplete/);
  assert.ok(!`${passed.stdout}${failed.stderr}`.includes('stub-token'), 'the token is never printed');
});
