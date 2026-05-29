/**
 * IndexedDB-backed translation cache that lives in the MV3 background service
 * worker. Survives tab navigations + extension reloads so a re-visit to a page
 * the user already translated can paint instantly from cache instead of round-
 * tripping through the LLM again.
 *
 * Two-layer design:
 *   - In-memory Map (`memoryCache`) for sub-ms reads of hot entries.
 *   - IndexedDB store (`STORE_NAME`) for persistence + cross-tab sharing.
 *
 * Channel surface (consumed by content scripts):
 *   "persistent_cache_prefetch"  { urlHash, langs }    →  Array<{ key, value }>
 *   "persistent_cache_save"      { urlHash, key, value }
 *   "persistent_cache_clear"     {}
 *
 * Entries are TTL'd to 7 days so we don't grow without bound on power users.
 */

const DB_NAME = "edge-translate-cache";
const DB_VERSION = 1;
const STORE_NAME = "translations";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_MEMORY_ENTRIES = 4000;
const PRUNE_BATCH_SIZE = 200;

const memoryCache = new Map();
let dbPromise = null;
let lastPruneAt = 0;

function isIndexedDbAvailable() {
    return typeof indexedDB !== "undefined";
}

function openDb() {
    if (dbPromise) return dbPromise;
    if (!isIndexedDbAvailable()) return Promise.resolve(null);
    dbPromise = new Promise((resolve) => {
        let request;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch {
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
                store.createIndex("urlHash", "urlHash", { unique: false });
                store.createIndex("expiresAt", "expiresAt", { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
    return dbPromise;
}

function withStore(mode, fn) {
    return openDb().then((db) => {
        if (!db) return null;
        return new Promise((resolve) => {
            let tx;
            try {
                tx = db.transaction(STORE_NAME, mode);
            } catch {
                resolve(null);
                return;
            }
            const store = tx.objectStore(STORE_NAME);
            let result = null;
            try {
                result = fn(store);
            } catch {
                /* noop */
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        });
    });
}

function rememberInMemory(key, entry) {
    if (memoryCache.has(key)) memoryCache.delete(key);
    memoryCache.set(key, entry);
    if (memoryCache.size > MAX_MEMORY_ENTRIES) {
        const oldest = memoryCache.keys().next();
        if (!oldest.done) memoryCache.delete(oldest.value);
    }
}

function isExpired(entry, now = Date.now()) {
    return Boolean(entry && entry.expiresAt && entry.expiresAt <= now);
}

/**
 * Fetch every cached entry for a given urlHash (so a content script can prefill
 * its in-memory LRU on translation start with one round-trip). Filters expired
 * entries inline.
 */
function prefetchEntriesForUrlHash(urlHash) {
    if (!urlHash) return Promise.resolve([]);
    return withStore("readonly", (store) => {
        return new Promise((resolve) => {
            const out = [];
            const index = store.index("urlHash");
            const request = index.openCursor(IDBKeyRange.only(String(urlHash)));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(out);
                    return;
                }
                const entry = cursor.value;
                if (!isExpired(entry)) {
                    out.push({ key: entry.key, value: entry.value });
                    rememberInMemory(entry.key, entry);
                }
                cursor.continue();
            };
            request.onerror = () => resolve(out);
        });
    }).then((result) => result || []);
}

function saveEntry({ urlHash, key, value }) {
    if (!key || !value) return Promise.resolve(false);
    const entry = {
        key,
        urlHash: urlHash || "",
        value,
        createdAt: Date.now(),
        expiresAt: Date.now() + DEFAULT_TTL_MS,
    };
    rememberInMemory(key, entry);
    schedulePrune();
    return withStore("readwrite", (store) => {
        store.put(entry);
        return true;
    }).then((result) => Boolean(result));
}

function getEntry(key) {
    if (!key) return Promise.resolve(null);
    const memoryHit = memoryCache.get(key);
    if (memoryHit && !isExpired(memoryHit)) {
        // Refresh recency.
        memoryCache.delete(key);
        memoryCache.set(key, memoryHit);
        return Promise.resolve(memoryHit.value);
    }
    return withStore("readonly", (store) => {
        return new Promise((resolve) => {
            const request = store.get(key);
            request.onsuccess = () => {
                const entry = request.result;
                if (!entry || isExpired(entry)) {
                    resolve(null);
                    return;
                }
                rememberInMemory(key, entry);
                resolve(entry.value);
            };
            request.onerror = () => resolve(null);
        });
    });
}

function clearAll() {
    memoryCache.clear();
    return withStore("readwrite", (store) => {
        store.clear();
        return true;
    }).then((result) => Boolean(result));
}

function schedulePrune() {
    const now = Date.now();
    // Run at most once every 30 minutes; cheap enough to not need a timer.
    if (now - lastPruneAt < 30 * 60 * 1000) return;
    lastPruneAt = now;
    withStore("readwrite", (store) => {
        const index = store.index("expiresAt");
        const range = IDBKeyRange.upperBound(now);
        const request = index.openCursor(range);
        let removed = 0;
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || removed >= PRUNE_BATCH_SIZE) return;
            cursor.delete();
            removed += 1;
            cursor.continue();
        };
    }).catch(() => null);
}

export { DEFAULT_TTL_MS, clearAll, getEntry, prefetchEntriesForUrlHash, saveEntry };
