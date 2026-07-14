#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const babel = require("@babel/core");
const { JSDOM } = require("jsdom");
const typescript = require("typescript");

const REPO_ROOT = path.resolve(__dirname, "../..");
const EDGE_SOURCE_ROOT = path.join(REPO_ROOT, "packages/EdgeTranslate/src");
const SOURCE_ROOT = path.join(EDGE_SOURCE_ROOT, "content/ai_page_translation");
const TRANSLATOR_SOURCE_ROOT = path.join(REPO_ROOT, "packages/translators/src");
const CONFIG_PATH = path.join(__dirname, "config.json");
const FIXTURES_PATH = path.join(__dirname, "fixtures/gate-a-fixtures.json");
const REPLIES_PATH = path.join(__dirname, "references/offline-replies.json");
const PLACEHOLDER = /<\/?g\d+>|<v\d+\/>/;
const TRANSLATABLE_VALUE_ATTRIBUTES = new Set([
    "alt",
    "placeholder",
    "aria-label",
    "aria-description",
    "aria-placeholder",
    "aria-roledescription",
    "aria-valuetext",
    "aria-rowindextext",
    "aria-colindextext",
    "aria-braillelabel",
    "aria-brailleroledescription",
    "value",
    "label",
    "abbr",
]);

function readJson(filename) {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function installProductionSourceHook() {
    const original = Module._extensions[".js"];
    const originalTs = Module._extensions[".ts"];
    const originalResolveFilename = Module._resolveFilename;
    Module._extensions[".js"] = function compileVnext(module, filename) {
        if (!filename.startsWith(`${EDGE_SOURCE_ROOT}${path.sep}`)) {
            return original(module, filename);
        }
        const source = fs.readFileSync(filename, "utf8");
        const transformed = babel.transformSync(source, {
            filename,
            babelrc: false,
            configFile: false,
            sourceMaps: "inline",
            presets: [
                [
                    require.resolve("@babel/preset-env"),
                    { targets: { node: "current" }, modules: "commonjs" },
                ],
            ],
        });
        module._compile(transformed.code, filename);
    };
    Module._extensions[".ts"] = function compileTranslatorSource(module, filename) {
        if (!filename.startsWith(`${TRANSLATOR_SOURCE_ROOT}${path.sep}`)) {
            if (originalTs) return originalTs(module, filename);
            throw new Error(`No TypeScript loader for ${filename}`);
        }
        const source = fs.readFileSync(filename, "utf8");
        const transformed = typescript.transpileModule(source, {
            fileName: filename,
            compilerOptions: {
                module: typescript.ModuleKind.CommonJS,
                target: typescript.ScriptTarget.ES2020,
                esModuleInterop: true,
                moduleResolution: typescript.ModuleResolutionKind.NodeJs,
            },
        });
        module._compile(transformed.outputText, filename);
    };
    Module._resolveFilename = function resolveEdgeAliases(request, parent, isMain, options) {
        // Gate A executes production source directly and must also work in a clean checkout
        // before the translators workspace has produced dist/. Route the workspace package
        // import to its TypeScript entrypoint; the source hook above transpiles it in-memory.
        if (request === "@edge_translate/translators") {
            return path.join(TRANSLATOR_SOURCE_ROOT, "index.ts");
        }
        if (typeof request === "string" && request.startsWith("common/")) {
            const relativeRequest = request.endsWith(".js") ? request : `${request}.js`;
            return originalResolveFilename.call(
                this,
                path.join(EDGE_SOURCE_ROOT, relativeRequest),
                parent,
                isMain,
                options
            );
        }
        return originalResolveFilename.call(this, request, parent, isMain, options);
    };
    return () => {
        Module._extensions[".js"] = original;
        if (originalTs) Module._extensions[".ts"] = originalTs;
        else delete Module._extensions[".ts"];
        Module._resolveFilename = originalResolveFilename;
    };
}

function parseArgs(argv) {
    const options = { output: null, compact: false };
    for (const argument of argv) {
        if (argument === "--compact") options.compact = true;
        else if (argument.startsWith("--output=")) {
            const requested = argument.slice("--output=".length);
            if (!requested) throw new Error("--output requires a path");
            options.output = path.resolve(process.cwd(), requested);
        } else if (argument === "--help" || argument === "-h") {
            process.stdout.write(
                "Usage: node tools/vnext-gates/run-gate-a.cjs [--compact] [--output=FILE]\n"
            );
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return options;
}

function generatedFixtureHtml(generate) {
    if (generate?.type !== "largeSemanticBlocks") {
        throw new Error(`Unknown generated fixture type: ${generate?.type || "none"}`);
    }
    const blocks = Number(generate.blocks);
    const viewportBlocks = Number(generate.viewportBlocks);
    const paragraphs = [];
    for (let index = 1; index <= blocks; index += 1) {
        const ordinal = String(index).padStart(4, "0");
        const below = index > viewportBlocks ? " data-below" : "";
        paragraphs.push(
            `<p data-large-index="${index}"${below}><span>大規模</span><span>検証</span><span>ブロック</span><span>番号${ordinal}</span><span>案内</span></p>`
        );
    }
    return `<main id="main">${paragraphs.join(
        ""
    )}</main><aside id="outside">DO_NOT_TRANSLATE</aside>`;
}

function fixtureHtml(fixture) {
    return fixture.generate ? generatedFixtureHtml(fixture.generate) : fixture.html;
}

function installDom(html) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
        url: "https://fixture.example.test/page",
        pretendToBeVisual: true,
    });
    const names = [
        "window",
        "document",
        "Node",
        "NodeFilter",
        "Element",
        "HTMLElement",
        "Text",
        "MutationObserver",
        "DOMParser",
        "CustomEvent",
        "Event",
        "navigator",
        "location",
        "getComputedStyle",
    ];
    const previous = new Map();
    for (const name of names) {
        previous.set(name, Object.getOwnPropertyDescriptor(global, name) || null);
        Object.defineProperty(global, name, {
            value: dom.window[name],
            writable: true,
            configurable: true,
            enumerable: true,
        });
    }
    previous.set(
        "IntersectionObserver",
        Object.getOwnPropertyDescriptor(global, "IntersectionObserver") || null
    );
    Object.defineProperty(global, "IntersectionObserver", {
        value: undefined,
        writable: true,
        configurable: true,
    });
    dom.window.requestIdleCallback = (callback) =>
        setTimeout(
            () => callback({ didTimeout: false, timeRemaining: () => Number.POSITIVE_INFINITY }),
            0
        );
    dom.window.cancelIdleCallback = (handle) => clearTimeout(handle);
    return {
        dom,
        restore() {
            dom.window.close();
            for (const [name, descriptor] of previous) {
                if (descriptor === null) delete global[name];
                else Object.defineProperty(global, name, descriptor);
            }
        },
    };
}

