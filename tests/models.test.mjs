import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL, UNAVAILABLE } from '../lib/calls/model.js';
import { checkModel } from '../web/shared/models.js';

test('the tool uses one model, deepseek-v4.1-flash-1017', () => {
  assert.equal(MODEL, 'deepseek-v4.1-flash-1017');
  assert.match(UNAVAILABLE, /unavailable for now/u);
  assert.doesNotMatch(UNAVAILABLE, /another model|choose/iu, 'no substitute is offered');
});

test('checkModel says true, false, or null when it cannot tell', async () => {
  const api = answer => ({ get: async path => { assert.equal(path, '/api/model'); if (answer instanceof Error) throw answer; return answer; } });
  assert.equal(await checkModel(api({ available: true })), true);
  assert.equal(await checkModel(api({ available: false })), false);
  assert.equal(await checkModel(api({ available: null })), null);
  assert.equal(await checkModel(api({})), null);
  assert.equal(await checkModel(api(new Error('network'))), null);
});

test('neither page offers a choice of model', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const page of ['web/format/index.html', 'web/index/index.html', 'web/format/app.js', 'web/index/app.js', 'web/format/manuscript-step.js', 'web/format/output-step.js']) {
    const text = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /model-select|another model|api\/catalog/u, page);
  }
});
