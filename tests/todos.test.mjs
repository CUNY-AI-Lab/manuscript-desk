import test from 'node:test';
import assert from 'node:assert/strict';
import { addComments } from '../lib/docx/comments.js';
import { readDocx } from '../lib/docx/read.js';
import { validateDocx } from '../lib/docx/validate.js';
import { formatDocx } from '../lib/format/format.js';
import { runChecks } from '../lib/checks/run.js';
import { abstractsDocument, altTextsDocument, checklistDocument, companionDocuments, ruleStatuses, runningTitlesDocument } from '../lib/todos/companions.js';
import { commentsFor, todosDocument, toSupply } from '../lib/todos/todos.js';
import { manuscript } from './manuscript-fixture.mjs';

// A rule sheet of invented rules: [id, category, slot, params, mode, quote].
function sheet(rules) {
  return {
    version: 1, docType: 'edited-collection', manual: { id: null, named: null }, dropped: 0, created: '2026-11-22T12:00:00Z',
    rules: rules.map(([id, category, slot, params = {}, mode = 'flag', quote = `Invented guideline sentence for ${id}.`]) => ({ id, category, slot, statement: `Statement of ${id}.`, mode, source: { kind: 'guidelines', quote, doc: 0 }, params, enabled: true })),
  };
}
const RULES = [
  ['restart', 'notes', 'notes.restart', { per: 'chapter' }, 'fix'],
  ['numbers', 'headings', 'headings.numbering', { scheme: 'decimal' }, 'fix'],
  ['split', 'chapters', 'chapters.subtitle', { split: true }, 'fix'],
  ['markers', 'figures-tables', 'figures.markers', { example: '[Figure 2.1 about here]' }, 'fix'],
  ['alt', 'alt-text', null, {}, 'supply'],
  ['abstract', 'abstract-keywords', 'abstract.words', { max: 150 }, 'supply'],
  ['running', 'length', 'running-title.length', { max: 30 }, 'supply'],
  ['cover', 'figures-tables', null, {}, 'supply'],
  ['proofread', 'other', null, {}, 'flag'],
];

function pipeline(rules = RULES) {
  const { bytes, roles } = manuscript();
  const rulesSheet = sheet(rules);
  const formatted = formatDocx({ bytes, roles, sheet: rulesSheet });
  assert.equal(formatted.ok, true);
  const { paragraphs } = readDocx(bytes);
  const { findings, checks } = runChecks({ paragraphs, roles, report: formatted.report, sheet: rulesSheet });
  return { bytes, roles, sheet: rulesSheet, formatted, report: formatted.report, paragraphs, findings, checks };
}
const textOf = bytes => readDocx(bytes).paragraphs.map(entry => entry.text).join('\n');

test('the formatted file gains one comment per place with findings, the summary at the top, and stays valid', () => {
  const { formatted, findings, sheet: rulesSheet, report } = pipeline();
  const comments = commentsFor(findings, rulesSheet);
  assert.equal(new Set(comments.map(comment => comment.sourceIndex)).size, comments.length, 'one comment per place');
  assert.match(comments[0].text, /^What this formatting pass changed/);
  const withRule = comments.find(comment => comment.text.includes('Invented guideline sentence for split.'));
  assert.ok(withRule, 'a finding with a rule quotes the guideline sentence');
  const result = addComments(formatted.bytes, { map: report.map, comments });
  assert.equal(result.ok, true);
  assert.equal(result.written, comments.length);
  const validity = validateDocx(result.bytes);
  assert.deepEqual(validity.problems, []);
  assert.equal(validity.counts.comments, comments.length);
});

