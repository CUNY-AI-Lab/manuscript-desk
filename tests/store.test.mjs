import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, watchExpiry } from '../web/shared/store.js';

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

test('the saved records are one piece of work: kept while any was saved in the last 24 hours, then deleted together', async () => {
  const indexedDB = new IDBFactory();
  let time = 0;
  const store = createStore({ indexedDB, now: () => time });
  await store.saveJob('format', { docType: 'article' });
  time = DAY / 2;
  await store.saveJob('manuscript', { hash: 'h' });
  time = DAY + 1;
  assert.deepEqual(await store.loadJob('format'), { docType: 'article' }, 'the rule sheet stays while the labels are recent');
  assert.deepEqual(await store.loadJob('manuscript'), { hash: 'h' });
  time = DAY / 2 + DAY + 1;
  assert.equal(await store.loadJob('manuscript'), null);
  assert.equal(await store.loadJob('format'), null, 'deleted with the rest, not left behind');
});

test('expiresAt is the last save plus 24 hours, and null when nothing is kept', async () => {
  let time = 1000;
  const store = createStore({ indexedDB: new IDBFactory(), now: () => time });
  assert.equal(await store.expiresAt(), null);
  await store.saveJob('format', { docType: 'article' });
  time = 5000;
  await store.saveJob('manuscript', { hash: 'h' });
  assert.equal(await store.expiresAt(), 5000 + DAY);
  await store.clearJob('manuscript');
  assert.equal(await store.expiresAt(), 1000 + DAY);
});

test('expire deletes the work only once 24 hours have passed since the last save, while the page stays open', async () => {
  const indexedDB = new IDBFactory();
  let time = 0;
  const store = createStore({ indexedDB, now: () => time });
  assert.equal(await store.expire(), false, 'nothing kept, nothing deleted');
  await store.saveJob('format', { docType: 'article' });
  await store.saveJob('manuscript', { hash: 'h' });
  time = DAY;
  assert.equal(await store.expire(), false);
  assert.notEqual(await store.expiresAt(), null);
  time = DAY + 1;
  assert.equal(await store.expire(), true);
  assert.equal(await store.expiresAt(), null, 'every record is gone');
  assert.equal(await store.expire(), false);
  // Gone for any store on the same database, even with the clock set back.
  time = 0;
  const again = createStore({ indexedDB, now: () => time });
  assert.equal(await again.loadJob('format'), null);
  assert.equal(await again.loadJob('manuscript'), null);
});

test('a record without a readable time does not keep the work alive', async () => {
  const indexedDB = new IDBFactory();
  const store = createStore({ indexedDB, now: () => DAY * 3 });
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('manuscript-desk', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('jobs');
    request.onsuccess = () => {
      const transaction = request.result.transaction('jobs', 'readwrite');
      transaction.objectStore('jobs').put({ savedAt: 'yesterday', value: { docType: 'article' } }, 'format');
      transaction.oncomplete = () => { request.result.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
  assert.equal(await store.loadJob('format'), null);
});

test('clearAll deletes everything kept, whatever its age', async () => {
  const store = createStore({ indexedDB: new IDBFactory(), now: () => 5 });
  await store.saveJob('format', { docType: 'article' });
  await store.saveJob('manuscript', { hash: 'h' });
  await store.clearAll();
  assert.equal(await store.loadJob('format'), null);
  assert.equal(await store.loadJob('manuscript'), null);
  assert.equal(await store.expiresAt(), null);
});

// A fake clock with timers, for the page's watch on the saved work.
function fakeClock(start = 0) {
  let time = start;
  let next = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, delay) => { const id = next++; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer: id => { timers.delete(id); },
    pending: () => [...timers.values()].map(timer => timer.at),
    // Moves the clock on and runs the timers due, waiting for what they start.
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > time || !timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    set: value => { time = value; },
  };
}

test('while the page stays open, the saved work is deleted a second after its 24 hours, and the page is told', async () => {
  const clock = fakeClock();
  const store = createStore({ indexedDB: new IDBFactory(), now: clock.now });
  let expired = 0;
  const watch = watchExpiry({ store, onExpired: () => { expired += 1; }, ...clock });
  await watch.check();
  assert.deepEqual(clock.pending(), [], 'nothing saved, no timer');
  await store.saveJob('format', { docType: 'article' });
  await watch.check();
  assert.deepEqual(clock.pending(), [DAY + 1000]);
  await clock.advance(DAY);
  assert.equal(expired, 0);
  assert.deepEqual(await store.loadJob('format'), { docType: 'article' });
  await clock.advance(1000);
  assert.equal(expired, 1);
  assert.equal(await store.expiresAt(), null, 'deleted from the browser');
  assert.deepEqual(clock.pending(), []);
});

test('a save moves the deletion on; a late timer or a check on return deletes what is due', async () => {
  const clock = fakeClock();
  const store = createStore({ indexedDB: new IDBFactory(), now: clock.now });
  let expired = 0;
  const watch = watchExpiry({ store, onExpired: () => { expired += 1; }, ...clock });
  await store.saveJob('format', { docType: 'article' });
  await watch.check();
  clock.set(DAY / 2);
  await store.saveJob('manuscript', { hash: 'h' });
  await watch.check();
  assert.deepEqual(clock.pending(), [DAY / 2 + DAY + 1000], 'one timer, for the later time');
  // The computer slept through the timer: the check made when the page is shown again deletes it.
  clock.set(DAY * 3);
  await watch.check();
  assert.equal(expired, 1);
  assert.equal(await store.expiresAt(), null);
});

test('the deletion waits while work is under way, and stop() ends the watch', async () => {
  const clock = fakeClock();
  const store = createStore({ indexedDB: new IDBFactory(), now: clock.now });
  let busy = true;
  let expired = 0;
  const watch = watchExpiry({ store, onExpired: () => { expired += 1; }, busy: () => busy, ...clock });
  await store.saveJob('format', { docType: 'article' });
  clock.set(DAY + 5);
  await watch.check();
  assert.equal(expired, 0);
  assert.deepEqual(clock.pending(), [DAY + 5 + 60000]);
  busy = false;
  await clock.advance(60000);
  assert.equal(expired, 1);

  await store.saveJob('format', { docType: 'article' });
  await watch.check();
  watch.stop();
  assert.deepEqual(clock.pending(), []);
  clock.set(DAY * 9);
  await watch.check();
  assert.equal(expired, 1, 'a stopped watch deletes nothing');
});
