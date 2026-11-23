// The dissertation settings applied by the formatter, the checks on a work's parts, and the
// accessibility checks, on the invented dissertation of tests/dissertation-fixture.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { DECLARED } from '../lib/format/declared.js';
import { formatDocx } from '../lib/format/format.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readDocx } from '../lib/docx/read.js';
import { readPackage } from '../lib/docx/write.js';
import { readAppearance } from '../lib/docx/appearance.js';
import { readAccessibility } from '../lib/docx/accessibility.js';
import { compareWords, documentWords } from '../lib/format/words.js';
import { titleParts } from '../lib/format/titles.js';
import { runChecks } from '../lib/checks/run.js';
import { altTextsDocument } from '../lib/todos/companions.js';
import { todosDocument } from '../lib/todos/todos.js';
import { presetSheet } from '../lib/presets/index.js';
import { buildOutputs } from '../web/format/output-state.js';
import { dissertation } from './dissertation-fixture.mjs';
import { manuscript, sheetWith } from './manuscript-fixture.mjs';

const DATE = '2026-11-23T00:00:00Z';
const preset = () => presetSheet('cuny-gc');
const withRule = (sheet, rule) => ({ ...sheet, rules: [...sheet.rules, { id: 'test-a1', statement: 'A rule written for the tests.', mode: 'flag', source: { kind: 'author' }, enabled: true, ...rule }] });
const run = (sheet = preset()) => {
  const { bytes, roles } = dissertation();
  const result = formatDocx({ bytes, roles, sheet, date: DATE });
  assert.equal(result.ok, true, JSON.stringify(result));
  const { paragraphs } = readDocx(bytes);
  const accessibility = readAccessibility(result.bytes);
  return { bytes, roles, result, paragraphs, accessibility, ...runChecks({ paragraphs, roles, report: result.report, sheet, accessibility }) };
};
const part = (bytes, name) => strFromU8(unzipSync(bytes)[name]);
const declared = (result, kind) => result.report.declared.find(entry => entry.kind === kind)?.count ?? 0;
const sectionsOf = bytes => [...part(bytes, 'word/document.xml').matchAll(/<w:sectPr>(.*?)<\/w:sectPr>/gu)].map(match => match[1]);

test('a dissertation title page is read into its title, its "by" line, the author and the statement lines', () => {
  const lines = ['A TITLE IN CAPITALS: AND ITS SUBTITLE', 'by', 'Rowan Placeholder', 'A dissertation submitted to the Graduate Faculty in partial fulfillment of the requirements for the degree of Doctor of Philosophy', 'May 2027'];
  assert.deepEqual(titleParts(lines.map(text => ({ text })), { statements: true }), ['title', 'label', 'author', 'statement', 'statement']);
  // A chapter's title block is read as before: a statement is only looked for on a whole work's title page.
  assert.deepEqual(titleParts([{ text: 'Charting Nowhere' }, { text: 'A Thesis on Imaginary Ports' }, { text: 'Rowan Placeholder' }]), ['title', 'subtitle', 'author']);
});

test('the paper, the margins and the line spacing the sheet sets are applied, by element too', () => {
  const { result } = run();
  const look = readAppearance(result.bytes);
  for (const section of look.sections) {
    assert.deepEqual([section.width, section.height], [12240, 15840], 'US Letter');
    assert.deepEqual([section.margins.top, section.margins.right, section.margins.bottom, section.margins.left], [1440, 1440, 1440, 1440]);
  }
  const body = look.paragraphs.filter(entry => entry.styleName === 'Body Text' || entry.styleName === 'Body Text First');
  assert.ok(body.length > 3 && body.every(entry => entry.line === 480), 'the body is double-spaced');
  assert.ok(look.notes.filter(entry => !entry.separator).every(entry => entry.line === 240), 'notes are single-spaced');
  assert.ok(declared(result, DECLARED.paper) > 0 && declared(result, DECLARED.margins) > 0 && declared(result, DECLARED.elementSpacing) === 1);
});

test('the margins can differ by side, and the sides the sheet leaves unset follow most of the text', () => {
  const sheet = withRule({ ...preset(), rules: preset().rules.filter(rule => rule.slot !== 'layout.margins') }, { category: 'layout', slot: 'layout.margin-sides', params: { top: null, right: null, bottom: null, left: 1.5 } });
  const { result } = run(sheet);
  for (const section of readAppearance(result.bytes).sections) assert.deepEqual([section.margins.left, section.margins.right], [2160, 1440]);
});

