import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocx } from '../lib/docx/read.js';
import { DECLARED } from '../lib/format/declared.js';
import { formatDocx } from '../lib/format/format.js';
import { parseKeywords } from '../lib/checks/matter.js';
import { CHECKS, runChecks } from '../lib/checks/run.js';
import { inCapitals } from '../lib/checks/titles.js';
import { RULES, manuscript, sheetWith } from './manuscript-fixture.mjs';

// An invented paragraph model: [text, role, hints] per paragraph, indices in order.
function model(rows) {
  const paragraphs = [];
  const roles = {};
  rows.forEach(([text, role, extra = {}], index) => {
    paragraphs.push({ index, kind: extra.kind ?? 'paragraph', text, hints: { empty: text.trim() === '', footnote: Boolean(extra.footnote), image: false, bold: false, italic: false } });
    if (role) roles[index] = role;
  });
  return { paragraphs, roles };
}

// A rule sheet of hand-written rules: [id, category, slot, params, mode].
function sheet(rules) {
  return {
    version: 1, docType: 'edited-collection', manual: { id: null, named: null }, dropped: 0, created: '2026-11-22T12:00:00Z',
    rules: rules.map(([id, category, slot, params = {}, mode = 'flag']) => ({ id, category, slot, statement: 'A rule written for the tests.', mode, source: { kind: 'guidelines', quote: 'A sentence of invented guidelines.', doc: 0 }, params, enabled: true })),
  };
}

// Two invented chapters, each with a title block, so checks have chapters to read.
const CHAPTERS = [
  ['Lanterns and Their Readers', 'title-block'],
  ['Ada Placeholder', 'title-block'],
  ['Abstract: A short summary of the chapter that runs to a few words only.', 'abstract'],
  ['Keywords: lanterns; reading; Lanterns; light, shade', 'keywords'],
  ['1 Opening', 'heading-1'],
  ['Body text of the first chapter.', 'body'],
  ['Bibliography', 'bibliography-heading'],
  ['Placeholder, Ada. A Book. 2001.', 'bibliography-entry'],
  ['——. Another Book. 2002.', 'bibliography-entry'],
  ['——. A Third Book. 2003.', 'bibliography-entry'],
  ['THE “GLASS” BELLS OF AN INVENTED TOWN', 'title-block'],
  ['Ben Example', 'title-block', { footnote: true }],
  ['Opening', 'heading-1'],
  ['More body text, with no abstract before it.', 'body'],
  ['Works cited', 'bibliography-heading'],
  ['Example, Ben. A Book. 2004.', 'bibliography-entry'],
];
const report = (overrides = {}) => ({
  chapters: [
    { first: 0, last: 9, number: 1, titleBlock: [0, 1], parts: ['title', 'author'], typedNumbers: false },
    { first: 10, last: 15, number: 2, titleBlock: [10, 11], parts: ['title', 'author'], typedNumbers: false },
  ],
  declared: [], figures: [], settings: {}, styles: { 'body-first': 2 },
  ...overrides,
});
const findingsOf = (rows, rules, overrides) => {
  const { paragraphs, roles } = model(rows);
  return runChecks({ paragraphs, roles, report: report(overrides), sheet: sheet(rules) });
};
const byCheck = (result, id) => result.findings.filter(finding => finding.check === id);

test('a check with no rule behind it does not run, and the list says what it needed', () => {
  const result = findingsOf(CHAPTERS, []);
  const ran = result.checks.filter(check => check.ran).map(check => check.id);
  assert.deepEqual(ran, ['formatting-summary'], 'only the summary of the formatter\'s own changes');
  assert.equal(result.checks.length, CHECKS.length);
  for (const check of result.checks.filter(entry => !entry.ran)) assert.ok(check.needs.length > 10, check.id);
  // A rule switched off or in conflict asks for nothing.
  const off = sheet([['q', 'headings', 'titles.quotes', { allowed: false }]]);
  off.rules[0].enabled = false;
  const { paragraphs, roles } = model(CHAPTERS);
  assert.equal(runChecks({ paragraphs, roles, report: report(), sheet: off }).findings.filter(finding => finding.check === 'title-quotation-marks').length, 0);
});

