/**
 * Deterministic collection-time glossary for the vNext AI page translation engine (spec
 * §5.1) plus the per-domain persistent glossary store client (spec §9).
 *
 * The glossary is harvested from the collected blocks BEFORE any packet is sent and is
 * never reply-driven: reply-driven append-only glossaries make payloads nondeterministic
 * across runs and break replay fixtures. The session context built here is frozen once and
 * stays byte-identical for every packet of the session (prompt-cache hygiene, spec §4.2).
 *
 * Store layout mirrors runtime/translation_cache.js: the same background channel services
 * ("persistent_segment_get" / "persistent_segment_save"), reads treated as an optimization
 * that may fail, writes batched and fire-and-forget. Key: `gloss|{domain}|{sl}|{tl}`.
 *
 * First visit: the gloss carries the source-side entity list only (`[source]` entries) —
 * the model sees the inventory and self-consists. Revisit: validated pairs recorded by
 * earlier sessions on this domain are seeded as `[source, target]` entries.
 */

const GLOSSARY_STORE_VERSION = 1;
const MAX_GLOSS_ENTRIES = 24;
const MIN_TERM_OCCURRENCES = 3;
const DEFAULT_STORE_READ_TIMEOUT_MS = 150;
// Guard on the per-domain store so a pathological domain cannot grow it unboundedly;
// oldest recorded pairs are evicted first.
const MAX_STORED_PAIRS = 256;

/**
 * Harvest heuristics (spec §5.1, pinned):
 * - Capitalized-Latin runs: consecutive words each starting with an uppercase letter.
 *   Runs of >=2 words always qualify; a single capitalized word qualifies only at >=4
 *   characters (drops "Bob"-class noise; the >=3-occurrence threshold drops most
 *   sentence-initial words).
 * - Katakana runs of >=3 characters (foreign names/terms in Japanese text). The prolonged
 *   sound mark and iteration marks count as run characters.
 * - CJK proper-noun candidates: Han runs of 2-10 characters. In Japanese text kanji
 *   compounds are naturally bounded by kana; runs longer than 10 characters are almost
 *   never single proper nouns and are skipped.
 */
const CAPITALIZED_LATIN_RUN = /\p{Lu}[\p{L}\p{N}'’-]*(?:[ \u00a0]\p{Lu}[\p{L}\p{N}'’-]*)*/gu;
const KATAKANA_RUN = /[ァ-ヺー-ヾ]{3,}/gu;
const HAN_RUN = /\p{Script=Han}{2,10}/gu;

function glossaryStoreKey(domain, sl, tl) {
    return `gloss|${domain}|${sl}|${tl}`;
}

function blockText(block) {
    const text = typeof block === "string" ? block : block?.source ?? block?.text ?? "";
    return String(text).normalize("NFC").replace(/\s+/g, " ");
}

function countMatches(counts, text, pattern, accept, position) {
    let cursor = position;
    for (const match of text.matchAll(pattern)) {
        cursor += 1;
        const term = match[0];
        if (accept && !accept(term)) continue;
        const entry = counts.get(term);
        if (entry) entry.count += 1;
        else counts.set(term, { count: 1, first: cursor });
    }
    return cursor;
}

function acceptCapitalizedRun(term) {
    const words = term.split(/[ \u00a0]/);
    return words.length >= 2 || term.length >= 4;
}

/**
 * Deterministic harvest: repeated proper-noun n-grams appearing >= minOccurrences times
 * across the given blocks, ordered by count descending then first occurrence, capped at
 * maxEntries. Same page in, byte-identical term list out.
 */
function harvestGlossaryTerms(
    blocks,
    { maxEntries = MAX_GLOSS_ENTRIES, minOccurrences = MIN_TERM_OCCURRENCES } = {}
) {
    const counts = new Map();
    let position = 0;
    for (const block of Array.isArray(blocks) ? blocks : []) {
        const text = blockText(block);
        if (!text.trim()) continue;
        position = countMatches(
            counts,
            text,
            CAPITALIZED_LATIN_RUN,
            acceptCapitalizedRun,
            position
        );
        position = countMatches(counts, text, KATAKANA_RUN, null, position);
        position = countMatches(counts, text, HAN_RUN, null, position);
    }
    return Array.from(counts.entries())
        .filter(([, entry]) => entry.count >= minOccurrences)
        .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
        .slice(0, Math.max(0, maxEntries))
        .map(([term]) => term);
}

class PageGlossary {
    constructor({ channel, now, storeReadTimeoutMs, setTimeoutFn, clearTimeoutFn } = {}) {
        this.channel = channel || null;
        this.now = typeof now === "function" ? now : () => Date.now();
        this.storeReadTimeoutMs = Number.isFinite(storeReadTimeoutMs)
            ? Math.max(0, Number(storeReadTimeoutMs))
            : DEFAULT_STORE_READ_TIMEOUT_MS;
        this.setTimeoutFn =
            typeof setTimeoutFn === "function" ? setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
        this.clearTimeoutFn =
            typeof clearTimeoutFn === "function" ? clearTimeoutFn : (id) => clearTimeout(id);
        this.context = null;
        this.storeKey = null;
        this.harvestedTerms = new Set();
        this.storedPairs = new Map();
        this.pendingWrite = false;
        this.writeFlushScheduled = false;
    }

