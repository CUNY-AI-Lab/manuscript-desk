// The Formatter page, step 6: formatting the manuscript in this browser and what is offered for
// download. buildOutputs runs the formatter, the To-do checks, the comments writer, the To-dos list
// and the companion documents the rule sheet calls for, all on bytes held in memory, and asks the
// model for running titles (through the injected `proposeTitles`) only when a rule asks for them,
// and, when the scholar chose it, for the reading check of each chapter's opening (through the
// injected `readText`), whose verified findings become comments and To-dos entries. Every file it
// offers has passed the structural validator. Pure apart from those injected calls, so it loads and
// is tested under Node; output-step.js draws its result.

import { addComments } from '../../lib/docx/comments.js';
import { validateDocx } from '../../lib/docx/validate.js';
import { formatDocx } from '../../lib/format/format.js';
import { runChecks } from '../../lib/checks/run.js';
import { readChapters, readingFindings, readingUnits } from '../../lib/checks/reading.js';
import { planFormatting, settingsFrom } from '../../lib/format/plan.js';
import { ruleWith } from '../../lib/checks/rules.js';
import { changeLines } from '../../lib/checks/summary.js';
import { companionDocuments } from '../../lib/todos/companions.js';
import { proposeRunningTitles } from '../../lib/todos/running.js';
import { fullTitle, kindLabel } from '../../lib/todos/shared.js';
import { commentsFor, todosDocument, toSupply } from '../../lib/todos/todos.js';

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const GENERAL_FAILURE = 'The manuscript could not be formatted. Try again; if it happens again, open the file in Word, save it as a new .docx file and choose that one.';
const NOT_VALID = 'The formatted file did not pass the tool\'s own check of a Word file, so it is not offered: Word might report it as damaged. Nothing was downloaded. Please let the CUNY AI Lab know.';

// What each companion document is, in plain words, by the name the library gives it.
const COMPANION_LABELS = {
  'Abstracts and Keywords': 'Abstracts and keywords, chapter by chapter',
  'Alt Texts (template)': 'Alt texts: a template with every figure, to fill in',
  'Running Titles (proposals)': 'Running titles, with proposals to check',
  'Running Titles (template)': 'Running titles: a template to fill in',
  Checklist: 'Checklist of every requirement in the rule sheet, with its status',
};

/** The rule that asks for running titles, or null: only then is the model asked to propose them. */
export const runningTitlesRule = sheet => ruleWith(sheet, { slot: 'running-title.length' });

/**
 * How many model calls the reading check would make: one per chapter with text to read, found as
 * the formatter finds chapters. Zero without labels.
 */
export function readingPlan({ paragraphs, roles, sheet }) {
  if (!Array.isArray(paragraphs) || !roles) return 0;
  const { chapters } = planFormatting(paragraphs, roles, settingsFrom(sheet));
  return readingUnits({ paragraphs, roles, chapters, sheet }).length;
}

/** The file's name without .docx, for the names of the downloads. */
export function baseName(name) {
  const base = String(name ?? '').replace(/\.docx$/iu, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, ' ').trim();
  return base || 'manuscript';
}

/** A fingerprint of what a result was made from, so the page can tell when it is out of date. */
export const outputBasis = ({ sheet, roles, reading = false }) => JSON.stringify({ rules: sheet?.rules ?? [], docType: sheet?.docType ?? null, roles, reading });

/**
 * @param {{ bytes: Uint8Array, paragraphs: Array<object>, roles: Record<number, string>, sheet: object,
 *   name: string, proposeTitles?: (request: { titles: string, max: number }) => Promise<string>,
 *   readText?: (request: { unit: string, signal?: AbortSignal }) => Promise<string>, onReading?: Function, date?: string }} input
 *   readText: given only when the scholar chose the reading check; onReading gets its progress.
 * @returns {Promise<{ ok: true, files: Array<{ id: string, label: string, name: string, bytes: Uint8Array }>, summary: object }
 *   | { ok: false, message: string }>}
 */
