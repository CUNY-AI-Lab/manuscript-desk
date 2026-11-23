import test from 'node:test';
import assert from 'node:assert/strict';
import { collapsePages, romanValue, secondNumber } from '../lib/index/ranges.js';
import { compareHeadings, formatIndex, indexDocx } from '../lib/index/format.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readDocx } from '../lib/docx/read.js';

test('Chicago\'s abbreviation of the second number, with its own examples', () => {
  const cases = [[3, 10, '10'], [71, 72, '72'], [96, 117, '117'], [100, 104, '104'], [1100, 1113, '1113'], [101, 108, '8'], [808, 833, '33'], [1103, 1104, '4'],
    [321, 328, '28'], [498, 532, '532'], [1087, 1089, '89'], [1496, 1500, '500'], [11564, 11615, '615'], [12991, 13001, '3001']];
  for (const [first, last, want] of cases) assert.equal(secondNumber(first, last, 'chicago'), want, `${first}-${last}`);
});

test('full and two-digit styles', () => {
  assert.equal(secondNumber(321, 328, 'full'), '328');
  assert.equal(secondNumber(104, 108, 'two-digit'), '08');
  assert.equal(secondNumber(321, 328, 'two-digit'), '28');
  assert.equal(secondNumber(23, 28, 'two-digit'), '28');
  assert.equal(secondNumber(1496, 1504, 'two-digit'), '504');
  assert.equal(secondNumber(998, 1003, 'two-digit'), '1003');
});

test('consecutive pages become ranges; roman numerals are joined but never shortened; others stay', () => {
  assert.deepEqual(collapsePages(['ii', 'iii', 'iv', '3', '4', '5', '9', '101', '102', '103', '200', 'A3']), ['ii–iv', '3–5', '9', '101–3', '200', 'A3']);
  assert.deepEqual(collapsePages(['3', '4', '5'], { collapse: false }), ['3', '4', '5']);
  assert.deepEqual(collapsePages(['321', '322', '323', '324', '325', '326', '327', '328'], { style: 'full' }), ['321–328']);
  assert.equal(romanValue('xiv'), 14);
  assert.equal(romanValue('12'), null);
});

test('letter by letter and word by word, Chicago\'s examples', () => {
  const headings = ['New York', 'Newark', 'new deal', 'New England', 'newborn', 'New Zealand'];
  const sorted = sorting => [...headings].sort((a, b) => compareHeadings(a, b, sorting));
  assert.deepEqual(sorted('letter-by-letter'), ['Newark', 'newborn', 'new deal', 'New England', 'New York', 'New Zealand']);
  assert.deepEqual(sorted('word-by-word'), ['new deal', 'New England', 'New York', 'New Zealand', 'Newark', 'newborn']);
  // Up to the first comma in either system: "Smith, John" before "Smithson, Ann".
  for (const sorting of ['letter-by-letter', 'word-by-word']) assert.ok(compareHeadings('Smith, John', 'Smithson, Ann', sorting) < 0, sorting);
  // Subentries skip a leading small word.
  assert.ok(compareHeadings('in Africa', 'beliefs', 'letter-by-letter', { subentry: true }) < 0);
});

const ENTRIES = [
  { heading: 'artificial intelligence', pages: ['3', '12', '13', '14'], subentries: [{ heading: 'in medicine', pages: ['20'] }, { heading: 'ethics of', pages: ['5', '6'] }, { heading: 'unused', pages: [] }], seeAlso: ['neural networks', 'robots'] },
  { heading: 'AI', pages: ['3'], see: ['artificial intelligence'] },
  { heading: 'Babbage, Charles', pages: ['101', '102', '108'], seeAlso: ['computing'] },
  { heading: 'Ørsted, Hans', pages: [] },
];

test('indented: subentries under the heading, See also last, a see-only heading, letter groups', () => {
  const { lines, count } = formatIndex(ENTRIES, { layout: 'indented' });
  assert.equal(count, 3);
  assert.deepEqual(lines, [
    'A',
    'AI. See artificial intelligence',
    'artificial intelligence, 3, 12–14',
    '    ethics of, 5–6',
    '    in medicine, 20',
    '    See also neural networks; robots',
    '',
    'B',
    'Babbage, Charles, 101–2, 108. See also computing',
  ]);
});

test('run-in: one paragraph per entry, subentries after semicolons', () => {
  const { lines } = formatIndex(ENTRIES, { layout: 'run-in', style: 'full', collapse: false });
  assert.equal(lines[2], 'artificial intelligence, 3, 12, 13, 14; ethics of, 5, 6; in medicine, 20. See also neural networks; robots');
  const bare = formatIndex([{ heading: 'jazz', pages: [], subentries: [{ heading: 'bebop', pages: ['9'] }] }], { layout: 'run-in' });
  assert.equal(bare.lines[1], 'jazz: bebop, 9');
});

test('the Word file is valid and holds the entries in the index styles', () => {
  const bytes = indexDocx(formatIndex(ENTRIES), { note: 'Made with the Index Builder.' });
  const report = validateDocx(bytes);
  assert.equal(report.ok, true, JSON.stringify(report));
  const read = readDocx(bytes);
  assert.ok(read.ok);
  const texts = read.paragraphs.map(entry => entry.text);
  assert.ok(texts.includes('artificial intelligence, 3, 12–14'));
  assert.ok(read.paragraphs.some(entry => entry.hints.styleId === 'Index2'));
});
