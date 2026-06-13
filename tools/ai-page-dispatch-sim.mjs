// Discrete-event wall-clock simulator for the AI page-translation dispatch redesign.
//
// Quantifies BEFORE (scroll-paced lazy dispatch) vs AFTER (backlog promotion / continuous
// slot top-up) on a REAL large Wikipedia page (/tmp/keihan.html, 1.18MB ja.wikipedia),
// using the extension's real collector (collectHtmlPageSections + findLeafBlocksInElement +
// serializeTranslationLeaf from dom_page_translate_context.js, loaded in JSDOM exactly the
// way tools/find-untranslated.mjs does) and the extension's real token estimators
// (estimateLlmPayloadTokens / estimateLlmOutputTokens, replicated verbatim from
// banner_controller.js).
//
// ───────────────────────────── Modeled policies ─────────────────────────────
// Shared (both policies, parameters read from banner_controller.js / settings.js):
//   - First dispatch wave: entries viewport-ranked (getAiPageSectionViewportRank tiers),
//     lead-chunk split (getAiPageSectionLeadChars: 2000 cloud / 800 openaiCompatible),
//     lazy window keep/defer (selectAiPageEntriesForLazyWindow):
//       within  = sectionTop < scrollY + (1 + screensBelow)*vh  AND
//                 sectionBottom > scrollY − screensAbove*vh
//       screensBelow = 2.5, screensAbove = 1   (getAiPageLazyScreensBelow/Above)
//       budget  = AiPageTranslateConfig.tokenBudget default 16000 estimated input tokens
//                 (settings.js); 0 disables the cap. First entry always kept.
//   - Visible (tier-0) kept entries: up to getAiPageVisibleStreamingLimit singles
//     (no-telemetry initial state: 3 for cloud since concurrency ≥ 8, 1 for
//     openaiCompatible); the rest packed into batches (buildAiPageSectionBatches):
//     greedy in rank order, overflow on maxItems / targetChars / maxInputTokens /
//     maxOutputTokens.
//   - IntersectionObserver rootMargin = 250% (getAiPageLazyRootMargin from
//     screensBelow 2.5) → a deferred section "reveals" when
//     sectionTop < scrollY + vh + 2.5*vh = scrollY + 3.5*vh.
//   - Requests served by a FIFO queue over `slots` parallel servers
//     (getDomPageMaxConcurrentTranslations failure-0: googleAiStudio 32, openai 16,
//     openaiCompatible 8). Request duration = TTFT + outputTokens / tokPerSec.
//
// BEFORE (old policy):
//   - targetChars = clamp(minBatch, totalChars/concurrency, maxChars); NO tail-balance.
//   - openai used the generic cloud batch options (maxChars 24000 / maxItems 24 /
//     maxOutputTokens 9000 / maxInputTokens 7000) → batches whose ESTIMATED output
//     exceeds the engine's universal 4096 first-attempt completion cap (local.ts) pay
//     the truncation double-generation: duration = TTFT + gen(4096) + TTFT + gen(full),
//     input billed twice, the 4096 wasted output tokens billed too.
//   - Deferred sections dispatch ONLY on reveal: trailing 120ms debounce with 600ms
//     max-defer (scheduleDomPageIncrementalScan semantics) + ~35ms re-collect, then the
//     burst enqueues through the same singles/batches split. No scroll ⇒ deferred
//     content beyond the rootMargin never dispatches (time-to-full-page = Infinity).
//
// AFTER (new policy, the shipped redesign):
//   - Deferred entries go to a viewport-ranked BACKLOG (addAiPageBacklogEntries).
//     Whenever the queue drains with free slots, the pump (promoteAiPageBacklogEntries)
//     refills ~one batch per free slot: perBatchTarget = min(maxChars, max(minBatch,
//     ceil(backlogChars/cap))), charBudget = freeSlots × perBatchTarget. Eager (non-
//     revealed) promotion stops once promoted input tokens reach the 16000 budget
//     UNLESS budget = 0 (both scenarios simulated); reveal-boosted entries always
//     promote (reveal-to-request ≈ 0ms — entries are pre-serialized).
//   - Tail balance (cloud): targetChars halves to ceil(totalChars/(2*concurrency))
//     when per-slot chars > 2*minBatch.
//   - openai per-engine tiers (failures 0): maxChars 9500 / maxInputTokens 2800 /
//     maxOutputTokens 3600 / maxItems 12, post-scale clamp min(·, 3686)
//     (clampAiPageSectionBatchOutputCeiling) → packed batches stay under the 4096
//     first-attempt ceiling: no truncation double-gen. Oversized ATOMIC sections
//     (single entry above the caps) ride the modern-model 12288 first-attempt cap
//     (local.ts supportsLargeCompletionBudget) — modeled as completing in one stream
//     (real CJK→latin outputs run well below the packing estimate; the count of
//     estimate-over-12288 atomics is reported separately).
//   - openaiCompatible small-cap reserve: while work is in flight the pump keeps the
//     last free slot for reveal-boosted entries (boostedOnly when cap ≤ 8).
//
// ─────────────────────────── Geometry approximation ───────────────────────────
// Sections are viewport-ordered top-to-bottom. Each section's vertical position is
// approximated by its cumulative serialized-char offset at a uniform char density:
// charsPerPixel = totalChars / totalPageHeight, with totalPageHeight ≈ 60000px for
// this page (a 1.18MB ja.wikipedia article is roughly 60-70 screens of 900px).
// This ignores images/tables/whitespace variation but preserves ordering and the
// relative size of the lazy window vs the page, which is what the dispatch policies
// key on. Viewport height = 900px; the reader starts at scrollY = 0.
//
// Other documented approximations:
//   - One entry per collected section (leaf-level char counts kept for the lead split).
//   - Streaming partial paint is not modeled: time-to-first-visible = completion of the
//     first request containing a tier-0 section (same definition for both policies).
//   - Telemetry feedback (batchScale, dynamic concurrency, latency EMAs) is frozen at
//     its failure-0 / initial state; failures are 0 throughout.
//   - estimateLlmPayloadTokens is computed from per-leaf CJK/other char counts summed
//     per entry (identical formula, ±1 token vs per-string ceil).
//
// Run:  node tools/ai-page-dispatch-sim.mjs        (SIM_DEBUG=1 dumps per-request traces)
// Deterministic (no Math.random); needs /tmp/keihan.html.
// Exit code 1 if any sanity check fails.

