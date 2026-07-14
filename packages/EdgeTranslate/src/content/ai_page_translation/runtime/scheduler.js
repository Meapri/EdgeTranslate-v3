/**
 * Continuous slot-pump scheduler for the vNext AI page translation engine (spec §2.3 + §7).
 *
 * Owns dispatch machinery ONLY:
 * - a continuous slot-fill pump with NO wave barriers — the next packet starts the moment a
 *   slot frees, never at a batch boundary (stable's `await scheduler.run()` pattern is banned);
 * - per-limiterKey AIMD concurrency — +1 per N clean completions, ×0.5 on 429/5xx, floor/cap
 *   per provider — with cooldowns scoped to the limiterKey (never global, stable's
 *   scheduler.js:276 ban) that ALWAYS recover (stable's permanent halving at :263 ban);
 * - Retry-After / RetryInfo honored exactly; otherwise backoff 500ms·2^g +20% jitter, cap 15s;
 * - the §7 retry table as data: the scheduler executes retry DECISIONS (bounds + timing) and
 *   delegates recovery POLICY (split/ladder construction) to the session-supplied
 *   `recover(packet, failure, context)` callback;
 * - exactly-1 idempotent replay for delivery-unknown;
 * - circuit breakers: terminal provider failures, 4 consecutive retry-EXHAUSTED no-output
 *   TRANSPORT-class packet lineages (partial success resets; first-attempt 429/5xx bursts do
 *   not count), and the global attempt ceiling (≤3× initial packet count, supplied by the
 *   session as `maxTotalAttempts`);
 * - in-flight requests are never cancelled for priority — only a session stop aborts them.
 *
 * Failure classes follow the @edge_translate/translators page_translation_v2 errors.ts
 * vocabulary (kind + retryDirective never|same-units|split|downgrade) plus the session-level
 * validation classes from spec §7.
 */

import { AI_PAGE_HEDGE, AI_PAGE_PROVIDER_AIMD } from "common/scripts/ai_page_translation_limits.js";

const DEFAULT_BACKOFF = Object.freeze({ baseMs: 500, factor: 2, jitter: 0.2, capMs: 15000 });

// Pinned per-provider AIMD parameters (spec §2.3 / gates config `concurrencyAimd`).
const DEFAULT_AIMD = Object.freeze({
    // Cloud providers ramp one slot after every clean completion. The shared rows keep these
    // caps byte-identical to the background's cross-tab provider/key gate.
    ...AI_PAGE_PROVIDER_AIMD,
    multiplicativeDecrease: 0.5,
    backoff: DEFAULT_BACKOFF,
});

// Only TRANSPORT-class failures count toward the 4-consecutive no-output circuit (spec §7,
// v2 precedent): validation-class failures (schema/placeholder/semantic) route through the
// bounded recovery ladders, and counting them would trip the circuit mid-ladder — the google
// 8-malformed ≤16-calls pin (original + reinforced + 2 bisections = 4 consecutive no-output
// replies before the atomic rung) would become unreachable.
const NO_OUTPUT_CIRCUIT_KINDS = Object.freeze(
    new Set(["rate-limit", "transient", "timeout", "provider-status", "delivery-unknown"])
);

// Pinned §7 bounds (gates config `resilience`).
const DEFAULT_RESILIENCE = Object.freeze({
    transientRetries: 3,
    rateLimitRetries: 3,
    outputLimitSplits: 2,
    schemaInvalidMaxRequests: 3,
    placeholderRepairRetries: 1,
    placeholderDegradesPerBlock: 1,
    semanticRetries: 1,
    deliveryUnknownReplays: 1,
    consecutiveNoOutputCircuit: 4,
    globalAttemptCeilingFactor: 3,
});

/**
 * Spec §7 retry table as data: failure class -> decision entry.
 * Kinds: backoff-retry | split | ladder | isolate | replay-once | terminal.
 */
