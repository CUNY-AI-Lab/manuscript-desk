// Ranking and filtering the proposed term list. A model proposes about twice as many entries as a
// professional index holds. Most of the excess is concepts named on one page only: an index takes a
// person, place or work it names even once, but a concept only where the book spends some time on it.
// So the term editor shows the proposals ranked and hides those below thresholds the author moves: the
// pages of the manuscript an entry occurs on (stretches of about a printed page, lib/index/terms.js
// `countAndDrop`), one threshold for concepts and one for names (people, places, organizations, works,
// events). The page shows people apart from the other names, so people may have a threshold of their
// own (`people`); without one they follow `names`, as the measurement counts them. Nothing is dropped
// by the filter: what it hides stays in the list, one click away. The default was chosen from the
// trade-off measured on the dev book (docs/eval/index-loop.md, round 2). Pure.

import { headingOf } from './termlist.js';

/** `concepts`: the fewest pages a concept must occur on to be shown; `names`: the same for every other kind; `people`, when given: the same for the entries searched as names. */
export const DEFAULT_FILTER = Object.freeze({ concepts: 2, names: 1 });
export const PAGE_CHOICES = Object.freeze([1, 2, 3, 4, 5, 6]);

// An entry not found by its own forms still counts as on one page: the model found it in a passage.
const pagesOf = entry => Math.max(Number.isInteger(entry.spread) ? entry.spread : 0, 1);
const isConcept = entry => (entry.kind ?? 'concept') === 'concept' && entry.section !== 'names';

/**
 * Whether the filter shows an entry. Entries the author accepted, dropped, typed or moved to the
 * other group are not mere proposals and always show.
 */
export function passesFilter(entry, { concepts = 1, names = 1, people } = {}) {
  if ((entry.status && entry.status !== 'proposed') || entry.moved === true) return true;
  return pagesOf(entry) >= (entry.section === 'names' ? people ?? names : isConcept(entry) ? concepts : names);
}

/** Larger first: proposed in more passages, on more pages, more occurrences, discussed in more passages. */
export function rankKey(entry) {
  return [entry.passages ?? 0, pagesOf(entry), entry.count ?? 0, entry.discussed ?? 0];
}

/** The entries in rank order (a copy); ties keep the heading's alphabetical order. */
export function rankEntries(list) {
  return [...list].sort((a, b) => {
    const ka = rankKey(a), kb = rankKey(b);
    for (let at = 0; at < ka.length; at += 1) if (ka[at] !== kb[at]) return kb[at] - ka[at];
    return headingOf(a.text).localeCompare(headingOf(b.text), 'en', { sensitivity: 'base' });
  });
}

/** The filter in words, as the measurement prints it. */
export function describeFilter({ concepts = 1, names = 1 } = {}) {
  const part = (what, pages) => (pages <= 1 ? `every ${what}` : `${what}s on at least ${pages} pages`);
  return `${part('concept', concepts)}, ${part('name', names)}`;
}

/** The points the measurement prints: concepts' threshold with every name, then both together. */
export const FILTER_CURVE = Object.freeze([
  ...PAGE_CHOICES.map(concepts => ({ concepts, names: 1 })),
  ...PAGE_CHOICES.slice(1).map(pages => ({ concepts: pages, names: pages })),
]);
