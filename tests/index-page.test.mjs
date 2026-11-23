import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { addEntries, defaultJudgeScope, editEntry, entriesFromText, indexEntries, invertedSubjects, judgeScopes, looksLikeInvertedName, mergeEntries, moveEntry, namesFromText, previewNames, restoredFilter, restoredState, savedState, setStatus, settingsFromSheet, subjectsFromText, termListFile, termsPlan, workingList, DEFAULT_SETTINGS } from '../web/index/state.js';
import { groupView, newView, shownEntries, viewEntries } from '../web/index/terms-view.js';
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

test('the term editor ranks the proposals and hides those below the thresholds until asked', () => {
  const made = (text, extra) => ({ id: text, text, section: 'terms', kind: 'concept', status: 'proposed', subentries: [], see: [], seeAlso: [], count: 1, spread: 1, passages: 1, ...extra });
  const list = [made('once'), made('wide', { spread: 4, passages: 2 }), made('Example, Ada', { section: 'names', kind: 'person' }), made('kept', { status: 'accepted' })];
  const view = viewEntries(list, {}, { concepts: 2, names: 1 });
  assert.deepEqual(view.shown.map(entry => entry.text), ['wide', 'Example, Ada', 'kept']);
  assert.equal(view.below, 1);
  assert.deepEqual(viewEntries(list, { below: true }, { concepts: 2, names: 1 }).shown.map(entry => entry.text).sort(), ['Example, Ada', 'kept', 'once', 'wide']);
  assert.deepEqual(viewEntries(list, { order: 'list' }, { concepts: 1, names: 1 }).shown.map(entry => entry.text), ['once', 'wide', 'Example, Ada', 'kept']);
  assert.deepEqual(DEFAULT_SETTINGS.filter, { concepts: 2, names: 1 });
  assert.deepEqual(restoredFilter({ concepts: 9, names: 3 }), { concepts: 2, names: 3, people: 3 }, 'saved before people had their own threshold, they follow the names');
  assert.deepEqual(restoredFilter({ concepts: 2, names: 1, people: 4 }), { concepts: 2, names: 1, people: 4 });
  assert.deepEqual(restoredFilter('nonsense'), { concepts: 2, names: 1 });
  // The facts and the thresholds are kept in this browser and come back.
  const saved = savedState({ entries: list, settings: { ...DEFAULT_SETTINGS, filter: { concepts: 3, names: 1 } }, proposing: null, pdf: null, ranges: [], manualRanges: '', decisions: {}, overrides: {}, appliedJudge: {}, assignments: {}, appliedSorting: {} });
  const back = restoredState(structuredClone(saved));
  assert.deepEqual(back.settings.filter, { concepts: 3, names: 1, people: 1 });
  assert.deepEqual(back.entries.find(entry => entry.text === 'wide').spread, 4);
});

test('the judge reads the entries the author marked, those the tool flags, or both, each with hits', () => {
  const { entries } = entriesFromText('Terms:\nriver [ambiguous]\nlake\nsea [ambiguous]\n');
  const [river, lake, sea] = entries;
  const reasons = new Map([[river.id, ['marked by you', 'found 2 times in lower case']], [lake.id, ['found 1 time in lower case']], [sea.id, ['marked by you']]]);
  const byEntry = new Map([[river.id, { hits: [{ id: 'h1' }] }], [lake.id, { hits: [{ id: 'h2' }] }], [sea.id, { hits: [] }]]);
  const scopes = judgeScopes(entries, reasons, byEntry);
  assert.deepEqual(scopes.marked.map(entry => entry.text), ['river']);
  assert.deepEqual(scopes.flagged.map(entry => entry.text), ['river', 'lake']);
  assert.deepEqual(scopes.both.map(entry => entry.text), ['river', 'lake']);
  assert.equal(defaultJudgeScope(scopes), 'marked');
  assert.equal(defaultJudgeScope({ marked: [], flagged: [lake], both: [lake] }), 'flagged');
});

const empty = { proposing: null, pdf: null, ranges: [], manualRanges: '', decisions: {}, overrides: {}, appliedJudge: {}, assignments: {}, appliedSorting: {} };