import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
const { JSDOM } = require("jsdom");

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const domContextPath = path.join(
    repoRoot,
    "packages/EdgeTranslate/src/content/dom_page_translate_context.js"
);
const PAGE_PATH = "/tmp/keihan.html";

// ───────────────────────────── Parameters (read from the code) ─────────────────────────────

const VH = 900; // simulated viewport height (px)
const PAGE_HEIGHT = 60000; // documented approximation for this page (px)
const SCREENS_BELOW = 2.5; // getAiPageLazyScreensBelow()
const SCREENS_ABOVE = 1; // getAiPageLazyScreensAbove()
const TOKEN_BUDGET_DEFAULT = 16000; // settings.js AiPageTranslateConfig.tokenBudget
const REVEAL_MARGIN_PX = VH + SCREENS_BELOW * VH; // rootMargin 250% → trigger at top+3.5vh
const DEBOUNCE_MS = 120; // old reveal path debounce
const DEBOUNCE_MAX_DEFER_MS = 600; // scheduleDomPageIncrementalScan maxDefer
const RECOLLECT_MS = 35; // old reveal path re-collect cost
const OPENAI_FIRST_ATTEMPT_CAP_BEFORE = 4096; // local.ts universal legacy ceiling
const OPENAI_MODERN_ATOMIC_CAP = 12288; // local.ts supportsLargeCompletionBudget cap

const ENGINES = {
    googleAiStudio: {
        slots: 32, // getDomPageMaxConcurrentTranslations, failures 0
        tokPerSec: 300,
        ttftMs: 500,
        streamingLimit: 3, // getAiPageVisibleStreamingLimit, initial telemetry
        minBatchChars: 3000,
        cloud: true,
        leadChars: 2000,
        // generic cloud tier (getAiPageSectionBatchOptions failures 0) — unchanged by the redesign
        batchBefore: { maxChars: 24000, maxInputTokens: 7000, maxOutputTokens: 9000, maxItems: 24 },
        batchAfter: { maxChars: 24000, maxInputTokens: 7000, maxOutputTokens: 9000, maxItems: 24 },
    },
    openai: {
        slots: 16,
        tokPerSec: 150,
        ttftMs: 800,
        streamingLimit: 3,
        minBatchChars: 3000,
        cloud: true,
        leadChars: 2000,
        // BEFORE: openai shared the generic cloud tier → estimated output up to 9000 ≫ 4096
        batchBefore: { maxChars: 24000, maxInputTokens: 7000, maxOutputTokens: 9000, maxItems: 24 },
        // AFTER: openai-specific tier + post-scale clamp min(3600, 3686) = 3600
        batchAfter: { maxChars: 9500, maxInputTokens: 2800, maxOutputTokens: 3600, maxItems: 12 },
    },
    openaiCompatible: {
        slots: 8,
        tokPerSec: 40,
        ttftMs: 300,
        streamingLimit: 1,
        minBatchChars: 1200,
        cloud: false,
        leadChars: 800,
        batchBefore: { maxChars: 3800, maxInputTokens: 1200, maxOutputTokens: 1450, maxItems: 4 },
        // AFTER adds the 1382 output-ceiling clamp (0.9 × 1536 local-slot budget)
        batchAfter: { maxChars: 3800, maxInputTokens: 1200, maxOutputTokens: 1382, maxItems: 4 },
    },
};

