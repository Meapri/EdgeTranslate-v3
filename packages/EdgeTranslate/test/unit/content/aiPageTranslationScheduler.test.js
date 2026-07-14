import { createPriorityQueue } from "../../../src/content/ai_page_translation/runtime/priority_queue.js";
import {
    buildRetryTable,
    createScheduler,
} from "../../../src/content/ai_page_translation/runtime/scheduler.js";

const flush = async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

function createClock() {
    let currentTime = 0;
    let nextId = 1;
    const timers = new Map();
    const scheduledDelays = [];
    return {
        now: () => currentTime,
        setTimeoutFn: (fn, delay) => {
            const id = nextId;
            nextId += 1;
            scheduledDelays.push(Number(delay) || 0);
            timers.set(id, { at: currentTime + Math.max(0, Number(delay) || 0), fn });
            return id;
        },
        clearTimeoutFn: (id) => {
            timers.delete(id);
        },
        scheduledDelays,
        async advance(ms) {
            const target = currentTime + ms;
            for (;;) {
                let earliest = null;
                for (const [id, timer] of timers) {
                    if (timer.at <= target && (!earliest || timer.at < earliest.timer.at)) {
                        earliest = { id, timer };
                    }
                }
                if (!earliest) break;
                timers.delete(earliest.id);
                currentTime = Math.max(currentTime, earliest.timer.at);
                earliest.timer.fn();
                await flush();
            }
            currentTime = target;
        },
    };
}

function makePacket(id, extra = {}) {
    return { id, items: [{ id: `${id}-t` }], itemCount: 1, ...extra };
}

function createHarness(overrides = {}) {
    const clock = createClock();
    const queue = createPriorityQueue();
    const pending = [];
    const dispatch = jest.fn(
        (packet, meta) =>
            new Promise((resolve) => {
                pending.push({ packet, meta, resolve });
            })
    );
    const settled = [];
    const onSettled = jest.fn((packet, outcome) => settled.push({ packet, outcome }));
    const onCircuitOpen = jest.fn();
    const scheduler = createScheduler({
        limiterKey: "openai:key1",
        provider: "openai",
        dispatch,
        onSettled,
        onCircuitOpen,
        queue,
        now: clock.now,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        random: () => 0,
        ...overrides,
    });
    const push = (packets, tier = 2) => {
        for (const packet of packets) queue.push(packet, tier);
        scheduler.notifyEnqueued();
    };
    const resolveNext = async (outcome) => {
        const entry = pending.shift();
        entry.resolve(outcome?.ok === true ? { resolvedCount: 1, ...outcome } : outcome);
        await flush();
        return entry;
    };
    const resolveWhere = async (predicate, outcome) => {
        const index = pending.findIndex(predicate);
        const [entry] = pending.splice(index, 1);
        entry.resolve(outcome?.ok === true ? { resolvedCount: 1, ...outcome } : outcome);
        await flush();
        return entry;
    };
    return {
        clock,
        queue,
        pending,
        dispatch,
        settled,
        onSettled,
        onCircuitOpen,
        scheduler,
        push,
        resolveNext,
        resolveWhere,
    };
}

const rateLimit = (extra = {}) => ({
    ok: false,
    failure: { kind: "rate-limit", retryDirective: "same-units", httpStatus: 429, ...extra },
});
const transient = (extra = {}) => ({
    ok: false,
    failure: { kind: "transient", retryDirective: "same-units", httpStatus: 500, ...extra },
});

