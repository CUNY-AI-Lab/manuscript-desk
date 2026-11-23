// The Formatter page's pure state decisions: what loading a sheet does, what a read leaves on the
// page, which sentence names each failure, and what is saved and restored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { LOADED_NOTICE, afterRead, droppedNotice, manualNotice, failureLines, failureSentence, loadSheetQuestion, loadedSheetState, removeGuideline, restoredState, savedState } from '../web/format/app.js';
import { splitGuidelines } from '../lib/rules/chunk.js';
import { newSheet } from '../lib/rules/schema.js';
import { createStore } from '../web/shared/store.js';

const TEXT = 'Use double quotation marks throughout the manuscript. '.repeat(5);
const LONG = Array.from({ length: 30 }, (_, p) => Array.from({ length: 40 }, (_, s) => `Sentence ${p * 40 + s} states one more requirement.`).join(' ')).join('\n\n');
const quoted = (id, doc = 0) => ({ id, category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.', mode: 'fix',
  source: { kind: 'guidelines', quote: 'Use double quotation marks throughout the manuscript.', doc }, params: { style: 'double' }, enabled: true });
const author = id => ({ id, category: 'other', slot: null, statement: 'Number the pages.', mode: 'flag', source: { kind: 'author' }, params: {}, enabled: true });
const sheetWith = rules => ({ ...newSheet('monograph'), rules });
const JARGON = /\b(slot|schema|json|payload|params?)\b/i;

test('the loaded-sheet notice has its exact wording', () => {
  assert.equal(LOADED_NOTICE, 'This rule sheet was loaded from a file. Its quotations have not been checked against any guidelines.');
});

test('loading a sheet marks it as from a file and clears the guidelines and failures', () => {
  const sheet = sheetWith([quoted('quotations-1')]);
  assert.deepEqual(loadedSheetState(sheet), { sheet, docType: 'monograph', guidelines: [], failures: [], loadedFromFile: true });
});

test('the question before loading a sheet says what will be lost', () => {
  const guidelines = [{ name: 'a.docx', text: TEXT }];
  assert.equal(loadSheetQuestion({ sheet: null, guidelines: [] }), null, 'nothing to lose, nothing to ask');
  assert.equal(loadSheetQuestion({ sheet: sheetWith([]), guidelines: [] }), null);
  assert.equal(loadSheetQuestion({ sheet: sheetWith([quoted('quotations-1')]), guidelines: [] }), 'Loading a rule sheet replaces the rule sheet below. Continue?');
  assert.equal(loadSheetQuestion({ sheet: null, guidelines }), 'Loading a rule sheet clears the guidelines you added, because its rules were not read from them. Continue?');
  assert.equal(loadSheetQuestion({ sheet: sheetWith([quoted('quotations-1')]), guidelines }),
    'Loading a rule sheet replaces the rule sheet below and clears the guidelines you added, because its rules were not read from them. Continue?');
});

test('a fresh read replaces a loaded sheet and clears the mark', () => {
  const loaded = { sheet: sheetWith([quoted('quotations-1'), author('other-a1')]), failures: [], loadedFromFile: true };
  const read = { sheet: sheetWith([quoted('quotations-1')]), failures: [{ group: 'style', doc: 0, part: 0, code: 'quota_exceeded' }] };
  assert.deepEqual(afterRead(loaded, read, { retry: false }), { sheet: read.sheet, failures: read.failures, loadedFromFile: false, kept: false });
});

