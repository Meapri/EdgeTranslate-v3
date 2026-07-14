/**
 * Packet builder for the vNext AI page translation engine (spec §2.4).
 *
 * Packets are sized in estimated OUTPUT tokens — decode dominates wall time — through the one
 * estimator (ir/estimator.js). Tier caps and delivery ceilings mirror the pins in
 * tools/vnext-gates/config.json (`packetSizing` section); this module is the single source in
 * code, the config file is the pin record.
 *
 * Oversized single blocks are pre-split at sentence/whitespace boundaries into virtual chunk
 * ids at max(128, 0.55×providerOutputLimit) estimated output tokens (chunking semantics ported
 * from the stable/v2 planner, made placeholder-aware so ordinary splits prefer stack-depth-zero
 * boundaries between complete `<gN>…</gN>` scopes and never cut a `<gN>`/`<vN/>` tag in half),
 * with all-or-nothing reassembly bookkeeping: a block only ever commits when every one of its
 * chunks translated.
 */

import { PLACEHOLDER_GRAMMAR } from "../dom/block_ir.js";
import {
    OPENAI_INCIDENTAL_REASONING_OUT_TOKENS,
    OTHER_CHARS_PER_TOKEN,
    PER_ITEM_OUTPUT_TOKENS,
    estIn,
} from "./estimator.js";

// Tier caps: the active one-pass pipeline uses only `drain`. The smaller legacy names remain for
// focused planner tests/rollback compatibility. Drain was sized for measured latency, not prompt
// amortization: latency is decode-bound (∝ output tokens) and small packets win on both p90 tail
// and parallelism, so drain now ships small (≤16 blocks / ≤900 est-out tokens). Basis:
// .artifacts/vnext-gates/latency-gpt-5.6-luna-none.md (2026-07-14) — the old spec §2.4 "≤96/4000"
// big-packet regime measured 31.6s/13.7s on the target pages and FAILED. The provider ceiling and
// OUTPUT_TOKEN_HEADROOM_FACTOR still bound every actual generation.
const TIER_CAPS = Object.freeze({
    firstPaint: Object.freeze({
        maxBlocks: 12,
        maxSrcChars: 1500,
        maxEstOutTokens: 600,
        minEstOutTokens: 0,
    }),
    viewportHorizon: Object.freeze({
        maxBlocks: 24,
        maxSrcChars: Number.POSITIVE_INFINITY,
        maxEstOutTokens: 1200,
        minEstOutTokens: 0,
    }),
    drain: Object.freeze({
        // Small packets keep the decode tail tight (latency is decode-bound). Live 京阪本線 at
        // conc32: est-out 900/16-block -> 36.6s (tight tail); est-out 1500/24-block -> 53.4s
        // (fat tail dominates despite fewer requests). The wall is bounded by the SLOWEST
        // packet, so we keep packets small and rely on immediate full concurrency (scheduler
        // start == cap) rather than fewer/bigger packets. max_output sent has 3x/2048 headroom
        // so a small packet still never truncates (0 output_limit_split observed).
        maxBlocks: 16,
        maxSrcChars: 2400,
        maxEstOutTokens: 1000,
        minEstOutTokens: 500,
    }),
});

const TIER_NAMES = Object.freeze({
    firstPaint: "firstPaint",
    viewport: "viewportHorizon",
    horizon: "viewportHorizon",
    viewportHorizon: "viewportHorizon",
    drain: "drain",
});

// Hard delivery ceilings (spec §2.4), decoupled from capability metadata — never exceed
// evidence. Unknown providers get the most conservative pin.
const DELIVERY_CEILING_ITEMS = Object.freeze({
    googleAiStudio: 128,
    openai: 128,
    openaiCompatible: 32,
});
const DEFAULT_DELIVERY_CEILING_ITEMS = 32;

