import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';

// Runs the release job's secrets-file step exactly as written in the workflow.
const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
const program = workflow.match(/node --input-type=module -e '([^']+)'/)[1];
const { jwksJson } = await createTestIdentityIssuer();
async function secretsFile(extra) {
  const directory = await mkdtemp(join(tmpdir(), 'manuscript-release-'));
  const file = join(directory, 'secrets.json');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', env: { PATH: process.env.PATH, CAIL_IDENTITY_JWKS: jwksJson, RELEASE_SECRETS_FILE: file, ...extra } });
    const written = await readFile(file, 'utf8').catch(() => null);
    if (result.status !== 0) return { error: result.stderr, written };
    return { secrets: JSON.parse(written), mode: (await stat(file)).mode & 0o777 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('the release writes the pinned verifier key set, and only it, to a private secrets file', async () => {
  const { secrets, mode, error } = await secretsFile({});
  assert.equal(error, undefined);
  assert.deepEqual(Object.keys(secrets), ['CAIL_IDENTITY_JWKS']);
  assert.equal(secrets.CAIL_IDENTITY_JWKS, jwksJson);
  assert.equal(mode, 0o600);
});

test('the release refuses an identity configuration that does not verify both audiences, before anything is written', async () => {
  // The program checks the key set for this tool's audience and the Gateway's.
  assert.match(program, /for\(const expectedAudience of \["cail:manuscript","cail:gateway"\]\)/);
  const NOT_A_KEY_SET = '{"keys":[{"kty":"oct","k":"c2VjcmV0"}]}';
  for (const jwks of ['', '   ', 'not json', '{"keys":[]}', NOT_A_KEY_SET]) {
    const { error, written } = await secretsFile({ CAIL_IDENTITY_JWKS: jwks });
    assert.match(error, /Invalid release identity configuration/, JSON.stringify(jwks));
    assert.equal(written, null, 'no secrets file');
    if (jwks.trim()) assert.ok(!error.includes(jwks), 'the value is never printed');
  }
  const { error } = await secretsFile({ CAIL_IDENTITY_JWKS: undefined });
  assert.match(error, /Invalid release identity configuration/);
});

test('the release job deploys only the checked current main, privately, then reads it back', () => {
  const release = workflow.slice(workflow.indexOf('\n  release:\n'));
  assert.ok(release.length > 1 && workflow.indexOf('\n  check:\n') < workflow.indexOf('\n  release:\n'));
  for (const line of [
    "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    'needs: check',
    'environment: production',
    'cancel-in-progress: false',
    'RELEASE_SHA: ${{ inputs.sha }}',
    'test "$RELEASE_SHA" = "$GITHUB_SHA"',
    'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    'CAIL_IDENTITY_JWKS: ${{ secrets.CAIL_IDENTITY_JWKS }}',
    "trap 'rm -f \"$RELEASE_SECRETS_FILE\"' EXIT",
    'npx wrangler deploy --strict --tag "$RELEASE_SHA" --message "commit $RELEASE_SHA" --secrets-file "$RELEASE_SECRETS_FILE"',
    'node scripts/verify-release.mjs --deployed',
  ]) assert.ok(release.includes(line), `the release job has: ${line}`);
  // Main is read before the build, before the deploy and after the readback, so a newer commit stops it.
  assert.equal(release.split('test "$RELEASE_SHA" = "$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)"').length - 1, 3);
  const order = ['Reject stale or unchecked release', 'npm run build', '--input-type=module', 'npx wrangler deploy --strict', 'node scripts/verify-release.mjs --deployed'].map(step => release.indexOf(step));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'stale check, build, identity check, deploy, readback, in that order');
  assert.deepEqual([...new Set([...workflow.matchAll(/\$\{\{ secrets\.(\w+) \}\}/g)].map(match => match[1]))], ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CAIL_IDENTITY_JWKS'], 'no other secret is used');
  // Every action is pinned to a full commit, the same in both jobs.
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  assert.ok(uses.length === 4 && uses.every(use => /@[0-9a-f]{40}$/.test(use)));
  assert.deepEqual(uses.slice(0, 2), uses.slice(2));
});
