import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { DECLARED } from '../lib/format/declared.js';
import { formatDocx } from '../lib/format/format.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { compareWords, documentWords } from '../lib/format/words.js';
import { volume } from './decide-fixture.mjs';

const words = bytes => { const { files, main } = readPackage(bytes); return documentWords(files, main); };
const rejected = bytes => { const { files, main } = readPackage(bytes); return documentWords(files, main, { rejected: true }); };
const run = edits => {
  const { bytes, roles, sheet } = volume();
  const result = formatDocx({ bytes, roles, sheet, edits, date: '2026-11-23T12:00:00Z' });
  assert.equal(result.ok, true);
  return { result, source: bytes };
};

test('declared edits are made as tracked changes, every word declared, and rejecting them gives the source back', () => {
  const edits = [
    { op: 'replace', paragraph: 26, before: '———', after: 'Example, Ben', kind: DECLARED.authorDash },
    { op: 'replace', paragraph: 17, before: 'GLASS BELLS AND OTHER THINGS', after: 'Glass Bells and Other Things', kind: DECLARED.titleCase },
    { op: 'delete', from: 27, to: 27, kind: DECLARED.strayRemoved },
    { op: 'delete', from: 35, to: 36, kind: DECLARED.duplicateRemoved },
    { op: 'delete', from: 4, to: 7, kind: DECLARED.contentsReplaced },
    { op: 'insert', before: 4, field: 'contents', lines: [{ text: 'Why We Read Lanterns' }, { text: 'Glass Bells and Other Things' }, { text: 'Paper Ships' }], kind: DECLARED.contentsInserted },
  ];
  const { result, source } = run(edits);
  assert.equal(result.report.edits.applied.length, 6, JSON.stringify(result.report.edits.refused));
  assert.deepEqual(result.report.edits.refused, []);
  assert.equal(validateDocx(result.bytes).ok, true, JSON.stringify(validateDocx(result.bytes).problems));
  const check = compareWords(words(source), words(result.bytes), result.report.declared);
  assert.equal(check.undeclaredRemoved + check.undeclaredAdded, 0, JSON.stringify(check));
  const back = rejected(result.bytes);
  assert.deepEqual(back.body, words(source).body, 'rejecting every change gives the source\'s words');
  const xml = strFromU8(unzipSync(result.bytes)['word/document.xml']);
  assert.match(xml, /<w:instrText xml:space="preserve"> TOC \\o "1-1" \\h \\z \\u <\/w:instrText>/);
  assert.match(strFromU8(unzipSync(result.bytes)['word/settings.xml']), /<w:updateFields w:val="true"\/>/);
  const kinds = new Set(result.report.declared.map(entry => entry.kind));
  for (const kind of [DECLARED.authorDash, DECLARED.titleCase, DECLARED.strayRemoved, DECLARED.duplicateRemoved, DECLARED.contentsReplaced, DECLARED.contentsInserted]) assert.ok(kinds.has(kind), kind);
});

test('an edit on a paragraph the formatter already changed is made on the paragraph as it now stands', () => {
  // Two edits in one title, the second made after the first changed the paragraph.
  const { result } = run([{ op: 'replace', paragraph: 17, before: 'GLASS BELLS', after: 'Glass Bells', kind: DECLARED.titleCase }, { op: 'replace', paragraph: 17, before: 'AND OTHER THINGS', after: 'and Other Things', kind: DECLARED.titleCase }]);
  assert.equal(result.report.edits.applied.length, 2, JSON.stringify(result.report.edits.refused));
});

test('the formatter refuses an edit it cannot make safely, and says why', () => {
  const { result, source } = run([
    { op: 'replace', paragraph: 23, before: 'tehm', after: 'them', kind: 'a copyedit' },
    { op: 'replace', paragraph: 35, before: 'A paper ship', after: 'One paper ship', kind: DECLARED.titleCase },
    { op: 'replace', paragraph: 15, before: 'nothing like this', after: 'x', kind: DECLARED.authorDash },
    { op: 'delete', from: 18, to: 18, kind: DECLARED.duplicateRemoved },
    { op: 'delete', from: 23, to: 23, kind: DECLARED.strayRemoved },
  ]);
  const reasons = result.report.edits.refused.map(entry => entry.reason);
  assert.equal(result.report.edits.applied.length, 1, 'only the case edit, which is the formatter\'s to make, is applied');
  assert.match(reasons[0], /not an edit this formatter makes/u);
  assert.match(reasons[1], /not in the paragraph/u);
  assert.match(reasons[2], /note/u, 'a paragraph holding a note is never deleted');
  assert.match(reasons[3], /note/u);
  const check = compareWords(words(source), words(result.bytes), result.report.declared);
  assert.equal(check.undeclaredRemoved + check.undeclaredAdded, 0);
});

test('an edit on a title the formatter splits at its colon is made on the part it lands in', async () => {
  const { manuscript, sheetWith, RULES } = await import('./manuscript-fixture.mjs');
  const { bytes, roles } = manuscript();
  const result = formatDocx({ bytes, roles, sheet: sheetWith([RULES.split]), edits: [{ op: 'replace', paragraph: 3, before: 'How Invented', after: 'how invented', kind: DECLARED.titleCase }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.report.edits.refused, []);
  assert.ok(result.report.declared.some(entry => entry.kind === DECLARED.titleSplit), 'the formatter split the title too');
  const check = compareWords(words(bytes), words(result.bytes), result.report.declared);
  assert.equal(check.undeclaredRemoved + check.undeclaredAdded, 0);
  assert.equal(validateDocx(result.bytes).ok, true);
});

test('a contents field goes in only when a line of the typed list it replaces could be deleted', () => {
  const insert = { op: 'insert', before: 18, field: 'contents', group: 'contents', lines: [{ text: 'A Title' }], kind: DECLARED.contentsInserted };
  // Paragraph 18 holds a note, so it cannot be deleted: the field is refused too, and no second list appears.
  const { result } = run([insert, { op: 'delete', from: 18, to: 18, group: 'contents', kind: DECLARED.contentsReplaced }]);
  assert.equal(result.report.edits.applied.length, 0);
  assert.match(result.report.edits.refused.map(entry => entry.reason).join(' | '), /nothing of its group/u);
});