const OPENAI_COMPATIBLE_OUTPUT_CEILING_FLOOR = 1024;
// SIZING/feasibility headroom: packing and the impossible-packet gate reserve 1.25x the
// estimated output. This is what decides how many blocks fit a packet and whether a packet can
// leave the content process at all — deliberately tight so it is not distorted by the generous
// SEND ceiling below.
const OUTPUT_TOKEN_HEADROOM_FACTOR = 1.25;
// SEND ceiling (decoupled from sizing): the max_output_tokens actually requested from the
// provider gets generous headroom — max(3x est-out, 2048 floor) — always capped DOWN by the
// provider/combined output ceiling (never raising the feasibility bar, so it can never reject a
// packet or force chunking). A high ceiling costs no latency when the model stops early; it only
// prevents ja->ko decode from truncating at a tight limit and splitting into extra requests.
const MAX_OUTPUT_SEND_HEADROOM_FACTOR = 3;
const MAX_OUTPUT_SEND_FLOOR = 2048;
// Carried from the v2 session: the working default when capability metadata is absent.
const DEFAULT_PROVIDER_OUTPUT_LIMIT = 2048;

// Provider context-window metadata is not exact enough to pack to the last token: prompts can
// gain a few adapter-owned tokens and the estimator is intentionally local/zero-request. Keep
// 10% clear on both the input-only and combined windows. Output has its separate 1.25x reserve
// above; a packet must fit both reserves before it can leave the content process.
const CONTEXT_WINDOW_HEADROOM_FACTOR = 0.9;
const PREFERRED_MIN_OUTPUT_TOKENS = 256;

const CHUNK_MIN_OUTPUT_TOKENS = 128;
const CHUNK_PROVIDER_OUTPUT_SHARE = 0.55;

function observedNumber(value) {
    if (Number.isFinite(value)) return Number(value);
    if (value && Number.isFinite(value.value)) return Number(value.value);
    return null;
}

function resolveTier(tier) {
    const name = TIER_NAMES[String(tier || "")];
    if (!name) throw new TypeError(`Unknown packet tier: ${tier}`);
    return { name, caps: TIER_CAPS[name] };
}

function providerOutputCeiling(provider, capabilities) {
    const observed = observedNumber(capabilities?.maxOutputTokens);
    let ceiling = observed && observed > 0 ? observed : DEFAULT_PROVIDER_OUTPUT_LIMIT;
    if (provider === "openaiCompatible") {
        ceiling = Math.max(ceiling, OPENAI_COMPATIBLE_OUTPUT_CEILING_FLOOR);
    }
    return ceiling;
}

function safeContextCeiling(value) {
    const observed = observedNumber(value);
    return observed && observed > 0
        ? Math.max(1, Math.floor(observed * CONTEXT_WINDOW_HEADROOM_FACTOR))
        : Number.POSITIVE_INFINITY;
}

function contextLimits(capabilities) {
    return {
        maxInput: safeContextCeiling(capabilities?.maxInputTokens),
        maxCombined: safeContextCeiling(
            capabilities?.maxCombinedTokens ?? capabilities?.combinedTokens
        ),
    };
}

function requiredOutputTokens(estOut) {
    return Math.max(1, Math.ceil(Number(estOut || 0) * OUTPUT_TOKEN_HEADROOM_FACTOR));
}

/**
 * Resolves the exact max-output value sent to the provider and rejects impossible packets
 * before dispatch. Both observed `{ value, source }` fields and legacy plain numbers work.
 */
function maxOutputTokensForPacket({ estIn, estOut, provider, capabilities } = {}) {
    const input = Math.max(0, Math.ceil(Number(estIn) || 0));
    const estimatedOutput = Math.max(0, Math.ceil(Number(estOut) || 0));
    const { maxInput, maxCombined } = contextLimits(capabilities);
    if (input > maxInput) {
        throw new RangeError(
            `Packet input estimate ${input} exceeds safe provider input ceiling ${maxInput}`
        );
    }

    // Feasibility uses the TIGHT reserve: a packet is only impossible if even 1.25x its est-out
    // cannot fit the provider/combined window. This preserves packing and chunking decisions and
    // keeps small-ceiling profiles (openaiCompatible 1024) from over-fragmenting.
    const required = requiredOutputTokens(estimatedOutput);
    const outputCeiling = providerOutputCeiling(String(provider || ""), capabilities);
    const combinedOutputCeiling = Number.isFinite(maxCombined) ? maxCombined - input : Infinity;
    const hardOutputCeiling = Math.min(outputCeiling, combinedOutputCeiling);
    if (hardOutputCeiling < required) {
        throw new RangeError(
            `Packet estimate ${input}+${required} exceeds safe provider context/output ceiling`
        );
    }

    // SEND value: generous headroom so decode never truncates, then capped DOWN by the hard
    // ceiling (a small-context provider simply sends its ceiling, never throws on the floor).
    const generous = Math.max(
        required,
        MAX_OUTPUT_SEND_FLOOR,
        Math.ceil(estimatedOutput * MAX_OUTPUT_SEND_HEADROOM_FACTOR)
    );
    return Math.max(
        1,
        Math.floor(Math.min(Math.max(PREFERRED_MIN_OUTPUT_TOKENS, generous), hardOutputCeiling))
    );
}