test('the Names box puts each person surname first, keeps what is typed surname first, and the preview says so', () => {
  const typed = 'Mary Shelley\n  early life\n  see also Godwin, William\nShelley, Percy Bysshe [ambiguous]\nSimone de Beauvoir (Beauvoir)\nPlato\nExample Brothers\n';
  const { entries } = namesFromText(typed);
  assert.deepEqual(entries.map(entry => [entry.section, entry.text, entry.status, entry.ambiguous]), [
    ['names', 'Shelley, Mary', 'accepted', false],
    ['names', 'Shelley, Percy Bysshe', 'accepted', true],
    ['names', 'Beauvoir, Simone de (Beauvoir)', 'accepted', false],
    ['names', 'Plato', 'accepted', false],
    ['names', 'Example Brothers', 'accepted', false],
  ]);
  assert.deepEqual(entries[0].subentries, [{ text: 'early life' }]);
  assert.deepEqual(entries[0].seeAlso, ['Godwin, William']);
  assert.deepEqual(previewNames(typed).map(row => [row.typed, row.heading, row.how, row.searched]), [
    ['Mary Shelley', 'Shelley, Mary', 'inverted', 'Mary Shelley'],
    ['Shelley, Percy Bysshe', 'Shelley, Percy Bysshe', 'as-typed', 'Percy Bysshe Shelley'],
    ['Simone de Beauvoir', 'Beauvoir, Simone de', 'inverted', 'Simone de Beauvoir'],
    ['Plato', 'Plato', 'single', 'Plato'],
    ['Example Brothers', 'Example Brothers', 'organization', 'Example Brothers'],
  ]);
  // A whole term list pasted into the box is read as one, its subjects staying subjects.
  assert.deepEqual(namesFromText('Terms:\nriver\nNames:\nShelley, Mary\n').entries.map(entry => [entry.section, entry.text]), [['terms', 'river'], ['names', 'Shelley, Mary']]);
  assert.deepEqual(previewNames('Terms:\nriver'), []);
  // The download keeps book-index's syntax.
  assert.equal(termListFile(entries).text.split('\n').slice(0, 4).join('\n'), 'Names:\nShelley, Mary\n  early life\n  see also Godwin, William');
});

test('the Subjects box reads the term list syntax, so lines are subjects unless a Names: line says otherwise', () => {
  const { entries } = subjectsFromText('artificial intelligence (AI, machine learning)\nLisbon\nThe Long Night\n');
  assert.deepEqual(entries.map(entry => [entry.section, entry.text]), [['terms', 'artificial intelligence (AI, machine learning)'], ['terms', 'Lisbon'], ['terms', 'The Long Night']]);
});

test('an entry moves between the groups with its facts; into Names it is put surname first, out of Names it keeps finding the same words', () => {
  const made = (text, section, extra = {}) => ({ id: text, text, section, kind: section === 'names' ? 'person' : 'concept', status: 'proposed', subentries: [], see: [], seeAlso: [], ambiguous: false, count: 3, spread: 1, passages: 1, ...extra });
  const list = [made('Mary Shelley (Shelley)', 'terms'), made('Example, Ada', 'names'), made('Hamlet', 'names'), made('river', 'terms')];
  const moved = moveEntry(list, 'Mary Shelley (Shelley)', 'names');
  assert.deepEqual([moved[0].section, moved[0].text, moved[0].moved, moved[0].count, moved[0].status, moved[0].kind], ['names', 'Shelley, Mary (Shelley)', true, 3, 'proposed', 'concept']);
  const out = moveEntry(list, 'Example, Ada', 'terms');
  assert.equal(out[1].text, 'Example, Ada (Ada Example)', 'a surname-first heading keeps the order the text uses as a form');
  assert.equal(moveEntry(list, 'Hamlet', 'terms')[2].text, 'Hamlet');
  assert.equal(moveEntry(list, 'river', 'sideways'), list);
  assert.equal(moveEntry(list, 'river', 'terms')[3], list[3], 'already there: unchanged');
  // A moved proposal stays shown whatever the threshold, in its new group, and its move is kept.
  assert.equal(viewEntries(moved, { group: 'names' }, { concepts: 6, names: 6, people: 6 }).shown.some(entry => entry.id === 'Mary Shelley (Shelley)'), true);
  const back = restoredState(structuredClone(savedState({ entries: moved, settings: DEFAULT_SETTINGS, ...empty })));
  assert.equal(back.entries.find(entry => entry.text === 'Shelley, Mary (Shelley)').moved, true);
});

