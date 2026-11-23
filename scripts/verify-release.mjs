// Release check of wrangler.toml: the settings that keep this Worker private and binding-only.
// verifyConfig returns a list of problems, empty when the config is good. It reads only the small
// TOML subset this file uses and reports any line outside it, so an unexpected setting fails the
// check instead of passing unseen. Run directly, it checks ./wrangler.toml (or the path given).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  expect(config.name === 'cail-manuscript', 'name must be "cail-manuscript"');
  expect(config.main === 'server/worker.js', 'main must be "server/worker.js"');
  expect(config.compatibility_date === '2026-09-07', 'compatibility_date must be "2026-09-07"');
  // Without enable_request_signal (default only from 2026-11-17) a caller abort never reaches the Gateway call.
  expect(JSON.stringify(config.compatibility_flags) === '["enable_request_signal"]', 'compatibility_flags must be exactly ["enable_request_signal"]');
  // Absent means true to wrangler, so both must be written out as false.
  expect(config.workers_dev === false, 'workers_dev must be false');
  expect(config.preview_urls === false, 'preview_urls must be false');
  expect(assets.directory === './dist' && assets.binding === 'ASSETS' && assets.run_worker_first === true, '[assets] must serve ./dist through the ASSETS binding with run_worker_first = true');
  expect(vars.CAIL_IDENTITY_ISSUER === 'https://tools.ailab.gc.cuny.edu/cail-sso', 'CAIL_IDENTITY_ISSUER must be "https://tools.ailab.gc.cuny.edu/cail-sso"');
  expect(!('CAIL_IDENTITY_JWKS' in vars), 'CAIL_IDENTITY_JWKS must be a secret, not a [vars] entry');
  expect(metadata.binding === 'CF_VERSION_METADATA', '[version_metadata] must bind CF_VERSION_METADATA');
  // Same-zone global fetch() to the Gateway URL reaches the zone origin (404); only this binding reaches it.
  const gateway = (Array.isArray(services) ? services : []).filter(service => service.binding === 'GATEWAY');
  expect(gateway.length === 1 && gateway[0].service === 'cail-model-api', 'exactly one [[services]] entry must bind GATEWAY to service "cail-model-api"');
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2] ?? 'wrangler.toml';
  const problems = verifyConfig(readFileSync(path, 'utf8'));
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`${path} passes the release check.`);
}