test('chapter titles: quotation marks, capitals, a long title without a subtitle, and a split to verify', () => {
  const rows = CHAPTERS.map(row => [...row]);
  rows[0][0] = 'Lanterns and Their Readers in the Long History of Invented Objects Read at Night';
  const result = findingsOf(rows, [
    ['q', 'headings', 'titles.quotes', { allowed: false }],
    ['c', 'headings', 'headings.case', { case: 'title' }],
    ['s', 'chapters', 'chapters.subtitle', { split: true }],
  ], { declared: [{ kind: DECLARED.titleSplit, count: 1, places: [99], removedWords: [], addedWords: [] }] });
  assert.deepEqual(byCheck(result, 'title-quotation-marks').map(finding => [finding.paragraphIndex, finding.ruleId, finding.kind, finding.chapter]), [[10, 'q', 'chapter-title', 1]]);
  assert.deepEqual(byCheck(result, 'title-capitals').map(finding => finding.paragraphIndex), [10]);
  assert.match(byCheck(result, 'title-capitals')[0].message, /title case/);
  assert.deepEqual(byCheck(result, 'title-long').map(finding => finding.paragraphIndex), [0]);
  assert.match(byCheck(result, 'title-long')[0].message, /\(80 characters\)/);
  assert.deepEqual(byCheck(result, 'title-split').map(finding => [finding.paragraphIndex, finding.ruleId]), [[99, 's']]);
  // An apostrophe is not a quotation mark; a title in title case is not in capitals.
  assert.equal(inCapitals('The Readers’ Lanterns'), false);
  assert.equal(inCapitals('THE READERS’ LANTERNS'), true);
  const plain = findingsOf(CHAPTERS.map(([text, role, extra]) => [text.replace(/[“”]/gu, '').replace('THE GLASS BELLS OF AN INVENTED TOWN', 'The Readers’ Glass Bells'), role, extra]), [['q', 'headings', 'titles.quotes', { allowed: false }]]);
  assert.equal(byCheck(plain, 'title-quotation-marks').length, 0);
});

test('abstracts and keywords: missing, too long, and keywords counted, repeated or mixed', () => {
  const result = findingsOf(CHAPTERS, [
    ['a', 'abstract-keywords', 'abstract.words', { max: 8 }, 'supply'],
    ['k', 'abstract-keywords', 'keywords.count', { min: 6, max: 10 }, 'supply'],
  ]);
  assert.deepEqual(byCheck(result, 'abstract-missing').map(finding => [finding.paragraphIndex, finding.ruleId, finding.chapter]), [[11, 'a', 1]], 'on the last line of the second chapter\'s title block');
  assert.match(byCheck(result, 'abstract-missing')[0].message, /no abstract and no keywords[^]*about 8 words[^]*6 to 10/);
  assert.match(byCheck(result, 'abstract-length')[0].message, /has 13 words; the guidelines ask for about 8/);
  const keywords = byCheck(result, 'keywords-form');
  assert.equal(keywords.length, 1);
  assert.match(keywords[0].message, /^In these keywords, there are 4, where the guidelines ask for 6 to 10; 1 keyword appears more than once; some keywords are separated by semicolons and others by commas\. Correct the list\.$/);
  assert.deepEqual(parseKeywords('Key words: one, two, three.'), { items: ['one', 'two', 'three'], mixed: false });
  // Without a rule on abstracts, none of this runs.
  assert.equal(findingsOf(CHAPTERS, []).findings.filter(finding => finding.kind.startsWith('abstract') || finding.kind === 'keywords-form').length, 0);
});

test('a note on a title-block line, and dashes for a repeated author, each where a rule forbids them', () => {
  const result = findingsOf(CHAPTERS, [
    ['n', 'notes', 'notes.titles', { allowed: false }],
    ['r', 'references', 'references.repeated-author', { form: 'name' }],
  ]);
  assert.deepEqual(byCheck(result, 'note-on-title').map(finding => finding.paragraphIndex), [11]);
  const dashes = byCheck(result, 'repeated-author-dash');
  assert.deepEqual(dashes.map(finding => finding.paragraphIndex), [8], 'one finding per bibliography, at its first dash');
  assert.match(dashes[0].message, /^2 entries in this bibliography/);
  // A sheet that allows the dash asks for nothing.
  assert.equal(byCheck(findingsOf(CHAPTERS, [['r', 'references', 'references.repeated-author', { form: 'dash' }]]), 'repeated-author-dash').length, 0);
});

