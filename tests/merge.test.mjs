import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeExtracted, layerSheet } from '../lib/rules/merge.js';
import { newSheet, validateRule } from '../lib/rules/schema.js';

// Guideline text written for these tests.
const G0 = 'Use American spelling throughout, following Merriam-Webster. Please use double quotation marks for all quotations. '
  + 'Notes should be footnotes rather than endnotes. Submit the manuscript as a Word file, with figures supplied as separate files.';
const G1 = 'In the main text, single quotation marks are used for quotations. Abstracts must not exceed 250 words. '
  + 'Every figure needs a caption and a credit line.';

// Candidates in the shape a model reply delivers them.
const spelling = () => ({
  category: 'spelling', slot: 'spelling.variety', statement: 'Use US spelling.',
  quote: 'Use American spelling throughout', mode: 'fix', params: { variety: 'us' },
});
const doubleQuotes = () => ({
  category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.',
  quote: 'Please use double quotation marks', mode: 'fix', params: { style: 'double' },
});
const singleQuotes = () => ({
  category: 'quotations', slot: 'quotes.primary', statement: 'Use single quotation marks.',
  quote: 'single quotation marks are used for quotations', mode: 'fix', params: { style: 'single' },
});
const footnotes = () => ({
  category: 'notes', slot: 'notes.kind', statement: 'Use footnotes.',
  quote: 'Notes should be footnotes rather than endnotes', mode: 'fix', params: { kind: 'footnotes' },
});
const wordFile = () => ({
  category: 'files', statement: 'Submit a Word file.',
  quote: 'Submit the manuscript as a Word file', mode: 'flag',
});
const captions = () => ({
  category: 'other', statement: 'Give every figure a caption and a credit line.',
  quote: 'Every figure needs a caption and a credit line', mode: 'supply',
});

const ids = rules => rules.map(rule => rule.id);

test('drops and counts a rule whose quote is not in the guidelines', () => {
  const invented = { ...spelling(), quote: 'Authors must use British spelling everywhere' };
  const { rules, dropped } = mergeExtracted([invented, doubleQuotes()], [G0]);
  assert.equal(dropped, 1);
  assert.deepEqual(ids(rules), ['quotations-1']);
});

test('drops and counts a rule that fails validation for a reason other than its slot, params or mode', () => {
  const badCategory = { ...footnotes(), category: 'gossip' };
  const noStatement = { ...wordFile(), statement: '' };
  const longStatement = { ...wordFile(), mode: 'fix', statement: 'x'.repeat(501) };
  const { rules, dropped } = mergeExtracted([badCategory, noStatement, longStatement, doubleQuotes()], [G0]);
  assert.equal(dropped, 3);
  assert.deepEqual(ids(rules), ['quotations-1']);
});

// The one rule a single candidate becomes, with nothing dropped.
function keptAlone(candidate, guidelines = [G0]) {
  const { rules, dropped } = mergeExtracted([candidate], guidelines);
  assert.equal(dropped, 0, 'kept, not left out');
  assert.equal(rules.length, 1);
  assert.equal(validateRule(rules[0]).ok, true);
  return rules[0];
}
const commentOnly = rule => [rule.category, rule.slot, rule.mode, rule.params, rule.statement, rule.source.quote];

test('keeps a verified fix rule with no slot as a comment', () => {
  const nullSlot = { ...wordFile(), mode: 'fix', slot: null };
  assert.deepEqual(commentOnly(keptAlone(nullSlot)), ['files', null, 'flag', {}, 'Submit a Word file.', 'Submit the manuscript as a Word file']);
  const noSlotKey = { ...wordFile(), mode: 'fix' };
  assert.deepEqual(commentOnly(keptAlone(noSlotKey)), ['files', null, 'flag', {}, 'Submit a Word file.', 'Submit the manuscript as a Word file']);
});

