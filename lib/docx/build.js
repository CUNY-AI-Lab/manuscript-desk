// Builds a new, plain Word document (the To-dos list, the companion documents) from a list of
// blocks: headings, paragraphs of runs, quotations and tables. Every text goes in through the
// element tree and is escaped when written; the package skeleton and the styles are fixed text that
// holds no document value. Pure: no DOM, no network.

import { strToU8, zipSync } from 'fflate';
import { serializeXml, wordElement, WORD_NS } from './xml.js';

const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/gu;
const TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WORD_NS}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="567" w:right="567"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="List Item"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="357" w:hanging="357"/></w:pPr></w:style>'
  + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
  + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>'
  + '</w:styles>';
const STYLE_IDS = { 1: 'Heading1', 2: 'Heading2', 3: 'Heading3' };
const PAGE_WIDTH = 9360; // twips between the margins of a Letter page with one-inch margins
const GAP_COLOR = 'C00000';

const el = (local, attributes = {}, children = []) => wordElement('w', local, attributes, children);

/** A run: { text, bold?, italic?, gap? } (a gap is a marked place to fill, in bold red). */
function run({ text, bold = false, italic = false, gap = false }) {
  const properties = [];
  if (bold || gap) properties.push(el('b'));
  if (italic) properties.push(el('i'));
  if (gap) properties.push(el('color', { val: GAP_COLOR }));
  const parts = String(text).replace(NOT_XML, '').split('\n');
  const content = parts.flatMap((part, at) => [...(at ? [el('br')] : []), el('t', { 'xml:space': 'preserve' }, [{ type: 'text', text: part }])]);
  return el('r', {}, [...(properties.length ? [el('rPr', {}, properties)] : []), ...content]);
}

const runsOf = value => (Array.isArray(value) ? value : [{ text: value ?? '' }]);

function paragraph(value, style = null) {
  return el('p', {}, [...(style ? [el('pPr', {}, [el('pStyle', { val: style })])] : []), ...runsOf(value).map(run)]);
}

function table({ header, rows, widths }) {
  const columns = header.length;
  const share = widths ?? Array(columns).fill(1);
  const total = share.reduce((sum, value) => sum + value, 0);
  const twips = share.map(value => Math.round((PAGE_WIDTH * value) / total));
  const cell = (value, at, bold) => el('tc', {}, [el('tcPr', {}, [el('tcW', { w: twips[at], type: 'dxa' })]), paragraph(bold ? runsOf(value).map(part => ({ ...part, bold: true })) : value)]);
  const row = (cells, bold = false) => el('tr', {}, [...(bold ? [el('trPr', {}, [el('tblHeader')])] : []), ...cells.map((value, at) => cell(value, at, bold))]);
  return el('tbl', {}, [
    el('tblPr', {}, [el('tblStyle', { val: 'TableGrid' }), el('tblW', { w: PAGE_WIDTH, type: 'dxa' }), el('tblLook', { val: '04A0', firstRow: '1', lastRow: '0', firstColumn: '0', lastColumn: '0', noHBand: '0', noVBand: '1' })]),
    el('tblGrid', {}, twips.map(width => el('gridCol', { w: width }))),
    row(header, true),
    ...rows.map(cells => row(cells)),
  ]);
}

/**
 * The .docx bytes of a document made of blocks:
 *   { type: 'heading', level: 1 | 2 | 3, text }
 *   { type: 'paragraph', text } or { type: 'paragraph', runs: [{ text, bold, italic, gap }] }
 *   { type: 'quote', text }   a quotation, indented and in italics
 *   { type: 'item', text | runs }   one item of a list
 *   { type: 'table', header: [cell], rows: [[cell]], widths?: [number] }   cells are text or runs
 */
export function buildDocx(blocks) {
  const body = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': body.push(paragraph(block.text, STYLE_IDS[block.level] ?? 'Heading3')); break;
      case 'quote': body.push(paragraph(block.runs ?? block.text, 'Quote')); break;
      case 'item': body.push(paragraph(block.runs ?? [{ text: `•\t${block.text}` }], 'ListItem')); break;
      case 'table': body.push(table(block), paragraph('')); break;
      default: body.push(paragraph(block.runs ?? block.text));
    }
  }
  body.push(el('sectPr', {}, [el('pgSz', { w: 12240, h: 15840 }), el('pgMar', { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 })]));
  const document = el('document', { 'xmlns:w': WORD_NS }, [el('body', {}, body)]);
  return zipSync({
    '[Content_Types].xml': strToU8(TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(serializeXml(document)),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS),
    'word/styles.xml': strToU8(STYLES),
  });
}
