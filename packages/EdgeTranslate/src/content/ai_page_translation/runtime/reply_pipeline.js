/**
 * Reply-side pipeline of the vNext session (spec §1.3 validation layers, §1.4 ladder
 * routing, §7 recovery wiring): unit consumption, chunk reassembly, atomic groups, the
 * placeholder/semantic buckets, wire-failure routing into runtime/recovery, and the entry
 * bookkeeping (finish / flatten / incomplete / alias fan-out). Split out of session.js so
 * the orchestrator stays inside its pinned ≤600-line budget (spec §8); every function takes
 * the session as its explicit first argument and is exercised through the session tests.
 */

import { stripPlaceholderTags, unarmorText } from "../dom/block_ir.js";
import { reassembleChunks } from "../ir/packet_builder.js";
import { normalizeSourceKey } from "./normalize.js";
import { restoreProtectedTokens } from "./protected_tokens.js";
import { SCHEDULER_RETRY_KINDS, TERMINAL_FAILURE_KINDS } from "./recovery.js";
import {
    applyAtomicSegments,
    commitEntryText,
    flattenCommit,
    usableUnit,
    validateEntryTranslation,
} from "./session_support.js";
import { KEEP_SOURCE_SENTINEL } from "./translation_cache.js";
import { validateTranslatedItem } from "./validator.js";

/**
 * Dedupe link: attaches `entry` under `key` as an alias of the live representative (mirroring
 * an already-applied translation immediately), or installs it as the representative. Returns
 * true when the entry became the representative and therefore needs its own packet.
 */
function linkDedupeEntry(session, entry, key) {
    const rep = session.repByKey.get(key);
    if (rep && rep !== entry && rep.status !== "failed" && rep.status !== "cancelled") {
        entry.rep = rep;
        rep.aliases.push(entry);
        if (rep.status === "applied") applyAliasNow(session, rep, entry);
        return false;
    }
    session.repByKey.set(key, entry);
    return true;
}

/**
 * Re-enters a revision-bumped entry into the dedupe graph (SPA mutation path). Its old
 * rep/alias links were built for the OLD text — fanning the refreshed representative's new
 * translation across aliases that still display the old text is the wrong-target-apply
 * class — so the entry detaches, relinks under its new key, and its still-pending aliases
 * re-enter planning independently (appended to `changed`).
 */
function relinkChangedEntry(session, entry, oldKey, changed) {
    if (entry.rep) {
        const siblings = entry.rep.aliases;
        const index = siblings.indexOf(entry);
        if (index >= 0) siblings.splice(index, 1);
        entry.rep = null;
    }
    if (session.repByKey.get(oldKey) === entry) session.repByKey.delete(oldKey);
    const detached = entry.aliases.splice(0);
    if (linkDedupeEntry(session, entry, normalizeSourceKey(entry.text, entry.role))) {
        changed.push(entry);
    }
    for (const alias of detached) {
        alias.rep = null;
        if (alias.status !== "pending") continue;
        if (linkDedupeEntry(session, alias, normalizeSourceKey(alias.text, alias.role))) {
            changed.push(alias);
        }
    }
}

/** Alias fan-out: mirror the representative's validated translation onto one alias. */
function applyAliasNow(session, rep, alias) {
    if (alias.status !== "pending") return;
    const committed = commitEntryText({
        entry: alias,
        text: rep.translation,
        keepSource: rep.keptSource,
        sessionId: session.sessionId,
        revision: alias.target.revision,
    });
    if (!committed) return;
    alias.status = "applied";
    session.counters.translated += 1;
    session.advance(alias.target.id, ["queued", "in_flight", "validated", "applied"], {
        appliedTranslation: rep.keptSource ? alias.target.source : rep.translation,
    });
    session.notifyApplied?.(alias, rep.translation, {
        keepSource: rep.keptSource,
        via: "dedupe",
    });
}

function applyCacheHits(session, entries, hits) {
    for (const entry of entries) {
        if (entry.status !== "pending") continue;
        const hit = hits.get(entry.target.id);
        if (typeof hit !== "string" || !hit) continue;
        const keepSource = hit === KEEP_SOURCE_SENTINEL;
        const committed =
            keepSource ||
            commitEntryText({
                entry,
                text: hit,
                keepSource: false,
                sessionId: session.sessionId,
                revision: entry.target.revision,
            });
        if (committed) {
            finishEntry(session, entry, keepSource ? entry.target.source : hit, keepSource, {
                skipCache: true,
                via: "cache",
            });
        }
    }
}