function structureSnapshot(root) {
    const visit = (node) => {
        if (node.nodeType === 3) return { type: "text" };
        if (node.nodeType !== 1) return { type: `node-${node.nodeType}` };
        const attributes = Array.from(node.attributes || [])
            .map(({ name, value }) => [
                name,
                TRANSLATABLE_VALUE_ATTRIBUTES.has(name) ? "<translated-value>" : value,
            ])
            .sort(([a], [b]) => a.localeCompare(b));
        return {
            type: String(node.tagName || "").toLowerCase(),
            attributes,
            children: Array.from(node.childNodes || []).map(visit),
        };
    };
    return JSON.stringify(visit(root));
}

function countTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode()) count += 1;
    return count;
}

function observedValue(assertion) {
    const element = document.querySelector(assertion.selector);
    if (!element) return { found: false, value: null };
    if (assertion.attribute) {
        return { found: true, value: element.getAttribute(assertion.attribute) };
    }
    return { found: true, value: element[assertion.property || "textContent"] };
}

function expectationMatches(assertion) {
    const observed = observedValue(assertion);
    return observed.found && observed.value === assertion.equals;
}

async function waitFor(predicate, { timeoutMs = 6000, intervalMs = 10 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return Boolean(predicate());
}

function translateLargeSource(source) {
    if (!source.includes("大規模") || !source.includes("番号")) return null;
    return source
        .replaceAll("大規模", "대규모")
        .replaceAll("検証", "검증")
        .replaceAll("ブロック", "블록")
        .replaceAll("番号", "번호")
        .replaceAll("案内", "안내");
}

function makeFixtureChannel({ fixture, references, placeholderInventoryMatches, config }) {
    const calls = {
        translate: [],
        countTokens: [],
        cancel: [],
        emitted: [],
        unknownSources: [],
        placeholderItems: 0,
        intactPlaceholderItems: 0,
        movedPlaceholderItems: 0,
        expectedReceiptTokens: 0,
        expectedReceiptRequests: 0,
        duplicateReceiptsPresented: 0,
    };

    const translationFor = (source) => {
        if (Object.prototype.hasOwnProperty.call(references.translations, source)) {
            return references.translations[source];
        }
        if (Object.prototype.hasOwnProperty.call(references.semanticFailures, source)) {
            return references.semanticFailures[source];
        }
        const generated = translateLargeSource(source);
        if (generated !== null) return generated;
        calls.unknownSources.push(source);
        return "매핑되지 않은 오프라인 응답";
    };

    const channel = {
        async request(service, payload) {
            if (service === "get_page_translation_capabilities") {
                return {
                    provider: "googleAiStudio",
                    apiKeyHash: "offline-fixture-key",
                    profileRevision: "offline-v1",
                    maxOutputTokens: 8192,
                };
            }
            if (service === "persistent_segment_get") return [];
            if (service === "count_page_translation_tokens") {
                calls.countTokens.push(payload);
                const sourceChars = (payload.units || []).reduce(
                    (sum, unit) => sum + String(unit.text || "").length,
                    0
                );
                return {
                    tokens:
                        config.estimator.fixedInTokens +
                        Math.ceil(sourceChars / config.estimator.otherCharsPerToken),
                    source: "offline-exact-counter",
                };
            }
            if (service === "cancel_page_translation") {
                calls.cancel.push(payload);
                return { aborted: 0 };
            }
            if (service !== "translate_page_packet") return null;

            const callNumber = calls.translate.length + 1;
            const units = (payload.units || []).map((unit) => {
                const translatedText = translationFor(String(unit.text || ""));
                if (PLACEHOLDER.test(unit.text)) {
                    calls.placeholderItems += 1;
                    if (placeholderInventoryMatches(unit.text, translatedText)) {
                        calls.intactPlaceholderItems += 1;
                    }
                    const sourcePosition = String(unit.text).indexOf("<g1>");
                    const translatedPosition = translatedText.indexOf("<g1>");
                    if (sourcePosition !== translatedPosition) calls.movedPlaceholderItems += 1;
                }
                return { id: unit.id, status: "translated", translatedText };
            });
            const record = {
                packetId: payload.packetId,
                hint: payload.hint || null,
                units: payload.units || [],
                results: units,
            };
            calls.translate.push(record);

            let usageReceipts = [];
            if (fixture.usageMode !== "missing") {
                const sourceChars = record.units.reduce(
                    (sum, unit) => sum + String(unit.text || "").length,
                    0
                );
                const translatedChars = units.reduce(
                    (sum, unit) => sum + String(unit.translatedText || "").length,
                    0
                );
                const input =
                    config.estimator.fixedInTokens +
                    record.units.length * config.estimator.perItemInTokens +
                    Math.ceil(sourceChars / config.estimator.otherCharsPerToken);
                const output =
                    record.units.length * config.estimator.perItemOutTokens +
                    Math.ceil(translatedChars / config.estimator.otherCharsPerToken);
                const billingEventId = `${fixture.id}:receipt:${callNumber}`;
                const receipt = {
                    billingEventId,
                    inputTokens: { value: input, source: "provider-reported" },
                    outputTokens: { value: output, source: "provider-reported" },
                    reasoningTokens: { value: 0, source: "provider-reported" },
                    reasoningRelation: "included-in-output",
                    costAttribution: "offline-fixture",
                };
                // Duplicate each receipt deliberately: the production ledger must charge it once.
                usageReceipts = [receipt, { ...receipt }];
                calls.expectedReceiptTokens += input + output;
                calls.expectedReceiptRequests += 1;
                calls.duplicateReceiptsPresented += 1;
            }
            return {
                ok: true,
                units,
                usageReceipts,
                costAttribution: "offline-fixture",
                resolvedProvider: "offline-fixture",
            };
        },
        emit(service, payload) {
            calls.emitted.push({ service, payload });
        },
    };
    return { channel, calls };
}

function checkCollectorRect(element) {
    const below = element.hasAttribute?.("data-below") || element.closest?.("[data-below]");
    return below
        ? { top: 5000, bottom: 5020, left: 0, right: 100, width: 100, height: 20 }
        : { top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20 };
}

function addCheck(checks, id, pass, details = null) {
    checks.push({ id, pass: Boolean(pass), ...(details === null ? {} : { details }) });
}

async function applyMutation(mutation) {
    const element = document.querySelector(mutation.selector);
    if (!element) throw new Error(`Mutation selector not found: ${mutation.selector}`);
    if (mutation.type === "appendHtml") {
        element.insertAdjacentHTML("beforeend", mutation.html);
    } else if (mutation.type === "setAttribute") {
        element.setAttribute(mutation.attribute, mutation.value);
    } else {
        throw new Error(`Unknown mutation type: ${mutation.type}`);
    }
}

async function runFixture({
    fixture,
    references,
    config,
    production,
    placeholderInventoryMatches,
    checks,
}) {
    const installed = installDom(fixtureHtml(fixture));
    let controller = null;
    try {
        const root = document.getElementById("main");
        if (!root) throw new Error(`${fixture.id}: #main is missing`);
        const beforeStructure = structureSnapshot(root);
        const domTextNodes = countTextNodes(root);
        const { channel, calls } = makeFixtureChannel({
            fixture,
            references,
            placeholderInventoryMatches,
            config,
        });
        controller = production.createAiPageTranslationSession({
            engine: "googleAiStudio",
            channel,
            root,
            sourceLanguage: fixture.sourceLanguage,
            targetLanguage: fixture.targetLanguage,
            providerProfileId: `offline:${fixture.id}`,
            sessionId: `offline:${fixture.id}`,
            title: `Offline fixture ${fixture.id}`,
            domain: "fixture.example.test",
            collector: {
                viewportHeight: 800,
                viewportBudgetMs: 1000,
                idleSliceMs: 1000,
                measureRects: (elements) => elements.map(checkCollectorRect),
                scheduleIdle: (callback) => setTimeout(() => callback(null), 0),
            },
            deps: {
                createPriorityQueue: production.createPriorityQueue,
                createScheduler: production.createScheduler,
            },
        });
        await controller.start();
        const initialSettled = await waitFor(() => {
            const phase = controller.getStatusSnapshot().phase;
            return phase === "complete" || phase === "error" || phase === "incomplete";
        });
        addCheck(checks, `${fixture.id}:initial-settled`, initialSettled, {
            phase: controller.getStatusSnapshot().phase,
        });

        const initialExpectations = (fixture.expect || [])
            .filter((expectation) => expectation.stage === "initial")
            .map((expectation) => {
                const observed = observedValue(expectation);
                return {
                    selector: expectation.selector,
                    field: expectation.attribute || expectation.property || "textContent",
                    expected: expectation.equals,
                    observed: observed.value,
                    pass: observed.found && observed.value === expectation.equals,
                };
            });
        addCheck(
            checks,
            `${fixture.id}:initial-expected-values`,
            initialExpectations.every((item) => item.pass),
            { mismatches: initialExpectations.filter((item) => !item.pass) }
        );

        const mutationStructures = [];
        let expectedStructure = beforeStructure;
        for (let index = 0; index < (fixture.mutations || []).length; index += 1) {
            const mutation = fixture.mutations[index];
            const requestsBefore = calls.translate.length;
            await applyMutation(mutation);
            const structureAfterSiteMutation = structureSnapshot(root);
            const applied = await waitFor(
                () =>
                    calls.translate.length > requestsBefore &&
                    expectationMatches(mutation.expect) &&
                    controller.getStatusSnapshot().phase === "complete",
                { timeoutMs: 7000 }
            );
            addCheck(checks, `${fixture.id}:mutation-${index + 1}`, applied, {
                type: mutation.type,
                observed: observedValue(mutation.expect),
                expected: mutation.expect.equals,
            });
            mutationStructures.push({
                type: mutation.type,
                invariant: structureSnapshot(root) === structureAfterSiteMutation,
            });
            expectedStructure = structureAfterSiteMutation;
        }

        const snapshot = controller.getStatusSnapshot();
        const expectations = (fixture.expect || [])
            .filter((expectation) => expectation.stage !== "initial")
            .map((expectation) => {
                const observed = observedValue(expectation);
                return {
                    selector: expectation.selector,
                    field: expectation.attribute || expectation.property || "textContent",
                    expected: expectation.equals,
                    observed: observed.value,
                    pass: observed.found && observed.value === expectation.equals,
                };
            });
        const alternativeResults = (fixture.expectAlternatives || []).map((alternative) => {
            const assertions = (alternative.assertions || []).map((expectation) => {
                const observed = observedValue(expectation);
                return {
                    selector: expectation.selector,
                    field: expectation.attribute || expectation.property || "textContent",
                    expected: expectation.equals,
                    observed: observed.value,
                    pass: observed.found && observed.value === expectation.equals,
                };
            });
            return {
                label: alternative.label,
                pass: assertions.length > 0 && assertions.every((item) => item.pass),
                assertions,
            };
        });
        const alternativeMatched =
            alternativeResults.length === 0 || alternativeResults.some((item) => item.pass);
        const wrongTargetApply =
            initialExpectations.filter((item) => !item.pass).length +
            expectations.filter((item) => !item.pass).length +
            (alternativeMatched ? 0 : 1);
        const domInvariant =
            structureSnapshot(root) === expectedStructure &&
            mutationStructures.every((item) => item.invariant);
        const expected = fixture.expected || {};

        addCheck(checks, `${fixture.id}:phase`, snapshot.phase === expected.phase, {
            expected: expected.phase,
            actual: snapshot.phase,
        });
        addCheck(
            checks,
            `${fixture.id}:failed-strings`,
            snapshot.failedStrings === expected.failedStrings,
            { expected: expected.failedStrings, actual: snapshot.failedStrings }
        );
        addCheck(
            checks,
            `${fixture.id}:incomplete-strings`,
            snapshot.incompleteStrings === expected.incompleteStrings,
            { expected: expected.incompleteStrings, actual: snapshot.incompleteStrings }
        );
        addCheck(
            checks,
            `${fixture.id}:coverage-accounted`,
            snapshot.translatedStrings + snapshot.failedStrings === snapshot.totalStrings,
            {
                total: snapshot.totalStrings,
                translated: snapshot.translatedStrings,
                failed: snapshot.failedStrings,
            }
        );
        addCheck(checks, `${fixture.id}:dom-invariant`, domInvariant);
        addCheck(checks, `${fixture.id}:expected-values`, wrongTargetApply === 0, {
            mismatches: expectations.filter((item) => !item.pass),
            alternatives: alternativeResults,
        });
        addCheck(checks, `${fixture.id}:known-offline-replies`, calls.unknownSources.length === 0, {
            unknownSources: calls.unknownSources,
        });
        addCheck(
            checks,
            `${fixture.id}:request-packet-reconciliation`,
            snapshot.packets.dispatched === calls.translate.length,
            { dispatched: snapshot.packets.dispatched, httpRequests: calls.translate.length }
        );
        const maxItemsPerRequest = Math.max(0, ...calls.translate.map((call) => call.units.length));
        addCheck(
            checks,
            `${fixture.id}:packet-item-cap`,
            maxItemsPerRequest <= config.packetSizing.drain.maxBlocks &&
                maxItemsPerRequest <= config.packetSizing.deliveryCeilingItems.googleAiStudio,
            { maxItemsPerRequest }
        );
        addCheck(
            checks,
            `${fixture.id}:attempt-amplification-bound`,
            calls.translate.length <= Math.max(6, snapshot.packets.enqueued * 3),
            { httpRequests: calls.translate.length, enqueuedPackets: snapshot.packets.enqueued }
        );
        if (fixture.expectedRecoveryHint) {
            addCheck(
                checks,
                `${fixture.id}:recovery-hint-emitted`,
                calls.translate.slice(1).some((call) => call.hint === fixture.expectedRecoveryHint),
                {
                    expected: fixture.expectedRecoveryHint,
                    observed: calls.translate.map((call) => call.hint),
                }
            );
        }
        const flattened =
            Number(snapshot.telemetry?.placeholder_flattened || 0) +
            Number(snapshot.telemetry?.placeholder_boundary_flattened || 0);
        const allowedFlattenMax = Number(fixture.allowedFlattenMax || 0);
        addCheck(
            checks,
            `${fixture.id}:bounded-placeholder-flatten`,
            flattened <= allowedFlattenMax,
            { actual: flattened, allowed: allowedFlattenMax }
        );

        if (fixture.usageMode === "missing") {
            addCheck(
                checks,
                `${fixture.id}:missing-usage-estimated`,
                snapshot.tokens.estimated >= Number(expected.estimatedTokensMin || 1),
                { estimatedTokens: snapshot.tokens.estimated }
            );
        } else {
            addCheck(
                checks,
                `${fixture.id}:receipt-token-reconciliation`,
                snapshot.tokens.settled === calls.expectedReceiptTokens,
                { expected: calls.expectedReceiptTokens, actual: snapshot.tokens.settled }
            );
            addCheck(
                checks,
                `${fixture.id}:usage-deduplicated`,
                snapshot.requestCount === calls.expectedReceiptRequests,
                {
                    expectedUnique: calls.expectedReceiptRequests,
                    actual: snapshot.requestCount,
                    duplicateReceiptsPresented: calls.duplicateReceiptsPresented,
                }
            );
        }

        if (Number.isFinite(expected.totalStrings)) {
            addCheck(
                checks,
                `${fixture.id}:semantic-target-count`,
                snapshot.totalStrings === expected.totalStrings,
                { expected: expected.totalStrings, actual: snapshot.totalStrings }
            );
        }
        if (Number.isFinite(expected.domTextNodes)) {
            addCheck(
                checks,
                `${fixture.id}:dom-text-node-count`,
                domTextNodes === expected.domTextNodes,
                {
                    expected: expected.domTextNodes,
                    actual: domTextNodes,
                }
            );
            addCheck(
                checks,
                `${fixture.id}:semantic-block-compression`,
                snapshot.totalStrings < domTextNodes &&
                    snapshot.packets.enqueued < snapshot.totalStrings,
                {
                    domTextNodes,
                    semanticTargets: snapshot.totalStrings,
                    providerPackets: snapshot.packets.enqueued,
                }
            );
        }

        const result = {
            id: fixture.id,
            families: fixture.families,
            phase: snapshot.phase,
            strings: {
                total: snapshot.totalStrings,
                translated: snapshot.translatedStrings,
                failed: snapshot.failedStrings,
                incomplete: snapshot.incompleteStrings,
            },
            packing: {
                domTextNodes,
                semanticTargets: snapshot.totalStrings,
                semanticTargetsPerDomTextNode:
                    domTextNodes > 0 ? snapshot.totalStrings / domTextNodes : null,
                enqueuedPackets: snapshot.packets.enqueued,
                dispatchedPackets: snapshot.packets.dispatched,
                httpRequests: calls.translate.length,
                maxItemsPerRequest,
                semanticTargetsPerPacket:
                    snapshot.packets.enqueued > 0
                        ? snapshot.totalStrings / snapshot.packets.enqueued
                        : null,
            },
            placeholders: {
                checked: calls.placeholderItems,
                intact: calls.intactPlaceholderItems,
                reordered: calls.movedPlaceholderItems,
                fidelity:
                    calls.placeholderItems > 0
                        ? calls.intactPlaceholderItems / calls.placeholderItems
                        : 1,
            },
            usage: {
                settledTokens: snapshot.tokens.settled,
                estimatedTokens: snapshot.tokens.estimated,
                billedRequests: snapshot.requestCount,
                expectedUniqueReceiptTokens: calls.expectedReceiptTokens,
                expectedUniqueReceipts: calls.expectedReceiptRequests,
                expectedBilledRequests: calls.translate.length,
                duplicateReceiptsPresented: calls.duplicateReceiptsPresented,
            },
            domInvariant,
            wrongTargetApply,
            matchedAlternative:
                alternativeResults.find((alternative) => alternative.pass)?.label || null,
            allowedFlattenMax,
            telemetry: snapshot.telemetry,
        };
        controller.stop("offline-gate-complete");
        return result;
    } finally {
        if (controller) controller.stop("offline-gate-cleanup");
        installed.restore();
    }
}

function manualEstIn(text, estimatorConfig) {
    const value = String(text || "");
    const cjkChars = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
    return Math.ceil(
        cjkChars * estimatorConfig.cjkTokensPerChar +
            (value.length - cjkChars) / estimatorConfig.otherCharsPerToken
    );
}

function providerPromptText(provider, body) {
    if (provider === "openai-responses") {
        return `${body.instructions || ""}\n${body.input || ""}`;
    }
    if (provider === "openai-chat") {
        return (body.messages || []).map((message) => String(message.content || "")).join("\n");
    }
    if (provider === "gemini-generate-content") {
        const system = (body.systemInstruction?.parts || [])
            .map((part) => String(part.text || ""))
            .join("\n");
        const user = (body.contents || [])
            .flatMap((content) => content.parts || [])
            .map((part) => String(part.text || ""))
            .join("\n");
        return `${system}\n${user}`;
    }
    return JSON.stringify(body);
}

function countSubstring(value, needle) {
    if (!needle) return 0;
    return String(value).toLowerCase().split(String(needle).toLowerCase()).length - 1;
}

/**
 * Proves the recovery signal crosses both trust boundaries: content envelope -> background
 * TranslationBatchRequest -> actual provider prompt body. A changed requestId is deliberately
 * held constant and cannot satisfy this gate.
 */
function runRecoveryDirectiveAudit({ checks }) {
    const { AiPageTranslationTransport } = require(path.join(
        EDGE_SOURCE_ROOT,
        "background/library/ai_page_translation_transport.js"
    ));
    const backgroundTransport = new AiPageTranslationTransport({
        resolveProfile: async () => null,
        adapters: new Map(),
    });
    const hints = [
        { value: "reinforced-schema", markers: ["schema", "every-id"] },
        { value: "reinforced-inventory", markers: ["inventory", "placeholder"] },
        { value: "reinforced-order", markers: ["order", "source-order"] },
        { value: "reinforced-atomic", markers: ["atomic", "protected-values"] },
        { value: "reinforced-semantic", markers: ["semantic", "natural-target"] },
    ];
    const backgroundResults = hints.map(({ value }) => {
        const request = backgroundTransport.toAdapterRequest({
            requestId: "recovery-probe:a1",
            sessionId: "recovery-probe",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            maxOutputTokens: 512,
            hint: value,
            units: [{ id: "unit-1", text: "回復指示の検証文です。", role: "p" }],
        });
        return { hint: value, observed: request.hint || null, pass: request.hint === value };
    });
    addCheck(
        checks,
        "recovery-directive:background-boundary",
        backgroundResults.every((result) => result.pass),
        { cases: backgroundResults }
    );

    const dummyFetch = async () => {
        throw new Error("Gate A body construction must not execute fetch");
    };
    const { OpenAIResponsesAdapter } = require(path.join(
        TRANSLATOR_SOURCE_ROOT,
        "page_translation_v2/openai_responses.ts"
    ));
    const { OpenAIChatCompatibleAdapter } = require(path.join(
        TRANSLATOR_SOURCE_ROOT,
        "page_translation_v2/openai_chat.ts"
    ));
    const { GeminiGenerateContentAdapter } = require(path.join(
        TRANSLATOR_SOURCE_ROOT,
        "page_translation_v2/gemini.ts"
    ));
    const providers = [
        {
            name: "openai-responses",
            adapter: new OpenAIResponsesAdapter(dummyFetch),
            profile: {
                id: "offline",
                revision: "1",
                protocol: "openai-responses",
                modelId: "gpt-5-mini",
                apiKey: "offline",
                reasoningControl: "none",
            },
            build(adapter, profile, request) {
                return adapter.buildBody(profile, request).body;
            },
        },
        {
            name: "openai-chat",
            adapter: new OpenAIChatCompatibleAdapter(dummyFetch),
            profile: {
                id: "offline",
                revision: "1",
                protocol: "openai-chat",
                modelId: "offline-chat",
                apiKey: "offline",
                structuredOutput: "json-schema",
                reasoningControl: "none",
            },
            build(adapter, profile, request) {
                return adapter.buildBody(profile, request).body;
            },
        },
        {
            name: "gemini-generate-content",
            adapter: new GeminiGenerateContentAdapter(dummyFetch),
            profile: {
                id: "offline",
                revision: "1",
                protocol: "gemini-generate-content",
                modelId: "gemini-2.5-flash",
                apiKey: "offline",
                reasoningControl: "none",
            },
            build(adapter, profile, request) {
                return adapter.buildGenerateContentRequest(profile, request).body;
            },
        },
    ];
    const baseRequest = {
        requestId: "recovery-probe:a1",
        sessionId: "recovery-probe",
        wireProtocol: "pt3",
        sourceLanguage: "ja",
        targetLanguage: "ko",
        maxOutputTokens: 512,
        items: [{ id: "unit-1", text: "回復指示の検証文です。", role: "p" }],
    };
    const providerResults = [];
    for (const provider of providers) {
        const baselineBody = provider.build(provider.adapter, provider.profile, baseRequest);
        const baselinePrompt = providerPromptText(provider.name, baselineBody);
        const cases = hints.map(({ value, markers }) => {
            const recoveryBody = provider.build(provider.adapter, provider.profile, {
                ...baseRequest,
                hint: value,
            });
            const recoveryPrompt = providerPromptText(provider.name, recoveryBody);
            const promptChanged = recoveryPrompt !== baselinePrompt;
            const directiveAdded = markers.some(
                (marker) =>
                    countSubstring(recoveryPrompt, marker) > countSubstring(baselinePrompt, marker)
            );
            return {
                hint: value,
                promptChanged,
                directiveAdded,
                pass: promptChanged && directiveAdded,
                promptBytes: Buffer.byteLength(recoveryPrompt, "utf8"),
            };
        });
        const distinctRecoveryPrompts = new Set(
            hints.map(({ value }) =>
                providerPromptText(
                    provider.name,
                    provider.build(provider.adapter, provider.profile, {
                        ...baseRequest,
                        hint: value,
                    })
                )
            )
        ).size;
        const pass = cases.every((item) => item.pass) && distinctRecoveryPrompts === hints.length;
        addCheck(checks, `recovery-directive:${provider.name}-provider-body`, pass, {
            cases,
            distinctRecoveryPrompts,
        });
        providerResults.push({ provider: provider.name, pass, cases, distinctRecoveryPrompts });
    }
    return {
        backgroundBoundary: backgroundResults,
        providers: providerResults,
    };
}

function runTokenPinAudit({ production, config, checks }) {
    const items = Array.from({ length: 96 }, (_, index) => ({
        id: `pin-${index + 1}`,
        text: `複雑なページの意味単位を安定してまとめる検証文${String(index + 1).padStart(
            3,
            "0"
        )}。`.repeat(2),
        role: "p",
        order: index,
    }));
    const estimator = production.createEstimator({
        sl: "ja",
        tl: "ko",
        provider: "googleAiStudio",
    });
    const result = production.buildPackets({
        items,
        tier: "drain",
        provider: "googleAiStudio",
        estimator,
        capabilities: { maxOutputTokens: { value: 8192, source: "offline-pin" } },
        ctxTokens: 0,
    });
    let maxDelta = 0;
    for (const packet of result.packets) {
        const sourceTokens = packet.items.reduce(
            (sum, item) => sum + manualEstIn(item.text, config.estimator),
            0
        );
        const expectedIn = Math.ceil(
            sourceTokens +
                packet.itemCount * config.estimator.perItemInTokens +
                config.estimator.fixedInTokens
        );
        const expectedOut = Math.ceil(
            sourceTokens * config.estimator.outRatioSeed +
                packet.itemCount * config.estimator.perItemOutTokens
        );
        const inDelta = expectedIn ? Math.abs(packet.estIn - expectedIn) / expectedIn : 0;
        const outDelta = expectedOut ? Math.abs(packet.estOut - expectedOut) / expectedOut : 0;
        maxDelta = Math.max(maxDelta, inDelta, outDelta);
    }
    const tolerance = config.gateA_offlineReplay.packetTokenPinTolerance;
    addCheck(checks, "token-estimator:pinned-formula", maxDelta <= tolerance, {
        maxRelativeDelta: maxDelta,
        tolerance,
    });
    addCheck(
        checks,
        "packet-builder:drain-caps",
        result.packets.every(
            (packet) =>
                packet.itemCount <= config.packetSizing.drain.maxBlocks &&
                packet.srcChars <= config.packetSizing.drain.maxSrcChars &&
                packet.estOut <= config.packetSizing.drain.maxEstOutTokens
        ),
        { packetCount: result.packets.length }
    );
    return {
        sourceItems: items.length,
        packets: result.packets.length,
        maxItems: Math.max(...result.packets.map((packet) => packet.itemCount)),
        maxRelativeDelta: maxDelta,
        tolerance,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const config = readJson(CONFIG_PATH);
    const fixtureCorpus = readJson(FIXTURES_PATH);
    const references = readJson(REPLIES_PATH);
    const restoreHook = installProductionSourceHook();
    let report;
    try {
        const production = {
            ...require(path.join(SOURCE_ROOT, "index.js")),
            ...require(path.join(SOURCE_ROOT, "runtime/scheduler.js")),
            ...require(path.join(SOURCE_ROOT, "runtime/priority_queue.js")),
            ...require(path.join(SOURCE_ROOT, "ir/estimator.js")),
            ...require(path.join(SOURCE_ROOT, "ir/packet_builder.js")),
        };
        const { placeholderInventoryMatches } = require("@edge_translate/translators");
        const checks = [];
        const fixtures = [];
        for (const fixture of fixtureCorpus.cases) {
            try {
                fixtures.push(
                    await runFixture({
                        fixture,
                        references,
                        config,
                        production,
                        placeholderInventoryMatches,
                        checks,
                    })
                );
            } catch (error) {
                addCheck(checks, `${fixture.id}:harness`, false, {
                    message: error?.message || String(error),
                });
                fixtures.push({
                    id: fixture.id,
                    families: fixture.families,
                    harnessError: error?.message || String(error),
                });
            }
        }

        const recoveryDirectives = runRecoveryDirectiveAudit({ checks });
        const tokenPin = runTokenPinAudit({ production, config, checks });
        const families = Array.from(
            new Set(fixtures.flatMap((fixture) => fixture.families || []))
        ).sort();
        const aggregate = fixtures.reduce(
            (totals, fixture) => {
                totals.wrongTargetApply += Number(fixture.wrongTargetApply) || 0;
                totals.placeholderChecked += Number(fixture.placeholders?.checked) || 0;
                totals.placeholderIntact += Number(fixture.placeholders?.intact) || 0;
                totals.httpRequests += Number(fixture.packing?.httpRequests) || 0;
                totals.providerPackets += Number(fixture.packing?.enqueuedPackets) || 0;
                totals.domTextNodes += Number(fixture.packing?.domTextNodes) || 0;
                totals.semanticTargets += Number(fixture.packing?.semanticTargets) || 0;
                totals.usageDoubleCount += Math.max(
                    0,
                    (Number(fixture.usage?.billedRequests) || 0) -
                        (Number(fixture.usage?.expectedBilledRequests) || 0)
                );
                totals.flattened +=
                    (Number(fixture.telemetry?.placeholder_flattened) || 0) +
                    (Number(fixture.telemetry?.placeholder_boundary_flattened) || 0);
                totals.allowedFlatten += Number(fixture.allowedFlattenMax) || 0;
                return totals;
            },
            {
                wrongTargetApply: 0,
                placeholderChecked: 0,
                placeholderIntact: 0,
                httpRequests: 0,
                providerPackets: 0,
                domTextNodes: 0,
                semanticTargets: 0,
                usageDoubleCount: 0,
                flattened: 0,
                allowedFlatten: 0,
            }
        );
        const fidelity =
            aggregate.placeholderChecked > 0
                ? aggregate.placeholderIntact / aggregate.placeholderChecked
                : 1;
        addCheck(
            checks,
            "gate-a:fixture-family-minimum",
            families.length >= config.gateA_offlineReplay.minFixtureFamilies,
            { actual: families.length, minimum: config.gateA_offlineReplay.minFixtureFamilies }
        );
        addCheck(
            checks,
            "gate-a:wrong-target-apply",
            aggregate.wrongTargetApply === config.gateA_offlineReplay.wrongTargetApply,
            {
                actual: aggregate.wrongTargetApply,
                expected: config.gateA_offlineReplay.wrongTargetApply,
            }
        );
        addCheck(
            checks,
            "gate-a:placeholder-fidelity-no-flatten",
            fidelity >= config.gateA_offlineReplay.minPlaceholderFidelityNoFlatten &&
                aggregate.flattened <= aggregate.allowedFlatten,
            {
                actual: fidelity,
                minimum: config.gateA_offlineReplay.minPlaceholderFidelityNoFlatten,
                flattened: aggregate.flattened,
                allowedFlatten: aggregate.allowedFlatten,
            }
        );
        addCheck(
            checks,
            "gate-a:usage-double-count",
            aggregate.usageDoubleCount === config.gateA_offlineReplay.usageDoubleCount,
            {
                actual: aggregate.usageDoubleCount,
                expected: config.gateA_offlineReplay.usageDoubleCount,
            }
        );

        const failed = checks.filter((check) => !check.pass);
        report = {
            $schema: "edge-translate/vnext-gate-a-report/v1",
            gate: "A",
            mode: "offline-deterministic",
            paidProviderCalls: 0,
            networkAccessRequired: false,
            passed: failed.length === 0,
            summary: {
                fixtureCases: fixtures.length,
                fixtureFamilies: families.length,
                assertions: checks.length,
                failedAssertions: failed.length,
            },
            thresholds: config.gateA_offlineReplay,
            metrics: {
                ...aggregate,
                placeholderFidelityNoFlatten: fidelity,
                tokenPin,
                recoveryDirectives,
            },
            families,
            fixtures,
            checks,
            liveOnlyRemaining: [
                "Gate 0 paid-provider placeholder probe",
                "Gate C live quality A/B and chrF references",
                "Gate D throttled real-browser latency",
                "Gate E stable-vs-vNext provider receipt comparison",
                "Gate F bounded human adequacy/fluency spot-check",
            ],
        };
    } finally {
        restoreHook();
    }

    const serialized = options.compact ? JSON.stringify(report) : JSON.stringify(report, null, 2);
    if (options.output) {
        fs.mkdirSync(path.dirname(options.output), { recursive: true });
        fs.writeFileSync(options.output, `${serialized}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${serialized}\n`);
    process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
    const report = {
        $schema: "edge-translate/vnext-gate-a-report/v1",
        gate: "A",
        mode: "offline-deterministic",
        passed: false,
        harnessError: error?.stack || error?.message || String(error),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
});