test('the front matter is numbered in roman from i with the title page counted but unnumbered, the chapters in arabic from 1', () => {
  const { result } = run();
  const sections = sectionsOf(result.bytes);
  assert.match(sections[0], /<w:pgNumType w:fmt="lowerRoman" w:start="1"\/>/u);
  assert.match(sections[0], /<w:titlePg\/>/u);
  assert.match(sections[0], /<w:headerReference w:type="first" r:id="[^"]+"\/><w:footerReference w:type="first"/u);
  const front = result.report.declared.find(entry => entry.kind === DECLARED.pageSequences);
  assert.ok(front);
  const body = sections.findIndex(section => /w:fmt="decimal" w:start="1"/u.test(section));
  assert.ok(body > 0, 'the first chapter starts again at 1');
  assert.ok(sections.slice(body + 1).every(section => /w:fmt="decimal"/u.test(section) && !/w:start=/u.test(section) && !/titlePg/u.test(section)), 'later sections continue');
  assert.ok(sections.slice(1, body).every(section => /lowerRoman/u.test(section)));
  // No place for the numbers in the sheet or the file: they go at the bottom centre, and the summary says so.
  assert.ok(declared(result, DECLARED.pageNumbersAdded) > 0);
  const look = readAppearance(result.bytes);
  assert.equal(look.sections[0].pageNumber.first, null, 'the title page shows no number');
  assert.equal(look.sections[0].pageNumber.other.position, 'bottom-center');
});

test('each chapter and major section starts on a new page, a heading and its page together', () => {
  const { result } = run();
  const xml = part(result.bytes, 'word/document.xml');
  const paragraphs = [...xml.matchAll(/<w:p>(.*?)<\/w:p>/gu)].map(match => match[1]);
  const breaksBefore = text => paragraphs.find(paragraph => paragraph.includes(text))?.includes('<w:pageBreakBefore/>') ?? false;
  assert.equal(breaksBefore('>Approval<'), true);
  assert.equal(breaksBefore('read and accepted'), false, 'the approval page stays with its heading');
  assert.equal(breaksBefore('>Contents<'), true);
  // A chapter after a section break already starts a page, and gets no second break.
  assert.equal(breaksBefore('>CHAPTER 2<'), false);
  assert.match(paragraphs.find(paragraph => paragraph.includes('The chapter ends here.')), /<w:sectPr>/u);
  assert.equal(breaksBefore('>Bibliography<'), true, 'a single bibliography is a major section');
  assert.equal(breaksBefore('INVENTED HARBOURS'), false, 'the first page needs no break');
});

test('formatting a dissertation keeps every word, declares every change and gives a valid file', () => {
  const { bytes, result } = run();
  const words = file => { const { files, main } = readPackage(file); return documentWords(files, main); };
  const check = compareWords(words(bytes), words(result.bytes), result.report.declared);
  assert.equal(check.undeclaredRemoved, 0);
  assert.equal(check.undeclaredAdded, 0);
  const validity = validateDocx(result.bytes);
  assert.equal(validity.ok, true, JSON.stringify(validity.problems));
});

test('the parts out of order and the required parts that are missing are found, and nothing is moved', () => {
  const { findings, result, bytes } = run();
  const order = findings.filter(finding => finding.kind === 'parts-order');
  assert.equal(order.length, 1);
  assert.match(order[0].message, /out of the order/u);
  const missing = findings.filter(finding => finding.kind === 'parts-missing').map(finding => finding.message);
  assert.equal(missing.length, 2);
  assert.ok(missing.some(message => /list of tables/u.test(message)) && missing.some(message => /list of figures/u.test(message)));
  // The source's order of the paragraphs is the output's.
  const texts = file => readDocx(file).paragraphs.map(entry => entry.text.trim()).filter(Boolean);
  assert.deepEqual(texts(result.bytes), texts(bytes));
});

test('a title page that lacks what the sheet asks for is listed, and caption positions are checked', () => {
  const base = preset();
  const sheet = withRule({ ...base, rules: base.rules.map(rule => (rule.slot === 'title-page.elements' ? { ...rule, params: { elements: 'title > author > statement > degree > year > month > advisor' } } : rule)) },
    { category: 'figures-tables', slot: 'captions.position', params: { tables: 'above', figures: 'below' } });
  const { findings } = run(sheet);
  const page = findings.find(finding => finding.kind === 'title-page-elements');
  assert.match(page.message, /the month and the advisor/u);
  const captions = findings.filter(finding => finding.kind === 'caption-position');
  assert.equal(captions.length, 1, 'the table title below its table; the figure captions are below as asked');
  assert.match(captions[0].message, /below the table/u);
});

