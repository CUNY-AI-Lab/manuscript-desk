// The checks of the front and back matter against the chapters, and the reading check's units that
// carry the notes on contributors. Everything here is invented for these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFormatting } from '../lib/format/plan.js';
import { compareContents, matchNotes, tokens } from '../lib/checks/front.js';
import { checkContext } from '../lib/checks/context.js';
import { runChecks } from '../lib/checks/run.js';
import { readingUnits, withoutRepeats } from '../lib/checks/reading.js';

function book(rows) {
  const paragraphs = [];
  const roles = {};
  rows.forEach(([text, role], index) => {
    paragraphs.push({ index, kind: 'paragraph', text, hints: { empty: text.trim() === '', footnote: false, image: false, bold: false, italic: false } });
    if (role) roles[index] = role;
  });
  const { chapters } = planFormatting(paragraphs, roles);
  return { paragraphs, roles, report: { chapters, declared: [], figures: [], settings: {}, styles: { body: 1 } } };
}

const ROWS = [
  ['A Book of Invented Lanterns', 'title-page'],
  ['Edited by Ada Placeholder', 'title-page'],
  ['', null],
  ['Contents', 'front-matter-heading'],
  ['ADA PLACEHOLDER - University of Elsewhere', 'contents-entry'],
  ['Paper Lantern: A Study of Light 3', 'contents-entry'],
  ['', null],
  ['CY SAMPLE & BEN EXAMPLE', 'contents-entry'],
  ['Glass Bells and the Sound of', 'contents-entry'],
  ['Small Towns 20', 'contents-entry'],
  ['', null],
  ['Part One: Paper', 'contents-entry'],
  ['Notes on Contributors 40', 'contents-entry'],
  ['Paper Lanterns: A Study of Light', 'title-block'],
  ['Ada Placeholder (University of Elsewhere)', 'title-block'],
  ['Body text of the first chapter.', 'body'],
  ['Glass Bells and the Sound of Small Towns', 'title-block'],
  ['Ben Example and Cy Sample', 'title-block'],
  ['Institute of Nowhere', 'title-block'],
  ['Body text of the second chapter.', 'body'],
  ['Tin Drums', 'title-block'],
  ['Di Testcase', 'title-block'],
  ['Body text of the third chapter.', 'body'],
  ['Notes on Contributors', 'front-matter-heading'],
  ['Ada Placehold is a lecturer at the University of Elsewhere, where she studies light in invented towns and writes about lanterns of every kind.', 'contributor-note'],
  ['Ben Example teaches sound studies at the Institute of Nowhere.', 'contributor-note'],
  ['Cy Sample teaches at the University of Somewhere.', 'contributor-note'],
  ['Ed Extra writes about invented music.', 'contributor-note'],
];
const SHEET = {
  version: 1, docType: 'edited-collection', manual: { id: null, named: null }, dropped: 0, created: '2026-11-22T12:00:00Z',
  rules: [
    { id: 'contents', category: 'front-matter', slot: null, statement: 'Include a table of contents.', mode: 'supply', params: {}, source: { kind: 'guidelines', quote: 'Include a table of contents.', doc: 0 }, enabled: true },
    { id: 'bios', category: 'contributors', slot: 'contributors.words', statement: 'Each note on a contributor has about 20 words.', mode: 'flag', params: { max: 20 }, source: { kind: 'guidelines', quote: 'Notes of about 20 words.', doc: 0 }, enabled: true },
  ],
};

test('tokens fold accents and case and drop apostrophes, keeping the words as written', () => {
  assert.deepEqual(tokens('Ítalo’s CAFÉ, n. 3').map(token => token.norm), ['italos', 'cafe', 'n', '3']);
  assert.deepEqual(tokens('Ítalo’s').map(token => token.surface), ['Ítalo’s']);
});

test('the contents list is compared with the chapters: wording, authors, order, missing and unmatched lines', () => {
  const { paragraphs, roles, report } = book(ROWS);
  assert.equal(report.chapters.length, 3, 'the matter belongs to no chapter');
  const result = compareContents(checkContext({ paragraphs, roles, report, sheet: SHEET }));
  const [first, second, third] = result.chapters;
  assert.deepEqual(first.titleExtra, ['“Lantern”']);
  assert.deepEqual(first.titleMissing, ['“Lanterns”']);
  assert.equal(first.reordered, false);
  assert.deepEqual(second.lines.map(line => line.index), [7, 8, 9], 'the author line and a title wrapped onto two lines');
  assert.deepEqual([second.titleMissing, second.titleExtra], [[], []]);
  assert.equal(second.reordered, true);
  assert.equal(third.missing, true);
  assert.deepEqual(result.unmatched.map(line => line.index), [11], 'a part named only in the list');
  assert.deepEqual(result.sections.map(match => [match.section.index, match.line.index, match.missing.length + match.extra.length]), [[23, 12, 0]], 'a section heading listed with its page number');
});

