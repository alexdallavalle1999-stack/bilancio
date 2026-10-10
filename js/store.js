// Archivio locale: IndexedDB come memoria permanente, copia in RAM per calcoli veloci.

const DB_NAME = 'bilancio';
const DB_VERSION = 1;
const STORES = ['categories', 'accounts', 'transactions', 'recurring', 'rules'];

export const DEFAULT_SETTINGS = {
  defaultAccountId: null,
  backupEveryDays: 7,
  lastBackupAt: null,
  changesSinceBackup: 0,
  lastImported: {},
  rememberPassword: true,
};

export const S = {
  categories: [],
  accounts: [],
  transactions: [],
  recurring: [],
  rules: [],
  settings: { ...DEFAULT_SETTINGS },
  cat: new Map(),
  acc: new Map(),
};

let db = null;
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => listeners.forEach((fn) => { try { fn(what); } catch (e) { console.error(e); } });

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('Database bloccato: chiudi le altre schede dell\'app.'));
  });
}

function tx(stores, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Scrittura annullata'));
  });
}

const getAll = (store) => new Promise((res, rej) => {
  const r = db.transaction(store).objectStore(store).getAll();
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

function reindex() {
  S.cat = new Map(S.categories.map((c) => [c.id, c]));
  S.acc = new Map(S.accounts.map((a) => [a.id, a]));
  S.transactions.sort((a, b) => (a.date === b.date ? (a.created || '').localeCompare(b.created || '') : a.date.localeCompare(b.date)));
  S.categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  S.accounts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function load() {
  db = await openDB();
  for (const s of STORES) S[s] = await getAll(s);
  const kv = await getAll('kv');
  S.settings = { ...DEFAULT_SETTINGS };
  for (const { k, v } of kv) S.settings[k] = v;
  reindex();
}

const META_KEYS = new Set(['lastBackupAt', 'changesSinceBackup', 'backupPassword']);

async function bumpChanges(n = 1) {
  S.settings.changesSinceBackup = (S.settings.changesSinceBackup || 0) + n;
  await tx(['kv'], 'readwrite', (t) => t.objectStore('kv').put({ k: 'changesSinceBackup', v: S.settings.changesSinceBackup }));
}

function memPut(store, obj) {
  const arr = S[store];
  const i = arr.findIndex((x) => x.id === obj.id);
  if (i >= 0) arr[i] = obj; else arr.push(obj);
}

export async function put(store, obj) {
  obj.updated = new Date().toISOString();
  if (!obj.created) obj.created = obj.updated;
  await tx([store], 'readwrite', (t) => t.objectStore(store).put(obj));
  memPut(store, obj);
  reindex();
  await bumpChanges();
  emit(store);
  return obj;
}

export async function putMany(store, arr) {
  if (!arr.length) return;
  const now = new Date().toISOString();
  await tx([store], 'readwrite', (t) => {
    const os = t.objectStore(store);
    for (const o of arr) { o.updated = now; if (!o.created) o.created = now; os.put(o); }
  });
  for (const o of arr) memPut(store, o);
  reindex();
  await bumpChanges(arr.length);
  emit(store);
}

export async function del(store, id) {
  return delMany(store, [id]);
}

export async function delMany(store, ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  await tx([store], 'readwrite', (t) => { const os = t.objectStore(store); for (const id of ids) os.delete(id); });
  S[store] = S[store].filter((x) => !set.has(x.id));
  reindex();
  await bumpChanges(ids.length);
  emit(store);
}

export async function setSetting(k, v) {
  S.settings[k] = v;
  await tx(['kv'], 'readwrite', (t) => t.objectStore('kv').put({ k, v }));
  if (!META_KEYS.has(k)) await bumpChanges();
  emit('settings');
}

export async function getSecret(k) {
  return new Promise((res) => {
    const r = db.transaction('kv').objectStore('kv').get(k);
    r.onsuccess = () => res(r.result?.v ?? null);
    r.onerror = () => res(null);
  });
}

// Sostituisce tutti i dati (ripristino da backup)
export async function replaceAll(data) {
  const keepPw = await getSecret('backupPassword');
  await tx([...STORES, 'kv'], 'readwrite', (t) => {
    for (const s of STORES) {
      const os = t.objectStore(s);
      os.clear();
      for (const o of data[s] || []) os.put(o);
    }
    const kv = t.objectStore('kv');
    kv.clear();
    const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    delete settings.backupPassword;
    for (const [k, v] of Object.entries(settings)) kv.put({ k, v });
    if (keepPw) kv.put({ k: 'backupPassword', v: keepPw });
  });
  await load();
  emit('all');
}

export function exportData() {
  const settings = { ...S.settings };
  delete settings.backupPassword;
  return {
    categories: S.categories,
    accounts: S.accounts,
    transactions: S.transactions,
    recurring: S.recurring,
    rules: S.rules,
    settings,
  };
}

export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

export async function isPersisted() {
  try { return navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { return null; }
}
