// The Formatter page, step 6: formatting the manuscript in this browser and what is offered for
// download. buildOutputs runs the formatter, the To-do checks, the comments writer, the To-dos list
// and the companion documents the rule sheet calls for, all on bytes held in memory, and asks the
// model for running titles (through the injected `proposeTitles`) only when a rule asks for them,
// and, when the scholar chose it, for the reading check of each chapter's opening (through the
// injected `readText`), whose verified findings become comments and To-dos entries. Every file it
// offers has passed the structural validator. Pure apart from those injected calls, so it loads and
// is tested under Node; output-step.js draws its result.

import { readAccessibility } from '../../lib/docx/accessibility.js';
import { addComments } from '../../lib/docx/comments.js';
import { validateDocx } from '../../lib/docx/validate.js';
import { formatDocx } from '../../lib/format/format.js';
import { runChecks } from '../../lib/checks/run.js';
import { readChapters, readingFindings, readingUnits, withoutRepeats } from '../../lib/checks/reading.js';
import { planFormatting, settingsFrom } from '../../lib/format/plan.js';
import { ruleWith } from '../../lib/checks/rules.js';
import { changeLines } from '../../lib/checks/summary.js';
import { companionDocuments } from '../../lib/todos/companions.js';
import { proposeRunningTitles } from '../../lib/todos/running.js';
import { chapterName, fullTitle, kindLabel } from '../../lib/todos/shared.js';
import { commentsFor, todosDocument, toSupply } from '../../lib/todos/todos.js';
import { abstractsDocument, altTextsDocument, ruleStatuses, runningTitlesDocument } from '../../lib/todos/companions.js';
import { SETTLING_DEFAULTS, withDefaults } from '../../lib/decide/defaults.js';
import { askModel, decidePlan, disposeFindings, planDecisions, preparedSheet, triageRules } from '../../lib/decide/run.js';
import { COPYEDIT_NAME, DID_NAME, copyeditDocument, decideChecklist, decideComments, formatterLines, summaryComment, whatWeDidDocument } from '../../lib/decide/outputs.js';

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
  [COPYEDIT_NAME]: 'Queries for the copyeditor: possible slips in the running text, by chapter, not marked in the manuscript',
  [DID_NAME]: 'What we did: the changes, the defaults, what is left for you and why, and every rule of the guidelines',
};
const DECIDED_CHECKLIST = 'Checklist: what you need to decide and what to hand in';

/** The rule that asks for running titles, or null: only then is the model asked to propose them. */
export const runningTitlesRule = sheet => ruleWith(sheet, { slot: 'running-title.length' });

/**
 * How many model calls the reading check would make: one per chapter with text to read, found as
 * the formatter finds chapters, and one for the front and back matter when it has any. Zero
 * without labels.
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
export const outputBasis = ({ sheet, roles, reading = false, decide = false }) => JSON.stringify({ rules: sheet?.rules ?? [], docType: sheet?.docType ?? null, roles, reading, decide });

/**
 * What the decide step will take, said before it starts: model calls and minutes, roughly.
 * Zero calls without labels.
 */
export function decideEstimate({ paragraphs, roles, sheet }) {
  if (!Array.isArray(paragraphs) || !roles || !sheet) return { calls: 0, minutes: 0 };
  const { chapters } = planFormatting(paragraphs, roles, settingsFrom(sheet));
  const units = readingUnits({ paragraphs, roles, chapters, sheet }).length;
  const open = (sheet.rules ?? []).filter(rule => rule.enabled !== false && rule.slot === null).length;
  return decidePlan({ chapters: chapters.length, openRules: open, readingUnits: units });
}

/**
 * @param {{ bytes: Uint8Array, paragraphs: Array<object>, roles: Record<number, string>, sheet: object,
 *   name: string, proposeTitles?: (request: { titles: string, max: number }) => Promise<string>,
 *   readText?: (request: { unit: string, signal?: AbortSignal }) => Promise<string>, onReading?: Function, date?: string }} input
 *   readText: given only when the scholar chose the reading check; onReading gets its progress.
 * @returns {Promise<{ ok: true, files: Array<{ id: string, label: string, name: string, bytes: Uint8Array }>, summary: object }
 *   | { ok: false, message: string }>}
 */
