// Measures how well paragraph roles come out of a real manuscript with a real model. It runs the
// product's own reader (readDocx), passages and labelling run (labelRoles) and the payload POST
// /api/roles sends, calling the CAIL Gateway with the caller's own key, and scores the roles against
// a case's hand-set gold roles.
//
//   CAIL_API_KEY=... npm run roles-eval -- [--case <folder>] [--model <id>] [--chapters dev|holdout|all|<key,key>]
//
// A case is a folder under manuscripts/ in MANUSCRIPT_DESK_GUIDELINES (default
// ../manuscript-desk-guidelines) holding source.docx and gold-roles.json. Results go to stdout only:
// counts, accuracies, role names, confusion tallies, tokens and cost. It never prints manuscript
// text, writes nothing to disk and never prints the key.

import { readdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readDocx } from '../lib/docx/read.js';
import { labelRoles } from '../lib/roles/label.js';
import { ROLE_IDS, STRUCTURAL } from '../lib/roles/roles.js';
import { rolesPayload } from '../server/prompts.js';
import { costOf, createGatewayCall, readCatalog, table } from './generality.mjs';

const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
const DEFAULT_FOLDER = fileURLToPath(new URL('../../manuscript-desk-guidelines', import.meta.url));
// Paragraphs before a measured chapter that are labelled too (and not scored), so the chapter does
// not begin exactly where a passage begins, as it would not in a whole manuscript.
const LEAD = 10;

const USAGE = `Usage: npm run roles-eval -- [--case <folder>] [--model <id>] [--chapters dev|holdout|all|<key,key>]

Reads manuscripts/<folder>/source.docx and gold-roles.json in MANUSCRIPT_DESK_GUIDELINES (default
../manuscript-desk-guidelines) and calls the CAIL Gateway with the key in CAIL_API_KEY, which pays for
every call.
  --case      the case folder under manuscripts/ (needed when there is more than one)
  --model     model id (default ${DEFAULT_MODEL})
  --chapters  dev, holdout, all (default dev), or chapter keys separated by commas`;

const isText = value => typeof value === 'string' && value.trim() !== '';

/** The problems of a gold-roles.json, as short descriptions (empty when it is valid). */
export function checkGold(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['must be a JSON object'];
  const problems = [];
  if (!Array.isArray(value.roles) || !value.roles.every(isText)) problems.push('roles must be a list of role names');
  else {
    const unknown = value.roles.filter(role => !ROLE_IDS.includes(role));
    if (unknown.length) problems.push(`roles names roles this tool does not have: ${unknown.join(', ')}`);
  }
  if (typeof value.gold !== 'object' || value.gold === null || Array.isArray(value.gold)) problems.push('gold must map paragraph indices to roles');
  else if (!Object.entries(value.gold).every(([key, role]) => /^\d+$/.test(key) && ROLE_IDS.includes(role))) problems.push('gold must map paragraph indices to known roles');
  if (!Array.isArray(value.chapters) || !value.chapters.every(chapter => isText(chapter?.key) && Number.isInteger(chapter.first) && Number.isInteger(chapter.last) && chapter.first <= chapter.last)) problems.push('chapters must list { key, first, last }');
  for (const split of ['dev', 'holdout']) if (!Array.isArray(value[split]) || !value[split].every(isText)) problems.push(`${split} must be a list of chapter keys`);
  return problems;
}

/** The chapters to measure for a --chapters value, or an error message. */
export function selectChapters(gold, which = 'dev') {
  const keys = which === 'dev' || which === 'holdout' ? gold[which] : which === 'all' ? gold.chapters.map(chapter => chapter.key) : which.split(',').map(key => key.trim()).filter(Boolean);
  const byKey = new Map(gold.chapters.map(chapter => [chapter.key, chapter]));
  const unknown = keys.filter(key => !byKey.has(key));
  if (unknown.length || keys.length === 0) return { error: `Unknown chapters: ${unknown.join(', ') || '(none named)'}. Use dev, holdout, all, or keys from gold-roles.json.` };
  return { chapters: keys.map(key => byKey.get(key)) };
}