function finishEntry(
    session,
    entry,
    text,
    keepSource,
    { skipCache = false, via = "wire", degraded = false } = {}
) {
    entry.status = "applied";
    entry.translation = text;
    entry.keptSource = keepSource;
    session.counters.translated += 1;
    const states =
        via === "cache"
            ? ["cached", "validated", "applied"]
            : ["queued", "in_flight", "validated", "applied"];
    session.advance(entry.target.id, states, {
        appliedTranslation: keepSource ? entry.target.source : text,
    });
    session.notifyApplied?.(entry, text, { keepSource, via, degraded });
    if (!skipCache) {
        // Validated-only writes; "=" resolutions stay session-only (cache enforces it).
        session.cache.set(entry.target, keepSource ? KEEP_SOURCE_SENTINEL : text);
    }
    if (!keepSource && !degraded) {
        session.glossary.recordValidatedPair(entry.text.trim(), String(text).trim());
    }
    for (const alias of entry.aliases) {
        if (alias.status !== "pending") continue;
        if (degraded && alias.target.kind === "block" && alias.ir) {
            if (flattenCommit(alias.target, text, session.sessionId)) {
                alias.status = "applied";
                session.counters.translated += 1;
                session.advance(alias.target.id, ["queued", "in_flight", "validated", "applied"], {
                    appliedTranslation: text,
                });
                session.notifyApplied?.(alias, text, {
                    keepSource: false,
                    via: "dedupe",
                    degraded: true,
                });
            }
            continue;
        }
        applyAliasNow(session, entry, alias);
    }
}

/** §1.4(a) flatten-accept — never reaches interactive text (ladder routes those atomic). */
function applyFlatten(session, entry, translated) {
    const flat = unarmorText(stripPlaceholderTags(String(translated || ""))).trim();
    if (!flat || !flattenCommit(entry.target, flat, session.sessionId)) {
        markIncomplete(session, entry, "placeholder-invalid");
        return;
    }
    if (entry.recovery?.orderUnrepresentable) {
        session.bumpTelemetry("inline_order_flattened");
    }
    finishEntry(session, entry, flat, false, { skipCache: true, degraded: true });
}

const TERMINAL_STRING_REASONS = new Set([
    "attempt-ceiling",
    "atomic-invalid",
    "cancelled",
    "cas-conflict",
    "chunk-incomplete",
    "content-filter",
    "context-limit",
    "inline-order",
    "output-limit",
    "placeholder-invalid",
    "recovery-exhausted",
    "schema-invalid",
    "semantic-invalid",
    "session-aborted",
    "transport-exhausted",
]);

function boundedTerminalReason(reason) {
    const value = String(reason || "");
    return TERMINAL_STRING_REASONS.has(value) ? value : "recovery-exhausted";
}

/** Terminal keep-source: per-string honest incomplete counts, aliases included. */
function markIncomplete(session, entry, reason = "recovery-exhausted") {
    if (!entry || entry.status !== "pending") return;
    const boundedReason = boundedTerminalReason(reason);
    for (const record of [entry, ...entry.aliases]) {
        if (record.status !== "pending") continue;
        record.status = "failed";
        session.counters.failed += 1;
        session.ledger.recordIncompleteStrings(1);
        session.advance(record.target.id, ["failed_terminal"], { reason: boundedReason });
    }
}

function failUnresolvedItem(session, item, reason) {
    if (item.chunk) {
        const group = session.chunkGroups.get(item.chunk.parentId);
        if (group) {
            group.failed = true;
            session.chunkGroups.delete(item.chunk.parentId);
        }
    }
    if (item.atomicPart) item.entry.atomic = null;
    markIncomplete(session, item.entry, reason);
}

const CAPABILITY_DROP_REASONING_HINT = "capability-drop-reasoning";

function canDropReasoningOnce(session, packet, failure) {
    return Boolean(
        session.provider === "openai" &&
            !packet.recovery &&
            failure?.capabilityPatch?.reasoningControl?.value === "none"
    );
}

