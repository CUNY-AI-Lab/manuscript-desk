// The reader of a whole work's title page finds each element by what it says, wherever it stands.
// Every layout here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDateLine, titlePageFacts, titlePageParts } from '../lib/format/titles.js';
import { PARTS_CHECKS } from '../lib/checks/parts.js';

const parts = lines => titlePageParts(lines.map(text => ({ text })));
const ELEMENTS = 'title > author > statement > degree > program > institution > year > advisor';
const check = PARTS_CHECKS.find(entry => entry.id === 'title-page-elements');
// The title-page check on a page of these entries, every one labelled as the title page unless it says otherwise.
function missing(entries, elements = ELEMENTS) {
  const paragraphs = entries.map((entry, index) => ({ index, kind: entry.kind ?? 'paragraph', text: entry.text, hints: { empty: entry.text.trim() === '' } }));
  const roles = Object.fromEntries(entries.map((entry, index) => [index, entry.role ?? 'title-page']));
  const found = check.run({ paragraphs, roleOf: index => roles[index] ?? null }, { params: { elements } });
  return found.length ? found[0].message : '';
}

test('the title first, then "by", the author, the statement and the date, as the Graduate Center sets it', () => {
  assert.deepEqual(parts(['INVENTED HARBOURS', 'A STUDY OF PORTS THAT NEVER WERE', 'by', 'ROWAN PLACEHOLDER', 'A dissertation submitted to the Graduate Faculty in Invented Studies in partial', 'fulfillment of the requirements for the degree of Doctor of Philosophy,', 'The Institution of Nowhere', '2027']),
    ['title', 'subtitle', 'label', 'author', 'statement', 'statement', 'affiliation', 'statement']);
});

test('the university first, the title near the end, the candidate and the advisor under their labels, the academic year last', () => {
  const lines = ['UNIVERSITY OF NOWHERE', 'DEPARTMENT OF INVENTED STUDIES', 'AND IMAGINARY MAPS', 'Graduate Program in Coastal History', 'A THESIS IN THE HISTORY OF PORTS', 'Invented Harbours, a Study of Ports That Never Were', 'Candidate', 'Rowan Placeholder', 'Advisor', 'Some Advisor', 'Academic Year 2026/2027'];
  assert.deepEqual(parts(lines), ['affiliation', 'affiliation', 'affiliation', 'statement', 'statement', 'title', 'statement', 'author', 'statement', 'statement', 'statement']);
});

test('the date and the statement before the title, the author after it with "Presented by"', () => {
  assert.deepEqual(parts(['Spring 2027', 'A thesis submitted in partial fulfillment of the requirements for the degree of Master of Arts', 'Charting Nowhere', 'The Tide Tables of Imaginary Ports', 'Presented by', 'Rowan Placeholder', 'College of Elsewhere']),
    ['statement', 'statement', 'title', 'subtitle', 'statement', 'author', 'affiliation']);
});

test('a book’s title page: the title in capitals that read like names, "Edited by" and the editors with their institutions', () => {
  assert.deepEqual(parts(['INVENTED LANTERNS', 'Essays on Paper and Light', 'Edited by', 'Ada Placeholder, University of Elsewhere', 'Ben Example, Institute of Nowhere']), ['title', 'subtitle', 'label', 'author', 'author']);
  assert.deepEqual(parts(['Invented Lanterns', 'Rowan Placeholder']), ['title', 'author'], 'no "by": the last line of names is the author');
});

test('a line that only states when, in English and other languages', () => {
  for (const line of ['2027', 'May 2027', 'Academic Year 2026/2027', 'Anno Accademico 2026/2027', 'Fall 2026']) assert.equal(isDateLine(line), true, line);
  for (const line of ['Harbours of 1702', 'A History, 1700–1800', 'Invented Harbours']) assert.equal(isDateLine(line), false, line);
});

test('the title-page check finds every element wherever it stands, reading a table of names between the lines', () => {
  const page = [
    { text: 'UNIVERSITY OF NOWHERE' },
    { text: '', role: null },
    { text: 'Graduate Program in Coastal History' },
    { text: 'A THESIS IN THE HISTORY OF PORTS FOR THE DEGREE OF MASTER OF ARTS' },
    { text: 'Invented Harbours, a Study of Ports That Never Were' },
    { text: 'ADVISOR\tCANDIDATE\nSome Advisor\tRowan Placeholder', kind: 'table', role: 'table' },
    { text: 'Academic Year 2026/2027' },
    { text: 'Contents', role: 'front-matter-heading' },
  ];
  assert.equal(missing(page), '', 'nothing missing');
  const facts = titlePageFacts(page.slice(0, 7).map(entry => ({ kind: entry.kind ?? 'paragraph', text: entry.text })).filter(entry => entry.text));
  assert.ok(facts.lines.includes('Rowan Placeholder') && facts.lines.includes('CANDIDATE'), 'the table’s cells are lines of the page');
  // The same page without its table and its last line lacks the author, the advisor and the year.
  assert.match(missing(page.filter(entry => entry.kind !== 'table' && !/Academic/u.test(entry.text))), /the author’s full name, the year and the advisor/u);
});

test('the title page ends at the first paragraph that is not one of its lines, a picture or a table', () => {
  const page = [{ text: 'Invented Harbours' }, { text: 'by' }, { text: 'Rowan Placeholder' }, { text: 'Abstract', role: 'front-matter-heading' }, { text: 'A dissertation submitted for the degree of Doctor of Philosophy, 2027' }];
  assert.match(missing(page, 'title > author > statement > year'), /the statement of what the work is and what it is submitted for and the year/u);
});
