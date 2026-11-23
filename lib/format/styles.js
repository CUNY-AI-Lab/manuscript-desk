// The paragraph styles the formatter applies: one per role, plus the variants a role needs (a
// first paragraph without indent, the parts of a title block, an epigraph's source line, a
// bibliography's subheadings, figure markers and captions). Each is defined here once, with the
// Word XML for its definition, and merged into the document's styles part: a style the document
// already has under the same name or id is replaced in place and keeps its id, any other is added.
// Pure: no DOM, no network.

import { PPR_ORDER } from '../docx/validate.js';
import { elements, firstWord, isElement, isWord, parseXml, setWordAttribute, wordAttribute, wordElement } from '../docx/xml.js';

const PPR_RANK = new Map(PPR_ORDER.map((name, rank) => [name, rank]));

const spacing = (before, after, line = null) => `<w:spacing w:before="${before}" w:after="${after}"${line ? ` w:line="${line}" w:lineRule="auto"` : ''}/>`;
// The body styles' line spacing is written in when the definitions are merged (BODY_LINE).
const BODY_LINE = 'BODY_LINE';

// key: { id, name, next, outline, pPr, rPr }. pPr and rPr are Word XML fragments with the w prefix.
export const STYLES = Object.freeze({
  'body': { id: 'BodyText', name: 'Body Text', next: 'body', pPr: `${spacing(0, 0, BODY_LINE)}<w:ind w:firstLine="425"/><w:jc w:val="both"/>` },
  'body-first': { id: 'BodyTextFirst', name: 'Body Text First', next: 'body', pPr: `${spacing(0, 0, BODY_LINE)}<w:ind w:firstLine="0"/><w:jc w:val="both"/>` },
  'chapter-label': { id: 'ChapterLabel', name: 'Chapter Label', next: 'chapter-title', pPr: `<w:keepNext/>${spacing(720, 240)}<w:jc w:val="center"/>`, rPr: '<w:smallCaps/>' },
  'chapter-title': { id: 'Heading1', name: 'heading 1', next: 'chapter-subtitle', outline: 0, pPr: `<w:keepNext/><w:keepLines/>${spacing(240, 240)}<w:jc w:val="center"/>`, rPr: '<w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/>' },
  'chapter-subtitle': { id: 'ChapterSubtitle', name: 'Chapter Subtitle', next: 'chapter-author', pPr: `<w:keepNext/><w:keepLines/>${spacing(0, 360)}<w:jc w:val="center"/>`, rPr: '<w:i/><w:iCs/><w:sz w:val="28"/><w:szCs w:val="28"/>' },
  'chapter-author': { id: 'ChapterAuthor', name: 'Chapter Author', next: 'chapter-affiliation', pPr: `<w:keepNext/>${spacing(120, 0)}<w:jc w:val="center"/>` },
  'chapter-affiliation': { id: 'ChapterAffiliation', name: 'Chapter Affiliation', next: 'body-first', pPr: `${spacing(0, 480)}<w:jc w:val="center"/>`, rPr: '<w:i/><w:iCs/>' },
  'epigraph': { id: 'Epigraph', name: 'Epigraph', next: 'epigraph-source', pPr: `${spacing(240, 0)}<w:ind w:left="2835"/><w:jc w:val="left"/>`, rPr: '<w:sz w:val="22"/><w:szCs w:val="22"/>' },
  'epigraph-source': { id: 'EpigraphSource', name: 'Epigraph Source', next: 'body-first', pPr: `${spacing(0, 240)}<w:ind w:left="2835"/><w:jc w:val="right"/>`, rPr: '<w:sz w:val="20"/><w:szCs w:val="20"/>' },
  'abstract': { id: 'Abstract', name: 'Abstract', next: 'keywords', pPr: `${spacing(0, 120)}<w:ind w:left="567" w:right="567"/><w:jc w:val="both"/>`, rPr: '<w:sz w:val="22"/><w:szCs w:val="22"/>' },
  'keywords': { id: 'Keywords', name: 'Keywords', next: 'body-first', pPr: `${spacing(0, 480)}<w:ind w:left="567" w:right="567"/><w:jc w:val="left"/>`, rPr: '<w:sz w:val="22"/><w:szCs w:val="22"/>' },
  'heading-1': { id: 'Heading2', name: 'heading 2', next: 'body-first', outline: 1, pPr: `<w:keepNext/><w:keepLines/>${spacing(480, 160)}<w:jc w:val="left"/>`, rPr: '<w:b/><w:bCs/>' },
  'heading-2': { id: 'Heading3', name: 'heading 3', next: 'body-first', outline: 2, pPr: `<w:keepNext/><w:keepLines/>${spacing(360, 120)}<w:jc w:val="left"/>`, rPr: '<w:b/><w:bCs/><w:i/><w:iCs/>' },
  'bibliography-heading': { id: 'BibliographyHeading', name: 'Bibliography Heading', next: 'bibliography-entry', outline: 1, pPr: `<w:keepNext/><w:keepLines/>${spacing(480, 160)}<w:jc w:val="left"/>`, rPr: '<w:b/><w:bCs/>' },
  'bibliography-subheading': { id: 'BibliographySubheading', name: 'Bibliography Subheading', next: 'bibliography-entry', outline: 2, pPr: `<w:keepNext/>${spacing(240, 120)}<w:jc w:val="left"/>`, rPr: '<w:i/><w:iCs/>' },
  'bibliography-entry': { id: 'Bibliography', name: 'Bibliography', next: 'bibliography-entry', pPr: `${spacing(0, 80)}<w:ind w:left="567" w:hanging="567"/><w:jc w:val="left"/>` },
  'block-quotation': { id: 'BlockQuotation', name: 'Block Quotation', next: 'body-first', pPr: `${spacing(240, 240)}<w:ind w:left="567" w:right="567" w:firstLine="0"/><w:contextualSpacing/><w:jc w:val="both"/>`, rPr: '<w:sz w:val="22"/><w:szCs w:val="22"/>' },
  'verse': { id: 'Verse', name: 'Verse', next: 'verse', pPr: `${spacing(240, 240)}<w:ind w:left="567" w:firstLine="0"/><w:contextualSpacing/><w:jc w:val="left"/>`, rPr: '<w:sz w:val="22"/><w:szCs w:val="22"/>' },
  'list-item': { id: 'ListItem', name: 'List Item', next: 'list-item', pPr: `${spacing(60, 60)}<w:ind w:left="567"/><w:contextualSpacing/><w:jc w:val="left"/>` },
  'table-text': { id: 'TableText', name: 'Table Text', pPr: `${spacing(40, 40)}<w:jc w:val="left"/>`, rPr: '<w:sz w:val="22"/><w:szCs w:val="22"/>' },
  'figure': { id: 'Figure', name: 'Figure', next: 'figure-caption', pPr: `<w:keepNext/>${spacing(240, 120)}<w:jc w:val="center"/>` },
  'figure-marker': { id: 'FigureMarker', name: 'Figure Marker', next: 'figure-caption', pPr: `<w:keepNext/>${spacing(360, 120)}<w:jc w:val="center"/>`, rPr: '<w:b/><w:bCs/><w:color w:val="C00000"/>' },
  'figure-caption': { id: 'FigureCaption', name: 'Figure Caption', next: 'body-first', pPr: `${spacing(0, 360)}<w:jc w:val="left"/>`, rPr: '<w:sz w:val="20"/><w:szCs w:val="20"/>' },
  'book-label': { id: 'BookLabel', name: 'Book Label', next: 'book-title', pPr: `<w:keepNext/>${spacing(240, 120)}<w:jc w:val="center"/>` },
  'book-title': { id: 'BookTitle', name: 'Book Title', next: 'book-subtitle', pPr: `<w:keepNext/><w:keepLines/>${spacing(1440, 240)}<w:jc w:val="center"/>`, rPr: '<w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/>' },
  'book-subtitle': { id: 'BookSubtitle', name: 'Book Subtitle', next: 'book-author', pPr: `<w:keepNext/><w:keepLines/>${spacing(0, 480)}<w:jc w:val="center"/>`, rPr: '<w:i/><w:iCs/><w:sz w:val="32"/><w:szCs w:val="32"/>' },
  'book-author': { id: 'BookAuthor', name: 'Book Author', next: 'book-affiliation', pPr: `<w:keepNext/>${spacing(240, 0)}<w:jc w:val="center"/>`, rPr: '<w:sz w:val="28"/><w:szCs w:val="28"/>' },
  'book-affiliation': { id: 'BookAffiliation', name: 'Book Affiliation', next: 'book-author', pPr: `${spacing(0, 120)}<w:jc w:val="center"/>`, rPr: '<w:i/><w:iCs/>' },
  'book-statement': { id: 'BookStatement', name: 'Book Statement', next: 'book-statement', pPr: `${spacing(240, 120)}<w:jc w:val="center"/>` },
  'chapter-statement': { id: 'ChapterStatement', name: 'Chapter Statement', next: 'body-first', pPr: `${spacing(120, 120)}<w:jc w:val="center"/>` },
  'front-matter-heading': { id: 'FrontMatterHeading', name: 'Front Matter Heading', next: 'body-first', outline: 0, pPr: `<w:keepNext/><w:keepLines/>${spacing(480, 360)}<w:jc w:val="left"/>`, rPr: '<w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/>' },
  'contents-entry': { id: 'ContentsEntry', name: 'Contents Entry', next: 'contents-entry', pPr: `${spacing(60, 60)}<w:jc w:val="left"/>` },
  'contributor-note': { id: 'ContributorNote', name: 'Contributor Note', next: 'contributor-note', pPr: `${spacing(0, 160)}<w:jc w:val="both"/>` },
  'part-title': { id: 'PartTitle', name: 'Part Title', next: 'chapter-title', outline: 0, pPr: `<w:keepNext/><w:keepLines/><w:pageBreakBefore/>${spacing(1440, 480)}<w:jc w:val="center"/>`, rPr: '<w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/>' },
  'copyright-page': { id: 'CopyrightPage', name: 'Copyright Page', next: 'copyright-page', pPr: `${spacing(0, 120)}<w:jc w:val="center"/>` },
  'approval-page': { id: 'ApprovalPage', name: 'Approval Page', next: 'approval-page', pPr: `${spacing(0, 120)}<w:jc w:val="center"/>` },
  'dedication': { id: 'Dedication', name: 'Dedication', next: 'body-first', pPr: `${spacing(1440, 240)}<w:jc w:val="center"/>` },
  'appendix-heading': { id: 'AppendixHeading', name: 'Appendix Heading', next: 'body-first', outline: 0, pPr: `<w:keepNext/><w:keepLines/>${spacing(480, 360)}<w:jc w:val="left"/>`, rPr: '<w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/>' },
  'note-text': { id: 'FootnoteText', name: 'footnote text', pPr: `${spacing(0, 40)}<w:jc w:val="both"/>`, rPr: '<w:sz w:val="20"/><w:szCs w:val="20"/>' },
});


