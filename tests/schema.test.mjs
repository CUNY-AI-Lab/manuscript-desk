import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHEET_VERSION, DOC_TYPES, MODES, CATEGORIES, SLOTS,
  categoriesFor, validateRule, validateSheet, newSheet,
} from '../lib/rules/schema.js';

// A valid slotted rule; tests change one thing at a time.
const slotted = () => ({
  id: 'quotations-1',
  category: 'quotations',
  slot: 'quotes.primary',
  statement: 'Use double quotation marks.',
  mode: 'fix',
  source: { kind: 'guidelines', quote: 'Please use double quotation marks throughout.', doc: 0 },
  params: { style: 'double' },
  enabled: true,
});
// A valid slot-less rule.
const slotless = () => ({
  id: 'files-1',
  category: 'files',
  slot: null,
  statement: 'Submit the manuscript as a Word file.',
  mode: 'flag',
  source: { kind: 'guidelines', quote: 'Manuscripts must be submitted as Word files.', doc: 0 },
  params: {},
  enabled: true,
});
const sheetWith = rules => ({ ...newSheet('article'), rules });

const rejects = (rule, field) => {
  const result = validateRule(rule);
  assert.equal(result.ok, false, `expected rejection for ${field}`);
  assert.match(result.reason, new RegExp(field.replace('.', '\\.')));
};
const ids = list => list.map(category => category.id);

test('exports the version, document types and modes', () => {
  assert.equal(SHEET_VERSION, 1);
  assert.deepEqual(DOC_TYPES, ['article', 'monograph', 'edited-collection']);
  assert.deepEqual(MODES, ['fix', 'flag', 'supply']);
});

test('categoriesFor("article") includes anonymization and excludes front-matter', () => {
  const article = ids(categoriesFor('article'));
  assert.ok(article.includes('anonymization'));
  assert.ok(article.includes('abstract-keywords'));
  assert.ok(article.includes('spelling'));
  assert.ok(!article.includes('front-matter'));
  assert.ok(!article.includes('contributors'));
});

test('categoriesFor("edited-collection") includes contributors and consistency', () => {
  const collection = ids(categoriesFor('edited-collection'));
  for (const id of ['contributors', 'consistency', 'front-matter', 'abstract-keywords', 'other']) {
    assert.ok(collection.includes(id), id);
  }
  assert.ok(!collection.includes('title-page'));
  assert.deepEqual(categoriesFor('poem'), []);
});

test('every category has a label, a known group and known document types', () => {
  for (const category of CATEGORIES) {
    assert.equal(typeof category.label, 'string');
    assert.ok(category.label.length > 0);
    assert.ok(['style', 'references', 'structure'].includes(category.group), category.id);
    assert.ok(category.docTypes.length > 0 && category.docTypes.every(type => DOC_TYPES.includes(type)), category.id);
  }
  assert.equal(CATEGORIES.find(category => category.id === 'figures-tables').label, 'Figures and tables');
  assert.equal(new Set(ids(CATEGORIES)).size, CATEGORIES.length);
});

test('every slot names an existing category', () => {
  const known = new Set(ids(CATEGORIES));
  assert.equal(Object.keys(SLOTS).length, 32);
  for (const [slot, { category, params }] of Object.entries(SLOTS)) {
    assert.ok(known.has(category), `${slot} -> ${category}`);
    for (const validator of Object.values(params)) assert.equal(typeof validator, 'function', slot);
  }
});

test('accepts a slotted fix rule with exact params', () => {
  const result = validateRule(slotted());
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.rule, slotted());
});

test('rejects unknown category, mode, slot', () => {
  rejects({ ...slotted(), category: 'typography' }, 'category');
  rejects({ ...slotted(), mode: 'rewrite' }, 'mode');
  rejects({ ...slotted(), slot: 'quotes.tertiary' }, 'slot');
  assert.deepEqual(validateRule({ ...slotted(), slot: 'toString' }), { ok: false, reason: 'slot' });
});

test('rejects a slotted rule with a missing, extra or wrong-typed param', () => {
  rejects({ ...slotted(), params: {} }, 'params');
  rejects({ ...slotted(), params: { style: 'double', size: 2 } }, 'params');
  rejects({ ...slotted(), params: { style: 'curly' } }, 'params.style');
  rejects({ ...slotted(), params: undefined }, 'params');
  const serial = { ...slotted(), category: 'punctuation', slot: 'comma.serial' };
  rejects({ ...serial, params: { use: 'yes' } }, 'params.use');
  assert.equal(validateRule({ ...serial, params: { use: false } }).ok, true);
  const spellout = { ...slotted(), category: 'numbers', slot: 'numbers.spellout' };
  rejects({ ...spellout, params: { below: 1 } }, 'params.below');
  rejects({ ...spellout, params: { below: 10.5 } }, 'params.below');
  assert.equal(validateRule({ ...spellout, params: { below: 101 } }).ok, true);
  const font = { ...slotted(), category: 'layout', slot: 'layout.font' };
  assert.equal(validateRule({ ...font, params: { family: null, sizePt: 12 } }).ok, true);
  rejects({ ...font, params: { family: '', sizePt: 12 } }, 'params.family');
  rejects({ ...font, params: { family: 'Times', sizePt: 40 } }, 'params.sizePt');
});

