import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../lib/index/indexer.js';
import { detectAmbiguous, findHits, searchForms } from '../lib/index/hits.js';
import { matcherInput, parseTermList } from '../lib/index/termlist.js';

// Invented pages.
const pages = (...texts) => texts.map((text, i) => ({ number: String(i + 1), text }));
const BOOK = pages(
  'George Washington crossed the river. Later Washington wrote a letter.',
  'A bush grew by the road; the Bush family arrived.',
  'The intel-\nligence report reached the US embassy. Tell us more.',
  'Nothing to see here.',
);

test('the pages are exactly buildIndex\'s, and each occurrence is found with the words around it', () => {
  const { entries } = parseTermList('Terms:\nintelligence\nUS\nNames:\nWashington, George\nWashington\nBush\n');
  const { index, byEntry } = findHits(BOOK, entries);
  const input = matcherInput(entries);
  assert.deepEqual(index, buildIndex(BOOK, input.terms, input.names));
  const [intelligence, us, george, washington, bush] = entries.map(entry => byEntry.get(entry.id));
  assert.deepEqual(intelligence.pages, ['3']);
  assert.equal(intelligence.hits.length, 1);
  assert.equal(intelligence.hits[0].matched, 'intelligence');
  assert.deepEqual(george.hits.map(hit => hit.matched), ['George Washington']);
  assert.deepEqual(washington.hits.map(hit => hit.matched), ['Washington', 'Washington']);
  assert.deepEqual(bush.hits.map(hit => hit.matched), ['bush', 'Bush']);
  assert.deepEqual(us.hits.map(hit => hit.matched), ['US', 'us']);
  const [first] = washington.hits;
  assert.equal(first.context.match, 'Washington');
  assert.match(first.context.before, /George $/);
  assert.match(first.context.after, /^ crossed the river/);
  assert.equal(first.id, `${entries[3].id}:0:0`);
});

test('with matchCase the lower-case hits are not found, as in book-index', () => {
  const { entries } = parseTermList('US\nBush\n');
  const { byEntry } = findHits(BOOK, entries, { matchCase: true });
  assert.deepEqual(byEntry.get(entries[0].id).hits.map(hit => hit.matched), ['US']);
  assert.deepEqual(byEntry.get(entries[1].id).hits.map(hit => hit.matched), ['Bush']);
});

test('context only for the entries asked for, and skipped pages are never searched', () => {
  const { entries } = parseTermList('river\nBush\n');
  const skipped = BOOK.map((page, i) => (i === 1 ? { ...page, number: null } : page));
  const { byEntry } = findHits(skipped, entries, { contextFor: new Set([entries[0].id]) });
  assert.ok(byEntry.get(entries[0].id).hits[0].context);
  assert.deepEqual(byEntry.get(entries[1].id).hits, []);
});

test('subentry pages: the entry\'s pages on which the subentry\'s own words occur', () => {
  const { entries } = parseTermList('Terms:\nreport\nriver\n  letters (letter)\n  roads (road)\n');
  const { byEntry } = findHits(BOOK, entries);
  assert.deepEqual(byEntry.get(entries[1].id).subentryPages, [['1'], []]);
});

test('ambiguous entries and why: lower case, acronyms, shared forms, surnames, hits inside longer hits, marked', () => {
  const { entries } = parseTermList('Terms:\nUS\nriver [ambiguous]\nNames:\nWashington, George\nWashington\nBush\nBush, Laura\n');
  const { byEntry } = findHits(BOOK, entries);
  const reasons = detectAmbiguous(entries, byEntry);
  const of = text => reasons.get(entries.find(entry => entry.text === text).id) ?? [];
  assert.ok(of('US').some(reason => /in lower case/.test(reason)));
  assert.ok(of('US').some(reason => /short abbreviation/.test(reason)));
  assert.deepEqual(of('river'), ['marked by you']);
  assert.ok(of('Bush').some(reason => /in lower case/.test(reason)));
  assert.ok(of('Bush').some(reason => /surname of Bush, Laura/.test(reason)));
  assert.ok(of('Washington').some(reason => /surname of Washington, George/.test(reason)));
  assert.ok(of('Washington').some(reason => /1 of its hits is part of Washington, George/.test(reason)));
  assert.deepEqual(of('Washington, George'), []);
});

test('search forms follow book-index: names reversed, variants as typed, case folded unless asked', () => {
  assert.deepEqual(searchForms('King, Martin Luther, Jr.', 'names'), ['martin luther king jr.', 'martin luther king, jr.']);
  assert.deepEqual(searchForms('artificial intelligence (AI)', 'terms', { matchCase: true }), ['AI', 'artificial intelligence']);
});

test('a hit on the first line of its page is marked, for the judge to see a running head', () => {
  const book = [{ number: '7', text: 'Chapter Two: Rivers   7\nThe river rose again.' }];
  const { entries } = parseTermList('river\nRivers\n');
  const { byEntry } = findHits(book, entries);
  assert.deepEqual(byEntry.get(entries[1].id).hits.map(hit => hit.top), [true]);
  assert.deepEqual(byEntry.get(entries[0].id).hits.map(hit => hit.top ?? false), [false]);
});
