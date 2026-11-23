// Reads a Word (.docx) manuscript into its paragraph model: one entry per top-level child of
// w:body, in order, with its kind, its text and hints about its direct formatting. Pure: no DOM, no
// network; runs in the browser (where the file is opened and never uploaded) and in Node.
//
// fflate unzips the package; saxes parses the XML as a stream and rejects anything that is not
// well-formed. Neither builds a DOM.

import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

export const MAX_DOCX_BYTES = 50 * 1024 * 1024;
// No one XML part of a manuscript comes near this; a larger one is refused, not inflated.
const MAX_PART_BYTES = 200 * 1024 * 1024;

const MESSAGES = {
  not_docx: 'This is not a Word (.docx) file. Save the manuscript as a Word document and choose it again.',
  unreadable: 'This Word file could not be read. Open it in Word or Google Docs, save it again as a .docx file, and choose the new file.',
  too_large: 'This file is too large to read here (the limit is 50 MB). Save a copy without its images and choose that instead.',
};
const failure = code => ({ ok: false, code, message: MESSAGES[code] });

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const MARKUP_COMPATIBILITY = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DEFAULT_MAIN = 'word/document.xml';
const DEFAULT_STYLES = 'word/styles.xml';
const STYLES_TYPE = '/styles';
const ALIGNMENTS = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };
const OFF = new Set(['0', 'false', 'off']);

class Unreadable extends Error {}

const asBytes = value => (value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null);
const startsWithZip = bytes => bytes.length >= 4 && ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

// Parses `xml`, calling handlers.open(node, stack), handlers.close(node, stack) and
// handlers.text(text, stack) with the stack of open elements, innermost last. Throws Unreadable.
function parseXml(bytes, handlers) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let failed = null;
  parser.on('error', error => { failed ??= error; });
  parser.on('opentag', node => { stack.push(node); handlers.open?.(node, stack); });
  parser.on('closetag', node => { handlers.close?.(node, stack); stack.pop(); });
  parser.on('text', text => handlers.text?.(text, stack));
  parser.on('cdata', text => handlers.text?.(text, stack));
  try {
    parser.write(new TextDecoder('utf-8').decode(bytes)).close();
  } catch (error) {
    failed ??= error;
  }
  if (failed) throw new Unreadable('not well-formed XML');
}

const isWord = (node, local) => node !== undefined && node.local === local && WORD.has(node.uri);
// A Word attribute's value by local name (w:val, w:left, ...), or undefined.
function attribute(node, local) {
  for (const value of Object.values(node.attributes)) if (value.local === local && (WORD.has(value.uri) || value.uri === '')) return value.value;
  return undefined;
}
const toggle = node => { const value = attribute(node, 'val'); return value === undefined || !OFF.has(value.toLowerCase()); };
const twipsToPoints = value => { const number = Number.parseInt(value, 10); return Number.isFinite(number) ? Math.round(number / 2) / 10 : 0; };

// The main document part named by the package relationships, or the usual one.
function mainPartName(rels) {
  if (!rels) return DEFAULT_MAIN;
  let target = null;
  parseXml(rels, {
    open(node) {
      if (target !== null || node.local !== 'Relationship' || node.uri !== RELATIONSHIPS) return;
      const type = node.attributes.Type?.value ?? '';
      if (type.endsWith('/officeDocument')) target = node.attributes.Target?.value ?? null;
    },
  });
  return target ? target.replace(/^\/+/, '') : DEFAULT_MAIN;
}

function unzip(bytes, names) {
  let oversized = false;
  const files = unzipSync(bytes, {
    filter(file) {
      if (!names.includes(file.name)) return false;
      if (file.originalSize > MAX_PART_BYTES) { oversized = true; return false; }
      return true;
    },
  });
  return { files, oversized };
}

