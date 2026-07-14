/**
 * Session orchestration for the vNext AI page translation engine (§2 whole-page planning, §3
 * scheduling surface, §7 resilience wiring). Orchestration ONLY — mechanism lives in the
 * composed modules: dom/{collector,block_ir,committer,target_registry,mutation_watcher},
 * ir/{estimator,packet_builder}, runtime/{translation_cache,usage_ledger,glossary,
 * validator,recovery,transport_client}, with the packet/apply glue in
 * runtime/session_support and the reply-side pipeline in runtime/reply_pipeline. The
 * scheduler and priority queue are injected factories conforming to the pinned C1 contract.
 *
 * Timeline: t=0 session created and capability fetch starts; one layout-free DOM walk collects
 * the whole page; cache lookup gets at most 150ms; the frozen session context is built once;
 * every cache miss is packed into large drain packets and dispatched through the same bounded
 * scheduler. There is no viewport/focus lane, second collection pass, reveal promotion or
 * countTokens round-trip. Late content rejoins the same drain policy.
 */

import { collectPage, collectSubtreeTargets } from "../dom/collector.js";
import { AI_PAGE_PROVIDER_AIMD } from "common/scripts/ai_page_translation_limits.js";
import { MutationWatcher } from "../dom/mutation_watcher.js";
import { TargetRegistry } from "../dom/target_registry.js";
import { createEstimator, estIn } from "../ir/estimator.js";
import { isAlreadyInTargetLanguage } from "../../dom_page_translate_context.js";
import { PAGE_TRANSLATION_PROMPT_VERSION } from "@edge_translate/translators";
import { createPageGlossary } from "./glossary.js";
import { normalizeSourceKey } from "./normalize.js";
import { RETRY_TABLE, TERMINAL_FAILURE_KINDS, createRecoveryController } from "./recovery.js";
import {
    applyCacheHits,
    handleSettledOutcome,
    linkDedupeEntry,
    markIncomplete,
    relinkChangedEntry,
} from "./reply_pipeline.js";
import {
    buildAtomicItems,
    buildEntryPackets,
    buildRecoveryPackets,
    makeEntry,
    refreshEntry,
    sumSizes,
    usableUnit,
} from "./session_support.js";
import { PageTranslationCache } from "./translation_cache.js";
import { createTransportClient } from "./transport_client.js";
import { createUsageLedger } from "./usage_ledger.js";

// Pinned in tools/vnext-gates/config.json (scheduling / concurrencyAimd sections).
const FIRST_PACKET_GATE_MS = 150;
const CONCURRENCY_AIMD = Object.freeze({
    ...AI_PAGE_PROVIDER_AIMD,
    multiplicativeDecrease: 0.5,
    backoff: Object.freeze({ baseMs: 500, factor: 2, jitter: 0.2, capMs: 15000 }),
});

let sessionSequence = 0;

function createSessionId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    sessionSequence += 1;
    return `page-v3-${Date.now().toString(36)}-${sessionSequence.toString(36)}`;
}

