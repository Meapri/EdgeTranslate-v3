import {
    createAiPageTranslationSession,
    SUPPORTED_ENGINES,
} from "../../../src/content/ai_page_translation/index.js";
import { createEstimator } from "../../../src/content/ai_page_translation/ir/estimator.js";
import { cacheIdentity } from "../../../src/content/ai_page_translation/runtime/translation_cache.js";
import {
    buildRecoveryPackets,
    finalizePacket,
} from "../../../src/content/ai_page_translation/runtime/session_support.js";
import { createScheduler as createRuntimeScheduler } from "../../../src/content/ai_page_translation/runtime/scheduler.js";
import {
    createQueueDouble,
    createSchedulerDouble,
    flushMicrotasks,
} from "./aiPageTranslationVnextTestKit.js";

function goodUnit(unit) {
    return { id: unit.id, status: "translated", translatedText: `번역 ${unit.text}` };
}

function defaultTranslate(payload) {
    return {
        ok: true,
        units: payload.units.map(goodUnit),
        usageReceipts: [],
        costAttribution: "owner",
    };
}

function placeholderTagsBalanced(text) {
    const stack = [];
    for (const tag of String(text || "").match(/<\/?g\d+>|<v\d+\/>/g) || []) {
        if (/^<v/.test(tag)) continue;
        const open = /^<g(\d+)>$/.exec(tag);
        if (open) stack.push(open[1]);
        else if (stack.pop() !== /^<\/g(\d+)>$/.exec(tag)?.[1]) return false;
    }
    return stack.length === 0;
}

const SCHEMA_FAILURE = {
    ok: false,
    units: [],
    usageReceipts: [],
    failure: { kind: "schema-invalid", retryDirective: "split", requestMayHaveExecuted: true },
};

function unsupportedReasoningFailure({ includePatch = true } = {}) {
    return {
        ok: false,
        units: [],
        usageReceipts: [],
        failure: {
            kind: "unsupported-capability",
            message: "This model does not accept reasoning controls.",
            retryDirective: "downgrade",
            ...(includePatch ? { capabilityPatch: { reasoningControl: { value: "none" } } } : {}),
        },
    };
}

// Sessions keep their root-guardian observer alive after completion (late-joiner support),
// so every controller must be stopped on teardown or it would re-attach to the next test's
// fresh #main and translate it through the previous test's channel.
const activeControllers = [];

function makeHarness({
    html,
    translate = defaultTranslate,
    persistent = () => [],
    countTokens = () => ({ tokens: null, source: "none" }),
    capabilities = {
        provider: "openai",
        apiKeyHash: "k1",
        profileRevision: "r1",
        maxOutputTokens: 4096,
    },
    sourceLanguage = "en",
    targetLanguage = "ko",
    options = {},
    dependencyOverrides = {},
} = {}) {
    document.body.innerHTML = html;
    const root = document.getElementById("main") || document.body;
    const calls = { translate: [], count: [], cancel: [], saves: [], order: [] };
    const channel = {
        request: async (service, payload) => {
            calls.order.push(service);
            if (service === "get_page_translation_capabilities") {
                return typeof capabilities === "function"
                    ? capabilities(payload)
                    : { ...capabilities };
            }
            if (service === "persistent_segment_get") return persistent(payload);
            if (service === "count_page_translation_tokens") {
                calls.count.push(payload);
                return countTokens(payload);
            }
            if (service === "translate_page_packet") {
                calls.translate.push(payload);
                return translate(payload, calls.translate.length);
            }
            if (service === "cancel_page_translation") {
                calls.cancel.push(payload);
                return { aborted: 0 };
            }
            return null;
        },
        emit: (service, payload) => {
            if (service === "persistent_segment_save") calls.saves.push(payload);
        },
    };
    const queue = createQueueDouble();
    const controller = createAiPageTranslationSession({
        engine: "openai",
        channel,
        root,
        sourceLanguage,
        targetLanguage,
        providerProfileId: "profile-1",
        title: "Test Page",
        domain: "example.test",
        deps: {
            createPriorityQueue: () => queue,
            createScheduler: (schedulerOptions) => createSchedulerDouble(schedulerOptions),
            ...dependencyOverrides,
        },
        ...options,
    });
    activeControllers.push(controller);
    return { controller, calls, queue, root, channel };
}

async function advance(ms) {
    jest.advanceTimersByTime(ms);
    await flushMicrotasks(60);
}

/** Runs the standard settle sequence: microtasks, idle collection, pending timers. */
async function drainAll() {
    await flushMicrotasks(60);
    await advance(0);
    await advance(300);
    await flushMicrotasks(60);
}