function newEntry(index, local) {
  return {
    index,
    kind: local === 'p' ? 'paragraph' : local === 'tbl' ? 'table' : 'other',
    parts: [],
    runs: [],
    hints: { align: null, indentLeft: 0, indentRight: 0, indentFirst: 0, styleId: null, bold: false, italic: false, size: null, list: false, pageBreak: false, image: false, footnote: false, empty: false },
    // Evidence of where the paragraph stands in the work's structure (see addStructure).
    outline: null, breakBefore: false, sectionEnd: null, firstBreak: -1, lastBreak: -1, bookmarks: [], links: [], innerStyle: null,
  };
}

// Where a note reference stands among a paragraph's parts; it adds no text.
const NOTE_MARK = Object.freeze({ note: true });

// The finished entry: its text, the run hints worked out from the runs that hold visible text, and,
// when it has note references, their places as offsets into the text (`notes`).
function finish(entry) {
  const notes = [];
  let text = '';
  for (const part of entry.parts) {
    if (part === NOTE_MARK) notes.push(text.length);
    else text += part;
  }
  if (entry.kind !== 'paragraph') text = text.replace(/[\t\n]+$/, '');
  const { hints, runs } = entry;
  if (runs.length) {
    hints.bold = runs.every(one => one.bold);
    hints.italic = runs.every(one => one.italic);
    const sizes = new Set(runs.map(one => one.size));
    hints.size = sizes.size === 1 ? [...sizes][0] : null;
  }
  hints.empty = text.trim() === '' && !hints.image;
  // A page break with no text after it ends the page this paragraph is on.
  const breakAfter = entry.lastBreak >= 0 && text.slice(entry.lastBreak).trim() === '';
  // One with no text before it starts a new page with this paragraph's text.
  const breakFirst = entry.firstBreak >= 0 && text.slice(0, entry.firstBreak).trim() === '' && text.trim() !== '';
  const raw = { outline: entry.outline, breakBefore: entry.breakBefore || breakFirst, sectionEnd: entry.sectionEnd, breakAfter, bookmarks: entry.bookmarks, links: entry.links };
  return { index: entry.index, kind: entry.kind, text, hints, raw, ...(notes.length ? { notes: notes.filter(at => at <= text.length) } : {}) };
}

