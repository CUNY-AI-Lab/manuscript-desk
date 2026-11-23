// The formatter's round 8 tidy-ups and layout settings, on small invented manuscripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readAppearance } from '../lib/docx/appearance.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { runChecks } from '../lib/checks/run.js';
import { layoutKept } from '../lib/checks/summary.js';
import { readDocx } from '../lib/docx/read.js';
import { DECLARED } from '../lib/format/declared.js';
import { followsCase, formatDocx } from '../lib/format/format.js';
import { labelText } from '../lib/format/plan.js';
import { compareWords, documentWords } from '../lib/format/words.js';
import { validateRule } from '../lib/rules/schema.js';
import { readUnits } from '../scripts/format-eval.mjs';
import { sheetWith } from './manuscript-fixture.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = type => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`;

const RUN = '<w:rFonts w:ascii="Book Serif" w:hAnsi="Book Serif"/><w:sz w:val="24"/>';
const run = (text, extra = '') => `<w:r><w:rPr>${RUN}${extra}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (content, pPr = '<w:spacing w:line="480" w:lineRule="auto"/>') => `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`;
const line = text => p(run(text));
const sup = text => `<w:r><w:rPr>${RUN}<w:vertAlign w:val="superscript"/></w:rPr><w:t>${text}</w:t></w:r>`;
const ref = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
const SECTION = (extra = '', margins = '1134') => `<w:sectPr>${extra}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${margins}" w:right="${margins}" w:bottom="${margins}" w:left="${margins}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

/**
 * An invented package from [xml, role] children. Options: notes (footnote bodies by id), a header
 * holding a PAGE field (or other text), a theme whose minor font the defaults use.
 */
function build(children, { notes = {}, header = null } = {}) {
  const body = children.map(([xml]) => xml).join('');
  const roles = {};
  children.forEach(([, role], index) => { if (role) roles[index] = role; });
  const footnotes = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`
    + Object.entries(notes).map(([id, content]) => `<w:footnote w:id="${id}"><w:p><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>${content}</w:p></w:footnote>`).join('') + '</w:footnotes>';
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const theme = `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="${A}"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Theme Display"/></a:majorFont><a:minorFont><a:latin typeface="Theme Sans"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const headerXml = header === null ? null : `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${header === 'page' ? '<w:r><w:rPr><w:rFonts w:ascii="Plain Sans" w:hAnsi="Plain Sans"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:rFonts w:ascii="Plain Sans" w:hAnsi="Plain Sans"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' : `<w:r><w:t>${header}</w:t></w:r>`}</w:p></w:hdr>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL('styles')}" Target="styles.xml"/><Relationship Id="rId2" Type="${REL('footnotes')}" Target="footnotes.xml"/><Relationship Id="rId3" Type="${REL('theme')}" Target="theme/theme1.xml"/>${headerXml ? `<Relationship Id="rId4" Type="${REL('header')}" Target="header1.xml"/>` : ''}</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>${headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}</Types>`;
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL('officeDocument')}" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`),
    'word/_rels/document.xml.rels': strToU8(rels),
    'word/styles.xml': strToU8(styles),
    'word/footnotes.xml': strToU8(footnotes),
    'word/theme/theme1.xml': strToU8(theme),
    ...(headerXml ? { 'word/header1.xml': strToU8(headerXml) } : {}),
  });
  return { bytes, roles };
}