const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * Merges the styles `used` (keys) into a styles part. Returns the ids to use by key (an existing
 * style with the same name keeps its id) and how many duplicate definitions were removed.
 * @param {object} root the styles part's root element (changed in place)
 * @param {{ used: Iterable<string>, bodyLine?: number|null, normal?: { font?: string|null, halfPoints?: number|null },
 *   numbering?: Record<string, { numId: string, ilvl: number }>, lines?: Record<string, string> }} options
 *   lines: a line spacing (in 240ths of a line) for some styles by key, from the sheet's spacing by element
 */
export function mergeStyles(root, { used, bodyLine = null, normal = {}, numbering = {}, lines = {} }) {
  const prefix = root.prefix ?? 'w';
  // A second definition under an id already defined is never used by Word; it goes.
  const seen = new Set();
  let duplicates = 0;
  root.children = root.children.filter(child => {
    if (!isWord(child, 'style')) return true;
    const id = wordAttribute(child, 'styleId');
    if (seen.has(id)) { duplicates += 1; return false; }
    seen.add(id);
    return true;
  });
  const existing = elements(root, 'style');
  const byId = new Map(existing.map(style => [wordAttribute(style, 'styleId'), style]));
  const byName = new Map(existing.map(style => [(wordAttribute(firstWord(style, 'name') ?? { attributes: [] }, 'val') ?? '').toLowerCase(), style]));
  const normalStyle = existing.find(style => wordAttribute(style, 'type') === 'paragraph' && ['1', 'true', 'on'].includes(wordAttribute(style, 'default') ?? ''))
    ?? byId.get('Normal');
  const normalId = normalStyle ? wordAttribute(normalStyle, 'styleId') : 'Normal';
  if (!normalStyle) root.children.push(parseFragment(prefix, `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`));
  setNormalRun(root, prefix, normalId, normal);
  const defaultsChanged = setDefaultFont(root, prefix, normal.font);

  const keys = [...new Set(used)];
  // The ids by key: an existing style of the same name or id is reused.
  const ids = {};
  for (const key of keys) {
    const spec = STYLES[key];
    const match = byName.get(spec.name.toLowerCase()) ?? byId.get(spec.id);
    ids[key] = match && wordAttribute(match, 'type') !== 'character' && wordAttribute(match, 'type') !== 'table' && wordAttribute(match, 'type') !== 'numbering' ? wordAttribute(match, 'styleId') : uniqueId(spec.id, byId);
    if (!byId.has(ids[key])) byId.set(ids[key], null);
  }
  // Only the constant definitions above are written as XML text; every value that can come from
  // the document (its style ids, its line spacing) is set as an attribute, which the serializer
  // escapes, so no value can change the structure.
  const line = typeof bodyLine === 'string' && /^\d{1,5}$/.test(bodyLine) ? bodyLine : null;
  for (const key of keys) {
    const spec = STYLES[key];
    const next = spec.next && ids[spec.next] ? ids[spec.next] : ids[key];
    const outline = spec.outline !== undefined ? `<w:outlineLvl w:val="${spec.outline}"/>` : '';
    const element = parseFragment(prefix, `<w:style w:type="paragraph"><w:name/><w:basedOn/><w:next/>`
      + `<w:uiPriority w:val="${spec.outline !== undefined ? 9 : 20}"/><w:qFormat/>`
      + `<w:pPr>${insertOutline(spec.pPr, outline)}</w:pPr>${spec.rPr ? `<w:rPr>${spec.rPr}</w:rPr>` : ''}</w:style>`);
    setWordAttribute(element, 'styleId', ids[key]);
    setWordAttribute(firstWord(element, 'name'), 'val', spec.name);
    setWordAttribute(firstWord(element, 'basedOn'), 'val', normalId);
    setWordAttribute(firstWord(element, 'next'), 'val', next);
    const pPr = firstWord(element, 'pPr');
    const spacing = firstWord(pPr, 'spacing');
    if (spacing && wordAttribute(spacing, 'line') === BODY_LINE) {
      if (line) setWordAttribute(spacing, 'line', line);
      else spacing.attributes = spacing.attributes.filter(attribute => attribute.local !== 'line' && attribute.local !== 'lineRule');
    }
    // A line spacing the rule sheet sets for this style (notes, quotations and the like).
    if (spacing && typeof lines[key] === 'string' && /^\d{1,5}$/.test(lines[key])) {
      setWordAttribute(spacing, 'line', lines[key]);
      setWordAttribute(spacing, 'lineRule', 'auto');
    }
    const number = numbering[key];
    if (number && /^\d{1,9}$/.test(String(number.numId)) && /^[0-8]$/.test(String(number.ilvl))) {
      const numPr = wordElement(prefix, 'numPr', {}, [wordElement(prefix, 'ilvl', { val: number.ilvl }), wordElement(prefix, 'numId', { val: number.numId })]);
      const at = pPr.children.findIndex(child => isElement(child) && (PPR_RANK.get(child.local) ?? -1) > PPR_RANK.get('numPr'));
      if (at < 0) pPr.children.push(numPr);
      else pPr.children.splice(at, 0, numPr);
    }
    const current = byId.get(ids[key]);
    if (current) root.children.splice(root.children.indexOf(current), 1, element);
    else root.children.push(element);
    byId.set(ids[key], element);
  }
  return { ids, duplicates, defaultsChanged };
}

