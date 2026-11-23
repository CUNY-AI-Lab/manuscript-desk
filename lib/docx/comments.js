// Writes Word comments into a .docx the formatter wrote: each anchored on the output paragraph that
// came from a given source paragraph (through the formatter's map of output elements to source
// paragraphs), by the author "CAIL Manuscript Desk". Comments the file already has are kept; the new
// ones take ids above theirs. Every value is written through the element tree, never as XML text.
// Pure: no DOM, no network.

import { strToU8 } from 'fflate';
import { addRelatedPart, readPackage, relatedPart, writePackage } from './write.js';
import { descendants, elements, isWord, parseXml, serializeXml, wordAttribute, wordElement, wordPrefix } from './xml.js';

export const COMMENT_AUTHOR = 'CAIL Manuscript Desk';
const COMMENT_INITIALS = 'CMD';
const EMPTY_COMMENTS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';
// Characters XML 1.0 does not allow in text.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/gu;
const COMMENT_MARKS = new Set(['comment', 'commentRangeStart', 'commentRangeEnd', 'commentReference']);

/** A date for w:date: the ISO form without fractions of a second. */
export const commentDate = (date = new Date()) => date.toISOString().replace(/\.\d+Z$/u, 'Z');

/**
 * @param {Uint8Array} bytes the formatted .docx
 * @param {{ map: Array<{ source: number }>, comments: Array<{ sourceIndex: number | null, text: string }>, date?: string }} options
 *   map: the formatter's report.map, one entry per top-level output element before the last section properties
 * @returns {{ ok: true, bytes: Uint8Array, written: number, unplaced: number } | { ok: false, code: string }}
 */
export function addComments(bytes, { map, comments, date = commentDate() }) {
  try {
    return write(bytes, { map, comments, date });
  } catch {
    return { ok: false, code: 'unreadable' };
  }
}

function write(bytes, { map, comments, date }) {
  const { files, main } = readPackage(bytes);
  const document = parseXml(files.get(main)).root;
  const prefix = wordPrefix(document);
  const body = elements(document).find(child => isWord(child, 'body'));
  if (!body) return { ok: false, code: 'unreadable' };
  const children = elements(body).filter(child => !isWord(child, 'sectPr'));
  if (!Array.isArray(map) || children.length !== map.length) return { ok: false, code: 'map_mismatch' };

  const part = relatedPart(files, main, 'comments') ?? addRelatedPart(files, main, 'comments', EMPTY_COMMENTS);
  const store = files.has(part) ? parseXml(files.get(part)).root : parseXml(EMPTY_COMMENTS).root;
  const storePrefix = wordPrefix(store);
  // New ids above every comment id the package already uses.
  const used = [...descendants(store), ...descendants(document)].filter(node => COMMENT_MARKS.has(node.local) && isWord(node, node.local)).map(node => Number.parseInt(wordAttribute(node, 'id'), 10)).filter(Number.isFinite);
  let next = Math.max(-1, ...used) + 1;

  let written = 0;
  let unplaced = 0;
  for (const comment of comments) {
    const paragraph = anchorFor(children, map, comment.sourceIndex);
    if (!paragraph) { unplaced += 1; continue; }
    const id = String(next);
    next += 1;
    const el = (local, attributes = {}, content = []) => wordElement(prefix, local, attributes, content);
    const at = paragraph.children.findIndex(child => isWord(child, 'pPr')) + 1;
    paragraph.children.splice(at, 0, el('commentRangeStart', { id }));
    paragraph.children.push(el('commentRangeEnd', { id }), el('r', {}, [el('commentReference', { id })]));
    store.children.push(commentElement(storePrefix, { id, text: comment.text, date }));
    written += 1;
  }
  files.set(main, strToU8(serializeXml(document)));
  files.set(part, strToU8(serializeXml(store)));
  return { ok: true, bytes: writePackage(files), written, unplaced };
}

/** The output paragraph for a source paragraph: the first one it became, or the next one after it. */
function anchorFor(children, map, sourceIndex) {
  let position = Number.isInteger(sourceIndex) ? map.findIndex(entry => entry.source === sourceIndex) : 0;
  if (position < 0) position = map.findIndex(entry => entry.source > sourceIndex);
  for (; position >= 0 && position < children.length; position += 1) {
    const child = children[position];
    if (isWord(child, 'p')) return child;
    const inner = [...descendants(child, 'p')][0];
    if (inner) return inner;
  }
  return null;
}

function commentElement(prefix, { id, text, date }) {
  const el = (local, attributes = {}, content = []) => wordElement(prefix, local, attributes, content);
  const lines = String(text).replace(NOT_XML, '').split('\n');
  const paragraphs = lines.map((line, at) => el('p', {}, [
    ...(at === 0 ? [el('r', {}, [el('annotationRef')])] : []),
    el('r', {}, [el('t', { 'xml:space': 'preserve' }, [{ type: 'text', text: line }])]),
  ]));
  return el('comment', { id, author: COMMENT_AUTHOR, date, initials: COMMENT_INITIALS }, paragraphs);
}
