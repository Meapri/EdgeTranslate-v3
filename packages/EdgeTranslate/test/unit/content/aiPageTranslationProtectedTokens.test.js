/**
 * Protected-token local masking (docs/AI_PAGE_TRANSLATION_LUNA_SPEED_RESEARCH.md
 * "P0: make protected tokens local data"). Two layers:
 *
 *  1. Property/adversarial suite over runtime/protected_tokens.js: mask→restore round-trip
 *     identity, the "masked set == validator protected set" invariant, gN/kN namespace
 *     isolation, and malformed replies (missing / duplicate / invented `<kN/>` → ok:false,
 *     never throws).
 *  2. A session/reply-pipeline trace proving the XDA retry-amplification class is gone: a model
 *     that returns the translation with the placeholder intact ACCEPTS in one request with the
 *     identifier restored verbatim and zero semantic retries; a model that drops the placeholder
 *     degrades through the bounded placeholder ladder, never a naked identifier semantic retry.
 */

import {
    K_GRAMMAR,
    maskProtectedTokens,
    restoreProtectedTokens,
} from "../../../src/content/ai_page_translation/runtime/protected_tokens.js";
import {
    PROTECTED_TOKEN_MATCHERS,
    extractProtectedExacts,
    findProtectedSpans,
} from "../../../src/content/ai_page_translation/runtime/validator.js";
import { PLACEHOLDER_GRAMMAR } from "../../../src/content/ai_page_translation/dom/block_ir.js";
import { createAiPageTranslationSession } from "../../../src/content/ai_page_translation/index.js";
import {
    createQueueDouble,
    createSchedulerDouble,
    flushMicrotasks,
} from "./aiPageTranslationVnextTestKit.js";

const K_TOKEN_EXACT = /^<k\d+\/>$/;

/** Deterministic PRNG so the property suite replays identically on every CI run. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a += 0x6d2b79f5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A spread of genuinely-protected spans (letter-led-with-digit identifiers, URLs, emails, code)
// and safe-to-translate fillers (plain words, CJK, plain integers, bare dotted versions).
const PROTECTED = [
    "N100",
    "DDR4",
    "2.5GbE",
    "gpt-5.6-luna",
    "v1.2.3",
    "RFC2616",
    "sha-256",
    "https://xda.com/n100?ref=1",
    "user.name@example.co.uk",
    "`npm run build`",
    "/usr/lib/node18/bin",
];
const SAFE = ["quiet", "server", "京阪", "노선", "속도", "and", "the", "2025", "1.2.3", "駅"];
const PUNCT = ["", ",", ".", "…", "은", "を", ")", ":"];
const GTAGS = ["<g1>", "</g1>", "<v1/>", "<g2>", "</g2>"];

function pick(rand, list) {
    return list[Math.floor(rand() * list.length)];
}

function randomSource(rand) {
    const parts = [];
    const count = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i += 1) {
        const roll = rand();
        if (roll < 0.34) parts.push(pick(rand, PROTECTED) + pick(rand, PUNCT));
        else if (roll < 0.5) parts.push(pick(rand, GTAGS));
        else parts.push(pick(rand, SAFE) + pick(rand, PUNCT));
    }
    const lead = rand() < 0.3 ? " " : "";
    const trail = rand() < 0.3 ? " " : "";
    return `${lead}${parts.join(rand() < 0.5 ? " " : "")}${trail}`;
}

/** Multiset comparison independent of order. */
function sortedCopy(list) {
    return list.slice().sort();
}