function buildRetryTable(resilience = {}) {
    const bounds = { ...DEFAULT_RESILIENCE, ...resilience };
    return {
        "rate-limit": {
            kind: "backoff-retry",
            maxRetries: bounds.rateLimitRetries,
            limiterCooldown: true,
        },
        transient: { kind: "backoff-retry", maxRetries: bounds.transientRetries },
        timeout: { kind: "backoff-retry", maxRetries: bounds.transientRetries },
        "provider-status": { kind: "backoff-retry", maxRetries: bounds.transientRetries },
        "output-limit": { kind: "split", maxRounds: bounds.outputLimitSplits },
        "context-limit": { kind: "split", maxRounds: bounds.outputLimitSplits },
        // ≤3 requests total for the schema ladder (stable pin): initial + 2 recovery rounds.
        "schema-invalid": {
            kind: "ladder",
            maxRounds: Math.max(0, bounds.schemaInvalidMaxRequests - 1),
        },
        "placeholder-invalid": {
            kind: "ladder",
            maxRounds: bounds.placeholderRepairRetries + bounds.placeholderDegradesPerBlock,
        },
        "semantic-invalid": { kind: "ladder", maxRounds: bounds.semanticRetries },
        "unsupported-capability": { kind: "ladder", maxRounds: 1 },
        "content-filter": { kind: "isolate" },
        refusal: { kind: "isolate" },
        "delivery-unknown": { kind: "replay-once", maxReplays: bounds.deliveryUnknownReplays },
        auth: { kind: "terminal", circuit: true },
        quota: { kind: "terminal", circuit: true },
        "model-not-found": { kind: "terminal", circuit: true },
        "missing-key": { kind: "terminal", circuit: true },
        cancelled: { kind: "terminal", circuit: false },
    };
}

