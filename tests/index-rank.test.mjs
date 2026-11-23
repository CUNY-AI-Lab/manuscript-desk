import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FILTER, FILTER_CURVE, describeFilter, passesFilter, rankEntries } from '../lib/index/rank.js';

// Invented proposals with the facts lib/index/terms.js gives them.
const entry = (text, extra = {}) => ({ id: text, text, section: 'terms', kind: 'concept', status: 'proposed', count: 1, spread: 1, passages: 1, discussed: 0, ...extra });

test('the default hides concepts on one page only, never a name, never what the author accepted or dropped', () => {
  assert.deepEqual(DEFAULT_FILTER, { concepts: 2, names: 1 });
  assert.equal(passesFilter(entry('once'), DEFAULT_FILTER), false);
  assert.equal(passesFilter(entry('twice', { spread: 2 }), DEFAULT_FILTER), true);
  assert.equal(passesFilter(entry('Example, Ada', { section: 'names', kind: 'person' }), DEFAULT_FILTER), true);
  assert.equal(passesFilter(entry('Silent Rivers', { kind: 'work' }), DEFAULT_FILTER), true);
  assert.equal(passesFilter(entry('once', { status: 'accepted' }), DEFAULT_FILTER), true);
  assert.equal(passesFilter(entry('once', { status: 'dropped' }), { concepts: 6, names: 6 }), true);
  assert.equal(passesFilter(entry('not found', { spread: 0, count: 0 }), { concepts: 1, names: 1 }), true, 'every proposal passes at 1 page');
  assert.equal(passesFilter(entry('Lisbon', { kind: 'place', spread: 2 }), { concepts: 1, names: 3 }), false);
});

test('ranked by passages, then pages, then occurrences, then discussion; ties alphabetical', () => {
  const ranked = rankEntries([entry('b'), entry('a'), entry('wide', { spread: 5 }), entry('often', { passages: 3 }), entry('talked', { discussed: 2 })]);
  assert.deepEqual(ranked.map(item => item.text), ['often', 'wide', 'talked', 'a', 'b']);
});

test('the measurement\'s curve and the filter in words', () => {
  assert.equal(describeFilter({ concepts: 2, names: 1 }), 'concepts on at least 2 pages, every name');
  assert.equal(describeFilter({ concepts: 1, names: 1 }), 'every concept, every name');
  assert.deepEqual(FILTER_CURVE[0], { concepts: 1, names: 1 });
  assert.ok(FILTER_CURVE.some(point => point.concepts === 3 && point.names === 3));
});

test('people may have their own threshold, else they follow the names; an entry the author moved always shows', () => {
  const ada = entry('Example, Ada', { section: 'names', kind: 'person', spread: 2 });
  assert.equal(passesFilter(ada, { concepts: 1, names: 3 }), false, 'no people threshold: the names\'');
  assert.equal(passesFilter(ada, { concepts: 1, names: 3, people: 2 }), true);
  assert.equal(passesFilter(entry('Lisbon', { kind: 'place', spread: 2 }), { concepts: 1, names: 3, people: 1 }), false, 'a place is not a person');
  assert.equal(passesFilter(entry('once', { moved: true }), { concepts: 6, names: 6 }), true);
});