class AiPageTranslationSession {
    constructor(options = {}) {
        const deps = options.deps || {};
        if (typeof deps.createScheduler !== "function") {
            throw new TypeError("AiPageTranslationSession requires deps.createScheduler");
        }
        if (typeof deps.createPriorityQueue !== "function") {
            throw new TypeError("AiPageTranslationSession requires deps.createPriorityQueue");
        }
        this.deps = deps;
        this.channel = options.channel || null;
        this.root = options.root || (typeof document !== "undefined" ? document.body : null);
        this.sourceLanguage = options.sourceLanguage || "auto";
        this.targetLanguage = options.targetLanguage || "en";
        this.provider = options.engine || options.provider || "openai";
        this.providerProfileId = options.providerProfileId || "page-translation";
        this.title = options.title ?? (typeof document !== "undefined" ? document.title || "" : "");
        this.domain =
            options.domain ?? (typeof location !== "undefined" ? location.hostname || "" : "");
        this.onStatus = typeof options.onStatus === "function" ? options.onStatus : null;
        this.collectorOptions = { ...(options.collector || {}) };
        this.skipAlreadyTargetLanguage = options.skipAlreadyTargetLanguage !== false;
        this.sessionId = options.sessionId || createSessionId();
        this.registry = new TargetRegistry(this.sessionId);
        this.ledger = createUsageLedger({ onRunaway: () => this._onRunaway() });
        this.estimator = createEstimator({
            sl: this.sourceLanguage,
            tl: this.targetLanguage,
            provider: this.provider,
        });
        this.cache =
            options.cache ||
            new PageTranslationCache({
                channel: this.channel,
                sourceLanguage: this.sourceLanguage,
                targetLanguage: this.targetLanguage,
                model: String(options.modelId || ""),
                promptVersion: PAGE_TRANSLATION_PROMPT_VERSION,
                qualityTier: 1,
            });
        this.glossary = createPageGlossary({ channel: this.channel });
        this.recovery = createRecoveryController({
            onTelemetry: (name, count) => this.bumpTelemetry(name, count),
        });
        this.watcher = new MutationWatcher({
            registry: this.registry,
            onNewContent: (roots) => this.onNewContent(roots),
            onChangedTarget: (target) => this.onChangedTarget(target),
        });
        Object.assign(this, {
            entries: new Map(),
            repByKey: new Map(),
            chunkGroups: new Map(),
            counters: { total: 0, translated: 0, failed: 0 },
            telemetry: {},
            timers: [],
            phase: "idle",
            failure: null,
            started: false,
            finalized: false,
            stopped: false,
            fullDocDone: false,
            pendingAsync: 0,
            packetSequence: 0,
            enqueuedPacketCount: 0,
            initialWorkUnitCount: 0,
            dispatchCount: 0,
            plannedTotal: 0,
            ctx: null,
            ctxTokens: 0,
            capabilities: null,
            queue: null,
            scheduler: null,
            transport: null,
            ingestChain: Promise.resolve(),
            runtimeReady: false,
            bufferedMutationRoots: new Set(),
        });
    }

    bumpTelemetry(name, count = 1) {
        this.telemetry[name] = (this.telemetry[name] || 0) + (Number(count) || 1);
    }

    advance(targetId, states, metadata = {}) {
        const target = this.registry.get(targetId);
        if (!target) return;
        for (const state of states) {
            if (target.state === state) continue;
            try {
                this.registry.transition(targetId, state, metadata);
            } catch {
                return;
            }
        }
    }