/** The spans of paragraph indices to label: each chapter with LEAD paragraphs before it, merged. */
export function spansFor(chapters, lead = LEAD) {
  const spans = chapters.map(chapter => [Math.max(0, chapter.first - lead), chapter.last]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/**
 * The score of predicted roles against the gold roles over some chapters. Only gold paragraphs that
 * the reader finds non-empty are scored; a paragraph with no predicted role counts as wrong.
 * @returns {{ scored, correct, structural, structuralCorrect, bodyAsStructural, confusions: Map<string, number> }}
 */
export function scoreRoles({ gold, predicted, paragraphs, chapters }) {
  const score = { scored: 0, correct: 0, structural: 0, structuralCorrect: 0, bodyAsStructural: 0, emptySkipped: 0, confusions: new Map() };
  for (const chapter of chapters) {
    for (let index = chapter.first; index <= chapter.last; index += 1) {
      const want = gold[index];
      if (want === undefined) continue;
      if (!paragraphs[index] || paragraphs[index].hints.empty) { score.emptySkipped += 1; continue; }
      const got = predicted[index] ?? '(none)';
      score.scored += 1;
      if (got === want) score.correct += 1;
      else score.confusions.set(`${want}->${got}`, (score.confusions.get(`${want}->${got}`) ?? 0) + 1);
      if (STRUCTURAL.has(want)) {
        score.structural += 1;
        if (got === want) score.structuralCorrect += 1;
      }
      if (want === 'body' && STRUCTURAL.has(got)) score.bodyAsStructural += 1;
    }
  }
  return score;
}

function addScores(scores) {
  const total = { scored: 0, correct: 0, structural: 0, structuralCorrect: 0, bodyAsStructural: 0, emptySkipped: 0, confusions: new Map() };
  for (const score of scores) {
    for (const field of ['scored', 'correct', 'structural', 'structuralCorrect', 'bodyAsStructural', 'emptySkipped']) total[field] += score[field];
    for (const [pair, count] of score.confusions) total.confusions.set(pair, (total.confusions.get(pair) ?? 0) + count);
  }
  return total;
}

const percent = (part, of) => (of > 0 ? `${((part / of) * 100).toFixed(1)}%` : '-');
const row = (name, score) => [name, score.scored, percent(score.correct, score.scored), `${score.structuralCorrect}/${score.structural}`, percent(score.structuralCorrect, score.structural), score.bodyAsStructural];

// The single case folder under manuscripts/, or the one named.
async function findCase(root, name) {
  const base = path.join(root, 'manuscripts');
  if (name) return path.join(base, name);
  const folders = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  if (folders.length !== 1) throw new Error(folders.length ? `Name the case with --case (one of ${folders.length} folders).` : 'There is no case folder under manuscripts/.');
  return path.join(base, folders[0]);
}

async function main(argv, environment, { out = console.log, err = console.error } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { case: { type: 'string' }, model: { type: 'string' }, chapters: { type: 'string' }, help: { type: 'boolean' } }, strict: true }));
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const key = environment.CAIL_API_KEY?.trim();
  if (!key) {
    err('CAIL_API_KEY is not set. Set it to your CAIL Gateway API key; every model call is charged to that key.');
    return 1;
  }
  const model = values.model ?? DEFAULT_MODEL;
  const root = environment.MANUSCRIPT_DESK_GUIDELINES ? path.resolve(environment.MANUSCRIPT_DESK_GUIDELINES) : DEFAULT_FOLDER;
  let folder, gold, bytes;
  try {
    folder = await findCase(root, values.case);
    gold = JSON.parse(await readFile(path.join(folder, 'gold-roles.json'), 'utf8'));
    bytes = new Uint8Array(await readFile(path.join(folder, 'source.docx')));
  } catch (error) {
    // Only a generic reason: a JSON error message can quote the file.
    const reason = error?.code === 'ENOENT' ? 'a file or folder is missing' : error instanceof SyntaxError ? 'gold-roles.json is not valid JSON' : error?.message?.startsWith('Name the case') || error?.message?.startsWith('There is no case') ? error.message : 'a file could not be read';
    err(`Cannot read the case: ${reason}. Set MANUSCRIPT_DESK_GUIDELINES to the guidelines folder.`);
    return 1;
  }
  const problems = checkGold(gold);
  if (problems.length) {
    err(`Fix gold-roles.json first (no model was called):\n${problems.map(problem => `  ${problem}`).join('\n')}`);
    return 1;
  }
  const selected = selectChapters(gold, values.chapters ?? 'dev');
  if (selected.error) {
    err(selected.error);
    return 1;
  }
  const read = readDocx(bytes);
  if (!read.ok) {
    err(`The reader could not open source.docx (${read.code}).`);
    return 1;
  }
  const { paragraphs } = read;

  const rows = await readCatalog();
  if (!rows) out('The model catalog could not be read: calls go without model controls and cost is unknown.');
  else if (!rows.has(model)) out(`${model} is not in the model catalog: calls go without its model controls and cost is unknown.`);
  const usage = { prompt: 0, completion: 0, calls: 0, unmetered: 0 };
  const callRoles = createGatewayCall({ key, rows: rows ?? new Map(), usage, payloadOf: ({ model: id, passage }, row) => rolesPayload({ model: id, passage, row }) });

  const predicted = {};
  const failures = [];
  const start = performance.now();
  for (const [from, to] of spansFor(selected.chapters)) {
    err(`${model}: labelling paragraphs ${from} to ${to}`);
    const result = await labelRoles({ paragraphs: paragraphs.slice(from, to + 1), model, callRoles, passageOptions: { total: paragraphs.length } });
    Object.assign(predicted, result.roles);
    failures.push(...result.failures);
  }
  const seconds = (performance.now() - start) / 1000;

  const goldRoles = gold.gold;
  const perChapter = selected.chapters.map(chapter => ({ chapter, score: scoreRoles({ gold: goldRoles, predicted, paragraphs, chapters: [chapter] }) }));
  const split = chapter => (gold.dev.includes(chapter.key) ? 'dev' : gold.holdout.includes(chapter.key) ? 'holdout' : '-');
  const tableRows = perChapter.map(({ chapter, score }) => [`${chapter.key} (${split(chapter)})`, ...row('', score).slice(1)]);
  const dev = perChapter.filter(({ chapter }) => split(chapter) === 'dev').map(({ score }) => score);
  const holdout = perChapter.filter(({ chapter }) => split(chapter) === 'holdout').map(({ score }) => score);
  const total = addScores(perChapter.map(({ score }) => score));
  if (dev.length) tableRows.push(row('Dev', addScores(dev)));
  if (holdout.length) tableRows.push(row('Holdout', addScores(holdout)));
  tableRows.push(row('Total', total));

  out(`\nModel ${model}, chapters ${values.chapters ?? 'dev'}`);
  out(table(['Chapter', 'Scored', 'Accuracy', 'Structural', 'Struct. acc.', 'Body as structural'], tableRows));
  out(`Empty gold paragraphs not scored: ${total.emptySkipped}.`);
  const confusions = [...total.confusions].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  out(`Confusions (gold->predicted: count), ${confusions.reduce((sum, [, count]) => sum + count, 0)} in all:`);
  for (const [pair, count] of confusions) out(`  ${pair}: ${count}`);
  for (const { chapter, score } of perChapter) {
    if (score.confusions.size) out(`  in ${chapter.key}: ${[...score.confusions].sort((a, b) => b[1] - a[1]).map(([pair, count]) => `${pair} ${count}`).join(', ')}`);
  }
  if (failures.length) {
    const codes = failures.reduce((counts, failure) => ({ ...counts, [failure.code]: (counts[failure.code] ?? 0) + 1 }), {});
    out(`Failed or incomplete passages: ${Object.entries(codes).map(([code, count]) => `${code} x${count}`).join(', ')}; ${failures.reduce((sum, failure) => sum + failure.unlabelled.length, 0)} paragraphs left unlabelled.`);
  }
  const cost = costOf(usage, rows?.get(model));
  const costText = cost === null ? 'unknown' : `${usage.unmetered ? 'at least ' : ''}$${cost.toFixed(4)}`;
  out(`Tokens: ${usage.prompt} in, ${usage.completion} out, over ${usage.calls} calls${usage.unmetered ? ` (${usage.unmetered} replies without token counts)` : ''}, ${seconds.toFixed(0)} s. Cost: ${costText}.`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    code => { process.exitCode = code; },
    error => {
      console.error(`The run stopped: ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
