// Counts everything the product hands back to the author on a case, as the Formatter page would
// (its own labels and rule sheet, the reading check on every chapter), and sorts the questions into
// the classes of docs/eval/model-bakeoff.md: (a) the hand job simply did it, (b) a sensible default
// answers it when the guidelines are silent, (c) a duplicate or noise, (d) a real author decision.
// The class is set per place (classOf below, a judgment written down from the hand job's
// method), split where the answer key says the hand job asked the same thing at the same place.
// Prints counts only; the findings with their messages go to the case's private work/ folder.
//
//   node scripts/spikes/agent/questions.mjs [--roles <file>] [--sheet <file>] [--no-reading]

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { matchComments, placesOf, ranker } from '../../todos-eval.mjs';
import { checkedSheet, readJson, runPipeline } from './pipeline.mjs';
import { caseFolder } from '../gateway.mjs';
import { table } from '../../generality.mjs';

// The class of a place (a kind of finding at a paragraph), a judgment written down from the hand
// job's method (its working notes and its build spec), not a measurement:
//   hand: the hand job left a comment of the same kind at the same place (a report or a question);
//   a: the hand job simply did it (rebuilt the contents list from the chapters, split and retyped
//      titles, joined the pasted quotation lines and said so once, replaced the repeated-author
//      dashes, deleted the duplicated translation, fixed an obvious name typo);
//   b: a sensible default settles it (one way of joining two authors' names, a tolerance on "about
//      200 words");
//   c: noise or a repeat;
//   d: a real author decision or a missing item;
//   d-copyedit: a possible slip in the authors' text that the reading check queried; real or not,
//      it is the copyeditor's (the hand job flagged such slips at most once per chapter).
const READING_KINDS = new Set(['typo', 'missing-spaces', 'wording-inconsistent', 'affiliation-inconsistent', 'stray-or-duplicated-text']);
export function classOf(place, messages) {
  const text = messages.join(' ');
  switch (place.kind) {
    case 'formatting-summary': return 'report';
    case 'chapter-title': return /divided at its colon|typed in capital/u.test(text) ? 'a' : 'd';
    case 'contents-mismatch': case 'quotation-lines-joined': case 'repeated-author-dash': return 'a';
    case 'authors-joined-differently': case 'abstract-length': return 'b';
    case 'contributor-bio': return /gives the name as/u.test(text) ? 'a' : /words; the guidelines ask/u.test(text) ? 'b' : 'd';
    case 'stray-or-duplicated-text': return /appears twice|duplicate/u.test(text) ? 'a' : 'd-copyedit';
    default: return READING_KINDS.has(place.kind) ? 'd-copyedit' : 'd';
  }
}
export const CLASSES = ['hand', 'a', 'b', 'c', 'd', 'd-copyedit', 'report'];

async function main() {
  const { values } = parseArgs({ options: { roles: { type: 'string' }, sheet: { type: 'string' }, 'no-reading': { type: 'boolean' }, case: { type: 'string' } } });
  const folder = await caseFolder(values.case);
  const work = path.join(folder, 'work');
  const gold = await readJson(path.join(folder, 'gold-roles.json'));
  const key = await readJson(path.join(work, 'comments-key.json'));
  const source = new Uint8Array(await readFile(path.join(folder, 'source.docx')));
  const roles = (await readJson(values.roles ? path.resolve(values.roles) : path.join(work, 'page-run-6', 'roles.json'))).roles;
  const sheet = checkedSheet(await readJson(values.sheet ? path.resolve(values.sheet) : path.join(work, 'page-run-6', 'rule-sheet.json')));
  const run = await runPipeline({ source, roles, sheet, work, reading: !values['no-reading'] });
  const report = summarize({ run, gold, key, sheet });
  await writeFile(path.join(work, 'bakeoff-questions.json'), JSON.stringify(report.privateRows, null, 1));
  print(report);
}

/** Counts and classes; `privateRows` holds the messages and must stay in the private folder. */
export function summarize({ run, gold, key, sheet }) {
  const chapterOf = index => (index === null || index === undefined ? null : gold.chapters.find(chapter => index >= chapter.first && index <= chapter.last)?.key ?? null);
  const rankOf = ranker(run.read.paragraphs);
  const places = placesOf(run.findings);
  const { matched } = matchComments(key.comments, places, chapterOf, rankOf);
  const askedThere = new Set([...matched.values()].map(place => `${place.kind}\u0000${place.paragraphIndex}`));
  const rows = places.map(place => {
    const there = askedThere.has(`${place.kind}\u0000${place.paragraphIndex}`);
    const messages = run.findings.filter(finding => finding.kind === place.kind && (finding.paragraphIndex ?? null) === (place.paragraphIndex ?? null)).map(finding => finding.message ?? '');
    const cls = place.kind === 'formatting-summary' ? 'report' : there ? 'hand' : classOf(place, messages);
    return { ...place, chapter: chapterOf(place.paragraphIndex), matchedKey: there, cls };
  });
  const byKind = new Map();
  for (const row of rows) {
    const entry = byKind.get(row.kind) ?? { places: 0, findings: 0, matched: 0, classes: {} };
    entry.places += 1; entry.findings += row.count; entry.matched += row.matchedKey ? 1 : 0; entry.classes[row.cls] = (entry.classes[row.cls] ?? 0) + 1;
    byKind.set(row.kind, entry);
  }
  const statusCounts = run.statuses.reduce((counts, entry) => ({ ...counts, [entry.status]: (counts[entry.status] ?? 0) + 1 }), {});
  const privateRows = { places: rows, findings: run.findings.map(finding => ({ kind: finding.kind, paragraph: finding.paragraphIndex ?? null, chapter: chapterOf(finding.paragraphIndex), check: finding.check ?? null, message: finding.message })), supply: run.supply.map(rule => ({ id: rule.id, category: rule.category, statement: rule.statement })), statuses: run.statuses.map(entry => ({ id: entry.rule?.id ?? entry.id, status: entry.status })) };
  return { rows, byKind, comments: run.comments.length, todos: run.todosCounts, supply: run.supply.length, statusCounts, rules: sheet.rules.length, key: key.comments.length, keyMatched: matched.size, reading: run.readingRun, privateRows };
}

export function print(report, out = console.log) {
  out(`Comments in the formatted file (one per place): ${report.comments}. Hand job: ${report.key}.`);
  out(`To-dos list: ${report.todos.items} items in ${report.todos.chapters} chapters, ${report.todos.toSupply} requirements to supply, ${report.todos.notChecked} rules not checked.`);
  out(`Checklist: ${report.rules} rules; by status ${Object.entries(report.statusCounts).map(([status, count]) => `${status} ${count}`).join(', ')}.`);
  if (report.reading) out(`Reading check: ${report.reading.units} units, ${report.reading.missing} not cached.`);
  out(`Of the hand job's ${report.key} comments, the product asked ${report.keyMatched} at the same place (same kind, within two paragraphs).`);
  const kinds = [...report.byKind].sort((a, b) => b[1].places - a[1].places);
  out(table(['Kind', 'Places', 'Findings', ...CLASSES], kinds.map(([kind, entry]) => [kind, entry.places, entry.findings, ...CLASSES.map(cls => entry.classes[cls] ?? 0)])));
  const total = cls => report.rows.filter(row => row.cls === cls).length;
  out(`Places by class: ${CLASSES.map(cls => `${cls} ${total(cls)}`).join(', ')}; of ${report.rows.length}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(`The run stopped: ${error?.message ?? error}`); process.exitCode = 1; });
