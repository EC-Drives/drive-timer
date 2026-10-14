// On-phone storage (IndexedDB). Nothing here ever leaves the phone unless the driver exports it.
//
//   sessions  one record per recording (metadata and summary)
//   chunks    raw rows written every second while recording: key [sessionId, seq]
//   tracks    compact GPS array per session for fast analysis (rebuilt from chunks if missing)
//   defs      circuits and stages the driver created
//   meta      settings and best laps

const DB_NAME = 'drive-timer';
const DB_VERSION = 1;
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('This browser has no on-device database.'));
      return;
    }
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['sid', 'seq'] });
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'sid' });
      if (!db.objectStoreNames.contains('defs')) db.createObjectStore('defs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    rq.onsuccess = () => {
      const db = rq.result;
      // if Safari closes the connection (for example after the app was in the background),
      // forget it so the next call opens a fresh one
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    rq.onerror = () => {
      dbPromise = null;
      reject(rq.error);
    };
    rq.onblocked = () => {
      dbPromise = null;
      reject(new Error('Database is open in another tab. Close other copies of the app.'));
    };
  });
  return dbPromise;
}

const WRITE_TIMEOUT_MS = 10000;

function done(tx) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Storage did not respond')), WRITE_TIMEOUT_MS);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onerror = () => {
      clearTimeout(timer);
      reject(tx.error);
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(tx.error || new Error('Storage transaction aborted'));
    };
  });
}

function result(rq) {
  return new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

/** Start a transaction; if the connection was closed under us, reopen once and try again. */
async function txn(stores, mode) {
  for (let attempt = 0; ; attempt++) {
    const db = await openDb();
    try {
      return db.transaction(stores, mode);
    } catch (e) {
      dbPromise = null;
      if (attempt >= 1) throw e;
    }
  }
}

export async function put(store, value) {
  const tx = await txn(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

export async function putMany(store, values) {
  const tx = await txn(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return done(tx);
}

export async function get(store, key) {
  const tx = await txn(store, 'readonly');
  return result(tx.objectStore(store).get(key));
}

export async function getAll(store, range) {
  const tx = await txn(store, 'readonly');
  return result(tx.objectStore(store).getAll(range));
}

export async function del(store, key) {
  const tx = await txn(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

const chunkRange = (sid) => IDBKeyRange.bound([sid, -Infinity], [sid, Infinity]);

// ---------- sessions ----------

export async function listSessions() {
  const all = await getAll('sessions');
  return all.sort((a, b) => b.startUtcMs - a.startUtcMs);
}

export const getSession = (id) => get('sessions', id);
export const putSession = (s) => put('sessions', { ...s, updated: Date.now() });
export const putChunk = (c) => put('chunks', c);
export const getChunks = (sid) => getAll('chunks', chunkRange(sid));

export async function deleteSession(sid) {
  const tx = await txn(['sessions', 'chunks', 'tracks'], 'readwrite');
  tx.objectStore('sessions').delete(sid);
  tx.objectStore('tracks').delete(sid);
  tx.objectStore('chunks').delete(chunkRange(sid));
  return done(tx);
}

/** GPS rows of a session as fix objects in time order. */
export async function getFixes(sid) {
  let tr = await get('tracks', sid);
  if (!tr) {
    const chunks = await getChunks(sid);
    let n = 0;
    for (const c of chunks) n += c.L ? c.L.length : 0;
    const L = new Float64Array(n);
    let o = 0;
    for (const c of chunks) {
      if (c.L) {
        L.set(c.L, o);
        o += c.L.length;
      }
    }
    tr = { sid, L };
    const sess = await getSession(sid);
    if (sess && sess.status !== 'recording') await put('tracks', tr);
  }
  return decodeL(tr.L);
}

export async function saveTrack(sid, L) {
  return put('tracks', { sid, L });
}

/** Float64Array of L rows (11 values each) into fix objects, sorted, duplicates removed. */
export function decodeL(L) {
  const out = [];
  for (let i = 0; i + 10 < L.length; i += 11) {
    out.push({
      t_us: L[i],
      t: L[i] / 1e6,
      lat: L[i + 1],
      lon: L[i + 2],
      alt: L[i + 3],
      speed: L[i + 4],
      bearing: L[i + 5],
      hAcc: L[i + 6],
      sAcc: L[i + 7],
      bAcc: L[i + 8],
      utc: L[i + 9],
      lag: L[i + 10],
    });
  }
  out.sort((a, b) => a.t_us - b.t_us);
  const clean = [];
  for (const f of out) if (!clean.length || f.t_us > clean[clean.length - 1].t_us) clean.push(f);
  return clean;
}

export function encodeL(fixes) {
  const L = new Float64Array(fixes.length * 11);
  let o = 0;
  for (const f of fixes) {
    L[o++] = f.t_us != null ? f.t_us : Math.round(f.t * 1e6);
    L[o++] = f.lat;
    L[o++] = f.lon;
    L[o++] = f.alt != null ? f.alt : -9999;
    L[o++] = f.speed != null ? f.speed : -1;
    L[o++] = f.bearing != null ? f.bearing : -1;
    L[o++] = f.hAcc != null ? f.hAcc : -1;
    L[o++] = f.sAcc != null ? f.sAcc : -1;
    L[o++] = f.bAcc != null ? f.bAcc : -1;
    L[o++] = f.utc != null ? f.utc : -1;
    L[o++] = f.lag != null ? f.lag : -1;
  }
  return L;
}

// ---------- definitions and settings ----------

export const listDefs = () => getAll('defs');
export const putDef = (d) => put('defs', { ...d, updated: Date.now() });
export const deleteDef = (id) => del('defs', id);

export async function getMeta(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}
export const setMeta = (key, value) => put('meta', { key, value });

/** Ask the browser to keep this app's data even when the phone is short of space. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) {
    /* not supported */
  }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (e) {
    /* not supported */
  }
  return null;
}
