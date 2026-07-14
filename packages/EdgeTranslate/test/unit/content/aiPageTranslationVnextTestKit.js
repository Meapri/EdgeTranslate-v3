/**
 * Test doubles for the vNext runtime pieces owned by the C1 work area, implemented
 * strictly against the pinned C1/C2 interface contract so the C2 session tests are an
 * executable specification of that contract:
 *
 * - priority queue: push(packet, tier 0..3), pull() lowest tier first / FIFO within tier,
 *   promoteByTargets, observeForReveal, sizeByTier, stop.
 * - scheduler: continuous slot pump (no wave barriers), transport-class retries bounded by
 *   the retry table, terminal-kind circuit, 4-consecutive-no-output (transport-class)
 *   circuit with partial success resetting, global attempt ceiling, dispatch/onSettled/
 *   onCircuitOpen callbacks, stop().
 */

const TRANSPORT_KINDS = new Set([
    "rate-limit",
    "transient",
    "timeout",
    "provider-status",
    "delivery-unknown",
]);
const TERMINAL_KINDS = new Set([
    "auth",
    "quota",
    "model-not-found",
    "unsupported-capability",
    "missing-key",
]);

function createQueueDouble() {
    const tiers = [[], [], [], []];
    const pushes = [];
    return {
        pushes,
        push(packet, tier) {
            const lane = Math.max(0, Math.min(3, Number(tier) || 0));
            tiers[lane].push(packet);
            pushes.push({ tier: lane, packet });
        },
        pull() {
            for (const lane of tiers) {
                if (lane.length) return lane.shift();
            }
            return null;
        },
        promoteByTargets(targetIds) {
            const wanted = new Set(targetIds || []);
            for (let tier = 1; tier < tiers.length; tier += 1) {
                for (let index = tiers[tier].length - 1; index >= 0; index -= 1) {
                    const packet = tiers[tier][index];
                    if (packet.items?.some((item) => wanted.has(item.entry?.target?.id))) {
                        tiers[tier].splice(index, 1);
                        tiers[0].push(packet);
                    }
                }
            }
        },
        observeForReveal() {},
        sizeByTier: () => tiers.map((lane) => lane.length),
        stop() {},
    };
}

function createSchedulerDouble({
    retryTable = {},
    dispatch,
    onSettled,
    onCircuitOpen,
    queue,
    maxTotalAttempts,
    concurrency = 4,
} = {}) {
    const state = {
        inFlight: 0,
        attempts: 0,
        consecutiveNoOutput: 0,
        circuit: null,
        stopped: false,
    };
    const ceiling = () =>
        typeof maxTotalAttempts === "function"
            ? maxTotalAttempts()
            : maxTotalAttempts ?? Number.POSITIVE_INFINITY;
    const openCircuit = (failure) => {
        if (state.circuit || state.stopped) return;
        state.circuit = failure;
        state.stopped = true;
        if (onCircuitOpen) onCircuitOpen(failure);
    };

    async function run(packet) {
        state.inFlight += 1;
        let settled = null;
        try {
            let attempt = 0;
            for (;;) {
                if (state.stopped) return;
                if (state.attempts >= ceiling()) {
                    openCircuit({ kind: "attempt-ceiling" });
                    return;
                }
                state.attempts += 1;
                const outcome = await dispatch(packet, { attempt });
                if (outcome?.status === "cancelled") return;
                const kind = outcome?.failure?.kind || null;
                if ((outcome?.resolvedCount || 0) > 0) {
                    state.consecutiveNoOutput = 0;
                } else if (kind && TRANSPORT_KINDS.has(kind)) {
                    state.consecutiveNoOutput += 1;
                    if (state.consecutiveNoOutput >= 4) {
                        openCircuit({ kind: "consecutive-no-output", cause: kind });
                        return;
                    }
                }
                if (kind && TERMINAL_KINDS.has(kind) && retryTable[kind]?.kind !== "ladder") {
                    openCircuit(outcome.failure);
                    return;
                }
                if (outcome?.status !== "ok" && kind && TRANSPORT_KINDS.has(kind)) {
                    const bound = Number(retryTable[kind]?.maxRetries) || 0;
                    if (attempt < bound) {
                        attempt += 1;
                        continue;
                    }
                }
                settled = outcome;
                return;
            }
        } finally {
            state.inFlight -= 1;
            if (settled && !state.stopped) onSettled(packet, settled);
            pump();
        }
    }

    function pump() {
        if (state.stopped) return;
        let packet;
        while (state.inFlight < concurrency && (packet = queue.pull())) run(packet);
    }

    return {
        pump,
        notifyEnqueued: pump,
        inFlightCount: () => state.inFlight,
        cooldownUntil: () => 0,
        circuitState: () => state.circuit,
        stop() {
            state.stopped = true;
        },
        _state: state,
    };
}

async function flushMicrotasks(rounds = 30) {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

export {
    TERMINAL_KINDS,
    TRANSPORT_KINDS,
    createQueueDouble,
    createSchedulerDouble,
    flushMicrotasks,
};
