import { normalizeSourceKey } from "./normalize.js";

const CACHE_VALUE_VERSION = 3;
// TTL is enforced on read (spec §9): stale persistent entries are simply skipped, letting the
// background store lazily garbage-collect instead of requiring an eager sweep.
const PERSISTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FNV_OFFSET_BASIS_A = 0x811c9dc5;
// Second offset basis: a single FNV-32 demonstrably collided in production, so the persistent
// key carries a composite {len}:{hashA}:{hashB} fingerprint plus full-key verification on read.
const FNV_OFFSET_BASIS_B = 0x9747b28c;
const KEEP_SOURCE_SENTINEL = "=";

function fnv1a32(value, seed = FNV_OFFSET_BASIS_A) {
    let hash = seed >>> 0;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

// "pt3-1" -> "pt3". Major bumps invalidate persistent reads; minor prompt revisions keep the
// accumulated cache (spec §9).
function promptVersionMajor(version) {
    return String(version || "").split("-")[0];
}

function cacheIdentity(target, { sourceLanguage, targetLanguage } = {}) {
    const role = String(target?.role || "p");
    const normalizedKey = normalizeSourceKey(target?.source, role);
    const fingerprint = `${normalizedKey.length}:${fnv1a32(normalizedKey)}:${fnv1a32(
        normalizedKey,
        FNV_OFFSET_BASIS_B
    )}`;
    return {
        source: String(target?.source || ""),
        role,
        normalizedKey,
        // Model ID is deliberately OUT of the key (spec §9): switching models must keep serving
        // accumulated hits. Who produced an entry lives in the value.
        key: `pt3|${sourceLanguage}|${targetLanguage}|${role}|${fingerprint}`,
    };
}

class PageTranslationCache {
    constructor({
        channel,
        sourceLanguage,
        targetLanguage,
        model,
        promptVersion,
        qualityTier,
        maxEntries = 6000,
        now,
    } = {}) {
        this.channel = channel || null;
        this.sourceLanguage = String(sourceLanguage || "auto");
        this.targetLanguage = String(targetLanguage || "");
        this.model = String(model || "");
        this.promptVersion = String(promptVersion || "pt3-3");
        // cloud = 1, on-device = 0. Reads accept only qualityTier >= current so on-device
        // output never masquerades as a cloud-quality hit (spec §9).
        this.qualityTier = Number.isFinite(qualityTier) ? qualityTier : 1;
        this.maxEntries = Math.max(1, Number(maxEntries) || 6000);
        this.now = typeof now === "function" ? now : () => Date.now();
        this.memory = new Map();
        // In-flight join: concurrent targets with the same normalized source share one
        // translation request instead of paying for duplicates.
        this.entriesByText = new Map();
        this.pendingWrites = new Map();
        this.writeFlushScheduled = false;
    }

    identify(target) {
        return cacheIdentity(target, this);
    }

    remember(key, value) {
        if (this.memory.has(key)) this.memory.delete(key);
        else if (this.memory.size >= this.maxEntries) {
            this.memory.delete(this.memory.keys().next().value);
        }
        this.memory.set(key, value);
    }

    acceptsPersistentValue(value, identity, now = this.now()) {
        if (!value || value.v !== CACHE_VALUE_VERSION) return false;
        // Full-source verification: the composite fingerprint makes collisions implausible,
        // never impossible.
        if (value.k !== identity.normalizedKey) return false;
        if (typeof value.t !== "string" || !value.t.trim()) return false;
        if (value.t === KEEP_SOURCE_SENTINEL) return false;
        if ((Number(value.qualityTier) || 0) < this.qualityTier) return false;
        if (promptVersionMajor(value.promptVersion) !== promptVersionMajor(this.promptVersion)) {
            return false;
        }
        if (!(Number(value.ts) > now - PERSISTENT_TTL_MS)) return false;
        return true;
    }

    async getMany(targets) {
        const now = this.now();
        const hits = new Map();
        const missing = new Map();
        for (const target of targets || []) {
            const identity = this.identify(target);
            const memoryValue = this.memory.get(identity.key);
            // Session-memory entries were validated when written this session; only the
            // full-source check guards them. "=" hits are served here (session-only).
            if (memoryValue && memoryValue.k === identity.normalizedKey) {
                this.remember(identity.key, memoryValue);
                hits.set(target.id, memoryValue.t);
            } else {
                const pending = missing.get(identity.key) || { targets: [], identity };
                pending.targets.push(target);
                missing.set(identity.key, pending);
            }
        }
        if (!missing.size || !this.channel?.request) return hits;
        try {
            const entries = await this.channel.request("persistent_segment_get", {
                keys: Array.from(missing.keys()),
            });
            for (const entry of entries || []) {
                const pending = missing.get(entry?.key);
                if (!pending) continue;
                if (!this.acceptsPersistentValue(entry.value, pending.identity, now)) continue;
                this.remember(entry.key, entry.value);
                for (const target of pending.targets) hits.set(target.id, entry.value.t);
            }
        } catch {
            // Persistent caching is an optimization. Translation must remain available if IDB fails.
        }
        return hits;
    }

    // Callers must only pass validator-accepted translations (validated-only writes, spec §9).
    set(target, translation) {
        if (!target || typeof translation !== "string" || !translation.trim()) return;
        const identity = this.identify(target);
        const value = {
            v: CACHE_VALUE_VERSION,
            k: identity.normalizedKey,
            t: translation,
            model: this.model,
            promptVersion: this.promptVersion,
            qualityTier: this.qualityTier,
            ts: this.now(),
        };
        this.remember(identity.key, value);
        // "=" keep-source resolutions are session-only, never persisted (spec §9): whether a
        // string "is already target language" depends on this session's language pair state.
        if (translation === KEEP_SOURCE_SENTINEL) return;
        this.pendingWrites.set(identity.key, { key: identity.key, value });
        if (this.writeFlushScheduled) return;
        this.writeFlushScheduled = true;
        const schedule =
            typeof queueMicrotask === "function"
                ? queueMicrotask
                : (callback) => Promise.resolve().then(callback);
        schedule(() => this.flushPersistentWrites());
    }

    /**
     * In-flight join over the same normalization as every cache layer. The first caller for a
     * normalized source owns the request (`owner: true`) and must call settleInFlight() with
     * the validated translation (or null on failure); every later caller awaits the shared
     * promise instead of dispatching a duplicate.
     */
    joinInFlight(target) {
        const identity = this.identify(target);
        const existing = this.entriesByText.get(identity.normalizedKey);
        if (existing) return { owner: false, promise: existing.promise };
        let resolve;
        const promise = new Promise((res) => {
            resolve = res;
        });
        this.entriesByText.set(identity.normalizedKey, { promise, resolve });
        return { owner: true, promise };
    }

    settleInFlight(target, translation) {
        const identity = this.identify(target);
        const entry = this.entriesByText.get(identity.normalizedKey);
        if (!entry) return;
        this.entriesByText.delete(identity.normalizedKey);
        entry.resolve(typeof translation === "string" && translation.trim() ? translation : null);
    }

    flushPersistentWrites() {
        this.writeFlushScheduled = false;
        if (!this.pendingWrites.size) return;
        const entries = Array.from(this.pendingWrites.values());
        this.pendingWrites.clear();
        try {
            this.channel?.emit?.("persistent_segment_save", {
                entries,
            });
        } catch {
            // Fire-and-forget persistent cache writes never own translation correctness.
        }
    }
}

export {
    KEEP_SOURCE_SENTINEL,
    PERSISTENT_TTL_MS,
    PageTranslationCache,
    cacheIdentity,
    fnv1a32,
    promptVersionMajor,
};