function createScheduler(options = {}) {
    const {
        limiterKey = "default",
        provider = "openaiCompatible",
        aimd,
        retryTable,
        resilience,
        dispatch,
        onSettled = () => undefined,
        onCircuitOpen = () => undefined,
        onTelemetry = () => undefined,
        recover = null,
        queue,
        hedge,
        maxTotalAttempts = Number.POSITIVE_INFINITY,
        now = () => Date.now(),
        setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
        clearTimeoutFn = (id) => clearTimeout(id),
        random = Math.random,
    } = options;
    if (typeof dispatch !== "function") {
        throw new TypeError("createScheduler requires a dispatch function");
    }
    if (!queue || typeof queue.pull !== "function" || typeof queue.push !== "function") {
        throw new TypeError("createScheduler requires a queue with pull() and push()");
    }

    const aimdConfig = aimd || DEFAULT_AIMD;
    const providerAimd =
        aimdConfig[provider] ||
        (Number.isFinite(aimdConfig.start) ? aimdConfig : null) ||
        DEFAULT_AIMD[provider] ||
        DEFAULT_AIMD.openaiCompatible;
    const multiplicativeDecrease = Number(aimdConfig.multiplicativeDecrease) || 0.5;
    const backoffConfig = { ...DEFAULT_BACKOFF, ...(aimdConfig.backoff || {}) };
    const resilienceBounds = { ...DEFAULT_RESILIENCE, ...(resilience || {}) };
    const table = retryTable || buildRetryTable(resilienceBounds);
    const transportRetryLimit = Math.max(
        0,
        ...Array.from(NO_OUTPUT_CIRCUIT_KINDS)
            .map((kind) => table[kind])
            .filter((rule) => rule?.kind === "backoff-retry")
            .map((rule) => Math.max(0, Number(rule.maxRetries) || 0))
    );
    const noOutputCircuitThreshold = Math.max(
        1,
        Math.floor(Number(resilienceBounds.consecutiveNoOutputCircuit) || 4)
    );

    // Straggler tail-latency hedging (spec §2.3): defaults pinned in ai_page_translation_limits.js
    // / gates config `hedging`, overridable per session for tests.
    const hedgeConfig = { ...AI_PAGE_HEDGE, ...(hedge || {}) };
    const hedgeEnabled = hedgeConfig.enabled !== false;
    const hedgeThresholdMs = Math.max(0, Number(hedgeConfig.thresholdMs) || 0);
    const hedgeCheckIntervalMs = Math.max(1, Number(hedgeConfig.checkIntervalMs) || 1000);

    const keyStates = new Map(); // limiterKey -> { limit, inFlight, cleanCompletions, cooldownUntil, congestionEpoch, held }
    const metas = new WeakMap(); // packet -> attempt bookkeeping
    const inFlightEntries = new Set(); // { packet, key, controller }
    const timers = new Set();
    const waitingRetries = new Set(); // { packet, key, timerId } — parked on a backoff timer
    let totalAttempts = 0;
    let consecutiveNoOutput = 0;
    let stopped = false;
    let hedgeTimerArmed = false;
    let circuit = { open: false, reason: null, failure: null };

    function keyState(key) {
        let state = keyStates.get(key);
        if (!state) {
            state = {
                limit: Math.max(1, Math.floor(Number(providerAimd.start) || 1)),
                inFlight: 0,
                cleanCompletions: 0,
                cooldownUntil: 0,
                congestionEpoch: 0,
                held: [],
            };
            keyStates.set(key, state);
        }
        return state;
    }

    function metaOf(packet) {
        let meta = metas.get(packet);
        if (!meta) {
            meta = {
                attempts: 0,
                counts: {},
                transportRetries: 0,
                replayPending: false,
                isolateBound: null,
                // At most one hedge per packet ever (spec §2.3 / gates `hedging.maxPerPacket`).
                hedged: false,
            };
            metas.set(packet, meta);
        }
        return meta;
    }

    function limiterKeyOf(packet) {
        return typeof packet?.limiterKey === "string" && packet.limiterKey
            ? packet.limiterKey
            : limiterKey;
    }

    function attemptCeiling() {
        const ceiling =
            typeof maxTotalAttempts === "function" ? maxTotalAttempts() : maxTotalAttempts;
        return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : Number.POSITIVE_INFINITY;
    }

    function scheduleTimer(delayMs, fn) {
        const id = setTimeoutFn(() => {
            timers.delete(id);
            fn();
        }, Math.max(0, delayMs));
        timers.add(id);
        return id;
    }

    function clearAllTimers() {
        for (const id of timers) clearTimeoutFn(id);
        timers.clear();
    }

    // Backoff 500ms·2^g +20% jitter, cap 15s (spec §7): the base is capped, jitter added after,
    // so the observable delay is min(cap, base·factor^g)·[1, 1+jitter].
    function backoffDelayMs(generation) {
        const base = Math.min(
            backoffConfig.capMs,
            backoffConfig.baseMs * backoffConfig.factor ** Math.max(0, generation)
        );
        const jitter = Math.round(
            base * backoffConfig.jitter * Math.max(0, Math.min(1, Number(random()) || 0))
        );
        return base + jitter;
    }

    function ruleFor(failure) {
        const rule = table[failure?.kind];
        if (rule) return rule;
        switch (failure?.retryDirective) {
            case "same-units":
                return { kind: "backoff-retry", maxRetries: resilienceBounds.transientRetries };
            case "split":
                return { kind: "split", maxRounds: resilienceBounds.outputLimitSplits };
            case "downgrade":
                return { kind: "ladder", maxRounds: 1 };
            default:
                return { kind: "terminal", circuit: false };
        }
    }

    function settleTerminal(packet, failure) {
        onSettled(packet, { ok: false, terminal: true, failure });
    }

    function settleAborted(packet, cause) {
        onSettled(packet, {
            ok: false,
            terminal: true,
            aborted: true,
            failure: {
                kind: "session-aborted",
                cause: cause || circuit.reason || "stopped",
                retryDirective: "never",
            },
        });
    }

    function openCircuit(failure) {
        if (circuit.open) return;
        circuit = { open: true, reason: failure?.kind || "unknown", failure: failure || null };
        clearAllTimers();
        for (const waiting of Array.from(waitingRetries)) {
            settleAborted(waiting.packet, circuit.reason);
        }
        waitingRetries.clear();
        for (const state of keyStates.values()) {
            for (const held of state.held.splice(0)) settleAborted(held, circuit.reason);
        }
        let queued;
        while ((queued = queue.pull())) settleAborted(queued, circuit.reason);
        // Terminal circuits abort in-flight work; late transport results settle as aborted.
        for (const entry of inFlightEntries) entry.controller?.abort();
        onCircuitOpen(circuit.failure);
    }

    function dispatchAllowed(state) {
        return state.inFlight < state.limit && now() >= state.cooldownUntil;
    }

    function queuedPacketIsDispatchable(packet) {
        const state = keyStates.get(limiterKeyOf(packet));
        // An unseen key owns a fresh independent limiter and therefore has initial capacity.
        // Do not let an earlier saturated/cooling key create head-of-line blocking for it.
        return !state || dispatchAllowed(state);
    }

    // Decode time tracks output size. While a limiter is below its cap, complete short packets
    // first so clean feedback opens slots quickly; once at cap, start the longest remaining
    // packets first so one large generation cannot become the full-page tail. A production page
    // session owns one limiter key; queue tiers still take precedence over this within-lane
    // choice, and unlike held retries this selection never crosses a recovery tier boundary.
    function compareQueuedPackets(a, b) {
        const aKey = limiterKeyOf(a);
        if (aKey !== limiterKeyOf(b)) return 0;
        const state = keyState(aKey);
        const aOut = Number(a?.estOut);
        const bOut = Number(b?.estOut);
        if (!Number.isFinite(aOut) || !Number.isFinite(bOut) || aOut <= 0 || bOut <= 0) return 0;
        return state.limit < providerAimd.cap ? aOut - bOut : bOut - aOut;
    }

    // A dispatch that resolves to a non-object, or rejects, is treated as a delivery-unknown:
    // the request may have executed, so it is not silently dropped.
    function normalizeOutcome(outcome) {
        return outcome && typeof outcome === "object"
            ? outcome
            : {
                  ok: false,
                  failure: {
                      kind: "delivery-unknown",
                      message: "dispatch returned no outcome",
                      retryDirective: "never",
                      requestMayHaveExecuted: true,
                  },
              };
    }

    function dispatchError(error) {
        return {
            ok: false,
            failure: {
                kind: "delivery-unknown",
                message: error?.message || String(error),
                retryDirective: "never",
                requestMayHaveExecuted: true,
            },
        };
    }

    function dispatchPacket(packet, key) {
        const state = keyState(key);
        if (totalAttempts >= attemptCeiling()) {
            const failure = {
                kind: "attempt-ceiling",
                message: `Global attempt ceiling reached after ${totalAttempts} HTTP attempts`,
                retryDirective: "never",
            };
            settleTerminal(packet, failure);
            openCircuit(failure);
            return;
        }
        totalAttempts += 1;
        const meta = metaOf(packet);
        meta.attempts += 1;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        // A later 429/5xx advances this key's congestion epoch. Successes from requests that
        // started before that signal are stale ACKs and must not immediately undo the
        // multiplicative decrease while their siblings are still settling.
        const attemptMeta = {
            attempt: meta.attempts,
            totalAttempts,
            counts: { ...meta.counts },
            replay: meta.replayPending === true,
            limiterKey: key,
            signal: controller ? controller.signal : null,
        };
        // startedAt drives the hedge gate; meta/attemptMeta are held so a winning hedge sibling
        // can reap this entry (release its slot, suppress its billing) without waiting on it.
        const entry = {
            packet,
            key,
            controller,
            congestionEpoch: state.congestionEpoch,
            startedAt: now(),
            meta,
            attemptMeta,
        };
        inFlightEntries.add(entry);
        state.inFlight += 1;
        meta.replayPending = false;
        Promise.resolve()
            .then(() => dispatch(packet, attemptMeta))
            .then(normalizeOutcome, dispatchError)
            .then((outcome) => settle(entry, outcome));
    }

    // Fires a SECOND concurrent provider request for an in-flight straggler (spec §2.3 tail
    // control). The two entries share a `pair` guard so the packet is settled EXACTLY once; the
    // hedge carries attemptMeta.hedge=true so the transport routes it under a distinct wire
    // packetId and the session suppresses the loser's usage. A hedge is a real HTTP attempt, so
    // it is counted against the global attempt ceiling; maxPerPacket 1 (meta.hedged) bounds it.
    function fireHedge(originalEntry) {
        const { packet, key } = originalEntry;
        const state = keyState(key);
        const meta = originalEntry.meta;
        meta.hedged = true;
        totalAttempts += 1;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const pair = { resolved: false };
        originalEntry.hedgePair = pair;
        const attemptMeta = {
            attempt: meta.attempts,
            totalAttempts,
            counts: { ...meta.counts },
            replay: false,
            limiterKey: key,
            signal: controller ? controller.signal : null,
            hedge: true,
        };
        const hedgeEntry = {
            packet,
            key,
            controller,
            congestionEpoch: state.congestionEpoch,
            startedAt: now(),
            meta,
            attemptMeta,
            hedgePair: pair,
            isHedge: true,
            sibling: originalEntry,
        };
        originalEntry.sibling = hedgeEntry;
        inFlightEntries.add(hedgeEntry);
        state.inFlight += 1;
        onTelemetry("hedge_fired");
        Promise.resolve()
            .then(() => dispatch(packet, attemptMeta))
            .then(normalizeOutcome, dispatchError)
            .then((outcome) => settle(hedgeEntry, outcome));
    }

    // The winner of a hedge pair reaps its sibling immediately: release its slot, mark it so its
    // late settle is a no-op, tell the session (through the shared attemptMeta) to DISCARD its
    // usage receipt, and abort its local controller. The provider still bills the loser's
    // generation, so the banner may under-report by the loser's tokens — accepted (never summed).
    function reapHedgeSibling(sibling) {
        if (!sibling || sibling.reaped) return;
        sibling.reaped = true;
        if (inFlightEntries.delete(sibling)) {
            const siblingState = keyState(sibling.key);
            siblingState.inFlight = Math.max(0, siblingState.inFlight - 1);
        }
        if (sibling.attemptMeta) sibling.attemptMeta.hedgeLost = true;
        sibling.controller?.abort();
    }

    function queuedWorkCount() {
        if (!queue || typeof queue.sizeByTier !== "function") return 0;
        const sizes = queue.sizeByTier();
        return Array.isArray(sizes)
            ? sizes.reduce((total, count) => total + (Number(count) || 0), 0)
            : 0;
    }

    function hasUnhedgedInFlight() {
        for (const entry of inFlightEntries) {
            if (!entry.meta || entry.meta.hedged !== true) return true;
        }
        return false;
    }

    // Runs on each pump tick and on the ~1s re-armed timer. Hedges an in-flight straggler ONLY
    // when a slot is free AND no fresh work is queued (never steal a slot from unstarted work).
    function evaluateHedges() {
        if (!hedgeEnabled || stopped || circuit.open) return;
        if (queuedWorkCount() > 0) return;
        const nowTs = now();
        for (const entry of Array.from(inFlightEntries)) {
            if (entry.isHedge || !entry.meta || entry.meta.hedged === true) continue;
            if (nowTs - entry.startedAt < hedgeThresholdMs) continue;
            if (totalAttempts >= attemptCeiling()) continue;
            const state = keyState(entry.key);
            if (!dispatchAllowed(state)) continue;
            fireHedge(entry);
        }
    }

    function armHedgeTimer() {
        if (!hedgeEnabled || stopped || circuit.open || hedgeTimerArmed) return;
        if (!hasUnhedgedInFlight()) return;
        hedgeTimerArmed = true;
        scheduleTimer(hedgeCheckIntervalMs, () => {
            hedgeTimerArmed = false;
            if (stopped || circuit.open) return;
            evaluateHedges();
            armHedgeTimer();
        });
    }

    function settleExhaustedTransport(packet, failure, resolvedCount) {
        settleTerminal(packet, failure);
        if (resolvedCount > 0) {
            consecutiveNoOutput = 0;
            return false;
        }
        if (!NO_OUTPUT_CIRCUIT_KINDS.has(failure?.kind)) return false;
        consecutiveNoOutput += 1;
        if (consecutiveNoOutput < noOutputCircuitThreshold) return false;
        openCircuit({
            kind: "consecutive-no-output",
            cause: failure.kind,
            message: `${consecutiveNoOutput} retry-exhausted packet lineages failed without validated output`,
            retryDirective: "never",
        });
        return true;
    }

    async function settle(entry, outcome) {
        const { packet, key } = entry;
        // A hedge loser reaped by its winning sibling already had its slot released, its usage
        // suppressed and its outcome discarded at reap time. Its late settle is a pure no-op —
        // never double-decrement the limiter, never re-process, never retry, never bill.
        if (entry.reaped) return;
        inFlightEntries.delete(entry);
        const state = keyState(key);
        state.inFlight = Math.max(0, state.inFlight - 1);
        // Hedge pair resolution: the FIRST entry of a pair to reach settle drives the packet's
        // state machine exactly once. It reaps the sibling straggler immediately so full-page
        // completion never waits on the loser's slow generation, and marks the pair resolved so
        // the loser's eventual settle short-circuits above.
        if (entry.hedgePair && !entry.hedgePair.resolved) {
            entry.hedgePair.resolved = true;
            reapHedgeSibling(entry.sibling);
            onTelemetry(entry.isHedge ? "hedge_won" : "hedge_original_won");
        }
        // A session stop or an open circuit is a terminal dispatch boundary: a transport call
        // that settles after it must not mutate scheduling state or spawn retries.
        if (stopped) return;
        if (circuit.open) {
            settleAborted(packet, outcome?.failure?.kind);
            return;
        }

        const resolvedCount = Math.max(0, Number(outcome?.resolvedCount) || 0);
        if (outcome?.ok === true) {
            consecutiveNoOutput = 0;
            const currentEpoch = entry.congestionEpoch === state.congestionEpoch;
            const cooldownComplete = now() >= state.cooldownUntil;
            if (resolvedCount > 0 && currentEpoch && cooldownComplete) {
                state.cleanCompletions += 1;
                const additive = Math.max(
                    1,
                    Math.floor(Number(providerAimd.additivePerClean) || 3)
                );
                if (state.cleanCompletions >= additive) {
                    state.cleanCompletions = 0;
                    state.limit = Math.min(providerAimd.cap, state.limit + 1);
                }
            }
            onSettled(packet, { ...outcome, disposition: "success" });
            pump();
            return;
        }

        const failure = outcome?.failure || { kind: "delivery-unknown", retryDirective: "never" };
        // Partial validated output proves the provider path is alive. A no-output transport
        // attempt does not count until this packet lineage has spent its bounded retries below;
        // otherwise four concurrent first-attempt 429/5xx replies can abort the whole page before
        // even one Retry-After/cooldown probe runs.
        if (resolvedCount > 0) consecutiveNoOutput = 0;
        // AIMD multiplicative decrease on 429/5xx (spec §2.3) — scoped to this limiterKey,
        // never below the floor, and always recovering via additive increase.
        if (
            failure.kind === "rate-limit" ||
            (failure.kind === "transient" && Number(failure.httpStatus) >= 500)
        ) {
            state.congestionEpoch += 1;
            state.limit = Math.max(
                providerAimd.floor,
                Math.floor(state.limit * multiplicativeDecrease)
            );
            state.cleanCompletions = 0;
        }
        const rule = ruleFor(failure);
        const meta = metaOf(packet);
        switch (rule.kind) {
            case "backoff-retry": {
                const kindGeneration = meta.counts[failure.kind] || 0;
                const lineageGeneration = meta.transportRetries || 0;
                // A retry lineage owns one shared transport allowance. Alternating 429/5xx/
                // timeout/provider-status responses must not reset the budget and multiply one
                // packet into three retries per failure class.
                if (kindGeneration >= rule.maxRetries || lineageGeneration >= transportRetryLimit) {
                    settleExhaustedTransport(packet, failure, resolvedCount);
                    break;
                }
                meta.counts[failure.kind] = kindGeneration + 1;
                meta.transportRetries = lineageGeneration + 1;
                const retryAfterMs = Number(failure.retryAfterMs);
                const honorRetryAfter = Number.isFinite(retryAfterMs) && retryAfterMs >= 0;
                const delayMs = honorRetryAfter ? retryAfterMs : backoffDelayMs(lineageGeneration);
                if (rule.limiterCooldown) {
                    // Rate-limit: cooldown blocks new dispatch on THIS limiterKey only; the
                    // packet re-enters this key's held lane and a timer guarantees recovery.
                    state.cooldownUntil = Math.max(state.cooldownUntil, now() + delayMs);
                    state.held.push(packet);
                    scheduleTimer(delayMs + 1, pump);
                } else {
                    const waiting = { packet, key, timerId: null };
                    waiting.timerId = scheduleTimer(delayMs, () => {
                        waitingRetries.delete(waiting);
                        keyState(key).held.push(packet);
                        pump();
                    });
                    waitingRetries.add(waiting);
                }
                break;
            }
            case "split":
            case "ladder":
            case "isolate": {
                await handleRecovery(packet, failure, rule, meta);
                break;
            }
            case "replay-once": {
                const replays = meta.counts.replay || 0;
                const maxReplays = Math.max(0, Number(rule.maxReplays) || 0);
                if (replays >= maxReplays) {
                    settleExhaustedTransport(packet, failure, resolvedCount);
                    break;
                }
                // Exactly-1 idempotent replay: same packet (same idempotency key downstream),
                // immediate, flagged so the transport replays instead of re-billing.
                meta.counts.replay = replays + 1;
                meta.replayPending = true;
                state.held.push(packet);
                break;
            }
            default: {
                if (NO_OUTPUT_CIRCUIT_KINDS.has(failure.kind)) {
                    settleExhaustedTransport(packet, failure, resolvedCount);
                } else {
                    settleTerminal(packet, failure);
                }
                if (rule.circuit) openCircuit(failure);
            }
        }
        pump();
    }

    function isolateBound(packet, meta) {
        if (Number.isFinite(meta.isolateBound) && meta.isolateBound !== null) {
            return meta.isolateBound;
        }
        const itemCount = Math.max(
            1,
            Math.floor(
                Number(packet?.itemCount) ||
                    (Array.isArray(packet?.items) ? packet.items.length : 1)
            )
        );
        meta.isolateBound = Math.ceil(Math.log2(itemCount)) + 1;
        return meta.isolateBound;
    }

    // Bounds + timing only: recovery POLICY (how to split, which ladder step, what to isolate)
    // belongs to the session's recover() callback; an empty/missing plan settles terminal.
    async function handleRecovery(packet, failure, rule, meta) {
        const counter = rule.kind;
        const rounds = meta.counts[counter] || 0;
        const bound =
            rule.kind === "isolate"
                ? isolateBound(packet, meta)
                : Math.max(0, Number(rule.maxRounds) || 0);
        if (rounds >= bound || typeof recover !== "function") {
            settleTerminal(packet, failure);
            return;
        }
        let plan = null;
        try {
            plan = await recover(packet, failure, {
                rule: rule.kind,
                rounds,
                bound,
                counts: { ...meta.counts },
            });
        } catch (error) {
            plan = null;
        }
        const children = Array.isArray(plan) ? plan.filter(Boolean) : [];
        if (stopped) return;
        if (circuit.open || !children.length) {
            settleTerminal(packet, failure);
            return;
        }
        for (const child of children) {
            const childPacket =
                child.packet && typeof child.packet === "object" ? child.packet : child;
            const childTier = Number.isInteger(child.tier) ? child.tier : 0;
            const childMeta = metaOf(childPacket);
            childMeta.counts = { ...meta.counts, [counter]: rounds + 1 };
            childMeta.isolateBound = meta.isolateBound;
            queue.push(childPacket, childTier);
        }
        onSettled(packet, {
            ok: false,
            disposition: "recovered",
            failure,
            childCount: children.length,
        });
    }

    function pump() {
        if (stopped || circuit.open) return;
        // Held packets (backoff returns, replays, cooldown survivors) dispatch before new pulls.
        for (const [key, state] of keyStates) {
            while (state.held.length && dispatchAllowed(state)) {
                dispatchPacket(state.held.shift(), key);
            }
            if (stopped || circuit.open) return;
        }
        // Continuous pull: fill every free slot, no wave barrier. A packet whose limiterKey is
        // cooling or saturated remains queued so another limiterKey can dispatch without losing
        // the original packet's tier/FIFO position.
        while (!stopped && !circuit.open) {
            const packet = queue.pull({
                compare: compareQueuedPackets,
                accept: queuedPacketIsDispatchable,
            });
            if (!packet) break;
            const key = limiterKeyOf(packet);
            const state = keyState(key);
            if (dispatchAllowed(state)) dispatchPacket(packet, key);
            else state.held.push(packet);
        }
        if (stopped || circuit.open) return;
        // The queue is drained (or every remaining packet is gated): now that fresh work has had
        // first claim on the slots, consider hedging any in-flight straggler with an idle slot.
        evaluateHedges();
        armHedgeTimer();
    }

    function notifyEnqueued() {
        pump();
    }

    function inFlightCount(key) {
        if (key !== undefined) return keyStates.get(key)?.inFlight || 0;
        let total = 0;
        for (const state of keyStates.values()) total += state.inFlight;
        return total;
    }

    /**
     * Packets parked on a backoff timer, a cooldown hold or a pending replay — neither
     * queued nor in flight, but guaranteed to dispatch again. Sessions must not declare
     * completion while this is nonzero.
     */
    function pendingRetryCount() {
        let total = waitingRetries.size;
        for (const state of keyStates.values()) total += state.held.length;
        return total;
    }

    function cooldownUntil(key = limiterKey) {
        return keyStates.get(key)?.cooldownUntil || 0;
    }

    function circuitState() {
        return { open: circuit.open, reason: circuit.reason, failure: circuit.failure };
    }

    function stop(reason = "session") {
        stopped = true;
        clearAllTimers();
        waitingRetries.clear();
        // In-flight requests are NEVER cancelled for priority (spec §2.3); only a session stop
        // aborts the transport signals.
        if (reason !== "priority") {
            for (const entry of inFlightEntries) entry.controller?.abort();
        }
    }

    /** Diagnostic snapshot (test/telemetry helper; not part of the dispatch contract). */
    function snapshot() {
        const keys = {};
        for (const [key, state] of keyStates) {
            keys[key] = {
                limit: state.limit,
                inFlight: state.inFlight,
                cleanCompletions: state.cleanCompletions,
                cooldownUntil: state.cooldownUntil,
                congestionEpoch: state.congestionEpoch,
                held: state.held.length,
            };
        }
        return {
            totalAttempts,
            consecutiveNoOutput,
            stopped,
            circuit: circuitState(),
            keys,
        };
    }

    return {
        pump,
        notifyEnqueued,
        inFlightCount,
        pendingRetryCount,
        cooldownUntil,
        circuitState,
        stop,
        snapshot,
    };
}

export {
    DEFAULT_AIMD,
    DEFAULT_BACKOFF,
    DEFAULT_RESILIENCE,
    NO_OUTPUT_CIRCUIT_KINDS,
    buildRetryTable,
    createScheduler,
};
