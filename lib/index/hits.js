// Where each entry of the term list occurs in the book, occurrence by occurrence, for the model
// helpers that judge hits in context or sort them into subentries. The pages are always exactly
// the ones book-index's buildIndex finds (it runs first, on exactly the lines book-index would be
// given); this module only finds, on those pages, each occurrence and the words around it, with the
// same normalization and the same whole-word rules (lib/index/indexer.js). It also says which
// entries look ambiguous and why. Pure: no DOM, no network.

import { addTerms, buildIndex, pageVariants, variantRegExp } from './indexer.js';
import { displayOf, matcherInput } from './termlist.js';

export const CONTEXT_CHARS = 220;
// A short all-capitals variant (US, AI, WHO) also spells ordinary words or other names.
const ACRONYM = /^[A-Z]{2,4}$/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

/** The search forms of an entry or subentry line, as buildIndex builds them (case folded unless matchCase). */
export function searchForms(line, section = 'terms', { matchCase = false } = {}) {
  const map = addTerms(new Map(), line, section === 'names');
  const forms = [...map.values()].flatMap(set => [...set]);
  return [...new Set(forms.map(form => (matchCase ? form : form.toLowerCase())))];
}

// The same forms with their case as typed, for telling a capitalized term from a lower-case hit.
const typedForms = (line, section) => [...new Set([...addTerms(new Map(), line, section === 'names').values()].flatMap(set => [...set]))];

const globalRegExp = (form, matchCase) => new RegExp(variantRegExp(form).source, `gu${matchCase ? '' : 'i'}`);

// Cuts the context at a word boundary, so a hit is never shown with half a word at either end.
function contextAround(text, start, end, chars) {
  let from = Math.max(0, start - chars);
  let to = Math.min(text.length, end + chars);
  if (from > 0) { const space = text.indexOf(' ', from); if (space !== -1 && space < start) from = space + 1; }
  if (to < text.length) { const space = text.lastIndexOf(' ', to); if (space > end) to = space; }
  return { before: `${from > 0 ? '…' : ''}${text.slice(from, start)}`, match: text.slice(start, end), after: `${text.slice(end, to)}${to < text.length ? '…' : ''}` };
}

// The occurrences of some forms on one page: in the first of the page's searchable forms (as
// written, line-end hyphens rejoined, or kept as compounds) where any form occurs; overlapping
// matches keep the longest.
function occurrences(pageText, forms, matchCase) {
  const variants = pageVariants(pageText, true);
  for (let formIndex = 0; formIndex < variants.length; formIndex += 1) {
    const text = variants[formIndex];
    const spans = [];
    for (const form of forms) {
      for (const match of text.matchAll(globalRegExp(form, matchCase))) spans.push({ start: match.index, end: match.index + match[0].length });
    }
    if (!spans.length) continue;
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const span of spans) if (!kept.length || span.start >= kept[kept.length - 1].end) kept.push(span);
    return { text, formIndex, spans: kept };
  }
  return null;
}

/**
 * Every occurrence of every entry on the pages buildIndex finds for it.
 * @param {Array<{ number: string|null, text: string }>} pages in PDF order (number null: skipped)
 * @param {object[]} entries the term list (lib/index/termlist.js)
 * @param {{ matchCase?: boolean, contextFor?: Set<string>|null, contextChars?: number }} options
 *   contextFor: the entry ids whose hits carry the words around them (all when null)
 * @returns {{ index: object, byEntry: Map<string, { pages: string[], hits: object[], subentryPages: Array<string[]> }> }}
 *   index: buildIndex's own result. A hit: { id, entryId, page, pdfIndex, formIndex, start, end,
 *   matched, context? }. subentryPages[i]: the entry's pages on which subentry i's own words occur.
 */
