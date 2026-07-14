import {
    PERSISTENT_TTL_MS,
    PageTranslationCache,
    cacheIdentity,
    promptVersionMajor,
} from "../../../src/content/ai_page_translation/runtime/translation_cache.js";
import { normalizeSourceKey } from "../../../src/content/ai_page_translation/runtime/normalize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function persistentStore() {
    const store = new Map();
    return {
        store,
        channel: {
            emit: jest.fn((service, payload) => {
                if (service !== "persistent_segment_save") return;
                for (const entry of payload.entries) store.set(entry.key, entry.value);
            }),
            request: jest.fn(async (service, payload) => {
                if (service !== "persistent_segment_get") throw new Error(service);
                return payload.keys
                    .map((key) => ({ key, value: store.get(key) }))
                    .filter((entry) => entry.value);
            }),
        },
    };
}

function makeCache(channel, overrides = {}) {
    return new PageTranslationCache({
        channel,
        sourceLanguage: "ja",
        targetLanguage: "ko",
        model: "gemini-2.5-flash",
        promptVersion: "pt3-1",
        qualityTier: 1,
        ...overrides,
    });
}

describe("AI page translation cache (vNext re-key)", () => {
    describe("key derivation", () => {
        it("builds pt3 keys with the composite length + double-FNV fingerprint", () => {
            const identity = cacheIdentity(
                { source: "駅一覧", role: "h" },
                { sourceLanguage: "ja", targetLanguage: "ko" }
            );
            expect(identity.key).toMatch(/^pt3\|ja\|ko\|h\|\d+:[0-9a-z]+:[0-9a-z]+$/);
            expect(identity.normalizedKey).toBe(normalizeSourceKey("駅一覧", "h"));
        });

        it("joins whitespace and NFC variants onto one key but separates roles", () => {
            const options = { sourceLanguage: "ja", targetLanguage: "ko" };
            const spaced = cacheIdentity({ source: "  Hello   world ", role: "p" }, options);
            const plain = cacheIdentity({ source: "Hello world", role: "p" }, options);
            const decomposed = cacheIdentity({ source: "Cafe\u0301", role: "p" }, options);
            const composed = cacheIdentity({ source: "Caf\u00e9", role: "p" }, options);
            const heading = cacheIdentity({ source: "Hello world", role: "h" }, options);

            expect(spaced.key).toBe(plain.key);
            expect(decomposed.key).toBe(composed.key);
            expect(heading.key).not.toBe(plain.key);
        });

        it("keeps the model OUT of the key", () => {
            const target = { source: "淀屋橋駅", role: "p" };
            const a = makeCache(null, { model: "gemini-2.5-flash" }).identify(target);
            const b = makeCache(null, { model: "gpt-5-mini" }).identify(target);
            expect(a.key).toBe(b.key);
        });
    });

    describe("read policy", () => {
        it("serves a persistent hit after a model switch", async () => {
            const { channel } = persistentStore();
            const target = { id: "t1", role: "p", source: "淀屋橋駅から三条駅までを結ぶ。" };

            const writer = makeCache(channel, { model: "gemini-2.5-flash" });
            writer.set(target, "요도야바시역에서 산조역까지를 잇는다.");
            await Promise.resolve();

            const reader = makeCache(channel, { model: "gpt-5-mini" });
            const hits = await reader.getMany([target]);
            expect(hits.get("t1")).toBe("요도야바시역에서 산조역까지를 잇는다.");

            const stored = channel.emit.mock.calls[0][1].entries[0].value;
            expect(stored.model).toBe("gemini-2.5-flash");
        });

        it("enforces the 7-day TTL on read", async () => {
            const { channel } = persistentStore();
            const target = { id: "t1", role: "p", source: "駅一覧" };
            const writtenAt = 1_700_000_000_000;

            makeCache(channel, { now: () => writtenAt }).set(target, "역 목록");
            await Promise.resolve();

            const freshReader = makeCache(channel, { now: () => writtenAt + 6 * DAY_MS });
            expect((await freshReader.getMany([target])).get("t1")).toBe("역 목록");

            const staleReader = makeCache(channel, { now: () => writtenAt + 8 * DAY_MS });
            expect((await staleReader.getMany([target])).size).toBe(0);
            expect(writtenAt + 8 * DAY_MS - writtenAt).toBeGreaterThan(PERSISTENT_TTL_MS);
        });

        it("never serves on-device output as a cloud-quality hit", async () => {
            const { channel } = persistentStore();
            const target = { id: "t1", role: "p", source: "駅一覧" };

            makeCache(channel, { qualityTier: 0 }).set(target, "역 목록");
            await Promise.resolve();

            const cloudReader = makeCache(channel, { qualityTier: 1 });
            expect((await cloudReader.getMany([target])).size).toBe(0);

            const onDeviceReader = makeCache(channel, { qualityTier: 0 });
            expect((await onDeviceReader.getMany([target])).get("t1")).toBe("역 목록");
        });

        it("accepts cloud entries when reading at on-device quality", async () => {
            const { channel } = persistentStore();
            const target = { id: "t1", role: "p", source: "駅一覧" };

            makeCache(channel, { qualityTier: 1 }).set(target, "역 목록");
            await Promise.resolve();

            const reader = makeCache(channel, { qualityTier: 0 });
            expect((await reader.getMany([target])).get("t1")).toBe("역 목록");
        });

        it("invalidates on prompt-version major bumps but not minor revisions", async () => {
            const { channel } = persistentStore();
            const target = { id: "t1", role: "p", source: "駅一覧" };

            makeCache(channel, { promptVersion: "pt3-1" }).set(target, "역 목록");
            await Promise.resolve();

            const minorReader = makeCache(channel, { promptVersion: "pt3-4" });
            expect((await minorReader.getMany([target])).get("t1")).toBe("역 목록");

            const majorReader = makeCache(channel, { promptVersion: "pt4-1" });
            expect((await majorReader.getMany([target])).size).toBe(0);
            expect(promptVersionMajor("pt3-4")).toBe("pt3");
        });

        it("rejects a fingerprint collision through full-source verification", async () => {
            const { store, channel } = persistentStore();
            const target = { id: "t1", role: "p", source: "駅一覧" };

            makeCache(channel).set(target, "역 목록");
            await Promise.resolve();

            const key = Array.from(store.keys())[0];
            store.set(key, {
                ...store.get(key),
                k: normalizeSourceKey("別のテキスト", "p"),
            });
            expect((await makeCache(channel).getMany([target])).size).toBe(0);
        });
    });

    describe("keep-source sentinel", () => {
        it("never persists '=' resolutions but serves them within the session", async () => {
            const { channel } = persistentStore();
            const cache = makeCache(channel);
            const target = { id: "t1", role: "p", source: "Seoul Metro" };

            cache.set(target, "=");
            await Promise.resolve();
            expect(channel.emit).not.toHaveBeenCalled();

            const hits = await cache.getMany([target]);
            expect(hits.get("t1")).toBe("=");
            expect(channel.request).not.toHaveBeenCalled();
        });
    });

    describe("write batching (ported v2 behavior)", () => {
        it("coalesces one provider packet worth of cache writes into one background message", async () => {
            const channel = { emit: jest.fn(), request: jest.fn(async () => []) };
            const cache = makeCache(channel);

            for (let index = 0; index < 256; index += 1) {
                cache.set(
                    { id: `t${index}`, role: "p", source: `Unique source ${index}` },
                    `번역 ${index}`
                );
            }

            expect(channel.emit).not.toHaveBeenCalled();
            await Promise.resolve();

            expect(channel.emit).toHaveBeenCalledTimes(1);
            expect(channel.emit).toHaveBeenCalledWith(
                "persistent_segment_save",
                expect.objectContaining({ entries: expect.any(Array) })
            );
            expect(channel.emit.mock.calls[0][1].entries).toHaveLength(256);
        });

        it("keeps only the latest pending value for the same cache identity", async () => {
            const channel = { emit: jest.fn() };
            const cache = makeCache(channel);
            const target = { id: "t1", role: "h", source: "Railway guide" };

            cache.set(target, "철도 안내");
            cache.set(target, "철도 가이드");
            await Promise.resolve();

            const entries = channel.emit.mock.calls[0][1].entries;
            expect(entries).toHaveLength(1);
            expect(entries[0].value.t).toBe("철도 가이드");
        });
    });

    describe("in-flight join (entriesByText)", () => {
        it("gives one owner per normalized source and resolves every joiner", async () => {
            const cache = makeCache(null);
            const owner = cache.joinInFlight({ id: "t1", role: "p", source: "駅一覧" });
            const joiner = cache.joinInFlight({ id: "t2", role: "p", source: " 駅一覧 " });
            expect(owner.owner).toBe(true);
            expect(joiner.owner).toBe(false);

            cache.settleInFlight({ id: "t1", role: "p", source: "駅一覧" }, "역 목록");
            await expect(joiner.promise).resolves.toBe("역 목록");
            await expect(owner.promise).resolves.toBe("역 목록");

            const reclaimed = cache.joinInFlight({ id: "t3", role: "p", source: "駅一覧" });
            expect(reclaimed.owner).toBe(true);
        });

        it("resolves joiners with null when the owner's request fails", async () => {
            const cache = makeCache(null);
            const target = { id: "t1", role: "p", source: "駅一覧" };
            cache.joinInFlight(target);
            const joiner = cache.joinInFlight({ id: "t2", role: "p", source: "駅一覧" });

            cache.settleInFlight(target, null);
            await expect(joiner.promise).resolves.toBeNull();
        });

        it("keeps different roles as separate in-flight entries", () => {
            const cache = makeCache(null);
            expect(cache.joinInFlight({ id: "t1", role: "p", source: "駅一覧" }).owner).toBe(true);
            expect(cache.joinInFlight({ id: "t2", role: "h", source: "駅一覧" }).owner).toBe(true);
        });
    });

    describe("session LRU", () => {
        it("evicts the oldest session entry beyond the capacity bound", async () => {
            const cache = makeCache(null, { maxEntries: 2 });
            cache.set({ id: "a", role: "p", source: "first" }, "첫째");
            cache.set({ id: "b", role: "p", source: "second" }, "둘째");
            cache.set({ id: "c", role: "p", source: "third" }, "셋째");

            const hits = await cache.getMany([
                { id: "a", role: "p", source: "first" },
                { id: "b", role: "p", source: "second" },
                { id: "c", role: "p", source: "third" },
            ]);
            expect(hits.has("a")).toBe(false);
            expect(hits.get("b")).toBe("둘째");
            expect(hits.get("c")).toBe("셋째");
        });
    });
});
