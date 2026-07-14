#!/usr/bin/env node

/**
 * Paid, no-retry research probe for whole Semantic Document translation.
 *
 * This intentionally bypasses the production scheduler. It collects the same vNext semantic
 * targets, deduplicates them like the session, then sends the complete document in one Responses
 * request. Only aggregate diagnostics and hashes are emitted; source/translation text and API
 * keys are never written to the artifact.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
const { JSDOM } = require("jsdom");
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sourceRoot = path.join(repoRoot, "packages/EdgeTranslate/src/content/ai_page_translation");

function readArg(name, fallback = "") {
    const prefix = `--${name}=`;
    const found = process.argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}

function readPositiveNumber(name, fallback) {
    const value = Number(readArg(name, fallback));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sha256(value) {
    return createHash("sha256").update(String(value)).digest("hex");
}

function loadModule(filePath, globals, cache = new Map()) {
    const resolved = path.resolve(filePath);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const source = fs.readFileSync(resolved, "utf8");
    const { code } = transformSync(source, {
        filename: resolved,
        babelrc: false,
        configFile: false,
        presets: [[require.resolve("@babel/preset-env"), { targets: { node: "18" } }]],
    });
    const localRequire = (specifier) => {
        if (!specifier.startsWith(".")) return require(specifier);
        const dependency = path.resolve(path.dirname(resolved), specifier);
        return loadModule(
            path.extname(dependency) ? dependency : `${dependency}.js`,
            globals,
            cache
        );
    };
    const sandbox = {
        ...globals,
        module,
        exports: module.exports,
        require: localRequire,
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        URL,
    };
    vm.createContext(sandbox);
    new vm.Script(code, { filename: resolved }).runInContext(sandbox);
    return module.exports;
}

const PLACEHOLDER = /<\/?g\d+>|<v\d+\/>/g;
const EXACT_PROTECTED_PATTERNS = [
    { kind: "url", regex: /https?:\/\/[^\s<>"'\uff09)\]]+/g },
    { kind: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    { kind: "code", regex: /`[^`\n]+`/g },
    { kind: "identifier", regex: /\b[A-Za-z][A-Za-z0-9_.-]*\d[A-Za-z0-9_.-]*\b/g },
];
const ALL_PROTECTED_PATTERNS = [
    ...EXACT_PROTECTED_PATTERNS,
    { kind: "number", regex: /[0-9\uff10-\uff19][0-9\uff10-\uff19.,]*/g },
];

function rangesFor(text, regex) {
    return Array.from(String(text).matchAll(regex), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
    }));
}

function overlaps(left, right) {
    return left.start < right.end && right.start < left.end;
}

function protectText(text, itemIndex, patterns) {
    const source = String(text || "");
    const reserved = rangesFor(source, PLACEHOLDER);
    const candidates = [];
    for (const { kind, regex } of patterns) {
        for (const range of rangesFor(source, regex)) {
            if (reserved.some((item) => overlaps(item, range))) continue;
            candidates.push({ ...range, kind });
        }
    }
    candidates.sort(
        (left, right) =>
            left.start - right.start || right.end - right.start - (left.end - left.start)
    );
    const selected = [];
    for (const candidate of candidates) {
        if (!selected.some((item) => overlaps(item, candidate))) selected.push(candidate);
    }
    const replacements = new Map();
    let protectedText = source;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
        const match = selected[index];
        const token = `<v${900000000 + itemIndex * 10000 + index}/>`;
        replacements.set(token, { value: match.value, kind: match.kind });
        protectedText = `${protectedText.slice(0, match.start)}${token}${protectedText.slice(
            match.end
        )}`;
    }
    return { text: protectedText, replacements };
}

function partitionContiguous(items, packetCount) {
    const count = Math.max(1, Math.min(items.length || 1, Math.floor(packetCount)));
    if (count === 1) return [items];
    const totalChars = items.reduce((sum, item) => sum + item.wireText.length, 0);
    const targetChars = totalChars / count;
    const packets = [];
    let packet = [];
    let packetChars = 0;
    let processedItems = 0;
    for (const item of items) {
        const remainingItems = items.length - processedItems;
        const remainingPackets = count - packets.length;
        if (packet.length && packetChars >= targetChars && remainingItems >= remainingPackets - 1) {
            packets.push(packet);
            packet = [];
            packetChars = 0;
        }
        packet.push(item);
        packetChars += item.wireText.length;
        processedItems += 1;
    }
    if (packet.length) packets.push(packet);
    return packets;
}

