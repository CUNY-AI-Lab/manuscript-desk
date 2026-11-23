// The grouping the Formatter page draws its rule list from: every rule appears exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRules } from '../web/format/rules-view.js';
import { keepRule } from '../web/format/app.js';
import { newSheet } from '../lib/rules/schema.js';

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
