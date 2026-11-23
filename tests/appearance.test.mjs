import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { fontSlot, readAppearance, strayFonts } from '../lib/docx/appearance.js';
import { chaptersOf, comparePairs, matchParagraphs, valueOf } from '../scripts/render-eval.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;

// An invented package: theme fonts, defaults, a style chain, numbering, a header and a footer.
function invented({ body, styles = '', footnotes = '' }) {
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr><w:rPr><w:rFonts w:ascii="Book Serif" w:hAnsi="Book Serif"/><w:sz w:val="24"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Block Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Listed"><w:name w:val="Listed"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr></w:style>`
    + `<w:style w:type="character" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:style>${styles}</w:styles>`;
  const theme = `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="${A}"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Display Sans"/></a:majorFont><a:minorFont><a:latin typeface="Theme Sans"/><a:ea typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="1"><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const header = `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:hdr>`;
  const footer = `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'styles', 'styles.xml')}${rel('rId2', 'theme', 'theme/theme1.xml')}${rel('rId3', 'numbering', 'numbering.xml')}${rel('rId4', 'header', 'header1.xml')}${rel('rId5', 'footer', 'footer1.xml')}${footnotes ? rel('rId6', 'footnotes', 'footnotes.xml') : ''}</Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(rels),
    'word/styles.xml': strToU8(stylesXml),
    'word/theme/theme1.xml': strToU8(theme),
    'word/numbering.xml': strToU8(numbering),
    'word/header1.xml': strToU8(header),
    'word/footer1.xml': strToU8(footer),
    ...(footnotes ? { 'word/footnotes.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="${W}">${footnotes}</w:footnotes>`) } : {}),
  });
}