test('the two groups are shown apart, each with its own threshold: people, then concepts and the other names', () => {
  const made = (text, section, kind, spread = 1) => ({ id: text, text, section, kind, status: 'proposed', subentries: [], see: [], seeAlso: [], count: 1, spread, passages: 1 });
  const list = [made('Example, Ada', 'names', 'person'), made('Other, Ben', 'names', 'person', 3), made('once', 'terms', 'concept'), made('wide', 'terms', 'concept', 4), made('Lisbon', 'terms', 'place')];
  const view = newView();
  const filter = { concepts: 2, names: 1, people: 2 };
  assert.deepEqual(viewEntries(list, groupView(view, 'names'), filter).shown.map(entry => entry.text), ['Other, Ben']);
  assert.equal(viewEntries(list, groupView(view, 'names'), filter).below, 1);
  assert.deepEqual(viewEntries(list, groupView(view, 'terms'), filter).shown.map(entry => entry.text), ['wide', 'Lisbon']);
  view.groups.terms.kind = 'place';
  assert.deepEqual(viewEntries(list, groupView(view, 'terms'), filter).shown.map(entry => entry.text), ['Lisbon']);
  view.groups.names.below = true;
  assert.equal(viewEntries(list, groupView(view, 'names'), filter).shown.length, 2);
  // Without a people threshold, people follow the names', as before.
  assert.equal(viewEntries(list, groupView(newView(), 'names'), { concepts: 2, names: 1 }).shown.length, 2);
});

test('subjects that read like a person surname first are offered to Names; titles and bodies are not', () => {
  for (const heading of ['Shelley, Mary', 'Du Bois, W. E. B.', 'King, Martin Luther, Jr.', 'Beauvoir, Simone de']) assert.equal(looksLikeInvertedName(heading), true, heading);
  for (const heading of ['Long Night, The', 'Example Press, The', 'artificial intelligence', 'reading, close', 'Silent Rivers', 'Ada']) assert.equal(looksLikeInvertedName(heading), false, heading);
  const { entries } = entriesFromText('Shelley, Mary\nriver\nLong Night, The\nNames:\nExample, Ada\n');
  assert.deepEqual(invertedSubjects(entries).map(entry => entry.text), ['Shelley, Mary']);
  assert.deepEqual(invertedSubjects(moveEntry(entries, entries[0].id, 'names')), []);
});

test('saved work from before the groups comes back whole: an entry without a section is sorted by its kind', () => {
  const saved = {
    entries: [
      { id: 'e1', section: 'terms', text: 'river', status: 'accepted' },
      { id: 'e2', section: 'names', text: 'Example, Ada', status: 'accepted' },
      { id: 'e3', text: 'Other, Ben', status: 'proposed', kind: 'person', count: 2 },
      { id: 'e4', text: 'memory', status: 'proposed', kind: 'concept' },
      { id: 'e5', section: 'sideways', text: 'Lisbon', status: 'accepted' },
      { id: 'e6', text: 'harbour' },
    ],
    settings: { ...DEFAULT_SETTINGS, filter: { concepts: 3, names: 2 } },
  };
  const back = restoredState(saved);
  assert.deepEqual(back.entries.map(entry => [entry.id, entry.section, entry.text, entry.status]), [
    ['e1', 'terms', 'river', 'accepted'], ['e4', 'terms', 'memory', 'proposed'], ['e5', 'terms', 'Lisbon', 'accepted'], ['e6', 'terms', 'harbour', 'accepted'],
    ['e2', 'names', 'Example, Ada', 'accepted'], ['e3', 'names', 'Other, Ben', 'proposed'],
  ]);
  assert.equal(back.entries.find(entry => entry.id === 'e3').count, 2);
  assert.deepEqual(back.settings.filter, { concepts: 3, names: 2, people: 2 });
});
