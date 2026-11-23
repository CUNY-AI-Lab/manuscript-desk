// The index as a book prints it: entries in alphabetical order under their letters, each with its
// locators, its subentries and its cross-references, indented or run in, as plain text and as Word
// blocks (lib/docx/build.js). The conventions are The Chicago Manual of Style's: a heading is
// alphabetized up to its first comma or parenthesis, then by what follows; letter by letter ignores
// spaces and punctuation in that part, word by word stops at the end of each word; "See" follows a
// heading with no locators, "See also" closes the entry. Pure: no DOM, no network.

import { letterFor, sortKey } from './indexer.js';
import { collapsePages } from './ranges.js';
import { buildDocx } from '../docx/build.js';

export const LAYOUTS = Object.freeze(['indented', 'run-in']);
export const SORTINGS = Object.freeze(['letter-by-letter', 'word-by-word']);
export const INDENT = '    ';
const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
// Small words a subentry's order skips at its start ("in Africa" sorts under A).
const SKIPPED = /^(?:a|an|the|and|as|at|by|for|from|in|of|on|to|with|vs\.?|versus)\s+/i;

// The part of a heading alphabetized first (up to a comma or parenthesis) and the rest.
function parts(heading) {
  const cut = heading.search(/[,(]/);
  return cut === -1 ? [heading, ''] : [heading.slice(0, cut), heading.slice(cut + 1)];
}

const words = text => sortKey(text).replace(/[-‐-―/]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
const letters = text => sortKey(text).replace(/[^\p{L}\p{N}]/gu, '');

function compareWords(a, b) {
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    const order = COLLATOR.compare(a[at], b[at]);
    if (order) return order;
  }
  return a.length - b.length;
}

function comparePart(a, b, sorting) {
  return sorting === 'word-by-word' ? compareWords(words(a), words(b)) : COLLATOR.compare(letters(a), letters(b));
}

/** Orders two headings by a sorting system. */
export function compareHeadings(a, b, sorting = 'letter-by-letter', { subentry = false } = {}) {
  const left = subentry ? a.replace(SKIPPED, '') : a;
  const right = subentry ? b.replace(SKIPPED, '') : b;
  const [a1, a2] = parts(left);
  const [b1, b2] = parts(right);
  return comparePart(a1, b1, sorting) || comparePart(a2, b2, sorting) || COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

const joinTargets = targets => targets.join('; ');

/**
 * The index in lines and Word blocks.
 * @param {Array<{ heading: string, pages: string[], subentries?: Array<{ heading: string, pages: string[] }>,
 *   see?: string[], seeAlso?: string[] }>} entries pages in book order
 * @param {{ layout?: string, sorting?: string, style?: string, collapse?: boolean }} options
 * @returns {{ lines: string[], blocks: object[], count: number }} count: entries printed
 */
export function formatIndex(entries, { layout = 'indented', sorting = 'letter-by-letter', style = 'chicago', collapse = true } = {}) {
  const locators = pages => collapsePages(pages, { collapse, style }).join(', ');
  const printed = entries
    .map(entry => ({
      ...entry,
      subentries: (entry.subentries ?? []).filter(sub => sub.pages?.length).sort((a, b) => compareHeadings(a.heading, b.heading, sorting, { subentry: true })),
      see: entry.see ?? [],
      seeAlso: entry.seeAlso ?? [],
    }))
    .filter(entry => entry.heading && (entry.see.length || entry.pages?.length || entry.subentries.length))
    .sort((a, b) => compareHeadings(a.heading, b.heading, sorting));
  const lines = [];
  const blocks = [];
  let letter = null;
  for (const entry of printed) {
    const here = letterFor(sortKey(entry.heading));
    if (here !== letter) {
      if (letter !== null) lines.push('');
      lines.push(here);
      blocks.push({ type: 'heading', level: 2, text: here });
      letter = here;
    }
    // A heading that sends the reader elsewhere prints no locators: "AI. See artificial intelligence".
    if (entry.see.length) {
      lines.push(`${entry.heading}. See ${joinTargets(entry.see)}`);
      blocks.push({ type: 'index', level: 1, runs: [{ text: `${entry.heading}. ` }, { text: 'See', italic: true }, { text: ` ${joinTargets(entry.see)}` }] });
      continue;
    }
    const own = entry.pages?.length ? locators(entry.pages) : '';
    if (layout === 'run-in') {
      const runs = [{ text: entry.heading }];
      if (own) runs.push({ text: `, ${own}` });
      entry.subentries.forEach((sub, at) => runs.push({ text: `${at === 0 ? (own ? '; ' : ': ') : '; '}${sub.heading}, ${locators(sub.pages)}` }));
      if (entry.seeAlso.length) runs.push({ text: '. ' }, { text: 'See also', italic: true }, { text: ` ${joinTargets(entry.seeAlso)}` });
      lines.push(runs.map(run => run.text).join(''));
      blocks.push({ type: 'index', level: 1, runs });
      continue;
    }
    const head = [{ text: entry.heading }];
    if (own) head.push({ text: `, ${own}` });
    if (entry.seeAlso.length && !entry.subentries.length) head.push({ text: '. ' }, { text: 'See also', italic: true }, { text: ` ${joinTargets(entry.seeAlso)}` });
    lines.push(head.map(run => run.text).join(''));
    blocks.push({ type: 'index', level: 1, runs: head });
    for (const sub of entry.subentries) {
      lines.push(`${INDENT}${sub.heading}, ${locators(sub.pages)}`);
      blocks.push({ type: 'index', level: 2, runs: [{ text: `${sub.heading}, ${locators(sub.pages)}` }] });
    }
    if (entry.seeAlso.length && entry.subentries.length) {
      lines.push(`${INDENT}See also ${joinTargets(entry.seeAlso)}`);
      blocks.push({ type: 'index', level: 2, runs: [{ text: 'See also', italic: true }, { text: ` ${joinTargets(entry.seeAlso)}` }] });
    }
  }
  return { lines, blocks, count: printed.length };
}

/** The index as a Word file: a title, a line on how it was made, and the entries. */
export function indexDocx(formatted, { note } = {}) {
  return buildDocx([{ type: 'heading', level: 1, text: 'Index' }, ...(note ? [{ type: 'paragraph', text: note }] : []), ...formatted.blocks]);
}