function restoreText(text, replacements) {
    let restored = String(text || "");
    const failures = [];
    for (const [token, entry] of replacements) {
        const count = restored.split(token).length - 1;
        if (count !== 1) failures.push({ kind: entry.kind, count });
        if (count === 1) restored = restored.replace(token, entry.value);
    }
    return { ok: failures.length === 0, text: restored, failures };
}

function receiptValue(receipt, field) {
    const value = receipt?.[field];
    return Number.isFinite(value) ? Number(value) : Number(value?.value || 0);
}

const url = readArg("url");
const mode = readArg("mode", "protected");
const model = readArg("model", "gpt-5.6-luna");
const sourceLanguage = readArg("sl", "en");
const targetLanguage = readArg("tl", "ko");
const maxOutputTokens = readPositiveNumber("max-output-tokens", 32768);
const requestedPacketCount = readPositiveNumber("packets", 1);
const confirmProviderCost = process.argv.includes("--confirm-provider-cost");

if (!url) {
    throw new Error(
        "Usage: ai-page-translation-semantic-document-benchmark.mjs --url=<page> " +
            "--mode=raw|protected-exact|protected --packets=1 --confirm-provider-cost"
    );
}
if (!new Set(["raw", "protected-exact", "protected"]).has(mode)) {
    throw new Error(`Unknown --mode=${mode}`);
}
if (!confirmProviderCost) throw new Error("Refusing provider call without --confirm-provider-cost");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const pageResponse = await fetch(url, {
    headers: {
        "user-agent": "EdgeTranslate-Semantic-Document-Benchmark/1.0",
        accept: "text/html",
    },
});
if (!pageResponse.ok) throw new Error(`Page fetch failed: ${pageResponse.status}`);
const html = await pageResponse.text();
const dom = new JSDOM(html, { url });
const globals = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    CSS: dom.window.CSS,
};
const moduleCache = new Map();
const { TargetRegistry } = loadModule(
    path.join(sourceRoot, "dom/target_registry.js"),
    globals,
    moduleCache
);
const { collectPage } = loadModule(path.join(sourceRoot, "dom/collector.js"), globals, moduleCache);
const { validateTranslatedItem } = loadModule(
    path.join(sourceRoot, "runtime/validator.js"),
    globals,
    moduleCache
);