test('keeps a verified rule whose slot params are wrong or missing as a comment', () => {
  const wrong = { ...spelling(), params: { variety: 'martian' } };
  assert.deepEqual(commentOnly(keptAlone(wrong)), ['spelling', null, 'flag', {}, 'Use US spelling.', 'Use American spelling throughout']);
  const missing = { ...spelling(), params: {} };
  assert.deepEqual(commentOnly(keptAlone(missing)), ['spelling', null, 'flag', {}, 'Use US spelling.', 'Use American spelling throughout']);
  const absent = { ...spelling() };
  delete absent.params;
  assert.deepEqual(commentOnly(keptAlone(absent)), ['spelling', null, 'flag', {}, 'Use US spelling.', 'Use American spelling throughout']);
  const extra = { ...spelling(), params: { variety: 'us', strict: true } };
  assert.deepEqual(commentOnly(keptAlone(extra)), ['spelling', null, 'flag', {}, 'Use US spelling.', 'Use American spelling throughout']);
});

test('keeps a verified rule whose slot is unknown or belongs to another category as a comment', () => {
  const unknown = { ...spelling(), slot: 'spelling.colour' };
  assert.deepEqual(commentOnly(keptAlone(unknown)), ['spelling', null, 'flag', {}, 'Use US spelling.', 'Use American spelling throughout']);
  const elsewhere = { ...spelling(), category: 'punctuation' };
  assert.deepEqual(commentOnly(keptAlone(elsewhere)), ['punctuation', null, 'flag', {}, 'Use US spelling.', 'Use American spelling throughout']);
  const notText = { ...spelling(), slot: 42 };
  assert.deepEqual(commentOnly(keptAlone(notText)), ['spelling', null, 'flag', {}, 'Use US spelling.', 'Use American spelling throughout']);
  const fixInOther = { ...captions(), mode: 'fix', slot: 'spelling.variety', params: { variety: 'us' } };
  assert.deepEqual(commentOnly(keptAlone(fixInOther, [G1])), ['other', null, 'flag', {}, 'Give every figure a caption and a credit line.', 'Every figure needs a caption and a credit line']);
});

test('keeps flag and supply when retrying as a comment, and turns an unknown mode into flag', () => {
  const supply = { ...captions(), slot: 'spelling.variety', params: { variety: 'us' } };
  assert.equal(keptAlone(supply, [G1]).mode, 'supply');
  const flagWithParams = { ...wordFile(), params: { colour: 'red' } };
  assert.deepEqual(commentOnly(keptAlone(flagWithParams)), ['files', null, 'flag', {}, 'Submit a Word file.', 'Submit the manuscript as a Word file']);
  for (const mode of ['auto', undefined, null, 7]) {
    const odd = { ...wordFile(), mode };
    assert.equal(keptAlone(odd).mode, 'flag', String(mode));
  }
});

test('still drops a comment-only retry whose quotation is invented or whose category is unknown', () => {
  const invented = { ...wordFile(), mode: 'fix', quote: 'Authors must submit a LaTeX source file' };
  const badSlotInvented = { ...spelling(), params: { variety: 'martian' }, quote: 'Authors must use British spelling everywhere' };
  const unknownCategory = { ...wordFile(), mode: 'fix', category: 'gossip' };
  const unknownCategorySlot = { ...spelling(), category: 'gossip' };
  const shortQuote = { ...wordFile(), mode: 'fix', quote: 'Word file' };
  const { rules, dropped } = mergeExtracted([invented, badSlotInvented, unknownCategory, unknownCategorySlot, shortQuote], [G0]);
  assert.equal(dropped, 5);
  assert.deepEqual(rules, []);
});

test('leaves a valid slotted fix rule untouched', () => {
  const rule = keptAlone(spelling());
  assert.deepEqual([rule.category, rule.slot, rule.mode, rule.params], ['spelling', 'spelling.variety', 'fix', { variety: 'us' }]);
});

test('drops and counts a candidate that is not a plain object or whose quote is not text', () => {
  const noQuote = { ...spelling() };
  delete noQuote.quote;
  const candidates = [null, 'Use double quotation marks', 42, [doubleQuotes()], { ...footnotes(), quote: 7 }, noQuote, wordFile()];
  const { rules, dropped } = mergeExtracted(candidates, [G0]);
  assert.equal(dropped, 6);
  assert.deepEqual(ids(rules), ['files-1']);
});

