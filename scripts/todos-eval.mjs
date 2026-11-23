// Measures the To-do stage against a formatting job done by hand: the comments the hand-formatted
// file carries, keyed in a private answer key. It runs the product's reader, the paragraph roles
// (gold, or the labelling stage's cached answer), the formatter, the To-do checks, the comments
// writer, the To-dos list and the companion documents on a case's source.docx, and compares the
// findings with the key: of the key's comments in each class (structure, reading, human), how many
// the tool produced (same kind, same chapter, anchored on the same paragraph or within two
// paragraphs of it), the misses by kind, and the findings that match no comment, by kind.
//
//   npm run todos-eval -- [--case <folder>] [--predicted] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all] [--key <file>] [--running-titles]
//
// A case is a folder under manuscripts/ in MANUSCRIPT_DESK_GUIDELINES (default
// ../manuscript-desk-guidelines) with source.docx, gold-roles.json and work/comments-key.json (and
// work/companions-key.json for the companion documents). The outputs (the formatted file with its
// comments, the To-dos list, the companion documents) go to the case's work/ folder. Results go to
// stdout: counts, percentages, kinds and class names. It prints no manuscript text and no comment
// wording. The rule sheet and predicted roles come from the work/ cache; the one model call it can
// make, with --running-titles, proposes running titles, uses the key in CAIL_API_KEY and is cached
// in work/running-titles.json.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addComments } from '../lib/docx/comments.js';
import { readDocx } from '../lib/docx/read.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { formatDocx } from '../lib/format/format.js';
import { compareWords, documentWords } from '../lib/format/words.js';
import { runChecks } from '../lib/checks/run.js';
import { companionDocuments } from '../lib/todos/companions.js';
import { proposeRunningTitles } from '../lib/todos/running.js';
import { fullTitle } from '../lib/todos/shared.js';
import { ruleWith } from '../lib/checks/rules.js';
import { commentsFor, todosDocument } from '../lib/todos/todos.js';
import { validateSheet } from '../lib/rules/schema.js';
import { runningTitlesPayload } from '../server/prompts.js';
import { checkGold } from './roles-eval.mjs';
import { costOf, createGatewayCall, readCatalog, table } from './generality.mjs';

const DEFAULT_FOLDER = fileURLToPath(new URL('../../manuscript-desk-guidelines', import.meta.url));
const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
export const CLASSES = ['structure', 'reading', 'human'];
// How far a finding may sit from the comment's paragraph, in paragraphs with text.
export const NEAR = 2;

const USAGE = `Usage: npm run todos-eval -- [--case <folder>] [--predicted] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all] [--key <file>] [--running-titles]

Runs the formatter and the To-do checks on manuscripts/<case>/source.docx in MANUSCRIPT_DESK_GUIDELINES
(default ../manuscript-desk-guidelines) and compares the findings with the comments of the hand-formatted
file, keyed in work/comments-key.json.
  --predicted   roles from the labelling stage (work/predicted-roles.json) instead of gold-roles.json
  --sheet       hand (work/hand-sheet.json, the default), extracted (work/extracted-sheet.json) or a sheet file
  --chapters    the comments to report: dev (the default: the dev chapters and the front matter), holdout or all
  --key         the answer key (default work/comments-key.json)
  --running-titles  propose running titles with a model (cached in work/running-titles.json; a call,
                    made only when the cache is missing, uses the key in CAIL_API_KEY, which pays for it)
Otherwise no model call is made; a missing cache is an error.`;

// ---------------------------------------------------------------------------------------------
// Matching

/** Rank of each paragraph among those with text, so distances skip empty paragraphs. */
export function ranker(paragraphs) {
  const ranks = new Map();
  let rank = 0;
  for (const entry of paragraphs) {
    if (entry.hints?.empty === false) rank += 1;
    ranks.set(entry.index, rank);
  }
  return index => ranks.get(index) ?? null;
}

/** The findings as places: one per kind and paragraph, in order. */
export function placesOf(findings) {
  const seen = new Map();
  for (const finding of findings) {
    const key = `${finding.kind}\u0000${finding.paragraphIndex}`;
    if (!seen.has(key)) seen.set(key, { kind: finding.kind, paragraphIndex: finding.paragraphIndex, count: 0 });
    seen.get(key).count += 1;
  }
  return [...seen.values()];
}

