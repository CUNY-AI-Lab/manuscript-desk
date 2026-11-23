import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { addEntries, editEntry, entriesFromText, indexEntries, mergeEntries, restoredState, savedState, setStatus, settingsFromSheet, termListFile, termsPlan, workingList, DEFAULT_SETTINGS } from '../web/index/state.js';
import { shownEntries } from '../web/index/terms-view.js';
import { createStore } from '../web/shared/store.js';
import { findHits } from '../lib/index/hits.js';
import { newSheet } from '../lib/rules/schema.js';

const pages = (...texts) => texts.map((text, i) => ({ number: String(i + 1), text }));

test('a loaded list is accepted; proposals are not in the index or the download until accepted', () => {
  const { entries } = entriesFromText('Terms:\nriver\nNames:\nExample, Ada\n');
  assert.ok(entries.every(entry => entry.status === 'accepted'));
  const proposed = { ...entries[0], id: 'e900', text: 'lake', status: 'proposed' };
  const list = [...entries, proposed];
  assert.deepEqual(workingList(list).map(entry => entry.text), ['river', 'Example, Ada']);
  assert.equal(termListFile(list).text, 'Terms:\nriver\nNames:\nExample, Ada\n');
  assert.equal(workingList(setStatus(list, ['e900'], 'accepted')).length, 3);
  assert.equal(addEntries(list, entriesFromText('river\nsea').entries).added, 1);
});

test('editing, merging and the filter', () => {
  const { entries } = entriesFromText('Names:\nExample, Ada\nExample, A.\nOther, Ben\n');
  const [ada, initial, ben] = entries;
  const edited = editEntry(entries, ben.id, { heading: 'Other, Benedict', variants: ['Ben Other'], ambiguous: true, see: ['Example, Ada'] });
  assert.equal(edited[2].text, 'Other, Benedict (Ben Other)');
  assert.equal(edited[2].ambiguous, true);
  const merged = mergeEntries(entries, initial.id, ada.id);
  assert.deepEqual(merged.map(entry => entry.text), ['Example, Ada (A. Example)', 'Other, Ben']);
  assert.deepEqual(shownEntries(merged, { search: 'other' }).map(entry => entry.text), ['Other, Ben']);
  assert.deepEqual(shownEntries(merged, { kind: 'name', status: 'accepted' }).length, 2);
});

test('the index from the match and the choices: dropped hits and sorted subentries apply only when applied', () => {
  const book = pages('The river rose. A river boat.', 'The river flooded the town.', 'Floods of the river again.', 'Nothing here.');
  const { entries } = entriesFromText('river\n  floods (flooded)\n  boats\n');
  const { byEntry } = findHits(book, entries);
  const [river] = entries;
  const hits = byEntry.get(river.id).hits;
  // Pages 2 and 3 hold the first subentry's own words, so they go to it.
  assert.deepEqual(indexEntries(entries, byEntry)[0].pages, ['1']);
  assert.deepEqual(indexEntries(entries, byEntry)[0].subentries.map(sub => sub.pages), [['2', '3'], []]);
  // A drop proposed but not applied changes nothing; applied, a page goes when all its hits go.
  const decisions = Object.fromEntries(hits.filter(hit => hit.page === '1').map(hit => [hit.id, { keep: false }]));
  assert.deepEqual(indexEntries(entries, byEntry, { decisions })[0].pages, ['1']);
  assert.deepEqual(indexEntries(entries, byEntry, { decisions, appliedJudge: { [river.id]: true } })[0].pages, []);
  const overrides = { [hits[0].id]: true };
  assert.deepEqual(indexEntries(entries, byEntry, { decisions, appliedJudge: { [river.id]: true }, overrides })[0].pages, ['1']);
  const assignments = { [hits.find(hit => hit.page === '3').id]: 0, [hits[0].id]: 1 };
  const sorted = indexEntries(entries, byEntry, { assignments, appliedSorting: { [river.id]: true } })[0];
  assert.deepEqual(sorted.pages, []);
  assert.deepEqual(sorted.subentries.map(sub => sub.pages), [['2', '3'], ['1']]);
});