export async function buildOutputs({ bytes, paragraphs, roles, sheet, name, proposeTitles, readText, onReading, date }) {
  const formatted = formatDocx({ bytes, roles, sheet, ...(date ? { date } : {}) });
  if (!formatted.ok) return { ok: false, message: formatted.message ? `${formatted.message} Nothing was formatted.` : GENERAL_FAILURE };
  const { report } = formatted;
  let findings, checks, comments, commented, todos;
  let reading = null;
  try {
    ({ findings, checks } = runChecks({ paragraphs, roles, report, sheet }));
  } catch {
    return { ok: false, message: GENERAL_FAILURE };
  }
  if (typeof readText === 'function') {
    const units = readingUnits({ paragraphs, roles, chapters: report.chapters, sheet });
    try {
      const result = await readChapters({ units, model: null, call: readText, onProgress: onReading });
      reading = { chapters: units.length, failed: result.failures.length, found: result.findings.length };
      findings = [...findings, ...readingFindings(result.findings)].sort((a, b) => (a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1));
    } catch {
      reading = { chapters: units.length, failed: units.length, found: 0 };
    }
  }
  try {
    comments = commentsFor(findings, sheet);
    commented = addComments(formatted.bytes, { map: report.map, comments, ...(date ? { date } : {}) });
    if (!commented.ok) return { ok: false, message: GENERAL_FAILURE };
    todos = todosDocument({ findings, checks, sheet, report, paragraphs });
  } catch {
    return { ok: false, message: GENERAL_FAILURE };
  }
  const validity = validateDocx(commented.bytes);
  if (!validity.ok) return { ok: false, message: NOT_VALID };

  let running = null;
  let titles = 'not asked';
  const rule = runningTitlesRule(sheet);
  if (rule && typeof proposeTitles === 'function') {
    const chapters = (report.chapters ?? []).map(chapter => ({ first: chapter.first, title: fullTitle(chapter, paragraphs) }));
    if (chapters.length) {
      try {
        running = await proposeRunningTitles({ chapters, max: rule.params.max, call: proposeTitles });
        titles = 'proposed';
      } catch {
        titles = 'failed';
      }
    }
  }
  const companions = companionDocuments({ sheet, report, paragraphs, roles, findings, checks, proposals: running?.proposals ?? new Map() });
  const base = baseName(name);
  const files = [
    { id: 'manuscript', label: 'The formatted manuscript, with comments and tracked changes', name: `${base} (formatted).docx`, bytes: commented.bytes },
    { id: 'todos', label: 'The To-dos list: what is left for you, chapter by chapter', name: `${base} To-dos.docx`, bytes: todos.bytes },
    ...companions.map(companion => ({ id: companion.name.toLowerCase().replace(/[^a-z]+/gu, '-').replace(/^-|-$/gu, ''), label: COMPANION_LABELS[companion.name] ?? companion.name, name: `${base} ${companion.name}.docx`, bytes: companion.bytes })),
  ];
  if (files.slice(1).some(file => !validateDocx(file.bytes).ok)) return { ok: false, message: NOT_VALID };
  return {
    ok: true,
    files,
    summary: outputSummary({ report, findings, checks, sheet, comments: validity.counts.comments, revisions: validity.counts.revisions, todos, unplaced: commented.unplaced, running, titles, reading }),
  };
}

/**
 * The summary the page shows after formatting, in plain words: what was changed, with counts; what
 * was flagged; what the author still has to supply; and notes on what was not done.
 */
