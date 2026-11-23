// The term list the Index Builder's two stages share, and its file. The file is book-index's
// syntax: one term per line, variants in parentheses (`artificial intelligence (AI, machine
// learning)`), names in index order (`King, Martin Luther, Jr.`). A list in that syntax alone is
// all terms, as book-index's Terms box reads it. This tool adds, and only ever adds:
//   - a line `Terms:` or `Names:` on its own, starting the terms or the names (names are searched
//     as "First Last", as in book-index's Names box);
//   - a line indented under an entry, for a subentry (`  early life (childhood)`), or for a
//     cross-reference (`  see artificial intelligence`, `  see also neural networks; robots`);
//   - a trailing ` [ambiguous]` on an entry, for a term whose hits should be judged in context.
// Indentation common to every line of a section is ignored, so a pasted list whose lines all start
// with spaces still reads as book-index reads it. Pure: no DOM, no network.

import { addTerms } from './indexer.js';

export const SECTIONS = Object.freeze(['terms', 'names']);
const SECTION_LINE = /^\s*(terms|names)\s*:\s*$/i;
const AMBIGUOUS_MARK = /\s+\[ambiguous\]\s*$/i;
const SEE_ALSO = /^see\s+also\s+(.+)$/i;
const SEE = /^see\s+(.+)$/i;
export const MAX_ENTRIES = 5000;
export const MAX_LINE = 500;

const collapse = text => text.replace(/\s+/gu, ' ').trim();
const indentOf = line => /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
const targets = text => text.split(';').map(collapse).filter(Boolean);

/** The display book-index gives a line (the key of its entry), or '' for a line with nothing to search. */
export function displayOf(line, section = 'terms') {
  const map = addTerms(new Map(), line, section === 'names');
  return [...map.keys()][0] ?? '';
}

/** The heading an index prints for an entry or subentry: its line without the parenthetical variants. */
export function headingOf(line) {
  return collapse(String(line ?? '').replace(/\([^)]*\)/g, ' ')).replace(/^["'`´‘’“”„‟‹›«»]+|["'`´‘’“”„‟‹›«»]+$/gu, '').trim();
}

/** The variants written in a line's parentheses. */
export function variantsOf(line) {
  return [...String(line ?? '').matchAll(/\(([^)]+)\)/g)].flatMap(match => match[1].split(',')).map(collapse).filter(Boolean);
}

/** A line made of a heading and variants, in the file's syntax. */
export function lineOf(heading, variants = []) {
  const unique = [...new Set(variants.map(collapse).filter(Boolean))].filter(variant => variant.toLowerCase() !== collapse(heading).toLowerCase());
  return unique.length ? `${collapse(heading)} (${unique.join(', ')})` : collapse(heading);
}

let lastId = 0;
/** A new entry id, unique in this page's lifetime and among `taken`. */
export function newId(taken = new Set()) {
  let id;
  do { lastId += 1; id = `e${lastId}`; } while (taken.has(id));
  return id;
}

/** An entry: what the file holds, plus fields the page may add (kind, status, count). */
export function newEntry({ section = 'terms', text, ambiguous = false, subentries = [], see = [], seeAlso = [], id, taken, ...extra }) {
  return { id: id ?? newId(taken), section: SECTIONS.includes(section) ? section : 'terms', text: collapse(text), ambiguous: Boolean(ambiguous), subentries: subentries.map(sub => ({ text: collapse(sub.text ?? sub) })).filter(sub => sub.text), see: [...see], seeAlso: [...seeAlso], ...extra };
}

/**
 * Reads a term list file (or pasted text). Never throws.
 * @returns {{ entries: object[], problems: string[] }} problems: lines that could not be placed, in words.
 */
export function parseTermList(text) {
  const entries = [];
  const problems = [];
  if (typeof text !== 'string') return { entries, problems: ['This is not a term list.'] };
  const lines = text.replace(/^﻿/, '').split(/\r\n?|\n/);
  // Split into sections first, so each section's common indentation can be ignored.
  const sections = [];
  let current = { section: 'terms', lines: [] };
  sections.push(current);
  for (const line of lines) {
    const header = SECTION_LINE.exec(line);
    if (header) {
      current = { section: header[1].toLowerCase(), lines: [] };
      sections.push(current);
    } else current.lines.push(line);
  }
  const taken = new Set();
  const byDisplay = new Map();
  for (const { section, lines: body } of sections) {
    const content = body.filter(line => line.trim());
    const common = content.length ? Math.min(...content.map(indentOf)) : 0;
    let parent = null;
    for (const raw of content) {
      if (raw.length > MAX_LINE) { problems.push(`A line longer than ${MAX_LINE} characters was left out.`); continue; }
      const indented = indentOf(raw) > common;
      const line = collapse(raw);
      if (indented && parent) {
        const also = SEE_ALSO.exec(line);
        const see = also ? null : SEE.exec(line);
        if (also) parent.seeAlso.push(...targets(also[1]));
        else if (see) parent.see.push(...targets(see[1]));
        else parent.subentries.push({ text: line });
        continue;
      }
      const ambiguous = AMBIGUOUS_MARK.test(line);
      const entryText = line.replace(AMBIGUOUS_MARK, '').trim();
      if (!displayOf(entryText, section)) { parent = null; continue; }
      if (entries.length >= MAX_ENTRIES) { problems.push(`A list can hold at most ${MAX_ENTRIES} entries; the rest were left out.`); break; }
      // The same entry twice in a section is one entry, as book-index makes it.
      const key = `${section}\u0000${displayOf(entryText, section)}`;
      const same = byDisplay.get(key);
      if (same) {
        same.ambiguous ||= ambiguous;
        parent = same;
        continue;
      }
      parent = newEntry({ section, text: entryText, ambiguous, taken });
      taken.add(parent.id);
      byDisplay.set(key, parent);
      entries.push(parent);
    }
  }
  return { entries, problems: [...new Set(problems)] };
}

/** The file text of a list: the terms, then the names, each entry with its subentries and cross-references. */
export function serializeTermList(entries) {
  const out = [];
  for (const section of SECTIONS) {
    const own = entries.filter(entry => entry.section === section);
    if (!own.length) continue;
    out.push(section === 'terms' ? 'Terms:' : 'Names:');
    for (const entry of own) {
      out.push(entry.ambiguous ? `${entry.text} [ambiguous]` : entry.text);
      for (const sub of entry.subentries ?? []) out.push(`  ${sub.text}`);
      if (entry.see?.length) out.push(`  see ${entry.see.join('; ')}`);
      if (entry.seeAlso?.length) out.push(`  see also ${entry.seeAlso.join('; ')}`);
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** What book-index's two boxes would hold for this list: the entries' lines, nothing else. */
export function matcherInput(entries) {
  const of = section => entries.filter(entry => entry.section === section).map(entry => entry.text).join('\n');
  return { terms: of('terms'), names: of('names') };
}
