// Applies an agent's spec to a manuscript (spike). Roles and settings go through the product's
// formatter unchanged (formatDocx with the agent's roles and a sheet with the agent's settings);
// the text operations are then made on the formatted file as tracked changes by "CAIL Manuscript
// Desk", each declared with the words it removes and adds, so the product's word check still proves
// that no word changed undeclared. An operation the spike cannot make safely (text inside a link,
// a field or a note reference, a table) is refused and counted, never forced.

import { strToU8 } from 'fflate';
import { readPackage, writePackage } from '../../../lib/docx/write.js';
import { cloneNode, descendants, elements, firstWord, isElement, isWord, nextAnnotationId, parseXml, serializeXml, wordElement, wordPrefix } from '../../../lib/docx/xml.js';
import { formatDocx, REVISION_AUTHOR } from '../../../lib/format/format.js';
import { textOf, wordsOf } from '../../../lib/format/words.js';
import { SLOTS, validateSheet } from '../../../lib/rules/schema.js';

/** The rule sheet with the agent's settings: a setting replaces the sheet's rules for its slot. */
export function sheetWith(sheet, settings) {
  const rules = sheet.rules.filter(rule => !(rule.slot && settings[rule.slot]));
  for (const [slot, { params, source, reason }] of Object.entries(settings)) {
    if (params === null) continue;
    rules.push({ id: `agent-${slot.replace(/[^a-z0-9-]/gu, "-")}`, category: SLOTS[slot].category, slot, statement: `${source === 'default' ? 'Default chosen by the agent (the guidelines are silent)' : 'Set by the agent from the guidelines'}: ${String(reason ?? '').slice(0, 300)}`.slice(0, 480), mode: 'fix', source: { kind: 'author' }, params, enabled: true });
  }
  const checked = validateSheet({ ...sheet, rules });
  if (!checked.ok) throw new Error(`The agent's sheet is not valid (${checked.reason}).`);
  return checked.sheet;
}

export function formatWith({ source, roles, sheet, settings }) {
  const fullSheet = sheetWith(sheet, settings);
  const formatted = formatDocx({ bytes: source, roles, sheet: fullSheet });
  if (!formatted.ok) throw new Error(`The formatter stopped: ${formatted.code}.`);
  return { ...formatted, sheet: fullSheet };
}

const UNSAFE = new Set(['footnoteReference', 'endnoteReference', 'fldChar', 'instrText', 'drawing', 'object', 'pict', 'fldSimple', 'sdt', 'hyperlink']);

/**
 * The text operations of a spec made on formatted bytes. `map` is the formatter's report.map.
 * Returns { bytes, map, declared, applied, refused }.
 */