const SCROLL_SPEEDS = [
    { key: "fast-skim", pxPerSec: 3000 },
    { key: "read", pxPerSec: 300 },
    { key: "no-scroll", pxPerSec: 0 },
];

// ───────────────────────────── Token estimators (banner_controller.js) ─────────────────────────────

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/g;

function charCounts(text) {
    const value = String(text || "");
    const cjk = (value.match(CJK_RE) || []).length;
    return { chars: value.length, cjk };
}

// estimateLlmPayloadTokens: ceil(cjk*0.8 + other/3.6) — computed from summed counts.
function payloadTokensFromCounts(chars, cjk) {
    return Math.ceil(cjk * 0.8 + Math.max(0, chars - cjk) / 3.6);
}

function payloadTokensRaw(chars, cjk) {
    return cjk * 0.8 + Math.max(0, chars - cjk) / 3.6;
}

// estimateLlmOutputTokens(plainText, sourceHtml):
//   visible = est(plainText); structural = max(0, est(sourceHtml) − visible)
//   out = ceil(visible*1.25 + structural*0.8)
function tokensForLeaves(leaves) {
    let srcChars = 0;
    let srcCjk = 0;
    let plainChars = 0;
    let plainCjk = 0;
    for (const leaf of leaves) {
        srcChars += leaf.srcChars;
        srcCjk += leaf.srcCjk;
        plainChars += leaf.plainChars;
        plainCjk += leaf.plainCjk;
    }
    const visible = payloadTokensRaw(plainChars, plainCjk);
    const srcEst = payloadTokensRaw(srcChars, srcCjk);
    const structural = Math.max(0, srcEst - visible);
    return {
        srcChars,
        inTok: payloadTokensFromCounts(srcChars, srcCjk),
        outTok: Math.ceil(visible * 1.25 + structural * 0.8),
    };
}

// ───────────────────────────── Real-page section extraction ─────────────────────────────
// Loader copied from tools/find-untranslated.mjs (babel transform + vm over JSDOM).

async function loadContext(seedDoc, win) {
    const source = await fs.readFile(domContextPath, "utf8");
    const mod = { exports: {} };
    const sandbox = {
        module: mod,
        exports: mod.exports,
        require,
        console,
        document: seedDoc,
        window: win,
        Node: win.Node,
        NodeFilter: win.NodeFilter,
        DOMParser: win.DOMParser,
        Element: win.Element,
        DocumentFragment: win.DocumentFragment,
    };
    vm.createContext(sandbox);
    const { code } = transformSync(source, {
        filename: domContextPath,
        babelrc: false,
        configFile: false,
        presets: [[require.resolve("@babel/preset-env"), { targets: { node: "18" } }]],
    });
    new vm.Script(code, { filename: domContextPath }).runInContext(sandbox);
    return mod.exports;
}

function textLen(el) {
    return String((el && el.textContent) || "")
        .replace(/\s+/g, " ")
        .trim().length;
}

// Mirror getDomPagePrimaryContentRoot() the way find-untranslated.mjs does.
function primaryContentRoot(doc) {
    const bodyLen = textLen(doc.body);
    const mains = Array.from(doc.querySelectorAll("main, [role='main']")).filter(
        (el) => textLen(el) >= 200
    );
    if (mains.length === 1 && textLen(mains[0]) / bodyLen >= 0.35) return mains[0];
    return doc.querySelector(".mw-parser-output") || doc.body;
}

async function extractSections() {
    const html = await fs.readFile(PAGE_PATH, "utf8");
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const ctx = await loadContext(doc, dom.window);
    const root = primaryContentRoot(doc);

    const sections = ctx.collectHtmlPageSections([root], {
        minChars: 600,
        maxChars: 20000,
        recurseNestedContainers: true,
    });

    const out = [];
    for (const section of sections) {
        const leaves = [];
        for (const child of section.children) {
            for (const leaf of ctx.findLeafBlocksInElement(child)) {
                const segment = ctx.serializeTranslationLeaf(leaf);
                if (!segment || !segment.text) continue;
                const src = charCounts(segment.text);
                const plain = charCounts(segment.plainText || "");
                leaves.push({
                    srcChars: src.chars,
                    srcCjk: src.cjk,
                    plainChars: plain.chars,
                    plainCjk: plain.cjk,
                });
            }
        }
        if (!leaves.length) continue;
        out.push({ leaves });
    }
    return { sections: out, rootTag: root.tagName.toLowerCase() };
}

// ───────────────────────────── Entries + geometry ─────────────────────────────

function buildEntries(sections) {
    const totalChars = sections.reduce(
        (sum, s) => sum + s.leaves.reduce((a, l) => a + l.srcChars, 0),
        0
    );
    const charsPerPixel = totalChars / PAGE_HEIGHT;
    const entries = [];
    let cum = 0;
    for (let i = 0; i < sections.length; i += 1) {
        const t = tokensForLeaves(sections[i].leaves);
        const top = cum / charsPerPixel;
        cum += t.srcChars;
        const bottom = Math.max(top + 1, cum / charsPerPixel);
        entries.push({
            id: i,
            leaves: sections[i].leaves,
            chars: t.srcChars,
            inTok: t.inTok,
            outTok: t.outTok,
            top,
            bottom,
        });
    }
    return { entries, totalChars, charsPerPixel };
}