    /**
     * Builds the frozen session context ONCE (spec §5.1/§4.2): `{ title, domain, gloss }`,
     * byte-identical for every packet of the session. Subsequent calls return the same
     * frozen object regardless of arguments — the context can never drift mid-session.
     */
    async buildSessionContext({ title, domain, sl, tl, blocks, storeReadTimeoutMs } = {}) {
        if (this.context) return this.context;
        const terms = harvestGlossaryTerms(blocks);
        this.harvestedTerms = new Set(terms);
        this.storeKey = glossaryStoreKey(String(domain || ""), String(sl || ""), String(tl || ""));
        if (this.channel?.request) {
            let timeoutId = null;
            try {
                const timeoutMs = Number.isFinite(storeReadTimeoutMs)
                    ? Math.max(0, Number(storeReadTimeoutMs))
                    : this.storeReadTimeoutMs;
                const read = Promise.resolve(
                    this.channel.request("persistent_segment_get", { keys: [this.storeKey] })
                ).then(
                    (entries) => ({ kind: "store", entries }),
                    () => ({ kind: "error", entries: [] })
                );
                const timeout = new Promise((resolve) => {
                    timeoutId = this.setTimeoutFn(
                        () => resolve({ kind: "timeout", entries: [] }),
                        timeoutMs
                    );
                });
                const result = await Promise.race([read, timeout]);
                if (result.kind === "store") {
                    for (const entry of result.entries || []) {
                        if (entry?.key !== this.storeKey) continue;
                        const value = entry.value;
                        if (!value || value.v !== GLOSSARY_STORE_VERSION) continue;
                        const pairs =
                            value.pairs && typeof value.pairs === "object" ? value.pairs : {};
                        for (const [source, target] of Object.entries(pairs)) {
                            if (typeof target === "string" && target.trim()) {
                                this.storedPairs.set(source, target);
                            }
                        }
                    }
                }
            } catch {
                // The domain glossary is an optimization. A session must build (with a
                // source-only gloss) even when the persistent store is unavailable.
            } finally {
                if (timeoutId !== null) this.clearTimeoutFn(timeoutId);
            }
        }
        const gloss = terms.map((term) => {
            const target = this.storedPairs.get(term);
            return Object.freeze(target ? [term, target] : [term]);
        });
        this.context = Object.freeze({
            title: String(title || ""),
            domain: String(domain || ""),
            gloss: Object.freeze(gloss),
        });
        return this.context;
    }

    /**
     * Queues one validated (source, target) entity pair for the per-domain store. Callers
     * must only pass validator-accepted pairs (validated-only writes, spec §5.1/§9), and
     * only pairs for this session's harvested entity list are recorded — the domain store
     * holds entities, never arbitrary strings. Writes are batched.
     */
    recordValidatedPair(source, target) {
        if (!this.storeKey) return false;
        const sourceTerm = String(source ?? "");
        const targetTerm = String(target ?? "").trim();
        if (!targetTerm || !this.harvestedTerms.has(sourceTerm)) return false;
        if (this.storedPairs.get(sourceTerm) === targetTerm) return false;
        // Re-insert so eviction order tracks recency of validation.
        this.storedPairs.delete(sourceTerm);
        this.storedPairs.set(sourceTerm, targetTerm);
        while (this.storedPairs.size > MAX_STORED_PAIRS) {
            this.storedPairs.delete(this.storedPairs.keys().next().value);
        }
        this.pendingWrite = true;
        if (this.writeFlushScheduled) return true;
        this.writeFlushScheduled = true;
        const schedule =
            typeof queueMicrotask === "function"
                ? queueMicrotask
                : (callback) => Promise.resolve().then(callback);
        schedule(() => this.flushPendingWrites());
        return true;
    }

    flushPendingWrites() {
        this.writeFlushScheduled = false;
        if (!this.pendingWrite || !this.storeKey) return;
        this.pendingWrite = false;
        try {
            this.channel?.emit?.("persistent_segment_save", {
                entries: [
                    {
                        key: this.storeKey,
                        value: {
                            v: GLOSSARY_STORE_VERSION,
                            pairs: Object.fromEntries(this.storedPairs),
                            ts: this.now(),
                        },
                    },
                ],
            });
        } catch {
            // Fire-and-forget domain-glossary writes never own translation correctness.
        }
    }
}

function createPageGlossary(options = {}) {
    return new PageGlossary(options);
}

export {
    DEFAULT_STORE_READ_TIMEOUT_MS,
    MAX_GLOSS_ENTRIES,
    MIN_TERM_OCCURRENCES,
    PageGlossary,
    createPageGlossary,
    glossaryStoreKey,
    harvestGlossaryTerms,
};