export function outputSummary({ report, findings, checks, sheet, comments, revisions, todos, unplaced = 0, running = null, titles = 'not asked', reading = null }) {
  const styled = Object.values(report.styles ?? {}).reduce((sum, count) => sum + count, 0);
  const changed = [
    `${plural(styled, 'paragraph was', 'paragraphs were')} given a named style for what ${styled === 1 ? 'it is' : 'they are'}, in place of direct formatting.`,
    ...changeLines(report).map(line => `${line.charAt(0).toUpperCase()}${line.slice(1)}.`),
  ];
  if (revisions) changed.push(`${plural(revisions, 'change to words is', 'changes to words are')} marked as tracked changes, for you to accept or reject in Word.`);
  const byKind = new Map();
  for (const finding of findings) if (finding.kind !== 'formatting-summary') byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  const flagged = [...byKind].map(([kind, count]) => `${kindLabel(kind)}: ${plural(count, 'place', 'places')}.`);
  if (reading) flagged.push(`The reading check read the opening of ${plural(reading.chapters, 'chapter', 'chapters')} and proposed ${plural(reading.found, 'query', 'queries')} whose quoted words it found in the text; each is a comment marked as a model's proposal, for you to judge.`);
  const supply = toSupply(sheet, findings, checks).map(rule => rule.statement);
  const notes = [];
  const conflicts = new Set((sheet?.rules ?? []).filter(rule => rule.conflict === true && rule.enabled !== false).map(rule => rule.slot)).size;
  if (conflicts) notes.push(`${plural(conflicts, 'setting in the rule sheet has', 'settings in the rule sheet have')} rules that disagree, so ${conflicts === 1 ? 'it was' : 'they were'} not applied. Choose one rule in each case in step 3 and format again.`);
  if (unplaced) notes.push(`${plural(unplaced, 'comment', 'comments')} could not be placed at ${unplaced === 1 ? 'its' : 'their'} paragraph and ${unplaced === 1 ? 'is' : 'are'} at the start of the file instead.`);
  if (reading?.failed) notes.push(`The reading check could not read ${plural(reading.failed, 'chapter', 'chapters')} (the model service did not answer), so ${reading.failed === 1 ? 'that chapter has' : 'those chapters have'} no queries from it. Format again to try once more.`);
  if (titles === 'failed') notes.push('Running titles could not be proposed (the model service did not answer), so the running titles document is a template to fill in. Format again to try once more.');
  else if (titles === 'proposed' && running?.dropped?.length) notes.push(`${plural(running.dropped.length, 'proposed running title was', 'proposed running titles were')} left out because ${running.dropped.length === 1 ? 'it' : 'they'} could not be used (too long, or with words the title does not have); ${running.dropped.length === 1 ? 'that chapter is' : 'those chapters are'} left blank to fill in.`);
  return {
    headline: `Formatted. ${plural(comments, 'comment', 'comments')} in the file, ${plural(todos.counts.items, 'item', 'items')} on the To-dos list, ${plural(supply.length, 'requirement', 'requirements')} for you to supply.`,
    changed,
    flagged: flagged.length ? flagged : ['Nothing in the text needed a comment beyond the summary at the top of the file.'],
    supply: supply.length ? supply : ['Nothing: no requirement in the rule sheet is only yours to provide.'],
    notes,
    counts: { comments, revisions, items: todos.counts.items, supply: supply.length, styled, reading: reading?.found ?? null },
  };
}

/**
 * What a formatting run leaves on the page: a new result replaces the old; a failure keeps the
 * files made before (marked as such) and gives the reason. kept: whether earlier files stay offered.
 */
export function afterFormat(previous, result, basis) {
  if (result.ok) return { output: { files: result.files, summary: result.summary, basis }, error: null, kept: false };
  if (previous) return { output: previous, error: `${result.message} The files below are from the last time the manuscript was formatted.`, kept: true };
  return { output: null, error: result.message, kept: false };
}

/** Whether files on the page were made from what the page now holds. */
export const isStale = (output, basis) => Boolean(output) && output.basis !== basis;
export const STALE = 'The rule sheet or the labels changed after these files were made. Format the manuscript again to include the changes.';
