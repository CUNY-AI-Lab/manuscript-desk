// The Formatter page's pure sheet edits and the wording it shows for rule settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addAuthorRule, keepRule, mergeRetry, normaliseLineEndings, removeGuideline, restoredState, updateRule } from '../web/format/app.js';
import { fieldKind, plainReason, settingLabel, valueLabel } from '../web/format/rules-view.js';
import { MAX_RULES, SLOTS, newSheet, validateSheet } from '../lib/rules/schema.js';

const quoted = (id, fields = {}) => ({
  id, category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.', mode: 'fix',
  source: { kind: 'guidelines', quote: 'Use double quotation marks throughout the manuscript.', doc: 0 }, params: { style: 'double' }, enabled: true, ...fields,
});
const slotless = (id, fields = {}) => ({
  id, category: 'other', slot: null, statement: 'Send the manuscript as one file.', mode: 'supply',
  source: { kind: 'guidelines', quote: 'Send the whole manuscript as a single file.', doc: 0 }, params: {}, enabled: true, ...fields,
});
const sheetWith = rules => ({ ...newSheet('monograph'), rules });
const JARGON = /\b(slot|schema|json|payload|params?)\b/i;

test('a rule the author adds has an author source, a fresh id, and is validated', () => {
  let sheet = sheetWith([quoted('quotations-1')]);
  let result = addAuthorRule(sheet, { category: 'other', statement: 'Include a list of illustrations.', mode: 'supply' });
  assert.equal(result.ok, true);
  sheet = result.sheet;
  assert.deepEqual(sheet.rules.at(-1), { id: 'other-a1', category: 'other', slot: null, statement: 'Include a list of illustrations.', mode: 'supply', source: { kind: 'author' }, params: {}, enabled: true });
  sheet = addAuthorRule(sheet, { category: 'other', statement: 'Number the pages.', mode: 'flag' }).sheet;
  assert.equal(sheet.rules.at(-1).id, 'other-a2');
  assert.equal(validateSheet(sheet).ok, true);

  result = addAuthorRule(sheet, { category: 'other', statement: '', mode: 'flag' });
  assert.deepEqual(result, { ok: false, message: 'Write the rule in 1 to 500 characters.' });
  result = addAuthorRule(sheet, { category: 'other', statement: 'Fix it.', mode: 'fix' });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, JARGON);
});

test('adding a rule to a full sheet is refused in plain words', () => {
  const full = sheetWith(Array.from({ length: MAX_RULES }, (_, i) => slotless(`other-${i + 1}`, { source: { kind: 'author' } })));
  assert.deepEqual(addAuthorRule(full, { category: 'other', statement: 'One more.', mode: 'flag' }),
    { ok: false, message: `A rule sheet can hold at most ${MAX_RULES} rules. Remove a rule before adding another.` });
});

