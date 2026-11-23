// What an accessibility check needs to know about a Word file, read from its package: the outline
// level of each heading in order, every picture with its alternative text (wp:docPr descr and
// title, or VML alt) and whether it is marked decorative, every table and whether its first row is
// marked as a header row (w:tblHeader) or only looks like one, every link with its text, the
// paragraphs whose text is highlighted or coloured, and the document's title and language. Each
// item carries `position`, its top-level body element, so a caller can map it back to the source
// paragraph it came from (the formatter's report.map). Pure: no DOM, no network.

import { readPackage, relationshipsOf, relatedPart } from './write.js';
import { descendants, elements, firstWord, isElement, isWord, parseXml, wordAttribute } from './xml.js';

const CORE_TYPE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
export const DC_NS = 'http://purl.org/dc/elements/1.1/';
const OFF = new Set(['0', 'false', 'off']);

const textOf = node => {
  let out = '';
  for (const child of descendants(node)) {
    if (isWord(child, 't')) out += child.children.map(part => part.text ?? '').join('');
    else if (isWord(child, 'tab')) out += '\t';
    else if (isWord(child, 'br') || isWord(child, 'cr')) out += '\n';
  }
  return out;
};
// Text outside deleted runs, which a reader does not see.
const visibleText = node => {
  let out = '';
  const walk = parent => {
    for (const child of parent.children) {
      if (!isElement(child)) continue;
      if (isWord(child, 'del') || isWord(child, 'moveFrom') || isWord(child, 'instrText') || isWord(child, 'delText')) continue;
      if (isWord(child, 't')) out += child.children.map(part => part.text ?? '').join('');
      else walk(child);
    }
  };
  walk(node);
  return out;
};
const toggleOn = node => node && !OFF.has((wordAttribute(node, 'val') ?? 'true').toLowerCase());
const byLocal = (node, local) => [...descendants(node)].filter(child => isElement(child) && child.local === local);
const attributeOf = (node, local) => node.attributes.find(attribute => attribute.local === local && (attribute.prefix === null || attribute.prefix === undefined || attribute.prefix === ''))?.value ?? node.attributes.find(attribute => attribute.local === local)?.value;

/** Each paragraph style's outline level (0 for a top heading), following basedOn, and its name. */
function styleOutlines(root) {
  const styles = new Map();
  for (const style of root ? elements(root, 'style') : []) {
    if (wordAttribute(style, 'type') !== 'paragraph') continue;
    const id = wordAttribute(style, 'styleId');
    const pPr = firstWord(style, 'pPr');
    const level = pPr && firstWord(pPr, 'outlineLvl') ? Number(wordAttribute(firstWord(pPr, 'outlineLvl'), 'val')) : null;
    const name = wordAttribute(firstWord(style, 'name') ?? { attributes: [] }, 'val') ?? '';
    const basedOn = firstWord(style, 'basedOn') ? wordAttribute(firstWord(style, 'basedOn'), 'val') : null;
    styles.set(id, { level, name, basedOn });
  }
  const resolve = (id, seen = new Set()) => {
    const style = styles.get(id);
    if (!style || seen.has(id)) return null;
    seen.add(id);
    if (Number.isInteger(style.level) && style.level >= 0 && style.level <= 8) return style.level;
    const named = /^heading ([1-9])$/iu.exec(style.name);
    if (named) return Number(named[1]) - 1;
    return style.basedOn ? resolve(style.basedOn, seen) : null;
  };
  const languageOf = id => {
    for (let at = id, seen = new Set(); at && !seen.has(at); seen.add(at), at = styles.get(at)?.basedOn) {
      const style = root ? elements(root, 'style').find(node => wordAttribute(node, 'styleId') === at) : null;
      const lang = style && firstWord(firstWord(style, 'rPr') ?? { children: [] }, 'lang');
      if (lang && wordAttribute(lang, 'val')) return wordAttribute(lang, 'val');
    }
    return null;
  };
  return { levelOf: id => (id ? resolve(id) : null), names: id => styles.get(id)?.name ?? null, languageOf };
}

/** Whether a run's text is marked by colour: a highlight, a shading or a font colour other than black or automatic. */
export function colourMark(rPr) {
  if (!rPr) return null;
  const highlight = firstWord(rPr, 'highlight');
  if (highlight && !['none', 'white'].includes(wordAttribute(highlight, 'val') ?? 'none')) return 'highlight';
  const shading = firstWord(rPr, 'shd');
  const fill = shading ? (wordAttribute(shading, 'fill') ?? 'auto').toLowerCase() : 'auto';
  if (shading && fill !== 'auto' && fill !== 'ffffff') return 'highlight';
  const colour = firstWord(rPr, 'color');
  if (!colour) return null;
  const theme = wordAttribute(colour, 'themeColor');
  if (theme) return theme === 'text1' || theme === 'dark1' ? null : 'colour';
  const value = (wordAttribute(colour, 'val') ?? 'auto').toLowerCase();
  if (value === 'auto' || !/^[0-9a-f]{6}$/u.test(value)) return null;
  const [r, g, b] = [0, 2, 4].map(at => Number.parseInt(value.slice(at, at + 2), 16));
  // Black and the near-black greys that pasted text brings with it are not a marker.
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24 && Math.max(r, g, b) <= 0x40 ? null : 'colour';
}

