import TtlCache from "../../../src/background/library/ttlCache.js";

describe("TtlCache", () => {
    it("returns cached values before ttl expires", () => {
        const now = jest.fn(() => 1000);
        const cache = new TtlCache({ maxEntries: 2, now });

        cache.set("a", "value", 100);

        expect(cache.get("a")).toBe("value");
    });

    it("removes expired values", () => {
        const now = jest.fn(() => 1000);
        const cache = new TtlCache({ maxEntries: 2, now });

        cache.set("a", "value", 100);
        now.mockReturnValue(1101);

        expect(cache.get("a")).toBeNull();
        expect(cache.size()).toBe(0);
    });

    it("evicts the least recently used entry", () => {
        const cache = new TtlCache({ maxEntries: 2, now: () => 1000 });

        cache.set("a", "A", 0);
        cache.set("b", "B", 0);
        expect(cache.get("a")).toBe("A");
        cache.set("c", "C", 0);

        expect(cache.get("a")).toBe("A");
        expect(cache.get("b")).toBeNull();
        expect(cache.get("c")).toBe("C");
    });
});