/**
 * OpenAI reasoning controls can be rejected by a model even when the model itself remains
 * usable. The provider adapter returns an explicit, validated capability patch for exactly
 * that case. Re-enter the normal scheduler with one visible recovery packet so usage,
 * request counts and the global attempt ceiling all observe the second HTTP request.
 *
 * A recovery packet is deliberately never nested inside another recovery ladder. A second
 * unsupported result, a missing patch, a non-OpenAI provider, or an unsupported result from
 * an existing schema/item recovery is a provider-configuration error and fails loudly.
 */
function routeUnsupportedCapability(session, packet, failure, unresolved) {
    if (canDropReasoningOnce(session, packet, failure)) {
        session.bumpTelemetry("capability_drop_reasoning_retry");
        session.enqueuePackets(
            session.makeRecoveryPackets(unresolved, {
                stage: CAPABILITY_DROP_REASONING_HINT,
                hint: CAPABILITY_DROP_REASONING_HINT,
                depth: 1,
            }),
            packet.queueTier ?? 0
        );
        return;
    }
    session.bumpTelemetry("unsupported_capability_terminal");
    session.handleCircuitOpen(failure);
}

function resolveEntryResult(
    session,
    entry,
    translated,
    keepSource,
    revision,
    buckets,
    protectedFidelityFailed = false
) {
    if (!entry || entry.status !== "pending") return;
    if (revision !== undefined && entry.target.revision !== revision) return; // stale reply
    if (protectedFidelityFailed && !keepSource) {
        // A dropped / duplicated / invented `<kN/>` is a placeholder-fidelity failure, not a
        // semantic one: the protected VALUE was never exposed to the model, so re-sending the
        // naked identifier would be pointless and is exactly the paid retry class this masking
        // removes. Route it into the bounded §1.4 placeholder ladder (local repair → reinforced
        // retry → flatten/atomic → keep-source); keep-source preserves the value verbatim from
        // the source. This never loops and never costs a naked identifier retry.
        session.bumpTelemetry("protected_token_restore_failed");
        buckets.placeholder.push({ entry, translated });
        return;
    }
    const verdict = validateEntryTranslation({
        entry,
        translated,
        keepSource,
        targetLanguage: session.targetLanguage,
        onTelemetry: (name) => session.bumpTelemetry(name),
    });
    if (verdict.ok) {
        const committed = commitEntryText({
            entry,
            text: verdict.text,
            keepSource,
            sessionId: session.sessionId,
            revision,
        });
        // A CAS miss stays pending only while the session-owned immediate recollection runs.
        // This does not rely solely on MutationObserver delivery: frameworks can win the CAS
        // race before the observer callback reaches us.
        if (committed) {
            finishEntry(
                session,
                entry,
                keepSource ? entry.target.source : verdict.text,
                keepSource
            );
        } else {
            session.handleCommitMiss?.(entry);
        }
        return;
    }
    if (verdict.placeholderFailure) buckets.placeholder.push({ entry, translated: verdict.text });
    else buckets.semantic.push(entry);
}

function consumeAtomicPart(session, item, translated, keepSource) {
    const entry = item.entry;
    const group = entry.atomic;
    if (
        !group ||
        item.revision !== group.revision ||
        item.revision !== entry.revision ||
        item.revision !== entry.target.revision ||
        group.results.has(item.atomicPart.index)
    ) {
        return;
    }
    let text = null;
    if (keepSource) {
        text = item.text;
    } else {
        const verdict = validateTranslatedItem(
            { source: item.text, translated },
            { targetLanguage: session.targetLanguage }
        );
        if (verdict.verdict !== "fail") text = translated;
    }
    group.results.set(item.atomicPart.index, text);
    if (group.results.size < group.expected) return;
    entry.atomic = null;
    if (entry.status !== "pending" || entry.target.revision !== group.revision) return;
    const result = applyAtomicSegments({ entry, group, sessionId: session.sessionId });
    if (result.applied && result.allOk) {
        finishEntry(session, entry, result.text, false, { skipCache: true, degraded: true });
    } else {
        markIncomplete(session, entry, "atomic-invalid");
    }
}

