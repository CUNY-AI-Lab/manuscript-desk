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
  return { index: entry.index, kind: entry.kind, text, hints, ...(notes.length ? { notes: notes.filter(at => at <= text.length) } : {}) };
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
        else if (node.local === 'pageBreakBefore') hints.pageBreak = hints.pageBreak || toggle(node);
        else if (node.local === 'ind') {
          hints.indentLeft = twipsToPoints(attribute(node, 'left') ?? attribute(node, 'start'));
          hints.indentRight = twipsToPoints(attribute(node, 'right') ?? attribute(node, 'end'));
          const hanging = attribute(node, 'hanging');
          hints.indentFirst = hanging !== undefined ? -twipsToPoints(hanging) : twipsToPoints(attribute(node, 'firstLine'));
        }
      }
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
              if (attribute(node, 'type') === 'page') hints.pageBreak = true;
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

/**
 * Reads a .docx file into its paragraph model. Never throws.
 * @param {Uint8Array | ArrayBuffer} input the file's bytes
 * @returns {{ ok: true, paragraphs: Array<{ index: number, kind: 'paragraph'|'table'|'other', text: string, hints: object }> }
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
    return { ok: true, paragraphs: readBody(files[main]) };
  } catch {
    return failure('unreadable');
  }
}