// The paragraph model of a main document part.
function readBody(xml) {
  const paragraphs = [];
  let sawBody = false;
  let entry = null;
  const runStack = [];
  let skipped = 0; // depth inside markup whose text is a duplicate (mc:Fallback)

  // The top-level element is stack[2] (document > body > child).
  const inBody = stack => stack.length >= 2 && isWord(stack[0], 'document') && isWord(stack[1], 'body');
  const parentOf = stack => stack[stack.length - 2];

  parseXml(xml, {
    open(node, stack) {
      if (stack.length === 1 && !isWord(node, 'document')) throw new Unreadable('not a Word document');
      if (stack.length === 2 && isWord(node, 'body')) sawBody = true;
      if (!inBody(stack)) return;
      if (stack.length === 3) { entry = newEntry(paragraphs.length, WORD.has(node.uri) ? node.local : ''); return; }
      if (node.local === 'Fallback' && node.uri === MARKUP_COMPATIBILITY) skipped += 1;
      if (!WORD.has(node.uri) || entry === null) return;
      const parent = parentOf(stack);
      const { hints } = entry;
      // The top-level paragraph's own properties (not those of a tracked change to them).
      if (entry.kind === 'paragraph' && stack.length === 5 && isWord(stack[3], 'pPr')) {
        if (node.local === 'jc') hints.align = ALIGNMENTS[attribute(node, 'val')] ?? null;
        else if (node.local === 'pStyle') hints.styleId = attribute(node, 'val') ?? null;
        else if (node.local === 'numPr') hints.list = true;
        else if (node.local === 'pageBreakBefore') { hints.pageBreak = hints.pageBreak || toggle(node); entry.breakBefore = entry.breakBefore || toggle(node); }
        else if (node.local === 'outlineLvl') { const level = Number.parseInt(attribute(node, 'val'), 10); entry.outline = Number.isInteger(level) ? level : null; }
        else if (node.local === 'sectPr') entry.sectionEnd = 'nextPage';
        else if (node.local === 'ind') {
          hints.indentLeft = twipsToPoints(attribute(node, 'left') ?? attribute(node, 'start'));
          hints.indentRight = twipsToPoints(attribute(node, 'right') ?? attribute(node, 'end'));
          const hanging = attribute(node, 'hanging');
          hints.indentFirst = hanging !== undefined ? -twipsToPoints(hanging) : twipsToPoints(attribute(node, 'firstLine'));
        }
      }
      // The kind of the section this paragraph ends (w:type; next page when it has none).
      if (node.local === 'type' && entry.kind === 'paragraph' && stack.length === 6 && isWord(stack[3], 'pPr') && isWord(stack[4], 'sectPr')) entry.sectionEnd = attribute(node, 'val') ?? 'nextPage';
      // Bookmarks, and the links of a contents list with the style of the paragraph that holds them
      // (a contents list in a content control holds its own paragraphs).
      if (node.local === 'bookmarkStart') { const name = attribute(node, 'name'); if (name) entry.bookmarks.push(name); }
      if (node.local === 'p') entry.innerStyle = null;
      if (node.local === 'pStyle' && isWord(parent, 'pPr')) entry.innerStyle = attribute(node, 'val') ?? null;
      if (node.local === 'hyperlink') { const anchor = attribute(node, 'anchor'); if (anchor) entry.links.push({ anchor, styleId: entry.innerStyle }); }
      const current = runStack[runStack.length - 1];
      switch (node.local) {
        case 'r': runStack.push({ bold: false, italic: false, size: null, visible: false }); break;
        case 'drawing': case 'pict': case 'object': hints.image = true; break;
        case 'footnoteReference': case 'endnoteReference':
          hints.footnote = true;
          if (!skipped) entry.parts.push(NOTE_MARK);
          break;
        default:
          // Run properties: only those of the run itself, not of the paragraph mark or a change record.
          if (current && isWord(parent, 'rPr') && isWord(stack[stack.length - 3], 'r')) {
            if (node.local === 'b') current.bold = toggle(node);
            else if (node.local === 'i') current.italic = toggle(node);
            else if (node.local === 'sz') { const half = Number.parseInt(attribute(node, 'val'), 10); current.size = Number.isFinite(half) ? half / 2 : null; }
          }
          // Content of a run (w:tab and w:br also occur as tab stops and in other places).
          if (current && isWord(parent, 'r') && !skipped) {
            if (node.local === 'tab') entry.parts.push('\t');
            else if (node.local === 'br') {
              if (attribute(node, 'type') === 'page') {
                hints.pageBreak = true;
                entry.lastBreak = entry.parts.filter(part => typeof part === 'string').join('').length;
                if (entry.firstBreak < 0) entry.firstBreak = entry.lastBreak;
              }
              else if (attribute(node, 'type') !== 'column') entry.parts.push('\n');
            } else if (node.local === 'cr') entry.parts.push('\n');
            else if (node.local === 'noBreakHyphen') entry.parts.push('-');
          }
      }
    },
    text(text, stack) {
      if (!entry || skipped || !isWord(stack[stack.length - 1], 't') || !inBody(stack)) return;
      entry.parts.push(text);
      const current = runStack[runStack.length - 1];
      if (current && text.trim() !== '') current.visible = true;
    },
    close(node, stack) {
      if (!inBody(stack)) return;
      if (stack.length === 3) { if (entry) paragraphs.push(finish(entry)); entry = null; runStack.length = 0; return; }
      if (node.local === 'Fallback' && node.uri === MARKUP_COMPATIBILITY) skipped -= 1;
      if (!entry || !WORD.has(node.uri)) return;
      const { parts } = entry;
      // Inside a table or a block content control: paragraphs end a line, cells a column, rows a line.
      if (node.local === 'p') parts.push('\n');
      else if (node.local === 'tc' || node.local === 'tr') {
        while (parts.length && /^[\t\n]$/.test(parts[parts.length - 1])) parts.pop();
        parts.push(node.local === 'tc' ? '\t' : '\n');
      } else if (node.local === 'r') {
        const finished = runStack.pop();
        if (finished?.visible) entry.runs.push(finished);
      }
    },
  });
  if (!sawBody) throw new Unreadable('no document body');
  return paragraphs;
}

