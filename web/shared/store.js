// Work in progress kept in this browser's IndexedDB, one record per key, for 24 hours. Never the
// uploaded files themselves: callers save the text read from them and the rule sheet.
const DB_NAME = 'manuscript-desk';
const STORE = 'jobs';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

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
  return {
    saveJob: (key, value) => transact('readwrite', store => { store.put({ savedAt: now(), value }, key); }),
    clearJob: key => transact('readwrite', store => { store.delete(key); }),
    async loadJob(key) {
      const record = await transact('readonly', store => done(store.get(key)));
      if (!record) return null;
      if (!(now() - record.savedAt <= MAX_AGE_MS)) {
        await transact('readwrite', store => { store.delete(key); });
        return null;
      }
      return record.value;
    },
  };
}
