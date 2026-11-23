import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_MODEL, chooseModel, modelMenu } from '../web/shared/models.js';

const catalog = JSON.parse(await readFile(new URL('./fixtures/catalog-2026-11-09.json', import.meta.url), 'utf8'));
const row = fields => ({ id: 'model', name: 'Model', recommended: true, status: 'active', capabilities: ['text-generation'], context_length: 128000, order: 1, ...fields });

test('offers only recommended active text rows with enough context, in catalog order', () => {
  const menu = modelMenu(catalog);
  assert.deepEqual(menu.map(entry => entry.id), [
    'deepseek-v4.1-flash-1017', 'glm-5.3', 'qwen3.8-27b', 'gpt-oss-120b', 'gemma-4-26b-a4b-it', 'mistral-large-3-675b-instruct',
  ]);
  assert.deepEqual(menu[1], { id: 'glm-5.3', label: 'Glm 5.3' });
  const synthetic = { data: [
    row({ id: 'late', order: 9 }),
    row({ id: 'not-recommended', recommended: false }),
    row({ id: 'retired', status: 'retired' }),
    row({ id: 'speech', capabilities: ['automatic-speech-recognition'] }),
    row({ id: 'small-context', context_length: 31999 }),
    row({ id: 'early', order: 2, name: undefined }),
    'not a row',
  ] };
  assert.deepEqual(modelMenu(synthetic), [{ id: 'early', label: 'early' }, { id: 'late', label: 'Model' }]);
  assert.deepEqual(modelMenu(null), []);
  assert.deepEqual(modelMenu({ data: 'nope' }), []);
});

test('excludes rows whose id or name matches guard|safeguard', () => {
  const menu = modelMenu({ data: [
    row({ id: 'llama-guard-9', name: 'Llama 9' }),
    row({ id: 'plain-1', name: 'Plain Safeguard 1' }),
    row({ id: 'plain-2', name: 'Plain 2' }),
  ] });
  assert.deepEqual(menu.map(entry => entry.id), ['plain-2']);
});

test('chooseModel prefers deepseek-v4.1-flash-1017 when nothing is chosen', () => {
  const menu = modelMenu(catalog);
  assert.equal(DEFAULT_MODEL, 'deepseek-v4.1-flash-1017');
  assert.equal(chooseModel('', menu), 'deepseek-v4.1-flash-1017');
  assert.equal(chooseModel(undefined, menu), 'deepseek-v4.1-flash-1017');
  // The default is chosen by name, not by its place in the menu.
  const reordered = [...menu.slice(1), menu[0]];
  assert.equal(chooseModel('', reordered), 'deepseek-v4.1-flash-1017');
});

test('chooseModel keeps a chosen model that is still offered', () => {
  const menu = modelMenu(catalog);
  assert.equal(chooseModel('qwen3.8-27b', menu), 'qwen3.8-27b');
  assert.equal(chooseModel('glm-5.3', menu), 'glm-5.3');
  assert.equal(chooseModel('kimi-k3', menu), 'deepseek-v4.1-flash-1017', 'a model no longer offered is not kept');
});

test('chooseModel falls back to the first row when the default is not offered', () => {
  const menu = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  assert.equal(chooseModel('', menu), 'a');
  assert.equal(chooseModel('', []), '');
});