// ───────────────────────────── Viewport ranking (getAiPageSectionViewportRank) ─────────────────────────────

function viewportRank(entry, scrollY, index) {
    const rectTop = entry.top - scrollY;
    const rectBottom = entry.bottom - scrollY;
    const visiblePx = Math.max(0, Math.min(VH, rectBottom) - Math.max(0, rectTop));
    if (visiblePx > 0) {
        return { tier: 0, distance: Math.max(0, rectTop), visiblePx: -visiblePx, index };
    }
    if (rectTop >= VH && rectTop < VH * 2) {
        return { tier: 1, distance: rectTop - VH, visiblePx: 0, index };
    }
    if (rectBottom <= 0 && rectBottom >= -VH) {
        return { tier: 2, distance: Math.abs(rectBottom), visiblePx: 0, index };
    }
    return {
        tier: 3,
        distance: rectTop >= VH ? rectTop - VH : Math.abs(rectBottom),
        visiblePx: 0,
        index,
    };
}

function rankEntries(list, scrollY) {
    return list
        .map((entry, index) => ({ entry, ...viewportRank(entry, scrollY, index) }))
        .sort(
            (a, b) =>
                a.tier - b.tier ||
                a.distance - b.distance ||
                a.visiblePx - b.visiblePx ||
                (a.entry.inTok || 0) - (b.entry.inTok || 0) ||
                a.index - b.index
        )
        .map((r) => r.entry);
}

// ───────────────────────────── Batch packing (buildAiPageSectionBatches) ─────────────────────────────

function buildBatches(list, opts, { conc, minBatchChars, cloud, tailBalance }) {
    if (!list.length) return [];
    const totalChars = list.reduce((s, e) => s + e.chars, 0);
    const perSlotChars = Math.ceil(totalChars / conc);
    const targetBase =
        tailBalance && cloud && perSlotChars > 2 * minBatchChars
            ? Math.ceil(totalChars / (2 * conc))
            : perSlotChars;
    const targetChars = Math.min(opts.maxChars, Math.max(minBatchChars, targetBase));
    const batches = [];
    let cur = [];
    let curChars = 0;
    let curIn = 0;
    let curOut = 0;
    for (const e of list) {
        const overflow =
            cur.length >= opts.maxItems ||
            (cur.length > 0 && curChars + e.chars > targetChars) ||
            (cur.length > 0 && curIn + e.inTok > opts.maxInputTokens) ||
            (cur.length > 0 && curOut + e.outTok > opts.maxOutputTokens);
        if (overflow) {
            batches.push(cur);
            cur = [];
            curChars = 0;
            curIn = 0;
            curOut = 0;
        }
        cur.push(e);
        curChars += e.chars;
        curIn += e.inTok;
        curOut += e.outTok;
    }
    if (cur.length) batches.push(cur);
    return batches;
}

// ───────────────────────────── Lead-chunk split (splitSectionLeadChunk) ─────────────────────────────

function splitLeadChunk(entry, leadChars) {
    if (!leadChars || entry.leaves.length < 2 || entry.chars <= leadChars) return null;
    let leadCount = 0;
    let cumChars = 0;
    for (let i = 0; i < entry.leaves.length; i += 1) {
        cumChars += entry.leaves[i].srcChars;
        leadCount = i + 1;
        if (cumChars >= leadChars) break;
    }
    if (leadCount === 0 || leadCount === entry.leaves.length) return null;
    const leadLeaves = entry.leaves.slice(0, leadCount);
    const restLeaves = entry.leaves.slice(leadCount);
    const leadT = tokensForLeaves(leadLeaves);
    const restT = tokensForLeaves(restLeaves);
    const height = entry.bottom - entry.top;
    const cut = entry.top + (leadT.srcChars / entry.chars) * height;
    return {
        lead: {
            id: `${entry.id}L`,
            leaves: leadLeaves,
            chars: leadT.srcChars,
            inTok: leadT.inTok,
            outTok: leadT.outTok,
            top: entry.top,
            bottom: cut,
        },
        remainder: {
            id: `${entry.id}R`,
            leaves: restLeaves,
            chars: restT.srcChars,
            inTok: restT.inTok,
            outTok: restT.outTok,
            top: cut,
            bottom: entry.bottom,
        },
    };
}

// ───────────────────────────── Simulator ─────────────────────────────

const EPS = 1e-6;