/**
 * Pairs key comments with places: same kind, same chapter, within NEAR paragraphs; each place
 * pairs with one comment at most, the nearest first.
 * @param {Array<{ id, chapter, paragraph, kind }>} comments the key's comments
 * @param {Array<{ kind, paragraphIndex }>} places
 * @param {(index: number | null) => string | null} chapterOf the key chapter of a source paragraph
 * @param {(index: number) => number | null} rankOf
 * @returns {{ matched: Map<string, object>, extra: Array<object> }}
 */
export function matchComments(comments, places, chapterOf, rankOf) {
  const candidates = [];
  comments.forEach(comment => {
    places.forEach((place, at) => {
      if (place.kind !== comment.kind || chapterOf(place.paragraphIndex) !== (comment.chapter ?? null)) return;
      let distance = 0;
      if (comment.paragraph !== null && comment.paragraph !== undefined) {
        if (place.paragraphIndex === null) return;
        distance = Math.abs(rankOf(place.paragraphIndex) - rankOf(comment.paragraph));
        if (distance > NEAR) return;
      }
      candidates.push({ comment, at, distance });
    });
  });
  candidates.sort((a, b) => a.distance - b.distance);
  const matched = new Map();
  const taken = new Set();
  for (const { comment, at } of candidates) {
    if (matched.has(comment.id) || taken.has(at)) continue;
    matched.set(comment.id, places[at]);
    taken.add(at);
  }
  return { matched, extra: places.filter((place, at) => !taken.has(at)) };
}

const bump = (counts, key, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by);
const tally = counts => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => `${key}: ${count}`).join(', ') || 'none';

// ---------------------------------------------------------------------------------------------
// Cases

async function findCase(root, name) {
  const base = path.join(root, 'manuscripts');
  if (name) return path.join(base, name);
  const folders = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  if (folders.length !== 1) throw new Error(folders.length ? `Name the case with --case (one of ${folders.length} folders).` : 'There is no case folder under manuscripts/.');
  return path.join(base, folders[0]);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`${path.basename(file)} could not be read as JSON`);
  }
}

/**
 * Running-title proposals from the model, cached in work/running-titles.json; a call is made only
 * when the cache is missing, with the key in CAIL_API_KEY. Null when no rule asks for running titles.
 */
async function runningTitles({ work, sheet, report, paragraphs, environment, err }) {
  const rule = ruleWith(sheet, { slot: 'running-title.length' });
  if (!rule) return null;
  const chapters = (report.chapters ?? []).map(chapter => ({ first: chapter.first, title: fullTitle(chapter, paragraphs) }));
  // Answers are cached by the text of the request, so a rerun pays for nothing it asked before.
  const file = path.join(work, 'running-titles.json');
  const cache = (await readJson(file))?.answers ?? {};
  let rows = null;
  let call = null;
  const usage = { prompt: 0, completion: 0, calls: 0, unmetered: 0 };
  const ask = async ({ titles, max }) => {
    const id = `${max}\u0000${titles}`;
    if (cache[id]) return cache[id];
    const key = environment.CAIL_API_KEY?.trim();
    if (!key) throw new Error('Running titles are not cached and CAIL_API_KEY is not set; set it to your CAIL Gateway key (it pays for the call).');
    rows ??= (await readCatalog()) ?? new Map();
    call ??= createGatewayCall({ key, rows, usage, payloadOf: (request, row) => runningTitlesPayload({ ...request, row }) });
    err(`${DEFAULT_MODEL}: proposing running titles (cached afterwards)`);
    const { content } = await call({ model: DEFAULT_MODEL, titles, max });
    cache[id] = content;
    await writeFile(file, JSON.stringify({ model: DEFAULT_MODEL, answers: cache }));
    return content;
  };
  const result = await proposeRunningTitles({ chapters, max: rule.params.max, call: ask });
  return { ...result, cost: usage.calls ? costOf(usage, rows?.get(DEFAULT_MODEL)) : undefined };
}

// ---------------------------------------------------------------------------------------------
// Command line