describe("AI page translation vNext session", () => {
    beforeEach(() => {
        jest.useFakeTimers("modern");
    });

    afterEach(() => {
        for (const controller of activeControllers.splice(0)) controller.stop("test-teardown");
        jest.useRealTimers();
        document.body.innerHTML = "";
    });

    it("gates the engine to the three cloud providers", () => {
        expect(SUPPORTED_ENGINES).toEqual(["googleAiStudio", "openai", "openaiCompatible"]);
        expect(() => createAiPageTranslationSession({ engine: "chromeBuiltin" })).toThrow(
            /supports engines/
        );
        expect(() =>
            createAiPageTranslationSession({ engine: "googleAiStudio", channel: {} })
        ).not.toThrow();
    });

    it("finalizes observed capability fields without exceeding the safe combined window", () => {
        const packet = finalizePacket(
            {
                id: "context-packet",
                items: [{ id: "b1", text: "駅", role: "p" }],
                estIn: 500,
                estOut: 200,
            },
            {
                maxInputTokens: { value: 700, source: "provider-metadata" },
                maxOutputTokens: { value: 800, source: "provider-metadata" },
                maxCombinedTokens: { value: 1050, source: "provider-metadata" },
            },
            "googleAiStudio"
        );
        // Generous send ceiling (max(3x est-out, 2048 floor)) capped DOWN to the safe combined
        // remainder floor(1050*0.9) - 500 = 445.
        expect(packet.maxOutputTokens).toBe(445);
        expect(packet.estIn + packet.maxOutputTokens).toBeLessThanOrEqual(945);
    });

    it("terminalizes an impossible planner capability with zero provider calls", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            capabilities: {
                provider: "googleAiStudio",
                apiKeyHash: "k1",
                profileRevision: "r1",
                maxInputTokens: { value: 200, source: "profile-override" },
                maxOutputTokens: { value: 800, source: "profile-override" },
                maxCombinedTokens: { value: 1000, source: "profile-override" },
            },
            // A large but valid session context still fits before calibration. The provider
            // receipt then tightens the EMA enough that even a one-token recovery cannot fit,
            // exercising the post-settle planner guard instead of the normal chunk path.
            options: { engine: "googleAiStudio", title: "T".repeat(1200) },
        });

        const snapshot = await h.controller.start();

        expect(snapshot).toMatchObject({
            phase: "error",
            failure: { kind: "planner-capability" },
            requestCount: 0,
        });
        expect(h.calls.translate).toHaveLength(0);
        expect(h.calls.cancel).toHaveLength(1);
        expect(snapshot.packets).toMatchObject({ queued: 0, inFlight: 0 });

        h.root.appendChild(document.createElement("p")).textContent = "Late SPA content";
        await advance(100);
        expect(h.controller.getStatusSnapshot().phase).toBe("error");
        expect(h.calls.translate).toHaveLength(0);
    });

    it("terminalizes but rethrows an unexpected startup defect", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            dependencyOverrides: {
                collectPage: () => {
                    throw new Error("collector exploded");
                },
            },
        });

        await expect(h.controller.start()).rejects.toThrow("collector exploded");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "error",
            failure: { kind: "session-start", message: "collector exploded" },
            requestCount: 0,
        });
        expect(h.calls.translate).toHaveLength(0);
        expect(h.calls.cancel).toHaveLength(1);
    });

    it("waits at most 150ms for a cold cache, then dispatches the whole document", async () => {
        let firstPrefetch = true;
        const h = makeHarness({
            html: "<div id='main'><p>Viewport one</p><p>Viewport two</p><p>Viewport three</p><p data-below>Below one</p><p data-below>Below two</p></div>",
            persistent: (payload) => {
                if (firstPrefetch && payload.keys.every((key) => key.startsWith("pt3|"))) {
                    firstPrefetch = false;
                    return new Promise(() => undefined); // cold IDB never answers
                }
                return [];
            },
        });
        const startPromise = h.controller.start();
        await flushMicrotasks(60);
        expect(h.calls.translate).toHaveLength(0);
        await advance(149);
        expect(h.calls.translate).toHaveLength(0);
        await advance(1);
        expect(h.calls.translate).toHaveLength(1);
        expect(h.calls.translate[0].units.map((unit) => unit.text)).toEqual([
            "Viewport one",
            "Viewport two",
            "Viewport three",
            "Below one",
            "Below two",
        ]);
        await startPromise;
        await drainAll();
        expect(h.controller.getStatusSnapshot().phase).toBe("complete");
    });

    it("buffers hydration inserted while startup capabilities are still pending", async () => {
        let resolveCapabilities;
        const capabilitiesPending = new Promise((resolve) => {
            resolveCapabilities = resolve;
        });
        const h = makeHarness({
            html: "<div id='main'><p>Initial sentence</p></div>",
            capabilities: () => capabilitiesPending,
        });

        const startPromise = h.controller.start();
        const late = document.createElement("p");
        late.textContent = "Hydrated sentence";
        h.root.appendChild(late);
        await flushMicrotasks(20);
        await advance(75);
        expect(h.calls.translate).toHaveLength(0);

        resolveCapabilities({
            provider: "openai",
            apiKeyHash: "k1",
            profileRevision: "r1",
            maxOutputTokens: 4096,
        });
        await startPromise;
        await drainAll();

        const sent = h.calls.translate.flatMap((payload) => payload.units.map((unit) => unit.text));
        expect(sent.filter((text) => text === "Initial sentence")).toHaveLength(1);
        expect(sent.filter((text) => text === "Hydrated sentence")).toHaveLength(1);
        expect(late.textContent).toBe("번역 Hydrated sentence");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 2,
            failedStrings: 0,
        });
    });

    it("packs a 60-string whole document into balanced small drain requests", async () => {
        const blocks = Array.from(
            { length: 60 },
            (_, index) => `<p>Sentence number ${index + 1}</p>`
        ).join("");
        const h = makeHarness({
            html: `<div id='main'>${blocks}</div>`,
        });
        await h.controller.start();
        await flushMicrotasks(60);
        // Small-packet drain caps (16 blocks/packet) split 60 blocks into four packets that
        // together carry every string exactly once.
        expect(h.calls.translate).toHaveLength(4);
        expect(h.calls.translate.flatMap((call) => call.units)).toHaveLength(60);
        await advance(250);
        expect(h.calls.translate).toHaveLength(4);
        await drainAll();
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(60);
    });

    it("does not add a countTokens round-trip before whole-page dispatch", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>Viewport sentence</p><p data-below>Below sentence one</p><p data-below>Below sentence two</p></div>",
            countTokens: () => ({ tokens: 500, source: "provider" }),
        });
        await h.controller.start();
        await drainAll();
        expect(h.calls.count).toHaveLength(0);
        const order = h.calls.order.filter(
            (service) =>
                service === "count_page_translation_tokens" || service === "translate_page_packet"
        );
        expect(order).toEqual(["translate_page_packet"]);
        expect(h.controller.getStatusSnapshot().phase).toBe("complete");
    });

    it("spends exactly 3 attempts on a persistently schema-invalid single block (stable pin)", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>Only sentence</p></div>",
            translate: () => SCHEMA_FAILURE,
        });
        await h.controller.start();
        await drainAll();
        expect(h.calls.translate).toHaveLength(3);
        expect(h.calls.translate[1].hint).toBe("reinforced-schema"); // reinforced same retry
        expect(h.calls.translate[2].units[0].id.endsWith("@n0")).toBe(true); // per-block atomic
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.incompleteStrings).toBe(1);
        expect(snapshot.failedStrings).toBe(1);
        expect(snapshot.failedRepresentatives).toBe(1);
        expect(snapshot.failedByReason).toEqual({ "schema-invalid": 1 });
        expect(h.root.querySelector("p").textContent).toBe("Only sentence"); // never blanked
    });

    it("reports 33 deduplicated failures as one representative with one bounded reason", async () => {
        const h = makeHarness({
            html: `<div id='main'>${"<p>Repeated source sentence</p>".repeat(33)}</div>`,
            translate: () => SCHEMA_FAILURE,
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(3); // one representative owns the recovery ladder
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            totalStrings: 33,
            translatedStrings: 0,
            failedStrings: 33,
            incompleteStrings: 33,
            failedRepresentatives: 1,
            failedByReason: { "schema-invalid": 33 },
        });
    });

    it("keeps the global attempt ceiling fixed when recovery packets are enqueued", async () => {
        let ceiling = null;
        const h = makeHarness({
            html: "<div id='main'><p>Only sentence</p></div>",
            translate: () => SCHEMA_FAILURE,
            options: {
                deps: {
                    createPriorityQueue: () => createQueueDouble(),
                    createScheduler: (schedulerOptions) => {
                        ceiling = schedulerOptions.maxTotalAttempts;
                        return createSchedulerDouble(schedulerOptions);
                    },
                },
            },
        });
        await h.controller.start();
        await drainAll();
        await drainAll();

        expect(h.calls.translate).toHaveLength(3);
        expect(typeof ceiling).toBe("function");
        expect(ceiling()).toBe(6); // one original work unit; two recovery packets add zero
    });

    it("retries unresolved OpenAI items exactly once with capability-drop-reasoning and normal accounting", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>First source sentence</p><p>Second source sentence</p></div>",
            translate: (payload, callNumber) => {
                if (callNumber !== 1) return defaultTranslate(payload);
                return {
                    ...unsupportedReasoningFailure(),
                    // A validated partial unit must commit once and never be resent by the
                    // capability child packet.
                    units: [goodUnit(payload.units[0])],
                };
            },
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(2);
        expect(h.calls.translate[1].hint).toBe("capability-drop-reasoning");
        expect(h.calls.translate[1].units).toEqual(h.calls.translate[0].units.slice(1));
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(2);
        expect(snapshot.failedStrings).toBe(0);
        expect(snapshot.requestCount).toBe(2);
        expect(snapshot.packets.dispatched).toBe(2);
        expect(snapshot.telemetry.capability_drop_reasoning_retry).toBe(1);
    });

    it("fails loudly when the one capability-drop-reasoning recovery is also unsupported", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: () => unsupportedReasoningFailure(),
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(2);
        expect(h.calls.translate[1].hint).toBe("capability-drop-reasoning");
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("error");
        expect(snapshot.failure.kind).toBe("unsupported-capability");
        expect(snapshot.requestCount).toBe(2);
        expect(snapshot.packets.dispatched).toBe(2);
        expect(snapshot.telemetry.capability_drop_reasoning_retry).toBe(1);
        expect(snapshot.telemetry.unsupported_capability_terminal).toBe(1);
    });

    it("fails loudly without a provider-issued reasoningControl:none capability patch", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: () => unsupportedReasoningFailure({ includePatch: false }),
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(1);
        expect(h.calls.translate[0].hint).toBeUndefined();
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("error");
        expect(snapshot.failure.kind).toBe("unsupported-capability");
        expect(snapshot.requestCount).toBe(1);
        expect(snapshot.packets.dispatched).toBe(1);
        expect(snapshot.telemetry.capability_drop_reasoning_retry).toBeUndefined();
        expect(snapshot.telemetry.unsupported_capability_terminal).toBe(1);
    });

    it("resolves 8 malformed blocks in at most 16 calls (google pin)", async () => {
        const blocks = Array.from(
            { length: 8 },
            (_, index) => `<p>Source sentence number ${index + 1}</p>`
        ).join("");
        const h = makeHarness({
            html: `<div id='main'>${blocks}</div>`,
            translate: (payload) =>
                payload.units.length > 1 ? SCHEMA_FAILURE : defaultTranslate(payload),
        });
        await h.controller.start();
        await drainAll();
        // 1 original + 1 reinforced + 2 bisection halves + 8 per-block atomics = 12.
        expect(h.calls.translate.length).toBe(12);
        expect(h.calls.translate.length).toBeLessThanOrEqual(16);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(8);
        expect(snapshot.failedStrings).toBe(0);
        for (const paragraph of h.root.querySelectorAll("p")) {
            expect(paragraph.textContent.startsWith("번역")).toBe(true);
        }
    });

    it("fails LOUD on a missing API key: exactly 1 request and phase 'error', never 'incomplete'", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: () => ({
                ok: false,
                units: [],
                usageReceipts: [],
                failure: {
                    kind: "auth",
                    message: "OpenAI API key is missing.",
                    retryDirective: "never",
                },
            }),
        });
        await h.controller.start();
        await drainAll();
        expect(h.calls.translate).toHaveLength(1);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("error");
        expect(snapshot.failure.kind).toBe("auth");
        expect(h.calls.cancel.length).toBeGreaterThanOrEqual(1);
    });

    it("allows at most 2 session attempts through the auth circuit", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: () => ({
                ok: false,
                units: [],
                usageReceipts: [],
                failure: { kind: "auth", retryDirective: "never" },
            }),
        });
        await h.controller.start();
        await drainAll();
        expect(h.controller.getStatusSnapshot().phase).toBe("error");
        expect(h.calls.translate).toHaveLength(1);
        await h.controller.start();
        await drainAll();
        expect(h.calls.translate).toHaveLength(2);
        const refused = await h.controller.start();
        await drainAll();
        expect(refused.phase).toBe("error");
        expect(refused.failure.kind).toBe("auth-circuit");
        expect(h.calls.translate).toHaveLength(2); // no third provider request
    });

    it("terminalizes one retry-exhausted transient lineage without opening the page circuit", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: () => ({
                ok: false,
                units: [],
                usageReceipts: [],
                failure: { kind: "transient", retryDirective: "same-units" },
            }),
            dependencyOverrides: { createScheduler: createRuntimeScheduler },
        });
        await h.controller.start();
        await flushMicrotasks(60);
        // Production backoff adds up to 20% jitter; advance through each upper bound.
        await advance(600);
        await advance(1200);
        await advance(2400);
        await drainAll();

        expect(h.calls.translate).toHaveLength(4);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot).toMatchObject({
            phase: "complete",
            failure: null,
            failedStrings: 1,
            failedRepresentatives: 1,
            failedByReason: { "transport-exhausted": 1 },
            incompleteStrings: 1,
        });
    });

    it("terminalizes an active provider cancellation instead of hanging pending work", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: () => ({
                ok: false,
                units: [],
                usageReceipts: [],
                actualAttemptCount: 1,
                failure: {
                    kind: "cancelled",
                    message: "provider cancelled the generation",
                    retryDirective: "never",
                    requestMayHaveExecuted: true,
                },
            }),
        });

        await h.controller.start();
        await drainAll();

        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.failedStrings).toBe(1);
        expect(snapshot.incompleteStrings).toBe(1);
        expect(snapshot.packets.queued).toBe(0);
        expect(snapshot.packets.inFlight).toBe(0);
    });

    it("splits an oversized block into chunks and reassembles onto the SAME Text node", async () => {
        const longText = "word ".repeat(3000).trim();
        const h = makeHarness({ html: `<div id='main'><p>${longText}</p></div>` });
        const node = h.root.querySelector("p").firstChild;
        await h.controller.start();
        await drainAll();
        expect(h.calls.translate.length).toBe(7); // seven chunk packets under the small drain caps
        expect(h.calls.translate[0].units[0].id).toMatch(/#c\d+$/);
        expect(h.root.querySelector("p").firstChild).toBe(node); // Text-node identity preserved
        expect(node.data.startsWith("번역")).toBe(true);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(1);
    });

    it("re-packs a 19,500-character recovery through the context-aware chunk builder", () => {
        const text = "駅".repeat(19_500);
        const entry = {
            id: "b1",
            text,
            role: "p",
            order: 0,
            target: { revision: 0 },
        };
        const capabilities = {
            provider: "openai",
            maxInputTokens: { value: 8192, source: "provider-metadata" },
            maxOutputTokens: { value: 4096, source: "provider-metadata" },
            maxCombinedTokens: { value: 12_288, source: "provider-metadata" },
        };
        const chunkGroups = new Map();
        let sequence = 0;

        const packets = buildRecoveryPackets({
            items: [{ id: entry.id, text, role: entry.role, entry }],
            meta: { stage: "semantic", depth: 1, hint: "reinforced-semantic" },
            provider: "openai",
            estimator: createEstimator({ sl: "ja", tl: "ko", provider: "openai" }),
            ctxTokens: 100,
            capabilities,
            chunkGroups,
            nextId: () => `recovery-${++sequence}`,
        });

        expect(packets.length).toBeGreaterThan(1);
        expect(packets.flatMap((packet) => packet.items)).toHaveLength(
            chunkGroups.get(entry.id).expected
        );
        expect(packets.flatMap((packet) => packet.items).every((item) => item.chunk)).toBe(true);
        for (const packet of packets) {
            expect(packet.estIn).toBeLessThanOrEqual(Math.floor(8192 * 0.9));
            expect(packet.estIn + packet.maxOutputTokens).toBeLessThanOrEqual(
                Math.floor(12_288 * 0.9)
            );
        }
    });

    it("never nests recovery chunks inside an existing chunk", () => {
        const text = "駅".repeat(300);
        const entry = {
            id: "b1",
            text,
            role: "p",
            order: 0,
            initialChunkCount: 3,
            target: { revision: 0 },
        };
        const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
        estimator.applyPreflightCalibration(3, 1);
        const capabilities = {
            provider: "googleAiStudio",
            maxInputTokens: { value: 900, source: "provider-metadata" },
            maxOutputTokens: { value: 800, source: "provider-metadata" },
            maxCombinedTokens: { value: 1400, source: "provider-metadata" },
        };
        const chunkGroups = new Map();

        expect(() =>
            buildRecoveryPackets({
                items: [
                    {
                        id: "b1#c1",
                        text,
                        role: entry.role,
                        entry,
                        chunk: { parentId: entry.id, chunkIndex: 0, chunkCount: 3 },
                    },
                ],
                meta: { stage: "schema", depth: 1, hint: "reinforced-schema" },
                provider: "googleAiStudio",
                estimator,
                ctxTokens: 0,
                capabilities,
                chunkGroups,
                nextId: () => "recovery-1",
            })
        ).toThrow(/Indivisible recovery item/);
        expect(chunkGroups.size).toBe(0);
    });

    it("terminalizes pathological recovery fragmentation after receipt EMA calibration", async () => {
        const source = "回復パケットの上限を検証するための十分に長い日本語の原文です。";
        const h = makeHarness({
            html: `<div id="main"><p>${source}</p></div>`,
            sourceLanguage: "ja",
            targetLanguage: "ko",
            capabilities: {
                provider: "googleAiStudio",
                apiKeyHash: "k1",
                profileRevision: "r1",
                maxInputTokens: { value: 900, source: "provider-metadata" },
                maxOutputTokens: { value: 800, source: "provider-metadata" },
                maxCombinedTokens: { value: 1400, source: "provider-metadata" },
            },
            options: { engine: "googleAiStudio" },
            translate: (payload) => ({
                ok: true,
                // An empty reply hard-fails the (length-independent) `empty` tier and forces
                // semantic recovery after settleUsage calibrates the estimator from this
                // deliberately high provider receipt; the short source keeps the input EMA ratio
                // high, so the re-pack cannot fit and fragments past the amplification bound.
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: "",
                })),
                usageReceipts: [
                    {
                        billingEventId: "ema-context-limit-1",
                        inputTokens: { value: 900, source: "provider-reported" },
                        outputTokens: { value: 20, source: "provider-reported" },
                        reasoningRelation: "included-in-output",
                    },
                ],
                actualAttemptCount: 1,
            }),
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(1);
        expect(h.root.querySelector("p").textContent).toBe(source);
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 0,
            failedStrings: 1,
            incompleteStrings: 1,
            failedRepresentatives: 1,
            failedByReason: { "context-limit": 1 },
            telemetry: {
                recovery_plan_amplification: 1,
                recovery_plan_context_limit: 1,
            },
        });
    });

    it("atomically degrades a long inline wrapper so every provider chunk stays balanced", async () => {
        const longAnchorText = "very long linked sentence ".repeat(700);
        const h = makeHarness({
            html: `<div id='main'><p>Before <a href='/kept'>${longAnchorText}</a> after</p></div>`,
            capabilities: {
                provider: "openai",
                apiKeyHash: "k1",
                profileRevision: "r1",
                maxOutputTokens: 1024,
            },
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: "번역문".repeat(Math.max(1, Math.ceil(unit.text.length / 3))),
                })),
                usageReceipts: [],
                actualAttemptCount: 1,
            }),
        });
        const anchor = h.root.querySelector("a");

        await h.controller.start();
        await drainAll();

        const sentUnits = h.calls.translate.flatMap((payload) => payload.units);
        expect(sentUnits.length).toBeGreaterThan(1);
        expect(sentUnits.every((unit) => placeholderTagsBalanced(unit.text))).toBe(true);
        expect(sentUnits.every((unit) => !/<\/?g\d+>/.test(unit.text))).toBe(true);
        expect(h.root.querySelector("a")).toBe(anchor);
        expect(anchor.getAttribute("href")).toBe("/kept");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
    });

    it("keeps the 5,282-inline production session within 106 balanced provider requests", async () => {
        const targetCount = 5282;
        const h = makeHarness({
            html: `<main id="main">${Array.from(
                { length: targetCount },
                (_, index) => `<span>駅路線案内 ${index + 1}</span>`
            ).join("")}</main>`,
            sourceLanguage: "ja",
            targetLanguage: "ko",
            capabilities: {
                provider: "googleAiStudio",
                apiKeyHash: "k1",
                profileRevision: "r1",
                maxOutputTokens: 8000,
            },
            options: { engine: "googleAiStudio" },
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: unit.text.replace(/駅路線案内/g, "역 노선 안내"),
                })),
                usageReceipts: [],
                actualAttemptCount: 1,
            }),
        });
        const spans = h.root.querySelectorAll("span");
        const firstSpan = spans[0];
        const lastSpan = spans[targetCount - 1];

        await h.controller.start();
        await drainAll();

        const sentUnits = h.calls.translate.flatMap((payload) => payload.units);
        expect(h.calls.translate.length).toBeGreaterThan(1);
        // Small-packet drain caps + ja-ko outRatio (1.9) split this pathological 5,282-inline
        // leaf into exactly 96 packets (drain est-out 1000, ja-ko outRatio 1.9).
        expect(h.calls.translate.length).toBe(96);
        expect(sentUnits.every((unit) => placeholderTagsBalanced(unit.text))).toBe(true);
        expect(sentUnits.some((unit) => /<g\d+>/.test(unit.text))).toBe(true);
        expect(sentUnits.every((unit) => !unit.id.includes("@n"))).toBe(true);
        expect(h.root.querySelectorAll("span")[0]).toBe(firstSpan);
        expect(h.root.querySelectorAll("span")[targetCount - 1]).toBe(lastSpan);
        expect(firstSpan.textContent).toBe("역 노선 안내 1");
        expect(lastSpan.textContent).toBe(`역 노선 안내 ${targetCount}`);
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
    });

    it("keeps oversized-block reassembly all-or-nothing: a missing chunk leaves the source untouched", async () => {
        const longText = "word ".repeat(3000).trim();
        const h = makeHarness({
            html: `<div id='main'><p>${longText}</p></div>`,
            translate: (payload) => ({
                ok: true,
                units: payload.units.filter((unit) => !unit.id.includes("#c2")).map(goodUnit),
                usageReceipts: [],
            }),
        });
        const node = h.root.querySelector("p").firstChild;
        await h.controller.start();
        await drainAll();
        // seven chunk packets + one reinforced retry of the single missing chunk; chunk
        // fragments are indivisible so the ladder then terminates.
        expect(h.calls.translate.length).toBe(8);
        expect(node.data).toBe(longText); // nothing partial ever reached the DOM
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.incompleteStrings).toBe(1);
    });

    it("never double-bills a delivery-unknown replay (ledger billingEventId integration)", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: (payload, callNumber) =>
                callNumber === 1
                    ? {
                          ok: false,
                          units: [],
                          usageReceipts: [{ billingEventId: "b1", totalTokens: 100 }],
                          failure: {
                              kind: "delivery-unknown",
                              requestMayHaveExecuted: true,
                              retryDirective: "same-units",
                          },
                      }
                    : {
                          ok: true,
                          units: payload.units.map(goodUnit),
                          // worst case: the replay arrives with usage NOT stripped
                          usageReceipts: [{ billingEventId: "b1", totalTokens: 100 }],
                      },
        });
        await h.controller.start();
        await drainAll();
        expect(h.calls.translate).toHaveLength(2); // exactly 1 idempotent replay
        expect(h.calls.translate[1].payloadHash).toBe(h.calls.translate[0].payloadHash);
        expect(h.calls.translate[1].packetId).toBe(h.calls.translate[0].packetId);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.tokens.settled).toBe(100); // charged exactly once
        expect(snapshot.requestCount).toBe(1);
        expect(snapshot.translatedStrings).toBe(1);
    });

    it("accounts one estimated request when the owner response is lost before a cached replay", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>One source sentence</p></div>",
            translate: (payload, callNumber) => {
                if (callNumber === 1) throw new Error("content channel response lost");
                return {
                    ok: true,
                    units: payload.units.map(goodUnit),
                    usageReceipts: [],
                    actualAttemptCount: 0,
                    costAttribution: "reused",
                };
            },
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(2);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.requestCount).toBe(1);
        expect(snapshot.tokens.settled).toBe(0);
        expect(snapshot.tokens.estimated).toBeGreaterThan(0);
        expect(snapshot.translatedStrings).toBe(1);
    });

    it("warn+accepts a reformatted number and never leaks source details into telemetry keys", async () => {
        // Plain numbers are NOT masked (the validator normalizes them), and a dropped year is now
        // a WARN+ACCEPT (warn_accept_number), not a hard-fail: the string is translated with no
        // paid retry and no failed count. Letter-led identifiers like "KH01" are local `<kN/>`
        // data (ACCEPT path covered in aiPageTranslationProtectedTokens.test.js).
        const h = makeHarness({
            html: "<div id='main'><p>京阪線は西暦2025年について十分に長い案内文章を提供します</p></div>",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    // Drops the year 2025; accepted with a warning rather than kept as source.
                    translatedText: "게이한선에 대한 충분히 긴 한국어 안내문을 제공합니다",
                })),
                usageReceipts: [],
            }),
        });

        await h.controller.start();
        await drainAll();

        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.failedStrings).toBe(0);
        expect(snapshot.translatedStrings).toBe(1);
        expect(snapshot.telemetry.warn_accept_number).toBe(1);
        expect(snapshot.telemetry.validation_fail_number).toBeUndefined();
        expect(snapshot.telemetry.validation_fail_identifier).toBeUndefined();
        // The dropped value (2025) is a warning DETAIL, never a telemetry key.
        expect(Object.keys(snapshot.telemetry).some((key) => key.includes("2025"))).toBe(false);
    });

    it("counts and conservatively estimates a provider request when usage is omitted", async () => {
        const h = makeHarness({ html: "<div id='main'><p>One source sentence</p></div>" });
        await h.controller.start();
        await drainAll();

        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.requestCount).toBe(1);
        expect(snapshot.tokens.settled).toBe(0);
        expect(snapshot.tokens.estimated).toBeGreaterThan(0);
    });

    it("serves a fully cached page with ZERO provider requests", async () => {
        const sources = ["First cached sentence", "Second cached sentence"];
        const values = new Map();
        for (const source of sources) {
            const identity = cacheIdentity(
                { source, role: "p" },
                { sourceLanguage: "en", targetLanguage: "ko" }
            );
            values.set(identity.key, {
                v: 3,
                k: identity.normalizedKey,
                t: `캐시 ${source}`,
                model: "m",
                promptVersion: "pt3-1",
                qualityTier: 1,
                ts: Date.now(),
            });
        }
        const h = makeHarness({
            html: `<div id='main'><p>${sources[0]}</p><p>${sources[1]}</p></div>`,
            persistent: ({ keys }) =>
                keys
                    .map((key) => (values.has(key) ? { key, value: values.get(key) } : null))
                    .filter(Boolean),
        });
        await h.controller.start();
        await drainAll();
        expect(h.calls.translate).toHaveLength(0);
        expect(h.calls.count).toHaveLength(0);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(2);
        expect(h.root.querySelectorAll("p")[0].textContent).toBe(`캐시 ${sources[0]}`);
    });

    it("never fans a revised representative's translation onto aliases still showing the old text", async () => {
        let mutated = false;
        const h = makeHarness({
            html: "<div id='main'><p id='a'>Same sentence</p><p id='b'>Same sentence</p></div>",
            translate: (payload) => {
                if (!mutated) {
                    mutated = true;
                    // SPA rewrites the representative's Text node while its packet is in
                    // flight (after the watcher armed): the late reply goes stale cleanly
                    // and the mutation path owns the re-plan.
                    Promise.resolve().then(() => {
                        document.getElementById("a").firstChild.data = "Changed sentence";
                    });
                    return new Promise((resolve) =>
                        setTimeout(() => resolve(defaultTranslate(payload)), 20)
                    );
                }
                return defaultTranslate(payload);
            },
        });
        await h.controller.start();
        await drainAll();
        await advance(75); // watcher coalesce -> revision bump -> re-plan
        await drainAll();
        // The revised entry translates its NEW text; the alias keeps its own (old) text and
        // is re-planned independently — never painted with the other block's translation.
        expect(document.getElementById("a").textContent).toBe("번역 Changed sentence");
        expect(document.getElementById("b").textContent).toBe("번역 Same sentence");
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(2);
    });

    it("ignores late chunk successes from an older SPA revision", async () => {
        // Sized so the oversized block splits into three chunk packets: more than one (so the
        // late-settling revision genuinely races in-flight chunks) but within the scheduler
        // double's four in-flight slots, so every wave drains in the single-shot settles below.
        const oldSource = "OLD railway sentence ".repeat(240).trim();
        const newSource = "NEW railway sentence ".repeat(240).trim();
        const pending = { old: [], current: [] };
        const h = makeHarness({
            html: `<div id="main"><p id="source">${oldSource}</p></div>`,
            translate: (payload) => {
                const bucket = payload.units.every((unit) => unit.text.includes("OLD"))
                    ? pending.old
                    : pending.current;
                return new Promise((resolve) => {
                    bucket.push(() => resolve(defaultTranslate(payload)));
                });
            },
        });

        await h.controller.start();
        await flushMicrotasks(80);
        expect(pending.old.length).toBeGreaterThan(1);

        const node = document.getElementById("source").firstChild;
        node.data = newSource;
        await flushMicrotasks(40); // deliver MutationObserver before advancing its coalesce timer
        await advance(75);
        await flushMicrotasks(100);
        const queuedCurrentPackets = h.queue.pushes.filter(({ packet }) =>
            packet.items.every((item) => item.text.includes("NEW"))
        );
        expect(queuedCurrentPackets.length).toBeGreaterThan(1);

        for (const settle of pending.old) settle();
        await flushMicrotasks(100);
        expect(node.data).toBe(newSource);
        expect(pending.current.length).toBeGreaterThan(1);

        for (const settle of pending.current) settle();
        await drainAll();
        expect(node.data.startsWith("번역 NEW railway sentence")).toBe(true);
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
    });

    it("does not recover a late packet failure with source from an older SPA revision", async () => {
        // Three chunk packets stay within the scheduler double's four in-flight slots, so no stale
        // old chunk lingers in the queue to be dispatched after the revision changes.
        const oldSource = "OLD framework sentence ".repeat(240).trim();
        const oldFailures = [];
        const h = makeHarness({
            html: `<div id="main"><p id="source">${oldSource}</p></div>`,
            translate: (payload) => {
                if (payload.units.every((unit) => unit.text.includes("OLD"))) {
                    return new Promise((resolve) => {
                        oldFailures.push(() => resolve(SCHEMA_FAILURE));
                    });
                }
                return defaultTranslate(payload);
            },
        });

        await h.controller.start();
        await flushMicrotasks(80);
        expect(oldFailures.length).toBeGreaterThan(1);

        const node = document.getElementById("source").firstChild;
        node.data = "Fresh framework sentence.";
        await flushMicrotasks(40); // deliver MutationObserver before advancing its coalesce timer
        await advance(75);
        await flushMicrotasks(100);

        for (const settle of oldFailures) settle();
        await drainAll();
        expect(h.calls.translate.filter((payload) => payload.hint)).toHaveLength(0);
        expect(node.data).toBe("번역 Fresh framework sentence.");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
    });

    it("recollects immediately after a CAS miss and cannot report complete with a pending entry", async () => {
        let mutated = false;
        const h = makeHarness({
            html: "<div id='main'><p id='source'>Original framework text</p></div>",
            translate: (payload) => {
                if (!mutated) {
                    mutated = true;
                    document.getElementById("source").firstChild.data = "Framework replacement";
                }
                return defaultTranslate(payload);
            },
        });
        await h.controller.start();
        await flushMicrotasks(80);

        // Immediate session-owned recollection starts the second request before the watcher's
        // 75ms coalescing timer is needed.
        expect(h.calls.translate).toHaveLength(2);
        await drainAll();
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(1);
        expect(document.getElementById("source").textContent).toBe("번역 Framework replacement");
    });

    it("never leaves an earlier inline node partially translated when a sibling loses CAS", async () => {
        let retrySawUntouchedSibling = false;
        const h = makeHarness({
            html: "<div id='main'><p id='source'>Stable <strong>volatile</strong></p></div>",
            translate: (payload, callNumber) => {
                const paragraph = document.getElementById("source");
                if (callNumber === 1) {
                    paragraph.querySelector("strong").firstChild.data = "Framework replacement";
                    return {
                        ok: true,
                        units: [
                            {
                                id: payload.units[0].id,
                                status: "translated",
                                translatedText: "안정 <g1>변동</g1>",
                            },
                        ],
                        usageReceipts: [],
                    };
                }
                retrySawUntouchedSibling = paragraph.firstChild.data === "Stable ";
                return defaultTranslate(payload);
            },
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(2);
        expect(retrySawUntouchedSibling).toBe(true);
        expect(document.getElementById("source").textContent).toBe(
            "번역 Stable Framework replacement"
        );
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
    });

    it("sends an inline block exactly once in the single initial pass", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>Read <a href='/notes'>notes</a> now</p></div>",
        });
        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(1);
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
    });

    it("round-trips leading punctuation around an inline link without a false inventory recovery", async () => {
        const h = makeHarness({
            html: "<div id='main'><p id='line'>（<a>対象</a>）説明</p></div>",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: unit.text.replace("対象", "대상").replace("説明", "설명"),
                })),
                usageReceipts: [],
            }),
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(1);
        expect(h.calls.translate[0].hint).toBeUndefined();
        expect(document.getElementById("line").textContent).toBe("（대상）설명");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
    });

    it("translates comment-split inline text in one request without a false order recovery", async () => {
        const h = makeHarness({
            html: "<div id='main'><p id='line'>前<!-- framework marker -->中間<a>リンク</a>後</p></div>",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: unit.text
                        .replace("前", "앞")
                        .replace("中間", " 중간 ")
                        .replace("リンク", "링크")
                        .replace("後", " 뒤"),
                })),
                usageReceipts: [],
            }),
        });

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(1);
        expect(h.calls.translate[0].units[0].text).toBe("前<v1/>中間<g2>リンク</g2>後");
        expect(h.calls.translate[0].hint).toBeUndefined();
        expect(document.getElementById("line").textContent).toBe("앞 중간 링크 뒤");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
        });
        expect(h.controller.getStatusSnapshot().telemetry.inline_order_unrepresentable).toBeFalsy();
    });

    it("flattens an unrepresentable styling-only reorder into a bare outer Text node", async () => {
        const h = makeHarness({
            html: "<div id='main'><p id='sentence'><strong>京阪</strong>を私は利用する</p></div>",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: "나는 <g1>게이한</g1>을 이용한다",
                })),
                usageReceipts: [],
                costAttribution: "owner",
            }),
        });
        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(2); // reinforced once, then local flatten
        const sentence = document.getElementById("sentence");
        expect(sentence.textContent).toBe("나는 게이한을 이용한다");
        expect(sentence.querySelector("strong").textContent).toBe("");
        expect(sentence.lastChild.data).toBe("나는 게이한을 이용한다");
        expect(h.controller.getStatusSnapshot().telemetry).toMatchObject({
            inline_order_unrepresentable: 2,
            inline_order_flattened: 1,
        });
    });

    it("keeps target-introduced spaces around a movable inline wrapper", async () => {
        const h = makeHarness({
            html: "<div id='main'><p id='sentence'>私は<strong>京阪電気鉄道</strong>を利用する</p></div>",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: "나는 매일 <g1>게이한 전기철도</g1>를 이용한다",
                })),
                usageReceipts: [],
                costAttribution: "owner",
            }),
        });
        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(1);
        expect(document.getElementById("sentence").textContent).toBe(
            "나는 매일 게이한 전기철도를 이용한다"
        );
        expect(document.getElementById("sentence").firstChild.data).toBe("나는 매일 ");
    });

    it("retries an interactive reorder with fixed placeholder order and preserves the link", async () => {
        const anchorHtml = "<a href='/line'>京阪</a>を私は利用する";
        const h = makeHarness({
            html: `<div id='main'><p id='sentence'>${anchorHtml}</p></div>`,
            sourceLanguage: "ja",
            targetLanguage: "ko",
            translate: (payload, callNumber) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText:
                        callNumber === 1
                            ? "나는 <g1>게이한</g1>을 이용한다"
                            : "<g1>게이한</g1>을 나는 이용한다",
                })),
                usageReceipts: [],
                costAttribution: "owner",
            }),
        });
        const anchor = document.querySelector("#sentence a");

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(2);
        expect(h.calls.translate[1].hint).toBe("reinforced-order");
        expect(document.querySelector("#sentence a")).toBe(anchor);
        expect(anchor.textContent).toBe("게이한");
        expect(document.getElementById("sentence").textContent).toBe("게이한을 나는 이용한다");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
            incompleteStrings: 0,
            telemetry: {
                inline_order_unrepresentable: 1,
                inline_order_constrained_retry: 1,
            },
        });
    });

    it("atomically translates persistent interactive reorders instead of failing the string", async () => {
        const h = makeHarness({
            html: "<div id='main'><p id='sentence'><a href='/line'>京阪</a>を私は利用する</p></div>",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: unit.id.includes("@n")
                        ? unit.text === "京阪"
                            ? "게이한"
                            : "을 나는 이용한다"
                        : "나는 <g1>게이한</g1>을 이용한다",
                })),
                usageReceipts: [],
                costAttribution: "owner",
            }),
        });
        const anchor = document.querySelector("#sentence a");

        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(3);
        expect(h.calls.translate.map((payload) => payload.hint)).toEqual([
            undefined,
            "reinforced-order",
            "reinforced-atomic",
        ]);
        expect(h.calls.translate[2].units.every((unit) => unit.id.includes("@n"))).toBe(true);
        expect(document.querySelector("#sentence a")).toBe(anchor);
        expect(anchor.textContent).toBe("게이한");
        expect(document.getElementById("sentence").textContent).toBe("게이한을 나는 이용한다");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
            incompleteStrings: 0,
            telemetry: {
                inline_order_unrepresentable: 2,
                inline_order_constrained_retry: 1,
                placeholder_atomic_degrade: 1,
            },
        });
    });

    it("re-opens the same drain tier for content added after completion", async () => {
        const h = makeHarness({ html: "<div id='main'><p>Initial sentence</p></div>" });
        await h.controller.start();
        await drainAll();
        expect(h.controller.getStatusSnapshot().phase).toBe("complete");
        h.root.insertAdjacentHTML("beforeend", "<p>Late added sentence</p>");
        await flushMicrotasks(30); // MutationObserver delivery
        await advance(75); // watcher coalesce window
        await drainAll();
        expect(h.queue.pushes[h.queue.pushes.length - 1].tier).toBe(1);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.phase).toBe("complete");
        expect(snapshot.translatedStrings).toBe(2);
        expect(h.root.querySelectorAll("p")[1].textContent.startsWith("번역")).toBe(true);
    });

    it("reconciles an incomplete string when a later SPA revision succeeds", async () => {
        let rejectTranslation = true;
        const source =
            "翻訳に失敗した元の日本語の文章を後から更新して正しく反映されることを確認するための十分に長いテスト文章です。";
        const h = makeHarness({
            html: `<div id="main"><p id="source">${source}</p></div>`,
            sourceLanguage: "ja",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    // First revision returns wrong-language (zero target script) text that
                    // hard-fails the script tier; the later revision translates properly.
                    translatedText: rejectTranslation
                        ? "対象言語に翻訳されず日本語のまま残ってしまった十分に長い失敗応答の文章です。"
                        : `번역 ${unit.text}`,
                })),
                usageReceipts: [],
                actualAttemptCount: 1,
            }),
        });

        await h.controller.start();
        await drainAll();
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 0,
            failedStrings: 1,
            incompleteStrings: 1,
        });

        rejectTranslation = false;
        const node = document.getElementById("source").firstChild;
        node.data = "更新後には正しく翻訳できる文章です。";
        await flushMicrotasks(40);
        await advance(75);
        await drainAll();

        expect(node.data).toBe("번역 更新後には正しく翻訳できる文章です。");
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            translatedStrings: 1,
            failedStrings: 0,
            incompleteStrings: 0,
        });
    });

    it("aborts loudly when the runaway latch fires", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>Tiny sentence</p></div>",
            translate: (payload, callNumber) => ({
                ok: false,
                units: [],
                usageReceipts: [{ billingEventId: `b${callNumber}`, totalTokens: 6000 }],
                failure: { kind: "transient", retryDirective: "same-units" },
            }),
        });
        await h.controller.start();
        await drainAll();
        // The 3rd settled receipt calibrates the projection and trips the 2.5x latch, so
        // the transport-retry budget (which would allow a 4th attempt) is never spent.
        expect(h.calls.translate).toHaveLength(3);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.runawayLatched).toBe(true);
        expect(snapshot.phase).toBe("incomplete");
        expect(snapshot.failure.kind).toBe("runaway-latch");
        expect(snapshot.incompleteStrings).toBe(1);
    });

    it("accepts '=' keep-source (verified or warn-accepted) and never persists sentinel hits", async () => {
        const h = makeHarness({
            html: "<div id='main'><p>ACME X100 PRO</p><p>スーパーで買い物をします。</p></div>",
            sourceLanguage: "ja",
            translate: (payload) => ({
                ok: true,
                units: payload.units.map((unit) => ({
                    id: unit.id,
                    status: "translated",
                    translatedText: unit.text,
                    keepSource: true,
                })),
                usageReceipts: [],
            }),
        });
        await h.controller.start();
        await drainAll();
        // Latin-heavy brand string: '=' confirmed already-target-eligible, clean accept. Japanese
        // prose: '=' cannot be positively confirmed, but a '=' item displays source regardless, so
        // it is warn+accepted (warn_accept_echo) — no paid retry, no failed count.
        expect(h.calls.translate).toHaveLength(1);
        const snapshot = h.controller.getStatusSnapshot();
        expect(snapshot.translatedStrings).toBe(2);
        expect(snapshot.incompleteStrings).toBe(0);
        expect(snapshot.failedStrings).toBe(0);
        expect(snapshot.telemetry.warn_accept_echo).toBe(1);
        const paragraphs = h.root.querySelectorAll("p");
        expect(paragraphs[0].textContent).toBe("ACME X100 PRO");
        expect(paragraphs[1].textContent).toBe("スーパーで買い物をします。");
        expect(h.calls.saves).toHaveLength(0); // '=' resolutions are session-only
    });

    it("keeps the session ctx byte-identical across every packet", async () => {
        const paragraphs = Array.from(
            { length: 18 },
            (_, index) =>
                `<p>テストデータを使う長い説明文です。項目${
                    index + 1
                }の結果と詳細を確認します。</p>`
        ).join("");
        const h = makeHarness({
            html: `<div id='main'>${paragraphs}</div>`,
            sourceLanguage: "ja",
            capabilities: {
                provider: "openai",
                apiKeyHash: "k1",
                profileRevision: "r1",
                maxOutputTokens: 256,
            },
        });
        await h.controller.start();
        await drainAll();
        expect(h.calls.translate.length).toBeGreaterThanOrEqual(2);
        const serialized = h.calls.translate.map((payload) => JSON.stringify(payload.ctx));
        expect(new Set(serialized).size).toBe(1); // serialize each, compare — one value
        expect(h.calls.translate[0].ctx.title).toBe("Test Page");
        expect(h.calls.translate[0].ctx.domain).toBe("example.test");
        expect(h.calls.translate[0].ctx.gloss).toEqual(expect.arrayContaining([["テストデータ"]]));
        expect(h.controller.getStatusSnapshot().phase).toBe("complete");
    });

    it("uses whole-document candidates to seed terminology context", async () => {
        const h = makeHarness({
            html: [
                "<div id='main'>",
                "<p>Visible introduction</p>",
                "<p data-below>Keihan Railway first mention</p>",
                "<p data-below>Keihan Railway second mention</p>",
                "<p data-below>Keihan Railway third mention</p>",
                "</div>",
            ].join(""),
        });
        await h.controller.start();
        await flushMicrotasks(60);

        expect(h.calls.translate).toHaveLength(1);
        expect(h.calls.translate[0].units.map((unit) => unit.text)).toEqual([
            "Visible introduction",
            "Keihan Railway first mention",
            "Keihan Railway second mention",
            "Keihan Railway third mention",
        ]);
        expect(h.calls.translate[0].ctx.gloss).toContainEqual(["Keihan Railway"]);
        await drainAll();
    });

    it("skips high-confidence target-language text but keeps mixed source prose eligible", async () => {
        const h = makeHarness({
            html: [
                "<div id='main'>",
                "<p id='already'>이미 한국어로 작성된 문장입니다.</p>",
                "<p id='mixed'>한국어 안내와 日本語原文を翻訳します</p>",
                "</div>",
            ].join(""),
            sourceLanguage: "ja",
            targetLanguage: "ko",
        });
        await h.controller.start();
        await drainAll();

        expect(h.calls.translate).toHaveLength(1);
        expect(h.calls.translate[0].units.map((unit) => unit.text)).toEqual([
            "한국어 안내와 日本語原文を翻訳します",
        ]);
        expect(document.getElementById("already").textContent).toBe(
            "이미 한국어로 작성된 문장입니다."
        );
        expect(document.getElementById("mixed").textContent).toBe(
            "번역 한국어 안내와 日本語原文を翻訳します"
        );
        expect(h.controller.getStatusSnapshot()).toMatchObject({
            phase: "complete",
            totalStrings: 1,
            translatedStrings: 1,
        });
    });
});