function simulate({ engineKey, policy, tokenBudget, pxPerSec, baseEntries }) {
    const E = ENGINES[engineKey];
    const maxScroll = PAGE_HEIGHT - VH;
    const scrollYAt = (tMs) => (pxPerSec > 0 ? Math.min((pxPerSec * tMs) / 1000, maxScroll) : 0);
    const batchOpts = policy === "before" ? E.batchBefore : E.batchAfter;
    const tailBalance = policy === "after";
    const packCfg = {
        conc: E.slots,
        minBatchChars: E.minBatchChars,
        cloud: E.cloud,
        tailBalance,
    };

    // Working copy of entries, with the first-dispatch lead-chunk split applied.
    let entries = baseEntries.map((e) => ({ ...e }));
    {
        const rankedAtZero = rankEntries(entries, 0);
        const bestVisible = rankedAtZero.find((e) => viewportRank(e, 0, 0).tier === 0);
        if (bestVisible) {
            const split = splitLeadChunk(bestVisible, E.leadChars);
            if (split) {
                const idx = entries.indexOf(bestVisible);
                entries.splice(idx, 1, split.lead, split.remainder);
            }
        }
    }
    const totalChars = entries.reduce((s, e) => s + e.chars, 0);
    const tier0Ids = new Set(
        entries.filter((e) => viewportRank(e, 0, 0).tier === 0).map((e) => e.id)
    );

    // ── request machinery ──
    let now = 0;
    const queue = []; // FIFO of requests
    const running = []; // {end, ...req}
    const requests = []; // all started requests (for stats)
    const completedAt = new Map(); // entry id → completion ms
    let truncatedCount = 0;
    let oversizedAtomicOverModernCap = 0;

    function makeRequest(reqEntries, kind) {
        const inTok = reqEntries.reduce((s, e) => s + e.inTok, 0);
        const outTok = reqEntries.reduce((s, e) => s + e.outTok, 0);
        let durMs = E.ttftMs + (outTok / E.tokPerSec) * 1000;
        let inBilled = inTok;
        let outBilled = outTok;
        let truncated = false;
        if (policy === "before" && engineKey === "openai" && outTok > OPENAI_FIRST_ATTEMPT_CAP_BEFORE) {
            // Truncation double-generation: gen(4096) + TTFT + gen(full); input billed twice.
            truncated = true;
            durMs =
                E.ttftMs +
                (OPENAI_FIRST_ATTEMPT_CAP_BEFORE / E.tokPerSec) * 1000 +
                E.ttftMs +
                (outTok / E.tokPerSec) * 1000;
            inBilled = inTok * 2;
            outBilled = outTok + OPENAI_FIRST_ATTEMPT_CAP_BEFORE;
        }
        if (policy === "after" && engineKey === "openai" && outTok > OPENAI_MODERN_ATOMIC_CAP) {
            // Modeled as one stream under the modern 12288 first-attempt cap (see header).
            oversizedAtomicOverModernCap += 1;
        }
        return { entries: reqEntries, inTok, outTok, inBilled, outBilled, durMs, truncated, kind };
    }

    function enqueue(req) {
        queue.push(req);
    }

    function startRequests() {
        while (running.length < E.slots && queue.length) {
            const req = queue.shift();
            req.start = now;
            req.end = now + req.durMs;
            if (req.truncated) truncatedCount += 1;
            running.push(req);
            requests.push(req);
        }
    }

    // Singles/batches split shared by the initial wave and BEFORE reveal bursts.
    function dispatchWave(ranked, scrollY) {
        const visible = ranked.filter((e) => viewportRank(e, scrollY, 0).tier === 0);
        const offscreen = ranked.filter((e) => viewportRank(e, scrollY, 0).tier !== 0);
        const singles = visible.slice(0, Math.min(E.streamingLimit, visible.length));
        const batchEntries = visible.slice(singles.length).concat(offscreen);
        for (const s of singles) enqueue(makeRequest([s], "single"));
        for (const b of buildBatches(batchEntries, batchOpts, packCfg)) {
            enqueue(makeRequest(b, "batch"));
        }
    }

    // ── initial wave at t = 0 (selectAiPageEntriesForLazyWindow) ──
    const ranked0 = rankEntries(entries, 0);
    const keep = [];
    const deferred = [];
    {
        const belowLimit = (1 + SCREENS_BELOW) * VH; // rect.top < belowLimit
        const aboveLimit = SCREENS_ABOVE * VH; // rect.bottom > −aboveLimit
        let waveTokens = 0;
        for (const e of ranked0) {
            const within = e.top - 0 < belowLimit && e.bottom - 0 > -aboveLimit;
            const fits = tokenBudget <= 0 || waveTokens + e.inTok <= tokenBudget;
            if (!keep.length || (within && fits)) {
                keep.push(e);
                waveTokens += e.inTok;
            } else {
                deferred.push(e);
            }
        }
    }
    dispatchWave(keep, 0);

    // ── deferred handling ──
    // Reveal time: section top crosses scrollY + 3.5*vh (IntersectionObserver rootMargin 250%).
    const revealTimeOf = (e) => {
        if (e.top <= REVEAL_MARGIN_PX) return 0;
        if (pxPerSec <= 0) return Infinity;
        return ((e.top - REVEAL_MARGIN_PX) / pxPerSec) * 1000;
    };

    const timed = []; // {t, kind, ...}
    let backlog = []; // AFTER only
    let eagerTokens = 0;
    let needsRank = false;

    if (policy === "before") {
        // Cluster reveals: trailing 120ms debounce, 600ms max-defer, then +35ms re-collect.
        const reveals = deferred
            .map((e) => ({ t: revealTimeOf(e), e }))
            .filter((r) => Number.isFinite(r.t))
            .sort((a, b) => a.t - b.t);
        let cluster = null;
        const flush = () => {
            if (!cluster) return;
            timed.push({ t: cluster.fire + RECOLLECT_MS, kind: "burst", list: cluster.list });
            cluster = null;
        };
        for (const r of reveals) {
            if (cluster && r.t <= cluster.fire + EPS) {
                cluster.list.push(r.e);
                cluster.fire = Math.min(r.t + DEBOUNCE_MS, cluster.t0 + DEBOUNCE_MAX_DEFER_MS);
            } else {
                flush();
                cluster = { t0: r.t, fire: r.t + DEBOUNCE_MS, list: [r.e] };
            }
        }
        flush();
    } else {
        backlog = deferred.slice(); // already viewport-ranked
        for (const e of deferred) {
            const t = revealTimeOf(e);
            if (Number.isFinite(t)) timed.push({ t, kind: "reveal", entry: e });
        }
    }
    timed.sort((a, b) => a.t - b.t);

    // ── AFTER backlog promotion pump (promoteAiPageBacklogEntries) ──
    function pumpOnce() {
        if (!backlog.length) return false;
        const freeSlots = E.slots - running.length - queue.length;
        if (freeSlots <= 0) return false;
        const boostedOnly = E.slots <= 8 && freeSlots <= 1 && running.length > 0;
        if (needsRank) {
            needsRank = false;
            const scrollY = scrollYAt(now);
            const boosted = backlog.filter((e) => e._boost);
            const rest = backlog.filter((e) => !e._boost);
            backlog = rankEntries(boosted, scrollY).concat(rankEntries(rest, scrollY));
        }
        const backlogChars = backlog.reduce((s, e) => s + e.chars, 0);
        const perBatchTarget = Math.min(
            batchOpts.maxChars,
            Math.max(E.minBatchChars, Math.ceil(backlogChars / E.slots))
        );
        const charBudget = freeSlots * perBatchTarget;
        const promoted = [];
        const remaining = [];
        let accumChars = 0;
        for (const e of backlog) {
            if (accumChars >= charBudget) {
                remaining.push(e);
                continue;
            }
            if (boostedOnly && !e._boost) {
                remaining.push(e);
                continue;
            }
            if (!e._boost && tokenBudget > 0 && eagerTokens >= tokenBudget) {
                remaining.push(e);
                continue;
            }
            promoted.push(e);
            accumChars += e.chars;
            if (!e._boost) eagerTokens += e.inTok;
        }
        backlog = remaining;
        if (!promoted.length) return false;
        for (const b of buildBatches(promoted, batchOpts, packCfg)) {
            enqueue(makeRequest(b, "promoted"));
        }
        return true;
    }

    function pumpLoop() {
        if (policy !== "after") return;
        while (pumpOnce()) {
            /* keep refilling until slot/budget/backlog blocked */
        }
    }

    // ── event loop ──
    pumpLoop();
    startRequests();
    let timedIdx = 0;
    let guard = 0;
    while (true) {
        guard += 1;
        if (guard > 1e6) throw new Error("event-loop guard tripped");
        const nextEnd = running.length ? Math.min(...running.map((r) => r.end)) : Infinity;
        const nextTimed = timedIdx < timed.length ? timed[timedIdx].t : Infinity;
        const t = Math.min(nextEnd, nextTimed);
        if (!Number.isFinite(t)) break;
        now = t;
        // completions
        for (let i = running.length - 1; i >= 0; i -= 1) {
            if (running[i].end <= now + EPS) {
                const req = running[i];
                running.splice(i, 1);
                for (const e of req.entries) completedAt.set(e.id, req.end);
            }
        }
        // timed events
        while (timedIdx < timed.length && timed[timedIdx].t <= now + EPS) {
            const ev = timed[timedIdx];
            timedIdx += 1;
            if (ev.kind === "burst") {
                // BEFORE reveal burst: re-ranked at dispatch time, singles/batches split.
                dispatchWave(rankEntries(ev.list, scrollYAt(now)), scrollYAt(now));
            } else if (ev.kind === "reveal") {
                // AFTER: boost the entry if still in the backlog (reveal-to-request ≈ 0ms).
                const hit = backlog.find((e) => e.id === ev.entry.id);
                if (hit && !hit._boost) {
                    hit._boost = true;
                    needsRank = true;
                }
            }
        }
        pumpLoop();
        startRequests();
    }

    if (process.env.SIM_DEBUG) {
        console.error(
            `\n[debug] ${engineKey}/${policy}/b=${tokenBudget}/v=${pxPerSec} — first 12 requests:`
        );
        for (const r of requests.slice(0, 12)) {
            console.error(
                `  ${r.kind} start=${r.start.toFixed(0)}ms end=${r.end.toFixed(0)}ms ` +
                    `in=${r.inTok} out=${r.outTok} entries=[${r.entries
                        .map((e) => `${e.id}(${e.chars}c)`)
                        .join(",")}]`
            );
        }
        console.error(
            `  tier0=[${[...tier0Ids].join(",")}] | last end=${Math.max(
                ...requests.map((r) => r.end)
            ).toFixed(0)}ms by [${requests
                .slice()
                .sort((a, b) => b.end - a.end)[0]
                .entries.map((e) => `${e.id}(${e.chars}c,out${e.outTok})`)
                .join(",")}]`
        );
    }

    // ── metrics ──
    const finiteEnds = requests.map((r) => r.end);
    const makespan = finiteEnds.length ? Math.max(...finiteEnds) : 0;
    let ttfv = Infinity;
    for (const req of requests) {
        if (req.entries.some((e) => tier0Ids.has(e.id))) ttfv = Math.min(ttfv, req.end);
    }
    let viewportDone = 0;
    for (const id of tier0Ids) {
        const t = completedAt.get(id);
        if (t === undefined) {
            viewportDone = Infinity;
            break;
        }
        viewportDone = Math.max(viewportDone, t);
    }
    let fullPage = 0;
    let completedChars = 0;
    for (const e of entries) {
        const t = completedAt.get(e.id);
        if (t === undefined) fullPage = Infinity;
        else {
            fullPage = Math.max(fullPage, t);
            completedChars += e.chars;
        }
    }
    const busyMs = requests.reduce((s, r) => s + r.durMs, 0);
    const meanUtil = makespan > 0 ? busyMs / (E.slots * makespan) : 0;
    // peak concurrency via sweep
    const points = [];
    for (const r of requests) {
        points.push([r.start, 1], [r.end, -1]);
    }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let peak = 0;
    for (const [, d] of points) {
        cur += d;
        peak = Math.max(peak, cur);
    }
    return {
        engine: engineKey,
        policy,
        tokenBudget,
        scrollPxPerSec: pxPerSec,
        ttfvMs: ttfv,
        viewportDoneMs: viewportDone,
        fullPageMs: fullPage,
        coveragePct: (completedChars / totalChars) * 100,
        requests: requests.length,
        inputTokens: requests.reduce((s, r) => s + r.inBilled, 0),
        outputTokens: requests.reduce((s, r) => s + r.outBilled, 0),
        truncatedRequests: truncatedCount,
        oversizedAtomicOverModernCap,
        peakUtil: peak / E.slots,
        meanUtil,
        makespanMs: makespan,
    };
}