describe("protected-token masking — module invariants", () => {
    test("K_GRAMMAR and the block-IR placeholder grammar are disjoint namespaces", () => {
        // block IR never parses <kN/>, so masking survives block serialization untouched…
        expect(new RegExp(PLACEHOLDER_GRAMMAR.source).test("<k0/>")).toBe(false);
        // …and restoration never disturbs a <gN>/<vN/> tag.
        expect(new RegExp(K_GRAMMAR.source).test("<g1>")).toBe(false);
        expect(new RegExp(K_GRAMMAR.source).test("</g1>")).toBe(false);
        expect(new RegExp(K_GRAMMAR.source).test("<v1/>")).toBe(false);
        expect(new RegExp(K_GRAMMAR.source).test("<k7/>")).toBe(true);
    });

    test("masks the letter-led protected identifiers and restores them verbatim", () => {
        const source = "The N100 supports DDR4 and RFC2616.";
        const { masked, map } = maskProtectedTokens(source);
        expect(masked).toBe("The <k0/> supports <k1/> and <k2/>.");
        expect(map).toEqual(["N100", "DDR4", "RFC2616"]);
        const restore = restoreProtectedTokens(masked, map);
        expect(restore.ok).toBe(true);
        expect(restore.restored).toBe(source);
    });

    test("does NOT mask ordinary words, plain integers, or digit-led tokens the validator localizes", () => {
        // The masked set is exactly the validator's byte-exact class (letter-led-with-digit
        // identifiers, URLs, emails, code). Plain integers, bare dotted versions, and digit-led
        // mixed tokens like "2.5GbE" are localized by the number tier, not masked.
        for (const safe of [
            "quiet server",
            "in 2025",
            "version 1.2.3",
            "2.5GbE",
            "京阪本線 노선",
        ]) {
            expect(maskProtectedTokens(safe)).toEqual({ masked: safe, map: [] });
        }
    });

    test("mask→restore is an identity round-trip over the generative corpus", () => {
        const rand = mulberry32(0xc0ffee);
        for (let i = 0; i < 400; i += 1) {
            const source = randomSource(rand);
            const { masked, map } = maskProtectedTokens(source);
            // Masked output only ever injects the well-formed <kN/> namespace.
            for (const token of masked.match(/<k[^>]*\/>/g) || []) {
                expect(K_TOKEN_EXACT.test(token)).toBe(true);
            }
            const restore = restoreProtectedTokens(masked, map);
            expect(restore.ok).toBe(true);
            expect(restore.restored).toBe(source);
        }
    });

    test("repeated identical identifiers get distinct indices and both restore", () => {
        const { masked, map } = maskProtectedTokens("N100 vs N100 again, RFC2616 then RFC2616");
        expect(map).toEqual(["N100", "N100", "RFC2616", "RFC2616"]);
        expect(masked).toBe("<k0/> vs <k1/> again, <k2/> then <k3/>");
        expect(restoreProtectedTokens(masked, map).restored).toBe(
            "N100 vs N100 again, RFC2616 then RFC2616"
        );
    });

    test("identifiers adjacent to CJK / punctuation mask and restore cleanly", () => {
        const source = "駅N100은 sha-256, gpt-5.6-luna를 지원한다.";
        const { masked, map } = maskProtectedTokens(source);
        expect(map).toEqual(["N100", "sha-256", "gpt-5.6-luna"]);
        expect(restoreProtectedTokens(masked, map).restored).toBe(source);
        // The CJK filler is preserved untouched around the masked identifier.
        expect(masked).toContain("駅<k0/>은");
    });

    test("existing block-IR format tags are preserved through masking (kN vs gN)", () => {
        const source = "前<g1>DDR4 링크</g1>후 https://ex.com/p<v1/>끝";
        const { masked, map } = maskProtectedTokens(source);
        expect(map).toEqual(["DDR4", "https://ex.com/p"]);
        // gN/vN survive byte-identically; only the protected values became kN.
        expect(masked).toBe("前<g1><k0/> 링크</g1>후 <k1/><v1/>끝");
        expect(restoreProtectedTokens(masked, map).restored).toBe(source);
    });

    test("the masked set equals the validator's byte-exact protected set (shared fixture)", () => {
        const fixture =
            "See https://xda.com/n100?ref=1, mail user.name@example.co.uk, run `npm i`, " +
            "chip N100 and DDR4-3200 at 2.5GbE.";
        const maskedTokens = maskProtectedTokens(fixture).map;
        const validatorTokens = extractProtectedExacts(fixture).tokens.map((t) => t.token);
        expect(sortedCopy(maskedTokens)).toEqual(sortedCopy(validatorTokens));
        // And both share the one exported matcher table.
        expect(PROTECTED_TOKEN_MATCHERS.map((m) => m.tokenClass)).toEqual([
            "url",
            "email",
            "code",
            "identifier",
        ]);
        expect(findProtectedSpans(fixture).map((s) => s.token)).toEqual(
            expect.arrayContaining(validatorTokens)
        );
    });

    test("trailing sentence punctuation stays outside the masked URL span", () => {
        const { masked, map } = maskProtectedTokens("Visit https://ex.com/a).");
        expect(map).toEqual(["https://ex.com/a"]);
        expect(masked).toBe("Visit <k0/>).");
    });

    describe("malformed replies never throw and report ok:false with indices", () => {
        const source = "N100 and DDR4 and RFC2616";
        const { map } = maskProtectedTokens(source); // ["N100","DDR4","RFC2616"]

        test("a genuinely missing kN degrades", () => {
            const r = restoreProtectedTokens("<k0/> 그리고 <k2/>", map);
            expect(r.ok).toBe(false);
            expect(r.missing).toEqual([1]);
            expect(r.restored).toBe("N100 그리고 RFC2616");
        });

        test("a duplicated kN is illegal", () => {
            const r = restoreProtectedTokens("<k0/> <k1/> <k1/> <k2/>", map);
            expect(r.ok).toBe(false);
            expect(r.duplicated).toEqual([1]);
        });

        test("an invented out-of-range kN is dropped and flagged", () => {
            const r = restoreProtectedTokens("<k0/> <k1/> <k2/> <k9/>", map);
            expect(r.ok).toBe(false);
            expect(r.extra).toEqual([9]);
            expect(r.restored).toBe("N100 DDR4 RFC2616 ");
        });

        test("a merely reordered-but-complete set restores fine", () => {
            const r = restoreProtectedTokens("<k2/> <k0/> <k1/>", map);
            expect(r.ok).toBe(true);
            expect(r.restored).toBe("RFC2616 N100 DDR4");
        });

        test("an empty map with a stray kN in the reply is flagged, not thrown", () => {
            const r = restoreProtectedTokens("clean 번역 <k0/>", []);
            expect(r.ok).toBe(false);
            expect(r.extra).toEqual([0]);
            expect(r.restored).toBe("clean 번역 ");
        });

        test("null/undefined inputs are tolerated", () => {
            expect(() => restoreProtectedTokens(undefined, undefined)).not.toThrow();
            expect(maskProtectedTokens(undefined)).toEqual({ masked: "", map: [] });
        });
    });
});