export function findHits(pages, entries, { matchCase = false, contextFor = null, contextChars = CONTEXT_CHARS } = {}) {
  const input = matcherInput(entries);
  const index = buildIndex(pages, input.terms, input.names, { matchCase });
  const pagesByDisplay = new Map(index.entries.map(entry => [entry.term, entry.pages]));
  const byEntry = new Map();
  for (const entry of entries) {
    const found = pagesByDisplay.get(displayOf(entry.text, entry.section)) ?? [];
    const wanted = new Set(found);
    const forms = searchForms(entry.text, entry.section, { matchCase });
    const hits = [];
    const subForms = (entry.subentries ?? []).map(sub => searchForms(sub.text, 'terms', { matchCase }));
    const subentryPages = subForms.map(() => []);
    pages.forEach((page, pdfIndex) => {
      if (page.number == null || !wanted.has(page.number)) return;
      const found = occurrences(page.text, forms, matchCase);
      const withContext = contextFor === null || contextFor.has(entry.id);
      if (!found) {
        // buildIndex matched with toLowerCase and this search with the i flag; where the two disagree
        // (a rare letter whose cases differ in length), the page still counts, with no context.
        hits.push({ id: `${entry.id}:${pdfIndex}:0`, entryId: entry.id, page: page.number, pdfIndex, formIndex: -1, start: 0, end: 0, matched: '', ...(withContext ? { context: contextAround(pageVariants(page.text, true)[0], 0, 0, contextChars) } : {}) });
      } else {
        found.spans.forEach((span, n) => {
          hits.push({ id: `${entry.id}:${pdfIndex}:${n}`, entryId: entry.id, page: page.number, pdfIndex, formIndex: found.formIndex, start: span.start, end: span.end, matched: found.text.slice(span.start, span.end), ...(withContext ? { context: contextAround(found.text, span.start, span.end, contextChars) } : {}) });
        });
      }
      if (subForms.length) {
        const searchable = pageVariants(page.text, matchCase);
        subForms.forEach((formsOfSub, at) => {
          if (formsOfSub.some(form => { const re = variantRegExp(form); return searchable.some(text => text.includes(form) && re.test(text)); }) && !subentryPages[at].includes(page.number)) subentryPages[at].push(page.number);
        });
      }
    });
    byEntry.set(entry.id, { pages: found, hits, subentryPages });
  }
  return { index, byEntry };
}

// The surname of a name in index order ("King, Martin Luther, Jr." -> "king"), or null.
const surnameOf = text => {
  const [last, first] = text.split(',').map(part => part.trim());
  return last && first ? last.toLowerCase() : null;
};

/**
 * Entries whose hits may not all be about what the entry means, each with its reasons in words:
 * marked by the author; a capitalized term found in lower case; a short all-capitals variant; a
 * search form shared with another entry; a single word that is the surname of a name in the list;
 * hits that are part of another entry's longer hit on the same page.
 * @returns {Map<string, string[]>} entry id -> reasons
 */
export function detectAmbiguous(entries, byEntry) {
  const reasons = new Map();
  const add = (id, reason) => { if (!reasons.has(id)) reasons.set(id, []); if (!reasons.get(id).includes(reason)) reasons.get(id).push(reason); };
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const surnames = new Map();
  for (const entry of entries) {
    if (entry.section !== 'names') continue;
    const surname = surnameOf(entry.text);
    if (surname) surnames.set(surname, [...(surnames.get(surname) ?? []), entry.id]);
  }
  const owners = new Map();
  for (const entry of entries) {
    for (const form of searchForms(entry.text, entry.section)) owners.set(form, [...new Set([...(owners.get(form) ?? []), entry.id])]);
  }
  for (const entry of entries) {
    if (entry.ambiguous) add(entry.id, 'marked by you');
    const typed = typedForms(entry.text, entry.section);
    const found = byEntry.get(entry.id);
    const lowered = (found?.hits ?? []).filter(hit => hit.matched && typed.some(form => form.length === hit.matched.length && [...form].some((char, at) => UPPER.test(char) && LOWER.test(hit.matched[at]))
      && !typed.some(other => other === hit.matched))).length;
    if (lowered) add(entry.id, `found ${lowered} ${lowered === 1 ? 'time' : 'times'} in lower case`);
    for (const form of typed) if (ACRONYM.test(form)) add(entry.id, `“${form}” is a short abbreviation`);
    for (const form of searchForms(entry.text, entry.section)) {
      const others = (owners.get(form) ?? []).filter(id => id !== entry.id);
      if (others.length) add(entry.id, `“${form}” is also searched for ${byId.get(others[0])?.text ?? 'another entry'}`);
      if (!form.includes(' ')) {
        const named = (surnames.get(form) ?? []).filter(id => id !== entry.id);
        if (named.length) add(entry.id, `“${form}” is the surname of ${named.length === 1 ? byId.get(named[0]).text : `${named.length} people in the list`}`);
      }
    }
  }
  // Hits inside another entry's longer hit on the same page and form ("Washington" in "George Washington").
  const spansByPage = new Map();
  for (const [entryId, { hits }] of byEntry) {
    for (const hit of hits) {
      if (hit.formIndex < 0) continue;
      const key = `${hit.pdfIndex}:${hit.formIndex}`;
      if (!spansByPage.has(key)) spansByPage.set(key, []);
      spansByPage.get(key).push({ entryId, start: hit.start, end: hit.end });
    }
  }
  const inside = new Map();
  for (const spans of spansByPage.values()) {
    for (const span of spans) {
      const host = spans.find(other => other.entryId !== span.entryId && other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start);
      if (host) inside.set(span.entryId, { count: (inside.get(span.entryId)?.count ?? 0) + 1, host: host.entryId });
    }
  }
  for (const [entryId, { count, host }] of inside) add(entryId, `${count} of its hits ${count === 1 ? 'is' : 'are'} part of ${byId.get(host)?.text ?? 'another entry'}`);
  return reasons;
}