test('blockquote.threshold needs words or lines', () => {
  const block = { ...slotted(), slot: 'blockquote.threshold' };
  assert.equal(validateRule({ ...block, params: { words: 100, lines: null } }).ok, true);
  assert.equal(validateRule({ ...block, params: { words: null, lines: 5 } }).ok, true);
  rejects({ ...block, params: { words: null, lines: null } }, 'params');
  rejects({ ...block, params: { words: 0, lines: null } }, 'params.words');
});

test('rejects a slot whose category differs from the rule category', () => {
  rejects({ ...slotted(), category: 'punctuation' }, 'slot');
});

test('rejects mode "fix" on a rule without a slot', () => {
  rejects({ ...slotless(), mode: 'fix' }, 'mode');
  assert.equal(validateRule({ ...slotless(), mode: 'supply' }).ok, true);
  rejects({ ...slotless(), category: 'other', mode: 'fix' }, 'mode');
  assert.equal(validateRule({ ...slotless(), category: 'other' }).ok, true);
});

test('rejects a slot-less rule with params', () => {
  rejects({ ...slotless(), params: { style: 'double' } }, 'params');
});

test('defaults enabled to true and params to {} on a slot-less rule', () => {
  const { enabled, params, ...bare } = slotless();
  const result = validateRule(bare);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.rule.enabled, true);
  assert.deepEqual(result.rule.params, {});
  assert.equal(validateRule({ ...slotless(), enabled: false }).rule.enabled, false);
  rejects({ ...slotless(), enabled: 'yes' }, 'enabled');
});

test('accepts conflict only as exactly true', () => {
  assert.equal(validateRule({ ...slotted(), conflict: true }).rule.conflict, true);
  assert.equal('conflict' in validateRule(slotted()).rule, false);
  rejects({ ...slotted(), conflict: false }, 'conflict');
  rejects({ ...slotted(), conflict: 'true' }, 'conflict');
  // Only rules with a setting can disagree with each other.
  rejects({ ...slotless(), conflict: true }, 'conflict: needs a slot');
});

test('rejects bad ids and statements', () => {
  rejects({ ...slotted(), id: 'Quotations 1' }, 'id');
  rejects({ ...slotted(), id: 'a'.repeat(65) }, 'id');
  rejects({ ...slotted(), statement: '' }, 'statement');
  rejects({ ...slotted(), statement: 'x'.repeat(501) }, 'statement');
  assert.equal(validateRule({ ...slotted(), statement: 'x'.repeat(500) }).ok, true);
});

test('rejects a guidelines source whose quote is shorter than 12 characters', () => {
  rejects({ ...slotted(), source: { kind: 'guidelines', quote: 'Use double', doc: 0 } }, 'source.quote');
  rejects({ ...slotted(), source: { kind: 'guidelines', quote: 'q'.repeat(401), doc: 0 } }, 'source.quote');
  rejects({ ...slotted(), source: { kind: 'guidelines', quote: 'Please use double quotes.', doc: -1 } }, 'source.doc');
  rejects({ ...slotted(), source: { kind: 'guidelines', quote: 'Please use double quotes.' } }, 'source.doc');
});

test('accepts manual and author sources without a quote and rejects unknown kinds', () => {
  const manual = validateRule({ ...slotted(), source: { kind: 'manual', manual: 'Chicago 18', section: '6.9', quote: 'Not kept here.' } });
  assert.equal(manual.ok, true, manual.reason);
  assert.deepEqual(manual.rule.source, { kind: 'manual', manual: 'Chicago 18', section: '6.9' });
  const author = validateRule({ ...slotted(), source: { kind: 'author', quote: 'Not kept here.' } });
  assert.deepEqual(author.rule.source, { kind: 'author' });
  rejects({ ...slotted(), source: { kind: 'manual', manual: '', section: '6.9' } }, 'source.manual');
  rejects({ ...slotted(), source: { kind: 'manual', manual: 'Chicago 18', section: 's'.repeat(81) } }, 'source.section');
  rejects({ ...slotted(), source: { kind: 'editor' } }, 'source');
  rejects({ ...slotted(), source: null }, 'source');
});

