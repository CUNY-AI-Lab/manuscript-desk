// The grouping the Formatter page draws its rule list from: every rule appears exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldKind, groupRules, settingLabel, settingsInWords } from '../web/format/rules-view.js';
import { keepRule } from '../web/format/app.js';
import { SLOTS, newSheet, validateRule } from '../lib/rules/schema.js';

const rule = (id, category, fields = {}) => ({ id, category, slot: null, statement: `Rule ${id}.`, mode: 'flag', source: { kind: 'author' }, params: {}, enabled: true, ...fields });
const quotes = (id, style) => rule(id, 'quotations', { slot: 'quotes.primary', params: { style }, mode: 'fix', conflict: true });
const visible = groups => [...groups.conflicts.flatMap(group => group.rules), ...groups.sections.flatMap(section => section.rules)];

test('a rule whose category the document type does not offer is shown under Other requirements', () => {
  const sheet = { ...newSheet('monograph'), rules: [rule('other-1', 'other'), rule('anonymization-1', 'anonymization'), rule('notes-1', 'notes'), rule('title-page-1', 'title-page')] };
  const groups = groupRules(sheet);
  assert.deepEqual(groups.sections.map(section => [section.category.id, section.category.label, section.rules.map(entry => entry.id)]), [
    ['notes', 'Notes', ['notes-1']],
    ['other', 'Other requirements', ['other-1', 'anonymization-1', 'title-page-1']],
  ]);
  assert.equal(visible(groups).length, sheet.rules.length, 'every rule in the sheet can be seen');
});

test('conflicting rules are grouped by setting and drawn once', () => {
  const sheet = { ...newSheet('article'), rules: [quotes('quotations-1', 'double'), rule('other-1', 'other'), quotes('quotations-2', 'single')] };
  const groups = groupRules(sheet);
  assert.deepEqual(groups.conflicts.map(group => [group.slot, group.rules.map(entry => entry.id)]), [['quotes.primary', ['quotations-1', 'quotations-2']]]);
  assert.equal(visible(groups).length, 3);
});

test('a conflict mark on a rule with no setting does not break the list', () => {
  const odd = rule('other-1', 'other', { conflict: true });
  const groups = groupRules({ ...newSheet('article'), rules: [odd] });
  assert.deepEqual(groups.conflicts, []);
  assert.deepEqual(groups.sections.map(section => section.rules.map(entry => entry.id)), [['other-1']]);
  assert.deepEqual(groupRules(null), { conflicts: [], sections: [] });
});

test('keepRule acts only on rules that share the kept rule\'s setting', () => {
  const sheet = { ...newSheet('article'), rules: [rule('other-1', 'other', { conflict: true }), rule('other-2', 'other', { conflict: true }), quotes('quotations-1', 'double')] };
  assert.equal(keepRule(sheet, 'other-1'), sheet, 'a rule with no setting changes nothing');
  assert.deepEqual(keepRule(sheet, 'quotations-1').rules.map(entry => entry.id), ['other-1', 'other-2', 'quotations-1']);
});

// A value of each kind that the setting accepts: every listed value, both answers, a number, a text.
function sampleValues(validator) {
  const kind = fieldKind(validator);
  const values = kind.type === 'list' ? kind.values : kind.type === 'boolean' ? [true, false]
    : kind.type === 'number' ? [kind.min] : kind.type === 'parts' ? [kind.known.slice(0, 2).join(' > ')] : ['Times New Roman'];
  return kind.nullable ? [...values, null] : values;
}

test('every setting of every rule is shown on its row in plain words', () => {
  // No dotted identifier (quotes.primary), no camelCase name (sizePt), no programming words.
  const RAW = [/\b[a-z]+\.[a-z]+\b/, /[a-z][A-Z]/, /\b(slot|schema|json|payload|params?|true|false|null|undefined)\b/i];
  for (const [slot, spec] of Object.entries(SLOTS)) {
    const names = Object.keys(spec.params);
    const width = Math.max(...names.map(name => sampleValues(spec.params[name]).length));
    for (let i = 0; i < width; i += 1) {
      const params = Object.fromEntries(names.map(name => { const values = sampleValues(spec.params[name]); return [name, values[i % values.length]]; }));
      if (slot === 'blockquote.threshold' && params.words === null && params.lines === null) params.words = 1;
      // A setting with several nullable values needs at least one of them.
      if (SLOTS[slot].check?.(params)) { const first = names.find(name => params[name] === null); params[first] = sampleValues(spec.params[first])[0]; }
      const statement = 'A rule.';
      assert.equal(validateRule({ id: 'r-1', category: spec.category, slot, statement, mode: 'flag', source: { kind: 'author' }, params }).ok, true, `${slot} ${JSON.stringify(params)}`);
      const lines = settingsInWords(slot, params);
      assert.equal(lines.length, names.length, slot);
      names.forEach((name, n) => {
        assert.notEqual(settingLabel(slot, name), name, `${slot}.${name} has a label`);
        assert.ok(lines[n].startsWith(`${settingLabel(slot, name)}: `), lines[n]);
        assert.ok(lines[n].length > settingLabel(slot, name).length + 2, lines[n]);
        for (const raw of RAW) assert.doesNotMatch(lines[n], raw, `${slot}.${name}: ${lines[n]}`);
      });
    }
  }
  assert.deepEqual(settingsInWords('quotes.primary', { style: 'single' }), ['Quotation marks: Single (‘ ’)']);
  assert.deepEqual(settingsInWords('comma.serial', { use: false }), ['Use the serial (Oxford) comma: No']);
  assert.deepEqual(settingsInWords('layout.font', { family: null, sizePt: 12 }), ['Font: not given', 'Font size in points: 12']);
  assert.deepEqual(settingsInWords(null, {}), [], 'a rule without settings shows none');
  assert.deepEqual(settingsInWords('matter.order', { order: 'title-page > copyright > list-of-tables', required: null }), ['Parts in this order (separated by >): Title page, Copyright page, List of tables', 'Parts that must be there (separated by >): not given']);
});
