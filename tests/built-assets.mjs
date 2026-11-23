// dist/ as `npm run build` writes it, built here only when it is missing. Test files run in parallel
// processes, and a build first empties dist/, so only one process builds at a time: the others wait
// for it (up to two minutes) and then use what it wrote.
import { access, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PAGE = resolve('dist/format/index.html');
const LOCK = join(tmpdir(), `manuscript-desk-build-${createHash('sha256').update(resolve('.')).digest('hex').slice(0, 16)}`);

export async function builtAssets() {
  try {
    await access(PAGE);
    return resolve('dist');
  } catch {}
  try {
    await mkdir(LOCK);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    for (let waited = 0; waited < 120000; waited += 250) {
      await sleep(250);
      try { await access(LOCK); } catch { break; }
    }
    await access(PAGE);
    return resolve('dist');
  }
  try {
    await promisify(execFile)(process.execPath, ['scripts/build.mjs']);
  } finally {
    await rm(LOCK, { recursive: true, force: true });
  }
  await access(PAGE);
  return resolve('dist');
}
