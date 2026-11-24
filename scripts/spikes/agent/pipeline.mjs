// The product's Formatter pipeline, composed from its own library as scripts/todos-eval.mjs composes
// it (reader, formatter, checks, reading check, comments, To-dos list, checklist), for the spike:
// run it on a case, count everything it hands back to the author, and run it again with an agent's
// roles, settings, finding decisions and text operations. Not product code.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { addComments } from '../../../lib/docx/comments.js';
import { readDocx } from '../../../lib/docx/read.js';
import { validateDocx } from '../../../lib/docx/validate.js';
import { readPackage } from '../../../lib/docx/write.js';
import { formatDocx } from '../../../lib/format/format.js';
import { compareWords, documentWords } from '../../../lib/format/words.js';
import { runChecks } from '../../../lib/checks/run.js';
import { readChapters, readingFindings, readingUnits, withoutRepeats } from '../../../lib/checks/reading.js';
import { commentsFor, todosDocument, toSupply } from '../../../lib/todos/todos.js';
import { ruleStatuses } from '../../../lib/todos/companions.js';
import { validateSheet } from '../../../lib/rules/schema.js';
import { READING_THINKING, readingPrompt } from '../../../server/prompts.js';

export const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw new Error(`${path.basename(file)} could not be read as JSON`); }
}

export function checkedSheet(value) {
  const checked = validateSheet(value?.sheet ?? value);
  if (!checked.ok) throw new Error(`The rule sheet is not valid (${checked.reason}).`);
  return checked.sheet;
}

/**
 * The reading check from todos-eval's cache only (work/reading-answers.json, same key): no call is
 * made here; a unit not cached counts as failed. Returns readChapters' result.
 */
export async function cachedReading({ work, paragraphs, roles, report, sheet, model = DEFAULT_MODEL }) {
  const cache = (await readJson(path.join(work, 'reading-answers.json')))?.answers ?? {};
  const units = readingUnits({ paragraphs, roles, chapters: report.chapters, sheet });
  let missing = 0;
  const call = async ({ model: id, unit }) => {
    const content = cache[`${id}\u0000${READING_THINKING}\u0000${readingPrompt()}\u0000${unit}`];
    if (typeof content === 'string' && !content.startsWith('\u0000')) return content;
    missing += 1;
    throw Object.assign(new Error(content ? 'model_output_limit' : 'not_cached'), { code: content ? 'model_output_limit' : 'not_cached', retry: false });
  };
  const result = await readChapters({ units, model, call });
  return { ...result, units: units.length, missing };
}

/**
 * The product on a source: format with roles and sheet, run the checks and (optionally) the
 * reading check from the cache. Returns everything the author would be handed.
 */
export async function runPipeline({ source, roles, sheet, work, reading = true }) {
  const read = readDocx(source);
  if (!read.ok) throw new Error(`The reader could not open the source (${read.code}).`);
  const formatted = formatDocx({ bytes: source, roles, sheet });
  if (!formatted.ok) throw new Error(`The formatter stopped: ${formatted.code}.`);
  const { report } = formatted;
  const { findings, checks } = runChecks({ paragraphs: read.paragraphs, roles, report, sheet });
  let readingRun = null;
  if (reading) {
    readingRun = await cachedReading({ work, paragraphs: read.paragraphs, roles, report, sheet });
    const kept = withoutRepeats(readingRun.findings, findings);
    findings.push(...readingFindings(kept));
    findings.sort((a, b) => (a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1));
  }
  return { read, formatted, report, findings, checks, readingRun, ...handedBack({ findings, checks, sheet, report, paragraphs: read.paragraphs }) };
}

/** What the author is handed: comments (one per place), To-dos items, supply items, flagged rules no check verified, checklist rows by status. */
export function handedBack({ findings, checks, sheet, report, paragraphs }) {
  const comments = commentsFor(findings, sheet);
  const todos = todosDocument({ findings, checks, sheet, report, paragraphs });
  const supply = toSupply(sheet, findings, checks);
  const statuses = ruleStatuses({ sheet, report, findings, checks });
  return { comments, todosCounts: todos.counts, todosBytes: todos.bytes, supply, statuses };
}

/** Comments into formatted bytes, validated, with the word check against the source. */
export function finishFile({ source, bytes, report, comments, declared = [] }) {
  const commented = addComments(bytes, { map: report.map, comments });
  if (!commented.ok) throw new Error(`The comments could not be written: ${commented.code}.`);
  const validity = validateDocx(commented.bytes);
  const before = readPackage(source);
  const after = readPackage(commented.bytes);
  const words = compareWords(documentWords(before.files, before.main), documentWords(after.files, after.main), [...report.declared, ...declared]);
  const rejected = documentWords(after.files, after.main, { rejected: true });
  const sourceWords = documentWords(before.files, before.main);
  const rejectGivesSource = rejected.body.join(' ') === sourceWords.body.join(' ') && rejected.notes.join(' ') === sourceWords.notes.join(' ');
  return { bytes: commented.bytes, validity, words, rejectGivesSource, wordCounts: { source: sourceWords.body.length + sourceWords.notes.length, output: documentWords(after.files, after.main).body.length + documentWords(after.files, after.main).notes.length } };
}