test('validateRule never throws and never mutates its input', () => {
  for (const value of [undefined, null, 0, 'rule', [], () => {}, Object.create(null)]) {
    assert.equal(validateRule(value).ok, false);
  }
  const hostile = { ...slotted() };
  Object.defineProperty(hostile, 'statement', { enumerable: true, get() { throw new Error('boom'); } });
  assert.equal(validateRule(hostile).ok, false);
  const input = { ...slotted(), extra: 1, source: { ...slotted().source, extra: 2 } };
  const before = structuredClone(input);
  const result = validateRule(input);
  assert.deepEqual(input, before);
  assert.notEqual(result.rule.params, input.params);
  assert.notEqual(result.rule.source, input.source);
});

test('validateSheet rejects version 2 with reason "version"', () => {
  assert.deepEqual(validateSheet({ ...newSheet('article'), version: 2 }), { ok: false, reason: 'version' });
  assert.deepEqual(validateSheet({ ...newSheet('article'), version: undefined }), { ok: false, reason: 'version' });
});

test('validateSheet rejects non-objects, arrays, and more than 400 rules', () => {
  for (const value of [undefined, null, 1, 'sheet', [], [newSheet('article')]]) {
    assert.equal(validateSheet(value).ok, false);
  }
  const rules = n => Array.from({ length: n }, (_, i) => ({ ...slotless(), id: `files-${i + 1}` }));
  assert.equal(validateSheet(sheetWith(rules(400))).ok, true);
  assert.equal(validateSheet(sheetWith(rules(401))).ok, false);
  assert.equal(validateSheet(sheetWith({})).ok, false);
});

test('validateSheet rejects a sheet with an invalid rule and names it', () => {
  const result = validateSheet(sheetWith([slotless(), { ...slotted(), mode: 'rewrite' }]));
  assert.equal(result.ok, false);
  assert.match(result.reason, /rules\[1\].*mode/);
});

test('validateSheet checks docType, manual, dropped and created', () => {
  const base = newSheet('monograph');
  const bad = (change, field) => {
    const result = validateSheet({ ...base, ...change });
    assert.equal(result.ok, false, field);
    assert.match(result.reason, new RegExp(field.replace('.', '\\.')));
  };
  bad({ docType: 'thesis' }, 'docType');
  bad({ manual: null }, 'manual');
  bad({ manual: { id: '', named: null } }, 'manual.id');
  bad({ manual: { id: null, named: 'n'.repeat(121) } }, 'manual.named');
  bad({ manual: { id: null } }, 'manual.named');
  bad({ dropped: -1 }, 'dropped');
  bad({ dropped: 1.5 }, 'dropped');
  bad({ created: 'yesterday' }, 'created');
  bad({ created: '2026-02-31T00:00:00.000Z' }, 'created');
  bad({ created: 1795323600123 }, 'created');
  const named = { ...base, manual: { id: 'chicago-18', named: 'The Chicago Manual of Style, 18th edition' }, dropped: 3, created: '2026-11-22T10:00:00+05:00' };
  assert.equal(validateSheet(named).ok, true, validateSheet(named).reason);
});

test('validateSheet keeps markup in a statement as literal text', () => {
  const markup = '<img src=x onerror=1>';
  const result = validateSheet(sheetWith([{ ...slotless(), statement: markup }]));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sheet.rules[0].statement, markup);
});

test('validateSheet strips unknown top-level and rule keys', () => {
  const input = {
    ...sheetWith([{ ...slotted(), note: 'x', source: { ...slotted().source, page: 4 }, conflict: true }]),
    manual: { id: null, named: null, edition: 18 },
    owner: 'someone',
  };
  const result = validateSheet(input);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(Object.keys(result.sheet).sort(), ['created', 'docType', 'dropped', 'manual', 'rules', 'version']);
  assert.deepEqual(Object.keys(result.sheet.manual).sort(), ['id', 'named']);
  assert.deepEqual(result.sheet.rules[0], { ...slotted(), conflict: true });
  assert.equal(input.owner, 'someone');
  assert.equal(input.rules[0].note, 'x');
});

test('newSheet("monograph") is valid and empty', () => {
  const sheet = newSheet('monograph');
  assert.equal(sheet.version, SHEET_VERSION);
  assert.equal(sheet.docType, 'monograph');
  assert.deepEqual(sheet.manual, { id: null, named: null });
  assert.deepEqual(sheet.rules, []);
  assert.equal(sheet.dropped, 0);
  assert.ok(Math.abs(Date.parse(sheet.created) - Date.now()) < 5000);
  const result = validateSheet(sheet);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.sheet, sheet);
  assert.throws(() => newSheet('thesis'), TypeError);
});
