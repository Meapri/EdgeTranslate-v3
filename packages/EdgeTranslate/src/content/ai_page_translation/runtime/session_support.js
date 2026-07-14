/**
 * Mechanism helpers behind runtime/session.js — packet materialization, entry records,
 * DOM apply glue and the per-item validation ladder plumbing. Split out so session.js
 * stays orchestration-only inside its pinned ≤600-line budget (spec §8); everything here
 * is a pure function over explicit arguments, unit-driven through the session tests.
 */

import {
    applyBlockTranslation,
    isTranslationOrderRepresentable,
    parseTranslatedBlock,
    repairPlaceholders,
} from "../dom/block_ir.js";
import { applyBlock, commitTargetTranslation } from "../dom/committer.js";
import { reattachBoundaryWhitespace } from "../dom/target_registry.js";
import { buildPackets, maxOutputTokensForPacket } from "../ir/packet_builder.js";
import { maskProtectedTokens } from "./protected_tokens.js";
import { validateTranslatedItem } from "./validator.js";

// Bounded diagnostic vocabulary. Never derive telemetry keys from provider/source text: status
// snapshots expose counts only, and one failed item increments a class at most once per attempt.
const VALIDATION_FAILURE_COUNTERS = Object.freeze({
    empty: "validation_fail_empty",
    placeholder: "validation_fail_placeholder",
    "length-expansion": "validation_fail_length_expansion",
    "length-collapse": "validation_fail_length_collapse",
    url: "validation_fail_url",
    email: "validation_fail_email",
    code: "validation_fail_code",
    identifier: "validation_fail_identifier",
    number: "validation_fail_number",
    echo: "validation_fail_echo",
    script: "validation_fail_script",
    "keep-source-identity": "validation_fail_keep_source_identity",
    "keep-source-unverified": "validation_fail_keep_source_unverified",
});

// Provider receipts may force finer recovery chunks, but one ordinary source item must not
// become an unbounded series of tiny provider requests. Production entries remember their
// first-pass fragment count; recovery may double it, with a four-fragment floor for small pages.
const RECOVERY_CHUNK_AMPLIFICATION_FACTOR = 2;
const RECOVERY_CHUNK_FLOOR = 4;

function emitValidationFailureCounters(verdict, onTelemetry) {
    if (typeof onTelemetry !== "function" || verdict?.verdict !== "fail") return;
    const emitted = new Set();
    for (const failure of verdict.failures || []) {
        const counter = VALIDATION_FAILURE_COUNTERS[failure?.class];
        if (!counter || emitted.has(counter)) continue;
        emitted.add(counter);
        onTelemetry(counter);
    }
}

function usableUnit(unit) {
    return Boolean(
        unit && (unit.status === "translated" || unit.status === "unchanged" || unit.keepSource)
    );
}