// The paragraph styles of a styles part: id -> { name, basedOn, outline, breakBefore }.
function readStyles(xml) {
  const styles = new Map();
  if (!xml) return styles;
  let style = null;
  parseXml(xml, {
    open(node, stack) {
      if (!WORD.has(node.uri)) return;
      if (node.local === 'style' && stack.length === 2) {
        style = attribute(node, 'type') === 'paragraph' ? { id: attribute(node, 'styleId'), name: null, basedOn: null, outline: null, breakBefore: null } : null;
        return;
      }
      if (!style) return;
      const parent = stack[stack.length - 2];
      if (stack.length === 3 && node.local === 'name') style.name = attribute(node, 'val') ?? null;
      else if (stack.length === 3 && node.local === 'basedOn') style.basedOn = attribute(node, 'val') ?? null;
      else if (stack.length === 4 && isWord(parent, 'pPr') && node.local === 'outlineLvl') { const level = Number.parseInt(attribute(node, 'val'), 10); style.outline = Number.isInteger(level) ? level : null; }
      else if (stack.length === 4 && isWord(parent, 'pPr') && node.local === 'pageBreakBefore') style.breakBefore = toggle(node);
    },
    close(node, stack) {
      if (stack.length === 2 && node.local === 'style' && style?.id) styles.set(style.id, style);
      if (stack.length === 2 && node.local === 'style') style = null;
    },
  });
  return styles;
}

// A property of a style, looked up through the styles it is based on.
function inherited(styles, id, property) {
  const seen = new Set();
  for (let style = styles.get(id); style && !seen.has(style.id); style = styles.get(style.basedOn)) {
    seen.add(style.id);
    if (style[property] !== null && style[property] !== undefined) return style[property];
  }
  return null;
}

const HEADING_NAME = /^heading\s*([1-9])$/i;