test('a read that finds no rules and fails somewhere keeps the sheet on the page unchanged', () => {
  const edited = sheetWith([{ ...quoted('quotations-1'), statement: 'My own wording.', enabled: false }]);
  const before = { group: 'references', doc: 0, part: 0, code: 'invalid_model_response' };
  const current = { sheet: edited, failures: [before], loadedFromFile: false };
  const failed = { group: 'style', doc: 0, part: 0, code: 'quota_exceeded', message: 'Used up.' };
  const empty = { sheet: { ...sheetWith([]), dropped: 2 }, failures: [failed] };
  assert.deepEqual(afterRead(current, empty, { retry: false }), { sheet: edited, failures: [before], loadedFromFile: false, kept: true });
  // On a second try the failures are those of the parts tried again.
  assert.deepEqual(afterRead(current, empty, { retry: true }), { sheet: edited, failures: [failed], loadedFromFile: false, kept: true });
  // A loaded sheet stays marked as loaded when it is kept.
  assert.deepEqual(afterRead({ ...current, loadedFromFile: true }, empty, { retry: false }).loadedFromFile, true);
  // With no sheet on the page, the empty sheet and its failures are shown, so "Try again" is offered.
  assert.deepEqual(afterRead({ sheet: null, failures: [], loadedFromFile: false }, empty, { retry: false }), { sheet: empty.sheet, failures: [failed], loadedFromFile: false, kept: false });
  // No rules and no failure is a real answer: the guidelines hold no rules.
  const none = { sheet: sheetWith([]), failures: [] };
  assert.equal(afterRead(current, none, { retry: false }).sheet, none.sheet);
});

test('a second try merges what it found into the sheet', () => {
  const current = { sheet: sheetWith([author('other-a1')]), failures: [{ group: 'style', doc: 0, part: 0, code: 'quota_exceeded' }], loadedFromFile: false };
  const result = afterRead(current, { sheet: sheetWith([quoted('quotations-1')]), failures: [] }, { retry: true });
  assert.deepEqual(result.sheet.rules.map(rule => rule.id), ['other-a1', 'quotations-1']);
  assert.deepEqual(result.failures, []);
  assert.equal(result.kept, false);
});

test('each failure code has its sentence, then the Worker\'s message, then a general one', () => {
  const room = 'The model ran out of room on this part. Choose another model and try again.';
  const quota = 'Your model allowance is used up, so this part was not read.';
  const slow = 'The model service did not answer in time. Try again in a minute.';
  const unusable = 'The model\'s answer could not be used. Try again, or choose another model.';
  const general = 'This part could not be read. Try again.';
  const cases = [
    [{ code: 'model_output_limit', message: 'Worker words.' }, room],
    [{ code: 'quota_exceeded', message: 'Worker words.' }, quota],
    [{ code: 'monthly_quota_reached' }, quota],
    [{ code: 'request_timeout' }, slow],
    [{ code: 'upstream_timeout', message: 'Worker words.' }, slow],
    [{ code: 'network_error' }, slow],
    [{ code: 'invalid_model_response', message: 'Worker words.' }, unusable],
    [{ code: 'service_unavailable', message: 'The service is temporarily unavailable.' }, 'The service is temporarily unavailable.'],
    [{ code: 'service_unavailable', message: '   ' }, general],
    [{ code: 'upstream_busy' }, general],
    [{}, general],
  ];
  for (const [failure, sentence] of cases) assert.equal(failureSentence(failure), sentence, JSON.stringify(failure));
});

test('the failure notice names each failed part in plain words', () => {
  const guidelines = [{ name: 'press.docx', text: TEXT }, { name: 'series.pdf', text: LONG }];
  assert.equal(splitGuidelines(LONG).length, 2);
  const lines = failureLines([
    { group: 'references', doc: 0, part: 0, code: 'model_output_limit' },
    { group: 'style', doc: 1, part: 1, code: 'quota_exceeded' },
    { group: 'structure', doc: 1, part: 0, code: 'odd_code', message: 'The Worker said this.' },
  ], guidelines);
  assert.deepEqual(lines, [
    'Citations, references and notes in press.docx: The model ran out of room on this part. Choose another model and try again.',
    'Spelling, punctuation and style in series.pdf, part 2 of 2: Your model allowance is used up, so this part was not read.',
    'Structure, layout and other requirements in series.pdf, part 1 of 2: The Worker said this.',
  ]);
  for (const line of lines) assert.doesNotMatch(line, JARGON);
});

test('the left-out notice does not blame the quotation', () => {
  assert.equal(droppedNotice(1), '1 rule was left out because the tool could not confirm it against the guidelines.');
  assert.equal(droppedNotice(2), '2 rules were left out because the tool could not confirm them against the guidelines.');
  assert.equal(droppedNotice(1200), '1,200 rules were left out because the tool could not confirm them against the guidelines.');
});

