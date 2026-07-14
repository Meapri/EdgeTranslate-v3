/**
 * Recovery policy for the vNext AI page translation engine — spec §7 as data plus the
 * composable ladder actions the session feeds back into the scheduler queue.
 *
 * Division of labor: the SCHEDULER owns transport-class retries (rate-limit, transient,
 * timeout, provider-status, delivery-unknown) and the terminal circuit kinds; THIS module
 * owns the policy ladders that produce new, strictly shrinking packets — schema/parse
 * failures (google-style depth halving: reinforced same retry → one bisection → per-block
 * atomic), output-limit splits, content-filter isolation, the §1.4 placeholder ladder past
 * the zero-token local repair, and the semantic items-only retry. Every rung is bounded,
 * never throws, never loops; terminal rungs surface as keep-source items the session counts
 * in "Translation incomplete: N strings".
 *
 * Pins preserved from the deleted engines: a persistently schema-invalid single-block
 * packet costs exactly 3 requests (original + reinforced + atomic — stable pin); 8
 * malformed blocks cost ≤16 calls (1 original + 1 reinforced + 2 bisection halves + 8
 * atomics = 12 — google pin).
 */

const TERMINAL_FAILURE_KINDS = Object.freeze(
    new Set(["auth", "quota", "model-not-found", "unsupported-capability", "missing-key"])
);

const SCHEDULER_RETRY_KINDS = Object.freeze(
    new Set(["rate-limit", "transient", "timeout", "provider-status", "delivery-unknown"])
);

// Spec §7 rows as data. `owner` says which layer acts: "scheduler" rows are same-packet
// re-dispatches with backoff, "recovery" rows are ladders in this module, "circuit" rows
// stop the session loudly.
//
// Every row ALSO carries the C1 scheduler's decision vocabulary (`kind` +
// maxRetries/maxRounds/maxReplays/limiterCooldown/circuit) so the session can hand this
// exact table to runtime/scheduler.js: the scheduler executes the transport-class rows
// itself and settles the "recovery"-owned kinds terminally (it has no recover() callback in
// the vNext session wiring), which routes them into this module's ladders via onSettled.
const RETRY_TABLE = Object.freeze({
    "rate-limit": Object.freeze({
        owner: "scheduler",
        kind: "backoff-retry",
        maxRetries: 3,
        backoff: true,
        aimdDecrease: true,
        honorRetryAfter: true,
        limiterCooldown: true,
    }),
    transient: Object.freeze({
        owner: "scheduler",
        kind: "backoff-retry",
        maxRetries: 3,
        backoff: true,
    }),
    timeout: Object.freeze({
        owner: "scheduler",
        kind: "backoff-retry",
        maxRetries: 3,
        backoff: true,
    }),
    "provider-status": Object.freeze({
        owner: "scheduler",
        kind: "backoff-retry",
        maxRetries: 3,
        backoff: true,
    }),
    "delivery-unknown": Object.freeze({
        owner: "scheduler",
        kind: "replay-once",
        maxRetries: 1,
        maxReplays: 1,
        idempotentReplay: true,
    }),
    "output-limit": Object.freeze({
        owner: "recovery",
        kind: "split",
        maxRounds: 2,
        maxSplits: 2,
        thenAtomicOnce: true,
    }),
    "context-limit": Object.freeze({
        owner: "recovery",
        kind: "split",
        maxRounds: 2,
        maxSplits: 2,
        thenAtomicOnce: true,
    }),
    "schema-invalid": Object.freeze({
        owner: "recovery",
        kind: "ladder",
        maxRounds: 2,
        maxRequestsPerLineage: 3,
    }),
    "placeholder-invalid": Object.freeze({
        owner: "recovery",
        kind: "ladder",
        maxRounds: 2,
        repairRetries: 1,
        degradesPerBlock: 1,
    }),
    "semantic-invalid": Object.freeze({
        owner: "recovery",
        kind: "ladder",
        maxRounds: 1,
        retries: 1,
    }),
    "content-filter": Object.freeze({
        owner: "recovery",
        kind: "isolate",
        strategy: "split-to-isolate",
    }),
    auth: Object.freeze({
        owner: "circuit",
        kind: "terminal",
        circuit: true,
        terminal: true,
        maxSessionAttempts: 2,
    }),
    quota: Object.freeze({
        owner: "circuit",
        kind: "terminal",
        circuit: true,
        terminal: true,
        maxSessionAttempts: 2,
    }),
    "model-not-found": Object.freeze({
        owner: "circuit",
        kind: "terminal",
        circuit: true,
        terminal: true,
        maxSessionAttempts: 2,
    }),
    "missing-key": Object.freeze({
        owner: "circuit",
        kind: "terminal",
        circuit: true,
        terminal: true,
        maxSessionAttempts: 2,
    }),
    "unsupported-capability": Object.freeze({
        // The scheduler must surface the first failure to the content-side recovery hook.
        // Only a validated `reasoningControl:none` patch may produce one explicit child
        // packet; every other unsupported-capability outcome is turned into a loud provider
        // configuration error by reply_pipeline.js.
        owner: "recovery",
        kind: "ladder",
        maxRounds: 1,
    }),
    cancelled: Object.freeze({ owner: "none", kind: "terminal", circuit: false }),
});

