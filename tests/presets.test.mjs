import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, presetSheet, presetsFor } from '../lib/presets/index.js';
import { validateSheet } from '../lib/rules/schema.js';
import { builtInState, guidelineChoice, presetNotice } from '../web/format/app.js';
import { htmlToText } from '../scripts/generality.mjs';

test('every built-in set is a valid rule sheet for its document type, with distinct rule ids', () => {
  assert.ok(PRESETS.length >= 1);
  for (const preset of PRESETS) {
    const result = validateSheet(preset.sheet);
    assert.equal(result.ok, true, `${preset.id}: ${result.reason}`);
    assert.equal(result.sheet.docType, preset.docType);
    assert.equal(new Set(result.sheet.rules.map(rule => rule.id)).size, result.sheet.rules.length);
    assert.deepEqual(result.sheet.preset, { id: preset.id, name: preset.name, sources: [...preset.sources], retrieved: preset.retrieved });
  }
});

test('every rule of a built-in set quotes a source page, with its address and the day it was read', () => {
  for (const preset of PRESETS) {
    for (const rule of presetSheet(preset.id).rules) {
      const { source } = rule;
      assert.equal(source.kind, 'guidelines', rule.id);
      assert.ok(source.quote.length >= 12 && source.quote.length <= 400, rule.id);
      assert.equal(source.url, preset.sources[source.doc], `${rule.id}: its page is the set's source number ${source.doc}`);
      assert.match(source.url, /^https:\/\//u);
      assert.equal(source.retrieved, preset.retrieved, rule.id);
      assert.equal(source.set, preset.id, rule.id);
    }
  }
});

test('the rules of a built-in set that share a setting agree on it, so none is left out as a conflict', () => {
  for (const preset of PRESETS) {
    const bySlot = new Map();
    for (const rule of presetSheet(preset.id).rules) {
      assert.notEqual(rule.conflict, true, rule.id);
      if (rule.slot === null) continue;
      const params = JSON.stringify(rule.params);
      assert.equal(bySlot.get(rule.slot) ?? params, params, rule.slot);
      bySlot.set(rule.slot, params);
    }
  }
});

test('using a built-in set calls nothing: no model and no network, and gives the same sheet every time', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('no network call may be made'); };
  try {
    const first = builtInState('cuny-gc');
    const second = builtInState('cuny-gc');
    assert.ok(first.sheet.rules.length > 0);
    assert.deepEqual(first, second);
    assert.deepEqual(first.guidelines, [], 'no guidelines are read');
    assert.equal(first.loadedFromFile, false);
    assert.equal(first.source, 'built-in');
    assert.match(presetNotice(first.sheet), /No model read anything/u);
    assert.equal(builtInState('no-such-set'), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('step 2 offers the built-in set first for a dissertation, and no built-in set for the other types', () => {
  assert.equal(guidelineChoice('dissertation', null).builtIn, true);
  assert.equal(guidelineChoice('dissertation', 'upload').builtIn, false);
  assert.equal(guidelineChoice('dissertation', 'upload').preset.id, 'cuny-gc');
  for (const type of ['article', 'monograph', 'edited-collection']) {
    assert.deepEqual(presetsFor(type), []);
    assert.equal(guidelineChoice(type, null).builtIn, false);
  }
});

test('htmlToText decodes fractions and primes, which requirements pages use for inches', () => {
  assert.equal(htmlToText('<p>at least &frac34;&rdquo; from the edge; right: 1&Prime; and 5&prime;</p>'), 'at least ¾” from the edge; right: 1″ and 5′');
});