async function main(argv, environment, { out = console.log, err = console.error } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { case: { type: 'string' }, predicted: { type: 'boolean' }, sheet: { type: 'string' }, chapters: { type: 'string' }, key: { type: 'string' }, 'running-titles': { type: 'boolean' }, help: { type: 'boolean' } }, strict: true }));
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) { out(USAGE); return 0; }
  const root = environment.MANUSCRIPT_DESK_GUIDELINES ? path.resolve(environment.MANUSCRIPT_DESK_GUIDELINES) : DEFAULT_FOLDER;
  const folder = await findCase(root, values.case);
  const work = path.join(folder, 'work');
  await mkdir(work, { recursive: true });
  const gold = await readJson(path.join(folder, 'gold-roles.json'));
  const problems = gold ? checkGold(gold) : ['gold-roles.json is missing'];
  if (problems.length) { err(`Fix gold-roles.json first:\n${problems.map(problem => `  ${problem}`).join('\n')}`); return 1; }
  const key = await readJson(values.key ? path.resolve(values.key) : path.join(work, 'comments-key.json'));
  if (!Array.isArray(key?.comments)) { err('The answer key (work/comments-key.json) is missing or has no comments.'); return 1; }
  const companionsKey = await readJson(path.join(work, 'companions-key.json'));

  const source = new Uint8Array(await readFile(path.join(folder, 'source.docx')));
  const read = readDocx(source);
  if (!read.ok) { err(`The reader could not open source.docx (${read.code}).`); return 1; }
  let roles = gold.gold;
  let rolesNote = 'gold roles';
  if (values.predicted) {
    const predicted = await readJson(path.join(work, 'predicted-roles.json'));
    if (!predicted?.roles) { err('work/predicted-roles.json is missing: run npm run format-eval -- --predicted first.'); return 1; }
    roles = predicted.roles;
    rolesNote = `predicted roles (${predicted.model})`;
  }
  const sheetChoice = values.sheet ?? 'hand';
  const sheetFile = sheetChoice === 'hand' ? path.join(work, 'hand-sheet.json') : sheetChoice === 'extracted' ? path.join(work, 'extracted-sheet.json') : path.resolve(sheetChoice);
  const sheetValue = await readJson(sheetFile);
  const checked = validateSheet(sheetValue?.sheet ?? sheetValue);
  if (!checked.ok) { err(`The rule sheet is not valid (${checked.reason}).`); return 1; }
  const sheet = checked.sheet;

  // The product: format, check, comment, list, companions.
  const formatted = formatDocx({ bytes: source, roles, sheet });
  if (!formatted.ok) { err(`The formatter stopped: ${formatted.code}.`); return 1; }
  const { report } = formatted;
  const { findings, checks } = runChecks({ paragraphs: read.paragraphs, roles, report, sheet });
  const comments = commentsFor(findings, sheet);
  const commented = addComments(formatted.bytes, { map: report.map, comments });
  if (!commented.ok) { err(`The comments could not be written: ${commented.code}.`); return 1; }
  const validity = validateDocx(commented.bytes);
  const todos = todosDocument({ findings, checks, sheet, report, paragraphs: read.paragraphs });
  const todosValidity = validateDocx(todos.bytes);
  const running = values['running-titles'] ? await runningTitles({ work, sheet, report, paragraphs: read.paragraphs, environment, err }) : null;
  const companions = companionDocuments({ sheet, report, paragraphs: read.paragraphs, roles, findings, checks, proposals: running?.proposals ?? new Map() });
  const tag = `${values.predicted ? 'predicted' : 'gold'}-${sheetChoice === 'hand' || sheetChoice === 'extracted' ? sheetChoice : 'sheet'}`;
  await writeFile(path.join(work, `todos-output-${tag}.docx`), commented.bytes);
  await writeFile(path.join(work, `todos-list-${tag}.docx`), todos.bytes);
  for (const companion of companions) await writeFile(path.join(work, `todos-companion-${companion.name.replace(/[^A-Za-z]+/gu, '-').replace(/-+$/u, '').toLowerCase()}-${tag}.docx`), companion.bytes);
  const words = (() => {
    const before = readPackage(source);
    const after = readPackage(commented.bytes);
    return compareWords(documentWords(before.files, before.main), documentWords(after.files, after.main), report.declared);
  })();

  // Matching.
  const chapterOf = index => (index === null || index === undefined ? null : gold.chapters.find(chapter => index >= chapter.first && index <= chapter.last)?.key ?? null);
  const rankOf = ranker(read.paragraphs);
  const places = placesOf(findings);
  const { matched, extra } = matchComments(key.comments, places, chapterOf, rankOf);
  const split = chapter => (chapter === null ? 'front' : gold.dev.includes(chapter) ? 'dev' : gold.holdout.includes(chapter) ? 'holdout' : '-');
  const which = values.chapters ?? 'dev';
  if (!['dev', 'holdout', 'all'].includes(which)) { err('--chapters is dev, holdout or all.'); return 1; }
  // What this run reports: the dev chapters with the front matter, the holdout chapters, or all.
  const shown = chapter => which === 'all' || (which === 'dev' ? ['dev', 'front'].includes(split(chapter)) : split(chapter) === 'holdout');
  const groups = [
    ['Front matter', comment => comment.chapter === null],
    ...gold.chapters.map(chapter => [`${chapter.key} (${split(chapter.key)})`, comment => comment.chapter === chapter.key]),
    ['Dev', comment => split(comment.chapter) === 'dev'],
    ['Holdout', comment => split(comment.chapter) === 'holdout'],
    ['Total', () => true],
  ].filter(([name, test]) => (name === 'Total' ? which === 'all' : name === 'Dev' ? which !== 'holdout' : name === 'Holdout' ? which !== 'dev' : name === 'Front matter' ? which !== 'holdout' : shown(gold.chapters.find(chapter => test({ chapter: chapter.key }))?.key ?? null)));
  const extraIn = test => extra.filter(place => test({ chapter: chapterOf(place.paragraphIndex) })).length;
  const rows = groups.map(([name, test]) => {
    const inGroup = key.comments.filter(test);
    const cell = cls => { const list = inGroup.filter(comment => comment.class === cls); return list.length ? `${list.filter(comment => matched.has(comment.id)).length}/${list.length}` : '-'; };
    return [name, inGroup.length, cell('structure'), cell('reading'), cell('human'), extraIn(test)];
  });

  out(`\nTo-dos with ${rolesNote} and the ${sheetChoice === 'hand' || sheetChoice === 'extracted' ? sheetChoice : 'given'} rule sheet (${sheet.rules.length} rules); key of ${key.comments.length} comments; reporting ${which === 'dev' ? 'the dev chapters and the front matter' : which === 'holdout' ? 'the holdout chapters' : 'all chapters'}.`);
  out(`Checks run: ${checks.filter(check => check.ran).length} of ${checks.length}; findings ${findings.length} at ${places.length} places (kind and paragraph).`);
  out(table(['Chapter', 'Comments', 'Structure produced', 'Reading produced', 'Human produced', 'Extra places'], rows));
  for (const cls of CLASSES) {
    const missed = new Map();
    const produced = new Map();
    for (const comment of key.comments.filter(entry => entry.class === cls && shown(entry.chapter))) bump(matched.has(comment.id) ? produced : missed, `${comment.kind} (${split(comment.chapter)})`);
    out(`${cls}: produced ${tally(produced)}; missed ${tally(missed)}.`);
  }
  const extraKinds = new Map();
  for (const place of extra.filter(entry => shown(chapterOf(entry.paragraphIndex)))) bump(extraKinds, `${place.kind} (${split(chapterOf(place.paragraphIndex))})`);
  out(`Extra places by kind: ${tally(extraKinds)}.`);
  out(`Checks not run: ${checks.filter(check => !check.ran).map(check => check.id).join(', ') || 'none'}.`);

  // Companion documents.
  out('Companion documents:');
  const byName = new Map(companions.map(companion => [companion.name, companion]));
  const keyOfStart = first => chapterOf(first);
  const abstracts = [...byName.values()].find(companion => companion.name.startsWith('Abstracts'));
  if (abstracts) {
    const listedChapters = abstracts.entries.map(entry => keyOfStart(entry.chapter));
    const withAbstract = abstracts.entries.filter(entry => entry.abstract).map(entry => keyOfStart(entry.chapter));
    const expected = companionsKey?.abstracts;
    const same = (a, b) => (b ? (a.length === b.length && a.every(item => b.includes(item)) ? 'same' : `differs (${a.filter(item => !b.includes(item)).length} extra, ${b.filter(item => !a.includes(item)).length} missing)`) : 'no key');
    out(`  abstracts and keywords: produced; ${listedChapters.length} chapters listed (reference ${expected?.chapters.length ?? '?'}: ${same(listedChapters, expected?.chapters)}); abstracts present for ${withAbstract.length} (reference ${expected?.withAbstract.length ?? '?'}: ${same(withAbstract, expected?.withAbstract)}); keywords present for ${abstracts.entries.filter(entry => entry.keywords).length}.`);
  } else out('  abstracts and keywords: not produced (no rule asks for them).');
  const alt = [...byName.values()].find(companion => companion.name.startsWith('Alt'));
  if (alt) {
    const perChapter = new Map();
    for (const entry of alt.entries) bump(perChapter, chapterOf(entry.index) ?? 'none');
    const expected = companionsKey?.altTexts;
    const sameChapters = expected ? Object.entries(expected.byChapter).every(([chapter, count]) => perChapter.get(chapter) === count) && perChapter.size === Object.keys(expected.byChapter).length : null;
    out(`  alt texts: produced; ${alt.entries.length} figures (reference ${expected?.figures ?? '?'}), by chapter ${tally(perChapter)}${sameChapters === null ? '' : sameChapters ? ', same chapters as the reference' : ', chapters differ from the reference'}.`);
  } else out('  alt texts: not produced (no rule asks for them).');
  const titles = [...byName.values()].find(companion => companion.name.startsWith('Running'));
  if (titles) {
    const listedChapters = titles.entries.map(entry => keyOfStart(entry.chapter));
    const expected = companionsKey?.runningTitles?.chapters;
    const proposals = new Map();
    for (const entry of titles.entries) bump(proposals, entry.source ?? 'blank');
    out(`  running titles: produced (${titles.name.includes('proposals') ? 'proposals' : 'template'}); ${listedChapters.length} chapters listed (reference ${expected?.length ?? '?'}${expected ? `, ${listedChapters.every(item => expected.includes(item)) && listedChapters.length === expected.length ? 'same' : 'differ'}` : ''}); proposals ${tally(proposals)}${running ? `; model proposals kept ${running.proposals.size} after ${running.calls} ${running.calls === 1 ? 'call' : 'calls'}, dropped ${running.dropped.length}${running.dropped.length ? ` (${tally(new Map(running.dropped.map(entry => [entry.reason, running.dropped.filter(other => other.reason === entry.reason).length])))})` : ''}${running.cost === undefined ? ' (cached)' : `, cost ${running.cost === null ? 'unknown' : `$${running.cost.toFixed(4)}`}`}` : ''}.`);
  } else out('  running titles: not produced (no rule asks for them).');
  const checklist = byName.get('Checklist');
  if (checklist) out(`  checklist: produced; ${checklist.entries.length} requirements (reference ${companionsKey?.checklist?.rows ?? '?'} rows); status ${tally(new Map(Object.entries(checklist.tally)))}.`);
  else out('  checklist: not produced (the sheet has no rules).');
  out(`To-dos list: ${todos.counts.items} items in ${todos.counts.chapters} chapters, ${todos.counts.toSupply} to supply, ${todos.counts.notChecked} rules not checked; ${todosValidity.ok ? 'valid' : 'INVALID'}.`);
  out(`Output: ${validity.ok ? 'valid' : `INVALID (${validity.problems.map(problem => `${problem.code} in ${problem.part} x${problem.count}`).join(', ')})`}; ${validity.counts.comments} comments written (${commented.unplaced} could not be placed); word check: undeclared removed ${words.undeclaredRemoved}, added ${words.undeclaredAdded}.`);
  out(`Outputs written to the case's work/ folder with the tag ${tag}.`);
  return validity.ok && todosValidity.ok && !words.undeclaredRemoved && !words.undeclaredAdded ? 0 : 2;
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