const registry = new TargetRegistry("semantic-document-benchmark");
const collectionStartedAt = performance.now();
const collected = collectPage(dom.window.document.body, registry, { includeHidden: false });
const collectionMs = performance.now() - collectionStartedAt;
const representatives = [];
const seen = new Set();
for (const [index, record] of collected.viewportTargets.entries()) {
    const source = String(record.target.source || "");
    const role = record.target.role && record.target.role !== "text" ? record.target.role : "p";
    const key = `${role}\u0000${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    representatives.push({
        id: `d${index.toString(36)}`,
        source,
        role,
        inventory: record.ir?.placeholderInventory || null,
    });
}

const protectedItems = representatives.map((item, index) => {
    const patterns =
        mode === "protected"
            ? ALL_PROTECTED_PATTERNS
            : mode === "protected-exact"
            ? EXACT_PROTECTED_PATTERNS
            : null;
    const protection = patterns ? protectText(item.source, index, patterns) : null;
    return {
        ...item,
        wireText: protection ? protection.text : item.source,
        replacements: protection ? protection.replacements : new Map(),
    };
});
const packets = partitionContiguous(protectedItems, requestedPacketCount);

const { OpenAIResponsesAdapter, effectiveUsageTotal } = await import(
    "../packages/translators/dist/translators.es.js"
);
const adapter = new OpenAIResponsesAdapter();
const profile = {
    id: `semantic-document-${model}`,
    revision: `semantic-document:${model}:${mode}`,
    protocol: "openai-responses",
    modelId: model,
    apiKey: process.env.OPENAI_API_KEY,
    structuredOutput: "json-schema",
    timeoutMs: 180000,
};
const commonContext = {
    title: String(dom.window.document.title || "").trim(),
    domain: new URL(url).hostname,
};
const requests = packets.map((packet, index) => ({
    requestId: `semantic-document-${Date.now()}-${index}`,
    sessionId: "semantic-document-benchmark",
    sourceLanguage,
    targetLanguage,
    wireProtocol: "pt3",
    ctx: commonContext,
    maxOutputTokens,
    items: packet.map((item) => ({ id: item.id, text: item.wireText, role: item.role })),
}));

const countedInputs = await Promise.all(
    requests.map((request) => adapter.countInput(profile, request, new AbortController().signal))
);
const generationStartedAt = performance.now();
const providerResults = await Promise.all(
    requests.map((request) => adapter.executeOnce(profile, request, new AbortController().signal))
);
const generationMs = performance.now() - generationStartedAt;
const returnedItems = providerResults.flatMap((result) =>
    result.ok ? result.items : result.partialItems || []
);
const returnedById = new Map(returnedItems.map((item) => [item.id, item]));
const validationFailures = {};
const protectionFailures = {};
let validItems = 0;
let restoredItems = 0;
let keepSourceItems = 0;
for (const item of protectedItems) {
    const returned = returnedById.get(item.id);
    if (!returned) {
        validationFailures.missing = (validationFailures.missing || 0) + 1;
        continue;
    }
    if (returned.keepSource) keepSourceItems += 1;
    const restored = restoreText(returned.translatedText, item.replacements);
    if (restored.ok) restoredItems += 1;
    for (const failure of restored.failures) {
        const key = `protected-${failure.kind}`;
        protectionFailures[key] = (protectionFailures[key] || 0) + 1;
    }
    const verdict = validateTranslatedItem(
        {
            source: item.source,
            translated: restored.text,
            keepSource: returned.keepSource === true,
            placeholderInventory: item.inventory,
        },
        { targetLanguage }
    );
    if (restored.ok && verdict.verdict !== "fail") {
        validItems += 1;
        continue;
    }
    for (const failure of verdict.failures || []) {
        validationFailures[failure.class] = (validationFailures[failure.class] || 0) + 1;
    }
}

const usage = providerResults
    .flatMap((result) => result.usageReceipts || [])
    .reduce(
        (totals, receipt) => {
            totals.inputTokens += receiptValue(receipt, "inputTokens");
            totals.outputTokens += receiptValue(receipt, "outputTokens");
            totals.reasoningTokens += receiptValue(receipt, "reasoningTokens");
            totals.cachedInputTokens += receiptValue(receipt, "cachedInputTokens");
            totals.totalTokens += Number(effectiveUsageTotal(receipt)?.value || 0);
            return totals;
        },
        {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
        }
    );

const attemptDurations = providerResults
    .map((result) =>
        result.attempt?.finishedAt && result.attempt?.startedAt
            ? result.attempt.finishedAt - result.attempt.startedAt
            : null
    )
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

const result = {
    schemaVersion: "ai-page-semantic-document-benchmark-1",
    generatedAt: new Date().toISOString(),
    url,
    documentHash: sha256(protectedItems.map((item) => item.source).join("\u0000")),
    config: {
        mode,
        model,
        sourceLanguage,
        targetLanguage,
        maxOutputTokens,
        reasoningEffort: "none-model-default",
        retries: 0,
        requestCount: requests.length,
    },
    extraction: {
        rawHtmlChars: html.length,
        collectionMs: Number(collectionMs.toFixed(2)),
        targets: collected.viewportTargets.length,
        uniqueItems: representatives.length,
        sourceChars: representatives.reduce((sum, item) => sum + item.source.length, 0),
        wireChars: protectedItems.reduce((sum, item) => sum + item.wireText.length, 0),
        protectedValues: protectedItems.reduce((sum, item) => sum + item.replacements.size, 0),
    },
    countedInput: {
        tokens: countedInputs.reduce((sum, item) => sum + Number(item.tokens || 0), 0),
        source: countedInputs.every((item) => item.source === "provider-counted")
            ? "provider-counted"
            : "mixed",
        packets: countedInputs,
    },
    provider: {
        ok: providerResults.every((result) => result.ok),
        failures: providerResults.filter((result) => !result.ok).map((result) => result.failure),
        generationMs: Number(generationMs.toFixed(2)),
        attemptMs: {
            min: attemptDurations[0] || null,
            median: attemptDurations.length
                ? attemptDurations[Math.floor(attemptDurations.length / 2)]
                : null,
            max: attemptDurations.at(-1) || null,
        },
        finishReasons: providerResults.map((result) => result.attempt?.finishReason || null),
        usage,
    },
    integrity: {
        expectedItems: protectedItems.length,
        returnedItems: returnedItems.length,
        restoredItems,
        keepSourceItems,
        validItems,
        invalidItems: protectedItems.length - validItems,
        protectionFailures,
        validationFailures,
    },
    warning:
        "Paid no-retry research probe. Output contains aggregate diagnostics only; translations are not persisted.",
};

console.log(JSON.stringify(result, null, 2));
