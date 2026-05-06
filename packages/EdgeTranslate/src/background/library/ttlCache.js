class TtlCache {
    constructor({ maxEntries, now = Date.now }) {
        this.maxEntries = Math.max(1, maxEntries || 1);
        this.now = now;
        this.store = new Map();
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return null;

        if (entry.expireAt && entry.expireAt <= this.now()) {
            this.store.delete(key);
            return null;
        }

        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    set(key, value, ttlMs) {
        const expireAt = ttlMs ? this.now() + ttlMs : 0;
        if (this.store.has(key)) this.store.delete(key);
        this.store.set(key, { value, expireAt });

        if (this.store.size > this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (oldestKey !== undefined) this.store.delete(oldestKey);
        }
    }

    clear() {
        this.store.clear();
    }

    size() {
        return this.store.size;
    }
}

export default TtlCache;