test('heading numbers: one finding for the numbers the formatter added; typed numbers that are incomplete', () => {
  const added = findingsOf(CHAPTERS, [['h', 'headings', 'headings.numbering', { scheme: 'decimal' }]], {
    declared: [{ kind: DECLARED.headingNumbers, count: 2, places: [4, 12], removedWords: [], addedWords: [] }],
  });
  const numbers = byCheck(added, 'heading-numbers-added');
  assert.deepEqual(numbers.map(finding => [finding.paragraphIndex, finding.ruleId]), [[4, 'h']]);
  assert.match(numbers[0].message, /2 headings in 2 chapters/);
  assert.equal(byCheck(added, 'heading-numbers-typed').length, 0, 'no chapter has typed numbers');
  const rows = CHAPTERS.map(row => [...row]);
  rows.splice(6, 0, ['2.1. Going On', 'heading-2']);
  const typed = findingsOf(rows, [['h', 'headings', 'headings.numbering', { scheme: 'decimal' }]], {
    chapters: [
      { first: 0, last: 10, number: 1, titleBlock: [0, 1], parts: ['title', 'author'], typedNumbers: true },
      { first: 11, last: 16, number: 2, titleBlock: [11, 12], parts: ['title', 'author'], typedNumbers: false },
    ],
  });
  const found = byCheck(typed, 'heading-numbers-typed');
  assert.equal(found.length, 1);
  assert.equal(found[0].paragraphIndex, 4);
  assert.match(found[0].message, /end with a full stop|ends with a full stop/);
});

test('bibliographies headed differently from chapter to chapter, where a rule asks for consistency', () => {
  const result = findingsOf(CHAPTERS, [['c', 'consistency', null]]);
  const found = byCheck(result, 'bibliography-headings');
  assert.deepEqual(found.map(finding => finding.paragraphIndex), [6]);
  assert.match(found[0].message, /2 different ways: “Bibliography” \(1 chapter\) and “Works cited” \(1 chapter\)/);
  // Headings that differ only in their capitals differ; a trailing stop or colon does not count.
  const rows = CHAPTERS.map(row => [...row]);
  rows[6][0] = 'Works Cited:';
  assert.match(byCheck(findingsOf(rows, [['c', 'consistency', null]]), 'bibliography-headings')[0].message, /“Works Cited” \(1 chapter\) and “Works cited” \(1 chapter\)/);
  rows[14][0] = 'Works  Cited.';
  assert.equal(byCheck(findingsOf(rows, [['c', 'consistency', null]]), 'bibliography-headings').length, 0);
});

test('figures: each need from its own rule, a caption line to write, and figures the text never mentions', () => {
  const rows = CHAPTERS.map(row => [...row]);
  rows[5] = ['Body text that discusses Fig. 1.1 at length.', 'body'];
  rows.splice(6, 0, ['[insert Fig. 1.1 here]', 'figure'], ['[insert Fig. 1.2 here]', 'figure']);
  const result = findingsOf(rows, [
    ['f', 'figures-tables', 'figures.files', { separate: true }, 'supply'],
    ['p', 'permissions', null, {}, 'supply'],
    ['a', 'alt-text', null, {}, 'supply'],
    ['m', 'figures-tables', 'figures.markers', { example: '[insert Fig. 5.3 here]' }, 'fix'],
    ['o', 'figures-tables', 'figures.callouts', { required: true }],
  ], {
    chapters: [{ first: 0, last: 11, number: 1, titleBlock: [0, 1], parts: ['title', 'author'], typedNumbers: false }],
    figures: [{ index: 6, label: '1.1', placeholder: true, captionAt: null }, { index: 7, label: '1.2', placeholder: true, captionAt: null }],
    declared: [{ kind: DECLARED.captionAdded, count: 2, places: [6, 7], removedWords: [], addedWords: [] }],
    settings: { figureMarker: { label: 'Fig.' } },
  });
  const figures = result.findings.filter(finding => finding.kind === 'figure-to-supply');
  assert.deepEqual(figures.map(finding => [finding.check, finding.ruleId, finding.paragraphIndex]), [
    ['figure-file', 'f', 6], ['figure-permission', 'p', 6], ['figure-alt-text', 'a', 6], ['figure-caption', 'm', 6], ['figure-callouts', 'o', 6],
  ]);
  assert.match(figures[0].message, /^Figures 1\.1 and 1\.2 still need, each, an image file/);
  assert.match(figures[4].message, /1 figure of 2 \(1\.2\)[^]*see Fig\. 1\.2/);
});