// A style's outline level: its own or that of a style it is based on, a built-in heading style
// ("heading 2") counting as its level when it states none.
function styleOutline(styles, id) {
  const seen = new Set();
  for (let style = styles.get(id); style && !seen.has(style.id); style = styles.get(style.basedOn)) {
    seen.add(style.id);
    if (style.outline !== null) return style.outline;
    const named = HEADING_NAME.exec(style.name ?? '');
    if (named) return Number(named[1]) - 1;
  }
  return null;
}
const TOC_NAME = /^toc\s*([1-9])$/i;
// A contents line's title without its page number: "Chapter One\t12" -> "chapter one".
const contentsKey = text => text.replace(/[\t .·…]*[0-9ivxlcdm]+\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Where each paragraph stands in the work's structure, from evidence in the file rather than from
 * reading its words (lib/roles/structure.js uses it with the model's labels): `styleName`, the name
 * of its paragraph style ("heading 1"); `outline`, its outline level (0 for the top level), set
 * directly, by its style, or by a built-in heading style's name; `newPage`, whether it starts a new
 * page (a page break before it, or one or a section break at the end of the text before it, with
 * only empty paragraphs between); `toc`, the level of the contents list's entry for it (1 for the
 * top level), when the file's contents list links to it or gives its words on a line of its own.
 */
function addStructure(paragraphs, styles) {
  const tocLevelOf = styleId => { const match = TOC_NAME.exec(inherited(styles, styleId, 'name') ?? ''); return match ? Number(match[1]) : null; };
  const byAnchor = new Map();
  const byText = new Map();
  const keep = (map, key, level) => { if (key && level && !(map.get(key) <= level)) map.set(key, level); };
  for (const entry of paragraphs) {
    for (const link of entry.raw.links) keep(byAnchor, link.anchor, tocLevelOf(link.styleId));
    if (entry.kind === 'paragraph' && entry.hints.styleId) keep(byText, contentsKey(entry.text), tocLevelOf(entry.hints.styleId));
  }
  paragraphs.forEach((entry, position) => {
    const { raw, hints } = entry;
    const styleName = hints.styleId ? inherited(styles, hints.styleId, 'name') : null;
    const outline = raw.outline ?? (hints.styleId ? styleOutline(styles, hints.styleId) : null);
    let newPage = raw.breakBefore || (hints.styleId ? inherited(styles, hints.styleId, 'breakBefore') === true : false);
    for (let at = position - 1; at >= 0 && !newPage; at -= 1) {
      const before = paragraphs[at];
      if ((before.raw.sectionEnd && before.raw.sectionEnd !== 'continuous') || before.raw.breakAfter) newPage = true;
      if (!before.hints.empty) break;
    }
    const anchored = raw.bookmarks.map(name => byAnchor.get(name)).filter(Boolean);
    const typed = tocLevelOf(hints.styleId) ? null : byText.get(contentsKey(entry.text));
    const toc = anchored.length ? Math.min(...anchored) : entry.kind === 'paragraph' && !hints.empty && typed ? typed : null;
    entry.structure = { styleName, outline: Number.isInteger(outline) && outline < 9 ? outline : null, newPage, toc };
  });
  for (const entry of paragraphs) delete entry.raw;
  return paragraphs;
}

// The part a relationship of the main document names, or null.
function relatedName(rels, main, type) {
  if (!rels) return null;
  let target = null;
  parseXml(rels, {
    open(node) {
      if (target !== null || node.local !== 'Relationship' || node.uri !== RELATIONSHIPS) return;
      if ((node.attributes.Type?.value ?? '').endsWith(type) && node.attributes.TargetMode?.value !== 'External') target = node.attributes.Target?.value ?? null;
    },
  });
  if (!target) return null;
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const folder = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  return `${folder}${target}`.replace(/[^/]+\/\.\.\//g, '');
}

/**
 * Reads a .docx file into its paragraph model. Never throws.
 * @param {Uint8Array | ArrayBuffer} input the file's bytes
 * @returns {{ ok: true, paragraphs: Array<{ index: number, kind: 'paragraph'|'table'|'other', text: string, hints: object, structure: object }> }
 *   | { ok: false, code: 'not_docx'|'unreadable'|'too_large', message: string }}
 */
export function readDocx(input) {
  const bytes = asBytes(input);
  if (!bytes) return failure('not_docx');
  if (bytes.byteLength > MAX_DOCX_BYTES) return failure('too_large');
  if (!startsWithZip(bytes)) return failure('not_docx');
  try {
    let { files, oversized } = unzip(bytes, ['_rels/.rels', DEFAULT_MAIN]);
    const main = mainPartName(files['_rels/.rels']);
    if (!files[main] && main !== DEFAULT_MAIN) ({ files, oversized } = unzip(bytes, [main]));
    if (oversized) return failure('too_large');
    if (!files[main]) return failure('not_docx');
    const relsName = `${main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : ''}_rels/${main.split('/').pop()}.rels`;
    const { files: related } = unzip(bytes, [relsName, DEFAULT_STYLES]);
    const stylesName = relatedName(related[relsName], main, STYLES_TYPE) ?? DEFAULT_STYLES;
    let stylesXml = related[stylesName];
    if (!stylesXml && stylesName !== DEFAULT_STYLES) {
      const extra = unzip(bytes, [stylesName]);
      if (extra.oversized) return failure('too_large');
      stylesXml = extra.files[stylesName];
    }
    // A styles part that cannot be read leaves the structure without style evidence, not the file unread.
    let styles = new Map();
    try { styles = readStyles(stylesXml); } catch {}
    return { ok: true, paragraphs: addStructure(readBody(files[main]), styles) };
  } catch {
    return failure('unreadable');
  }
}