    async start() {
        if (this.started) return this.getStatusSnapshot();
        this.started = true;
        this.pendingAsync += 1;
        this.phase = "collecting";
        this.emitStatus();
        try {
            this.transport =
                this.deps.transportClient ||
                createTransportClient({
                    channel: this.channel,
                    sessionId: this.sessionId,
                    providerProfileId: this.providerProfileId,
                    provider: this.provider,
                    sourceLanguage: this.sourceLanguage,
                    targetLanguage: this.targetLanguage,
                });
            const capabilitiesPromise = this.transport.getCapabilities();
            const collect = this.deps.collectPage || collectPage;
            const collected = collect(this.root, this.registry, this.collectorOptions);
            this.collectorStats = collected.stats;
            const { fresh } = this.registerEntries(collected.viewportTargets);
            this.fullDocDone = true;
            // Observe immediately after the single initial walk. Hydration can mutate the DOM
            // while capabilities/cache/context are still resolving; those roots are buffered
            // until the queue and immutable session context are ready.
            this.watcher.start([this.root]);

            // Start the immutable ctx in parallel with cache/capability work. The glossary seed
            // reuses the one whole-document walk and the store read owns the same 150ms upper
            // bound as cache prefetch. A late store reply never mutates ctx.
            const contextSeedBlocks = collected.contextSeedBlocks?.length
                ? collected.contextSeedBlocks
                : fresh.map((entry) => entry.text);
            const contextPromise = this.glossary.buildSessionContext({
                title: this.title,
                domain: this.domain,
                sl: this.sourceLanguage,
                tl: this.targetLanguage,
                blocks: contextSeedBlocks,
                storeReadTimeoutMs: FIRST_PACKET_GATE_MS,
            });

            // Persistent cache gets ≤150ms to answer; a cold/broken IDB cannot block dispatch.
            const prefetch = this.cache
                .getMany(fresh.map((entry) => entry.target))
                .catch(() => new Map());
            const gate = new Promise((resolve) => {
                this.timers.push(setTimeout(() => resolve(null), FIRST_PACKET_GATE_MS));
            });

            let capabilities;
            try {
                capabilities = await capabilitiesPromise;
            } catch (error) {
                this.failure = { kind: "capabilities", message: error?.message || String(error) };
                this.finalizeSession("error");
                return this.getStatusSnapshot();
            }
            if (this.finalized) return this.getStatusSnapshot();
            this.capabilities = capabilities || {};
            this.queue = this.deps.createPriorityQueue({});
            this.scheduler = this.deps.createScheduler({
                limiterKey: this.capabilities.limiterKey || this.providerProfileId,
                provider: this.provider,
                aimd: CONCURRENCY_AIMD,
                retryTable: RETRY_TABLE,
                dispatch: (packet, attemptMeta) => this.dispatchPacket(packet, attemptMeta),
                onSettled: (packet, outcome) => handleSettledOutcome(this, packet, outcome),
                onCircuitOpen: (failure) => this.handleCircuitOpen(failure),
                onTelemetry: (name, count) => this.bumpTelemetry(name, count),
                queue: this.queue,
                // Global attempt ceiling (spec §7): 3× the initial work-unit budget, with a small floor
                // so a one-packet page can still spend its per-class §7 bounds (≤3
                // transient retries = 4 attempts; schema ladder = 3 requests).
                // Recovery packets never expand this ceiling. The base is the number of
                // original work units (not the number of recovery descendants), preserving
                // enough room for the bounded per-block schema ladder while preventing a
                // recovery-enqueue loop from manufacturing fresh global budget.
                maxTotalAttempts: () => Math.max(6, 3 * this.initialWorkUnitCount),
            });

            const hits = (await Promise.race([prefetch, gate])) || new Map();
            if (this.finalized) return this.getStatusSnapshot();
            this.watcher.pause(() => applyCacheHits(this, fresh, hits));

            // ctx is built ONCE over the collected blocks and frozen byte-identically for every
            // packet of the session.
            this.ctx = await contextPromise;
            if (this.finalized) return this.getStatusSnapshot();
            this.ctxTokens = estIn(JSON.stringify(this.ctx));

            // Plan once from the complete target set. Large drain packets amortize the static
            // prompt/context while the output-token ceiling still bounds model latency and
            // truncation risk. All packets share one priority; reading position never changes
            // which strings are translated.
            let packets;
            try {
                packets = this.buildTierPackets(fresh, "drain");
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                // Capability/profile ceilings can make even the smallest packet impossible once
                // fixed prompt + frozen ctx are included. This is a zero-provider-call terminal
                // configuration failure, not a retryable translation miss. Finalizing here tears
                // down the startup watcher/scheduler so later SPA mutations cannot overwrite the
                // error phase or manufacture work after the planner refused dispatch.
                this.failure = {
                    kind: "planner-capability",
                    message: error?.message || String(error),
                };
                this.finalizeSession("error");
                return this.getStatusSnapshot();
            }
            this.phase = "translating";
            if (packets.length) this.enqueuePackets(packets, 1);
            this.runtimeReady = true;
            this.flushBufferedMutationRoots();
            this.emitStatus();
            return this.getStatusSnapshot();
        } catch (error) {
            // Unexpected startup defects remain observable to the caller, but the session still
            // owns terminal cleanup before rethrowing. The product adapter's promise catch may
            // add diagnostics; it must never inherit a live watcher or a misleading running phase.
            if (!this.finalized) {
                this.failure = {
                    kind: "session-start",
                    message: error?.message || String(error),
                };
                this.finalizeSession("error");
            }
            throw error;
        } finally {
            this.pendingAsync -= 1;
            this.maybeComplete();
        }
    }

    stop(reason = "user-cancelled") {
        if (this.finalized) return this.getStatusSnapshot();
        this.stopped = true;
        this.finalized = true;
        this.phase = "cancelled";
        this.teardown(reason);
        for (const entry of this.entries.values()) {
            if (entry.status !== "pending") continue;
            entry.status = "cancelled";
            this.advance(entry.target.id, ["canceled"], { reason });
        }
        this.emitStatus();
        return this.getStatusSnapshot();
    }

