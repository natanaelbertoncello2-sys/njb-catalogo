// IndexedDB: las fotos de la sesión sobreviven a recargas y cierres de Safari.
const DB_NAME = 'njb-catalogo';
const STORE = 'photos';
const KV = 'kv';
const OUTBOX = 'outbox';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn, storeName = STORE) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  });
}

export const db = {
  all: async () => {
    const rows = await tx('readonly', (s) => s.getAll());
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  put: (photo) => tx('readwrite', (s) => s.put(photo)),
  delete: (id) => tx('readwrite', (s) => s.delete(id)),
};

// Valores sueltos que no entran en localStorage (p. ej. el acceso a la carpeta elegida).
export const kv = {
  get: (k) => tx('readonly', (s) => s.get(k), KV),
  set: (k, v) => tx('readwrite', (s) => s.put(v, k), KV),
  delete: (k) => tx('readwrite', (s) => s.delete(k), KV),
};

// Copias pendientes de subir a «Fotos compartidas» (sobreviven si se cierra la app).
export const outbox = {
  all: () => tx('readonly', (s) => s.getAll(), OUTBOX),
  put: (item) => tx('readwrite', (s) => s.put(item), OUTBOX),
  delete: (id) => tx('readwrite', (s) => s.delete(id), OUTBOX),
};

// Ajustes simples en localStorage.
const SETTINGS_KEY = 'njb-settings';
export function loadSettings(defaults) {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defaults }; }
}
export function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