const p = (text, pPr = '', rPr = '') => `<w:p><w:pPr>${pPr}</w:pPr><w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const SECTION = (extra = '') => `<w:sectPr><w:headerReference w:type="default" r:id="rId4"/>${extra}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="708" w:footer="708"/></w:sectPr>`;

test('a paragraph\'s look is resolved through defaults, its style chain, numbering and direct formatting', () => {
  const bytes = invented({ body: [
    p('Plain text in the default style.'),
    p('A quotation set off.', '<w:pStyle w:val="Quote"/>'),
    p('A listed line.', '<w:pStyle w:val="Listed"/>'),
    p('Direct spacing wins.', '<w:pStyle w:val="Quote"/><w:spacing w:before="240" w:line="480" w:lineRule="auto"/><w:ind w:firstLine="425"/><w:jc w:val="center"/>', '<w:sz w:val="28"/>'),
    SECTION(),
  ].join('') });
  const { paragraphs, normalFont } = readAppearance(bytes);
  assert.equal(normalFont, 'Book Serif');
  const [plain, quote, listed, direct] = paragraphs;
  assert.deepEqual([plain.font, plain.size, plain.line, plain.after, plain.jc, plain.styleName], ['Book Serif', 24, 360, 0, 'both', 'Normal']);
  assert.deepEqual([quote.left, quote.size, quote.line], [567, 20, 360], 'the style chain gives the indent and size, Normal the spacing');
  assert.deepEqual([listed.left, listed.firstLine], [720, -360], 'numbering gives a hanging indent');
  assert.deepEqual([direct.before, direct.line, direct.firstLine, direct.jc, direct.size, direct.left], [240, 480, 425, 'center', 28, 567]);
  assert.equal(valueOf(direct, 'line'), '2');
  assert.equal(valueOf(plain, 'line'), '1.5');
  assert.equal(valueOf(direct, 'size'), 14);
});

test('theme fonts resolve through the theme; a named font at a later level replaces them', () => {
  const bytes = invented({
    styles: '<w:style w:type="paragraph" w:styleId="Bare"><w:name w:val="Bare"/></w:style>',
    body: [p('Text in a style based on nothing.', '<w:pStyle w:val="Bare"/>'), p('Code here', '', '<w:rStyle w:val="Code"/>'), SECTION()].join(''),
  });
  const { paragraphs } = readAppearance(bytes);
  assert.equal(paragraphs[0].font, 'Theme Sans', 'the defaults name the theme\'s minor font');
  assert.equal(paragraphs[1].font, 'Courier New', 'a character style sets its font');
  assert.deepEqual([...strayFonts(paragraphs, 'Book Serif')], [['Theme Sans', 'Textinastylebasedonnothing.'.length]], 'code fonts are not counted as stray');
});

test('East Asian characters take the East Asian font; Latin text in another font is stray', () => {
  assert.equal(fontSlot('漢'), 'eastAsia');
  assert.equal(fontSlot('a'), 'ascii');
  assert.equal(fontSlot('é'), 'hAnsi');
  assert.equal(fontSlot('“', 'eastAsia'), 'eastAsia');
  assert.equal(fontSlot('“'), 'hAnsi');
  const bytes = invented({ body: [p('Latin 漢字', '', '<w:rFonts w:ascii="Pasted Font" w:hAnsi="Pasted Font" w:eastAsia="Han Font"/>'), SECTION()].join('') });
  const { paragraphs } = readAppearance(bytes);
  const fonts = paragraphs[0].characters.map(entry => entry.font);
  assert.deepEqual(fonts, ['Pasted Font', 'Pasted Font', 'Pasted Font', 'Pasted Font', 'Pasted Font', 'Han Font', 'Han Font']);
  assert.deepEqual([...strayFonts(paragraphs, 'Book Serif')], [['Pasted Font', 5]]);
});

test('sections give their page, margins, note numbering and where the page number stands, inheriting headers', () => {
  const bytes = invented({ body: [
    p('First section.'),
    `<w:p><w:pPr>${SECTION('<w:footerReference w:type="first" r:id="rId5"/>').replace('<w:pgSz', '<w:titlePg/><w:pgSz')}</w:pPr><w:r><w:t>One</w:t></w:r></w:p>`,
    p('Second section, with no references of its own.'),
    '<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
  ].join('') });
  const { sections } = readAppearance(bytes);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].pageNumber.first.position, 'bottom-center', 'the first page shows the first-page footer');
  assert.equal(sections[0].pageNumber.other.position, 'top-right');
  assert.deepEqual([sections[0].width, sections[0].margins.left, sections[0].noteRestart], [11906, 1134, 'continuous']);
  assert.equal(sections[1].pageNumber.other.position, 'top-right', 'a section without references keeps the headers before it');
  assert.equal(sections[1].pageNumber.first.position, 'top-right', 'and without a title page its first page is like the others');
  assert.deepEqual([sections[1].width, sections[1].noteRestart], [12240, 'eachSect']);
});

test('matched paragraphs are compared property by property, with the differences grouped by class', () => {
  const look = (text, line, size = 24) => ({ text, font: 'Book Serif', size, line, lineRule: 'auto', before: 0, after: 0, left: 0, right: 0, firstLine: 0, jc: 'both', styleName: 'Body Text' });
  const tool = [look('Alpha paragraph text', 480), look('Beta paragraph text', 480), look('Gamma only here', 480)];
  const reference = [look('Alpha paragraph text', 360), look('Beta paragraph text', 480, 22), look('Delta only there', 360)];
  const matched = matchParagraphs(tool, reference);
  assert.equal(matched.pairs.length, 2);
  const { groups, classes } = comparePairs(matched.pairs.map(([a, b]) => [a, b, 'dev']));
  assert.equal(groups.get('dev').pairs, 2);
  assert.equal(groups.get('dev').agree.line, 1);
  assert.equal(groups.get('dev').agree.size, 1);
  assert.equal(groups.get('dev').agree.font, 2);
  assert.deepEqual([...classes], [['line: 2 -> 1.5 (reference Body Text)', 1], ['size: 12 -> 11 (reference Body Text)', 1]]);
});

test('a tool paragraph takes the chapter of the source paragraph it came from, or of the one before it', () => {
  const source = [{ index: 0, text: 'Front title' }, { index: 1, text: 'Chapter one title' }, { index: 2, text: 'Its text' }, { index: 3, text: 'Chapter two title' }];
  const gold = { chapters: [{ key: 'one', first: 1, last: 2 }, { key: 'two', first: 3, last: 3 }], matter: [{ key: 'front', first: 0, last: 0 }], dev: ['one'], holdout: ['two'] };
  const looks = [{ text: 'Front title' }, { text: 'Chapter one title' }, { text: 'An added caption line' }, { text: 'Its text' }, { text: 'Chapter two title' }];
  const chapters = chaptersOf(looks, source, gold);
  assert.deepEqual(looks.map(look => chapters.get(look)), ['matter', 'one', 'one', 'one', 'two']);
});
