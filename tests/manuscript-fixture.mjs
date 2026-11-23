// Builds an invented two-chapter manuscript as a .docx, typed with direct formatting and no styles,
// the way a word processor's export arrives, for the formatter's tests. All text is written for
// the tests. `manuscript()` returns the bytes and the roles of its top-level children by index.
import { strToU8, zipSync } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/" TargetMode="External"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style><w:style w:type="table" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style></w:styles>`;

// Direct formatting of the kind an export writes on every run and paragraph.
const RUN = '<w:rFonts w:ascii="Book Serif" w:hAnsi="Book Serif" w:cs="Book Serif"/><w:b w:val="0"/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:u w:val="none"/><w:shd w:fill="auto" w:val="clear"/><w:vertAlign w:val="baseline"/><w:rtl w:val="0"/>';
const BODY_PPR = '<w:keepNext w:val="0"/><w:pageBreakBefore w:val="0"/><w:widowControl w:val="0"/><w:spacing w:line="480" w:lineRule="auto"/><w:ind w:firstLine="720"/><w:jc w:val="both"/>';
const run = (text, extra = '') => `<w:r><w:rPr>${RUN}${extra}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const note = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
const p = (content, pPr = BODY_PPR) => `<w:p><w:pPr>${pPr}<w:rPr>${RUN}</w:rPr></w:pPr>${content}</w:p>`;
const empty = (extra = '') => `<w:p><w:pPr>${BODY_PPR}</w:pPr>${extra}</w:p>`;
const centred = '<w:spacing w:line="480" w:lineRule="auto"/><w:jc w:val="center"/>';
const indented = '<w:spacing w:line="480" w:lineRule="auto"/><w:ind w:left="1440"/><w:jc w:val="both"/>';
const FRONT_SECTION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:start="1"/></w:sectPr>';

/**
 * The paragraphs of the invented manuscript, in order: [xml, role] (role null for none).
 * Indices in the returned roles are positions in this list.
 */
function children({ typedNumbers = false, authorWithAffiliation = false } = {}) {
  const number = text => (typedNumbers ? `1 ${text}` : text);
  const people = authorWithAffiliation
    ? [[p(run('Ada Placeholder (University of Elsewhere)', '<w:b/>'), centred), 'title-block']]
    : [[p(run('Ada Placeholder', '<w:b/>'), centred), 'title-block'], [p(run('University of Elsewhere', '<w:b/>'), centred), 'title-block']];
  return [
    [p(run('A Volume of Invented Essays'), centred), null],
    [`<w:p><w:pPr>${centred}${FRONT_SECTION}</w:pPr>${run('Edited by Nobody in Particular')}</w:p>`, null],
    [empty(), null],
    // Chapter one.
    [p(run('Paper Lanterns: How Invented Things Are Read', '<w:b/>'), centred), 'title-block'],
    ...people,
    [empty('<w:bookmarkStart w:id="7" w:name="here"/><w:bookmarkEnd w:id="7"/>'), null],
    [p(run('This chapter asks how a reader meets an invented object for the first time.'), indented), 'abstract'],
    [p(run('Keywords: lanterns, reading, invention'), indented), 'keywords'],
    [p(run(number('Opening the Box'), '<w:i/>')), 'heading-1'],
    [p(run('The first paragraph after a heading opens the section') + note(1) + run(' and runs on.')), 'body'],
    [p(run('A second paragraph has a word in ') + run('italics', '<w:i/>') + run(' and a ') + `<w:hyperlink r:id="rId3">${run('link')}</w:hyperlink>` + run('.')), 'body'],
    [empty(), null],
    [p(run('A quotation set off from the text, long enough to stand on its own as a block.'), indented), 'block-quotation'],
    [p(run('The paragraph after a quotation continues the argument.')), 'body'],
    [p(run('A line of verse that rises'), indented), 'verse'],
    [p(run('and a line of verse that falls'), indented), 'verse'],
    [empty(), null],
    [p(run('a second stanza begins'), indented), 'verse'],
    [p(run('Then the text resumes') + `<w:sdt><w:sdtPr><w:tag w:val="x"/></w:sdtPr><w:sdtContent>${run(' with a wrapped phrase')}</w:sdtContent></w:sdt>` + run('.')), 'body'],
    [p(run(number('Closing the Box'), '<w:i/>')), 'heading-1'],
    [p(run('[FIGURE 1 HERE]')), 'figure'],
    [p(run('After the figure the text goes on.')), 'body'],
    [`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${p(run('Left cell'))}</w:tc><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${p(run('Right cell'))}</w:tc></w:tr></w:tbl>`, 'table'],
    [p(run('Bibliography', '<w:b/>')), 'bibliography-heading'],
    [p(run('Placeholder, Ada. '), '<w:ind w:left="720" w:hanging="720"/>') .replace('</w:p>', `${run('Invented Things', '<w:i/>')}${run('. Nowhere: Press, 2001.')}</w:p>`), 'bibliography-entry'],
    [p(run('Writer, Some. Another Book. Nowhere: Press, 2002.'), '<w:ind w:left="720" w:hanging="720"/>'), 'bibliography-entry'],
    [empty(), null],
    [empty(), null],
    // Chapter two.
    [p(run('Glass Bells', '<w:b/>'), centred), 'title-block'],
    [p(run('Sounding Invented Objects', '<w:b/>'), centred), 'title-block'],
    [p(run('Ben Example and Cy Sample', '<w:b/>'), centred), 'title-block'],
    [p(run('Institute of Nowhere', '<w:b/>'), centred), 'title-block'],
    [p(run('The second chapter opens without a heading.') + note(2)), 'body'],
    [p(run('Its second paragraph is indented.')), 'body'],
    // A prose quotation pasted with a break at the end of every printed line.
    [p(run('The lantern was not lit when we came in, and the'), indented), 'block-quotation'],
    [p(run('room was as dark as the street outside, where'), indented), 'block-quotation'],
    [p(run('nobody waited. We sat down.'), indented), 'block-quotation'],
    [p(run('Then a second paragraph of the quotation begins.'), indented), 'block-quotation'],
    [`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`, null],
  ];
}

const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`
  + `<w:footnote w:id="1"><w:p><w:pPr><w:spacing w:line="480" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>${run(' A first note.')}</w:p></w:footnote>`
  + `<w:footnote w:id="2"><w:p><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>${run(' A second note, in the second chapter.')}</w:p></w:footnote></w:footnotes>`;

