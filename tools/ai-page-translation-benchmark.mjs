import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
const { JSDOM } = require("jsdom");

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const domContextPath = path.join(
    repoRoot,
    "packages/EdgeTranslate/src/content/dom_page_translate_context.js"
);

function readNumberArg(name, fallback) {
    const prefix = `--${name}=`;
    const found = process.argv.find((arg) => arg.startsWith(prefix));
    if (!found) return fallback;
    const value = Number(found.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function estimateLlmPayloadTokens(text) {
    const value = String(text || "");
    if (!value) return 0;
    const cjkChars = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
    const otherChars = Math.max(0, value.length - cjkChars);
    return Math.ceil(cjkChars * 0.8 + otherChars / 3.6);
}

function estimateLlmOutputTokens(plainText, sourceHtml = "") {
    const visibleTokens = estimateLlmPayloadTokens(plainText || sourceHtml);
    const structuralTokens = Math.max(0, estimateLlmPayloadTokens(sourceHtml) - visibleTokens);
    return Math.ceil(visibleTokens * 1.25 + structuralTokens * 0.8);
}

async function loadDomPageContext() {
    const source = await fs.readFile(domContextPath, "utf8");
    const seed = new JSDOM("<main></main>");
    const module = { exports: {} };
    const sandbox = {
        module,
        exports: module.exports,
        require,
        console,
        document: seed.window.document,
        Node: seed.window.Node,
        NodeFilter: seed.window.NodeFilter,
        DOMParser: seed.window.DOMParser,
        Element: seed.window.Element,
        DocumentFragment: seed.window.DocumentFragment,
    };
    vm.createContext(sandbox);
    const { code } = transformSync(source, {
        filename: domContextPath,
        babelrc: false,
        configFile: false,
        presets: [[require.resolve("@babel/preset-env"), { targets: { node: "18" } }]],
    });
    new vm.Script(code, { filename: domContextPath }).runInContext(sandbox);
    return module.exports;
}

function buildSyntheticPage({ sectionCount, paragraphsPerSection }) {
    const longClass =
        "relative mx-auto flex w-full max-w-screen-xl flex-col gap-4 rounded-md text-slate-900";
    const attrs = [
        `class="${longClass}"`,
        `style="padding:16px;margin:0;color:#222;background:white"`,
        `data-component="article-section"`,
        `data-tracking-id="edge-translate-ai-page-benchmark"`,
        `aria-label="AI page translation benchmark content"`,
    ].join(" ");
    const sections = Array.from({ length: sectionCount }, (_, index) => {
        const paragraphs = Array.from({ length: paragraphsPerSection }, (__, pIndex) => {
            const text = [
                `This benchmark paragraph ${index + 1}.${pIndex + 1} describes a product update,`,
                "explains operational context, and includes enough surrounding words for the",
                "LLM page translator to preserve tone without receiving framework styling noise.",
                "Readers should see translated content quickly while offscreen sections continue",
                "in compact marker-preserving batches.",
            ].join(" ");
            return `<p ${attrs}><span ${attrs}>${text}</span></p>`;
        }).join("\n");
        return `<section ${attrs}><h2 ${attrs}>Release note ${
            index + 1
        }</h2>${paragraphs}</section>`;
    }).join("\n");
    return `<main ${attrs}>${sections}</main>`;
}

function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
    return sorted[index] || 0;
}

function summarizeTiming(values) {
    return {
        minMs: Number(Math.min(...values).toFixed(2)),
        medianMs: Number(percentile(values, 0.5).toFixed(2)),
        p95Ms: Number(percentile(values, 0.95).toFixed(2)),
        maxMs: Number(Math.max(...values).toFixed(2)),
    };
}

function collectTimed(fn, iterations) {
    const values = [];
    for (let i = 0; i < iterations; i += 1) {
        const startedAt = performance.now();
        fn();
        values.push(performance.now() - startedAt);
    }
    return summarizeTiming(values);
}

function packBatches(entries, options) {
    const batches = [];
    let current = [];
    let currentChars = 0;
    let currentInputTokens = 0;
    let currentOutputTokens = 0;
    for (const entry of entries) {
        const chars = entry.sourceHtml.length;
        const inputTokens = entry.inputTokens;
        const outputTokens = entry.outputTokens;
        if (
            current.length >= options.maxItems ||
            (current.length > 0 && currentChars + chars > options.maxChars) ||
            (current.length > 0 && currentInputTokens + inputTokens > options.maxInputTokens) ||
            (current.length > 0 && currentOutputTokens + outputTokens > options.maxOutputTokens)
        ) {
            batches.push(current);
            current = [];
            currentChars = 0;
            currentInputTokens = 0;
            currentOutputTokens = 0;
        }
        current.push(entry);
        currentChars += chars;
        currentInputTokens += inputTokens;
        currentOutputTokens += outputTokens;
    }
    if (current.length) batches.push(current);
    return batches;
}

function scaleOptions(options, scale) {
    return {
        maxChars: Math.round(options.maxChars * scale),
        maxInputTokens: Math.round(options.maxInputTokens * scale),
        maxOutputTokens: Math.round(options.maxOutputTokens * scale),
        maxItems:
            scale > 1
                ? Math.ceil(options.maxItems * Math.min(scale, 1.25))
                : Math.max(1, Math.floor(options.maxItems * scale)),
    };
}

function printSummary(summary) {
    console.log("AI page translation synthetic benchmark");
    console.log(`sections: ${summary.sections}, entries: ${summary.entries}`);
    console.log(
        `DOM collect median/p95: ${summary.collectTiming.medianMs}ms / ${summary.collectTiming.p95Ms}ms`
    );
    console.log(
        `strip+segment median/p95: ${summary.payloadTiming.medianMs}ms / ${summary.payloadTiming.p95Ms}ms`
    );
    console.log(
        `payload chars: ${summary.rawChars} raw -> ${summary.strippedChars} stripped (${summary.charReductionPct}% less)`
    );
    console.log(
        `token estimate: ${summary.rawTokens} raw -> ${summary.strippedTokens} stripped (${summary.tokenReductionPct}% less)`
    );
    console.log(
        `compact markers: ${summary.verboseMarkerChars} chars -> ${summary.compactMarkerChars} chars`
    );
    console.log(
        `openaiCompatible requests: base ${summary.openaiCompatibleBaseBatches}, adaptive-fast ${summary.openaiCompatibleAdaptiveBatches}`
    );
    console.log(JSON.stringify(summary, null, 2));
}

const sectionCount = readNumberArg("sections", 80);
const paragraphsPerSection = readNumberArg("paragraphs", 2);
const iterations = readNumberArg("iterations", 25);
const context = await loadDomPageContext();
const html = buildSyntheticPage({ sectionCount, paragraphsPerSection });
let latestSections = [];
let latestEntries = [];
let latestVerbose = "";
let latestCompact = "";

const collectTiming = collectTimed(() => {
    const dom = new JSDOM(html);
    latestSections = context.collectHtmlPageSections([dom.window.document.querySelector("main")], {
        minChars: 600,
        maxChars: 2400,
        recurseNestedContainers: true,
    });
}, iterations);

const payloadTiming = collectTimed(() => {
    latestEntries = latestSections.map((section) => {
        const sourceHtml = context.buildStrippedSectionHtml(section.children);
        return {
            sourceHtml,
            role: section.role,
            plainText: section.plainText,
            inputTokens: estimateLlmPayloadTokens(sourceHtml),
            outputTokens: estimateLlmOutputTokens(section.plainText, sourceHtml),
        };
    });
    latestVerbose = context.buildSegmentedTranslationText(
        latestEntries.map((entry) => ({ text: entry.sourceHtml, role: entry.role }))
    );
    latestCompact = context.buildSegmentedTranslationText(
        latestEntries.map((entry) => ({ text: entry.sourceHtml, role: entry.role })),
        { compactMarkers: true }
    );
}, iterations);

const rawHtml = latestSections
    .map((section) => section.children.map((child) => child.outerHTML).join("\n"))
    .join("\n");
const rawChars = rawHtml.length;
const strippedChars = latestEntries.reduce((sum, entry) => sum + entry.sourceHtml.length, 0);
const rawTokens = estimateLlmPayloadTokens(rawHtml);
const strippedTokens = latestEntries.reduce((sum, entry) => sum + entry.inputTokens, 0);
const baseOptions = { maxChars: 3200, maxInputTokens: 1050, maxOutputTokens: 1250, maxItems: 2 };
const adaptiveFastOptions = scaleOptions(baseOptions, 1.35);
const summary = {
    sections: sectionCount,
    entries: latestEntries.length,
    paragraphsPerSection,
    iterations,
    collectTiming,
    payloadTiming,
    rawChars,
    strippedChars,
    charReductionPct: Number((((rawChars - strippedChars) / rawChars) * 100).toFixed(1)),
    rawTokens,
    strippedTokens,
    tokenReductionPct: Number((((rawTokens - strippedTokens) / rawTokens) * 100).toFixed(1)),
    verboseMarkerChars: latestVerbose.length,
    compactMarkerChars: latestCompact.length,
    openaiCompatibleBaseBatches: packBatches(latestEntries, baseOptions).length,
    openaiCompatibleAdaptiveBatches: packBatches(latestEntries, adaptiveFastOptions).length,
};

printSummary(summary);

// ---------------------------------------------------------------------------
// Boilerplate-skip token reduction (opt-in). Models a long encyclopedia article
// (à la a big Wikipedia page) whose token cost is dominated by a huge references
// list and navigation boxes rather than the article body itself.
// ---------------------------------------------------------------------------
function buildEncyclopediaPage({ bodyParagraphs, references, navboxLinks }) {
    const body = Array.from(
        { length: bodyParagraphs },
        (_, i) =>
            `<p>Article body paragraph ${i + 1} describing the line's history, route, ` +
            `stations and operations in enough prose to be worth translating for a reader.</p>`
    ).join("\n");
    const refs = Array.from(
        { length: references },
        (_, i) =>
            `<li id="cite_note-${i + 1}"><cite class="citation">Author ${i + 1}, ` +
            `"Cited work title number ${i + 1}", Publisher ${i + 1}, retrieved 2024-01-${
                (i % 28) + 1
            }.</cite></li>`
    ).join("\n");
    const nav = Array.from(
        { length: navboxLinks },
        (_, i) => `<a href="/wiki/Station_${i + 1}">Station ${i + 1}</a>`
    ).join(" ");
    return `<main>
        <div class="mw-parser-output">
            <div id="toc" class="toc"><ul><li>1 History</li><li>2 Route</li><li>3 Stations</li><li>4 References</li></ul></div>
            ${body}
            <h2>References <span class="mw-editsection"><a href="#">edit</a></span></h2>
            <ol class="references">${refs}</ol>
            <table class="navbox"><tbody><tr><td class="navbox-list">${nav}</td></tr></tbody></table>
            <div class="catlinks"><ul><li><a href="/wiki/Category:Rail">Category: Railway lines</a></li><li><a href="/wiki/Category:1910">Category: 1910 establishments</a></li></ul></div>
        </div>
    </main>`;
}

function leafTokens(leaves) {
    return leaves.reduce((sum, leaf) => sum + estimateLlmPayloadTokens(leaf.plainText || ""), 0);
}

const encyclopediaDom = new JSDOM(
    buildEncyclopediaPage({ bodyParagraphs: 60, references: 200, navboxLinks: 80 })
);
const encyclopediaRoot = encyclopediaDom.window.document.querySelector("main");
const allLeaves = context.collectTranslationLeaves([encyclopediaRoot]);
const articleLeaves = context.collectTranslationLeaves([encyclopediaRoot], {
    skipBoilerplate: true,
});
const allTokens = leafTokens(allLeaves);
const articleTokens = leafTokens(articleLeaves);
const boilerplateSummary = {
    fixture: "encyclopedia (60 body paragraphs, 200 references, 80 navbox links)",
    leavesFull: allLeaves.length,
    leavesArticleOnly: articleLeaves.length,
    leafReductionPct: Number(
        (((allLeaves.length - articleLeaves.length) / allLeaves.length) * 100).toFixed(1)
    ),
    inputTokensFull: allTokens,
    inputTokensArticleOnly: articleTokens,
    tokenReductionPct: Number((((allTokens - articleTokens) / allTokens) * 100).toFixed(1)),
};
console.log("\nBoilerplate-skip token reduction (opt-in)");
console.log(
    `leaves: ${boilerplateSummary.leavesFull} -> ${boilerplateSummary.leavesArticleOnly} ` +
        `(${boilerplateSummary.leafReductionPct}% fewer)`
);
console.log(
    `input token estimate: ${boilerplateSummary.inputTokensFull} -> ${boilerplateSummary.inputTokensArticleOnly} ` +
        `(${boilerplateSummary.tokenReductionPct}% less)`
);
console.log(JSON.stringify(boilerplateSummary, null, 2));
