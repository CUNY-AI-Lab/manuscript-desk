// Release checks, in two parts.
// verifyConfig: wrangler.toml keeps this Worker private and binding-only. It returns a list of
// problems, empty when the config is good. It reads only the small TOML subset this file uses and
// reports any line outside it, so an unexpected setting fails the check instead of passing unseen.
// verifyDeployed: a read-only control-plane readback, after `wrangler deploy`, of what Cloudflare now
// serves as cail-manuscript (as in the Bibliography Converter's release). It needs
// CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and RELEASE_SHA, and does not claim the service binding
// was exercised: private runtime and member acceptance remain separate.
// Run directly, it checks ./wrangler.toml (or the path given); with --deployed it then reads back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WORKER = 'cail-manuscript';
const ISSUER = 'https://tools.ailab.gc.cuny.edu/cail-sso';
const COMPATIBILITY_DATE = '2026-09-07';

const VALUE = /^("(?:[^"\\]|\\.)*"|true|false|-?\d+|\[(?:\s*(?:"(?:[^"\\]|\\.)*"|true|false)\s*,?)*\s*\])\s*(?:#.*)?$/;

// Returns { config, problems }: top-level keys on config, [table] as objects, [[table]] as arrays.
function parse(text) {
  const config = {}, problems = [];
  let table = config;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const arrayHeader = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]\s*(?:#.*)?$/);
    const tableHeader = line.match(/^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/);
    const name = (arrayHeader ?? tableHeader)?.[1];
    if (name) {
      table = {};
      if (name in config && (tableHeader || !Array.isArray(config[name]))) problems.push(`line ${index + 1}: [${name}] is declared twice`);
      else if (arrayHeader) (config[name] ??= []).push(table);
      else config[name] = table;
      return;
    }
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    const value = entry?.[2].match(VALUE);
    if (!value) { problems.push(`line ${index + 1} is not understood by the release check: ${line}`); return; }
    if (entry[1] in table) { problems.push(`line ${index + 1}: ${entry[1]} is set twice`); return; }
    table[entry[1]] = JSON.parse(value[1].replace(/,(\s*)\]$/, '$1]'));
  });
  return { config, problems };
}

export function verifyConfig(wranglerToml) {
  const { config, problems } = parse(wranglerToml);
  const expect = (ok, problem) => { if (!ok) problems.push(problem); };
  const { assets = {}, vars = {}, version_metadata: metadata = {}, services = [] } = config;
  expect(config.name === WORKER, `name must be "${WORKER}"`);
  expect(config.main === 'server/worker.js', 'main must be "server/worker.js"');
  expect(config.compatibility_date === COMPATIBILITY_DATE, `compatibility_date must be "${COMPATIBILITY_DATE}"`);
  // Without enable_request_signal (default only from 2026-11-17) a caller abort never reaches the Gateway call.
  expect(JSON.stringify(config.compatibility_flags) === '["enable_request_signal"]', 'compatibility_flags must be exactly ["enable_request_signal"]');
  // Absent means true to wrangler, so both must be written out as false.
  expect(config.workers_dev === false, 'workers_dev must be false');
  expect(config.preview_urls === false, 'preview_urls must be false');
  expect(assets.directory === './dist' && assets.binding === 'ASSETS' && assets.run_worker_first === true, '[assets] must serve ./dist through the ASSETS binding with run_worker_first = true');
  expect(vars.CAIL_IDENTITY_ISSUER === ISSUER, `CAIL_IDENTITY_ISSUER must be "${ISSUER}"`);
  expect(!('CAIL_IDENTITY_JWKS' in vars), 'CAIL_IDENTITY_JWKS must be a secret, not a [vars] entry');
  expect(metadata.binding === 'CF_VERSION_METADATA', '[version_metadata] must bind CF_VERSION_METADATA');
  // Same-zone global fetch() to the Gateway URL reaches the zone origin (404); only this binding reaches it.
  const gateway = (Array.isArray(services) ? services : []).filter(service => service.binding === 'GATEWAY');
  expect(gateway.length === 1 && gateway[0].service === 'cail-model-api', 'exactly one [[services]] entry must bind GATEWAY to service "cail-model-api"');
  return problems;
}

export async function verifyDeployed({ account, token, sha, fetchImpl = fetch }) {
  assert(account && token && /^[0-9a-f]{40}$/.test(sha || ''), 'Release verification environment is incomplete');
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${WORKER}`;
  async function read(path) {
    const response = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    assert(response.ok, `Cloudflare readback failed (${response.status})`);
    const body = await response.json();
    assert(body.success, 'Cloudflare readback was unsuccessful');
    return body.result;
  }
  const { deployments } = await read('/deployments');
  const latest = deployments[0];
  assert(latest?.versions.length === 1 && latest.versions[0].percentage === 100, 'Latest deployment must serve one version at 100%');
  const version = await read(`/versions/${latest.versions[0].version_id}`);
  const bindings = version.resources.bindings;
  assert(version.id === latest.versions[0].version_id, 'Version readback differs from deployment');
  assert(version.annotations?.['workers/tag'] === sha && version.annotations?.['workers/message'] === `commit ${sha}`, 'Deployed version metadata is not the requested commit');
  assert(bindings.some(binding => binding.name === 'CF_VERSION_METADATA' && binding.type === 'version_metadata'), 'Platform version metadata binding is absent');
  assert(bindings.some(binding => binding.name === 'CAIL_IDENTITY_JWKS' && binding.type === 'secret_text'), 'Pinned verifier secret is absent');
  assert(bindings.some(binding => binding.name === 'CAIL_IDENTITY_ISSUER' && binding.text === ISSUER), 'Issuer differs from canonical issuer');
  assert(bindings.some(binding => binding.name === 'ASSETS' && binding.type === 'assets'), 'Assets binding is absent');
  // Same-zone global fetch() to the Gateway URL reaches the zone origin (404); only this binding reaches it.
  assert(bindings.some(binding => binding.name === 'GATEWAY' && binding.type === 'service' && binding.service === 'cail-model-api'), 'GATEWAY service binding to cail-model-api is absent');
  assert(version.resources.script_runtime.compatibility_date === COMPATIBILITY_DATE, 'Unexpected runtime compatibility date');
  // Without enable_request_signal (default only from 2026-11-17) a caller abort never reaches the Gateway call.
  // `wrangler versions view` (4.130.0) reads the same GET .../versions/{id} field, resources.script_runtime
  // .compatibility_flags, and omits it when empty; absence therefore fails here, as it should.
  assert(JSON.stringify(version.resources.script_runtime.compatibility_flags) === JSON.stringify(['enable_request_signal']), 'Unexpected runtime compatibility flags');
  const subdomain = await read('/subdomain');
  assert(subdomain.enabled === false && subdomain.previews_enabled === false, 'Worker must have workers.dev and previews disabled');
  // A second read detects another deployment during verification.
  assert((await read('/deployments')).deployments[0].id === latest.id, 'Deployment changed during verification');
  return { version: version.id };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const deployed = process.argv.includes('--deployed');
  const path = process.argv.slice(2).find(argument => argument !== '--deployed') ?? 'wrangler.toml';
  const problems = verifyConfig(readFileSync(path, 'utf8'));
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`${path} passes the release check.`);
  if (deployed) {
    const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, RELEASE_SHA: sha } = process.env;
    const { version } = await verifyDeployed({ account, token, sha });
    console.log(`Private Worker control-plane readback passed: commit ${sha}, version ${version}, 100% traffic. Runtime and member acceptance remain pending.`);
  }
}
