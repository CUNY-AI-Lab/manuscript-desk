import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { MAX_DOCX_BYTES, readDocx } from '../lib/docx/read.js';

// Word files built here from XML written for these tests.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
const documentXml = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}</w:body></w:document>`;
const docx = (body, extra = {}) => zipSync({ '[Content_Types].xml': strToU8(TYPES), '_rels/.rels': strToU8(RELS), 'word/document.xml': strToU8(documentXml(body)), ...extra });
const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (runs, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
const read = async body => {
  const result = await readDocx(docx(body));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.paragraphs;
};

test('one entry per top-level child of w:body, in order, with its kind', async () => {
  const paragraphs = await read(para(run('A plain opening sentence.'))
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p/>'
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>');
  assert.deepEqual(paragraphs.map(entry => [entry.index, entry.kind]), [[0, 'paragraph'], [1, 'table'], [2, 'paragraph'], [3, 'other']]);
  assert.equal(paragraphs[0].text, 'A plain opening sentence.');
  assert.equal(paragraphs[1].text, 'cell one\tcell two');
  assert.equal(paragraphs[2].hints.empty, true);
  assert.equal(paragraphs[3].hints.empty, true);
});

test('reads text inside content-control wrappers, hyperlinks, tabs and line breaks', async () => {
  const [entry] = await read(para(`${run('Before ')}<w:sdt><w:sdtPr><w:id w:val="1"/></w:sdtPr><w:sdtContent>${run('wrapped')}</w:sdtContent></w:sdt>`
    + `<w:hyperlink r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${run(' linked')}</w:hyperlink>`
    + '<w:r><w:tab/><w:t>after tab</w:t><w:br/><w:t>next line</w:t></w:r>'));
  assert.equal(entry.text, 'Before wrapped linked\tafter tab\nnext line');
});

test('skips deleted text, field instructions and fallback copies of drawings', async () => {
  const [entry] = await read(para('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF x </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + run('7') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    + '<w:del w:id="1" w:author="a"><w:r><w:delText>gone</w:delText></w:r></w:del>'
    + '<mc:AlternateContent><mc:Choice Requires="wps">' + run(' boxed') + '</mc:Choice><mc:Fallback>' + run(' boxed') + '</mc:Fallback></mc:AlternateContent>'));
  assert.equal(entry.text, '7 boxed');
});

test('hints: alignment, indents, style, bold, italic and a single size', async () => {
  const [centred, quoted, mixed, styled] = await read(
    para(run('Title words', '<w:b/><w:sz w:val="32"/>') + run(' more', '<w:b w:val="1"/><w:sz w:val="32"/>'), '<w:jc w:val="center"/>')
    + para(run('An indented passage', '<w:i/><w:sz w:val="20"/>'), '<w:jc w:val="both"/><w:ind w:left="720" w:right="360" w:firstLine="0"/>')
    + para(run('Partly ', '<w:b/><w:sz w:val="24"/>') + run('bold', '<w:b w:val="0"/><w:i/><w:sz w:val="22"/>'), '<w:ind w:start="360" w:hanging="360"/>')
    + para(run('Styled'), '<w:pStyle w:val="Heading1"/><w:jc w:val="left"/>'),
  );
  assert.deepEqual(centred.hints, { align: 'center', indentLeft: 0, indentRight: 0, indentFirst: 0, styleId: null, bold: true, italic: false, size: 16, list: false, pageBreak: false, image: false, footnote: false, empty: false });
  assert.deepEqual(quoted.hints, { align: 'justify', indentLeft: 36, indentRight: 18, indentFirst: 0, styleId: null, bold: false, italic: true, size: 10, list: false, pageBreak: false, image: false, footnote: false, empty: false });
  assert.equal(mixed.hints.bold, false);
  assert.equal(mixed.hints.italic, false);
  assert.equal(mixed.hints.size, null, 'two sizes is no single size');
  assert.equal(mixed.hints.indentLeft, 18);
  assert.equal(mixed.hints.indentFirst, -18, 'a hanging indent is a negative first-line indent');
  assert.equal(styled.hints.styleId, 'Heading1');
  assert.equal(styled.hints.align, 'left');
  assert.equal(styled.hints.size, null, 'no size set');
});

test('bold and italic ignore runs that hold only spaces; the paragraph mark is not a run', async () => {
  const [entry] = await read(para(run('Bold words', '<w:b/>') + run('   ') + '<w:r><w:tab/></w:r>', '<w:rPr><w:i/></w:rPr>'));
  assert.equal(entry.hints.bold, true);
  assert.equal(entry.hints.italic, false);
});

test('hints: image, footnote reference, list numbering and page break', async () => {
  const [figure, noted, listed, broken, before] = await read(
    para('<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture"/></wp:inline></w:drawing></w:r>')
    + para(run('A sentence with a note.') + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r>')
    + para(run('First point'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>')
    + para('<w:r><w:br w:type="page"/></w:r>' + run('After a page break'))
    + para(run('Starts a page'), '<w:pageBreakBefore/>'),
  );
  assert.equal(figure.hints.image, true);
  assert.equal(figure.hints.empty, false, 'an image alone is not empty');
  assert.equal(figure.text, '');
  assert.equal(noted.hints.footnote, true);
  assert.deepEqual(noted.notes, [23], 'where the note reference stands in the text');
  assert.equal(noted.text, 'A sentence with a note.');
  assert.equal(listed.notes, undefined, 'no notes, no list of them');
  assert.equal(listed.hints.list, true);
  assert.equal(broken.hints.pageBreak, true);
  assert.equal(broken.text, 'After a page break', 'a page break adds no text');
  assert.equal(before.hints.pageBreak, true);
});

test('decodes entities and keeps spaces in preserved text', async () => {
  const [entry] = await read(para(run('Fish &amp; chips &lt;3 ') + run('  two  spaces')));
  assert.equal(entry.text, 'Fish & chips <3   two  spaces');
});

test('follows the package relationship to the main document part', async () => {
  const rels = RELS.replace('word/document.xml', 'word/main.xml');
  const bytes = zipSync({ '_rels/.rels': strToU8(rels), 'word/main.xml': strToU8(documentXml(para(run('Found it.')))) });
  const result = await readDocx(bytes);
  assert.equal(result.ok, true);
  assert.equal(result.paragraphs[0].text, 'Found it.');
});

test('accepts bytes as a Uint8Array or an ArrayBuffer', async () => {
  const bytes = docx(para(run('Either way.')));
  assert.equal((await readDocx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).paragraphs[0].text, 'Either way.');
});

test('never throws on a malformed file: a typed failure with a message', async () => {
  const cases = [
    [new Uint8Array(0), 'not_docx'],
    [strToU8('%PDF-1.7 not a word file'), 'not_docx'],
    [strToU8('PK\u0003\u0004 truncated zip'), 'unreadable'],
    [zipSync({ 'other.txt': strToU8('no document here') }), 'not_docx'],
    [zipSync({ '_rels/.rels': strToU8(RELS), 'word/document.xml': strToU8('<w:document><w:body><w:p>') }), 'unreadable'],
    [zipSync({ '_rels/.rels': strToU8(RELS), 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="${W}"></w:document>`) }), 'unreadable'],
    [null, 'not_docx'],
    ['a string', 'not_docx'],
  ];
  for (const [bytes, code] of cases) {
    const result = await readDocx(bytes);
    assert.equal(result.ok, false);
    assert.equal(result.code, code, String(bytes).slice(0, 40));
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 10);
  }
});

test('refuses a file over the size limit before unzipping it', async () => {
  const result = await readDocx(new Uint8Array(MAX_DOCX_BYTES + 1));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'too_large');
});