export async function buildOutputs({ bytes, paragraphs, roles, sheet, name, proposeTitles, readText, onReading, date, decide, onDecide }) {
  if (typeof decide === 'function') return buildDecidedOutputs({ bytes, paragraphs, roles, sheet, name, proposeTitles, readText, onReading, date, decide, onDecide });
  const formatted = formatDocx({ bytes, roles, sheet, ...(date ? { date } : {}) });
  if (!formatted.ok) return { ok: false, message: formatted.message ? `${formatted.message} Nothing was formatted.` : GENERAL_FAILURE };
  const { report } = formatted;
  let findings, checks, comments, commented, todos;
  let reading = null;
  // The formatted file's pictures, tables, headings, links and properties, for the accessibility checks.
  const accessibility = readAccessibility(formatted.bytes);
  try {
    ({ findings, checks } = runChecks({ paragraphs, roles, report, sheet, accessibility }));
  } catch {
    return { ok: false, message: GENERAL_FAILURE };
  }
  if (typeof readText === 'function') {
    const units = readingUnits({ paragraphs, roles, chapters: report.chapters, sheet });
    try {
      const result = await readChapters({ units, model: null, call: readText, onProgress: onReading });
      const kept = withoutRepeats(result.findings, findings);
      reading = { chapters: units.filter(unit => unit.chapter !== null).length, matter: units.some(unit => unit.chapter === null), failed: result.failures.length,
        outOfRoom: result.failures.length > 0 && result.failures.every(failure => failure.code === 'model_output_limit'), found: kept.length };
      findings = [...findings, ...readingFindings(kept)].sort((a, b) => (a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1));
    } catch {
      reading = { chapters: units.filter(unit => unit.chapter !== null).length, matter: units.some(unit => unit.chapter === null), failed: units.length, found: 0 };
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
  const companions = companionDocuments({ sheet, report, paragraphs, roles, findings, checks, accessibility, proposals: running?.proposals ?? new Map() });
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
  for (const finding of findings) if (finding.kind !== 'formatting-summary' && !finding.severity) byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  const flagged = [...byKind].map(([kind, count]) => `${kindLabel(kind)}: ${plural(count, 'place', 'places')}.`);
  const access = findings.filter(finding => finding.severity);
  if (access.length) {
    const tally = severity => access.filter(finding => finding.severity === severity).length;
    flagged.push(`Accessibility: ${plural(access.length, 'place', 'places')} (${tally('must')} must fix, ${tally('should')} should fix, ${tally('check')} to check), each a comment and an item in the To-dos list's Accessibility section.`);
  }
  if (reading) flagged.push(`The reading check read the opening of ${plural(reading.chapters, 'chapter', 'chapters')}${reading.matter ? ' and the front matter' : ''} and proposed ${plural(reading.found, 'query', 'queries')} whose quoted words it found in the text; each is a comment marked as a model's proposal, for you to judge.`);
  const supply = toSupply(sheet, findings, checks).map(rule => rule.statement);
  const notes = [];
  const conflicts = new Set((sheet?.rules ?? []).filter(rule => rule.conflict === true && rule.enabled !== false).map(rule => rule.slot)).size;
  if (conflicts) notes.push(`${plural(conflicts, 'setting in the rule sheet has', 'settings in the rule sheet have')} rules that disagree, so ${conflicts === 1 ? 'it was' : 'they were'} not applied. Choose one rule in each case in step 3 and format again.`);
  if (unplaced) notes.push(`${plural(unplaced, 'comment', 'comments')} could not be placed at ${unplaced === 1 ? 'its' : 'their'} paragraph and ${unplaced === 1 ? 'is' : 'are'} at the start of the file instead.`);
  if (reading?.failed) notes.push(`The reading check could not read ${plural(reading.failed, 'part', 'parts')} of the text (${reading.outOfRoom ? 'the model\'s answer ran out of room, even when the part was read in two halves' : 'the model service did not answer'}), so ${reading.failed === 1 ? 'that part has' : 'those parts have'} no queries from it, or only some. Format again to try once more.`);
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

const SETTLED_WORDS = settled => SETTLING_DEFAULTS.filter(entry => settled.some(finding => finding.disposition?.by === entry.id)).map(entry => entry.words);
const readingSummary = (units, result, kept) => ({ chapters: units.filter(unit => unit.chapter !== null).length, matter: units.some(unit => unit.chapter === null), failed: result.failures.length,
  outOfRoom: result.failures.length > 0 && result.failures.every(failure => failure.code === 'model_output_limit'), found: kept.length });

/**
 * Formatting with the decide step (the default on the page): the pipeline, the reading check, then
 * the decide step's operations, defaults and decisions (lib/decide/), the formatter again with them,
 * and what the author receives: the file with a summary comment and only the real questions, the
 * copyeditor's list, "What we did" and the checklist of decisions and things to hand in.
 * `decide` is the model call of one unit (POST /api/decide); `onDecide` gets its progress.
 */
export async function buildDecidedOutputs({ bytes, paragraphs, roles, sheet, name, proposeTitles, readText, onReading, date, decide, onDecide, signal }) {
  const base = preparedSheet(sheet);
  const first = withDefaults(base);
  const formatted0 = formatDocx({ bytes, roles, sheet: first.sheet, ...(date ? { date } : {}) });
  if (!formatted0.ok) return { ok: false, message: formatted0.message ? `${formatted0.message} Nothing was formatted.` : GENERAL_FAILURE };
  let findings0, checks0;
  try {
    ({ findings: findings0, checks: checks0 } = runChecks({ paragraphs, roles, report: formatted0.report, sheet: first.sheet, accessibility: readAccessibility(formatted0.bytes) }));
  } catch {
    return { ok: false, message: GENERAL_FAILURE };
  }
  // The reading check, which the decide step needs: its queries are questions or the copyeditor's.
  let reading = null;
  let readingFound = [];
  if (typeof readText === 'function') {
    const units = readingUnits({ paragraphs, roles, chapters: formatted0.report.chapters, sheet: first.sheet });
    try {
      const result = await readChapters({ units, model: null, call: readText, onProgress: onReading });
      readingFound = readingFindings(withoutRepeats(result.findings, findings0));
      reading = readingSummary(units, result, readingFound);
    } catch {
      reading = { chapters: units.filter(unit => unit.chapter !== null).length, matter: units.some(unit => unit.chapter === null), failed: units.length, found: 0 };
    }
  }
  const pipelineFindings = [...findings0, ...readingFound].sort((a, b) => (a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1));
  const statuses0 = ruleStatuses({ sheet: first.sheet, report: formatted0.report, findings: pipelineFindings, checks: checks0 });
  const made = ['the formatted manuscript', COPYEDIT_NAME, DID_NAME, 'a checklist', ...(ruleWith(first.sheet, { category: 'abstract-keywords' }) ? ['an abstracts-and-keywords document'] : []), ...(runningTitlesRule(first.sheet) ? ['running titles'] : []), 'an alt-text template when there are figures'];
  let answers;
  try {
    answers = await askModel({ paragraphs, roles, sheet: first.sheet, report: formatted0.report, findings: pipelineFindings, statuses: statuses0, made, call: decide, signal, onProgress: onDecide });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, message: GENERAL_FAILURE };
  }
  const plan = planDecisions({ paragraphs, roles, sheet: first.sheet, answers });
  const finalSheet = withDefaults(preparedSheet(base, plan.cleared), { ignore: new Set(plan.cleared.keys()) });
  const formatted = formatDocx({ bytes, roles: plan.roles, sheet: finalSheet.sheet, edits: plan.edits, ...(date ? { date } : {}) });
  if (!formatted.ok) return { ok: false, message: GENERAL_FAILURE };
  const { report } = formatted;
  const accessibility = readAccessibility(formatted.bytes);
  let final;
  try {
    final = runChecks({ paragraphs, roles: plan.roles, report, sheet: finalSheet.sheet, accessibility });
  } catch {
    return { ok: false, message: GENERAL_FAILURE };
  }
  const disposed = disposeFindings({ roles, answers, plan, finalFindings: final.findings, edits: report.edits });
  const everything = [...disposed.asked, ...disposed.resolved, ...disposed.settled, ...disposed.copyedit, ...disposed.flagged];
  const statuses = ruleStatuses({ sheet: finalSheet.sheet, report, findings: everything, checks: final.checks });
  const triage = triageRules({ statuses, answers, asked: disposed.asked, settled: disposed.settled });
  const decisions = disposed.asked.length + plan.extraQuestions.length;
  const copyeditCount = disposed.copyedit.length + plan.extraCopyedit.length;
  const summaryText = summaryComment({ applied: disposed.applied, report, defaults: finalSheet.applied, settled: disposed.settled, decisions, copyedit: copyeditCount, refusals: plan.refusals.length });
  const chapters = report.chapters ?? [];
  const { comments, places } = decideComments({ summary: summaryText, asked: disposed.asked, flagged: disposed.flagged, copyedit: disposed.copyedit, extraQuestions: plan.extraQuestions, applied: disposed.applied, chapters, paragraphs, sheet: finalSheet.sheet });
  const commented = addComments(formatted.bytes, { map: report.map, comments, ...(date ? { date } : {}) });
  if (!commented.ok) return { ok: false, message: GENERAL_FAILURE };
  const validity = validateDocx(commented.bytes);
  if (!validity.ok) return { ok: false, message: NOT_VALID };

  let running = null;
  let titles = 'not asked';
  const rule = runningTitlesRule(finalSheet.sheet);
  if (rule && typeof proposeTitles === 'function' && chapters.length) {
    try {
      running = await proposeRunningTitles({ chapters: chapters.map(chapter => ({ first: chapter.first, title: fullTitle(chapter, paragraphs) })), max: rule.params.max, call: proposeTitles });
      titles = 'proposed';
    } catch {
      titles = 'failed';
    }
  }
  const input = { sheet: finalSheet.sheet, report, paragraphs, roles: plan.roles, findings: everything, checks: final.checks, accessibility, proposals: running?.proposals ?? new Map() };
  const copyeditRules = triage.filter(entry => entry.end === 'copyedit').map(entry => entry.rule);
  const copyedit = copyeditDocument({ copyedit: disposed.copyedit, extraCopyedit: plan.extraCopyedit, rules: copyeditRules, chapters, paragraphs });
  const did = whatWeDidDocument({ applied: disposed.applied, report, defaults: finalSheet.applied, settled: disposed.settled, cleared: plan.cleared, sheet: finalSheet.sheet, roleChanges: plan.roleChanges, refusals: plan.refusals, asked: disposed.asked, copyeditCount, triage, chapters, paragraphs });
  const checklist = decideChecklist({ triage });
  const base_ = baseName(name);
  const others = [abstractsDocument(input), altTextsDocument(input), runningTitlesDocument(input)].filter(Boolean);
  const files = [
    { id: 'manuscript', label: 'The formatted manuscript: the changes as tracked changes, a summary at the top, and a comment at each thing you need to decide', name: `${base_} (formatted).docx`, bytes: commented.bytes },
    { id: 'checklist', label: DECIDED_CHECKLIST, name: `${base_} Checklist.docx`, bytes: checklist.bytes },
    { id: 'what-we-did', label: COMPANION_LABELS[DID_NAME], name: `${base_} ${DID_NAME}.docx`, bytes: did.bytes },
    { id: 'copyedit', label: COMPANION_LABELS[COPYEDIT_NAME], name: `${base_} ${COPYEDIT_NAME}.docx`, bytes: copyedit.bytes },
    ...others.map(companion => ({ id: companion.name.toLowerCase().replace(/[^a-z]+/gu, '-').replace(/^-|-$/gu, ''), label: COMPANION_LABELS[companion.name] ?? companion.name, name: `${base_} ${companion.name}.docx`, bytes: companion.bytes })),
  ];
  if (files.slice(1).some(file => !validateDocx(file.bytes).ok)) return { ok: false, message: NOT_VALID };
  const failedUnits = Object.entries(answers.stats.stopped).filter(([stopped]) => !['finished', 'turns', 'no_tool_call'].includes(stopped)).reduce((sum, [, count]) => sum + count, 0);
  return {
    ok: true,
    files,
    summary: decidedSummary({ report, applied: disposed.applied, defaults: finalSheet.applied, settled: disposed.settled, asked: disposed.asked, extraQuestions: plan.extraQuestions, chapters, paragraphs, copyeditCount, checklist, comments: validity.counts.comments, revisions: validity.counts.revisions, reading, failedUnits, titles, running }),
    measures: { comments: validity.counts.comments, places, questions: decisions, copyedit: copyeditCount, checklistRows: checklist.rows, triage, disposed, plan, answers, report, defaults: finalSheet.applied, finalSheet: finalSheet.sheet, statuses0, pipeline: { findings: pipelineFindings.length, report: formatted0.report } },
  };
}

/** The page's summary after the decide step, in plain words. */
export function decidedSummary({ report, applied, defaults, settled, asked, extraQuestions, chapters, paragraphs, copyeditCount, checklist, comments, revisions, reading, failedUnits = 0, titles = 'not asked', running = null }) {
  const styled = Object.values(report.styles ?? {}).reduce((sum, count) => sum + count, 0);
  const changed = [
    ...applied.map(op => `${op.words.charAt(0).toUpperCase()}${op.words.slice(1)}.`),
    `${plural(styled, 'paragraph was', 'paragraphs were')} given a named style for what ${styled === 1 ? 'it is' : 'they are'}.`,
    ...formatterLines(report).map(line => `${line.charAt(0).toUpperCase()}${line.slice(1)}.`),
  ];
  if (revisions) changed.push(`${plural(revisions, 'change to words is', 'changes to words are')} marked as tracked changes, for you to accept or reject in Word.`);
  const where = index => { const at = (chapters ?? []).findIndex(chapter => index >= chapter.first && index <= chapter.last); return at >= 0 ? chapterName(chapters[at], paragraphs) : 'Front and back matter'; };
  const decide = [...asked, ...extraQuestions.map(proposal => ({ kind: 'proposed-change', paragraphIndex: proposal.paragraphIndex }))]
    .sort((a, b) => (a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1))
    .map(finding => `${finding.kind === 'proposed-change' ? 'A change only you can decide' : kindLabel(finding.kind)} (${Number.isInteger(finding.paragraphIndex) ? where(finding.paragraphIndex) : 'the whole manuscript'}).`);
  const used = [...defaults.map(entry => entry.words), ...SETTLED_WORDS(settled)];
  const notes = [];
  if (reading?.failed) notes.push(`The reading check could not read ${plural(reading.failed, 'part', 'parts')} of the text, so ${reading.failed === 1 ? 'that part has' : 'those parts have'} no queries from it. Format again to try once more.`);
  if (failedUnits) notes.push(`The model service did not answer for ${plural(failedUnits, 'part', 'parts')} of the decide step, so what ${failedUnits === 1 ? 'it' : 'they'} held stayed a question for you. Format again to try once more.`);
  if (titles === 'failed') notes.push('Running titles could not be proposed (the model service did not answer), so the running titles document is a template to fill in.');
  else if (titles === 'proposed' && running?.dropped?.length) notes.push(`${plural(running.dropped.length, 'proposed running title was', 'proposed running titles were')} left out because ${running.dropped.length === 1 ? 'it' : 'they'} could not be used; ${running.dropped.length === 1 ? 'that chapter is' : 'those chapters are'} left blank to fill in.`);
  return {
    headline: `Formatted. You need to decide ${plural(decide.length, 'thing', 'things')}; ${plural(checklist.rows, 'item is', 'items are')} on the checklist.`,
    changed,
    decide: decide.length ? decide : ['Nothing in the text needs a decision from you.'],
    defaults: used.length ? used.map(line => `${line.charAt(0).toUpperCase()}${line.slice(1)}.`) : ['None: the guidelines say how to set everything the tool sets.'],
    copyedit: copyeditCount ? `${plural(copyeditCount, 'possible slip', 'possible slips')} in the running text ${copyeditCount === 1 ? 'is' : 'are'} in “${COPYEDIT_NAME}”, for the copyeditor; they are not marked in the manuscript.` : 'Nothing was noticed for the copyeditor.',
    notes,
    counts: { comments, revisions, decide: decide.length, checklist: checklist.rows, copyedit: copyeditCount, styled },
  };
}