function sumSizes(sizes) {
    const values = Array.isArray(sizes) ? sizes : Object.values(sizes || {});
    return values.reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function entryInteractive(record) {
    return Boolean(record.ir?.placeholderInventory?.tags?.some((tag) => tag.interactive));
}

function placeholderTagsBalanced(text) {
    const stack = [];
    const tags = String(text || "").match(/<\/?g\d+>|<v\d+\/>/g) || [];
    for (const tag of tags) {
        if (/^<v\d+\/>$/.test(tag)) continue;
        const open = /^<g(\d+)>$/.exec(tag);
        if (open) {
            stack.push(open[1]);
            continue;
        }
        const close = /^<\/g(\d+)>$/.exec(tag);
        if (!close || stack.pop() !== close[1]) return false;
    }
    return stack.length === 0;
}

function chunkGroupsWithUnbalancedPlaceholders(result) {
    const unsafe = new Set();
    for (const packet of result.packets || []) {
        for (const item of packet.items || []) {
            if (item.chunk && !placeholderTagsBalanced(item.text)) {
                unsafe.add(item.chunk.parentId);
            }
        }
    }
    return unsafe;
}

/** Session entry record for one registered target (block, atomic text or attribute). */
function makeEntry(record, fallbackOrder) {
    const target = record.target;
    return {
        id: target.id,
        kind: record.kind,
        target,
        element: record.element || null,
        ir: record.ir || null,
        order: Number.isFinite(record.order) ? record.order : fallbackOrder,
        role: target.role && target.role !== "text" ? target.role : "p",
        text: String(target.source || ""),
        revision: target.revision,
        status: "pending",
        aliases: [],
        rep: null,
        recovery: {},
        atomic: null,
        translation: null,
        keptSource: false,
        hasInteractive: entryInteractive(record),
        initialChunkCount: 1,
    };
}

/** Revision-bump refresh (Stage-B risk 5): same entry object, healed source + IR. */
function refreshEntry(entry, record) {
    entry.revision = record.target.revision;
    entry.text = String(record.target.source || "");
    entry.ir = record.ir || null;
    entry.hasInteractive = entryInteractive(record);
    entry.status = "pending";
    entry.recovery = {};
    entry.atomic = null;
    entry.initialChunkCount = 1;
}

function finalizePacket(packet, capabilities, provider = capabilities?.provider) {
    packet.itemById = new Map(packet.items.map((item) => [item.id, item]));
    // Mask protected tokens on the wire copy ONLY (item.text stays the verbatim source, so
    // recovery re-masks freshly and every reply restores against a clean map). The per-item map
    // rides on the packet item; reply_pipeline restores it before validation + apply.
    packet.wireItems = packet.items.map((item) => {
        const { masked, map } = maskProtectedTokens(item.text);
        item.protectedMap = map;
        return { id: item.id, text: masked, role: item.role };
    });
    packet.maxOutputTokens = maxOutputTokensForPacket({
        estIn: packet.estIn,
        estOut: packet.estOut,
        provider,
        capabilities,
    });
    return packet;
}

/**
 * Builds tier packets from pending representative entries via ir/packet_builder, records
 * oversized-block chunk groups (all-or-nothing bookkeeping) into `chunkGroups`.
 */
function buildEntryPackets({
    entries,
    tier,
    provider,
    estimator,
    capabilities,
    ctxTokens,
    chunkGroups,
    nextId,
}) {
    const pending = entries.filter((entry) => entry.status === "pending" && !entry.rep);
    if (!pending.length) return [];
    const normalItem = (entry) => ({
        id: entry.id,
        text: entry.text,
        role: entry.role,
        order: entry.order,
        entry,
    });
    let sourceItems = pending.map(normalItem);
    let built = buildPackets({
        items: sourceItems,
        tier,
        provider,
        estimator,
        capabilities,
        ctxTokens,
    });
    const unsafeChunkGroups = chunkGroupsWithUnbalancedPlaceholders(built);
    if (unsafeChunkGroups.size) {
        // A very long inline wrapper can force a token split while `<gN>` is still open. Never
        // send malformed placeholder fragments to a model. Degrade only that block to its
        // original Text-node mapping, then let the ordinary chunker split long atomic text.
        sourceItems = pending.flatMap((entry) =>
            unsafeChunkGroups.has(entry.id) ? buildAtomicItems(entry) : [normalItem(entry)]
        );
        built = buildPackets({
            items: sourceItems.map((item, index) => ({
                ...item,
                order: Number.isFinite(item.order) ? item.order : item.entry.order + index / 1000,
            })),
            tier,
            provider,
            estimator,
            capabilities,
            ctxTokens,
        });
    }
    const { packets, chunked } = built;
    const byId = new Map(sourceItems.map((item) => [item.id, item]));
    for (const group of chunked) {
        const sourceItem = byId.get(group.id);
        const entry = sourceItem?.entry;
        if (!entry) continue;
        entry.initialChunkCount = Math.max(entry.initialChunkCount || 1, group.chunkCount);
        chunkGroups.set(group.id, {
            entry,
            atomicPart: sourceItem.atomicPart || null,
            sourceText: sourceItem.text,
            expected: group.chunkCount,
            results: new Map(),
            failed: false,
            revision: entry.target.revision,
        });
    }
    return packets.map((built) =>
        finalizePacket(
            {
                id: nextId(),
                tier: built.tier,
                items: built.items.map((item) => ({
                    id: item.id,
                    text: item.text,
                    role: item.role || null,
                    entry: item.item.entry,
                    revision: item.item.entry.target.revision,
                    chunk: item.chunk || null,
                    atomicPart: item.item.atomicPart || null,
                })),
                estIn: built.estIn,
                estOut: built.estOut,
                recovery: null,
                hint: null,
            },
            capabilities,
            provider
        )
    );
}

/**
 * Re-packs recovery work through the same context/output-aware builder as first-generation
 * work. This is essential for a long block whose first translation assembled successfully but
 * then failed semantic/placeholder validation: retrying the full source as one ad-hoc packet can
 * exceed the provider window even though the initial path chunked it safely.
 */
function buildRecoveryPackets({
    items,
    meta = {},
    provider,
    estimator,
    ctxTokens,
    capabilities,
    chunkGroups,
    nextId,
}) {
    const sourceItems = (items || []).filter(Boolean).map((item, index) => ({
        ...item,
        order: Number.isFinite(item.order) ? item.order : (item.entry?.order || 0) + index / 1000,
    }));
    if (!sourceItems.length) return [];
    const built = buildPackets({
        items: sourceItems,
        tier: "drain",
        provider,
        estimator,
        capabilities,
        ctxTokens,
    });
    const byId = new Map(sourceItems.map((item) => [item.id, item]));
    for (const group of built.chunked) {
        const sourceItem = byId.get(group.id);
        if (sourceItem?.chunk) {
            // An existing chunk fragment is an indivisible recovery unit. A second nesting
            // level loses the outer linkage and can strand or misapply the original group, so
            // terminate locally when calibrated limits no longer fit it. Atomic parts are
            // different: the chunk group explicitly preserves atomicPart and safely rejoins it.
            const error = new RangeError(
                `Indivisible recovery item ${group.id} cannot fit provider context`
            );
            error.code = "recovery-indivisible-rechunk";
            throw error;
        }
        const baseline = Number(sourceItem?.entry?.initialChunkCount);
        // Focused packet-builder callers can omit runtime entry metadata. Every production
        // entry comes through makeEntry and therefore owns a finite baseline.
        if (!Number.isFinite(baseline) || baseline < 1) continue;
        const limit = Math.max(
            RECOVERY_CHUNK_FLOOR,
            Math.ceil(baseline * RECOVERY_CHUNK_AMPLIFICATION_FACTOR)
        );
        if (group.chunkCount > limit) {
            const error = new RangeError(
                `Recovery item ${group.id} requires ${group.chunkCount} chunks (limit ${limit})`
            );
            error.code = "recovery-chunk-amplification";
            throw error;
        }
    }
    for (const group of built.chunked) {
        const sourceItem = byId.get(group.id);
        const entry = sourceItem?.entry;
        if (!entry) continue;
        chunkGroups.set(group.id, {
            entry,
            atomicPart: sourceItem.atomicPart || null,
            sourceText: sourceItem.text,
            expected: group.chunkCount,
            results: new Map(),
            failed: false,
            revision: entry.target.revision,
        });
    }
    const recovery = {
        stage: meta.stage || null,
        splits: meta.splits || 0,
        depth: meta.depth || 0,
    };
    return built.packets.map((packet) =>
        finalizePacket(
            {
                id: nextId(),
                tier: "recovery",
                items: packet.items.map((item) => ({
                    id: item.id,
                    text: item.text,
                    role: item.role || null,
                    entry: item.item.entry,
                    revision: item.item.entry.target.revision,
                    chunk: item.chunk || item.item.chunk || null,
                    atomicPart: item.item.atomicPart || null,
                })),
                estIn: packet.estIn,
                estOut: packet.estOut,
                recovery,
                hint: meta.hint || null,
            },
            capabilities,
            provider
        )
    );
}

/** Per-Text-node atomic items for one entry (schema-atomic rung / §1.4 atomic-degrade). */
function buildAtomicItems(entry) {
    const target = entry.target;
    const nodes =
        target.kind === "block" && Array.isArray(target.textNodes) && target.textNodes.length
            ? target.textNodes
            : null;
    entry.atomic = {
        expected: nodes ? nodes.length : 1,
        results: new Map(),
        revision: target.revision,
    };
    if (!nodes) {
        return [
            {
                id: `${entry.id}@n0`,
                text: entry.text,
                role: entry.role,
                entry,
                revision: target.revision,
                atomicPart: { entry, index: 0 },
            },
        ];
    }
    return nodes.map((node, index) => ({
        id: `${entry.id}@n${index}`,
        text: node.source,
        role: entry.role,
        entry,
        revision: target.revision,
        atomicPart: { entry, index },
    }));
}

/**
 * CAS-guarded DOM commit for one entry. Blocks with IR get the serialize-time inventory and
 * applyMap attached before applyBlockTranslation (Stage-B risk 2); plain single-Text-node
 * blocks NEVER go through parseTranslatedBlock (risk 3); text/attribute targets commit with
 * boundary whitespace re-attached.
 */
function commitEntryText({ entry, text, keepSource, sessionId, revision }) {
    if (keepSource) return true; // the DOM already shows the source text
    if (typeof text !== "string" || !text) return false;
    const target = entry.target;
    const expected = { sessionId, revision };
    if (target.kind === "block") {
        if (entry.ir) {
            target.placeholderInventory = entry.ir.placeholderInventory;
            target.applyMap = entry.ir.applyMap;
            const parsed = parseTranslatedBlock(text, entry.ir.placeholderInventory);
            if (!parsed.ok) return false;
            const result = applyBlockTranslation(target, parsed.segments, (blockTarget, segments) =>
                applyBlock(blockTarget, segments, expected)
            );
            return (
                result.casFailures === 0 &&
                result.applied === target.textNodes.length &&
                target.textNodes.length > 0
            );
        }
        const result = applyBlock(target, [text], expected);
        return result.casFailures === 0 && result.applied === 1;
    }
    const committed = commitTargetTranslation(
        target,
        reattachBoundaryWhitespace(target.source, text),
        expected
    );
    return committed.status === "applied";
}

/** §1.4(a) flatten commit: full text into the dominant Text node, "" into the rest. */
function flattenCommit(target, flat, sessionId) {
    if (target.kind !== "block" || !Array.isArray(target.textNodes)) return false;
    // Prefer a bare (outside all styling placeholders) Text node. This preserves translated
    // reading order while erasing styling only; putting the full sentence into the first
    // wrapped node would style the whole block and can still produce surprising layout.
    let dominant = target.textNodes.findIndex(
        (node) =>
            (!Array.isArray(node.path) || node.path.length === 0) &&
            String(node.source || "").trim()
    );
    if (dominant < 0) {
        dominant = target.textNodes.findIndex((node) => String(node.source || "").trim());
    }
    if (dominant < 0) dominant = 0;
    const segments = target.textNodes.map((node, index) => (index === dominant ? flat : ""));
    const result = applyBlock(target, segments, { sessionId, revision: target.revision });
    return result.casFailures === 0 && result.applied === target.textNodes.length;
}

/**
 * Applies a completed atomic group: guaranteed per-node mapping, degraded cohesion — a part
 * that failed validation keeps its source text, so interactive text is never blanked.
 */
function applyAtomicSegments({ entry, group, sessionId }) {
    const target = entry.target;
    if (target.kind === "block" && Array.isArray(target.textNodes)) {
        const segments = target.textNodes.map((node, index) => {
            const part = group.results.get(index);
            return typeof part === "string" ? part : node.source;
        });
        const result = applyBlock(target, segments, { sessionId, revision: group.revision });
        const allOk = target.textNodes.every(
            (node, index) => typeof group.results.get(index) === "string"
        );
        const fullyApplied = result.casFailures === 0 && result.applied === target.textNodes.length;
        return { applied: fullyApplied, allOk, text: segments.join("") };
    }
    const part = group.results.get(0);
    const applied =
        typeof part === "string" &&
        commitEntryText({
            entry,
            text: part,
            keepSource: false,
            sessionId,
            revision: group.revision,
        });
    return { applied: Boolean(applied), allOk: Boolean(applied), text: applied ? part : "" };
}

/**
 * §6 validation plus the §1.4 rung-1 zero-token local repair. Returns
 * `{ ok, text }` on acceptance or `{ ok: false, placeholderFailure }` for bucket routing.
 */
function validateEntryTranslation({ entry, translated, keepSource, targetLanguage, onTelemetry }) {
    const inventory = entry.ir ? entry.ir.placeholderInventory : null;
    let text = translated;
    let verdict = validateTranslatedItem(
        { source: entry.text, translated: text, keepSource, placeholderInventory: inventory },
        { targetLanguage, onTelemetry }
    );
    if (
        verdict.verdict === "fail" &&
        inventory &&
        verdict.failures.every((failure) => failure.class === "placeholder")
    ) {
        const repair = repairPlaceholders(text, inventory);
        if (repair.ok) {
            if (onTelemetry) onTelemetry("placeholder_repaired");
            text = repair.repaired;
            verdict = validateTranslatedItem(
                {
                    source: entry.text,
                    translated: text,
                    keepSource,
                    placeholderInventory: inventory,
                },
                { targetLanguage }
            );
        }
    }
    if (verdict.verdict !== "fail" && inventory && entry.ir?.applyMap) {
        const representable = isTranslationOrderRepresentable(text, inventory, entry.ir.applyMap);
        if (!representable.ok) {
            entry.recovery = entry.recovery || {};
            entry.recovery.orderUnrepresentable = true;
            if (onTelemetry) onTelemetry("inline_order_unrepresentable");
            return {
                ok: false,
                text,
                placeholderFailure: true,
                representabilityFailure: true,
            };
        }
        if (entry.recovery) delete entry.recovery.orderUnrepresentable;
    }
    if (verdict.verdict !== "fail") return { ok: true, text };
    emitValidationFailureCounters(verdict, onTelemetry);
    return {
        ok: false,
        text,
        placeholderFailure: Boolean(
            inventory && verdict.failures.some((failure) => failure.class === "placeholder")
        ),
    };
}

export {
    applyAtomicSegments,
    buildAtomicItems,
    buildEntryPackets,
    buildRecoveryPackets,
    commitEntryText,
    finalizePacket,
    flattenCommit,
    makeEntry,
    refreshEntry,
    sumSizes,
    usableUnit,
    emitValidationFailureCounters,
    validateEntryTranslation,
};