function format(children, rules = [], options = {}) {
  const { bytes, roles } = build(children, options);
  const result = formatDocx({ bytes, roles, sheet: rules.length ? sheetWith(rules) : null, date: '2026-11-23T10:00:00Z' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const validity = validateDocx(result.bytes);
  assert.equal(validity.ok, true, JSON.stringify(validity.problems));
  // The guarantee: every changed word is declared, and rejecting every tracked change gives the source back.
  const words = (input, options2) => { const { files, main } = readPackage(input); return documentWords(files, main, options2); };
  const check = compareWords(words(bytes), words(result.bytes), result.report.declared);
  assert.equal(check.undeclaredRemoved + check.undeclaredAdded, 0, JSON.stringify(check));
  const rejected = compareWords(words(bytes), words(result.bytes, { rejected: true }), []);
  assert.equal(rejected.removed + rejected.added, 0, 'rejecting every tracked change gives the source back');
  return { result, source: bytes, roles };
}
const texts = bytes => readUnits(bytes).units.map(unit => [unit.text, unit.styleName]);
const declared = (result, kind) => result.report.declared.find(entry => entry.kind === kind)?.count ?? 0;
const part = (bytes, name) => strFromU8(unzipSync(bytes)[name]);

const SPLIT = ['chapters.subtitle', 'chapters', { split: true }];
const RESTART = ['notes.restart', 'notes', { per: 'chapter' }];
const chapterBody = text => [line(text), 'body'];

test('a title block is tidied: quotation marks around title and subtitle, the split subtitle\'s capital, brackets, a final full stop, spaces', () => {
  const { result } = format([
    [line('“Paper Lanterns: how invented things are read”  '), 'title-block'],
    [line(' Ada Placeholder'), 'title-block'],
    [line('(University of Elsewhere)'), 'title-block'],
    chapterBody('The chapter begins.'),
    [line('Glass Bells.'), 'title-block'],
    [line('Sounding Invented Objects'), 'title-block'],
    [line('Ben Example'), 'title-block'],
    [line('(Institute of Nowhere)'), 'title-block'],
    chapterBody('The second chapter begins.'),
    [SECTION(), null],
  ], [SPLIT]);
  assert.deepEqual(texts(result.bytes).slice(0, 9), [
    ['Paper Lanterns', 'heading 1'],
    ['How invented things are read', 'Chapter Subtitle'],
    ['Ada Placeholder', 'Chapter Author'],
    ['University of Elsewhere', 'Chapter Affiliation'],
    ['The chapter begins.', 'Body Text First'],
    ['Glass Bells', 'heading 1'],
    ['Sounding Invented Objects', 'Chapter Subtitle'],
    ['Ben Example', 'Chapter Author'],
    ['Institute of Nowhere', 'Chapter Affiliation'],
  ]);
  for (const kind of ['titleQuotes', 'subtitleCapital', 'affiliationBrackets', 'titleStop', 'titleSpaces']) assert.ok(declared(result, DECLARED[kind]) > 0, kind);
  assert.match(part(result.bytes, 'word/document.xml'), /<w:del [^>]*w:author="CAIL Manuscript Desk"[^>]*><w:r>(?:<w:rPr>[^]*?<\/w:rPr>)?<w:delText xml:space="preserve">“<\/w:delText>/);
});

test('a title holding its own quotation keeps its marks; a colon ending a title before its subtitle goes', () => {
  const { result } = format([
    [line('“Out of Time:”'), 'title-block'],
    [line('In a Prison Theatre'), 'title-block'],
    [line('Cy Sample'), 'title-block'],
    chapterBody('Text.'),
    [SECTION(), null],
  ]);
  assert.deepEqual(texts(result.bytes).slice(0, 2), [['“Out of Time”', 'heading 1'], ['In a Prison Theatre', 'Chapter Subtitle']]);
  assert.equal(declared(result, DECLARED.titleQuotes), 0);
  assert.equal(declared(result, DECLARED.titleColon), 1);
});

test('a book\'s title page: the colon goes, a subtitle broken over two lines is joined, "Edited by" is a label and each editor\'s line is split from the institution', () => {
  const { result } = format([
    [line('A Book of Invented Things: '), 'title-page'],
    [line('Essays on Lanterns, Bells'), 'title-page'],
    [line('and Other Objects'), 'title-page'],
    [line('Edited by'), 'title-page'],
    [p(run('Ada Placeholder, University of Elsewhere', '<w:i/>')), 'title-page'],
    [p(run('Ben Example, Institute of Nowhere', '<w:i/>')), 'title-page'],
    [line('Paper Lanterns'), 'title-block'],
    [line('Cy Sample'), 'title-block'],
    chapterBody('Text.'),
    [SECTION(), null],
  ]);
  assert.deepEqual(texts(result.bytes).slice(0, 8), [
    ['A Book of Invented Things', 'Book Title'],
    ['Essays on Lanterns, Bells and Other Objects', 'Book Subtitle'],
    ['Edited by', 'Book Label'],
    ['Ada Placeholder', 'Book Author'],
    ['University of Elsewhere', 'Book Affiliation'],
    ['Ben Example', 'Book Author'],
    ['Institute of Nowhere', 'Book Affiliation'],
    ['Paper Lanterns', 'heading 1'],
  ]);
  assert.equal(declared(result, DECLARED.subtitleJoined), 1);
  assert.equal(declared(result, DECLARED.authorSplit), 2);
});

test('a heading that starts with a line break loses it, as a tracked deletion', () => {
  const { result } = format([
    [line('Paper Lanterns'), 'title-block'],
    [line('Ada Placeholder'), 'title-block'],
    [p(`<w:r><w:rPr>${RUN}</w:rPr><w:br/></w:r>${run('Opening the Box')}`), 'heading-1'],
    chapterBody('Text.'),
    [SECTION(), null],
  ]);
  const heading = readUnits(result.bytes).units.find(unit => unit.styleName === 'heading 2');
  assert.equal(heading.text, 'Opening the Box');
  assert.match(part(result.bytes, 'word/document.xml'), /<w:del [^>]*><w:r>(?:<w:rPr>[^]*?<\/w:rPr>)?<w:br\/><\/w:r><\/w:del>/);
});

function threeBibliographies(headings) {
  return [
    ...headings.flatMap((heading, at) => [
      [line(`Chapter Title ${['One', 'Two', 'Three'][at]}`), 'title-block'],
      [line('Ada Placeholder'), 'title-block'],
      chapterBody('Text.'),
      [line(heading), 'bibliography-heading'],
      [line('Placeholder, Ada. A Book. Nowhere, 2001.'), 'bibliography-entry'],
    ]),
    [SECTION(), null],
  ];
}
const headingsOf = bytes => readUnits(bytes).units.filter(unit => unit.styleName === 'Bibliography Heading').map(unit => unit.text);

test('a heading repeated in every chapter with different capitals is made like most of them, or like the heading-case rule', () => {
  const majority = format(threeBibliographies(['Works cited', 'Works cited', 'Works Cited']));
  assert.deepEqual(headingsOf(majority.result.bytes), ['Works cited', 'Works cited', 'Works cited']);
  const byRule = format(threeBibliographies(['Works cited', 'Works cited', 'Works Cited']), [['headings.case', 'headings', { case: 'title' }]]);
  assert.deepEqual(headingsOf(byRule.result.bytes), ['Works Cited', 'Works Cited', 'Works Cited']);
  assert.equal(declared(byRule.result, DECLARED.headingCase), 2);
  const tie = format(threeBibliographies(['Works cited', 'Works Cited', 'References']));
  assert.deepEqual(headingsOf(tie.result.bytes), ['Works cited', 'Works Cited', 'References'], 'one each: left as they are');
  assert.equal(tie.result.report.needsAuthor['repeated heading typed with different capitals to make the same'], 1);
  assert.equal(followsCase('Works Cited', 'title'), true);
  assert.equal(followsCase('Works cited', 'title'), false);
  assert.equal(followsCase('Works cited', 'sentence'), true);
});

test('a typed copy of a note number next to the automatic one goes, in the text and in the note', () => {
  const { result } = format([
    [line('Paper Lanterns'), 'title-block'],
    [line('Ada Placeholder'), 'title-block'],
    [p(run('A sentence with a note.') + ref(1) + sup('1') + run(' It goes on.')), 'body'],
    [p(run('A square of x') + sup('2') + run(' stays.')), 'body'],
    [SECTION(), null],
  ], [], { notes: { 1: sup('1') + run('The note text.') } });
  assert.equal(declared(result, DECLARED.typedNoteNumber), 2);
  const units = readUnits(result.bytes).units;
  assert.equal(units[2].text, 'A sentence with a note. It goes on.');
  assert.equal(units[3].text, 'A square of x2 stays.', 'superscript digits not next to a note mark stay');
  const notes = part(result.bytes, 'word/footnotes.xml');
  assert.match(notes, /<w:footnoteRef\/><\/w:r><w:del [^>]*><w:r><w:rPr>[^]*?<\/w:rPr><w:delText>1<\/w:delText><\/w:r><\/w:del><w:ins [^>]*><w:r>[^]*?<w:t xml:space="preserve"> <\/w:t><\/w:r><\/w:ins>/, 'the typed number goes and a space stays after the mark');
});

test('Latin text set in another font by direct formatting takes the body font; code, symbol and other-script fonts stay; the defaults take the body font', () => {
  const { result } = format([
    [line('Paper Lanterns'), 'title-block'],
    [line('Ada Placeholder'), 'title-block'],
    [p(run('Most of the text is in the body font, ') + `<w:r><w:rPr><w:rFonts w:ascii="Pasted Sans" w:hAnsi="Pasted Sans" w:eastAsia="Han Serif" w:hint="eastAsia"/></w:rPr><w:t xml:space="preserve">this “part” was pasted</w:t></w:r>` + `<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr><w:t xml:space="preserve"> code()</w:t></w:r>` + `<w:r><w:rPr><w:rFonts w:ascii="Script Serif" w:hAnsi="Script Serif"/></w:rPr><w:t xml:space="preserve"> Բարեւ</w:t></w:r>` + run(' and so on, at some length, so that the body font is clear.')), 'body'],
    [SECTION(), null],
  ]);
  const xml = part(result.bytes, 'word/document.xml');
  assert.doesNotMatch(xml, /Pasted Sans/);
  assert.match(xml, /w:eastAsia="Han Serif"/, 'the East Asian font stays');
  assert.doesNotMatch(xml, /w:hint="eastAsia"/, 'the hint goes from a run without East Asian text');
  assert.match(xml, /Courier New/);
  assert.match(xml, /Script Serif/);
  const styles = part(result.bytes, 'word/styles.xml');
  assert.match(styles, /<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Book Serif" w:hAnsi="Book Serif" w:eastAsia="Book Serif" w:cs="Book Serif"\/>/);
  assert.equal(declared(result, DECLARED.fontRemoved), 1);
  const { paragraphs } = readAppearance(result.bytes);
  assert.ok(paragraphs.every(look => look.characters.filter(entry => entry.slot !== 'eastAsia').every(entry => ['Book Serif', 'Courier New', 'Script Serif'].includes(entry.font))));
});

test('a chapter\'s new section shows its page number on its first page too; the source\'s own section keeps its setting', () => {
  const { result } = format([
    [line('Paper Lanterns'), 'title-block'],
    [line('Ada Placeholder'), 'title-block'],
    chapterBody('One.'),
    [line('Glass Bells'), 'title-block'],
    [line('Ben Example'), 'title-block'],
    chapterBody('Two.'),
    [SECTION('<w:headerReference w:type="default" r:id="rId4"/><w:titlePg/>'), null],
  ], [RESTART], { header: 'page' });
  const sections = readAppearance(result.bytes).sections;
  assert.equal(sections.length, 2);
  assert.equal(sections[0].pageNumber.first?.position, 'top-right', 'the section added at the first chapter\'s end');
  assert.equal(sections[0].pageNumber.first.font, 'Book Serif', 'the page number takes the body font');
  assert.equal(sections[1].pageNumber.first, null, 'the source\'s own section keeps its different first page');
  assert.equal(declared(result, DECLARED.firstPageDropped), 1);
});

test('a section whose margins differ from those of most of the text takes theirs; a landscape section keeps its own', () => {
  const { result } = format([
    [line('Paper Lanterns'), 'title-block'],
    [line('Ada Placeholder'), 'title-block'],
    [p(run('One.'), `<w:spacing w:line="480" w:lineRule="auto"/>${SECTION('', '1440')}`), 'body'],
    [line('Glass Bells'), 'title-block'],
    [line('Ben Example'), 'title-block'],
    chapterBody('Two.'), chapterBody('Three.'),
    [p(run('Four.'), `<w:spacing w:line="480" w:lineRule="auto"/>${SECTION('', '1134')}`), 'body'],
    [p(run('A wide table.'), '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'), null],
    chapterBody('Five.'),
    [SECTION('', '1134'), null],
  ]);
  const sections = readAppearance(result.bytes).sections;
  assert.deepEqual(sections.map(section => section.margins.left), [1134, 1134, 720, 1134]);
  assert.equal(declared(result, DECLARED.pageSetup), 1);
});

test('with a page-number rule, every section shows the number where it asks; headers holding other text are left to the author', () => {
  const children = [
    [line('Paper Lanterns'), 'title-block'],
    [line('Ada Placeholder'), 'title-block'],
    chapterBody('One.'),
    [SECTION('<w:headerReference w:type="default" r:id="rId4"/><w:titlePg/>'), null],
  ];
  const rule = ['layout.page-numbers', 'layout', { position: 'bottom-center' }];
  const placed = format(children, [rule], { header: 'page' });
  const [section] = readAppearance(placed.result.bytes).sections;
  assert.equal(section.pageNumber.first.position, 'bottom-center');
  assert.equal(section.pageNumber.other.position, 'bottom-center');
  assert.equal(declared(placed.result, DECLARED.pageNumbers), 1);
  const left = format(children, [rule], { header: 'A running head' });
  assert.equal(left.result.report.needsAuthor['page numbers to place by hand (the headers or footers hold other text)'], 1);
});

test('with a chapter-label rule, a numbered chapter gets a label line in the form of the example; an introduction does not', () => {
  const { result } = format([
    [line('Introduction'), 'title-block'],
    [line('Ada Placeholder'), 'title-block'],
    chapterBody('Text.'),
    [line('Paper Lanterns'), 'title-block'],
    [line('Ben Example'), 'title-block'],
    chapterBody('Text.'),
    [SECTION(), null],
  ], [['chapters.label', 'chapters', { example: 'Chapter 4' }]]);
  assert.deepEqual(texts(result.bytes).slice(0, 7).map(([text, style]) => `${style}: ${text}`), ['heading 1: Introduction', 'Chapter Author: Ada Placeholder', 'Body Text First: Text.', 'Chapter Label: Chapter 1', 'heading 1: Paper Lanterns', 'Chapter Author: Ben Example', 'Body Text First: Text.']);
  assert.equal(declared(result, DECLARED.labelAdded), 1);
  assert.equal(labelText('Capitolo 9', 2), 'Capitolo 2');
  assert.equal(labelText('Part', 3), 'Part 3');
  assert.equal(validateRule({ id: 'r', category: 'chapters', slot: 'chapters.label', statement: 'x', mode: 'fix', source: { kind: 'author' }, params: { example: 'Chapter 3' } }).ok, true);
  assert.equal(validateRule({ id: 'r', category: 'layout', slot: 'layout.page-numbers', statement: 'x', mode: 'fix', source: { kind: 'author' }, params: { position: 'middle' } }).ok, false);
});

test('the summary says which layout the sheet leaves unset and the file keeps; a check flags names joined in different ways', () => {
  assert.equal(layoutKept({ layout: { line: '480', lineSet: false, pageNumbersSet: false, pageNumbers: 'top right', marginsSet: true, fontSet: true } }),
    'The rule sheet does not set these, so the manuscript keeps its own: the line spacing (double), the page numbers (top right). If the publisher asks for others, add them to the rule sheet and format again.');
  assert.equal(layoutKept({ layout: { line: '360', lineSet: true, pageNumbersSet: true, marginsSet: true, fontSet: true } }), null);
  const children = [
    [line('Paper Lanterns'), 'title-block'], [line('Ada Placeholder, Ben Example'), 'title-block'], chapterBody('Text.'),
    [line('Glass Bells'), 'title-block'], [line('Cy Sample and Di Instance'), 'title-block'], chapterBody('Text.'),
    [line('Tin Drums'), 'title-block'], [line('Ed Person and Flo Other'), 'title-block'], chapterBody('Text.'),
    [SECTION(), null],
  ];
  const { result, source, roles } = format(children);
  const sheet = { ...sheetWith([]), rules: [{ id: 'names', category: 'consistency', slot: null, statement: 'Names alike throughout.', mode: 'flag', source: { kind: 'author' }, params: {}, enabled: true }] };
  const { findings } = runChecks({ paragraphs: readDocx(source).paragraphs, roles, report: result.report, sheet });
  const flagged = findings.filter(finding => finding.kind === 'authors-joined-differently');
  assert.equal(flagged.length, 3);
  assert.match(flagged[0].message, /“ and ” 2 times, “, ” once/);
});
