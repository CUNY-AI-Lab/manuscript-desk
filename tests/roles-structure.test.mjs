import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { readDocx } from '../lib/docx/read.js';
import { structureRoles } from '../lib/roles/structure.js';
import { afterLabelling, newLabels } from '../web/format/manuscript-state.js';

// Word files built here from XML written for these tests; every text is invented.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const DOC_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="custom-styles.xml"/></Relationships>';
const style = (id, name, pPr = '', basedOn = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ''}${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}</w:style>`;
// Localized style ids, as a Word in another language writes them; the names stay the built-in ones.
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}">${style('Normale', 'Normal')}${style('Titolo1', 'heading 1', '<w:keepNext/>', 'Normale')}${style('Titolo2', 'heading 2', '<w:outlineLvl w:val="1"/>', 'Normale')}${style('Capitolo', 'Chapter Head', '<w:pageBreakBefore/>', 'Titolo1')}${style('Sommario1', 'toc 1')}${style('Sommario2', 'toc 2')}</w:styles>`;
const docx = body => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  '_rels/.rels': strToU8(RELS),
  'word/_rels/document.xml.rels': strToU8(DOC_RELS),
  'word/custom-styles.xml': strToU8(STYLES),
  'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`),
});
const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (content, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
const styled = (id, text, extra = '') => para(run(text), `<w:pStyle w:val="${id}"/>${extra}`);
const marked = (id, name, text) => para(`<w:bookmarkStart w:id="${name.length}" w:name="${name}"/>${run(text)}<w:bookmarkEnd w:id="${name.length}"/>`, `<w:pStyle w:val="${id}"/>`);
const tocLine = (id, anchor, text) => `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr><w:hyperlink w:anchor="${anchor}">${run(`${text}\t`)}</w:hyperlink></w:p>`;
const sectionEnd = type => para('', `<w:sectPr>${type ? `<w:type w:val="${type}"/>` : ''}<w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`);
const read = body => {
  const result = readDocx(docx(body));
  assert.equal(result.ok, true);
  return result.paragraphs;
};

test('the reader gives each paragraph its style name and outline level, through the styles it is based on', () => {
  const [one, two, chapter, plain, direct] = read(styled('Titolo1', 'Harbour Lights') + styled('Titolo2', 'Low Tide') + styled('Capitolo', 'Driftwood') + para(run('Plain text.')) + para(run('Promoted text'), '<w:outlineLvl w:val="0"/>'));
  assert.deepEqual(one.structure, { styleName: 'heading 1', outline: 0, newPage: false, toc: null }, 'a built-in heading style without an outline level has its own');
  assert.equal(two.structure.outline, 1);
  assert.deepEqual([chapter.structure.styleName, chapter.structure.outline, chapter.structure.newPage], ['Chapter Head', 0, true], 'based on heading 1, with a page break before it from its style');
  assert.deepEqual(plain.structure, { styleName: null, outline: null, newPage: false, toc: null });
  assert.equal(direct.structure.outline, 0, 'an outline level set on the paragraph itself');
  assert.equal(one.hints.pageBreak, false, 'the hints the labelling passage shows are unchanged');
});

test('a paragraph starts a new page after a section break, a page break that ends the text before it, or one before its own text', () => {
  const list = read(para(run('Before.')) + sectionEnd() + styled('Titolo1', 'First')
    + para(run('More.')) + sectionEnd('continuous') + styled('Titolo1', 'Same page')
    + para(`${run('Last line.')}<w:r><w:br w:type="page"/></w:r>`) + para('') + styled('Titolo1', 'After a break')
    + para(`<w:r><w:br w:type="page"/></w:r>${run('Opening words')}`)
    + para(`${run('Words')}<w:r><w:br w:type="page"/></w:r>${run('then more')}`) + styled('Titolo1', 'Not after a break'));
  const page = text => list.find(entry => entry.text.includes(text)).structure.newPage;
  assert.equal(page('First'), true, 'a section break with no type starts a new page');
  assert.equal(page('Same page'), false, 'a continuous section break does not');
  assert.equal(page('After a break'), true, 'a page break at the end of the text before it, an empty paragraph between');
  assert.equal(page('Opening words'), true);
  assert.equal(page('Not after a break'), false, 'a page break with text after it, in the paragraph before, does not end that page');
});

test('the contents list gives each heading its level, by its links or by a line with its words', () => {
  const toc = `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${tocLine('Sommario1', '_A', 'Introduction')}${tocLine('Sommario1', '_B', 'Salt Roads')}${tocLine('Sommario2', '_C', 'Ledgers')}</w:sdtContent></w:sdt>`;
  const typed = styled('Sommario1', 'Coda\t40');
  const list = read(toc + typed + marked('Titolo1', '_A', 'Introduction') + marked('Titolo1', '_B', 'Salt Roads') + marked('Titolo2', '_C', 'Ledgers') + styled('Titolo1', 'Coda') + styled('Titolo2', 'Unlisted'));
  const level = text => list.filter(entry => entry.text === text).map(entry => entry.structure.toc);
  assert.deepEqual(level('Introduction'), [1]);
  assert.deepEqual(level('Salt Roads'), [1]);
  assert.deepEqual(level('Ledgers'), [2]);
  assert.deepEqual(level('Coda'), [1], 'a contents line typed without a link, matched by its words');
  assert.deepEqual(level('Unlisted'), [null]);
  assert.equal(list.find(entry => entry.text === 'Coda\t40').structure.toc, null, 'the contents line itself has no level');
});

test('a styles part that cannot be read leaves the file readable, without style evidence', () => {
  const files = { '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), '_rels/.rels': strToU8(RELS), 'word/styles.xml': strToU8('<w:styles xmlns:w="x"><unclosed>'), 'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body>${styled('Heading1', 'A title')}</w:body></w:document>`) };
  const result = readDocx(zipSync(files));
  assert.equal(result.ok, true);
  assert.deepEqual(result.paragraphs[0].structure, { styleName: null, outline: null, newPage: false, toc: null });
});

// Paragraph models written directly, for the pass.
let next = 0;
const entry = (text, structure = {}) => ({ index: next++, kind: 'paragraph', text, hints: { empty: false }, structure: { styleName: null, outline: null, newPage: false, toc: null, ...structure } });
const top = { styleName: 'heading 1', outline: 0, newPage: true, toc: 1 };
const section = { styleName: 'heading 2', outline: 1, newPage: false, toc: 2 };
const sub = { styleName: 'heading 3', outline: 2, newPage: false, toc: 3 };

// A single-author dissertation: chapters typed in Heading 1, read by the model as headings.
function dissertation() {
  next = 0;
  const list = [
    [entry('Invented Harbours', {}), 'title-page'],
    [entry('Contents', { ...top, toc: null }), 'front-matter-heading'],
    [entry('Introduction\t1'), 'contents-entry'],
    [entry('Acknowledgments', top), 'heading-1'],
    [entry('I thank the harbour masters.'), 'body'],
    [entry('Introduction', top), 'heading-1'],
    [entry('This study begins at the quay.'), 'body'],
    [entry('Salt Roads', top), 'heading-1'],
    [entry('A first section', section), 'heading-1'],
    [entry('Ships came in.'), 'body'],
    [entry('A smaller part', sub), 'heading-1'],
    [entry('Ledgers', top), 'heading-1'],
    [entry('Counting', section), 'heading-2'],
    [entry('Cargo was counted.'), 'body'],
    [entry('Bibliography', top), 'heading-1'],
    [entry('Placeholder, A. An Invented Book. 2020.'), 'bibliography-entry'],
  ];
  return { paragraphs: list.map(([paragraph]) => paragraph), roles: Object.fromEntries(list.map(([paragraph, role]) => [paragraph.index, role])) };
}
const byText = (paragraphs, roles) => Object.fromEntries(paragraphs.map(paragraph => [paragraph.text, roles[paragraph.index]]));

test('in a dissertation, top-level headings that start pages and lead the contents list are chapter titles', () => {
  const { paragraphs, roles } = dissertation();
  const { roles: after, changes } = structureRoles(paragraphs, roles, { docType: 'dissertation' });
  const got = byText(paragraphs, after);
  assert.equal(got.Introduction, 'title-block');
  assert.equal(got['Salt Roads'], 'title-block');
  assert.equal(got.Ledgers, 'title-block');
  assert.equal(got.Acknowledgments, 'front-matter-heading', 'a top-level heading naming a front-matter part heads that part');
  assert.equal(got.Bibliography, 'bibliography-heading');
  assert.equal(got['A first section'], 'heading-1');
  assert.equal(got['A smaller part'], 'heading-2', 'levelled again under the chapter title by the contents list');
  assert.equal(got.Counting, 'heading-1', 'a chapter whose only heading was read one level down');
  for (const kind of ['Invented Harbours', 'Contents', 'This study begins at the quay.', 'Ships came in.']) assert.equal(got[kind], roles[paragraphs.find(paragraph => paragraph.text === kind).index], 'other labels stay');
  assert.ok(changes.every(change => change.evidence.length > 0));
  assert.deepEqual(roles[5], 'heading-1', 'the roles given are not changed in place');
});

test('a monograph is treated the same; an article or an edited collection is left as the model read it', () => {
  const { paragraphs, roles } = dissertation();
  assert.equal(byText(paragraphs, structureRoles(paragraphs, roles, { docType: 'monograph' }).roles)['Salt Roads'], 'title-block');
  for (const docType of ['article', 'edited-collection', undefined]) {
    const { roles: after, changes } = structureRoles(paragraphs, roles, { docType });
    assert.deepEqual(after, roles);
    assert.equal(changes.length, 0);
  }
});

test('one sign alone, or one heading so marked, is not enough', () => {
  next = 0;
  const pages = [entry('Opening', { newPage: true }), entry('Text.'), entry('Second', { newPage: true }), entry('More text.')];
  const roles = { 0: 'heading-1', 1: 'body', 2: 'heading-1', 3: 'body' };
  assert.equal(structureRoles(pages, roles, { docType: 'dissertation' }).changes.length, 0, 'headings that start pages but carry no outline level or contents level');
  next = 0;
  const single = [entry('Only Chapter', top), entry('Text.'), entry('A section', section), entry('More.')];
  assert.equal(structureRoles(single, { 0: 'heading-1', 1: 'body', 2: 'heading-2', 3: 'body' }, { docType: 'dissertation' }).changes.length, 0);
});

test('chapters the model found in a style of their own, with Heading 1 for sections, are left alone', () => {
  next = 0;
  const list = [entry('Chapter One', {}), entry('Text.'), entry('A section', { ...top, newPage: false }), entry('Chapter Two', {}), entry('A second section', { ...top, newPage: false }), entry('More.')];
  const roles = { 0: 'title-block', 1: 'body', 2: 'heading-1', 3: 'title-block', 4: 'heading-1', 5: 'body' };
  const result = structureRoles(list, roles, { docType: 'monograph' });
  assert.deepEqual(result.roles, roles);
});

test('a "Chapter 3" label line read as a heading joins its title block', () => {
  next = 0;
  const list = [entry('Chapter 1', top), entry('Salt Roads', { ...top, newPage: false }), entry('Text.'), entry('Chapter 2', top), entry('Ledgers', { ...top, newPage: false }), entry('More.')];
  const roles = { 0: 'heading-1', 1: 'heading-1', 2: 'body', 3: 'heading-1', 4: 'heading-2', 5: 'body' };
  const after = structureRoles(list, roles, { docType: 'dissertation' }).roles;
  assert.deepEqual([after[0], after[1], after[3], after[4]], ['title-block', 'title-block', 'title-block', 'title-block']);
});

test('the abstract page’s title lines, read as a chapter title block before the first chapter, are the abstract’s', () => {
  next = 0;
  const list = [entry('ABSTRACT'), entry('Invented Harbours'), entry('by'), entry('Rowan Placeholder'), entry('This dissertation reads harbours.'), entry('Introduction', top), entry('Text.'), entry('Salt Roads', top), entry('More.')];
  const roles = { 0: 'front-matter-heading', 1: 'title-block', 2: 'title-block', 3: 'title-block', 4: 'abstract', 5: 'heading-1', 6: 'body', 7: 'title-block', 8: 'body' };
  const after = structureRoles(list, roles, { docType: 'dissertation' }).roles;
  assert.deepEqual([after[1], after[2], after[3], after[5], after[7]], ['abstract', 'abstract', 'abstract', 'title-block', 'title-block']);
});

test('the page runs the pass after labelling, for the document type chosen in step 1, and says how many chapters it found', () => {
  const { paragraphs, roles } = dissertation();
  const labels = newLabels({ hash: 'h', name: 'invented.docx', paragraphs: paragraphs.length, model: 'm' });
  const done = afterLabelling(labels, { roles, failures: [] }, { paragraphs, docType: 'dissertation' });
  assert.equal(done.roles[7], 'title-block');
  assert.equal(done.structured, 3);
  const article = afterLabelling(done, { roles, failures: [] }, { paragraphs, docType: 'article' });
  assert.equal(article.roles[7], 'heading-1');
  assert.equal(article.structured, undefined, 'a count from an earlier run does not stay');
  assert.equal(afterLabelling(labels, { roles, failures: [] }).roles[7], 'heading-1', 'without the paragraphs, the roles are the model’s');
});