function placeholderStructure(text) {
    const spans = [];
    const safeBoundaries = [];
    const stack = [];
    let structurallyValid = true;
    const pattern = new RegExp(PLACEHOLDER_GRAMMAR.source, "g");
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const tag = match[0];
        const start = match.index;
        const end = start + tag.length;
        spans.push({ start, end });

        const open = /^<g(\d+)>$/.exec(tag);
        const close = /^<\/g(\d+)>$/.exec(tag);
        if (open) {
            // Plain text before a complete inline wrapper is a safe structural cut too.
            if (stack.length === 0 && start > 0) safeBoundaries.push(start);
            stack.push(open[1]);
        } else if (close) {
            if (stack.pop() !== close[1]) structurallyValid = false;
            // Prefer the boundary AFTER a complete outer wrapper. This keeps every provider
            // item independently balanced instead of relying on cross-chunk <gN> state.
            if (structurallyValid && stack.length === 0) safeBoundaries.push(end);
        } else if (stack.length === 0) {
            // A void placeholder is self-contained and may safely end a provider chunk.
            safeBoundaries.push(end);
        }
    }
    if (stack.length) structurallyValid = false;
    return {
        spans,
        // Malformed source should take the existing conservative fallback; never manufacture
        // a boundary from a placeholder sequence whose nesting we could not prove.
        safeBoundaries: structurallyValid ? safeBoundaries : [],
    };
}