    teardown(reason) {
        for (const timer of this.timers.splice(0)) clearTimeout(timer);
        this.watcher.stop();
        this.scheduler?.stop?.(reason);
        this.queue?.stop?.();
        this.transport?.cancel?.({ reason });
        this.runtimeReady = false;
        this.bufferedMutationRoots.clear();
    }

    finalizeSession(phase) {
        if (this.finalized) return;
        this.finalized = true;
        this.phase = phase;
        this.teardown(this.failure?.kind || phase);
        for (const entry of this.entries.values()) {
            if (entry.status !== "pending") continue;
            entry.status = "failed";
            this.counters.failed += 1;
            if (phase !== "error") this.ledger.recordIncompleteStrings(1);
            this.advance(entry.target.id, ["failed_terminal"], {
                reason: this.failure?.kind || phase,
            });
        }
        this.emitStatus();
    }

    handleCircuitOpen(failure) {
        if (this.finalized) return;
        this.failure = failure || { kind: "unknown" };
        // Fail LOUD on provider-configuration circuits (auth/quota/model), honest
        // per-string incomplete counts on operational circuits (spec §7).
        this.finalizeSession(
            TERMINAL_FAILURE_KINDS.has(this.failure.kind) ? "error" : "incomplete"
        );
    }

    _onRunaway() {
        if (this.finalized) return;
        this.failure = { kind: "runaway-latch" };
        this.bumpTelemetry("runaway_latch");
        this.finalizeSession("incomplete");
    }

    /**
     * Registers collected targets as session entries with normalizeSourceKey dedupe and
     * representative/alias fan-out (the proven v2 part: aliases mirror the representative's
     * validated translation, never dispatch their own). Revision bumps on known targets —
     * refresh the entry in place, re-enter it (and its detached still-pending aliases) into the
     * dedupe graph under the NEW text, and return everything needing re-planning in `changed`.
     */
    registerEntries(list) {
        const fresh = [];
        const changed = [];
        for (const record of Array.isArray(list) ? list : []) {
            const target = record?.target;
            if (!target) continue;
            const existing = this.entries.get(target.id);
            if (
                !existing &&
                this.skipAlreadyTargetLanguage &&
                isAlreadyInTargetLanguage(target.source, this.targetLanguage, this.sourceLanguage)
            ) {
                // High-confidence script heuristic only; shared-script mixed languages stay
                // eligible. Track the skipped target so a later SPA source-language rewrite
                // is discovered and can join this same session.
                this.watcher.track(target);
                this.advance(target.id, ["skipped_policy"], {
                    reason: "already-target-language",
                });
                if (this.collectorStats) {
                    const skipped = (this.collectorStats.skippedByReason ||= {});
                    skipped["already-target-language"] =
                        Number(skipped["already-target-language"] || 0) + 1;
                }
                continue;
            }
            if (existing) {
                if (target.revision !== existing.revision) {
                    if (existing.status === "applied") this.counters.translated -= 1;
                    if (existing.status === "failed") {
                        this.counters.failed -= 1;
                        this.ledger.resolveIncompleteStrings(1);
                    }
                    for (const [groupId, group] of this.chunkGroups) {
                        if (group?.entry === existing) this.chunkGroups.delete(groupId);
                    }
                    const oldKey = normalizeSourceKey(existing.text, existing.role);
                    refreshEntry(existing, record);
                    this.watcher.track(target); // revised blocks may capture new Text nodes
                    relinkChangedEntry(this, existing, oldKey, changed);
                }
                continue;
            }
            const entry = makeEntry(record, this.entries.size);
            this.entries.set(entry.id, entry);
            this.watcher.track(target);
            this.counters.total += 1;
            if (linkDedupeEntry(this, entry, normalizeSourceKey(entry.text, entry.role))) {
                fresh.push(entry);
            }
        }
        return { fresh, changed };
    }

    buildTierPackets(entries, tier) {
        return buildEntryPackets({
            entries,
            tier,
            provider: this.provider,
            estimator: this.estimator,
            capabilities: this.capabilities,
            ctxTokens: this.ctxTokens,
            chunkGroups: this.chunkGroups,
            nextId: () => `pkt${++this.packetSequence}`,
        });
    }