/**
 * The document defaults take the body font too, so text no style reaches (headers and footers,
 * note separators, a comment) is not set in a theme or other default font. True when it changed.
 */
function setDefaultFont(root, prefix, font) {
  if (!font) return false;
  let defaults = firstWord(root, 'docDefaults');
  if (!defaults) {
    // The defaults come first in the styles part.
    defaults = wordElement(prefix, 'docDefaults');
    root.children.unshift(defaults);
  }
  let rPrDefault = firstWord(defaults, 'rPrDefault');
  if (!rPrDefault) { rPrDefault = wordElement(prefix, 'rPrDefault'); defaults.children.unshift(rPrDefault); }
  let rPr = firstWord(rPrDefault, 'rPr');
  if (!rPr) { rPr = wordElement(prefix, 'rPr'); rPrDefault.children.push(rPr); }
  const current = firstWord(rPr, 'rFonts');
  const slots = ['ascii', 'hAnsi', 'eastAsia', 'cs'];
  if (current && slots.every(slot => wordAttribute(current, slot) === font) && !current.attributes.some(attribute => /Theme$/u.test(attribute.local))) return false;
  const element = wordElement(prefix, 'rFonts', { ascii: font, hAnsi: font, eastAsia: font, cs: font });
  if (current) rPr.children.splice(rPr.children.indexOf(current), 1, element);
  else rPr.children.unshift(element);
  return true;
}