function consumeUnit(session, packet, unit, resolved, buckets) {
    const item = unit && packet.itemById.get(unit.id);
    if (!item || resolved.has(unit.id)) return;
    // A framework can revise the same registry target while this provider request is in
    // flight. Stale replies are fully consumed as no-ops: they must neither write into a
    // replacement chunk/atomic group nor enter recovery with old source under a new revision.
    if (item.revision !== item.entry.revision || item.revision !== item.entry.target.revision) {
        resolved.add(unit.id);
        return;
    }
    if (!usableUnit(unit)) return; // failed/invalid units stay unresolved for recovery
    resolved.add(unit.id);
    const keepSource = unit.keepSource === true || unit.status === "unchanged";
    // Restore protected tokens locally BEFORE any validation / block apply, so the byte-exact
    // tiers see verbatim values (including the "=" sentinel, whose source echo was masked). A
    // genuinely missing / duplicated / invented `<kN/>` sets protectedFidelityFailed for the
    // bounded placeholder ladder; a merely reordered-but-complete set restores fine.
    const restore = restoreProtectedTokens(String(unit.translatedText ?? ""), item.protectedMap);
    const translated = restore.restored;
    const protectedFidelityFailed = restore.ok === false && !keepSource;
    if (item.chunk) {
        const group = session.chunkGroups.get(item.chunk.parentId);
        if (
            !group ||
            group.entry !== item.entry ||
            group.revision !== item.revision ||
            group.failed ||
            group.results.has(item.chunk.chunkIndex)
        ) {
            return;
        }
        if (protectedFidelityFailed) group.protectedFailed = true;
        group.results.set(item.chunk.chunkIndex, {
            id: item.id,
            chunk: item.chunk,
            translatedText: keepSource ? item.text : translated,
        });
        if (group.results.size < group.expected) return;
        session.chunkGroups.delete(item.chunk.parentId);
        const [assembled] = reassembleChunks(Array.from(group.results.values()));
        // All-or-nothing reassembly: the block commits only when every chunk arrived.
        if (assembled?.ok) {
            if (group.atomicPart) {
                consumeAtomicPart(
                    session,
                    {
                        entry: group.entry,
                        atomicPart: group.atomicPart,
                        text: group.sourceText,
                        revision: group.revision,
                    },
                    assembled.text,
                    false
                );
            } else {
                resolveEntryResult(
                    session,
                    group.entry,
                    assembled.text,
                    false,
                    group.revision,
                    buckets,
                    group.protectedFailed === true
                );
            }
        } else {
            markIncomplete(session, group.entry, "chunk-incomplete");
        }
        return;
    }
    if (item.atomicPart) {
        consumeAtomicPart(session, item, translated, keepSource);
        return;
    }
    resolveEntryResult(
        session,
        item.entry,
        translated,
        keepSource,
        item.revision,
        buckets,
        protectedFidelityFailed
    );
}

/** Item-level §1.4 / semantic ladder actions planned by runtime/recovery. */
function processItemBuckets(session, packet, buckets) {
    if (!buckets.placeholder.length && !buckets.semantic.length) return;
    const plan = session.recovery.planItemFailures(buckets);
    const tier = packet.queueTier ?? 0;
    const wireItem = (entry) => ({
        id: entry.id,
        text: entry.text,
        role: entry.role,
        entry,
        revision: entry.target.revision,
    });
    for (const { entry, translated } of plan.flatten) applyFlatten(session, entry, translated);
    for (const entry of plan.keepSource) {
        markIncomplete(session, entry, entry.recovery?.terminalReason);
    }
    if (plan.retry.length) {
        const meta = { stage: "placeholder-retry", hint: "reinforced-inventory", depth: 1 };
        session.enqueuePackets(session.makeRecoveryPackets(plan.retry.map(wireItem), meta), tier);
    }
    if (plan.orderRetry.length) {
        const meta = { stage: "placeholder-order-retry", hint: "reinforced-order", depth: 1 };
        session.enqueuePackets(
            session.makeRecoveryPackets(plan.orderRetry.map(wireItem), meta),
            tier
        );
    }
    for (const entry of plan.atomic) {
        session.enqueueAtomicPacket(
            entry,
            { stage: "atomic", hint: "reinforced-atomic", depth: 1 },
            tier
        );
    }
    if (plan.semanticRetry.length) {
        const meta = { stage: "semantic-retry", hint: "reinforced-semantic", depth: 1 };
        session.enqueuePackets(
            session.makeRecoveryPackets(plan.semanticRetry.map(wireItem), meta),
            tier
        );
    }
}