function pictures(node, rels) {
  const out = [];
  // Each wp:inline or wp:anchor holds one picture: its docPr (name, descr, title), extent and image.
  const holders = [...descendants(node)].filter(child => isElement(child) && (child.local === 'inline' || child.local === 'anchor') && /wordprocessingDrawing/u.test(child.uri ?? ''));
  for (const holder of holders) {
    const docPr = byLocal(holder, 'docPr')[0];
    if (!docPr) continue;
    const decorative = byLocal(docPr, 'decorative').some(child => (attributeOf(child, 'val') ?? '1') !== '0');
    const extent = elements(holder).find(child => child.local === 'extent') ?? null;
    const blip = byLocal(holder, 'blip')[0];
    const embed = blip?.attributes.find(attribute => attribute.local === 'embed')?.value;
    out.push({
      kind: 'drawing',
      descr: (attributeOf(docPr, 'descr') ?? '').trim(),
      title: (attributeOf(docPr, 'title') ?? '').trim(),
      name: (attributeOf(docPr, 'name') ?? '').trim(),
      decorative,
      hidden: (attributeOf(docPr, 'hidden') ?? '0') === '1',
      width: extent ? Number(attributeOf(extent, 'cx')) || null : null,
      height: extent ? Number(attributeOf(extent, 'cy')) || null : null,
      file: embed ? rels.get(embed)?.target ?? null : null,
      image: Boolean(blip),
    });
  }
  // Old VML pictures: v:shape with an alt attribute or an o:title on its image data.
  for (const shape of byLocal(node, 'shape')) {
    if (!byLocal(shape, 'imagedata').length) continue;
    const data = byLocal(shape, 'imagedata')[0];
    out.push({ kind: 'vml', descr: (attributeOf(shape, 'alt') ?? '').trim(), title: (attributeOf(data, 'title') ?? '').trim(), name: '', decorative: false, hidden: false, width: null, height: null, file: null });
  }
  return out;
}

export function tableFacts(table) {
  const rows = elements(table, 'tr');
  const first = rows[0];
  const header = rows.some(row => { const trPr = firstWord(row, 'trPr'); return trPr && toggleOn(firstWord(trPr, 'tblHeader')); });
  const cells = first ? elements(first, 'tc') : [];
  const runsOf = cell => [...descendants(cell, 'r')].filter(run => textOf(run).trim() !== '');
  const bold = run => { const rPr = firstWord(run, 'rPr'); return Boolean(rPr && toggleOn(firstWord(rPr, 'b'))); };
  const shaded = cell => { const shd = firstWord(firstWord(cell, 'tcPr') ?? { children: [] }, 'shd'); const fill = shd ? (wordAttribute(shd, 'fill') ?? 'auto').toLowerCase() : 'auto'; return fill !== 'auto' && fill !== 'ffffff'; };
  const filled = cells.length > 0 && cells.every(cell => textOf(cell).trim() !== '');
  const allBold = filled && cells.every(cell => runsOf(cell).length > 0 && runsOf(cell).every(bold));
  const second = rows[1] ? elements(rows[1], 'tc') : [];
  const shadedApart = filled && cells.every(shaded) && second.length > 0 && !second.some(shaded);
  const nested = byLocal(table, 'tbl').length > 0;
  return { rows: rows.length, columns: cells.length, header, looksLikeHeader: rows.length >= 2 && !nested && (allBold || shadedApart), firstRow: first ?? null };
}

function links(node, rels) {
  const out = [];
  for (const link of byLocal(node, 'hyperlink')) {
    if (!isWord(link, 'hyperlink')) continue;
    const id = link.attributes.find(attribute => attribute.local === 'id' && /relationships/u.test(attribute.uri ?? ''))?.value;
    const anchor = wordAttribute(link, 'anchor');
    out.push({ text: visibleText(link).trim(), target: id ? rels.get(id)?.target ?? null : anchor ? `#${anchor}` : null, internal: Boolean(anchor && !id) });
  }
  for (const field of byLocal(node, 'fldSimple')) {
    const instruction = wordAttribute(field, 'instr') ?? '';
    const match = /^\s*HYPERLINK\s+"([^"]*)"/iu.exec(instruction);
    if (match) out.push({ text: visibleText(field).trim(), target: match[1], internal: false });
  }
  return out;
}