// ───────────────────────────── Run + report ─────────────────────────────

function fmtSec(ms) {
    if (!Number.isFinite(ms)) return "∞";
    return (ms / 1000).toFixed(1);
}

function fmtFull(r) {
    if (Number.isFinite(r.fullPageMs)) return fmtSec(r.fullPageMs);
    return `∞ (${r.coveragePct.toFixed(0)}% cov)`;
}

function fmtKTok(n) {
    return (n / 1000).toFixed(1);
}

const { sections, rootTag } = await extractSections();
const { entries: baseEntries, totalChars } = buildEntries(sections);
const totalIn = baseEntries.reduce((s, e) => s + e.inTok, 0);
const totalOut = baseEntries.reduce((s, e) => s + e.outTok, 0);

console.log(
    `page: ${PAGE_PATH} | root <${rootTag}> | ${baseEntries.length} sections | ` +
        `${totalChars} serialized chars | est ${totalIn} in-tok / ${totalOut} out-tok | ` +
        `geometry: ${PAGE_HEIGHT}px page, ${(totalChars / PAGE_HEIGHT).toFixed(1)} chars/px, vh ${VH}px`
);

const variants = [
    { policy: "before", tokenBudget: TOKEN_BUDGET_DEFAULT, label: "BEFORE" },
    { policy: "after", tokenBudget: TOKEN_BUDGET_DEFAULT, label: "AFTER b=16k" },
    { policy: "after", tokenBudget: 0, label: "AFTER b=0" },
];