function lastSafeBoundaryAtOrBefore(boundaries, offset, ceiling) {
    let low = 0;
    let high = boundaries.length - 1;
    let found = null;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = boundaries[middle];
        if (candidate <= ceiling) {
            if (candidate > offset) found = candidate;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

/**
 * Sentence/whitespace-boundary chunker ported from the stable/v2 planner
 * (`splitTextByTokenLimit`, semantic_unitizer.js), with vNext additions: ordinary splits prefer
 * balanced placeholder-stack boundaries, no split lands inside a placeholder tag or surrogate
 * pair, and the binary search window is bounded by the token limit (estIn >= chars/3.6 for every
 * script, so wider windows are provably over).
 * Returns `[{ text, joinAfter }]`; joining `text + joinAfter` in order reproduces the source.
 */
function splitTextByEstimatedTokens(text, maxTokens) {
    const source = String(text || "");
    // Context-constrained profiles can legitimately leave fewer than 32 source tokens after
    // fixed prompt/ctx overhead. One token is the bounded last rung before we declare the
    // capability profile impossible and avoid the provider call entirely.
    const limit = Math.max(1, Math.floor(Number(maxTokens) || 0));
    if (!source || estIn(source) <= limit) {
        return source ? [{ text: source, joinAfter: "" }] : [];
    }

    const { spans, safeBoundaries } = placeholderStructure(source);
    const spanContaining = (index) => {
        for (const span of spans) {
            if (span.start >= index) break;
            if (index > span.start && index < span.end) return span;
        }
        return null;
    };

    const chunks = [];
    const length = source.length;
    const maxWindow = Math.ceil(limit * OTHER_CHARS_PER_TOKEN) + 2;
    let offset = 0;
    while (offset < length) {
        while (offset < length && /\s/.test(source[offset])) offset += 1;
        if (offset >= length) break;

        let low = offset + 1;
        let high = Math.min(length, offset + maxWindow);
        let best = low;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (estIn(source.slice(offset, middle)) <= limit) {
                best = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        // Inline placeholder IR is only independently parseable when each provider item ends at
        // stack depth zero. Prefer the closest proven-safe boundary below the token ceiling. A
        // single wrapper larger than the ceiling has no such boundary and intentionally falls
        // through to the old lexical split; session_support detects that imbalance and degrades
        // only that block to per-Text-node atomic translation.
        const safeEnd = lastSafeBoundaryAtOrBefore(safeBoundaries, offset, best);
        let end = safeEnd ?? best;
        if (safeEnd === null) {
            const minimumBoundary = offset + Math.floor((best - offset) * 0.55);
            for (let index = best - 1; index >= minimumBoundary; index -= 1) {
                if (/\s/.test(source[index])) {
                    end = index;
                    break;
                }
                if (/[.!?。！？]/.test(source[index]) && !spanContaining(index + 1)) {
                    end = index + 1;
                    break;
                }
            }
        }
        if (end <= offset) end = best;
        const inside = spanContaining(end);
        if (inside) end = inside.start > offset ? inside.start : inside.end;
        if (
            end < length &&
            /[\uD800-\uDBFF]/.test(source[end - 1]) &&
            /[\uDC00-\uDFFF]/.test(source[end])
        ) {
            end = end - 1 > offset ? end - 1 : end + 1;
        }
        if (end <= offset) end = Math.min(length, best);

        const raw = source.slice(offset, end);
        const chunkText = raw.trim();
        let nextOffset = end;
        while (nextOffset < length && /\s/.test(source[nextOffset])) nextOffset += 1;
        if (chunkText) {
            // Whitespace at a source-owned chunk seam is data, not decoration. Preserve the
            // exact suffix trimmed from this chunk plus the complete following run; reducing it
            // to one ASCII space changes pre-wrap content and breaks identity reassembly.
            const trimmedEnd = raw.trimEnd();
            const joinAfter = raw.slice(trimmedEnd.length) + source.slice(end, nextOffset);
            chunks.push({ text: chunkText, joinAfter });
        }
        offset = nextOffset;
    }
    return chunks;
}

function entryText(item) {
    if (typeof item.text === "string") return item.text;
    if (typeof item.source === "string") return item.source;
    if (typeof item.s === "string") return item.s;
    return "";
}

function normalizeItems(items) {
    const seen = new Set();
    const entries = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const id = typeof item?.id === "string" && item.id ? item.id : null;
        if (!id || seen.has(id)) {
            throw new Error(`Invalid or duplicate packet item id at index ${index}`);
        }
        seen.add(id);
        const text = entryText(item);
        if (!text) throw new TypeError(`Packet item ${id} requires non-empty source text`);
        entries.push({
            id,
            text,
            role: typeof item.role === "string" ? item.role : null,
            srcChars: text.length,
            order: Number.isFinite(item.order) ? Number(item.order) : index,
            chunkIndex: -1,
            seq: index,
            chunk: null,
            item,
        });
    }
    return entries;
}

function compareReadingOrder(a, b) {
    return a.order - b.order || a.chunkIndex - b.chunkIndex || a.seq - b.seq;
}

function packetItem(entry) {
    return {
        id: entry.id,
        text: entry.text,
        ...(entry.role ? { role: entry.role } : {}),
        order: entry.order,
        srcChars: entry.srcChars,
        estOutTokens: entry.estOut,
        ...(entry.chunk ? { chunk: { ...entry.chunk } } : {}),
        item: entry.item,
    };
}

/**
 * Builds provider packets for one tier from block/atomic items.
 *
 * `items`: `[{ id, text|source, role?, order? }]` — blocks serialized by block_ir, atomic
 * per-Text-node items (atomicRequired blocks arrive pre-split by the caller), and attribute
 * items alike. `estimator` is a createEstimator instance; `capabilities` supplies the observed
 * `maxOutputTokens`. Returns `{ packets, chunked }`:
 *
 * - `packets`: `[{ id, tier, aliases, items, itemCount, srcChars, estIn, estOut }]` — aliases
 *   are packet-local base36 (wire.ts convention), and items stay in document reading order
 *   within every packet. Packets are returned by first-item reading order; the scheduler may
 *   select among queued packets by estimated output to warm concurrency and shorten the tail.
 * - `chunked`: all-or-nothing bookkeeping for oversized blocks that were pre-split, one entry
 *   `{ id, chunkCount, chunkIds, chunks }` per split block; the virtual chunk items travel in
 *   `packets` like any other item, tagged with `chunk: { parentId, chunkIndex, chunkCount,
 *   joinAfter }` for `reassembleChunks`.
 *
 * Packing is LPT-ordered bin packing (largest estimated output first, best-fit) with a
 * document-position tiebreak, deterministic for identical input.
 */
function buildPackets({ items, tier, provider, estimator, capabilities, ctxTokens = 0 } = {}) {
    if (
        !estimator ||
        typeof estimator.estOutForText !== "function" ||
        typeof estimator.planPacketBudget !== "function"
    ) {
        throw new TypeError("buildPackets requires a createEstimator instance");
    }
    const { name: tierName, caps } = resolveTier(tier);
    const providerKey = String(provider || "");
    const entries = normalizeItems(Array.isArray(items) ? items : []);
    if (!entries.length) return { packets: [], chunked: [] };

    const estimatorState = typeof estimator.state === "function" ? estimator.state() : {};
    const outRatio = Number(estimatorState.outRatio) || 1;
    const outputCalibration = Number(estimatorState.outputCalibration) || 1;
    const safetyFactor =
        typeof estimator.outputCeilingFactor === "function" ? estimator.outputCeilingFactor() : 1;

    const outputCeiling = providerOutputCeiling(providerKey, capabilities);
    const incidentalOut =
        providerKey === "openai"
            ? Math.ceil(OPENAI_INCIDENTAL_REASONING_OUT_TOKENS * outputCalibration)
            : 0;
    // Packet output capacity: tier cap and the safety-scaled provider ceiling, minus the OpenAI
    // incidental-reasoning reserve so the reported packet estOut still fits the tier cap.
    const estimatedOutputCeiling = Math.floor(
        (outputCeiling * safetyFactor) / OUTPUT_TOKEN_HEADROOM_FACTOR
    );
    const packetOutCap = Math.max(
        CHUNK_MIN_OUTPUT_TOKENS,
        Math.min(caps.maxEstOutTokens, estimatedOutputCeiling) - incidentalOut
    );
    const maxItemsPerPacket = Math.min(
        caps.maxBlocks,
        DELIVERY_CEILING_ITEMS[providerKey] ?? DEFAULT_DELIVERY_CEILING_ITEMS
    );

    const budgetFor = (candidateEntries) =>
        estimator.planPacketBudget(
            candidateEntries.map((entry) => entry.text),
            ctxTokens
        );
    const fitsProviderContext = (candidateEntries) => {
        const budget = budgetFor(candidateEntries);
        try {
            maxOutputTokensForPacket({
                estIn: budget.estInTokens,
                estOut: budget.estOutTokens,
                provider: providerKey,
                capabilities,
            });
            return true;
        } catch (error) {
            if (error instanceof RangeError) return false;
            throw error;
        }
    };

    // Oversized-block pre-split (spec §1.1): chunk output budget is
    // max(128, 0.55×providerOutputLimit), never beyond what a packet of this tier can carry.
    const chunkOutBudget = Math.min(
        Math.max(CHUNK_MIN_OUTPUT_TOKENS, Math.floor(outputCeiling * CHUNK_PROVIDER_OUTPUT_SHARE)),
        packetOutCap
    );
    let chunkTokenLimit = Math.floor(
        (chunkOutBudget / outputCalibration - PER_ITEM_OUTPUT_TOKENS) / outRatio
    );
    if (Number.isFinite(caps.maxSrcChars)) {
        // estIn >= chars/3.6 for every script, so this bound also enforces the char cap.
        chunkTokenLimit = Math.min(
            chunkTokenLimit,
            Math.floor(caps.maxSrcChars / OTHER_CHARS_PER_TOKEN)
        );
    }
    chunkTokenLimit = Math.max(32, chunkTokenLimit);

    const packable = [];
    const chunked = [];
    for (const entry of entries) {
        entry.estOut = estimator.estOutForText(entry.text);
        const oversized =
            entry.estOut > packetOutCap ||
            entry.srcChars > caps.maxSrcChars ||
            !fitsProviderContext([entry]);
        if (!oversized) {
            packable.push(entry);
            continue;
        }

        // Find the largest safe source-token chunk limit. The binary search is bounded by the
        // existing output/character limit and preserves request consolidation, while testing
        // the complete prompt+ctx+requested-output estimate against provider context metadata.
        let chunks = null;
        let low = 1;
        let high = Math.min(chunkTokenLimit, Math.max(1, estIn(entry.text) - 1));
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = splitTextByEstimatedTokens(entry.text, middle);
            const safe =
                candidate.length > 1 &&
                candidate.every((chunk) => {
                    const chunkEntry = {
                        ...entry,
                        text: chunk.text,
                        srcChars: chunk.text.length,
                        estOut: estimator.estOutForText(chunk.text),
                    };
                    return (
                        chunkEntry.estOut <= packetOutCap &&
                        chunkEntry.srcChars <= caps.maxSrcChars &&
                        fitsProviderContext([chunkEntry])
                    );
                });
            if (safe) {
                chunks = candidate;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (!chunks) {
            // Even a one-source-token item cannot clear the fixed prompt/context overhead.
            // Failing here prevents an inevitably rejected (or silently truncated) provider
            // request; the session will surface the planner failure without billing a call.
            throw new RangeError(
                `Packet item ${entry.id} cannot fit provider context after bounded chunking`
            );
        }
        const chunkEntries = chunks.map((chunk, index) => ({
            id: `${entry.id}#c${index + 1}`,
            text: chunk.text,
            role: entry.role,
            srcChars: chunk.text.length,
            order: entry.order,
            chunkIndex: index,
            seq: entry.seq,
            estOut: estimator.estOutForText(chunk.text),
            chunk: {
                parentId: entry.id,
                chunkIndex: index,
                chunkCount: chunks.length,
                joinAfter: chunk.joinAfter,
            },
            item: entry.item,
        }));
        chunked.push({
            id: entry.id,
            chunkCount: chunkEntries.length,
            chunkIds: chunkEntries.map((chunkEntry) => chunkEntry.id),
            chunks: chunkEntries.map((chunkEntry) => ({ ...chunkEntry.chunk })),
        });
        packable.push(...chunkEntries);
    }

    // LPT order: largest estimated output first, document position as the tiebreak so equal
    // items pack — and therefore dispatch — in stable reading order.
    const sorted = packable
        .slice()
        .sort((a, b) => b.estOut - a.estOut || compareReadingOrder(a, b));

    const bins = [];
    for (const entry of sorted) {
        let best = null;
        for (const bin of bins) {
            if (
                bin.entries.length + 1 > maxItemsPerPacket ||
                bin.srcChars + entry.srcChars > caps.maxSrcChars ||
                bin.estOut + entry.estOut > packetOutCap ||
                !fitsProviderContext([...bin.entries, entry])
            ) {
                continue;
            }
            const leftover = packetOutCap - bin.estOut - entry.estOut;
            if (!best || leftover < best.leftover) best = { bin, leftover };
        }
        if (best) {
            best.bin.entries.push(entry);
            best.bin.srcChars += entry.srcChars;
            best.bin.estOut += entry.estOut;
        } else {
            bins.push({ entries: [entry], srcChars: entry.srcChars, estOut: entry.estOut });
        }
    }

    // Drain floor: est out >= drain.minEstOutTokens (500) except the final remainder. Merge
    // under-floor bins while any two of them still fit one packet together; whatever single
    // remainder is left stays exempt.
    if (caps.minEstOutTokens > 0) {
        const mergeOneUnderFloorPair = () => {
            const under = bins
                .filter((bin) => bin.estOut < caps.minEstOutTokens)
                .sort((a, b) => a.estOut - b.estOut);
            for (let i = 0; i < under.length; i += 1) {
                for (let j = i + 1; j < under.length; j += 1) {
                    const a = under[i];
                    const b = under[j];
                    if (
                        a.entries.length + b.entries.length <= maxItemsPerPacket &&
                        a.srcChars + b.srcChars <= caps.maxSrcChars &&
                        a.estOut + b.estOut <= packetOutCap &&
                        fitsProviderContext([...a.entries, ...b.entries])
                    ) {
                        a.entries.push(...b.entries);
                        a.srcChars += b.srcChars;
                        a.estOut += b.estOut;
                        bins.splice(bins.indexOf(b), 1);
                        return true;
                    }
                }
            }
            return false;
        };
        while (mergeOneUnderFloorPair()) {
            // Repeat until at most one under-floor packet (the final remainder) is left.
        }
    }

    for (const bin of bins) bin.entries.sort(compareReadingOrder);
    bins.sort((a, b) => compareReadingOrder(a.entries[0], b.entries[0]));

    const packets = bins.map((bin, index) => {
        const budget = budgetFor(bin.entries);
        return {
            id: `p${index + 1}`,
            tier: tierName,
            aliases: bin.entries.map((_, position) => position.toString(36)),
            items: bin.entries.map(packetItem),
            itemCount: bin.entries.length,
            srcChars: bin.srcChars,
            estIn: budget.estInTokens,
            estOut: budget.estOutTokens,
        };
    });
    return { packets, chunked };
}

function resultText(result) {
    if (typeof result.translatedText === "string") return result.translatedText;
    if (typeof result.t === "string") return result.t;
    if (typeof result.text === "string") return result.text;
    return "";
}

/**
 * All-or-nothing chunk reassembly (ported from the stable/v2 session semantics): a block
 * translation exists only when EVERY chunk arrived with usable text; any missing, empty or
 * failed chunk fails the whole block so a partially translated block never reaches the DOM.
 *
 * `chunkResults`: `[{ id, chunk: { parentId, chunkIndex, chunkCount, joinAfter },
 * translatedText|text, ok? }]` — packet chunk items with the reply text attached (flattened
 * chunk metadata is also accepted). Returns `[{ id, ok, text?, reason? }]`, one entry per
 * block, in first-seen order.
 */
function reassembleChunks(chunkResults) {
    const groups = new Map();
    for (const result of Array.isArray(chunkResults) ? chunkResults : []) {
        if (!result || typeof result !== "object") continue;
        const meta = result.chunk && typeof result.chunk === "object" ? result.chunk : result;
        const derived = /^(.+)#c\d+$/.exec(typeof result.id === "string" ? result.id : "");
        const parentId =
            typeof meta.parentId === "string" && meta.parentId
                ? meta.parentId
                : derived
                ? derived[1]
                : null;
        const chunkIndex = Number(meta.chunkIndex);
        if (!parentId || !Number.isInteger(chunkIndex) || chunkIndex < 0) continue;
        let group = groups.get(parentId);
        if (!group) {
            group = { byIndex: new Map(), chunkCount: null, failed: false };
            groups.set(parentId, group);
        }
        if (Number.isInteger(meta.chunkCount) && meta.chunkCount > 0) {
            group.chunkCount = group.chunkCount ?? meta.chunkCount;
        }
        const text = resultText(result);
        if (result.ok === false || !text.trim()) {
            group.failed = true;
            continue;
        }
        if (!group.byIndex.has(chunkIndex)) {
            group.byIndex.set(chunkIndex, {
                text,
                joinAfter: typeof meta.joinAfter === "string" ? meta.joinAfter : "",
            });
        }
    }

    const reassembled = [];
    for (const [id, group] of groups) {
        const count = group.chunkCount ?? group.byIndex.size;
        let complete = !group.failed && count > 0 && group.byIndex.size === count;
        for (let index = 0; complete && index < count; index += 1) {
            if (!group.byIndex.has(index)) complete = false;
        }
        if (!complete) {
            reassembled.push({ id, ok: false, reason: group.failed ? "failed" : "incomplete" });
            continue;
        }
        const parts = [];
        for (let index = 0; index < count; index += 1) {
            const chunk = group.byIndex.get(index);
            parts.push(`${chunk.text.trim()}${chunk.joinAfter}`);
        }
        // Per-chunk trim removes model-added boundary noise; source-owned seams were already
        // restored byte-for-byte through joinAfter. A final trim would erase the last owned run.
        reassembled.push({ id, ok: true, text: parts.join("") });
    }
    return reassembled;
}

export {
    CONTEXT_WINDOW_HEADROOM_FACTOR,
    DELIVERY_CEILING_ITEMS,
    MAX_OUTPUT_SEND_FLOOR,
    MAX_OUTPUT_SEND_HEADROOM_FACTOR,
    OPENAI_COMPATIBLE_OUTPUT_CEILING_FLOOR,
    OUTPUT_TOKEN_HEADROOM_FACTOR,
    TIER_CAPS,
    buildPackets,
    maxOutputTokensForPacket,
    reassembleChunks,
    splitTextByEstimatedTokens,
};