test('the accessibility checks find each fault of the invented dissertation, with its severity', () => {
  const { findings } = run();
  const found = findings.filter(finding => finding.severity).map(finding => `${finding.kind}:${finding.severity}`).sort();
  assert.deepEqual(found, ['a11y-alt-text:must', 'a11y-alt-text:must', 'a11y-colour:should', 'a11y-heading-skip:should', 'a11y-image-text:check', 'a11y-link-text:should', 'a11y-properties:must', 'a11y-table-header:must']);
  for (const finding of findings.filter(entry => entry.severity)) assert.match(finding.message, /^Accessibility \((?:must fix|should fix|check)\): .*WCAG \d\.\d\.\d/su);
  // The language is missing; the title was set from the title page, so it is not reported.
  const properties = findings.find(finding => finding.kind === 'a11y-properties');
  assert.match(properties.message, /language/u);
  assert.doesNotMatch(properties.message, /no document title/u);
  // Tied to the sheet's accessibility rules.
  assert.ok(findings.filter(entry => entry.severity).every(entry => entry.ruleId?.startsWith('cuny-gc-')));
});

test('the safe accessibility fixes: the document title from the title page, a bold first row marked as a header', () => {
  const { result, accessibility } = run();
  assert.equal(accessibility.title, 'INVENTED HARBOURS: A STUDY OF IMAGINARY PORTS');
  assert.match(part(result.bytes, 'docProps/core.xml'), /<dc:title>INVENTED HARBOURS: A STUDY OF IMAGINARY PORTS<\/dc:title>/u);
  assert.deepEqual(accessibility.tables.map(table => table.header), [true, false], 'only the table whose first row is set apart');
  assert.equal(declared(result, DECLARED.tableHeader), 1);
  assert.equal(declared(result, DECLARED.docTitle), 1);
});

test('the accessibility checks run without any rule, and name none', () => {
  const { bytes, roles } = manuscript();
  const result = formatDocx({ bytes, roles, sheet: sheetWith([]), date: DATE });
  const { findings, checks } = runChecks({ paragraphs: readDocx(bytes).paragraphs, roles, report: result.report, sheet: sheetWith([]), accessibility: readAccessibility(result.bytes) });
  assert.ok(checks.find(check => check.id === 'a11y-properties').ran);
  const link = findings.find(finding => finding.kind === 'a11y-link-text');
  assert.match(link.message, /“link”/u);
  assert.equal(link.ruleId, null);
  // Without the file's facts (as in the evaluation scripts) they do not run.
  const none = runChecks({ paragraphs: readDocx(bytes).paragraphs, roles, report: result.report, sheet: sheetWith([]) });
  assert.equal(none.findings.some(finding => finding.severity), false);
});

test('the alt-text companion lists the same pictures the check reads, and the To-dos have an Accessibility section', () => {
  const { result, paragraphs, roles, accessibility, findings, checks } = run();
  const companion = altTextsDocument({ sheet: preset(), report: result.report, paragraphs, roles, accessibility });
  assert.equal(companion.entries.length, accessibility.pictures.length);
  assert.deepEqual(companion.entries.map(entry => entry.alt), [false, false, true]);
  const todos = todosDocument({ findings, checks, sheet: preset(), report: result.report, paragraphs });
  const text = part(todos.bytes, 'word/document.xml');
  assert.match(text, />Accessibility</u);
  assert.match(text, />Must fix \(4\)</u);
  assert.equal(todos.counts.accessibility, 8);
});

test('the page builds every file for a dissertation with the built-in sheet, all valid', async () => {
  const { bytes, roles } = dissertation();
  const outputs = await buildOutputs({ bytes, paragraphs: readDocx(bytes).paragraphs, roles, sheet: preset(), name: 'invented.docx', date: DATE });
  assert.equal(outputs.ok, true);
  assert.ok(outputs.files.some(file => file.id === 'alt-texts-template'));
  for (const file of outputs.files) assert.equal(validateDocx(file.bytes).ok, true, file.name);
  assert.ok(outputs.summary.flagged.some(line => /^Accessibility: 8 places \(4 must fix, 3 should fix, 1 to check\)/u.test(line)));
});