const results = [];
for (const engineKey of Object.keys(ENGINES)) {
    for (const speed of SCROLL_SPEEDS) {
        for (const v of variants) {
            const r = simulate({
                engineKey,
                policy: v.policy,
                tokenBudget: v.tokenBudget,
                pxPerSec: speed.pxPerSec,
                baseEntries,
            });
            r.scroll = speed.key;
            r.label = v.label;
            results.push(r);
        }
    }
}

// ── markdown table ──
const header =
    "| engine | scroll | policy | TTFV s | viewport s | full page s | reqs | in kTok | out kTok | trunc | util mean/peak |";
const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
console.log("\n" + header + "\n" + sep);
for (const r of results) {
    console.log(
        `| ${r.engine} | ${r.scroll} | ${r.label} | ${fmtSec(r.ttfvMs)} | ${fmtSec(
            r.viewportDoneMs
        )} | ${fmtFull(r)} | ${r.requests} | ${fmtKTok(r.inputTokens)} | ${fmtKTok(
            r.outputTokens
        )} | ${r.truncatedRequests} | ${(r.meanUtil * 100).toFixed(0)}%/${(
            r.peakUtil * 100
        ).toFixed(0)}% |`
    );
}

// ── sanity checks ──
const checks = [];
function check(name, ok, detail = "") {
    checks.push({ name, ok, detail });
}