    makeRecoveryPackets(items, meta) {
        const sourceItems = (items || []).filter(Boolean);
        const build = (subset) => {
            try {
                return buildRecoveryPackets({
                    items: subset,
                    meta,
                    provider: this.provider,
                    estimator: this.estimator,
                    ctxTokens: this.ctxTokens,
                    capabilities: this.capabilities,
                    chunkGroups: this.chunkGroups,
                    nextId: () => `pkt${++this.packetSequence}`,
                });
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                if (subset.length > 1) {
                    // Isolate a locally impossible item without sacrificing its healthy packet
                    // siblings. This performs only bounded local planning; it adds no provider
                    // calls and each recursive child is strictly smaller.
                    const middle = Math.ceil(subset.length / 2);
                    this.bumpTelemetry("recovery_plan_bisection");
                    return build(subset.slice(0, middle)).concat(build(subset.slice(middle)));
                }

                // A provider receipt can tighten the estimator EMA after the original packet was
                // accepted. If even a one-token singleton recovery can no longer fit the observed
                // context, terminate that entry honestly instead of throwing out of onSettled and
                // leaving the session permanently pending.
                if (error.code === "recovery-chunk-amplification") {
                    this.bumpTelemetry("recovery_plan_amplification");
                }
                if (error.code === "recovery-indivisible-rechunk") {
                    this.bumpTelemetry("recovery_plan_indivisible");
                }
                const entry = subset[0]?.entry;
                if (entry) {
                    for (const [groupId, group] of this.chunkGroups) {
                        if (group?.entry === entry) this.chunkGroups.delete(groupId);
                    }
                    entry.atomic = null;
                    markIncomplete(this, entry, "context-limit");
                }
                this.bumpTelemetry("recovery_plan_context_limit");
                return [];
            }
        };
        return sourceItems.length ? build(sourceItems) : [];
    }

    enqueuePackets(packets, queueTier) {
        if (this.finalized || !packets.length) return;
        for (const packet of packets) {
            packet.queueTier = queueTier;
            this.enqueuedPacketCount += 1;
            if (!packet.recovery) {
                this.initialWorkUnitCount += Math.max(1, packet.items?.length || 0);
                this.plannedTotal += packet.estIn + packet.estOut;
            }
            for (const item of packet.items) {
                this.advance(item.entry.target.id, ["queued"]);
            }
            this.queue.push(packet, queueTier);
        }
        this.ledger.setPlannedEstimate(this.plannedTotal);
        this.scheduler.notifyEnqueued();
    }

    enqueueAtomicPacket(entry, meta, queueTier) {
        if (entry.status !== "pending") return;
        this.enqueuePackets(this.makeRecoveryPackets(buildAtomicItems(entry), meta), queueTier);
    }

    // Outcome shape carries both `ok` (boolean, what the C1 scheduler classifies on) and
    // `status` ("ok" | "failed" | "cancelled") so either consumer reads it unambiguously.
    async dispatchPacket(packet, attemptMeta = {}) {
        const cancelled = () => ({
            ok: false,
            status: "cancelled",
            failure: { kind: "cancelled" },
            units: [],
            resolvedCount: 0,
        });
        if (this.finalized || this.stopped) return cancelled();
        this.dispatchCount += 1;
        // A hedge attempt (spec §2.3 tail control) re-sends the same payload under a distinct
        // wire packetId so the background issues a genuinely new provider generation instead of
        // joining the in-flight straggler.
        const hedge = attemptMeta.hedge === true;
        let reply;
        try {
            reply = await this.transport.translatePacket({
                packetId: packet.id,
                items: packet.wireItems,
                maxOutputTokens: packet.maxOutputTokens,
                ctx: this.ctx,
                hint: packet.hint,
                attempt: attemptMeta.attempt || 0,
                hedge,
            });
        } catch (error) {
            // The provider may have completed and the background may even hold a replayable
            // success while only the content-channel response was lost. Record one conservative
            // estimated execution now; a subsequent cached replay reports attemptCount=0 and
            // cannot erase or double-charge this unknown owner request. A hedge that LOST the
            // race (its sibling already settled the winner's usage) never books this charge —
            // billing both attempts would double-count one logical packet.
            if (attemptMeta.hedgeLost !== true) {
                this.settleUsage(
                    packet,
                    {
                        actualAttemptCount: 1,
                        usageReceipts: [],
                        costAttribution: "delivery-unknown",
                    },
                    attemptMeta
                );
            }
            return {
                ok: false,
                status: "failed",
                failure: {
                    kind: "delivery-unknown",
                    message: error?.message || String(error),
                    requestMayHaveExecuted: true,
                },
                units: [],
                resolvedCount: 0,
            };
        }
        // The hedge LOSER's receipt is DISCARDED: the winning sibling already settled this
        // logical packet's usage, so settling the loser too would double-count one packet. The
        // ledger therefore reflects the winner only; the banner may under-report by the loser's
        // tokens (the provider still bills that generation) — accepted and honest, never summed.
        if (attemptMeta.hedgeLost !== true) {
            this.settleUsage(packet, reply, attemptMeta);
        }
        if (this.finalized || this.stopped) return cancelled();
        return {
            ok: reply.ok === true,
            status: reply.ok ? "ok" : "failed",
            failure: reply.failure || null,
            units: reply.units,
            usageReceipts: reply.usageReceipts,
            costAttribution: reply.costAttribution,
            resolvedCount: reply.units.filter(usableUnit).length,
        };
    }