describe("vNext AI page translation scheduler (spec §2.3 + §7)", () => {
    describe("continuous slot pump — no wave barriers", () => {
        it("fills every AIMD slot immediately and starts the next packet the moment one settles", async () => {
            // Pins the slot-pump mechanic (start 3, +1 per clean) independent of provider tuning.
            const h = createHarness({ aimd: { start: 3, floor: 1, cap: 8, additivePerClean: 1 } });
            h.push(Array.from({ length: 40 }, (_, i) => makePacket(`p${i}`)));
            await flush();

            expect(h.dispatch).toHaveBeenCalledTimes(3);
            expect(h.pending).toHaveLength(3);
            expect(h.scheduler.inFlightCount()).toBe(3);

            // One settle -> the next dispatch starts immediately, while the other two are
            // still in flight. The clean completion also opens one new AIMD slot, so the pump
            // fills both the freed slot and the new slot without a wave boundary.
            await h.resolveNext({ ok: true, resolvedCount: 1 });
            expect(h.dispatch).toHaveBeenCalledTimes(5);
            expect(h.pending).toHaveLength(4);

            await h.resolveNext({ ok: true, resolvedCount: 1 });
            expect(h.dispatch).toHaveBeenCalledTimes(7);
            expect(h.pending).toHaveLength(5);
        });

        it("grows cloud concurrency +1 per clean completion up to the provider cap", async () => {
            // Pins the additive-increase-to-cap mechanic (start 3, +1/clean, cap 8) directly.
            const h = createHarness({ aimd: { start: 3, floor: 1, cap: 8, additivePerClean: 1 } });
            h.push(Array.from({ length: 40 }, (_, i) => makePacket(`p${i}`)));
            await flush();

            let maxConcurrent = 0;
            while (h.pending.length) {
                maxConcurrent = Math.max(maxConcurrent, h.pending.length);
                await h.resolveNext({ ok: true, resolvedCount: 1 });
            }

            expect(maxConcurrent).toBe(8); // aimd cap
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(8);
            expect(h.dispatch).toHaveBeenCalledTimes(40);
            expect(h.settled.filter((s) => s.outcome.disposition === "success")).toHaveLength(40);
        });

        it("uses the measured OpenAI production AIMD default (start == cap == 40, immediate full concurrency)", async () => {
            // Production default from ai_page_translation_limits.js — the 2026-07-14 gpt-5.6-luna
            // measurement set OpenAI to start 40 / cap 40 ("speed mode": dispatch the full width
            // immediately instead of ramping from a low start, which held a ~190-packet ja page at
            // conc ~8-15 and missed the 30s target; conc40 completed 京阪本線 in 22.0s, 0×429).
            const h = createHarness(); // no aimd override -> openai production default
            h.push(Array.from({ length: 200 }, (_, i) => makePacket(`p${i}`)));
            await flush();

            // start == cap: exactly 40 slots fill immediately, no ramp needed.
            expect(h.dispatch).toHaveBeenCalledTimes(40);
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(40);

            // Already at cap: clean completions never push the limit above 40.
            for (let i = 0; i < 8; i++) await h.resolveNext({ ok: true, resolvedCount: 1 });
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(40);

            while (h.pending.length) await h.resolveNext({ ok: true, resolvedCount: 1 });
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(40);
        });

        it("warms on short packets, then starts the longest tail packets at the cap", async () => {
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 3, additivePerClean: 1 },
            });
            const packets = [
                makePacket("long", { estOut: 900 }),
                makePacket("short", { estOut: 100 }),
                makePacket("mid-high", { estOut: 700 }),
                makePacket("mid-low", { estOut: 200 }),
                makePacket("tail", { estOut: 800 }),
            ];
            h.push(packets);
            await flush();

            expect(h.dispatch.mock.calls.map(([packet]) => packet.id)).toEqual(["short"]);
            await h.resolveNext({ ok: true });
            expect(h.dispatch.mock.calls.map(([packet]) => packet.id)).toEqual([
                "short",
                "mid-low",
                "mid-high",
            ]);

            await h.resolveWhere((entry) => entry.packet.id === "mid-low", { ok: true });
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(3);
            expect(h.dispatch.mock.calls.map(([packet]) => packet.id)).toEqual([
                "short",
                "mid-low",
                "mid-high",
                "long",
                "tail",
            ]);
        });

        it("does not let one saturated limiter key block an unseen key", async () => {
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 1 },
            });
            h.push([
                makePacket("a-active", { limiterKey: "openai:key-a" }),
                makePacket("a-waiting", { limiterKey: "openai:key-a" }),
                makePacket("b-active", { limiterKey: "openai:key-b" }),
            ]);
            await flush();

            expect(h.dispatch.mock.calls.map(([packet]) => packet.id)).toEqual([
                "a-active",
                "b-active",
            ]);
            expect(h.scheduler.inFlightCount("openai:key-a")).toBe(1);
            expect(h.scheduler.inFlightCount("openai:key-b")).toBe(1);
            expect(h.queue.sizeByTier().reduce((total, count) => total + count, 0)).toBe(1);

            await h.resolveWhere((entry) => entry.packet.id === "a-active", { ok: true });
            expect(h.dispatch.mock.calls.map(([packet]) => packet.id)).toEqual([
                "a-active",
                "b-active",
                "a-waiting",
            ]);
        });
    });

    describe("AIMD decrease and recovery", () => {
        it("halves the limit on 429 and never drops below the floor", async () => {
            const h = createHarness({ provider: "googleAiStudio" }); // start 4, floor 1
            h.push(Array.from({ length: 20 }, (_, i) => makePacket(`p${i}`)));
            await flush();
            expect(h.pending).toHaveLength(4);

            await h.resolveNext(rateLimit({ retryAfterMs: 100 }));
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(2);
            await h.resolveNext(rateLimit({ retryAfterMs: 100 }));
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(1);
            await h.resolveNext(rateLimit({ retryAfterMs: 100 }));
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(1); // floor
        });

        it("also halves on 5xx transient failures", async () => {
            const h = createHarness({ provider: "googleAiStudio" });
            h.push(Array.from({ length: 10 }, (_, i) => makePacket(`p${i}`)));
            await flush();

            await h.resolveNext(transient());
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(2);
        });

        it("does not let stale successes undo a congestion decrease", async () => {
            const h = createHarness({
                aimd: { start: 4, floor: 1, cap: 8, additivePerClean: 1 },
            });
            h.push(Array.from({ length: 20 }, (_, i) => makePacket(`p${i}`)));
            await flush();
            expect(h.pending).toHaveLength(4);

            await h.resolveNext(rateLimit({ retryAfterMs: 1000 }));
            expect(h.scheduler.snapshot().keys["openai:key1"]).toMatchObject({
                limit: 2,
                congestionEpoch: 1,
            });

            // These three requests started before the 429. Their successes are valid output,
            // but stale congestion feedback and therefore cannot restore the old limit.
            await h.resolveNext({ ok: true });
            await h.resolveNext({ ok: true });
            await h.resolveNext({ ok: true });
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(2);
            expect(h.pending).toHaveLength(0);

            await h.clock.advance(1002);
            expect(h.pending).toHaveLength(2);
            await h.resolveNext({ ok: true });
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(3);
        });

        it("RECOVERS after cooldown — the stable permanent-halving regression", async () => {
            const h = createHarness({ provider: "googleAiStudio" }); // start 4, cap 12, +1/clean
            h.push(Array.from({ length: 40 }, (_, i) => makePacket(`p${i}`)));
            await flush();
            expect(h.pending).toHaveLength(4);

            await h.resolveNext(rateLimit({ retryAfterMs: 1000 }));
            expect(h.scheduler.snapshot().keys["openai:key1"].limit).toBe(2);
            expect(h.scheduler.cooldownUntil("openai:key1")).toBe(1000);

            // Remaining in-flight settle clean; the cooldown blocks NEW dispatch only.
            await h.resolveNext({ ok: true });
            await h.resolveNext({ ok: true });
            await h.resolveNext({ ok: true });
            expect(h.pending).toHaveLength(0);

            // Cooldown expiry resumes at the halved limit. Pre-429 successes above are stale
            // congestion feedback and intentionally do not undo the decrease.
            await h.clock.advance(1002);
            expect(h.pending).toHaveLength(2);

            // ...and additive increase restores the limit — it is never permanently halved.
            for (let i = 0; i < 12; i += 1) await h.resolveNext({ ok: true });
            const recovered = h.scheduler.snapshot().keys["openai:key1"].limit;
            expect(recovered).toBeGreaterThanOrEqual(4);
            expect(h.pending).toHaveLength(recovered); // pump keeps every restored slot full
            expect(h.scheduler.circuitState().open).toBe(false);
        });

        it("scopes cooldown to the limiterKey — the other key keeps dispatching", async () => {
            const h = createHarness({ aimd: { start: 3, floor: 1, cap: 8, additivePerClean: 1 } });
            const packets = [];
            for (let i = 1; i <= 5; i += 1) {
                packets.push(makePacket(`A${i}`, { limiterKey: "A" }));
                packets.push(makePacket(`B${i}`, { limiterKey: "B" }));
            }
            h.push(packets);
            await flush();
            // 3 per key in flight (openai start 3), A4/B4/A5/B5 still queued.
            expect(h.pending).toHaveLength(6);

            await h.resolveWhere((e) => e.packet.id === "A1", rateLimit({ retryAfterMs: 5000 }));
            expect(h.scheduler.cooldownUntil("A")).toBe(5000);
            expect(h.scheduler.cooldownUntil("B")).toBe(0);
            expect(h.scheduler.snapshot().keys.A.limit).toBe(1); // 3 -> 1 (floor)

            // B keeps dispatching while A cools.
            await h.resolveWhere((e) => e.packet.id === "B1", { ok: true });
            const dispatchedIds = h.dispatch.mock.calls.map(([packet]) => packet.id);
            expect(dispatchedIds).toContain("B4");
            expect(dispatchedIds).not.toContain("A4");
            expect(h.scheduler.inFlightCount("B")).toBe(4);

            // A's cooldown always lifts: the rate-limited packet retries first.
            await h.resolveWhere((e) => e.packet.id === "A2", { ok: true });
            await h.resolveWhere((e) => e.packet.id === "A3", { ok: true });
            expect(h.scheduler.inFlightCount("A")).toBe(0);
            await h.clock.advance(5002);
            expect(h.scheduler.inFlightCount("A")).toBe(1);
            const retried = h.pending.find((e) => e.packet.id === "A1");
            expect(retried.meta.attempt).toBe(2);
        });

        it("honors Retry-After exactly, without jitter", async () => {
            const h = createHarness({ random: () => 1 }); // jitter would be maximal if applied
            h.push([makePacket("p1"), makePacket("p2")]);
            await flush();

            await h.resolveWhere((e) => e.packet.id === "p1", rateLimit({ retryAfterMs: 3000 }));
            expect(h.scheduler.cooldownUntil("openai:key1")).toBe(3000);
            // Free the halved limit's only slot so the cooldown is the sole gate under test.
            await h.resolveWhere((e) => e.packet.id === "p2", { ok: true });

            await h.clock.advance(2999);
            expect(h.pending.find((e) => e.packet.id === "p1")).toBeUndefined();
            await h.clock.advance(5);
            const retried = h.pending.find((e) => e.packet.id === "p1");
            expect(retried).toBeDefined();
            expect(retried.meta.attempt).toBe(2);
        });
    });

    describe("backoff formula", () => {
        it("backs off 500ms·2^g with +20% jitter and a 15s cap", async () => {
            const table = buildRetryTable();
            table.transient = { kind: "backoff-retry", maxRetries: 10 };
            const h = createHarness({
                retryTable: table,
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
                resilience: { consecutiveNoOutputCircuit: 99 }, // isolate the backoff formula
                random: () => 1, // maximal jitter
            });
            h.push([makePacket("p1")]);
            await flush();

            const expected = [600, 1200, 2400, 4800, 9600, 18000, 18000];
            for (const delay of expected) {
                await h.resolveNext(transient({ httpStatus: 502 }));
                expect(h.clock.scheduledDelays[h.clock.scheduledDelays.length - 1]).toBe(delay);
                await h.clock.advance(delay);
                expect(h.pending).toHaveLength(1);
            }
        });

        it("applies zero jitter at the lower bound of the formula", async () => {
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
                random: () => 0,
            });
            h.push([makePacket("p1")]);
            await flush();

            await h.resolveNext(transient());
            expect(h.clock.scheduledDelays[h.clock.scheduledDelays.length - 1]).toBe(500);
        });

        it("retries transient failures at most 3 times, then settles terminal", async () => {
            const h = createHarness({ aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 } });
            h.push([makePacket("p1")]);
            await flush();

            for (const delay of [500, 1000, 2000]) {
                await h.resolveNext(transient());
                await h.clock.advance(delay);
            }
            await h.resolveNext(transient()); // 4th failure: generation 3 >= maxRetries 3

            expect(h.dispatch).toHaveBeenCalledTimes(4);
            const terminal = h.settled[h.settled.length - 1];
            expect(terminal.outcome).toMatchObject({
                ok: false,
                terminal: true,
                failure: { kind: "transient" },
            });
        });

        it("shares one three-retry allowance across changing transport failure kinds", async () => {
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
                resilience: { consecutiveNoOutputCircuit: 99 },
            });
            h.push([makePacket("p1")]);
            await flush();

            await h.resolveNext(rateLimit({ retryAfterMs: 0 }));
            expect(h.pending).toHaveLength(1);

            await h.resolveNext(transient({ httpStatus: 503 }));
            await h.clock.advance(1000); // shared lineage generation 1
            expect(h.pending).toHaveLength(1);

            await h.resolveNext({
                ok: false,
                failure: { kind: "timeout", retryDirective: "same-units" },
            });
            await h.clock.advance(2000); // shared lineage generation 2
            expect(h.pending).toHaveLength(1);

            await h.resolveNext({
                ok: false,
                failure: { kind: "provider-status", retryDirective: "same-units" },
            });

            expect(h.dispatch).toHaveBeenCalledTimes(4); // initial + 3 total retries, not 3/kind
            expect(h.scheduler.pendingRetryCount()).toBe(0);
            expect(h.settled[h.settled.length - 1].outcome).toMatchObject({
                ok: false,
                terminal: true,
                failure: { kind: "provider-status" },
            });
        });

        it("reports retry-parked packets through pendingRetryCount until they re-dispatch", async () => {
            const h = createHarness({ aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 } });
            h.push([makePacket("p1"), makePacket("p2")]);
            await flush();
            expect(h.scheduler.pendingRetryCount()).toBe(0);

            // p1 fails -> parked on its backoff timer while p2 takes the freed slot.
            await h.resolveNext(transient());
            expect(h.scheduler.pendingRetryCount()).toBe(1);
            expect(h.pending[0].packet.id).toBe("p2");

            // Timer fires but the slot is busy: p1 moves to the held lane, still pending.
            await h.clock.advance(500);
            expect(h.scheduler.pendingRetryCount()).toBe(1);

            // The slot frees -> p1 re-dispatches and nothing is parked anymore.
            await h.resolveWhere((e) => e.packet.id === "p2", { ok: true });
            expect(h.scheduler.pendingRetryCount()).toBe(0);
            expect(h.pending[0].packet.id).toBe("p1");
        });
    });

    describe("delivery-unknown", () => {
        it("replays exactly once with the replay flag, then settles terminal", async () => {
            const h = createHarness({ aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 } });
            const packet = makePacket("p1");
            h.push([packet]);
            await flush();
            expect(h.pending[0].meta.replay).toBe(false);

            await h.resolveNext({
                ok: false,
                failure: { kind: "delivery-unknown", retryDirective: "never" },
            });
            // Immediate idempotent replay of the SAME packet — no backoff timer.
            expect(h.dispatch).toHaveBeenCalledTimes(2);
            expect(h.pending[0].packet).toBe(packet);
            expect(h.pending[0].meta.replay).toBe(true);

            await h.resolveNext({
                ok: false,
                failure: { kind: "delivery-unknown", retryDirective: "never" },
            });
            expect(h.dispatch).toHaveBeenCalledTimes(2); // exactly 1 replay, never 2
            expect(h.settled[h.settled.length - 1].outcome).toMatchObject({
                ok: false,
                terminal: true,
                failure: { kind: "delivery-unknown" },
            });
        });

        it("a successful replay settles clean", async () => {
            const h = createHarness({ aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 } });
            h.push([makePacket("p1")]);
            await flush();

            await h.resolveNext({
                ok: false,
                failure: { kind: "delivery-unknown", retryDirective: "never" },
            });
            await h.resolveNext({ ok: true, resolvedCount: 3 });

            expect(h.settled[h.settled.length - 1].outcome).toMatchObject({
                ok: true,
                disposition: "success",
            });
            expect(h.scheduler.snapshot().consecutiveNoOutput).toBe(0);
        });
    });

    describe("circuit breakers", () => {
        it("does not open on a parallel first-wave transient burst when every retry succeeds", async () => {
            const h = createHarness({ provider: "googleAiStudio" }); // first wave: 4 slots
            h.push(Array.from({ length: 4 }, (_, i) => makePacket(`p${i}`)));
            await flush();

            expect(h.pending).toHaveLength(4);
            for (let i = 0; i < 4; i += 1) await h.resolveNext(transient());

            // Raw HTTP attempts do not represent four failed packet lineages: all four still
            // own their bounded retry opportunity, so the page circuit must remain closed.
            expect(h.scheduler.snapshot().consecutiveNoOutput).toBe(0);
            expect(h.scheduler.circuitState().open).toBe(false);
            expect(h.settled).toHaveLength(0);

            await h.clock.advance(500);
            for (let i = 0; i < 4; i += 1) await h.resolveNext({ ok: true, resolvedCount: 1 });

            expect(h.dispatch).toHaveBeenCalledTimes(8);
            expect(
                h.settled.filter((entry) => entry.outcome.disposition === "success")
            ).toHaveLength(4);
            expect(h.scheduler.snapshot().consecutiveNoOutput).toBe(0);
            expect(h.scheduler.circuitState().open).toBe(false);
            expect(h.onCircuitOpen).not.toHaveBeenCalled();
        });

        it("opens after 4 retry-exhausted no-output lineages; partial output resets the counter", async () => {
            const table = buildRetryTable();
            table.transient = { kind: "backoff-retry", maxRetries: 0 };
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
                retryTable: table,
            });
            h.push(Array.from({ length: 10 }, (_, i) => makePacket(`p${i}`)));
            await flush();

            for (let i = 0; i < 3; i += 1) await h.resolveNext(transient());
            expect(h.scheduler.snapshot().consecutiveNoOutput).toBe(3);
            expect(h.scheduler.circuitState().open).toBe(false);

            // Even when the remaining part of a lineage terminalizes, validated partial output
            // proves that the provider path is alive and resets the exhausted-lineage streak.
            await h.resolveNext({ ...transient(), resolvedCount: 2 });
            expect(h.scheduler.snapshot().consecutiveNoOutput).toBe(0);

            for (let i = 0; i < 3; i += 1) await h.resolveNext(transient());
            expect(h.scheduler.circuitState().open).toBe(false);
            await h.resolveNext(transient()); // 4th retry-exhausted lineage

            expect(h.scheduler.circuitState()).toMatchObject({
                open: true,
                reason: "consecutive-no-output",
            });
            expect(h.onCircuitOpen).toHaveBeenCalledTimes(1);
            expect(h.onCircuitOpen.mock.calls[0][0].kind).toBe("consecutive-no-output");
            // Remaining queued and retry-parked packets settle as aborted, never dropped.
            const aborted = h.settled.filter((s) => s.outcome.aborted === true);
            expect(aborted.length).toBeGreaterThan(0);
            expect(h.queue.pull()).toBeNull();
            expect(h.scheduler.pendingRetryCount()).toBe(0);
        });

        it("never counts validation-class failures toward the no-output circuit (google ladder pin)", async () => {
            // The schema ladder legitimately produces 4+ consecutive no-output replies
            // (original + reinforced + 2 bisections) before its atomic rung — tripping the
            // circuit there would make the 8-malformed ≤16-calls pin unreachable.
            const h = createHarness({ aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 } });
            h.push(Array.from({ length: 6 }, (_, i) => makePacket(`p${i}`)));
            await flush();

            for (let i = 0; i < 6; i += 1) {
                await h.resolveNext({ ok: false, failure: { kind: "schema-invalid" } });
            }

            expect(h.scheduler.snapshot().consecutiveNoOutput).toBe(0);
            expect(h.scheduler.circuitState().open).toBe(false);
            expect(h.onCircuitOpen).not.toHaveBeenCalled();
            // Without a recover() callback each packet settles terminal for the session's
            // recovery ladder to own — never silently dropped, never retried here.
            expect(h.settled.filter((s) => s.outcome.terminal === true)).toHaveLength(6);
            expect(h.dispatch).toHaveBeenCalledTimes(6);
        });

        it("settles the first unsupported-capability failure for content-side recovery instead of opening the circuit", async () => {
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
            });
            h.push([makePacket("p1")]);
            await flush();

            await h.resolveNext({
                ok: false,
                failure: {
                    kind: "unsupported-capability",
                    retryDirective: "downgrade",
                    capabilityPatch: { reasoningControl: { value: "none" } },
                },
            });

            expect(h.dispatch).toHaveBeenCalledTimes(1);
            expect(h.settled).toHaveLength(1);
            expect(h.settled[0].outcome).toMatchObject({
                terminal: true,
                failure: {
                    kind: "unsupported-capability",
                    capabilityPatch: { reasoningControl: { value: "none" } },
                },
            });
            expect(h.scheduler.circuitState().open).toBe(false);
            expect(h.onCircuitOpen).not.toHaveBeenCalled();
        });

        it("a terminal provider failure (auth) trips the circuit and aborts in-flight requests", async () => {
            const h = createHarness({ aimd: { start: 3, floor: 1, cap: 8, additivePerClean: 1 } });
            h.push(Array.from({ length: 6 }, (_, i) => makePacket(`p${i}`)));
            await flush();
            const otherSignals = h.pending.slice(1).map((e) => e.meta.signal);

            await h.resolveNext({
                ok: false,
                failure: { kind: "auth", retryDirective: "never" },
            });

            expect(h.scheduler.circuitState()).toMatchObject({ open: true, reason: "auth" });
            expect(h.onCircuitOpen).toHaveBeenCalledTimes(1);
            for (const signal of otherSignals) expect(signal.aborted).toBe(true);
            // Late results from aborted transports settle as aborted, no retries.
            await h.resolveNext({ ok: true });
            expect(h.settled[h.settled.length - 1].outcome.aborted).toBe(true);
            expect(h.dispatch).toHaveBeenCalledTimes(3); // nothing new dispatched
        });

        it("enforces the global attempt ceiling", async () => {
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
                resilience: { consecutiveNoOutputCircuit: 99 }, // isolate the attempt ceiling
                maxTotalAttempts: 5,
            });
            h.push([makePacket("p1"), makePacket("p2"), makePacket("p3")]);
            await flush();

            await h.resolveNext(transient()); // p1 attempt 1
            await h.resolveNext(transient()); // p2 attempt 2
            await h.resolveNext(transient()); // p3 attempt 3
            await h.clock.advance(500); // p1 retries (attempt 4), p2/p3 park behind the limit
            await h.resolveNext(transient()); // p1 attempt 4 fails -> p2 retries (attempt 5)
            await h.resolveNext(transient()); // p2 attempt 5 fails -> p3's dispatch would be #6

            // The 6th HTTP attempt is never made: the ceiling trips the circuit instead.
            expect(h.dispatch).toHaveBeenCalledTimes(5);
            expect(h.scheduler.circuitState()).toMatchObject({
                open: true,
                reason: "attempt-ceiling",
            });
            expect(h.settled.some((s) => s.outcome.failure?.kind === "attempt-ceiling")).toBe(true);
        });
    });

    describe("stop semantics", () => {
        it("stop('priority') NEVER aborts in-flight requests", async () => {
            const h = createHarness({ aimd: { start: 3, floor: 1, cap: 8, additivePerClean: 1 } });
            h.push(Array.from({ length: 5 }, (_, i) => makePacket(`p${i}`)));
            await flush();
            const signals = h.pending.map((e) => e.meta.signal);
            expect(signals).toHaveLength(3);

            h.scheduler.stop("priority");

            for (const signal of signals) expect(signal.aborted).toBe(false);
            // Late results after stop are ignored: no settle, no new dispatch.
            await h.resolveNext({ ok: true });
            expect(h.settled).toHaveLength(0);
            expect(h.dispatch).toHaveBeenCalledTimes(3);
        });

        it("a session stop aborts in-flight transport signals", async () => {
            const h = createHarness();
            h.push(Array.from({ length: 5 }, (_, i) => makePacket(`p${i}`)));
            await flush();
            const signals = h.pending.map((e) => e.meta.signal);

            h.scheduler.stop();

            for (const signal of signals) expect(signal.aborted).toBe(true);
        });
    });

    describe("recovery delegation (§7 policy stays in the session)", () => {
        const outputLimit = {
            ok: false,
            failure: { kind: "output-limit", retryDirective: "split" },
        };

        it("delegates split construction to recover() and enforces the split bound", async () => {
            const recover = jest.fn((packet) => [
                { packet: makePacket(`${packet.id}-child`), tier: 0 },
            ]);
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
                recover,
            });
            h.push([makePacket("p1")]);
            await flush();

            await h.resolveNext(outputLimit); // round 0 -> recover
            expect(recover).toHaveBeenCalledTimes(1);
            expect(recover.mock.calls[0][1].kind).toBe("output-limit");
            expect(recover.mock.calls[0][2]).toMatchObject({ rule: "split", rounds: 0, bound: 2 });
            expect(h.settled[0].outcome).toMatchObject({
                ok: false,
                disposition: "recovered",
                childCount: 1,
            });

            expect(h.pending[0].packet.id).toBe("p1-child");
            await h.resolveNext(outputLimit); // round 1 -> recover again
            expect(recover).toHaveBeenCalledTimes(2);
            expect(recover.mock.calls[1][2]).toMatchObject({ rounds: 1, bound: 2 });

            expect(h.pending[0].packet.id).toBe("p1-child-child");
            await h.resolveNext(outputLimit); // round 2 >= maxSplits 2 -> terminal, NO recover
            expect(recover).toHaveBeenCalledTimes(2);
            expect(h.settled[h.settled.length - 1].outcome).toMatchObject({
                ok: false,
                terminal: true,
                failure: { kind: "output-limit" },
            });
        });

        it("an empty recovery plan settles terminal", async () => {
            const recover = jest.fn(() => []);
            const h = createHarness({
                aimd: { start: 1, floor: 1, cap: 1, additivePerClean: 99 },
                recover,
            });
            h.push([makePacket("p1")]);
            await flush();

            await h.resolveNext(outputLimit);

            expect(recover).toHaveBeenCalledTimes(1);
            expect(h.settled[0].outcome).toMatchObject({ ok: false, terminal: true });
            expect(h.dispatch).toHaveBeenCalledTimes(1);
        });

        it("recovered children re-enter at tier 0, ahead of queued drain packets", async () => {
            const recover = jest.fn((packet) => [
                { packet: makePacket(`${packet.id}-child`), tier: 0 },
            ]);
            const h = createHarness({
                recover,
                aimd: { start: 3, floor: 1, cap: 8, additivePerClean: 1 },
            });
            h.push(
                Array.from({ length: 5 }, (_, i) => makePacket(`p${i}`)),
                2
            );
            await flush();
            expect(h.pending).toHaveLength(3); // p0..p2 in flight; p3, p4 queued at tier 2

            await h.resolveNext(outputLimit); // p0 -> child at tier 0

            const nextDispatched = h.dispatch.mock.calls[3][0];
            expect(nextDispatched.id).toBe("p0-child");
        });
    });
});