test('assigns doc to the document that contains the quote', () => {
  const { rules, dropped } = mergeExtracted([
    { ...singleQuotes() },                       // no doc: found in the second document
    { ...doubleQuotes(), doc: 7 },               // out of range: found in the first
    { ...footnotes(), doc: 1 },                  // wrong doc: falls back to the first
    { ...captions(), doc: 1 },                   // right doc: kept
  ], [G0, G1]);
  assert.equal(dropped, 0);
  const docOf = Object.fromEntries(rules.map(rule => [rule.statement, rule.source.doc]));
  assert.deepEqual(docOf, {
    'Use single quotation marks.': 1,
    'Use double quotation marks.': 0,
    'Use footnotes.': 0,
    'Give every figure a caption and a credit line.': 1,
  });
});

test('dedupes the same slot with equal params', () => {
  const again = { ...doubleQuotes(), statement: 'Double quotation marks throughout.', quote: 'double quotation marks for all quotations' };
  const { rules, dropped } = mergeExtracted([doubleQuotes(), again], [G0]);
  assert.equal(dropped, 0, 'a duplicate is not counted as dropped');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].statement, 'Use double quotation marks.');
  assert.equal(rules[0].conflict, undefined);
});

test('keeps both and marks conflict for the same slot with different params', () => {
  const { rules, dropped } = mergeExtracted([doubleQuotes(), singleQuotes(), { ...doubleQuotes(), statement: 'Double marks.' }], [G0, G1]);
  assert.equal(dropped, 0);
  assert.deepEqual(rules.map(rule => [rule.id, rule.params.style, rule.conflict]), [
    ['quotations-1', 'double', true],
    ['quotations-2', 'single', true],
  ]);
});

test('dedupes slot-less rules with the same category, mode and quote, keeping the longer statement', () => {
  const shorter = { ...wordFile(), statement: 'Word file.' };
  const unrelated = { ...wordFile(), statement: 'Footnotes, not endnotes.', quote: 'Notes should be footnotes rather than endnotes' };
  // Equal after normalization and trimming quote marks at the edges.
  const longer = { ...wordFile(), statement: 'Submit the manuscript as a single Word file.', quote: '“Submit the  MANUSCRIPT as a Word file”' };
  const { rules, dropped } = mergeExtracted([shorter, footnotes(), unrelated, longer], [G0]);
  assert.equal(dropped, 0);
  assert.deepEqual(rules.map(rule => [rule.id, rule.statement]), [
    ['notes-1', 'Use footnotes.'],
    ['files-1', 'Submit the manuscript as a single Word file.'],
    ['files-2', 'Footnotes, not endnotes.'],
  ]);
  assert.equal(rules[1].source.quote, '“Submit the  MANUSCRIPT as a Word file”', 'the survivor keeps its own quote');
  assert.equal(rules[1].source.doc, 0);
});

test('keeps both slot-less rules when the same quote is in two categories', () => {
  const asFiles = { ...wordFile(), quote: 'figures supplied as separate files', statement: 'Supply figures as separate files.' };
  const asFigures = { ...asFiles, category: 'figures-tables', statement: 'Figures go in their own files.' };
  const { rules } = mergeExtracted([asFiles, asFigures], [G0]);
  assert.deepEqual(ids(rules), ['figures-tables-1', 'files-1']);
});

test('keeps both slot-less rules when the same quote has different modes', () => {
  const { rules } = mergeExtracted([wordFile(), { ...wordFile(), mode: 'supply', statement: 'Provide a Word file of the manuscript.' }], [G0]);
  assert.deepEqual(rules.map(rule => [rule.id, rule.mode]), [['files-1', 'flag'], ['files-2', 'supply']]);
});

test('keeps both slot-less rules when one quote contains the other', () => {
  const whole = { ...wordFile(), statement: 'Word file; figures apart.', quote: 'Submit the manuscript as a Word file, with figures supplied as separate files' };
  const { rules } = mergeExtracted([wordFile(), whole], [G0]);
  assert.deepEqual(rules.map(rule => [rule.id, rule.statement]), [['files-1', 'Submit a Word file.'], ['files-2', 'Word file; figures apart.']]);
});

