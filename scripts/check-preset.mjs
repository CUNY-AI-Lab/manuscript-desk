// Re-verifies a built-in rule sheet against the pages it quotes: fetches each source page again,
// reads its text as the generality script does (HTML or PDF), and reports every quotation that is
// no longer found there, so a changed requirement is noticed. Needs the network, so it is not part
// of `npm run check`. Prints rule ids and counts only (the quotations are in the repository already).
//
//   node scripts/check-preset.mjs [<preset id>]

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRESETS } from '../lib/presets/index.js';
import { findQuote } from '../lib/rules/quote.js';
import { readCaseFile } from './generality.mjs';

const TIMEOUT_MS = 30000;
// A plain browser identity: some library sites refuse requests without one.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

async function pageText(url, folder, at) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return { ok: false, why: `HTTP ${response.status}` };
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const file = path.join(folder, `source-${at}${pdf ? '.pdf' : '.html'}`);
  await writeFile(file, bytes);
  const read = await readCaseFile(file);
  return read.ok ? { ok: true, text: read.text } : { ok: false, why: read.code };
}

async function main(argv) {
  const only = argv[0];
  const presets = PRESETS.filter(preset => !only || preset.id === only);
  if (!presets.length) { console.error(`No built-in set ${only}. Known: ${PRESETS.map(preset => preset.id).join(', ')}`); return 1; }
  let missing = 0;
  const folder = await mkdtemp(path.join(tmpdir(), 'check-preset-'));
  try {
    for (const preset of presets) {
      console.log(`${preset.name} (${preset.id}), read ${preset.retrieved}: ${preset.sheet.rules.length} rules`);
      const texts = [];
      for (const [at, url] of preset.sources.entries()) {
        let result;
        try {
          result = await pageText(url, folder, at);
        } catch (error) {
          result = { ok: false, why: error?.name === 'TimeoutError' ? 'timed out' : 'could not be fetched' };
        }
        texts.push(result.ok ? result.text : null);
        console.log(`  [${at}] ${url}: ${result.ok ? `${result.text.length} characters` : `NOT READ (${result.why})`}`);
      }
      for (const rule of preset.sheet.rules) {
        const text = texts[rule.source.doc];
        if (text === null) { missing += 1; console.log(`  ${rule.id}: not checked, its page could not be read`); continue; }
        if (!findQuote(rule.source.quote, text)) { missing += 1; console.log(`  ${rule.id}: quotation NOT FOUND on page ${rule.source.doc}`); }
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  console.log(missing ? `${missing} quotation(s) not confirmed: read the pages again and update the set.` : 'Every quotation was found on its page.');
  return missing ? 1 : 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`The check stopped: ${error?.message ?? error}`); process.exitCode = 1; });