export function applyTextOps({ bytes, map, spec, date = new Date().toISOString().replace(/\.\d+Z$/u, 'Z') }) {
  const { files, main } = readPackage(bytes);
  const document = parseXml(files.get(main)).root;
  const prefix = wordPrefix(document);
  const body = firstWord(document, 'body');
  const children = elements(body).filter(child => !isWord(child, 'sectPr'));
  if (children.length !== map.length) throw new Error('map_mismatch');
  let next = nextAnnotationId(document) + 1000;
  const el = (local, attributes = {}, content = []) => wordElement(prefix, local, attributes, content);
  const revision = () => ({ id: String(next++), author: REVISION_AUTHOR, date });
  const outputOf = index => map.map((entry, at) => (entry.source === index ? children[at] : null)).filter(Boolean);
  const declared = [], applied = [], refused = [];

  const deleteRunsIn = node => {
    node.children = node.children.map(child => {
      if (isWord(child, 'r')) {
        const copy = cloneNode(child);
        for (const inner of descendants(copy)) if (isWord(inner, 't')) { inner.name = inner.name.replace(/t$/u, 'delText'); inner.local = 'delText'; }
        return el('del', revision(), [copy]);
      }
      if (isElement(child) && !isWord(child, 'pPr') && !isWord(child, 'del') && !isWord(child, 'ins')) deleteRunsIn(child);
      return child;
    });
  };
  const markParagraph = (paragraph, kind) => {
    let pPr = firstWord(paragraph, 'pPr');
    if (!pPr) { pPr = el('pPr'); paragraph.children.unshift(pPr); }
    let rPr = firstWord(pPr, 'rPr');
    if (!rPr) {
      rPr = el('rPr');
      const sect = pPr.children.findIndex(child => isWord(child, 'sectPr') || isWord(child, 'pPrChange'));
      if (sect === -1) pPr.children.push(rPr); else pPr.children.splice(sect, 0, rPr);
    }
    rPr.children = [el(kind, revision()), ...rPr.children.filter(child => !isWord(child, kind))];
  };

  for (const op of spec) {
    if (op.op === 'delete') {
      const removed = [];
      let count = 0;
      for (let index = op.from; index <= op.to; index += 1) {
        for (const node of outputOf(index)) {
          if (!isWord(node, 'p')) { refused.push({ op, reason: 'a table in the range is left as it is' }); continue; }
          if ([...descendants(node)].some(inner => isWord(inner, 'sectPr'))) { refused.push({ op, reason: 'a paragraph carrying a section break is left as it is' }); continue; }
          removed.push(...wordsOf(textOf(node)));
          deleteRunsIn(node);
          markParagraph(node, 'del');
          count += 1;
        }
      }
      if (count) { declared.push({ kind: 'agent: paragraphs deleted', removedWords: removed, addedWords: [], count }); applied.push({ ...op, paragraphs: count, removedWords: removed.length }); }
    } else if (op.op === 'replace_text') {
      const nodes = outputOf(op.paragraph).filter(node => isWord(node, 'p'));
      const result = nodes.length ? replaceIn(nodes, op) : 'no paragraph in the output';
      if (typeof result === 'string') refused.push({ op, reason: result });
      else { declared.push({ kind: 'agent: text replaced', removedWords: wordsOf(op.before), addedWords: wordsOf(op.after) }); applied.push(op); }
    } else if (op.op === 'insert_contents') {
      const at = map.findIndex(entry => entry.source >= op.before);
      if (at === -1) { refused.push({ op, reason: 'no place in the output' }); continue; }
      const paragraph = el('p', {}, [el('pPr', {}, [el('rPr', {}, [el('ins', revision())])]), el('fldSimple', { instr: ' TOC \\o "1-1" \\h \\z \\u ' }, [])]);
      const target = children[at];
      body.children.splice(body.children.indexOf(target), 0, paragraph);
      children.splice(at, 0, paragraph);
      map.splice(at, 0, { source: -1, inserted: 'contents' });
      applied.push(op);
    }
  }

  // Word fills a TOC field when the file opens, after asking, with this setting.
  if (applied.some(op => op.op === 'insert_contents')) {
    const settingsPart = [...files.keys()].find(name => /word\/settings\.xml$/u.test(name));
    if (settingsPart) {
      const settings = parseXml(files.get(settingsPart)).root;
      if (!settings.children.some(child => isWord(child, 'updateFields'))) settings.children.push(wordElement(wordPrefix(settings), 'updateFields', { val: 'true' }));
      files.set(settingsPart, strToU8(serializeXml(settings)));
    }
  }
  files.set(main, strToU8(serializeXml(document)));
  return { bytes: writePackage(files), map, declared, applied, refused };

  // `before` replaced by `after` in the one output paragraph whose plain runs hold it once. Covered
  // runs are edited where they stand; anything between them must carry no text.
  function replaceIn(nodes, { before, after }) {
    for (const paragraph of nodes) {
      const visible = textOf(paragraph);
      const pieces = [];
      let offset = 0;
      for (const child of paragraph.children) {
        if (!isWord(child, 'r')) { const text = isElement(child) ? textOf({ children: [child] }) : ''; if (text) pieces.push({ child, start: offset, end: offset + text.length, text, run: false }); offset += text.length; continue; }
        const text = textOf(child);
        pieces.push({ child, start: offset, end: offset + text.length, text, run: true });
        offset += text.length;
      }
      if (offset !== visible.length) continue;
      const at = visible.indexOf(before);
      if (at === -1) continue;
      if (visible.indexOf(before, at + 1) !== -1) return 'occurs more than once in the formatted paragraph';
      const end = at + before.length;
      const covered = pieces.filter(piece => piece.end > at && piece.start < end);
      if (covered.some(piece => !piece.run)) return 'the text crosses a link or other markup';
      if (covered.some(piece => [...descendants(piece.child)].some(node => UNSAFE.has(node.local) || isWord(node, 'tab') || isWord(node, 'br')) || elements(piece.child).filter(child => isWord(child, 't')).length !== 1)) return 'the text crosses a note reference, field, tab, break or a run the spike does not split';
      const withText = (run, text) => { const copy = cloneNode(run); const t = elements(copy).find(child => isWord(child, 't')); t.children = [{ type: 'text', text }]; if (!t.attributes.some(a => a.name === 'xml:space')) t.attributes.push({ name: 'xml:space', local: 'space', prefix: 'xml', uri: 'http://www.w3.org/XML/1998/namespace', value: 'preserve' }); return copy; };
      const asDeleted = run => { for (const inner of descendants(run)) if (isWord(inner, 't')) { inner.name = inner.name.replace(/t$/u, 'delText'); inner.local = 'delText'; } return run; };
      const props = firstWord(covered[0].child, 'rPr');
      const replaced = new Map();
      covered.forEach((piece, index) => {
        const from = Math.max(at, piece.start) - piece.start, to = Math.min(end, piece.end) - piece.start;
        const parts = [];
        if (from > 0) parts.push(withText(piece.child, piece.text.slice(0, from)));
        parts.push(el('del', revision(), [asDeleted(withText(piece.child, piece.text.slice(from, to)))]));
        if (index === covered.length - 1 && after) parts.push(el('ins', revision(), [el('r', {}, [...(props ? [cloneNode(props)] : []), el('t', { 'xml:space': 'preserve' }, [{ type: 'text', text: after }])])]));
        if (to < piece.text.length) parts.push(withText(piece.child, piece.text.slice(to)));
        replaced.set(piece.child, parts);
      });
      paragraph.children = paragraph.children.flatMap(child => replaced.get(child) ?? [child]);
      return true;
    }
    return 'not found in the formatted paragraph as plain text';
  }
}
