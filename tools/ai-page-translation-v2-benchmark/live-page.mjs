#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
const { JSDOM } = require("jsdom");
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const sourceRoot = path.join(repoRoot, "packages/EdgeTranslate/src/content/ai_page_translation_v2");

function readArg(name, fallback = "") {
    const prefix = `--${name}=`;
    const found = process.argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}

function readNumber(name, fallback) {
    const number = Number(readArg(name, fallback));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function loadCommonJsModule(filePath, globals, cache = new Map()) {
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
        return loadCommonJsModule(
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
    };
    vm.createContext(sandbox);
    new vm.Script(code, { filename: resolved }).runInContext(sandbox);
    return module.exports;
}

const url = readArg("url");
if (!url) throw new Error("Usage: live-page.mjs --url=https://example.com/article");
const policy = readArg("policy", "stable");
if (!["stable", "legacy-v2"].includes(policy)) {
    throw new Error(`Unknown --policy=${policy}; use stable or legacy-v2`);
}
const protocol = readArg("protocol", "array-exact");
const maxInputTokens = readNumber("max-input-tokens", 32768);
const maxOutputTokens = readNumber("max-output-tokens", 4096);
const hardBudget = readNumber("hard-budget", 24000);
const eagerInputBudget = readNumber("eager-input-budget", 8000);

const response = await fetch(url, {
    headers: {
        "user-agent": "EdgeTranslate-V2-structural-benchmark/1.0",
        accept: "text/html",
    },
});
if (!response.ok) throw new Error(`Page fetch failed: ${response.status}`);
const html = await response.text();
const dom = new JSDOM(html, { url });
const globals = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
};
const { TargetRegistry } = loadCommonJsModule(
    path.join(sourceRoot, "dom/target_registry.js"),
    globals
);
const { collectTranslationTargets } = loadCommonJsModule(
    path.join(sourceRoot, "dom/collector.js"),
    globals
);
const { buildSemanticUnits } = loadCommonJsModule(
    path.join(sourceRoot, "ir/semantic_unitizer.js"),
    globals
);
const { planTranslationPackets } = loadCommonJsModule(
    path.join(sourceRoot, "ir/packet_planner.js"),
    globals
);
const { selectAdmissionWindow } = loadCommonJsModule(
    path.join(sourceRoot, "runtime/viewport_admission.js"),
    globals
);

const root =
    policy === "stable"
        ? dom.window.document.body
        : dom.window.document.querySelector("main") || dom.window.document.body;
const registry = new TargetRegistry("live-structural-benchmark");
const startedAt = performance.now();
const collected = collectTranslationTargets(root, registry, {
    includeTitleAttributes: policy !== "stable",
});
const representativeBySource = new Map();
const uniqueTargets = [];
for (const target of collected.targets) {
    const key = `${target.role || "text"}\u0000${target.source}`;
    if (representativeBySource.has(key)) continue;
    representativeBySource.set(key, target);
    uniqueTargets.push(target);
}
const units = buildSemanticUnits(uniqueTargets);
const admission =
    policy === "stable"
        ? { keep: units, deferred: [] }
        : selectAdmissionWindow(units, {
              lazyTranslate: true,
              tokenBudget: eagerInputBudget,
              belowScreens: 8,
              aboveScreens: 2,
          });
const planning = planTranslationPackets(admission.keep, {
    capabilities: { maxInputTokens, maxOutputTokens },
    outputProtocol: protocol,
    fixedInstructionTokens: 180,
    maxTargetsPerPacket: policy === "stable" ? 256 : Number.MAX_SAFE_INTEGER,
    availableTotalTokens: policy === "stable" ? Number.POSITIVE_INFINITY : hardBudget,
});
const elapsedMs = performance.now() - startedAt;
const sumTargets = (list) =>
    list.reduce((sum, unit) => sum + Number(unit.targetIds?.length || 0), 0);
const byKind = units.reduce((result, unit) => {
    result[unit.kind] = (result[unit.kind] || 0) + 1;
    return result;
}, {});
const targetBreakdown = uniqueTargets.reduce((result, target) => {
    const key = target.kind === "attribute" ? `attribute:${target.attributeName}` : target.role;
    const entry = result[key] || { targets: 0, sourceChars: 0 };
    entry.targets += 1;
    entry.sourceChars += String(target.source || "").length;
    result[key] = entry;
    return result;
}, {});
const packetTotals = planning.packets.reduce(
    (totals, packet) => {
        for (const key of [
            "estimatedInputTokens",
            "reservedInputTokens",
            "estimatedOutputTokens",
            "reservedOutputTokens",
            "reasoningReservationTokens",
            "reservedTotalTokens",
        ]) {
            totals[key] += Number(packet[key] || 0);
        }
        return totals;
    },
    {
        estimatedInputTokens: 0,
        reservedInputTokens: 0,
        estimatedOutputTokens: 0,
        reservedOutputTokens: 0,
        reasoningReservationTokens: 0,
        reservedTotalTokens: 0,
    }
);
const result = {
    schemaVersion: "ai-page-live-structural-2",
    generatedAt: new Date().toISOString(),
    url,
    usageSource: "client-estimated",
    warning:
        "No LLM was called. Token and packet values are planner estimates, not provider usage.",
    config: {
        policy,
        protocol,
        maxInputTokens,
        maxOutputTokens,
        hardBudget: policy === "stable" ? "unlimited" : hardBudget,
        eagerInputBudget: policy === "stable" ? "whole-document" : eagerInputBudget,
        maxTargetsPerPacket: policy === "stable" ? 256 : "provider-limited",
    },
    rawHtmlChars: html.length,
    rootTag: root?.tagName?.toLowerCase() || "document",
    collector: collected.stats,
    targets: collected.targets.length,
    uniqueSourceRoleTargets: uniqueTargets.length,
    deduplicatedTargets: collected.targets.length - uniqueTargets.length,
    uniqueSourceChars: uniqueTargets.reduce(
        (sum, target) => sum + String(target.source || "").length,
        0
    ),
    uniqueTargetBreakdown: targetBreakdown,
    semanticUnits: units.length,
    semanticUnitsByKind: byKind,
    initiallyAdmittedUnits: admission.keep.length,
    initiallyAdmittedTargets: sumTargets(admission.keep),
    viewportDeferredUnits: admission.deferred.length,
    viewportDeferredTargets: sumTargets(admission.deferred),
    plannedPackets: planning.packets.length,
    plannedTargets: planning.packets.reduce((sum, packet) => sum + packet.targetCount, 0),
    budgetDeferredUnits: planning.deferredUnits.length,
    budgetDeferredTargets: sumTargets(planning.deferredUnits),
    rejectedUnits: planning.rejectedUnits.length,
    reservedTotalTokens: planning.reservedTotalTokens,
    packetTokenEstimates: packetTotals,
    elapsedMs: Number(elapsedMs.toFixed(2)),
};

console.log(JSON.stringify(result, null, 2));
