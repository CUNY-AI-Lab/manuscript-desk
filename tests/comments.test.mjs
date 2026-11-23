import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { COMMENT_AUTHOR, addComments } from '../lib/docx/comments.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { descendants, elements, firstWord, isWord, parseXml, wordAttribute } from '../lib/docx/xml.js';
import { formatDocx } from '../lib/format/format.js';
import { compareWords, documentWords, textOf } from '../lib/format/words.js';
import { RULES, manuscript, sheetWith } from './manuscript-fixture.mjs';

const formatted = () => {
  const { bytes, roles } = manuscript();
  const result = formatDocx({ bytes, roles, sheet: sheetWith([RULES.restart, RULES.split]) });
  assert.equal(result.ok, true);
  return { source: bytes, ...result };
};
const part = (bytes, name) => strFromU8(unzipSync(bytes)[name]);
// The text of each body paragraph that holds a comment range, by comment id.
function anchored(bytes) {
  const { files, main } = readPackage(bytes);
  const body = firstWord(parseXml(files.get(main)).root, 'body');
  const out = {};
  for (const paragraph of descendants(body, 'p')) {
    for (const start of elements(paragraph, 'commentRangeStart')) out[wordAttribute(start, 'id')] = textOf(paragraph);
  }
  return out;
}

test('comments are anchored on the paragraph each source paragraph became, by CAIL Manuscript Desk', () => {
  const { bytes, report } = formatted();
  // Source paragraph 3 is the first chapter's title (split into title and subtitle); 12 a quotation.
  const result = addComments(bytes, { map: report.map, comments: [{ sourceIndex: null, text: 'At the top.\nA second line.' }, { sourceIndex: 3, text: 'On the title.' }, { sourceIndex: 12, text: 'On the quotation.' }], date: '2026-11-22T12:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(result.written, 3);
  const validity = validateDocx(result.bytes);
  assert.deepEqual(validity.problems, []);
  assert.equal(validity.counts.comments, 3);
  const texts = Object.entries(anchored(result.bytes)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, text]) => text);
  assert.match(texts[0], /A Volume of Invented Essays/);
  assert.equal(texts[1], 'Paper Lanterns', 'the first paragraph the title became');
  assert.match(texts[2], /^A quotation set off/);
  const comments = part(result.bytes, 'word/comments.xml');
  assert.equal((comments.match(new RegExp(`w:author="${COMMENT_AUTHOR}"`, 'g')) ?? []).length, 3);
  assert.match(comments, /<w:comment w:id="\d+" w:author="CAIL Manuscript Desk" w:date="2026-11-22T12:00:00Z" w:initials="CMD"><w:p><w:r><w:annotationRef\/><\/w:r><w:r><w:t xml:space="preserve">At the top\.<\/w:t><\/w:r><\/w:p><w:p><w:r><w:t xml:space="preserve">A second line\.<\/w:t>/);
  assert.match(part(result.bytes, '[Content_Types].xml'), /PartName="\/word\/comments\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.comments\+xml"/);
  assert.match(part(result.bytes, 'word/_rels/document.xml.rels'), /relationships\/comments" Target="comments\.xml"/);
  // The words of the document are untouched.
  const words = file => { const { files, main } = readPackage(file); return documentWords(files, main); };
  const check = compareWords(words(bytes), words(result.bytes), []);
  assert.equal(check.removed + check.added, 0);
});

test('comment text is written as text: markup characters are escaped and characters XML forbids are dropped', () => {
  const { bytes, report } = formatted();
  const result = addComments(bytes, { map: report.map, comments: [{ sourceIndex: 3, text: 'A <w:b/> & "quoted" \'thing\'\u0001 here' }] });
  assert.equal(result.ok, true);
  const comments = part(result.bytes, 'word/comments.xml');
  assert.match(comments, /A &lt;w:b\/&gt; &amp; "quoted" 'thing' here/);
  assert.equal(validateDocx(result.bytes).ok, true);
});

test('comments the file already has are kept, and new ones take ids above theirs', () => {
  const { bytes, report } = formatted();
  const first = addComments(bytes, { map: report.map, comments: [{ sourceIndex: 3, text: 'An earlier comment.' }] });
  const second = addComments(first.bytes, { map: report.map, comments: [{ sourceIndex: 12, text: 'A later one.' }] });
  assert.equal(second.ok, true);
  const ids = elements(parseXml(unzipSync(second.bytes)['word/comments.xml']).root, 'comment').map(node => Number(wordAttribute(node, 'id')));
  assert.equal(ids.length, 2);
  assert.equal(ids[1], ids[0] + 1);
  // Above every other annotation's id (the bookmark and the tracked changes share the space).
  const { files, main } = readPackage(bytes);
  const others = [...descendants(parseXml(files.get(main)).root)].filter(node => ['bookmarkStart', 'ins', 'del'].includes(node.local)).map(node => Number(wordAttribute(node, 'id')));
  assert.ok(others.length > 1 && ids[0] > Math.max(...others));
  assert.deepEqual(validateDocx(second.bytes).problems, []);
  assert.equal((part(second.bytes, '[Content_Types].xml').match(/comments\.xml/g) ?? []).length, 1, 'one content type for the part');
});

test('a map that does not fit the file is a typed failure, not a guess', () => {
  const { bytes, report } = formatted();
  assert.deepEqual(addComments(bytes, { map: report.map.slice(1), comments: [] }), { ok: false, code: 'map_mismatch' });
  assert.deepEqual(addComments(new Uint8Array([1, 2, 3]), { map: [], comments: [] }), { ok: false, code: 'unreadable' });
});

test('the validator reports comments that are undefined, unanchored, unreferenced or open', () => {
  const { bytes, report } = formatted();
  const good = addComments(bytes, { map: report.map, comments: [{ sourceIndex: 3, text: 'A comment.' }] }).bytes;
  const files = unzipSync(good);
  const document = strFromU8(files['word/document.xml']);
  const id = /<w:commentRangeStart w:id="(\d+)"\/>/.exec(document)[1];
  const broken = edits => zipSync({ ...files, ...Object.fromEntries(Object.entries(edits).map(([name, text]) => [name, strToU8(text)])) });
  const codes = bytesIn => validateDocx(bytesIn).problems.map(problem => problem.code).sort();
  assert.deepEqual(codes(broken({ 'word/document.xml': document.replace(`<w:commentRangeEnd w:id="${id}"/>`, '') })), ['comment_range_unpaired']);
  assert.deepEqual(codes(broken({ 'word/document.xml': document.replace(new RegExp(`<w:commentRangeStart w:id="${id}"/>|<w:commentRangeEnd w:id="${id}"/>|<w:r><w:commentReference w:id="${id}"/></w:r>`, 'g'), '') })), ['comment_unreferenced']);
  const renamed = validateDocx(broken({ 'word/document.xml': document.replaceAll(`w:id="${id}"/>`, 'w:id="999"/>') })).problems;
  assert.deepEqual(renamed.map(({ code, count }) => [code, count]), [['comment_undefined', 3], ['comment_unreferenced', 1]]);
  const comments = strFromU8(files['word/comments.xml']);
  assert.deepEqual(codes(broken({ 'word/comments.xml': comments.replace(' w:author="CAIL Manuscript Desk"', '') })), ['comment_without_author']);
  assert.ok(isWord(parseXml(files['word/comments.xml']).root, 'comments'));
});