test('an edit that fails validation is not applied and the reason is in plain words', () => {
  const sheet = sheetWith([{ ...quoted('numbers-1'), category: 'numbers', slot: 'numbers.spellout', params: { below: 10 }, statement: 'Spell out numbers below ten.' }]);
  const good = updateRule(sheet, 'numbers-1', { statement: 'Spell out numbers below one hundred.', params: { below: 100 } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.sheet.rules[0].params, { below: 100 });
  assert.equal(sheet.rules[0].params.below, 10, 'the original sheet is unchanged');

  const bad = updateRule(sheet, 'numbers-1', { params: { below: 1.5 } });
  assert.deepEqual(bad, { ok: false, message: 'Spell out numbers below: enter a whole number from 2 to 1001.' });
  const font = sheetWith([{ ...quoted('layout-1'), category: 'layout', slot: 'layout.font', params: { family: null, sizePt: 12 } }]);
  assert.equal(updateRule(font, 'layout-1', { params: { sizePt: 99 } }).message, 'Font size in points: enter a number from 6 to 30, or leave it empty.');
  assert.equal(updateRule(sheet, 'numbers-1', { statement: '' }).message, 'Write the rule in 1 to 500 characters.');
  assert.equal(updateRule(sheet, 'gone', { enabled: false }).ok, false);
  const block = sheetWith([{ ...quoted('quotations-1'), slot: 'blockquote.threshold', params: { words: 100, lines: null } }]);
  assert.equal(updateRule(block, 'quotations-1', { params: { words: null } }).message, 'Fill in at least one of the two numbers.');
});

test('keeping one of two conflicting rules removes the other', () => {
  const sheet = sheetWith([quoted('quotations-1', { conflict: true }), quoted('quotations-2', { conflict: true, params: { style: 'single' } }), slotless('other-1')]);
  const kept = keepRule(sheet, 'quotations-2');
  assert.deepEqual(kept.rules.map(rule => rule.id), ['quotations-2', 'other-1']);
  assert.equal(kept.rules[0].conflict, undefined);
  assert.equal(validateSheet(kept).ok, true);
});

test('rules from a second reading are added without duplicates, with fresh ids and conflicts marked', () => {
  const sheet = { ...sheetWith([quoted('quotations-1', { enabled: false }), slotless('other-1')]), dropped: 1 };
  const extra = { ...sheetWith([
    quoted('quotations-1'),                                    // the same setting: skipped
    quoted('quotations-2', { params: { style: 'single' } }),   // a different value: a conflict
    slotless('other-1', { source: { kind: 'guidelines', quote: '  Send the whole manuscript as a single file.', doc: 0 } }), // same quotation: skipped
    slotless('other-2', { statement: 'Use a single file.', source: { kind: 'guidelines', quote: 'Prepare the manuscript as one single file.', doc: 0 } }),
  ]), dropped: 2, manual: { id: null, named: 'Chicago' } };
  const merged = mergeRetry(sheet, extra);
  assert.deepEqual(merged.rules.map(rule => [rule.id, rule.conflict === true]), [['quotations-1', true], ['other-1', false], ['quotations-2', true], ['other-2', false]]);
  assert.equal(merged.rules[0].enabled, false, 'the author\'s change is kept');
  assert.equal(merged.dropped, 3);
  assert.equal(merged.manual.named, 'Chicago');
  assert.equal(validateSheet(merged).ok, true);
  assert.equal(sheet.rules[0].conflict, undefined, 'the original sheet is unchanged');
});

test('removing a guidelines document removes its rules and renumbers the later ones', () => {
  const guidelines = [{ name: 'a', text: 'A' }, { name: 'b', text: 'B' }, { name: 'c', text: 'C' }];
  const sheet = sheetWith([slotless('other-1', { source: { kind: 'guidelines', quote: 'Send the whole manuscript as a single file.', doc: 1 } }),
    slotless('other-2', { source: { kind: 'guidelines', quote: 'Send the whole manuscript as a single file.', doc: 2 } }), slotless('other-a1', { source: { kind: 'author' } })]);
  const result = removeGuideline(guidelines, sheet, 1);
  assert.deepEqual(result.guidelines.map(entry => entry.name), ['a', 'c']);
  assert.deepEqual(result.sheet.rules.map(rule => [rule.id, rule.source.doc]), [['other-2', 1], ['other-a1', undefined]]);
  assert.deepEqual(removeGuideline(guidelines, null, 0), { guidelines: guidelines.slice(1), sheet: null });
});

test('line endings are normalised', () => {
  assert.equal(normaliseLineEndings('one\r\ntwo\rthree\nfour'), 'one\ntwo\nthree\nfour');
});

test('saved work is restored only where it is well formed', () => {
  const text = 'Use double quotation marks throughout the manuscript. '.repeat(5);
  const sheet = sheetWith([quoted('quotations-1')]);
  assert.deepEqual(restoredState({ docType: 'article', guidelines: [{ name: 'a.docx', text }, { name: 'short', text: 'x' }, 'junk'], sheet }),
    { docType: 'monograph', guidelines: [{ name: 'a.docx', text }], sheet, failures: [], loadedFromFile: false });
  assert.deepEqual(restoredState({ docType: 'article', guidelines: 'no', sheet: { version: 1 } }), { docType: 'article', guidelines: [], sheet: null, failures: [], loadedFromFile: false });
  assert.deepEqual(restoredState(null), { docType: null, guidelines: [], sheet: null, failures: [], loadedFromFile: false });
});

test('every setting of every rule has a control and plain words', () => {
  for (const [slot, spec] of Object.entries(SLOTS)) {
    for (const [name, validator] of Object.entries(spec.params)) {
      const kind = fieldKind(validator);
      assert.ok(['boolean', 'list', 'number', 'text', 'parts'].includes(kind.type), `${slot}.${name}`);
      assert.notEqual(settingLabel(slot, name), name, `${slot}.${name} has a label`);
      if (kind.type === 'list') for (const value of kind.values) assert.notEqual(valueLabel(slot, name, value), value, `${slot}.${name}=${value} has a label`);
      if (kind.type === 'number' || kind.type === 'text' || kind.type === 'parts') {
        const message = plainReason(`params.${name}: expected ${validator.allowed}`, slot);
        assert.ok(message.startsWith(`${settingLabel(slot, name)}: enter `), message);
        assert.doesNotMatch(message, JARGON);
      }
    }
  }
  assert.deepEqual(fieldKind(SLOTS['layout.font'].params.family), { type: 'text', nullable: true, min: 1, max: 80 });
  assert.deepEqual(fieldKind(SLOTS['numbers.spellout'].params.below), { type: 'number', nullable: false, whole: true, min: 2, max: 1001 });
  assert.deepEqual(fieldKind(SLOTS['quotes.primary'].params.style), { type: 'list', nullable: false, values: ['double', 'single'] });
  assert.deepEqual(fieldKind(SLOTS['comma.serial'].params.use), { type: 'boolean', nullable: false });
});
