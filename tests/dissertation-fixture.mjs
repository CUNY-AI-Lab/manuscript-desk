// Builds an invented dissertation as a .docx, typed with direct formatting and no styles, with the
// faults a format check should find: front matter out of order (the approval page after the
// abstract, the acknowledgments spelled with an e), A4 pages with margins that differ by section,
// a subsection heading under no section heading, pictures without alt text, a table whose first row
// is bold but not marked as a header row and one with no header at all, a link that says
// "click here", highlighted text, and no document title or language. All text is invented for the
// tests. `dissertation()` returns the bytes and the roles of its top-level children by index.
import { strToU8, zipSync } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/archive" TargetMode="External"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style></w:styles>`;
// The core properties with no title, as an export often leaves them.
const CORE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Invented Author</dc:creator></cp:coreProperties>';
// A 1 by 1 pixel PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));

const RUN = '<w:rFonts w:ascii="Book Serif" w:hAnsi="Book Serif" w:cs="Book Serif"/><w:sz w:val="24"/><w:szCs w:val="24"/>';
const BODY_PPR = '<w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="720"/><w:jc w:val="both"/>';
const run = (text, extra = '') => `<w:r><w:rPr>${RUN}${extra}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const note = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
const p = (content, pPr = BODY_PPR) => `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`;
const empty = () => `<w:p><w:pPr>${BODY_PPR}</w:pPr></w:p>`;
const centred = '<w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="center"/>';
const flush = '<w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="left"/>';
const hanging = '<w:spacing w:line="240" w:lineRule="auto"/><w:ind w:left="720" w:hanging="720"/>';
// Two page setups: the front matter on A4 with narrow margins, the rest on A4 with wider ones.
const section = (margin, extra = '') => `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="708" w:footer="708" w:gutter="0"/>${extra}</w:sectPr>`;
const breakPara = (margin, text, pPr = centred) => `<w:p><w:pPr>${pPr}${section(margin)}</w:pPr>${run(text)}</w:p>`;
let pictureId = 0;
const picture = ({ descr = null, name = 'Picture', cx = 2743200, cy = 1828800 } = {}) => {
  pictureId += 1;
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${pictureId}" name="${name} ${pictureId}"${descr === null ? '' : ` descr="${descr}"`}/><a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:nvPicPr><pic:cNvPr id="${pictureId}" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
};
const cell = content => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${p(content, flush)}</w:tc>`;
const table = (rows, { boldFirst }) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows.map((row, at) => `<w:tr>${row.map(text => cell(run(text, at === 0 && boldFirst ? '<w:b/>' : ''))).join('')}</w:tr>`).join('')}</w:tbl>`;

function children() {
  pictureId = 0;
  return [
    // Title page.
    [p(run('INVENTED HARBOURS: A STUDY OF IMAGINARY PORTS'), centred), 'title-page'],
    [p(run('by'), centred), 'title-page'],
    [p(run('Rowan Placeholder'), centred), 'title-page'],
    [p(run('A dissertation submitted to the Graduate Faculty in Invented Studies in partial fulfillment of the requirements for the degree of Doctor of Philosophy, The Institution of Nowhere'), centred), 'title-page'],
    [breakPara(720, '2027'), 'title-page'],
    // Copyright page.
    [p(run('© 2027'), centred), 'copyright-page'],
    [p(run('ROWAN PLACEHOLDER'), centred), 'copyright-page'],
    [p(run('All Rights Reserved'), centred), 'copyright-page'],
    // The abstract, before the approval page that should precede it.
    [p(run('ABSTRACT', '<w:b/>'), centred), 'front-matter-heading'],
    [p(run('This dissertation reads harbours that exist only in invented maps, and asks what they kept.')), 'abstract'],
    [p(run('Approval', '<w:b/>'), centred), 'front-matter-heading'],
    [p(run('This manuscript has been read and accepted for the Graduate Faculty in Invented Studies.'), centred), 'approval-page'],
    [p(run('Approved: May 2027'), centred), 'approval-page'],
    [p(run('Some Advisor, Chair of Examining Committee'), centred), 'approval-page'],
    [p(run('Acknowledgements', '<w:b/>'), centred), 'front-matter-heading'],
    [p(run('I thank the invented archivists who kept the imaginary charts.')), 'body'],
    [p(run('Contents', '<w:b/>'), centred), 'front-matter-heading'],
    [p(run('Chapter 1: Charting Nowhere\t1'), flush), 'contents-entry'],
    [p(run('Chapter 2: The Tide Tables\t9'), flush), 'contents-entry'],
    [p(run('Bibliography\t15'), flush), 'contents-entry'],
    [breakPara(720, 'For the cartographers', centred), 'dedication'],
    // Chapter one.
    [p(run('CHAPTER 1'), centred), 'title-block'],
    [p(run('Charting Nowhere', '<w:b/>'), centred), 'title-block'],
    [p(run('Harbours appear on old charts that no ship ever reached.') + note(1) + run(' This chapter follows them.')), 'body'],
    [p(run('The second paragraph has a passage marked ') + run('for later revision', '<w:highlight w:val="yellow"/>') + run(' and a link to ') + `<w:hyperlink r:id="rId3">${run('click here', '<w:color w:val="0563C1"/><w:u w:val="single"/>')}</w:hyperlink>` + run('.')), 'body'],
    [p(run('Coastlines and Their Doubles', '<w:b/>'), flush), 'heading-1'],
    [p(run('A section begins.')), 'body'],
    [p(picture(), centred), 'figure'],
    [p(run('Figure 1.1. An invented coastline.'), centred), 'figure'],
    [p(run('The text resumes after the figure.')), 'body'],
    [table([['Port', 'Charted'], ['Nowhere Bay', '1702'], ['Lesser Haven', '1744']], { boldFirst: true }), 'table'],
    [p(run('Table 1.1. Invented ports and the year each was charted.'), centred), 'table'],
    [breakPara(1440, 'The chapter ends here.', BODY_PPR), 'body'],
    // Chapter two: a subsection heading with no section heading above it.
    [p(run('CHAPTER 2'), centred), 'title-block'],
    [p(run('The Tide Tables', '<w:b/>'), centred), 'title-block'],
    [p(run('Tides of Paper', '<w:b/><w:i/>'), flush), 'heading-2'],
    [p(run('The tables of tides were printed for ports that never were.') + note(2)), 'body'],
    [p(picture({ name: 'Screenshot', cx: 5486400, cy: 457200 }), centred), 'figure'],
    [p(picture({ descr: 'A hand-drawn chart of a bay with three soundings marked.' }), centred), 'figure'],
    [p(run('Figure 2.1. A second chart.'), centred), 'figure'],
    [table([['ebb', 'flood'], ['6.1', '7.4']], { boldFirst: false }), 'table'],
    [p(run('Bibliography', '<w:b/>'), flush), 'bibliography-heading'],
    [p(run('Example, Ben. '), hanging).replace('</w:p>', `${run('Imaginary Ports', '<w:i/>')}${run('. Nowhere: Invented Press, 2001.')}</w:p>`), 'bibliography-entry'],
    [p(run('Sample, Cy. The Atlas of Elsewhere. Nowhere: Invented Press, 2010.'), hanging), 'bibliography-entry'],
    [section(1440), null],
  ];
}

const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`
  + `<w:footnote w:id="1"><w:p><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>${run(' A first note on the charts.')}</w:p></w:footnote>`
  + `<w:footnote w:id="2"><w:p><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>${run(' A note in the second chapter.')}</w:p></w:footnote></w:footnotes>`;

/** The invented dissertation: { bytes, roles, count }. */
export function dissertation() {
  const list = children();
  const body = list.map(([xml]) => xml).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}"><w:body>${body}</w:body></w:document>`;
  const roles = {};
  list.forEach(([, role], index) => { if (role) roles[index] = role; });
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'docProps/core.xml': strToU8(CORE),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS),
    'word/styles.xml': strToU8(STYLES),
    'word/footnotes.xml': strToU8(FOOTNOTES),
    'word/media/image1.png': PNG,
  });
  return { bytes, roles, count: list.length };
}