// Absolute rung ceiling: no combination of ladder transitions is this deep, so a depth past
// it can only mean a bookkeeping bug — terminate instead of looping.
const MAX_LADDER_DEPTH = 6;

function splitInHalves(items) {
    const middle = Math.ceil(items.length / 2);
    return [items.slice(0, middle), items.slice(middle)].filter((half) => half.length);
}

// Chunk fragments and per-node atomic parts are already indivisible: their next rung is
// terminal, never a further decomposition.
function isIndivisible(item) {
    return Boolean(item?.chunk || item?.atomicPart);
}

function createRecoveryController({ onTelemetry } = {}) {
    const telemetry = {};
    const emit = (counter, count = 1) => {
        telemetry[counter] = (telemetry[counter] || 0) + count;
        if (typeof onTelemetry === "function") onTelemetry(counter, count);
    };

    const atomicStep = (meta, items) => {
        const packets = [];
        const keepSource = [];
        for (const item of items) {
            if (isIndivisible(item)) {
                keepSource.push(item);
                continue;
            }
            emit("recovery_atomic");
            packets.push({
                items: [item],
                mode: "atomic",
                stage: "atomic",
                depth: (meta?.depth || 0) + 1,
                hint: "reinforced-atomic",
            });
        }
        return { packets, keepSource };
    };

    /**
     * Wire-level ladder step for one failed packet. `meta` is the packet's recovery
     * metadata from the descriptor that created it (null for first-generation packets);
     * `items` are the still-unresolved packet items. Returns `{ packets, keepSource }`
     * where every descriptor's item list is no larger than the input — recovery packets
     * are strictly shrinking in aggregate and the ladder always terminates.
     */
    const planWireFailure = (meta, kind, items) => {
        const remaining = Array.isArray(items) ? items.filter(Boolean) : [];
        if (!remaining.length) return { packets: [], keepSource: [] };
        const depth = Number(meta?.depth) || 0;
        const stage = meta?.stage || null;
        if (depth >= MAX_LADDER_DEPTH || stage === "atomic") {
            emit("keep_source_terminal", remaining.length);
            return { packets: [], keepSource: remaining };
        }
        const nextDepth = depth + 1;

        if (kind === "content-filter") {
            // Split-to-isolate: singletons keep their original text and are NEVER retried.
            if (remaining.length === 1) {
                emit("content_filter_kept_source");
                return { packets: [], keepSource: remaining };
            }
            emit("content_filter_isolated");
            return {
                packets: splitInHalves(remaining).map((half) => ({
                    items: half,
                    mode: "wire",
                    stage: "isolate",
                    depth: nextDepth,
                })),
                keepSource: [],
            };
        }

        if (kind === "output-limit" || kind === "context-limit") {
            const splits = Number(meta?.splits) || 0;
            if (remaining.length > 1 && splits < RETRY_TABLE["output-limit"].maxSplits) {
                emit("output_limit_split");
                return {
                    packets: splitInHalves(remaining).map((half) => ({
                        items: half,
                        mode: "wire",
                        stage: "split",
                        splits: splits + 1,
                        depth: nextDepth,
                    })),
                    keepSource: [],
                };
            }
            return atomicStep({ depth }, remaining);
        }

        // schema/parse-invalid ladder (also the fallback for unknown policy kinds so the
        // session can never strand items): reinforced → bisection → per-block atomic.
        if (!stage) {
            emit("schema_reinforced_retry");
            return {
                packets: [
                    {
                        items: remaining,
                        mode: "wire",
                        stage: "reinforced",
                        depth: nextDepth,
                        hint: "reinforced-schema",
                    },
                ],
                keepSource: [],
            };
        }
        if (stage === "reinforced" && remaining.length > 1) {
            emit("schema_bisection");
            return {
                packets: splitInHalves(remaining).map((half) => ({
                    items: half,
                    mode: "wire",
                    stage: "bisect",
                    depth: nextDepth,
                    hint: "reinforced-schema",
                })),
                keepSource: [],
            };
        }
        return atomicStep({ depth }, remaining);
    };

    /**
     * Item-level ladders (spec §1.4 placeholder rows past local repair, §6 semantic row).
     * State lives on `entry.recovery` so an item keeps its rung across packets. Inputs:
     * `placeholder`: `[{ entry, translated }]`, `semantic`: `[entry]`. Output lists are
     * disjoint actions for the session: `retry` re-wires with a reinforced inventory
     * instruction, `flatten` strips tags into the dominant Text node (styling-only blocks),
     * `orderRetry` asks the provider to keep fixed DOM placeholders in source order,
     * `atomic` re-sends per-Text-node (any interactive wrapper), `semanticRetry` is the
     * items-only retry, `keepSource` is terminal.
     */
    const planItemFailures = ({ placeholder = [], semantic = [] } = {}) => {
        const plan = {
            retry: [],
            orderRetry: [],
            flatten: [],
            atomic: [],
            semanticRetry: [],
            keepSource: [],
        };
        for (const failure of placeholder) {
            const entry = failure?.entry;
            if (!entry) continue;
            const state = (entry.recovery = entry.recovery || {});
            if (!state.placeholderRetried) {
                state.placeholderRetried = true;
                emit("placeholder_retry");
                if (state.orderUnrepresentable) {
                    emit("inline_order_constrained_retry");
                    plan.orderRetry.push(entry);
                } else {
                    plan.retry.push(entry);
                }
            } else if (entry.hasInteractive) {
                if (!state.placeholderDegraded) {
                    state.placeholderDegraded = true;
                    emit("placeholder_atomic_degrade");
                    plan.atomic.push(entry);
                } else {
                    emit("keep_source_terminal");
                    state.terminalReason = state.orderUnrepresentable
                        ? "inline-order"
                        : "placeholder-invalid";
                    plan.keepSource.push(entry);
                }
            } else {
                // Flatten-accept never reaches interactive text by construction of the
                // branch above (§1.4(a)/(b)).
                emit("placeholder_flattened");
                plan.flatten.push({ entry, translated: failure.translated });
            }
        }
        for (const entry of semantic) {
            if (!entry) continue;
            const state = (entry.recovery = entry.recovery || {});
            if (!state.semanticRetried) {
                state.semanticRetried = true;
                emit("semantic_retry");
                plan.semanticRetry.push(entry);
            } else {
                emit("keep_source_terminal");
                state.terminalReason = "semantic-invalid";
                plan.keepSource.push(entry);
            }
        }
        return plan;
    };

    return {
        planWireFailure,
        planItemFailures,
        telemetry: () => ({ ...telemetry }),
    };
}

export {
    MAX_LADDER_DEPTH,
    RETRY_TABLE,
    SCHEDULER_RETRY_KINDS,
    TERMINAL_FAILURE_KINDS,
    createRecoveryController,
};