test('the index conventions come from a Formatter rule sheet when it states them', () => {
  const sheet = newSheet('monograph');
  sheet.rules.push({ id: 'index-1', category: 'index', slot: 'index.page-ranges', statement: 'Give page ranges in full.', mode: 'fix', source: { kind: 'author' }, params: { style: 'full' }, enabled: true });
  sheet.rules.push({ id: 'index-2', category: 'index', slot: 'index.layout', statement: 'Run in the subentries.', mode: 'fix', source: { kind: 'author' }, params: { layout: 'run-in' }, enabled: false });
  assert.deepEqual(settingsFromSheet(JSON.stringify(sheet)), { ok: true, settings: { style: 'full' }, found: ['index.page-ranges'] });
  assert.equal(settingsFromSheet('not json').ok, false);
  assert.equal(settingsFromSheet('{"version": 99}').ok, false);
});

test('what this browser keeps holds no quotation, reason or heading from the files, and comes back checked', async () => {
  const { entries } = entriesFromText('Terms:\nriver\n  floods\nNames:\nExample, Ada [ambiguous]\n');
  const state = {
    entries: entries.map((entry, at) => ({ ...entry, quotes: ['a private sentence from the manuscript'], count: at + 1, kind: 'concept' })),
    settings: { ...DEFAULT_SETTINGS, layout: 'run-in' },
    proposing: { hash: 'a'.repeat(64), name: 'book.docx', answered: { 'terms:0-3': { unverified: 1, proposals: [{ heading: 'river', kind: 'concept', variants: [], quote: 'a private sentence from the manuscript', passage: 'terms:0-3' }] } } },
    pdf: { name: 'proofs.pdf', hash: 'b'.repeat(64), pages: 300 },
    ranges: [{ kind: 'bibliography', first: 280, last: 290, heading: 'Private Heading Words', on: true, cut: 412 }],
    manualRanges: '1-10',
    decisions: { 'e1:3:0': { keep: false, reason: 'a private reason quoting the book' } },
    overrides: { 'e1:4:0': true }, appliedJudge: { e1: true }, assignments: { 'e1:3:0': 0 }, appliedSorting: {},
  };
  const saved = savedState(state);
  const text = JSON.stringify(saved);
  for (const secret of ['private sentence', 'Private Heading', 'private reason']) assert.equal(text.includes(secret), false, secret);
  const store = createStore({ indexedDB: globalThis.indexedDB, name: 'manuscript-desk-index-test' });
  await store.saveJob('index', saved);
  const back = restoredState(await store.loadJob('index'));
  assert.deepEqual(back.entries.map(entry => [entry.id, entry.text, entry.status, entry.count, entry.ambiguous]), state.entries.map(entry => [entry.id, entry.text, 'accepted', entry.count, entry.ambiguous]));
  assert.deepEqual(back.entries[0].subentries, [{ text: 'floods' }]);
  assert.equal(back.settings.layout, 'run-in');
  assert.deepEqual(back.ranges, [{ kind: 'bibliography', first: 280, last: 290, on: true, heading: '', cut: 412 }]);
  assert.deepEqual(back.decisions, { 'e1:3:0': { keep: false, reason: '' } });
  assert.equal(back.proposing.answered['terms:0-3'].proposals[0].quote, undefined);
  assert.deepEqual(restoredState({ entries: 'nonsense', settings: { layout: 'sideways' } }).settings.layout, 'indented');
  assert.deepEqual(restoredState(null), {});
});

test('the Index Builder keeps its work in its own database, apart from the Formatter\'s', async () => {
  const formatter = createStore({ indexedDB: globalThis.indexedDB });
  const index = createStore({ indexedDB: globalThis.indexedDB, name: 'manuscript-desk-index' });
  await formatter.saveJob('format', { kept: true });
  await index.saveJob('index', { kept: true });
  await index.clearAll();
  assert.deepEqual(await formatter.loadJob('format'), { kept: true });
  assert.equal(await index.loadJob('index'), null);
});

test('the plan says the number of calls before stage 1 runs', () => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => ({ index, kind: 'paragraph', text: `Paragraph ${index} ${'words '.repeat(80)}`, hints: {} }));
  const plan = termsPlan(paragraphs, new Set([0]));
  assert.ok(plan.calls >= 2);
  assert.match(plan.text, /^\d+ model calls, one per passage of about 9,000 characters; 1 paragraph of bibliography left out\.$/);
});