test('the contents check comments on the list and on each chapter that differs, naming its rule', () => {
  const { paragraphs, roles, report } = book(ROWS);
  const { findings, checks } = runChecks({ paragraphs, roles, report, sheet: SHEET });
  const contents = findings.filter(finding => finding.kind === 'contents-mismatch');
  assert.deepEqual(contents.map(finding => finding.paragraphIndex), [3, 13, 17, 20]);
  assert.match(contents[0].message, /does not match the text in 4 places/);
  assert.match(contents[0].message, /“Part One: Paper”/);
  assert.match(contents[1].message, /the contents has “Lantern” where the chapter has “Lanterns”/);
  assert.match(contents[2].message, /another order/);
  assert.match(contents[3].message, /not in the contents list/);
  assert.equal(contents[0].ruleId, 'contents');
  assert.ok(checks.find(check => check.id === 'contents-against-chapters').ran);
});

test('notes on contributors are matched to the chapters\' authors, and what differs is reported', () => {
  const { paragraphs, roles, report } = book(ROWS);
  const context = checkContext({ paragraphs, roles, report, sheet: SHEET });
  const { pairs, unmatchedAuthors, unmatchedNotes } = matchNotes(context);
  assert.deepEqual(pairs.map(pair => [pair.author.name, pair.note.index, pair.exact]), [['Ben Example', 25, true], ['Cy Sample', 26, true], ['Ada Placeholder', 24, false]]);
  assert.deepEqual(unmatchedAuthors.map(entry => entry.author.name), ['Di Testcase']);
  assert.deepEqual(unmatchedNotes.map(note => note.index), [27]);
  const { findings } = runChecks({ paragraphs, roles, report, sheet: SHEET });
  const notes = findings.filter(finding => finding.kind === 'contributor-bio' || finding.kind === 'affiliation-inconsistent');
  const at = index => notes.filter(finding => finding.paragraphIndex === index).map(finding => finding.message);
  assert.match(at(23)[0], /no note on Di Testcase/);
  assert.ok(at(24).some(message => /“Ada Placehold”.*“Ada Placeholder”/.test(message)), 'a name spelled differently');
  assert.ok(at(24).some(message => /has 25 words; the guidelines ask for about 20/.test(message)) === false, 'within half to one and a half times the length');
  assert.match(at(27)[0], /names no one given as an author/);
  assert.match(at(18)[0], /note on Cy Sample .* does not give the affiliation .*“Institute of Nowhere”/);
  assert.equal(notes.find(finding => finding.paragraphIndex === 18).kind, 'affiliation-inconsistent');
  assert.ok(at(14).length === 0, 'the first author\'s note gives the institution of the title page');
});

test('a note far from the length asked is flagged; without a rule the checks do not run', () => {
  const rows = ROWS.map(row => [...row]);
  rows[27][0] = 'Ed Extra writes.';
  const { paragraphs, roles, report } = book(rows);
  const { findings } = runChecks({ paragraphs, roles, report, sheet: SHEET });
  assert.ok(findings.some(finding => finding.paragraphIndex === 27 && /has 3 words; the guidelines ask for about 20/.test(finding.message)));
  const none = runChecks({ paragraphs, roles, report, sheet: { ...SHEET, rules: [] } });
  assert.ok(!none.findings.some(finding => ['contents-mismatch', 'contributor-bio'].includes(finding.kind)));
  assert.deepEqual(none.checks.filter(check => check.id.endsWith('-against-chapters')).map(check => check.ran), [false, false]);
});

test('the reading check reads each chapter with its authors\' notes, and the rest of the matter on its own', () => {
  const { paragraphs, roles, report } = book(ROWS);
  const units = readingUnits({ paragraphs, roles, chapters: report.chapters, sheet: SHEET });
  assert.equal(units.length, 4);
  assert.equal(units[0].chapter, null, 'the front and back matter first');
  assert.match(units[0].text, /^The book's front and back matter:/);
  assert.ok(units[0].shown.has(0) && units[0].shown.has(5) && units[0].shown.has(27), 'title page, contents and the note no chapter took');
  assert.ok(!units[0].shown.has(24), 'a note that went with its chapter is not read twice');
  assert.match(units[2].text, /The notes on this chapter's authors, from the book's notes on contributors:\n\[25\] \(note on a contributor\)/);
  assert.ok(units[2].shown.has(25) && units[2].shown.has(26));
  // A model's query of the same kind at the same place as a check's finding is left out.
  const found = [{ kind: 'affiliation-inconsistent', paragraph: 18 }, { kind: 'typo', paragraph: 18 }];
  assert.deepEqual(withoutRepeats(found, [{ kind: 'affiliation-inconsistent', paragraphIndex: 18 }]), [{ kind: 'typo', paragraph: 18 }]);
});