check(
    "utilization ≤ 1 everywhere",
    results.every((r) => r.meanUtil <= 1 + EPS && r.peakUtil <= 1 + EPS)
);
check(
    "truncation double-gen only in BEFORE openai",
    results.every(
        (r) => r.truncatedRequests === 0 || (r.policy === "before" && r.engine === "openai")
    )
);
for (const engineKey of Object.keys(ENGINES)) {
    for (const speed of SCROLL_SPEEDS) {
        const cell = results.filter((r) => r.engine === engineKey && r.scroll === speed.key);
        const before = cell.find((r) => r.label === "BEFORE");
        for (const label of ["AFTER b=16k", "AFTER b=0"]) {
            const after = cell.find((r) => r.label === label);
            const bothInf =
                !Number.isFinite(before.fullPageMs) && !Number.isFinite(after.fullPageMs);
            const ok = bothInf
                ? after.coveragePct >= before.coveragePct - EPS
                : (Number.isFinite(after.fullPageMs) ? after.fullPageMs : Infinity) <=
                  (Number.isFinite(before.fullPageMs) ? before.fullPageMs : Infinity) + EPS;
            check(
                `AFTER ≤ BEFORE full-page (${engineKey}/${speed.key}/${label})` +
                    (bothInf ? " [both ∞ → coverage ≥]" : ""),
                ok,
                `before=${fmtFull(before)} after=${fmtFull(after)}`
            );
        }
        check(
            `BEFORE no-scroll = first window only (${engineKey})`,
            speed.key !== "no-scroll" || !Number.isFinite(before.fullPageMs),
            `coverage ${before.coveragePct.toFixed(1)}%`
        );
    }
}
{
    // Target "roughly 10-30s". Tolerance to 35s: the tail is GENERATION-bound by the page's
    // largest atomic section (22.7k serialized chars → ~9.5k est output tokens → ~31.7s of
    // pure generation at 300 tok/s + TTFT), a floor no dispatch policy can beat without
    // splitting sections. The dispatch itself saturates all 32 slots from t≈0.
    const r = results.find(
        (x) => x.engine === "googleAiStudio" && x.scroll === "no-scroll" && x.label === "AFTER b=0"
    );
    const largestAtomicMs =
        ENGINES.googleAiStudio.ttftMs +
        (Math.max(...baseEntries.map((e) => e.outTok)) / ENGINES.googleAiStudio.tokPerSec) * 1000;
    check(
        "AFTER googleAiStudio no-scroll b=0 full page ≈ 10-30s (gen-bound floor tolerance ≤35s)",
        r.fullPageMs >= 8000 && r.fullPageMs <= 35000,
        `${fmtSec(r.fullPageMs)}s (largest atomic section alone needs ${fmtSec(largestAtomicMs)}s)`
    );
}

console.log("\nsanity checks:");
for (const c of checks) {
    console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
}
const failed = checks.filter((c) => !c.ok);

// ── JSON ──
console.log("\nJSON:");
console.log(
    JSON.stringify(
        {
            page: PAGE_PATH,
            geometry: { pageHeightPx: PAGE_HEIGHT, viewportPx: VH, totalChars },
            sections: baseEntries.length,
            estTokens: { input: totalIn, output: totalOut },
            engines: ENGINES,
            results: results.map((r) => ({
                ...r,
                ttfvMs: Number.isFinite(r.ttfvMs) ? Math.round(r.ttfvMs) : null,
                viewportDoneMs: Number.isFinite(r.viewportDoneMs)
                    ? Math.round(r.viewportDoneMs)
                    : null,
                fullPageMs: Number.isFinite(r.fullPageMs) ? Math.round(r.fullPageMs) : null,
                makespanMs: Math.round(r.makespanMs),
                coveragePct: Number(r.coveragePct.toFixed(2)),
                peakUtil: Number(r.peakUtil.toFixed(3)),
                meanUtil: Number(r.meanUtil.toFixed(3)),
            })),
            sanityChecks: checks,
        },
        null,
        1
    )
);

process.exitCode = failed.length ? 1 : 0;