test('quotations whose lines were joined, lines laid out with tabs, and Word tables of running text', () => {
  const rows = [
    ...CHAPTERS.slice(0, 6),
    ['Year\tPlace\tThing', 'table'], ['2001\tNowhere\tA lantern', 'table'],
    ['A text\tIts translation', 'body', { kind: 'table' }],
    ...CHAPTERS.slice(6),
  ];
  const result = findingsOf(rows, [], {
    chapters: [
      { first: 0, last: 12, number: 1, titleBlock: [0, 1], parts: ['title', 'author'], typedNumbers: false },
      { first: 13, last: 18, number: 2, titleBlock: [13, 14], parts: ['title', 'author'], typedNumbers: false },
    ],
    declared: [{ kind: DECLARED.linesJoined, count: 3, places: [16, 16, 18], removedWords: [], addedWords: [] }],
  });
  // A heading stands between paragraphs 16 and 18, so the two are two quotations.
  assert.deepEqual(byCheck(result, 'table-from-tabs').map(finding => finding.paragraphIndex), [6]);
  assert.match(byCheck(result, 'table-from-tabs')[0].message, /^These 2 lines lay out a table with tabs/);
  assert.deepEqual(byCheck(result, 'table-for-layout').map(finding => finding.paragraphIndex), [8]);
  const joined = byCheck(result, 'quotation-lines-joined');
  assert.deepEqual(joined.map(finding => finding.paragraphIndex), [16, 18]);
  assert.match(joined[0].message, /2 lines were put back together into one paragraph/);
  // Roots with only quotation lines between them are one quotation, one finding.
  const quotation = model([...CHAPTERS.slice(0, 6), ['First line of a quotation', 'block-quotation'], ['', null], ['Second paragraph of it', 'block-quotation'], ['Body text after it.', 'body'], ['Another quotation', 'block-quotation'], ...CHAPTERS.slice(6)]);
  const grouped = runChecks({ ...quotation, sheet: null, report: report({
    chapters: [{ first: 0, last: 16, number: 1, titleBlock: [0, 1], parts: ['title', 'author'], typedNumbers: false }],
    declared: [{ kind: DECLARED.linesJoined, count: 4, places: [6, 8, 8, 10], removedWords: [], addedWords: [] }],
  }) });
  assert.deepEqual(byCheck(grouped, 'quotation-lines-joined').map(finding => finding.paragraphIndex), [6, 10]);
  assert.match(byCheck(grouped, 'quotation-lines-joined')[0].message, /3 lines were put back together into 2 paragraphs/);
  for (const finding of [...byCheck(result, 'table-from-tabs'), ...joined]) assert.equal(finding.ruleId, null, 'these concern the formatter\'s own changes');
});

test('the summary at the top counts what the formatting pass changed, in plain words', () => {
  const result = findingsOf(CHAPTERS, [], {
    declared: [
      { kind: DECLARED.emptyRemoved, count: 12, places: [], removedWords: [], addedWords: [] },
      { kind: DECLARED.titleSplit, count: 1, places: [0], removedWords: [], addedWords: [] },
    ],
    styles: { 'body-first': 2, body: 5 },
  });
  const [summary] = byCheck(result, 'formatting-summary');
  assert.equal(summary.paragraphIndex, 0);
  assert.equal(summary.chapter, 0);
  const lines = summary.message.split('\n');
  assert.match(lines[1], /^- 7 paragraphs were given a named style[^]*\(2 styles in all\)/);
  assert.equal(lines[2], '- 12 empty paragraphs used for spacing removed;');
  assert.equal(lines[3], '- 1 chapter title divided at its colon into a title and a subtitle.');
  assert.match(lines[4], /^No other words were changed/);
});

test('on a formatted manuscript, every finding points at a paragraph with text and says what to do in plain words', () => {
  const { bytes, roles } = manuscript();
  const rules = sheetWith([RULES.restart, RULES.numbered, RULES.split, RULES.markers]);
  const formatted = formatDocx({ bytes, roles, sheet: rules });
  const { paragraphs } = readDocx(bytes);
  const result = runChecks({ paragraphs, roles, report: formatted.report, sheet: rules });
  const kinds = new Set(result.findings.map(finding => finding.kind));
  for (const kind of ['formatting-summary', 'chapter-title', 'heading-numbering', 'quotation-lines-joined', 'figure-to-supply']) assert.ok(kinds.has(kind), kind);
  for (const finding of result.findings) {
    assert.ok(paragraphs[finding.paragraphIndex].text.trim(), `${finding.check} points at a paragraph with text`);
    assert.doesNotMatch(finding.message, /\b[a-z]+\.[a-z]+\b|[a-z][A-Z]|\b(slot|params?|null|undefined)\b/u, finding.check);
  }
  const ids = new Set(rules.rules.map(rule => rule.id));
  for (const finding of result.findings) assert.ok(finding.ruleId === null || ids.has(finding.ruleId));
});
