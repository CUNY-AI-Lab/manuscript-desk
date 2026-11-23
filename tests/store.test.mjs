import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createStore } from '../web/shared/store.js';

const DAY = 24 * 60 * 60 * 1000;

test('saves and loads a job', async () => {
  const store = createStore({ indexedDB: new IDBFactory(), now: () => 1000 });
  const value = { docType: 'monograph', guidelines: [{ name: 'a.docx', text: 'Use double quotation marks.' }], sheet: null };
  await store.saveJob('format', value);
  assert.deepEqual(await store.loadJob('format'), value);
  assert.equal(await store.loadJob('other'), null);
  // A later save replaces the earlier one.
  await store.saveJob('format', { ...value, docType: 'article' });
  assert.equal((await store.loadJob('format')).docType, 'article');
});

test('returns null and deletes a job older than 24 hours', async () => {
  const indexedDB = new IDBFactory();
  let time = 0;
  const store = createStore({ indexedDB, now: () => time });
  await store.saveJob('format', { docType: 'article' });
  time = DAY;
  assert.deepEqual(await store.loadJob('format'), { docType: 'article' }, 'exactly 24 hours is not older');
  time = DAY + 1;
  assert.equal(await store.loadJob('format'), null);
  // The record is gone, not just hidden: even a clock set back does not bring it back.
  time = 0;
  assert.equal(await createStore({ indexedDB, now: () => time }).loadJob('format'), null);
});

test('clearJob removes it', async () => {
  const store = createStore({ indexedDB: new IDBFactory(), now: () => 5 });
  await store.saveJob('format', { docType: 'article' });
  await store.saveJob('index', { kept: true });
  await store.clearJob('format');
  assert.equal(await store.loadJob('format'), null);
  assert.deepEqual(await store.loadJob('index'), { kept: true });
  await store.clearJob('missing');
});