test('restoring keeps the loaded mark and the failures that still fit the guidelines', () => {
  const sheet = sheetWith([quoted('quotations-1')]);
  const guidelines = [{ name: 'a.docx', text: TEXT }];
  const failure = { group: 'style', doc: 0, part: 0, code: 'quota_exceeded', message: 'Used up.' };
  assert.deepEqual(restoredState({ docType: 'monograph', guidelines: [], sheet, failures: [], loadedFromFile: true }),
    { docType: 'monograph', guidelines: [], sheet, failures: [], loadedFromFile: true });
  const restored = restoredState({ docType: 'monograph', guidelines, sheet, loadedFromFile: 'yes', failures: [
    failure,
    { group: 'references', doc: 0, part: 0, code: 'network_error' },
    { group: 'no-such-group', doc: 0, part: 0, code: 'network_error' },
    { group: 'style', doc: 3, part: 0, code: 'network_error' },
    { group: 'style', doc: 0, part: -1, code: 'network_error' },
    { group: 'style', doc: 0, part: 0, code: '' },
    { group: 'style', doc: 0, part: 0, code: 'quota_exceeded', message: 'm'.repeat(400) },
    'junk',
  ] });
  assert.deepEqual(restored.failures, [failure, { group: 'references', doc: 0, part: 0, code: 'network_error' }, { group: 'style', doc: 0, part: 0, code: 'quota_exceeded', message: 'm'.repeat(300) }]);
  assert.equal(restored.loadedFromFile, false, 'only true marks a sheet as loaded');
  assert.equal(restoredState({ docType: 'article', guidelines: [], sheet: null, loadedFromFile: true }).loadedFromFile, false, 'no sheet, no mark');
  assert.deepEqual(restoredState(null), { docType: null, guidelines: [], sheet: null, failures: [], loadedFromFile: false });
});

test('the saved state round-trips through the store, failures included', async () => {
  const store = createStore({ indexedDB: new IDBFactory(), now: () => 1000 });
  const state = {
    docType: 'monograph', guidelines: [{ name: 'a.docx', text: TEXT }], sheet: sheetWith([quoted('quotations-1')]),
    failures: [{ group: 'references', doc: 0, part: 0, code: 'quota_exceeded', message: 'Used up.' }], loadedFromFile: false,
    editingId: 'quotations-1', adding: true, running: null,
  };
  await store.saveJob('format', structuredClone(savedState(state)));
  const back = restoredState(await store.loadJob('format'));
  assert.deepEqual(back, { docType: state.docType, guidelines: state.guidelines, sheet: state.sheet, failures: state.failures, loadedFromFile: false });
  const loaded = { ...state, ...loadedSheetState(state.sheet) };
  await store.saveJob('format', structuredClone(savedState(loaded)));
  assert.equal(restoredState(await store.loadJob('format')).loadedFromFile, true, 'the loaded mark survives a reload');
});

test('removing a guidelines document leaves a loaded sheet alone', () => {
  const guidelines = [{ name: 'new.docx', text: TEXT }];
  const sheet = sheetWith([quoted('quotations-1', 0), author('other-a1')]);
  assert.deepEqual(removeGuideline(guidelines, sheet, 0, { loadedFromFile: true }), { guidelines: [], sheet });
  assert.deepEqual(removeGuideline(guidelines, sheet, 0).sheet.rules.map(rule => rule.id), ['other-a1'], 'a read sheet loses the rules read from it');
});

test('the named manual says where the name came from', () => {
  const sheet = { ...sheetWith([]), manual: { id: null, named: 'The Chicago Manual of Style' } };
  assert.equal(manualNotice(sheet, { loadedFromFile: false }), 'Style manual named in the guidelines: The Chicago Manual of Style');
  assert.equal(manualNotice(sheet, { loadedFromFile: true }), 'Style manual named in the rule sheet file: The Chicago Manual of Style');
  assert.equal(manualNotice(sheetWith([]), { loadedFromFile: true }), null, 'no manual, no line');
  assert.equal(manualNotice(null, { loadedFromFile: false }), null);
});
