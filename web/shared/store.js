// Work in progress kept in this browser's IndexedDB, one record per key. Never the uploaded files
// themselves: callers save the guidelines' text, the rule sheet and the paragraph labels.
// The records are one piece of saved work: all of them are deleted together once 24 hours have
// passed since the last save of any of them. expire() does that, loadJob() runs it first, and the
// page runs it while it stays open (expiresAt() says when).
const DB_NAME = 'manuscript-desk';
const STORE = 'jobs';
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// The time of the last save among the records, or null when there is none. A record without a
// readable time counts as saved at time 0, so it never keeps the work alive.
const newestSave = records => (records.length ? Math.max(...records.map(record => (Number.isFinite(record?.savedAt) ? record.savedAt : 0))) : null);

export function createStore({ indexedDB, now = Date.now }) {
  let opening = null;
  function open() {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    opening.catch(() => { opening = null; });
    return opening;
  }
  // Runs `work` on the object store in one transaction and resolves when the transaction commits.
  async function transact(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let result;
      Promise.resolve(work(transaction.objectStore(STORE))).then(value => { result = value; }, reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  // Deletes every record when the last save is more than 24 hours old, in the transaction that read
  // them, so a save cannot slip in between. Resolves true when it deleted something.
  const expire = () => transact('readwrite', store => new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const newest = newestSave(request.result);
      const expired = newest !== null && !(now() - newest <= MAX_AGE_MS);
      if (expired) store.clear();
      resolve(expired);
    };
    request.onerror = () => reject(request.error);
  }));
  return {
    saveJob: (key, value) => transact('readwrite', store => { store.put({ savedAt: now(), value }, key); }),
    clearJob: key => transact('readwrite', store => { store.delete(key); }),
    // Deletes everything kept, whatever its age.
    clearAll: () => transact('readwrite', store => { store.clear(); }),
    expire,
    // When the saved work is due to be deleted (its last save plus 24 hours), or null when none is kept.
    async expiresAt() {
      const newest = newestSave(await transact('readonly', store => done(store.getAll())));
      return newest === null ? null : newest + MAX_AGE_MS;
    },
    async loadJob(key) {
      if (await expire()) return null;
      const record = await transact('readonly', store => done(store.get(key)));
      return record ? record.value : null;
    },
  };
}

// Makes the 24-hour deletion happen while the page stays open. check() deletes the saved work when
// it is due and calls onExpired; otherwise it sets a timer for a second after it is due. The page
// calls check() when it starts, after each save, and when it is shown again or regains focus, since
// timers are late or do not run while a computer sleeps. While busy() (a reading, labelling or
// formatting under way) the deletion waits and looks again a minute later.
export function watchExpiry({ store, onExpired, busy = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let stopped = false;
  const arm = delay => {
    clearTimer(timer);
    timer = stopped ? null : setTimer(() => void check(), Math.max(0, delay));
  };
  async function check() {
    if (stopped) return;
    let at;
    try {
      at = await store.expiresAt();
    } catch {
      return;
    }
    if (at === null || stopped) { clearTimer(timer); timer = null; return; }
    if (now() <= at) { arm(at - now() + 1000); return; }
    if (busy()) { arm(60000); return; }
    let expired;
    try {
      expired = await store.expire();
    } catch {
      return;
    }
    // A save that came in meanwhile moved the time on; look again.
    if (expired) { clearTimer(timer); timer = null; onExpired(); } else await check();
  }
  return {
    check,
    stop() { stopped = true; clearTimer(timer); timer = null; },
  };
}