test('the To-dos list groups findings by chapter and kind, names each rule, quotes the guidelines and lists what to supply', () => {
  const run = pipeline();
  const { bytes, counts } = todosDocument(run);
  assert.equal(validateDocx(bytes).ok, true);
  const text = textOf(bytes);
  assert.match(text, /^To-dos\n/);
  assert.match(text, /\nChapter 1: Paper Lanterns: How Invented Things Are Read\n/);
  assert.match(text, /\nGlass Bells: Sounding Invented Objects\n|\nChapter 2: Glass Bells: Sounding Invented Objects\n/);
  assert.match(text, /\nChapter title\nThis title was divided at its colon[^\n]*\nRule: Statement of split\.\n“Invented guideline sentence for split\.”\n/);
  assert.match(text, /\nTo supply\n[^]*\nStatement of cover\.\n“Invented guideline sentence for cover\.”/);
  assert.doesNotMatch(text.slice(text.indexOf('\nTo supply\n'), text.indexOf('\nSummary\n')), /Statement of (alt|abstract)\./, 'a supply rule a check ran on is not listed again');
  assert.match(text, /\nWhat was changed\n[^]*\nWhat was flagged\n[^]*\nWhat was skipped, and why\n[^]*it needs a rule that chapter titles have no quotation marks/);
  assert.match(text, /need someone to read the text[^]*\n•\tStatement of proofread\./);
  assert.ok(counts.items > 3);
  assert.deepEqual(toSupply(run.sheet, run.findings, run.checks).map(rule => rule.id), ['running', 'cover']);
});

test('companion documents are produced only when a rule asks for them', () => {
  const none = pipeline(RULES.slice(0, 4));
  assert.deepEqual(companionDocuments(none).map(entry => entry.name), ['Checklist']);
  assert.equal(abstractsDocument(none), null);
  assert.equal(altTextsDocument(none), null);
  assert.equal(runningTitlesDocument(none), null);
  const all = pipeline();
  const made = companionDocuments(all);
  assert.deepEqual(made.map(entry => entry.name), ['Abstracts and Keywords', 'Alt Texts (template)', 'Running Titles (template)', 'Checklist']);
  for (const entry of made) assert.equal(validateDocx(entry.bytes).ok, true, entry.name);
});

test('abstracts and keywords per chapter, with a marked gap where a chapter has none', () => {
  const run = pipeline();
  const made = abstractsDocument(run);
  assert.deepEqual(made.entries.map(({ abstract, keywords }) => [abstract, keywords]), [[true, true], [false, false]]);
  const text = textOf(made.bytes);
  assert.match(text, /Abstract: This chapter asks how a reader meets an invented object for the first time\./);
  assert.match(text, /Keywords: lanterns, reading, invention/);
  assert.match(text, /Abstract: \[to write: an abstract of about 150 words\]/);
});

test('the alt-text template lists every figure by its number; running titles take a short title as it stands', () => {
  const run = pipeline();
  const alt = altTextsDocument(run);
  assert.deepEqual(alt.entries.map(entry => entry.label), ['1.1']);
  assert.match(textOf(alt.bytes), /\n1\.1\tChapter 1: Paper Lanterns[^\t]*\t\[no caption in the text yet\]\t\[to write\]/);
  const titles = runningTitlesDocument(run);
  assert.deepEqual(titles.entries.map(({ proposed, source }) => [proposed, source]), [[true, 'title'], [true, 'title']]);
  assert.match(textOf(titles.bytes), /\tPaper Lanterns\t14\n/);
  const proposed = runningTitlesDocument({ ...run, proposals: new Map([[run.report.chapters[1].first, 'Bells of Glass']]) });
  assert.equal(proposed.name, 'Running Titles (proposals)');
  assert.match(textOf(proposed.bytes), /\tBells of Glass\t14\n/);
});

test('the checklist gives each requirement a status: done, flagged, checked, to supply, not checked, in conflict, off', () => {
  const run = pipeline();
  const rules = run.sheet.rules;
  rules.push({ ...rules[7], id: 'off', enabled: false }, { ...rules[1], id: 'conflict-a', conflict: true });
  const statuses = Object.fromEntries(ruleStatuses(run).map(({ rule, status }) => [rule.id, status]));
  assert.equal(statuses.restart, 'done');
  assert.equal(statuses.split, 'flagged', 'applied, and a split to verify');
  assert.equal(statuses.alt, 'flagged');
  assert.equal(statuses.abstract, 'flagged');
  assert.equal(statuses.cover, 'supply');
  assert.equal(statuses.proofread, 'unchecked');
  assert.equal(statuses.off, 'off');
  assert.equal(statuses['conflict-a'], 'conflict');
  const made = checklistDocument(run);
  assert.match(textOf(made.bytes), /Notes: Statement of restart\.\tdone by the tool\tApplied in the formatted file\./);
  assert.equal(Object.values(made.tally).reduce((sum, count) => sum + count, 0), rules.length);
});