test('keeps slot-less rules whose quotes do not overlap', () => {
  const figures = { ...wordFile(), statement: 'Supply figures as separate files.', quote: 'figures supplied as separate files' };
  const { rules } = mergeExtracted([wordFile(), figures], [G0]);
  assert.deepEqual(ids(rules), ['files-1', 'files-2']);
});

test('orders output by category order then appearance and numbers ids', () => {
  const figures = { ...wordFile(), statement: 'Supply figures as separate files.', quote: 'figures supplied as separate files' };
  const { rules } = mergeExtracted([captions(), footnotes(), wordFile(), spelling(), figures, doubleQuotes()], [G0, G1]);
  assert.deepEqual(rules.map(rule => [rule.id, rule.statement]), [
    ['spelling-1', 'Use US spelling.'],
    ['quotations-1', 'Use double quotation marks.'],
    ['notes-1', 'Use footnotes.'],
    ['files-1', 'Submit a Word file.'],
    ['files-2', 'Supply figures as separate files.'],
    ['other-1', 'Give every figure a caption and a credit line.'],
  ]);
});

test('puts category other after the categories listed after it', () => {
  const abstract = {
    category: 'abstract-keywords', slot: 'abstract.words', statement: 'Abstract of at most 250 words.',
    quote: 'Abstracts must not exceed 250 words', mode: 'flag', params: { max: 250 },
  };
  const { rules } = mergeExtracted([captions(), abstract], [G1]);
  assert.deepEqual(ids(rules), ['abstract-keywords-1', 'other-1']);
});

test('never returns a rule with source.kind other than guidelines', () => {
  const claimsManual = { ...spelling(), source: { kind: 'manual', manual: 'Chicago 18', section: '7.1' } };
  const claimsAuthor = { ...footnotes(), source: { kind: 'author' } };
  const nested = { ...doubleQuotes(), source: { kind: 'manual', quote: 'Please use double quotation marks', doc: 0 } };
  delete nested.quote;
  const { rules, dropped } = mergeExtracted([claimsManual, claimsAuthor, nested], [G0]);
  assert.equal(dropped, 0);
  assert.equal(rules.length, 3);
  for (const rule of rules) {
    assert.deepEqual(Object.keys(rule.source), ['kind', 'quote', 'doc']);
    assert.equal(rule.source.kind, 'guidelines');
  }
  assert.equal(rules.find(rule => rule.category === 'quotations').source.quote, 'Please use double quotation marks');
});

test('returns valid rules with enabled set and no fields the model invented', () => {
  const extra = { ...footnotes(), enabled: false, conflict: true, id: 'mine', colour: 'red' };
  const { rules } = mergeExtracted([extra, wordFile()], [G0]);
  for (const rule of rules) {
    assert.equal(validateRule(rule).ok, true, rule.id);
    assert.equal(rule.enabled, true);
    assert.equal(rule.conflict, undefined);
    assert.equal(Object.hasOwn(rule, 'colour'), false);
  }
  assert.deepEqual(ids(rules), ['notes-1', 'files-1']);
  assert.equal(rules[1].slot, null);
  assert.deepEqual(rules[1].params, {});
});

test('does not mutate its arguments and never throws', () => {
  const candidates = [doubleQuotes(), singleQuotes(), wordFile(), { ...wordFile(), statement: 'Submit a Word file, please.' }];
  const guidelines = [G0, G1];
  const before = structuredClone({ candidates, guidelines });
  const { rules } = mergeExtracted(candidates, guidelines);
  assert.deepEqual({ candidates, guidelines }, before);
  rules[0].params.style = 'single';
  assert.equal(candidates[0].params.style, 'double');
  for (const [badCandidates, badGuidelines] of [[undefined, [G0]], [null, null], [{}, 'text'], [[doubleQuotes()], undefined], [[doubleQuotes()], [42]]]) {
    const result = mergeExtracted(badCandidates, badGuidelines);
    assert.ok(Array.isArray(result.rules));
    assert.equal(Number.isInteger(result.dropped), true);
  }
  assert.deepEqual(mergeExtracted([doubleQuotes()], []), { rules: [], dropped: 1 });
});