export function coreTitle(files) {
  const rels = files.has('_rels/.rels') ? parseXml(files.get('_rels/.rels')).root : null;
  const rel = rels ? [...descendants(rels)].find(node => isElement(node) && node.local === 'Relationship' && attributeOf(node, 'Type') === CORE_TYPE) : null;
  const part = rel ? attributeOf(rel, 'Target').replace(/^\/+/u, '') : 'docProps/core.xml';
  if (!files.has(part)) return { part: null, title: null, root: null, element: null };
  const root = parseXml(files.get(part)).root;
  const element = [...descendants(root)].find(node => isElement(node) && node.local === 'title' && node.uri === DC_NS) ?? null;
  return { part, title: element ? element.children.map(child => child.text ?? '').join('').trim() || null : null, root, element };
}

/**
 * The accessibility facts of a .docx package. Never throws: an unreadable package gives null.
 * @param {Uint8Array} bytes
 * @returns {{ headings: Array<{ position: number, level: number, text: string }>, pictures: Array<object>, tables: Array<object>,
 *   links: Array<object>, marked: Array<{ position: number, kind: 'highlight' | 'colour', characters: number }>,
 *   title: string | null, corePart: string | null, language: string | null, elements: number } | null}
 */
export function readAccessibility(bytes) {
  try {
    return read(bytes);
  } catch {
    return null;
  }
}

function read(bytes) {
  const { files, main } = readPackage(bytes);
  const document = parseXml(files.get(main)).root;
  const body = firstWord(document, 'body');
  const stylesPart = relatedPart(files, main, 'styles');
  const stylesRoot = stylesPart && files.has(stylesPart) ? parseXml(files.get(stylesPart)).root : null;
  const styles = styleOutlines(stylesRoot);
  const rels = new Map(relationshipsOf(files, main).map(rel => [rel.id, { target: rel.external ? rel.target : rel.resolved }]));
  const children = body ? elements(body).filter(child => !isWord(child, 'sectPr')) : [];
  const out = { headings: [], pictures: [], tables: [], links: [], marked: [], elements: children.length };
  children.forEach((child, position) => {
    if (isWord(child, 'p')) {
      const pPr = firstWord(child, 'pPr');
      const styleId = pPr && firstWord(pPr, 'pStyle') ? wordAttribute(firstWord(pPr, 'pStyle'), 'val') : null;
      const direct = pPr && firstWord(pPr, 'outlineLvl') ? Number(wordAttribute(firstWord(pPr, 'outlineLvl'), 'val')) : null;
      const level = Number.isInteger(direct) && direct <= 8 ? direct : styles.levelOf(styleId);
      const text = visibleText(child).trim();
      if (Number.isInteger(level) && level <= 8 && text) out.headings.push({ position, level, text, style: styles.names(styleId) });
    }
    for (const picture of pictures(child, rels)) out.pictures.push({ position, ...picture, inTable: isWord(child, 'tbl') });
    if (isWord(child, 'tbl')) out.tables.push({ position, ...tableFacts(child) });
    for (const link of links(child, rels)) out.links.push({ position, ...link });
    // Highlighted or coloured text, outside links (which their own style colours).
    const counts = { highlight: 0, colour: 0 };
    const walk = node => {
      for (const part of node.children) {
        if (!isElement(part) || isWord(part, 'hyperlink') || isWord(part, 'del') || isWord(part, 'pPr')) continue;
        if (isWord(part, 'r')) {
          const mark = colourMark(firstWord(part, 'rPr'));
          if (mark) counts[mark] += textOf(part).replace(/\s/gu, '').length;
          continue;
        }
        walk(part);
      }
    };
    walk(child);
    for (const kind of ['highlight', 'colour']) if (counts[kind] > 0) out.marked.push({ position, kind, characters: counts[kind] });
  });
  const core = coreTitle(files);
  out.title = core.title;
  out.corePart = core.part;
  // The language: the document defaults', else the default paragraph style's.
  const defaults = stylesRoot && firstWord(stylesRoot, 'docDefaults');
  const defaultLang = defaults ? byLocal(defaults, 'lang').map(node => wordAttribute(node, 'val')).find(Boolean) ?? null : null;
  const normal = stylesRoot ? elements(stylesRoot, 'style').find(style => wordAttribute(style, 'type') === 'paragraph' && ['1', 'true', 'on'].includes(wordAttribute(style, 'default') ?? '')) : null;
  out.language = defaultLang ?? (normal ? styles.languageOf(wordAttribute(normal, 'styleId')) : null);
  return out;
}