    settleUsage(packet, reply, attemptMeta = {}) {
        // The ledger owns billingEventId dedupe: a delivery-unknown replay that arrives
        // with usage NOT stripped is still charged at most once. Recovery packets may need a
        // conservative missing-usage charge, but contribute zero fresh calibration estimate,
        // so amplification widens the runaway-latch gap instead of raising the projection.
        const hasReportedAttempts =
            reply.actualAttemptCount !== null && reply.actualAttemptCount !== undefined;
        const reportedAttempts = hasReportedAttempts ? Number(reply.actualAttemptCount) : NaN;
        const requestCount =
            Number.isFinite(reportedAttempts) && reportedAttempts >= 0
                ? Math.floor(reportedAttempts)
                : attemptMeta.replay
                ? 0
                : 1;
        this.ledger.settle(packet.id, reply.usageReceipts, {
            // Every provider execution consumes tokens even when its API omits usage. Use
            // the packet estimate conservatively in that case; idempotent reused replies
            // report/derive requestCount=0 and therefore remain free of double charging.
            chargeEstimateOnMissing: requestCount > 0,
            estimatedTokens: packet.estIn + packet.estOut,
            calibrationEstimatedTokens: packet.recovery ? 0 : packet.estIn + packet.estOut,
            requestCount,
            costAttribution: reply.costAttribution,
        });
        for (const receipt of reply.usageReceipts || []) {
            this.estimator.recordReceipt(receipt, {
                estInTokens: packet.estIn,
                estOutTokens: packet.estOut,
            });
        }
    }

    bufferMutationRoots(roots) {
        for (const root of Array.isArray(roots) ? roots : [roots]) {
            if (root) this.bufferedMutationRoots.add(root);
        }
    }

    onNewContent(roots) {
        if (this.finalized) return;
        if (!this.runtimeReady) {
            this.bufferMutationRoots(roots);
            return;
        }
        this.ingestRoots(roots, 1);
    }

    flushBufferedMutationRoots() {
        if (!this.runtimeReady || this.finalized || !this.bufferedMutationRoots.size) return;
        const roots = Array.from(this.bufferedMutationRoots);
        this.bufferedMutationRoots.clear();
        this.ingestRoots(roots, 1);
    }

    onChangedTarget(target) {
        if (this.finalized) return;
        // Stage-B risk 1: changed blocks are never re-sourced from the raw registry
        // refresh — the region goes back through collectSubtreeTargets so the serialized
        // source and per-node paths heal and the revision bumps consistently.
        const node =
            target?.kind === "block"
                ? target.textNodes?.[0]?.nodeRef?.deref?.() || null
                : target?.nodeRef?.deref?.() || null;
        const root = node ? node.parentElement || node : null;
        if (!root) return;
        if (!this.runtimeReady) {
            this.bufferMutationRoots([root]);
            return;
        }
        this.ingestRoots([root], 1);
    }

