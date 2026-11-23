import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyConfig } from '../scripts/verify-release.mjs';

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