// ---------------------------------------------------------------------------
// Session / reply-pipeline trace
// ---------------------------------------------------------------------------

const activeControllers = [];

function makeHarness({ html, translate, sourceLanguage = "en", targetLanguage = "ko" }) {
    document.body.innerHTML = html;
    const root = document.getElementById("main") || document.body;
    const calls = { translate: [] };
    const channel = {
        request: async (service, payload) => {
            if (service === "get_page_translation_capabilities") {
                return {
                    provider: "openai",
                    apiKeyHash: "k1",
                    profileRevision: "r1",
                    maxOutputTokens: 4096,
                };
            }
            if (service === "persistent_segment_get") return [];
            if (service === "translate_page_packet") {
                calls.translate.push(payload);
                return translate(payload);
            }
            if (service === "cancel_page_translation") return { aborted: 0 };
            return null;
        },
        emit: () => {},
    };
    const queue = createQueueDouble();
    const controller = createAiPageTranslationSession({
        engine: "openai",
        channel,
        root,
        sourceLanguage,
        targetLanguage,
        providerProfileId: "profile-1",
        title: "Test",
        domain: "example.test",
        deps: {
            createPriorityQueue: () => queue,
            createScheduler: (opts) => createSchedulerDouble(opts),
        },
    });
    activeControllers.push(controller);
    return { controller, calls, root };
}

async function drainAll() {
    await flushMicrotasks(60);
    jest.advanceTimersByTime(0);
    await flushMicrotasks(60);
    jest.advanceTimersByTime(300);
    await flushMicrotasks(60);
}

describe("protected-token masking — session reply pipeline", () => {
    beforeEach(() => jest.useFakeTimers("modern"));
    afterEach(() => {
        for (const controller of activeControllers.splice(0)) controller.stop("test-teardown");
        jest.useRealTimers();
        document.body.innerHTML = "";
    });

    it("ACCEPTS a kept-placeholder reply in one request with the identifier restored verbatim", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>The N100 mini PC is a quiet home server.</p></div>",
            // The model echoes the opaque placeholder untouched (its only job) and translates
            // the surrounding words. It never sees — and so can never corrupt — "N100".
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: `번역: ${unit.text}`,
                })),
                usageReceipts: [],
            }),
        });

        await h.controller.start();
        await drainAll();

        const snapshot = h.controller.getStatusSnapshot();
        // Proof the model was handed the MASKED source, never the raw identifier.
        expect(h.calls.translate[0].units[0].text).toBe(
            "The <k0/> mini PC is a quiet home server."
        );
        expect(h.calls.translate.length).toBe(1); // zero retries
        expect(snapshot).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
        // The byte-exact identifier hard-fail never fired, and no semantic retry was spent.
        expect(snapshot.telemetry.validation_fail_identifier).toBeUndefined();
        expect(snapshot.telemetry.semantic_retry).toBeUndefined();
        expect(snapshot.telemetry.protected_token_restore_failed).toBeUndefined();
        // The DOM carries the verbatim identifier.
        expect(h.root.querySelector("p").textContent).toBe(
            "번역: The N100 mini PC is a quiet home server."
        );
    });

    it("degrades a dropped placeholder through the bounded placeholder ladder, not a semantic retry", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>The N100 mini PC is a quiet home server.</p></div>",
            // Pathological model that omits the placeholder every time.
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: "이것은 조용한 홈 서버입니다",
                })),
                usageReceipts: [],
            }),
        });

        await h.controller.start();
        await drainAll();

        const snapshot = h.controller.getStatusSnapshot();
        // Bounded: original + exactly one placeholder-ladder retry, then terminal — no loop.
        expect(h.calls.translate.length).toBe(2);
        expect(snapshot.telemetry.protected_token_restore_failed).toBeGreaterThanOrEqual(1);
        // Crucially: the eliminated class. No naked identifier semantic retry, no identifier
        // hard-fail counter, no runaway amplification.
        expect(snapshot.telemetry.semantic_retry).toBeUndefined();
        expect(snapshot.telemetry.validation_fail_identifier).toBeUndefined();
        expect(snapshot.runawayLatched).toBeFalsy();
        expect(snapshot.phase).toBe("complete");
    });
});