test('drops and counts a candidate whose quote getter throws', () => {
  const trap = { ...spelling() };
  Object.defineProperty(trap, 'quote', { enumerable: true, get() { throw new Error('boom'); } });
  const { rules, dropped } = mergeExtracted([trap, doubleQuotes()], [G0]);
  assert.equal(dropped, 1);
  assert.deepEqual(ids(rules), ['quotations-1']);
});

test('drops and counts a candidate whose statement getter throws', () => {
  const trap = { ...footnotes() };
  Object.defineProperty(trap, 'statement', { enumerable: true, get() { throw new Error('boom'); } });
  const { rules, dropped } = mergeExtracted([doubleQuotes(), trap], [G0]);
  assert.equal(dropped, 1);
  assert.deepEqual(ids(rules), ['quotations-1']);
});

test('drops and counts a Proxy candidate whose traps throw', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
  const { rules, dropped } = mergeExtracted([hostile, wordFile()], [G0]);
  assert.equal(dropped, 1);
  assert.deepEqual(ids(rules), ['files-1']);
});

test('returns no rules and drops nothing for a candidates argument that is not a readable array', () => {
  const unreadable = new Proxy([], { get(target, key) { if (key === 'length') throw new Error('boom'); return target[key]; } });
  for (const bad of [undefined, null, 'rules', 42, {}, { length: 1, 0: doubleQuotes() }, unreadable]) {
    assert.deepEqual(mergeExtracted(bad, [G0]), { rules: [], dropped: 0 });
  }
  assert.deepEqual(mergeExtracted([doubleQuotes()], unreadable), { rules: [], dropped: 1 });
});

// A small fixture baseline, standing in for a manual's baseline sheet.
const manual = section => ({ kind: 'manual', manual: 'Chicago 18', section });
const baseline = () => [
  { id: 'baseline-quotes', category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.', mode: 'fix', source: manual('6.9'), params: { style: 'double' }, enabled: true },
  { id: 'baseline-serial', category: 'punctuation', slot: 'comma.serial', statement: 'Use the serial comma.', mode: 'fix', source: manual('6.19'), params: { use: true }, enabled: true },
  { id: 'baseline-notes', category: 'notes', slot: 'notes.kind', statement: 'Use footnotes.', mode: 'fix', source: manual('13.26'), params: { kind: 'footnotes' }, enabled: true },
  { id: 'baseline-ibid', category: 'notes', slot: null, statement: 'Prefer shortened citations to ibid.', mode: 'flag', source: manual('13.37'), params: {}, enabled: true },
];
const sheetWith = rules => ({ ...newSheet('article'), rules });

test('layerSheet appends baseline rules for unoccupied slots only', () => {
  const { rules } = mergeExtracted([singleQuotes(), wordFile()], [G0, G1]);
  const layered = layerSheet(sheetWith(rules), baseline());
  assert.deepEqual(ids(layered), ['quotations-1', 'files-1', 'baseline-serial', 'baseline-notes', 'baseline-ibid']);
  assert.equal(layered[0].params.style, 'single', 'the guidelines rule wins its slot');
  assert.deepEqual(layered.slice(2).map(rule => rule.source.kind), ['manual', 'manual', 'manual']);
});

test('layerSheet lets a disabled sheet rule still occupy its slot', () => {
  const { rules } = mergeExtracted([footnotes()], [G0]);
  const disabled = rules.map(rule => ({ ...rule, enabled: false }));
  const layered = layerSheet(sheetWith(disabled), baseline());
  assert.deepEqual(ids(layered), ['notes-1', 'baseline-quotes', 'baseline-serial', 'baseline-ibid']);
  assert.equal(layered[0].enabled, false);
});

test('layerSheet returns new rule objects and changes neither input', () => {
  const { rules } = mergeExtracted([footnotes()], [G0]);
  const sheet = sheetWith(rules);
  const base = baseline();
  const before = structuredClone({ sheet, base });
  const layered = layerSheet(sheet, base);
  assert.deepEqual({ sheet, base }, before);
  assert.notEqual(layered[0], sheet.rules[0]);
  assert.notEqual(layered[1], base[0]);
  layered[1].source.section = 'changed';
  layered[1].params.style = 'single';
  assert.deepEqual(base, before.base);
});
