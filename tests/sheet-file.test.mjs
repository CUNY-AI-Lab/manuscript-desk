import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetFromFile, sheetToFile } from '../web/format/app.js';
import { newSheet } from '../lib/rules/schema.js';

function sample() {
  const sheet = newSheet('monograph');
  sheet.manual.named = 'The Chicago Manual of Style';
  sheet.dropped = 2;
  sheet.rules = [
    { id: 'quotations-1', category: 'quotations', slot: 'quotes.primary', statement: 'Use double quotation marks.', mode: 'fix',
      source: { kind: 'guidelines', quote: 'Use double quotation marks throughout the manuscript.', doc: 0 }, params: { style: 'double' }, enabled: false },
    { id: 'other-a1', category: 'other', slot: null, statement: 'Send the manuscript as one file.', mode: 'supply', source: { kind: 'author' }, params: {}, enabled: true },
  ];
  return sheet;
}

const NOT_A_SHEET = 'This is not a rule sheet file.';
const OTHER_VERSION = 'This rule sheet was made by a different version of the tool.';
const DAMAGED = 'This rule sheet file is damaged and cannot be used.';

test('a downloaded sheet loads back deep-equal', () => {
  const sheet = sample();
  const file = sheetToFile(sheet);
  assert.equal(file.name, 'rule-sheet.json');
  assert.equal(typeof file.text, 'string');
  assert.deepEqual(sheetFromFile(file.text), { ok: true, sheet });
});

test('refuses non-JSON, wrong version, invalid sheet, each with its exact message', () => {
  const text = sheetToFile(sample()).text;
  assert.deepEqual(sheetFromFile('not json at all {'), { ok: false, message: NOT_A_SHEET });
  assert.deepEqual(sheetFromFile(''), { ok: false, message: NOT_A_SHEET });
  assert.deepEqual(sheetFromFile('[1, 2]'), { ok: false, message: NOT_A_SHEET });
  assert.deepEqual(sheetFromFile(' '.repeat(2000001)), { ok: false, message: NOT_A_SHEET });
  assert.deepEqual(sheetFromFile(text.replace('"version": 1', '"version": 2')), { ok: false, message: OTHER_VERSION });
  assert.deepEqual(sheetFromFile(text.replace('"mode": "fix"', '"mode": "sometimes"')), { ok: false, message: DAMAGED });
  assert.deepEqual(sheetFromFile(text.replace('"other-a1"', '"quotations-1"')), { ok: false, message: DAMAGED }, 'two rules with one id');
});

test('a statement containing markup comes back as the same literal string', () => {
  const sheet = sample();
  const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script> & &amp;';
  sheet.rules[1].statement = markup;
  const result = sheetFromFile(sheetToFile(sheet).text);
  assert.equal(result.ok, true);
  assert.equal(result.sheet.rules[1].statement, markup);
});