// Style ids and names holding every character XML treats specially, as a hostile or careless
// file might, written escaped as the file would hold them.
const HOSTILE = '&quot;&lt;&amp;\'&gt;';
const HOSTILE_STYLES = STYLES
  .replace('w:styleId="Normal"><w:name w:val="Normal"/>', `w:styleId="Nor${HOSTILE}mal"><w:name w:val="Nor${HOSTILE}mal"/>`)
  .replace('<w:basedOn w:val="Normal"/>', `<w:basedOn w:val="Nor${HOSTILE}mal"/>`)
  .replace('</w:styles>', `<w:style w:type="paragraph" w:styleId="Bo${HOSTILE}dy"><w:name w:val="Body Text"/></w:style></w:styles>`);

/**
 * The invented manuscript: { bytes, roles, count }. With `hostile`, its style ids and names and
 * its line spacing hold quotation marks, angle brackets, ampersands and apostrophes.
 */
export function manuscript(options = {}) {
  const list = children(options);
  let body = list.map(([xml]) => xml).join('');
  if (options.hostile) body = body.replaceAll('w:line="480"', `w:line="480${HOSTILE}"`).replace('<w:p><w:pPr>', `<w:p><w:pPr><w:pStyle w:val="Nor${HOSTILE}mal"/>`);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
  const roles = {};
  list.forEach(([, role], index) => { if (role) roles[index] = role; });
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS),
    'word/styles.xml': strToU8(options.hostile ? HOSTILE_STYLES : STYLES),
    'word/footnotes.xml': strToU8(FOOTNOTES),
  });
  return { bytes, roles, count: list.length };
}

/** A rule sheet holding the given slotted rules, written by hand. */
export function sheetWith(rules) {
  return {
    version: 1,
    docType: 'edited-collection',
    manual: { id: null, named: null },
    rules: rules.map(([slot, category, params], index) => ({ id: `rule-${index + 1}`, category, slot, statement: 'A rule written for the tests.', mode: 'fix', source: { kind: 'author' }, params, enabled: true })),
    dropped: 0,
    created: '2026-11-22T12:00:00Z',
  };
}

export const RULES = Object.freeze({
  restart: ['notes.restart', 'notes', { per: 'chapter' }],
  numbered: ['headings.numbering', 'headings', { scheme: 'decimal' }],
  split: ['chapters.subtitle', 'chapters', { split: true }],
  markers: ['figures.markers', 'figures-tables', { example: '[Figure 2.1 about here]' }],
});