    /**
     * A validator-accepted reply can still lose the CAS race to a framework render. Recollect
     * immediately instead of waiting for a MutationObserver record that may already have been
     * coalesced or missed. If recollection cannot revise/re-plan the entry, terminate it
     * honestly so a pending entry cannot strand the session forever.
     */
    handleCommitMiss(entry) {
        if (this.finalized || !entry || entry.status !== "pending") return;
        this.bumpTelemetry("cas_commit_miss");
        const revision = entry.target.revision;
        const node =
            entry.target.kind === "block"
                ? entry.target.textNodes?.[0]?.nodeRef?.deref?.() || null
                : entry.target.nodeRef?.deref?.() || null;
        const root = node ? node.parentElement || node : null;
        if (!root || node?.isConnected === false) {
            markIncomplete(this, entry, "cas-conflict");
            this.maybeComplete();
            return;
        }
        this.ingestRoots([root], 1).then(() => {
            if (this.finalized || entry.status !== "pending") return;
            if (entry.target.revision === revision && entry.revision === revision) {
                markIncomplete(this, entry, "cas-conflict");
                this.maybeComplete();
                this.emitStatus();
            }
        });
    }

    ingestRoots(roots, queueTier) {
        if (this.finalized) return Promise.resolve();
        this.ingestChain = this.ingestChain.then(async () => {
            if (this.finalized) return;
            this.pendingAsync += 1;
            try {
                const collectSubtree = this.deps.collectSubtreeTargets || collectSubtreeTargets;
                const collected = collectSubtree(roots, this.registry, this.collectorOptions);
                const { fresh, changed } = this.registerEntries(collected.targets);
                const pending = fresh.concat(changed).filter((entry) => entry.status === "pending");
                if (!pending.length) return;
                const hits = await this.cache
                    .getMany(pending.map((entry) => entry.target))
                    .catch(() => new Map());
                if (this.finalized) return;
                this.watcher.pause(() => applyCacheHits(this, pending, hits));
                const packets = this.buildTierPackets(pending, "drain");
                if (packets.length) {
                    // Late joiners re-open the same whole-page drain session.
                    if (this.phase === "complete") this.phase = "translating";
                    this.enqueuePackets(packets, queueTier);
                }
            } finally {
                this.pendingAsync -= 1;
                this.maybeComplete();
                this.emitStatus();
            }
        });
        return this.ingestChain;
    }

    maybeComplete() {
        if (this.finalized || !this.started || !this.fullDocDone) return;
        if (this.pendingAsync > 0) return;
        if (sumSizes(this.queue?.sizeByTier?.()) > 0) return;
        if ((this.scheduler?.inFlightCount?.() || 0) > 0) return;
        // Packets parked on backoff/cooldown timers are neither queued nor in flight.
        if ((this.scheduler?.pendingRetryCount?.() || 0) > 0) return;
        // A CAS-stale item is neither queued nor in-flight while recollection is pending.
        // Completion is therefore also conditioned on entry terminality, not scheduler
        // emptiness alone.
        if (Array.from(this.entries.values()).some((entry) => entry.status === "pending")) return;
        if (this.phase !== "complete") {
            this.phase = "complete";
            this.emitStatus();
        }
    }

    emitStatus() {
        if (this.onStatus) this.onStatus(this.getStatusSnapshot());
    }

    getStatusSnapshot() {
        const banner = this.ledger.bannerSnapshot();
        const registry = this.registry.snapshot();
        const failedRepresentatives = Array.from(this.entries.values()).filter(
            (entry) => entry.status === "failed" && !entry.rep
        ).length;
        return {
            sessionId: this.sessionId,
            phase: this.phase,
            totalStrings: this.counters.total,
            translatedStrings: this.counters.translated,
            failedStrings: this.counters.failed,
            failedRepresentatives,
            failedByReason: registry.failedByReason,
            incompleteStrings: banner.incompleteStrings,
            requestCount: banner.requestCount,
            tokens: { settled: banner.settledTokens, estimated: banner.estimatedTokens },
            packets: {
                enqueued: this.enqueuedPacketCount,
                dispatched: this.dispatchCount,
                queued: sumSizes(this.queue?.sizeByTier?.()),
                inFlight: this.scheduler?.inFlightCount?.() || 0,
            },
            runawayLatched: banner.runawayLatched,
            failure: this.failure,
            telemetry: { ...this.telemetry, ...this.recovery.telemetry() },
        };
    }
}

export { AiPageTranslationSession, CONCURRENCY_AIMD, FIRST_PACKET_GATE_MS, createSessionId };