// outlineLvl goes after jc in w:pPr.
const insertOutline = (pPr, outline) => (outline ? pPr.replace(/(<w:jc [^>]*\/>)/, `$1${outline}`) : pPr);

function uniqueId(id, byId) {
  if (!byId.has(id)) return id;
  let number = 2;
  while (byId.has(`${id}${number}`)) number += 1;
  return `${id}${number}`;
}

/**
 * Parses a fragment written with the w prefix into an element that uses the part's own prefix.
 * Only for constant XML written in this module: values from a document are set as attributes.
 */
export function parseFragment(prefix, xml) {
  const { root } = parseXml(`<w:root xmlns:w="${W_NS}">${xml}</w:root>`);
  const element = root.children.find(child => child.type === 'element');
  const rename = node => {
    if (node.type !== 'element') return node;
    const local = name => name.slice(name.indexOf(':') + 1);
    return {
      ...node,
      name: prefix ? `${prefix}:${local(node.name)}` : local(node.name),
      prefix,
      attributes: node.attributes.map(attribute => (attribute.uri === W_NS ? { ...attribute, name: prefix ? `${prefix}:${attribute.local}` : attribute.local, prefix } : attribute)),
      children: node.children.map(rename),
    };
  };
  return rename(element);
}

// The default font and size go on the Normal style, so text that lost its direct font keeps it.
function setNormalRun(root, prefix, normalId, { font = null, halfPoints = null }) {
  if (!font && !halfPoints) return;
  const style = elements(root, 'style').find(node => wordAttribute(node, 'styleId') === normalId);
  if (!style) return;
  let rPr = firstWord(style, 'rPr');
  if (!rPr) {
    rPr = wordElement(prefix, 'rPr');
    style.children.push(rPr);
  }
  const replace = (local, element, before) => {
    const index = rPr.children.findIndex(child => isWord(child, local));
    if (index >= 0) rPr.children.splice(index, 1, element);
    else {
      const at = rPr.children.findIndex(child => child.type === 'element' && !before.has(child.local));
      if (at < 0) rPr.children.push(element);
      else rPr.children.splice(at, 0, element);
    }
  };
  if (font) replace('rFonts', wordElement(prefix, 'rFonts', { ascii: font, hAnsi: font, eastAsia: font, cs: font }), new Set(['rStyle']));
  const beforeSize = new Set(['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position']);
  if (halfPoints) {
    replace('sz', wordElement(prefix, 'sz', { val: halfPoints }), beforeSize);
    replace('szCs', wordElement(prefix, 'szCs', { val: halfPoints }), new Set([...beforeSize, 'sz']));
  }
}

