// The words of a Word document, in order, and the check that formatting changed none of them except
// as declared. The formatter declares every transformation that changes text with the words it
// removed and added; compareWords diffs the source's words against the output's and reports what
// no declaration explains. Pure: no DOM, no network.

import { relatedPart } from '../docx/write.js';
import { elements, firstWord, isElement, isWord, parseXml, WORD_NAMESPACES } from '../docx/xml.js';

const MARKUP_COMPATIBILITY = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
// Text that is not part of the visible document: deleted text, the fallback copy of a drawing.
const SKIP = new Set(['del', 'moveFrom', 'instrText', 'delInstrText']);

/** The visible text of an element (a paragraph, a table, a note), with breaks and tabs as spaces. */
export function textOf(node) {
  const out = [];
  const walk = element => {
    for (const child of element.children) {
      if (child.type === 'text') {
        if (isWord(element, 't')) out.push(child.text);
        continue;
      }
      if (!isElement(child)) continue;
      if (child.local === 'Fallback' && child.uri === MARKUP_COMPATIBILITY) continue;
      if (WORD_NAMESPACES.has(child.uri)) {
        if (SKIP.has(child.local)) continue;
        if (child.local === 'tab' || child.local === 'br' || child.local === 'cr') { out.push(' '); continue; }
        if (child.local === 'noBreakHyphen') { out.push('-'); continue; }
        if (child.local === 'p' || child.local === 'tc') { walk(child); out.push(' '); continue; }
      }
      walk(child);
    }
  };
  walk(node);
  return out.join('');
}

/** The words of a text: its runs of characters between white space. */
export const wordsOf = text => text.split(/\s+/u).filter(Boolean);

/**
 * The words of a package's main document and of its notes, in document order.
 * @param {Map<string, Uint8Array>} files the package parts
 * @param {string} main the main document part
 * @returns {{ body: string[], notes: string[] }}
 */
export function documentWords(files, main) {
  const { root } = parseXml(files.get(main));
  const body = firstWord(root, 'body');
  const words = { body: [], notes: [] };
  for (const child of body ? elements(body) : []) words.body.push(...wordsOf(textOf(child)));
  for (const type of ['footnotes', 'endnotes']) {
    const part = relatedPart(files, main, type);
    if (!part || !files.has(part)) continue;
    const notes = parseXml(files.get(part)).root;
    for (const note of elements(notes)) words.notes.push(...wordsOf(textOf(note)));
  }
  return words;
}

// A multiset of words.
const bag = list => list.reduce((counts, word) => counts.set(word, (counts.get(word) ?? 0) + 1), new Map());
const size = counts => [...counts.values()].reduce((sum, count) => sum + count, 0);
function subtract(from, take) {
  const left = new Map(from);
  for (const [word, count] of take) {
    const have = left.get(word) ?? 0;
    if (have <= count) left.delete(word);
    else left.set(word, have - count);
  }
  return left;
}

const MAX_EDITS = 6000;

/**
 * The words removed from `a` and added in `b` by the shortest edit between them (Myers' diff),
 * or null when they differ by more than MAX_EDITS words.
 * @returns {{ removed: string[], added: string[] } | null}
 */
export function diffWords(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;
  if (n === 0 || m === 0) return { removed: x, added: y };
  // trace[d][k + d] is the furthest x reached on diagonal k (x - y) with d edits.
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS) && found < 0; d += 1) {
    const row = new Int32Array(2 * d + 1);
    const previous = trace[d - 1];
    for (let k = -d; k <= d; k += 2) {
      let xs;
      if (d === 0) xs = 0;
      else if (k === -d || (k !== d && previous[k - 1 + d - 1] < previous[k + 1 + d - 1])) xs = previous[k + 1 + d - 1];
      else xs = previous[k - 1 + d - 1] + 1;
      let ys = xs - k;
      while (xs < n && ys < m && x[xs] === y[ys]) { xs += 1; ys += 1; }
      row[k + d] = xs;
      if (xs >= n && ys >= m) { found = d; break; }
    }
    trace.push(row);
  }
  if (found < 0) return null;
  // Back from (n, m): each step undoes one edit and the run of equal words after it.
  const removed = [];
  const added = [];
  let xs = n;
  let ys = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d - 1];
    const k = xs - ys;
    const down = k === -d || (k !== d && previous[k - 1 + d - 1] < previous[k + 1 + d - 1]);
    const previousK = down ? k + 1 : k - 1;
    const previousX = previous[previousK + d - 1];
    const previousY = previousX - previousK;
    if (down) added.push(y[previousY]);
    else removed.push(x[previousX]);
    xs = previousX;
    ys = previousY;
  }
  return { removed: removed.reverse(), added: added.reverse() };
}

/**
 * Compares the words of a source and an output against the transformations the formatter declared.
 * @param {{ body: string[], notes: string[] }} source
 * @param {{ body: string[], notes: string[] }} output
 * @param {Array<{ removedWords?: string[], addedWords?: string[] }>} declared
 * @returns {{ comparable: boolean, removed: number, added: number, undeclaredRemoved: number, undeclaredAdded: number, declaredRemoved: number, declaredAdded: number }}
 */
export function compareWords(source, output, declared = []) {
  const parts = [diffWords(source.body, output.body), diffWords(source.notes, output.notes)];
  const comparable = parts.every(Boolean);
  // Without a path (too many edits), the words are compared as a bag: order is not checked.
  const removed = comparable ? [...parts[0].removed, ...parts[1].removed] : null;
  const added = comparable ? [...parts[0].added, ...parts[1].added] : null;
  const removedBag = removed ? bag(removed) : subtract(bag([...source.body, ...source.notes]), bag([...output.body, ...output.notes]));
  const addedBag = added ? bag(added) : subtract(bag([...output.body, ...output.notes]), bag([...source.body, ...source.notes]));
  const declaredRemoved = bag(declared.flatMap(entry => entry.removedWords ?? []));
  const declaredAdded = bag(declared.flatMap(entry => entry.addedWords ?? []));
  return {
    comparable,
    removed: size(removedBag),
    added: size(addedBag),
    declaredRemoved: size(declaredRemoved),
    declaredAdded: size(declaredAdded),
    undeclaredRemoved: size(subtract(removedBag, declaredRemoved)),
    undeclaredAdded: size(subtract(addedBag, declaredAdded)),
  };
}