/** Wire-level §7 routing: shrink still-unresolved items through the recovery ladders. */
function routeWireFailure(session, packet, outcome, resolved) {
    const kind = outcome.failure?.kind || null;
    const unresolved = packet.items.filter((item) => {
        if (resolved.has(item.id)) return false;
        if (item.revision !== item.entry.revision || item.revision !== item.entry.target.revision) {
            return false;
        }
        if (item.chunk) {
            const group = session.chunkGroups.get(item.chunk.parentId);
            return Boolean(
                group &&
                    group.entry === item.entry &&
                    group.revision === item.revision &&
                    !group.failed &&
                    !group.results.has(item.chunk.chunkIndex)
            );
        }
        if (item.atomicPart) {
            const group = item.entry.atomic;
            return Boolean(
                group &&
                    group.revision === item.revision &&
                    !group.results.has(item.atomicPart.index)
            );
        }
        return item.entry.status === "pending";
    });
    if (!unresolved.length) return;
    if (outcome.aborted === true || kind === "attempt-ceiling") {
        // Circuit/stop aborts and the global attempt ceiling are dispatch-boundary
        // terminals: routing them into a recovery ladder would enqueue packets the open
        // circuit can never dispatch. Honest per-string counts instead.
        for (const item of unresolved) {
            failUnresolvedItem(
                session,
                item,
                kind === "attempt-ceiling" ? kind : "session-aborted"
            );
        }
        return;
    }
    if (kind === "unsupported-capability") {
        routeUnsupportedCapability(session, packet, outcome.failure, unresolved);
        return;
    }
    if (
        kind &&
        (kind === "cancelled" ||
            SCHEDULER_RETRY_KINDS.has(kind) ||
            TERMINAL_FAILURE_KINDS.has(kind))
    ) {
        // Transport-class retries were the scheduler's job and are exhausted here;
        // terminal kinds are settled by the circuit path. An active-session provider
        // cancellation is terminal too; user/session stop was already filtered at the entry
        // point, so leaving it pending here would strand completion forever.
        const reason = SCHEDULER_RETRY_KINDS.has(kind)
            ? "transport-exhausted"
            : kind === "cancelled"
            ? "cancelled"
            : "session-aborted";
        for (const item of unresolved) failUnresolvedItem(session, item, reason);
        return;
    }
    const policyKind =
        kind === "output-limit" || kind === "context-limit" || kind === "content-filter"
            ? kind
            : "schema-invalid";
    const plan = session.recovery.planWireFailure(packet.recovery, policyKind, unresolved);
    for (const descriptor of plan.packets) {
        if (descriptor.mode === "atomic") {
            session.enqueueAtomicPacket(
                descriptor.items[0].entry,
                descriptor,
                packet.queueTier ?? 0
            );
        } else {
            session.enqueuePackets(
                session.makeRecoveryPackets(descriptor.items, descriptor),
                packet.queueTier ?? 0
            );
        }
    }
    for (const item of plan.keepSource) failUnresolvedItem(session, item, policyKind);
}

/** Entry point the scheduler's onSettled feeds; DOM writes run under watcher.pause. */
function handleSettledOutcome(session, packet, outcome) {
    if (session.finalized || session.stopped) return;
    if (!outcome || outcome.status === "cancelled") return;
    const resolved = new Set();
    const buckets = { placeholder: [], semantic: [] };
    session.watcher.pause(() => {
        for (const unit of outcome.units || []) {
            consumeUnit(session, packet, unit, resolved, buckets);
        }
        processItemBuckets(session, packet, buckets);
    });
    routeWireFailure(session, packet, outcome, resolved);
    session.maybeComplete();
    session.emitStatus();
}

/**
 * Apply only fully closed, ID-mapped stream items. Invalid partial items deliberately stay
 * pending until the authoritative final reply can validate them or route bounded recovery.
 */
function handleStreamingUnits(session, packet, units) {
    if (session.finalized || session.stopped || !Array.isArray(units) || !units.length) return 0;
    const translatedBefore = session.counters.translated;
    const resolved = new Set();
    const buckets = { placeholder: [], semantic: [] };
    session.watcher.pause(() => {
        for (const unit of units) consumeUnit(session, packet, unit, resolved, buckets);
    });
    const applied = Math.max(0, session.counters.translated - translatedBefore);
    if (applied > 0) {
        session.bumpTelemetry("stream_items_applied", applied);
        session.maybeComplete();
        session.emitStatus();
    }
    return applied;
}

export {
    applyAliasNow,
    applyCacheHits,
    finishEntry,
    handleSettledOutcome,
    handleStreamingUnits,
    linkDedupeEntry,
    markIncomplete,
    relinkChangedEntry,
};
