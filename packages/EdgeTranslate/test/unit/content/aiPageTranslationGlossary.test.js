import {
    createPageGlossary,
    glossaryStoreKey,
    harvestGlossaryTerms,
} from "../../../src/content/ai_page_translation/runtime/glossary.js";

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

const KEIHAN_BLOCKS = [
    "京阪電気鉄道の路線。京阪電気鉄道は大阪に本社を置く。",
    "京阪電気鉄道の主要路線は淀屋橋駅から三条駅までを結ぶ。",
    "Keihan Railway operates the line. Keihan Railway also runs buses.",
    "Many trains of Keihan Railway connect Osaka with Kyoto.",
];

const SESSION = {
    title: "京阪本線 - Wikipedia",
    domain: "ja.wikipedia.org",
    sl: "ja",
    tl: "ko",
    blocks: KEIHAN_BLOCKS,
};

describe("AI page translation vNext glossary harvest", () => {
    it("is deterministic: the same page harvests a byte-identical gloss", async () => {
        const first = await createPageGlossary().buildSessionContext(SESSION);
        const second = await createPageGlossary().buildSessionContext(SESSION);

        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it("requires at least three occurrences across blocks", () => {
        const terms = harvestGlossaryTerms([
            "トウキョウの記事。トウキョウは首都。",
            "トウキョウとケイハンの比較。ケイハンの路線。",
        ]);

        expect(terms).toContain("トウキョウ");
        expect(terms).not.toContain("ケイハン");
    });

    it("applies the pinned per-script candidate heuristics", () => {
        const blocks = [
            // Capitalized-Latin run of >=2 words, repeated 3x.
            "Keihan Railway history. Keihan Railway stations. Keihan Railway trains.",
            // Single capitalized word: >=4 chars qualifies, 3 chars does not.
            "Tokyo grew. Tokyo expanded. Tokyo modernized. Bob ran. Bob slept. Bob left.",
            // Katakana runs need >=3 chars.
            "システムのカナ表記。システムの設計。システムの運用。カナ表記とカナ表記。",
            // Han runs need >=2 chars; single-character runs are never candidates.
            "駅と駅と駅。淀屋橋の歴史。淀屋橋の構造。淀屋橋の未来。",
        ];
        const terms = harvestGlossaryTerms(blocks);

        expect(terms).toEqual(
            expect.arrayContaining(["Keihan Railway", "Tokyo", "システム", "淀屋橋"])
        );
        expect(terms).not.toContain("Bob");
        expect(terms).not.toContain("カナ");
        expect(terms).not.toContain("駅");
    });

    it("harvests count-desc then first-occurrence and caps the harvest at 24 terms", () => {
        const kata = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ";
        const terms = Array.from(kata, (char) => char.repeat(3));
        const blocks = [terms.map((term) => `${term}。${term}。${term}。`).join(" ")];
        // One extra occurrence pushes a late term to the front.
        blocks.push(`${terms[29]}。`);

        const harvested = harvestGlossaryTerms(blocks);
        expect(harvested).toHaveLength(24);
        expect(harvested[0]).toBe(terms[29]);
        expect(harvested.slice(1)).toEqual(terms.slice(0, 23));
    });

    it("caps source-only ctx entries at 8 (each is repeated per request for marginal value)", async () => {
        const kata = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ";
        const terms = Array.from(kata, (char) => char.repeat(3));
        const blocks = [terms.map((term) => `${term}。${term}。${term}。`).join(" ")];
        blocks.push(`${terms[29]}。`);

        const gloss = (await createPageGlossary().buildSessionContext({ ...SESSION, blocks }))
            .gloss;

        // No stored pairs -> all entries are source-only, capped to the top 8 by frequency.
        expect(gloss).toHaveLength(8);
        expect(gloss[0]).toEqual([terms[29]]);
        expect(gloss.slice(1).map(([term]) => term)).toEqual(terms.slice(0, 7));
        expect(gloss.every((entry) => entry.length === 1)).toBe(true);
    });

    it("emits a source-side entity list only on first visit and freezes the context", async () => {
        const glossary = createPageGlossary();
        const context = await glossary.buildSessionContext(SESSION);

        expect(context.title).toBe(SESSION.title);
        expect(context.domain).toBe(SESSION.domain);
        expect(context.gloss.length).toBeGreaterThan(0);
        for (const entry of context.gloss) expect(entry).toHaveLength(1);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.gloss)).toBe(true);

        // Built ONCE: later calls return the identical frozen object.
        expect(await glossary.buildSessionContext({ ...SESSION, title: "other" })).toBe(context);
    });

    it("seeds validated pairs from the per-domain store on revisit", async () => {
        const { channel, store } = persistentStore();
        const first = createPageGlossary({ channel, now: () => 1000 });
        await first.buildSessionContext(SESSION);
        expect(first.recordValidatedPair("京阪電気鉄道", "게이한 전기철도")).toBe(true);
        first.flushPendingWrites();

        expect(store.has(glossaryStoreKey("ja.wikipedia.org", "ja", "ko"))).toBe(true);

        const revisit = await createPageGlossary({ channel }).buildSessionContext(SESSION);
        expect(revisit.gloss).toContainEqual(["京阪電気鉄道", "게이한 전기철도"]);
        // Terms without a validated pair stay source-only.
        expect(revisit.gloss).toContainEqual(["Keihan Railway"]);
    });

    it("batches store writes and only records harvested validated pairs", async () => {
        const { channel, store } = persistentStore();
        const glossary = createPageGlossary({ channel, now: () => 1000 });

        // Before the session context exists nothing can be attributed to a domain.
        expect(glossary.recordValidatedPair("京阪電気鉄道", "게이한 전기철도")).toBe(false);

        await glossary.buildSessionContext(SESSION);
        expect(glossary.recordValidatedPair("存在しない用語", "임의 번역")).toBe(false);
        expect(glossary.recordValidatedPair("京阪電気鉄道", "게이한 전기철도")).toBe(true);
        expect(glossary.recordValidatedPair("Keihan Railway", "게이한 전철")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(channel.emit).toHaveBeenCalledTimes(1);
        const saved = store.get(glossaryStoreKey("ja.wikipedia.org", "ja", "ko"));
        expect(saved.pairs).toEqual({
            京阪電気鉄道: "게이한 전기철도",
            "Keihan Railway": "게이한 전철",
        });

        // Re-recording an unchanged pair queues no new write.
        expect(glossary.recordValidatedPair("京阪電気鉄道", "게이한 전기철도")).toBe(false);
    });

    it("builds a source-only gloss when the persistent store is unavailable", async () => {
        const channel = {
            request: jest.fn(async () => {
                throw new Error("idb-unavailable");
            }),
            emit: jest.fn(),
        };
        const context = await createPageGlossary({ channel }).buildSessionContext(SESSION);

        expect(context.gloss.length).toBeGreaterThan(0);
        for (const entry of context.gloss) expect(entry).toHaveLength(1);
    });

    it("freezes a source-only context at the deadline when the store hangs, ignoring a late reply", async () => {
        jest.useFakeTimers();
        let resolveStore;
        const channel = {
            request: jest.fn(
                () =>
                    new Promise((resolve) => {
                        resolveStore = resolve;
                    })
            ),
        };
        try {
            const glossary = createPageGlossary({ channel, storeReadTimeoutMs: 50 });
            const contextPromise = glossary.buildSessionContext(SESSION);
            await Promise.resolve();
            jest.advanceTimersByTime(50);
            const context = await contextPromise;
            for (const entry of context.gloss) expect(entry).toHaveLength(1);

            resolveStore([
                {
                    key: glossaryStoreKey("ja.wikipedia.org", "ja", "ko"),
                    value: {
                        v: 1,
                        pairs: { 京阪電気鉄道: "늦게 도착한 번역" },
                    },
                },
            ]);
            await Promise.resolve();
            expect(await glossary.buildSessionContext(SESSION)).toBe(context);
            expect(context.gloss).not.toContainEqual(["京阪電気鉄道", "늦게 도착한 번역"]);
        } finally {
            jest.useRealTimers();
        }
    });
});
