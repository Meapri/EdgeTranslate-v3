#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
function readArg(name, fallback = "") {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}
const liveUrl = readArg("url");
const fixtureUrl = readArg("fixture-url");
const liveProvider = readArg("provider");
const liveModel = readArg("model");
const stubProvider = readArg("stub-provider", "compatible");
const pipeline = readArg("pipeline", "vnext");
const expectedPipeline = readArg("expect-pipeline");
const screenshotArg = readArg("screenshot");
const maxRequestsArg = Number(readArg("max-requests"));
const timeoutMsArg = Number(readArg("timeout-ms"));
const stubBaseLatencyMsArg = Number(readArg("stub-base-latency-ms"));
const stubOutputTokenLatencyMsArg = Number(readArg("stub-output-token-latency-ms"));
const stubBaseLatencyMs =
    Number.isFinite(stubBaseLatencyMsArg) && stubBaseLatencyMsArg > 0 ? stubBaseLatencyMsArg : 0;
const stubOutputTokenLatencyMs =
    Number.isFinite(stubOutputTokenLatencyMsArg) && stubOutputTokenLatencyMsArg > 0
        ? stubOutputTokenLatencyMsArg
        : 0;
const liveMode = Boolean(liveUrl);
const externalFixtureMode = Boolean(fixtureUrl);
const sourceLanguage = readArg("sl", liveMode || externalFixtureMode ? "ja" : "en");
const targetLanguage = readArg("tl", "ko");
const requiresVnextFeatures = pipeline === "vnext" || expectedPipeline === "vnext";
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const extensionPath = path.join(repoRoot, "packages/EdgeTranslate/build/chrome");
const chromeCandidates = [
    process.env.CHROME_PATH,
    path.join(
        os.homedir(),
        "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    ),
    path.join(
        os.homedir(),
        "Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
    ),
].filter(Boolean);

async function resolveChromePath() {
    for (const candidate of chromeCandidates) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // Try the next extension-capable browser build.
        }
    }
    throw new Error(
        "Chrome for Testing or Chromium is required; set CHROME_PATH to an extension-capable build"
    );
}

async function readBrowserVersion(executable) {
    return new Promise((resolve) => {
        const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let output = "";
        child.stdout.on("data", (chunk) => {
            output += String(chunk);
        });
        child.once("exit", () => resolve(output.trim() || path.basename(executable)));
        child.once("error", () => resolve(path.basename(executable)));
    });
}

async function discoverUnpackedExtensionId(profile, directory) {
    const expected = path.resolve(directory);
    for (const filename of ["Secure Preferences", "Preferences"]) {
        try {
            const raw = await fs.readFile(path.join(profile, "Default", filename), "utf8");
            const settings = JSON.parse(raw)?.extensions?.settings || {};
            const match = Object.entries(settings).find(
                ([, value]) => path.resolve(value?.path || "") === expected
            );
            if (match) return match[0];
        } catch {
            // Chrome may still be writing the initial profile.
        }
    }
    return "";
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureScreenshot(client) {
    if (!screenshotArg) return "";
    const outputPath = path.resolve(screenshotArg);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const result = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
    });
    assert(result?.data, "Chrome did not return screenshot data");
    await fs.writeFile(outputPath, Buffer.from(result.data, "base64"));
    return outputPath;
}

async function waitFor(
    predicate,
    { timeoutMs = 15000, intervalMs = 100, label = "condition" } = {}
) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await predicate();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await wait(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

const RECOVERY_DIRECTIVES = Object.freeze({
    "retry-schema-return-every-id-exactly-once": "schema",
    "retry-inventory-preserve-every-placeholder-in-source-order": "inventory",
    "retry-order-keep-placeholder-source-order": "order",
    "retry-atomic-translate-completely-preserve-protected-values": "atomic",
    "retry-semantic-natural-target-preserve-protected-values": "semantic",
});

function parseProviderWire(body) {
    try {
        const geminiContent = body?.contents?.[0]?.parts
            ?.map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("");
        const content = body?.messages?.[1]?.content ?? body?.input ?? geminiContent;
        const wire = typeof content === "string" ? JSON.parse(content || "{}") : content;
        return wire && typeof wire === "object" ? wire : null;
    } catch {
        return null;
    }
}

function providerPayloadText(body) {
    const geminiContent = body?.contents?.[0]?.parts
        ?.map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    const value = body?.messages?.[1]?.content ?? body?.input ?? geminiContent ?? "";
    return typeof value === "string" ? value : JSON.stringify(value);
}

function requestedOutputTokenCap(body) {
    return Number(
        body?.max_completion_tokens ??
            body?.max_tokens ??
            body?.max_output_tokens ??
            body?.generationConfig?.maxOutputTokens ??
            NaN
    );
}

function stubProviderProtocol(provider) {
    if (provider === "openai") return "openai-responses-local-http-stub";
    if (provider === "gemini") return "gemini-generate-content-local-http-stub";
    return "openai-compatible-local-http-stub";
}

function observedStubProvider(body) {
    if (Array.isArray(body?.messages)) return "compatible";
    if (typeof body?.input === "string" && body?.text?.format?.type === "json_schema") {
        return "openai";
    }
    if (Array.isArray(body?.contents) && body?.generationConfig?.responseJsonSchema) {
        return "gemini";
    }
    return "unknown";
}

function requestMetricSummary(values, bucketFor = (value) => String(value)) {
    const finite = values.filter((value) => Number.isFinite(value));
    if (!finite.length) return { min: null, max: null, average: null, histogram: {} };
    const histogram = {};
    for (const value of finite) {
        const bucket = bucketFor(value);
        histogram[bucket] = (histogram[bucket] || 0) + 1;
    }
    return {
        min: Math.min(...finite),
        max: Math.max(...finite),
        average: Number(
            (finite.reduce((total, value) => total + value, 0) / finite.length).toFixed(1)
        ),
        histogram,
    };
}

function createRequestBucket(extra = {}) {
    return {
        ...extra,
        requests: 0,
        items: 0,
        sourceCharacters: 0,
        payloadBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        _itemsPerRequest: [],
        _sourceCharactersPerRequest: [],
        _outputTokensPerRequest: [],
        _requestedOutputTokenCaps: [],
    };
}

function addRequestToBucket(bucket, metrics) {
    bucket.requests += 1;
    bucket.items += metrics.items;
    bucket.sourceCharacters += metrics.sourceCharacters;
    bucket.payloadBytes += metrics.payloadBytes;
    bucket.inputTokens += metrics.inputTokens;
    bucket.outputTokens += metrics.outputTokens;
    bucket.totalTokens += metrics.totalTokens;
    bucket._itemsPerRequest.push(metrics.items);
    bucket._sourceCharactersPerRequest.push(metrics.sourceCharacters);
    bucket._outputTokensPerRequest.push(metrics.outputTokens);
    if (Number.isFinite(metrics.requestedOutputTokenCap)) {
        bucket._requestedOutputTokenCaps.push(metrics.requestedOutputTokenCap);
    }
}

function finalizeRequestBucket(bucket) {
    bucket.perRequest = {
        items: requestMetricSummary(bucket._itemsPerRequest),
        sourceCharacters: requestMetricSummary(bucket._sourceCharactersPerRequest, (value) =>
            value <= 255
                ? "0-255"
                : value <= 511
                ? "256-511"
                : value <= 1023
                ? "512-1023"
                : value <= 1535
                ? "1024-1535"
                : "1536+"
        ),
        outputTokens: requestMetricSummary(bucket._outputTokensPerRequest, (value) =>
            value <= 255 ? "0-255" : value <= 511 ? "256-511" : value <= 1023 ? "512-1023" : "1024+"
        ),
        requestedOutputTokenCap: requestMetricSummary(bucket._requestedOutputTokenCaps),
    };
    delete bucket._itemsPerRequest;
    delete bucket._sourceCharactersPerRequest;
    delete bucket._outputTokensPerRequest;
    delete bucket._requestedOutputTokenCaps;
    return bucket;
}

function summarizeProviderRequests(requests, receipts = []) {
    const totals = createRequestBucket();
    const baseline = createRequestBucket();
    const recovery = {
        totals: createRequestBucket(),
        byDirective: Object.fromEntries(
            Object.entries(RECOVERY_DIRECTIVES).map(([directive, kind]) => [
                directive,
                createRequestBucket({ kind }),
            ])
        ),
        unknown: createRequestBucket({ directives: [] }),
    };
    const malformed = createRequestBucket();

    requests.forEach((body, index) => {
        const wire = parseProviderWire(body);
        const sources = Array.isArray(wire?.x)
            ? wire.x.map((item) => item?.s)
            : Array.isArray(wire?.s)
            ? wire.s
            : [];
        const itemCount = sources.length;
        const requestSourceCharacters = sources.reduce(
            (total, source) => total + String(source || "").length,
            0
        );
        const requestPayloadBytes = Buffer.byteLength(JSON.stringify(body));
        const receipt = receipts[index] || {};
        const metrics = {
            items: itemCount,
            sourceCharacters: requestSourceCharacters,
            payloadBytes: requestPayloadBytes,
            inputTokens: Number(receipt.inputTokens) || 0,
            outputTokens: Number(receipt.outputTokens) || 0,
            totalTokens: Number(receipt.totalTokens) || 0,
            requestedOutputTokenCap: requestedOutputTokenCap(body),
        };
        const directive = typeof wire?.d === "string" ? wire.d : "";
        const recoveryKind = RECOVERY_DIRECTIVES[directive] || "";
        addRequestToBucket(totals, metrics);
        if (!wire) {
            addRequestToBucket(malformed, metrics);
        } else if (directive) {
            addRequestToBucket(recovery.totals, metrics);
            if (recoveryKind) {
                addRequestToBucket(recovery.byDirective[directive], metrics);
            } else {
                addRequestToBucket(recovery.unknown, metrics);
                if (!recovery.unknown.directives.includes(directive)) {
                    recovery.unknown.directives.push(directive);
                }
            }
        } else {
            addRequestToBucket(baseline, metrics);
        }
    });

    return {
        totals: finalizeRequestBucket(totals),
        baseline: finalizeRequestBucket(baseline),
        recovery: {
            totals: finalizeRequestBucket(recovery.totals),
            byDirective: Object.fromEntries(
                Object.entries(recovery.byDirective).map(([directive, bucket]) => [
                    directive,
                    finalizeRequestBucket(bucket),
                ])
            ),
            unknown: finalizeRequestBucket(recovery.unknown),
        },
        malformed: finalizeRequestBucket(malformed),
    };
}

function providerRequestSequence(requests, receipts = []) {
    return requests.map((body, index) => {
        const wire = parseProviderWire(body);
        const wireItems = Array.isArray(wire?.x)
            ? wire.x
            : Array.isArray(wire?.s)
            ? wire.s.map((source) => ({ s: source }))
            : [];
        const sources = wireItems.map((item) => String(item?.s || ""));
        const directive = typeof wire?.d === "string" ? wire.d : "";
        const roles = {};
        for (const item of wireItems) {
            const role = typeof item?.r === "string" ? item.r : "default";
            roles[role] = (roles[role] || 0) + 1;
        }
        const receipt = receipts[index] || {};
        return {
            request: index + 1,
            receivedAtMs: Number(receipt.receivedAtMs) || null,
            family: directive
                ? `recovery-${RECOVERY_DIRECTIVES[directive] || "unknown"}`
                : "baseline",
            directive: directive || null,
            items: sources.length,
            sourceCharacters: sources.reduce((total, source) => total + source.length, 0),
            maxSourceCharacters: sources.reduce(
                (maximum, source) => Math.max(maximum, source.length),
                0
            ),
            placeholderItems: sources.filter((source) => /<\/?g\d+>|<v\d+\/>/.test(source)).length,
            roles,
            inputTokens: Number(receipt.inputTokens) || 0,
            outputTokens: Number(receipt.outputTokens) || 0,
            totalTokens: Number(receipt.totalTokens) || 0,
            requestedOutputTokenCap: requestedOutputTokenCap(body),
            sourceSamples: sources.slice(0, 3).map((source) => source.slice(0, 120)),
        };
    });
}

function summarizeFixtureRequestPhases(requests, receipts, events) {
    const lateContentEvent = events.find((event) => event.name === "late-content") || null;
    const lateAttributesEvent = events.find((event) => event.name === "late-attributes") || null;
    // Classify by the fixture's source payload, not wall-clock/request-count boundaries.
    // Concurrent Chrome smokes can delay initial dispatch beyond the 800/1000 ms mutation
    // timers; using those timers as slicing indexes falsely labels untouched initial packets as
    // mutation amplification. The source signatures are deterministic and protocol-agnostic.
    const phaseIndexes = {
        initial: [],
        "late-content": [],
        "late-attributes": [],
    };
    requests.forEach((body, index) => {
        const wire = parseProviderWire(body);
        const sources = Array.isArray(wire?.x)
            ? wire.x.map((item) => String(item?.s || ""))
            : Array.isArray(wire?.s)
            ? wire.s.map((source) => String(source || ""))
            : [];
        const phase = sources.some(
            (source) => source === "Review changes" || source === "Find stations"
        )
            ? "late-attributes"
            : sources.includes("Late hydrated route update")
            ? "late-content"
            : "initial";
        phaseIndexes[phase].push(index);
    });
    const phases = Object.fromEntries(
        Object.entries(phaseIndexes).map(([name, indexes]) => {
            const phaseRequests = indexes.map((index) => requests[index]);
            const phaseReceipts = indexes.map((index) => receipts[index]);
            const summary = summarizeProviderRequests(phaseRequests, phaseReceipts);
            return [
                name,
                {
                    requests: summary.totals.requests,
                    items: summary.totals.items,
                    sourceCharacters: summary.totals.sourceCharacters,
                    inputTokens: summary.totals.inputTokens,
                    outputTokens: summary.totals.outputTokens,
                    recoveryRequests: summary.recovery.totals.requests,
                    requestRange: indexes.length
                        ? [Math.min(...indexes) + 1, Math.max(...indexes) + 1]
                        : [],
                    requestNumbers: indexes.map((index) => index + 1),
                },
            ];
        })
    );
    return {
        events: {
            lateContent: lateContentEvent,
            lateAttributes: lateAttributesEvent,
        },
        phases,
    };
}

function runtimeExceptions(clients, newEvents) {
    return clients
        .flatMap((client) => newEvents(client))
        .filter((event) => event.method === "Runtime.exceptionThrown")
        .map(
            (event) =>
                event.params?.exceptionDetails?.exception?.description ||
                event.params?.exceptionDetails?.text ||
                "unknown"
        );
}

function activeExecutionContexts(events) {
    const contexts = new Map();
    for (const event of events) {
        if (event.method === "Runtime.executionContextsCleared") {
            contexts.clear();
            continue;
        }
        if (event.method === "Runtime.executionContextDestroyed") {
            contexts.delete(event.params?.executionContextId);
            continue;
        }
        if (event.method === "Runtime.executionContextCreated") {
            const context = event.params?.context;
            if (context?.id) contexts.set(context.id, context);
        }
    }
    return Array.from(contexts.values());
}

async function readExtensionContextDiagnostics(pageClient) {
    const activeContexts = activeExecutionContexts(pageClient.events);
    const isolatedContexts = activeContexts.filter((context) => context?.name === "Edge Translate");
    const probes = [];
    for (const context of isolatedContexts) {
        try {
            const probe = await pageClient.evaluate(
                `(() => {
                    const controller = window.EdgeTranslateBannerController || null;
                    const activePipeline = controller?._activePagePipeline || null;
                    const call = (owner, method) => {
                        if (typeof owner?.[method] !== "function") return null;
                        try {
                            return owner[method]();
                        } catch (error) {
                            return { probeError: error?.message || String(error) };
                        }
                    };
                    return {
                        controllerExists: Boolean(controller),
                        currentTranslator: controller?.currentTranslator || null,
                        controllerGetStatusSnapshotAvailable:
                            typeof controller?.getStatusSnapshot === "function",
                        controllerStatusSnapshot: call(controller, "getStatusSnapshot"),
                        pipelineExists: Boolean(activePipeline),
                        pipelineGetSnapshotAvailable: typeof activePipeline?.getSnapshot === "function",
                        pipelineSnapshot: call(activePipeline, "getSnapshot"),
                        pipelineGetStatusSnapshotAvailable:
                            typeof activePipeline?.getStatusSnapshot === "function",
                        pipelineStatusSnapshot: call(activePipeline, "getStatusSnapshot")
                    };
                })()`,
                context.id
            );
            probes.push({
                contextId: context.id,
                name: context.name || "",
                origin: context.origin || "",
                frameId: context.auxData?.frameId || null,
                isDefault: Boolean(context.auxData?.isDefault),
                probe,
            });
        } catch (error) {
            probes.push({
                contextId: context.id,
                name: context.name || "",
                origin: context.origin || "",
                frameId: context.auxData?.frameId || null,
                isDefault: Boolean(context.auxData?.isDefault),
                probeError: error?.message || String(error),
            });
        }
    }
    const selected =
        probes.find(
            (entry) =>
                entry.probe?.controllerExists &&
                entry.probe?.pipelineExists &&
                entry.probe?.pipelineGetStatusSnapshotAvailable
        ) ||
        probes.find((entry) => entry.probe?.controllerExists && entry.probe?.pipelineExists) ||
        probes.find((entry) => entry.probe?.controllerExists) ||
        null;
    return {
        activeContextCount: activeContexts.length,
        isolatedContextCount: isolatedContexts.length,
        selected,
        probes,
    };
}

class CdpClient {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.sequence = 0;
        this.pending = new Map();
        this.events = [];
        this.ready = new Promise((resolve, reject) => {
            this.socket.once("open", resolve);
            this.socket.once("error", reject);
        });
        this.socket.on("message", (data) => {
            const message = JSON.parse(String(data));
            if (message.id) {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error.message));
                else pending.resolve(message.result);
                return;
            }
            this.events.push(message);
        });
    }

    async send(method, params = {}) {
        await this.ready;
        const id = ++this.sequence;
        const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
        this.socket.send(JSON.stringify({ id, method, params }));
        return result;
    }

    async evaluate(expression, contextId = undefined) {
        const result = await this.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
            ...(Number.isInteger(contextId) ? { contextId } : {}),
        });
        if (result.exceptionDetails) {
            throw new Error(
                result.exceptionDetails.exception?.description || "Runtime evaluation failed"
            );
        }
        return result.result?.value;
    }

    close() {
        this.socket.close();
    }
}

function fixtureHtml() {
    const rows = Array.from(
        { length: 48 },
        (_, index) =>
            `<tr><th>Station ${index + 1}</th><td>Express service ${index + 1}</td><td>${
                index + 1
            }.5 km</td></tr>`
    ).join("");
    const list = Array.from(
        { length: 30 },
        (_, index) => `<li>History event ${index + 1} with route information</li>`
    ).join("");
    return `<!doctype html>
        <html lang="en"><head><meta charset="utf-8"><title>Stable browser fixture</title></head>
        <body><main id="article" class="site-shell" data-owner="fixture">
            <h1 id="title" title="Railway guide">Intercity railway guide</h1>
            <p id="lead">Read <a id="link" href="/release" data-track="preserve">release notes</a> before travel.</p>
            <button id="action" aria-label="Save changes">Save changes</button>
            <input id="editor" value="user draft" placeholder="Search stations">
            <table><tbody>${rows}</tbody></table><ul>${list}</ul>
        </main>
        <script>
            window.fixtureClicks = 0;
            document.getElementById("action").addEventListener("click", () => window.fixtureClicks++);
            const editor = document.getElementById("editor");
            editor.focus(); editor.setSelectionRange(2, 6);
            const markFixturePhase = (name) => fetch(
                "/fixture-event?name=" + encodeURIComponent(name),
                { method: "POST", cache: "no-store" }
            ).catch(() => null);
            const waitForFixtureCondition = async (predicate) => {
                const deadline = performance.now() + 10000;
                while (performance.now() < deadline) {
                    if (predicate()) return true;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                return false;
            };
            void (async () => {
                const initialComplete = await waitForFixtureCondition(() => {
                    const banner = document.querySelector("#edge-translate-dom-page-banner");
                    return banner?.shadowRoot?.querySelector("[data-role='status']")?.textContent ===
                        "Translation complete";
                });
                if (!initialComplete) return;
                await markFixturePhase("late-content");
                const late = document.createElement("p");
                late.id = "late";
                late.textContent = "Late hydrated route update";
                document.getElementById("article").appendChild(late);
                const lateContentTranslated = await waitForFixtureCondition(
                    () => document.getElementById("late")?.textContent !== "Late hydrated route update"
                );
                if (!lateContentTranslated) return;
                await markFixturePhase("late-attributes");
                document.getElementById("action").setAttribute("aria-label", "Review changes");
                document.getElementById("editor").setAttribute("placeholder", "Find stations");
            })();
        </script></body></html>`;
}

async function readRequestBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString("utf8");
    return value ? JSON.parse(value) : {};
}

function translateStubText(source) {
    const value = String(source || "");
    if (!/^ko(?:-|$)/i.test(targetLanguage)) return `translated ${value}`;
    if (/^ja(?:-|$)/i.test(sourceLanguage)) {
        const syllables = Array.from("가나다라마바사아자차카타파하");
        let sequence = 0;
        const protectedParts =
            /(<\/?g\d+>|<v\d+\/>|https?:\/\/[^\s<>"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|`[^`]*`|\b[A-Za-z][A-Za-z0-9_.-]*\d[A-Za-z0-9_.-]*\b)/g;
        let changed = false;
        const translated = value
            .split(protectedParts)
            .map((part) => {
                if (!part || protectedParts.test(part)) {
                    protectedParts.lastIndex = 0;
                    return part;
                }
                protectedParts.lastIndex = 0;
                return part.replace(/[\p{L}]/gu, () => {
                    changed = true;
                    return syllables[sequence++ % syllables.length];
                });
            })
            .join("");
        if (changed) return translated;
    }
    return `번역 ${value}`;
}

async function startFixtureServer() {
    const providerRequests = [];
    const providerReceipts = [];
    const fixtureEvents = [];
    const startedAt = Date.now();
    let billedTokens = 0;
    const server = http.createServer(async (request, response) => {
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader(
            "Access-Control-Allow-Headers",
            "authorization, content-type, x-goog-api-key"
        );
        if (request.method === "OPTIONS") {
            response.writeHead(204);
            response.end();
            return;
        }
        if (request.url === "/fixture") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(fixtureHtml());
            return;
        }
        const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
        if (requestUrl.pathname === "/fixture-event" && request.method === "POST") {
            fixtureEvents.push({
                name: requestUrl.searchParams.get("name") || "unknown",
                receivedAtMs: Date.now() - startedAt,
                providerRequestCount: providerRequests.length,
            });
            response.writeHead(204);
            response.end();
            return;
        }
        const isCompatibleGeneration =
            requestUrl.pathname === "/v1/chat/completions" && request.method === "POST";
        const isOpenAiGeneration =
            requestUrl.pathname === "/v1/responses" && request.method === "POST";
        const isGeminiGeneration =
            /^\/v1beta\/models\/[^/]+:generateContent$/.test(requestUrl.pathname) &&
            request.method === "POST";
        if (isCompatibleGeneration || isOpenAiGeneration || isGeminiGeneration) {
            const body = await readRequestBody(request);
            providerRequests.push(body);
            const wire = parseProviderWire(body) || {};
            const output = Array.isArray(wire.x)
                ? {
                      x: wire.x.map((item) => ({
                          i: item.i,
                          t: translateStubText(item.s),
                      })),
                  }
                : { t: (wire.s || []).map((source) => translateStubText(source)) };
            const inputTokens = Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
            const outputTokens = Math.max(1, Math.ceil(JSON.stringify(output).length / 4));
            const totalTokens = inputTokens + outputTokens;
            const requestId = `browser-stub-${providerRequests.length}`;
            // Optional deterministic latency model for scheduler benchmarks. It is disabled by
            // default, so ordinary correctness smokes stay fast. When enabled, larger model
            // replies take proportionally longer and expose full-page tail scheduling effects
            // without making a paid provider request.
            const simulatedLatencyMs = Math.round(
                stubBaseLatencyMs + outputTokens * stubOutputTokenLatencyMs
            );
            if (simulatedLatencyMs > 0) await wait(simulatedLatencyMs);
            providerReceipts.push({
                inputTokens,
                outputTokens,
                totalTokens,
                receivedAtMs: Date.now() - startedAt,
                simulatedLatencyMs,
            });
            billedTokens += totalTokens;
            response.writeHead(200, {
                "content-type": "application/json",
                "x-request-id": requestId,
            });
            if (isOpenAiGeneration) {
                response.end(
                    JSON.stringify({
                        id: requestId,
                        status: "completed",
                        output_text: JSON.stringify(output),
                        usage: {
                            input_tokens: inputTokens,
                            output_tokens: outputTokens,
                            total_tokens: totalTokens,
                        },
                    })
                );
            } else if (isGeminiGeneration) {
                response.end(
                    JSON.stringify({
                        responseId: requestId,
                        candidates: [
                            {
                                finishReason: "STOP",
                                content: {
                                    role: "model",
                                    parts: [{ text: JSON.stringify(output) }],
                                },
                            },
                        ],
                        usageMetadata: {
                            promptTokenCount: inputTokens,
                            candidatesTokenCount: outputTokens,
                            totalTokenCount: totalTokens,
                        },
                    })
                );
            } else {
                response.end(
                    JSON.stringify({
                        id: requestId,
                        choices: [
                            {
                                finish_reason: "stop",
                                message: { content: JSON.stringify(output) },
                            },
                        ],
                        usage: {
                            prompt_tokens: inputTokens,
                            completion_tokens: outputTokens,
                            total_tokens: totalTokens,
                        },
                    })
                );
            }
            return;
        }
        if (requestUrl.pathname === "/v1/responses/input_tokens" && request.method === "POST") {
            const body = await readRequestBody(request);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    input_tokens: Math.max(1, Math.ceil(JSON.stringify(body).length / 4)),
                })
            );
            return;
        }
        if (
            /^\/v1beta\/models\/[^/]+:countTokens$/.test(requestUrl.pathname) &&
            request.method === "POST"
        ) {
            const body = await readRequestBody(request);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    totalTokens: Math.max(1, Math.ceil(JSON.stringify(body).length / 4)),
                })
            );
            return;
        }
        if (/^\/v1beta\/models\/[^/]+$/.test(requestUrl.pathname) && request.method === "GET") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    name: requestUrl.pathname.slice("/v1beta/".length),
                    version: "local-stub-v1",
                    inputTokenLimit: 1048576,
                    outputTokenLimit: 65536,
                })
            );
            return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `Unknown path ${request.url}` } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string", "Fixture server did not bind");
    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        providerRequests,
        providerReceipts,
        fixtureEvents,
        billedTokens: () => billedTokens,
    };
}

async function jsonEndpoint(port, route) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    if (!response.ok) throw new Error(`CDP endpoint ${route} returned ${response.status}`);
    return response.json();
}

async function run() {
    if (!["default", "stable", "vnext"].includes(pipeline)) {
        throw new Error("--pipeline must be default, stable, or vnext");
    }
    if (expectedPipeline && !["stable", "vnext"].includes(expectedPipeline)) {
        throw new Error("--expect-pipeline must be stable or vnext");
    }
    if (!["compatible", "openai", "gemini"].includes(stubProvider)) {
        throw new Error("--stub-provider must be compatible, openai, or gemini");
    }
    if (liveMode && !process.argv.includes("--confirm-provider-cost")) {
        throw new Error("Live browser mode requires --confirm-provider-cost");
    }
    if (liveMode && !["openai", "gemini"].includes(liveProvider)) {
        throw new Error("Live browser mode requires --provider=openai or --provider=gemini");
    }
    await fs.access(path.join(extensionPath, "manifest.json"));
    const chromePath = await resolveChromePath();
    const browserVersion = await readBrowserVersion(chromePath);
    const fixture = await startFixtureServer();
    const targetUrl = liveMode ? liveUrl : fixtureUrl || `${fixture.baseUrl}/fixture`;
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), `edge-${pipeline}-chrome-`));
    let chrome;
    let pageClient;
    let workerClient;
    let chromeExit;
    try {
        chrome = spawn(
            chromePath,
            [
                "--headless=new",
                "--disable-gpu",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--no-first-run",
                "--no-default-browser-check",
                "--remote-debugging-port=0",
                "--remote-allow-origins=*",
                `--user-data-dir=${profile}`,
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                targetUrl,
            ],
            { stdio: ["ignore", "ignore", "pipe"] }
        );
        chromeExit = new Promise((resolve) => chrome.once("exit", resolve));
        let chromeStderr = "";
        chrome.stderr.on("data", (chunk) => {
            chromeStderr += String(chunk);
        });
        const port = await waitFor(
            async () => {
                try {
                    const active = await fs.readFile(
                        path.join(profile, "DevToolsActivePort"),
                        "utf8"
                    );
                    return Number(active.split(/\r?\n/)[0]) || 0;
                } catch {
                    return 0;
                }
            },
            { label: "Chrome DevTools port" }
        );
        let lastTargetList = [];
        let pageTarget;
        try {
            pageTarget = await waitFor(
                async () => {
                    const list = await jsonEndpoint(port, "/json/list");
                    lastTargetList = list;
                    return list.find(
                        (target) => target.type === "page" && target.url.startsWith(targetUrl)
                    );
                },
                { label: "fixture page target" }
            );
        } catch (error) {
            const summary = lastTargetList.map(({ type, url }) => ({ type, url }));
            throw new Error(
                `${error.message}; targets=${JSON.stringify(summary)}; chrome=${chromeStderr.slice(
                    -2000
                )}`
            );
        }
        pageClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
        await Promise.all([pageClient.send("Runtime.enable"), pageClient.send("Page.enable")]);

        const extensionId = await waitFor(
            () => discoverUnpackedExtensionId(profile, extensionPath),
            { label: "unpacked Edge Translate registration" }
        );
        await pageClient.send("Page.navigate", {
            url: `chrome-extension://${extensionId}/options/options.html`,
        });
        const workerTarget = await waitFor(
            async () => {
                const list = await jsonEndpoint(port, "/json/list");
                lastTargetList = list;
                return list.find(
                    (target) =>
                        target.type === "service_worker" &&
                        target.url === `chrome-extension://${extensionId}/background/background.js`
                );
            },
            { label: "Edge Translate service worker" }
        );
        workerClient = new CdpClient(workerTarget.webSocketDebuggerUrl);
        await workerClient.send("Runtime.enable");

        const stubLocalTranslatorConfig =
            stubProvider === "openai"
                ? {
                      enabled: true,
                      mode: "openai",
                      openaiApiKey: "local-stub-key",
                      openaiModel: "gpt-5.4-mini",
                      aiPageV2OpenAIBaseUrl: `${fixture.baseUrl}/v1`,
                      timeoutMs: 10000,
                  }
                : stubProvider === "gemini"
                ? {
                      enabled: true,
                      mode: "googleAiStudio",
                      apiKey: "local-stub-key",
                      model: "gemini-2.5-flash-lite",
                      aiPageV2GeminiBaseUrl: `${fixture.baseUrl}/v1beta`,
                      aiPageV2ThinkingValue: 0,
                      timeoutMs: 10000,
                  }
                : {
                      enabled: true,
                      mode: "openaiCompatible",
                      openaiCompatibleBaseUrl: `${fixture.baseUrl}/v1`,
                      openaiCompatibleApiKey: "",
                      openaiCompatibleModel: "browser-stub",
                      timeoutMs: 10000,
                  };
        const localTranslatorConfig = liveMode
            ? liveProvider === "openai"
                ? {
                      enabled: true,
                      mode: "openai",
                      openaiApiKey: process.env.OPENAI_API_KEY || "",
                      openaiModel: liveModel,
                      timeoutMs: 120000,
                  }
                : {
                      enabled: true,
                      mode: "googleAiStudio",
                      apiKey: process.env.GEMINI_API_KEY || "",
                      model: liveModel,
                      aiPageV2ThinkingValue: 0,
                      timeoutMs: 120000,
                  }
            : stubLocalTranslatorConfig;
        const configuredEngine = liveMode
            ? liveProvider === "openai"
                ? "openai"
                : "googleAiStudio"
            : stubProvider === "openai"
            ? "openai"
            : stubProvider === "gemini"
            ? "googleAiStudio"
            : "openaiCompatible";
        const configuredModel = liveMode
            ? liveModel
            : stubProvider === "openai"
            ? "gpt-5.4-mini"
            : stubProvider === "gemini"
            ? "gemini-2.5-flash-lite"
            : "browser-stub";
        const settings = {
            LocalTranslatorConfig: localTranslatorConfig,
            DefaultPageTranslator: "AIPageTranslate",
            languageSetting: { sl: sourceLanguage, tl: targetLanguage },
            AiPageTranslateConfig: {
                ...(pipeline === "default" ? {} : { pipelineVersion: pipeline }),
                lazyTranslate: false,
                prefetchScreens: 0,
                tokenBudget: -1,
                hardTokenBudget: -1,
                skipBoilerplate: false,
                smartContentFilter: false,
            },
        };
        await workerClient.evaluate(`new Promise((resolve, reject) => {
            chrome.storage.sync.set(${JSON.stringify(settings)}, () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(true);
            });
        })`);

        await pageClient.send("Page.navigate", { url: targetUrl });
        await waitFor(
            () =>
                pageClient.evaluate(`document.readyState === "complete" && Boolean(document.body)`),
            { label: "fixture page load" }
        );
        // External applications may still be hydrating immediately after readyState=complete.
        // Give their own startup mutations a short head start so the translation CAS does not
        // spend recovery budget racing page initialization that a real user would never see.
        await wait(externalFixtureMode ? 1500 : 300);
        const externalBaseline = externalFixtureMode
            ? await pageClient.evaluate(`(() => ({
                  title: document.title,
                  elementCount: document.querySelectorAll("*").length,
                  textLength: document.body?.innerText?.length || 0,
                  htmlLength: document.documentElement?.outerHTML?.length || 0,
                  hrefs: Array.from(document.querySelectorAll("a[href]"), (anchor) => anchor.href).slice(0, 100)
              }))()`)
            : null;
        const eventOffsets = new Map([
            [pageClient, pageClient.events.length],
            [workerClient, workerClient.events.length],
        ]);
        const newEvents = (client) => client.events.slice(eventOffsets.get(client) || 0);
        if (!liveMode && !externalFixtureMode) fixture.fixtureEvents.length = 0;
        await workerClient.evaluate(`new Promise((resolve, reject) => {
            chrome.tabs.query({}, (tabs) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                const tab = tabs.find((item) => item.url && !item.url.startsWith("chrome-extension://"));
                if (!tab) return reject(new Error("fixture tab not found"));
                const message = JSON.stringify({
                    type: "event",
                    event: "start_dom_page_translate",
                    detail: {
                        engine: ${JSON.stringify(configuredEngine)},
                        model: ${JSON.stringify(configuredModel)},
                        translatorId: "LocalTranslate",
                        ${
                            pipeline === "default"
                                ? ""
                                : `pipelineVersion: ${JSON.stringify(pipeline)},`
                        }
                        sl: ${JSON.stringify(sourceLanguage)},
                        tl: ${JSON.stringify(targetLanguage)},
                        aiPageConfig: ${JSON.stringify(settings.AiPageTranslateConfig)}
                    }
                });
                chrome.tabs.sendMessage(tab.id, message, (result) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(result ?? true);
                });
            });
        })`);

        if (externalFixtureMode && !liveMode) {
            const startedAt = Date.now();
            const timeoutMs =
                Number.isFinite(timeoutMsArg) && timeoutMsArg > 0
                    ? Math.floor(timeoutMsArg)
                    : 120000;
            const readExternalState = () =>
                pageClient.evaluate(`(() => {
                        const banner = document.querySelector("#edge-translate-dom-page-banner");
                        const shadow = banner?.shadowRoot;
                        return {
                            status: shadow?.querySelector("[data-role='status']")?.textContent || "",
                            tokens: shadow?.querySelector("[data-role='token-meta']")?.textContent || "",
                            progress: shadow?.querySelector("[data-role='progress-meta']")?.textContent || "",
                            elementCount: document.querySelectorAll("*").length,
                            textLength: document.body?.innerText?.length || 0,
                            hrefs: Array.from(document.querySelectorAll("a[href]"), (anchor) => anchor.href).slice(0, 100)
                        };
                    })()`);
            let state = null;
            let waitError = null;
            try {
                state = await waitFor(
                    async () => {
                        const current = await readExternalState();
                        const terminal =
                            current.status === "Translation complete" ||
                            current.status.startsWith("Translation incomplete") ||
                            current.status.startsWith("Translation failed");
                        return terminal ? current : null;
                    },
                    {
                        timeoutMs,
                        intervalMs: 250,
                        label: `${pipeline} external fixture terminal state`,
                    }
                );
            } catch (error) {
                waitError = error?.message || String(error);
                state = await readExternalState();
            }
            const providerRequestSummary = summarizeProviderRequests(
                fixture.providerRequests,
                fixture.providerReceipts
            );
            const translatedItems = providerRequestSummary.totals.items;
            const sourceCharacters = providerRequestSummary.totals.sourceCharacters;
            const observedPipeline = fixture.providerRequests.some(
                (body) => parseProviderWire(body)?.v === "pt3"
            )
                ? "vnext"
                : "stable";
            const exceptions = runtimeExceptions([workerClient, pageClient], newEvents);
            const extensionIsolatedContext = await readExtensionContextDiagnostics(pageClient);
            const selectedProbe = extensionIsolatedContext.selected?.probe || null;
            const controllerStatusSnapshot = selectedProbe?.controllerStatusSnapshot || null;
            const pipelineMappedSnapshot = selectedProbe?.pipelineSnapshot || null;
            const pipelineStatusSnapshot = selectedProbe?.pipelineStatusSnapshot || null;
            const terminalKind =
                state?.status === "Translation complete"
                    ? "complete"
                    : state?.status?.startsWith("Translation incomplete")
                    ? "incomplete"
                    : state?.status?.startsWith("Translation failed")
                    ? "failed"
                    : "timeout";
            const requestCeiling =
                Number.isFinite(maxRequestsArg) && maxRequestsArg > 0
                    ? Math.floor(maxRequestsArg)
                    : 30;
            const checks = [];
            const recordCheck = (name, passed, detail) =>
                checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
            recordCheck(
                "external-page-not-blank",
                externalBaseline?.textLength > 0,
                `baseline text length ${externalBaseline?.textLength || 0}`
            );
            recordCheck(
                "translation-complete",
                terminalKind === "complete",
                state?.status || waitError || "no terminal status"
            );
            recordCheck(
                "progress-100-percent",
                state?.progress === "100%",
                state?.progress || "missing"
            );
            recordCheck(
                "provider-request-observed",
                fixture.providerRequests.length > 0,
                `${fixture.providerRequests.length} requests`
            );
            const observedStubProviders = Array.from(
                new Set(fixture.providerRequests.map(observedStubProvider))
            );
            recordCheck(
                "stub-provider-protocol",
                observedStubProviders.length === 1 && observedStubProviders[0] === stubProvider,
                `expected ${stubProvider}; observed ${observedStubProviders.join(",") || "none"}`
            );
            recordCheck(
                "provider-request-ceiling",
                fixture.providerRequests.length <= requestCeiling,
                `${fixture.providerRequests.length} <= ${requestCeiling}`
            );
            recordCheck(
                "translation-items-observed",
                translatedItems > 0,
                `${translatedItems} items`
            );
            recordCheck(
                "anchor-destinations-preserved",
                JSON.stringify(state?.hrefs || []) ===
                    JSON.stringify(externalBaseline?.hrefs || []),
                `${state?.hrefs?.length || 0} sampled anchors`
            );
            recordCheck(
                "no-runtime-exceptions",
                exceptions.length === 0,
                exceptions.length ? JSON.stringify(exceptions) : "0 exceptions"
            );
            if (expectedPipeline) {
                recordCheck(
                    "expected-pipeline",
                    observedPipeline === expectedPipeline,
                    `expected ${expectedPipeline}; observed ${observedPipeline}`
                );
            }
            if (requiresVnextFeatures) {
                recordCheck(
                    "vnext-isolated-context",
                    Boolean(extensionIsolatedContext.selected),
                    `${extensionIsolatedContext.isolatedContextCount} Edge Translate contexts`
                );
                recordCheck(
                    "vnext-get-status-snapshot",
                    Boolean(
                        selectedProbe?.pipelineGetStatusSnapshotAvailable &&
                            pipelineStatusSnapshot &&
                            typeof pipelineStatusSnapshot === "object"
                    ),
                    selectedProbe?.pipelineGetStatusSnapshotAvailable
                        ? `phase ${pipelineStatusSnapshot?.phase || "missing"}`
                        : "pipeline getStatusSnapshot unavailable"
                );
                recordCheck(
                    "vnext-snapshot-telemetry",
                    Boolean(
                        pipelineStatusSnapshot?.telemetry &&
                            typeof pipelineStatusSnapshot.telemetry === "object"
                    ),
                    pipelineStatusSnapshot?.telemetry
                        ? `${Object.keys(pipelineStatusSnapshot.telemetry).length} counters`
                        : "telemetry unavailable"
                );
            }
            const screenshot = await captureScreenshot(pageClient);
            const passed = checks.every((check) => check.passed);
            console.log(
                JSON.stringify(
                    {
                        schemaVersion: "ai-page-external-fixture-smoke-2",
                        passed,
                        browser: browserVersion,
                        pipeline,
                        observedPipeline,
                        url: targetUrl,
                        sourceLanguage,
                        targetLanguage,
                        externalProviderCost: false,
                        tokenAccounting: "deterministic-local-stub-estimate",
                        simulatedProviderLatency: {
                            baseMs: stubBaseLatencyMs,
                            outputTokenMs: stubOutputTokenLatencyMs,
                        },
                        stubProvider,
                        providerProtocol: stubProviderProtocol(stubProvider),
                        observedStubProviders,
                        elapsedMs: Date.now() - startedAt,
                        timeoutMs,
                        terminalKind,
                        waitError,
                        status: state?.status || "",
                        progress: state?.progress || "",
                        generationRequests: fixture.providerRequests.length,
                        translatedItems,
                        sourceCharacters,
                        averageItemsPerRequest: Number(
                            (
                                translatedItems / Math.max(1, fixture.providerRequests.length)
                            ).toFixed(1)
                        ),
                        providerReportedTokens: fixture.billedTokens(),
                        providerPayloadBytes: providerRequestSummary.totals.payloadBytes,
                        providerRequestSummary,
                        bannerTokenText: state?.tokens || "",
                        controllerStatusSnapshot,
                        pipelineMappedSnapshot,
                        pipelineStatusSnapshot,
                        snapshotTelemetry: pipelineStatusSnapshot?.telemetry || null,
                        failureDistribution: {
                            totalStrings: pipelineStatusSnapshot?.totalStrings ?? null,
                            translatedStrings: pipelineStatusSnapshot?.translatedStrings ?? null,
                            failedStrings: pipelineStatusSnapshot?.failedStrings ?? null,
                            incompleteStrings: pipelineStatusSnapshot?.incompleteStrings ?? null,
                            failure: pipelineStatusSnapshot?.failure || null,
                            telemetry: pipelineStatusSnapshot?.telemetry || null,
                            recoveryRequests: {
                                totals: {
                                    requests: providerRequestSummary.recovery.totals.requests,
                                    items: providerRequestSummary.recovery.totals.items,
                                    sourceCharacters:
                                        providerRequestSummary.recovery.totals.sourceCharacters,
                                    totalTokens: providerRequestSummary.recovery.totals.totalTokens,
                                },
                                byDirective: Object.fromEntries(
                                    Object.entries(providerRequestSummary.recovery.byDirective).map(
                                        ([directive, summary]) => [
                                            directive,
                                            {
                                                kind: summary.kind,
                                                requests: summary.requests,
                                                items: summary.items,
                                            },
                                        ]
                                    )
                                ),
                            },
                        },
                        extensionIsolatedContext,
                        before: {
                            title: externalBaseline?.title || "",
                            elementCount: externalBaseline?.elementCount || 0,
                            textLength: externalBaseline?.textLength || 0,
                            htmlLength: externalBaseline?.htmlLength || 0,
                            hrefSampleSize: externalBaseline?.hrefs?.length || 0,
                        },
                        after: {
                            elementCount: state?.elementCount || 0,
                            textLength: state?.textLength || 0,
                            hrefSampleSize: state?.hrefs?.length || 0,
                        },
                        runtimeExceptions: exceptions.length,
                        runtimeExceptionDetails: exceptions,
                        checks,
                        ...(screenshot ? { screenshot } : {}),
                    },
                    null,
                    2
                )
            );
            if (!passed) process.exitCode = 1;
            return;
        }

        if (liveMode) {
            const startedAt = Date.now();
            let state = null;
            let completedSweeps = 0;
            while (Date.now() - startedAt < 120000) {
                state = await pageClient.evaluate(`(() => {
                    const banner = document.querySelector("#edge-translate-dom-page-banner");
                    const shadow = banner?.shadowRoot;
                    return {
                        status: shadow?.querySelector("[data-role='status']")?.textContent || "",
                        tokens: shadow?.querySelector("[data-role='token-meta']")?.textContent || "",
                        progress: shadow?.querySelector("[data-role='progress-meta']")?.textContent || "",
                        scrollY,
                        scrollHeight: document.documentElement.scrollHeight,
                        viewportHeight: innerHeight,
                        elementCount: document.querySelectorAll("*").length
                    };
                })()`);
                if (
                    state.status === "Translation complete" ||
                    state.status.startsWith("Translation incomplete")
                ) {
                    break;
                }
                if (state.status.startsWith("Current view translated")) {
                    const reachedBottom =
                        state.scrollY + state.viewportHeight >= state.scrollHeight - 8;
                    if (reachedBottom) completedSweeps += 1;
                    await pageClient.evaluate(`(() => {
                        const reachedBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 8;
                        scrollTo(0, reachedBottom ? 0 : Math.min(
                            document.documentElement.scrollHeight,
                            scrollY + innerHeight * 1.2
                        ));
                        dispatchEvent(new Event("scroll"));
                    })()`);
                }
                await wait(1200);
            }
            assert(state?.tokens, "Live stable run did not report token usage");
            assert(
                state.status === "Translation complete" ||
                    state.status.startsWith("Translation incomplete"),
                `Live stable run did not reach a terminal state: ${JSON.stringify({
                    ...state,
                    completedSweeps,
                })}`
            );
            const exceptionDescriptions = (client) =>
                newEvents(client)
                    .filter((event) => event.method === "Runtime.exceptionThrown")
                    .map(
                        (event) =>
                            event.params?.exceptionDetails?.exception?.description ||
                            event.params?.exceptionDetails?.text ||
                            "unknown"
                    );
            const workerExceptions = exceptionDescriptions(workerClient);
            const pageExceptions = exceptionDescriptions(pageClient);
            const extensionIsolatedContext = await readExtensionContextDiagnostics(pageClient);
            const selectedProbe = extensionIsolatedContext.selected?.probe || null;
            const pipelineMappedSnapshot = selectedProbe?.pipelineSnapshot || null;
            const pipelineStatusSnapshot = selectedProbe?.pipelineStatusSnapshot || null;
            assert(
                workerExceptions.length === 0,
                `Extension worker exceptions: ${JSON.stringify(workerExceptions)}`
            );
            const screenshot = await captureScreenshot(pageClient);
            console.log(
                JSON.stringify(
                    {
                        schemaVersion: "ai-page-stable-live-browser-smoke-1",
                        browser: browserVersion,
                        url: targetUrl,
                        provider: liveProvider,
                        model: liveModel,
                        externalProviderCost: true,
                        elapsedMs: Date.now() - startedAt,
                        status: state.status,
                        bannerTokenText: state.tokens,
                        progress: state.progress,
                        scrollY: state.scrollY,
                        scrollHeight: state.scrollHeight,
                        elementCount: state.elementCount,
                        pipelineMappedSnapshot,
                        pipelineStatusSnapshot,
                        extensionRuntimeExceptions: workerExceptions.length,
                        pageRuntimeExceptions: pageExceptions.length,
                        ...(screenshot ? { screenshot } : {}),
                    },
                    null,
                    2
                )
            );
            return;
        }

        const readPageState = () =>
            pageClient.evaluate(`(() => {
                    const banner = document.querySelector("#edge-translate-dom-page-banner");
                    const shadow = banner?.shadowRoot;
                    return {
                        title: document.querySelector("#title")?.textContent || "",
                        lead: document.querySelector("#lead")?.textContent || "",
                        late: document.querySelector("#late")?.textContent || "",
                        bannerExists: Boolean(banner),
                        htmlHasBanner: document.documentElement.outerHTML.includes("edge-translate-dom-page-banner"),
                        shadowReadable: Boolean(shadow),
                        shadowRoleCount: shadow?.querySelectorAll("[data-role]").length || 0,
                        shadowText: shadow?.textContent?.slice(0, 300) || "",
                        directChildren: Array.from(document.documentElement.children).map((element) => element.tagName + "#" + element.id),
                        status: shadow?.querySelector("[data-role='status']")?.textContent || "",
                        tokens: shadow?.querySelector("[data-role='token-meta']")?.textContent || "",
                        progress: shadow?.querySelector("[data-role='progress-meta']")?.textContent || "",
                        href: document.querySelector("#link")?.getAttribute("href"),
                        track: document.querySelector("#link")?.getAttribute("data-track"),
                        inputValue: document.querySelector("#editor")?.value,
                        inputPlaceholder: document.querySelector("#editor")?.getAttribute("placeholder") || "",
                        actionAriaLabel: document.querySelector("#action")?.getAttribute("aria-label") || "",
                        activeId: document.activeElement?.id || "",
                        selection: [document.querySelector("#editor")?.selectionStart, document.querySelector("#editor")?.selectionEnd],
                        pipeline: ${JSON.stringify(pipeline)}
                    };
                })()`);
        let pageState;
        try {
            pageState = await waitFor(
                async () => {
                    const state = await readPageState();
                    const dynamicAttributesReady =
                        !requiresVnextFeatures ||
                        (state.inputPlaceholder.startsWith("번역 ") &&
                            state.inputPlaceholder.includes("Find stations") &&
                            state.actionAriaLabel.startsWith("번역 ") &&
                            state.actionAriaLabel.includes("Review changes"));
                    return state.status === "Translation complete" &&
                        state.late.startsWith("번역 ") &&
                        dynamicAttributesReady
                        ? state
                        : null;
                },
                { timeoutMs: 12000, label: `${pipeline} page translation completion` }
            );
        } catch (error) {
            const state = await readPageState();
            const exceptions = [workerClient, pageClient]
                .flatMap((client) => newEvents(client))
                .filter((event) => event.method === "Runtime.exceptionThrown")
                .map(
                    (event) =>
                        event.params?.exceptionDetails?.exception?.description ||
                        event.params?.exceptionDetails?.text
                );
            throw new Error(
                `${error.message}; state=${JSON.stringify(state)}; providerRequests=${
                    fixture.providerRequests.length
                }; exceptions=${JSON.stringify(exceptions)}`
            );
        }
        pageState = await waitFor(
            async () => {
                const state = await readPageState();
                return state.tokens.includes(`${fixture.providerRequests.length} request`)
                    ? state
                    : null;
            },
            { timeoutMs: 3000, label: "final banner usage repaint" }
        );
        const clicks = await pageClient.evaluate(`(() => {
            document.querySelector("#action").click();
            return window.fixtureClicks;
        })()`);

        assert(pageState.title.startsWith("번역 "), "Title was not translated");
        assert(pageState.lead.includes("번역 "), "Inline paragraph was not translated");
        assert(pageState.href === "/release", "Link href changed");
        assert(pageState.track === "preserve", "data attribute changed");
        assert(pageState.inputValue === "user draft", "Input value changed");
        if (requiresVnextFeatures) {
            assert(
                pageState.inputPlaceholder.startsWith("번역 ") &&
                    pageState.inputPlaceholder.includes("Find stations"),
                "Late placeholder attribute was not translated"
            );
            assert(
                pageState.actionAriaLabel.startsWith("번역 ") &&
                    pageState.actionAriaLabel.includes("Review changes"),
                "Late aria-label attribute was not translated"
            );
        }
        assert(pageState.activeId === "editor", "Focus changed during translation");
        assert(pageState.selection[0] === 2 && pageState.selection[1] === 6, "Selection changed");
        assert(clicks === 1, "Existing event listener was lost");
        assert(pageState.progress === "100%", "Banner did not reach 100%");
        assert(
            fixture.providerRequests.length >= 1,
            "Provider stub received no generation request"
        );
        const observedStubProviders = Array.from(
            new Set(fixture.providerRequests.map(observedStubProvider))
        );
        assert(
            observedStubProviders.length === 1 && observedStubProviders[0] === stubProvider,
            `Expected ${stubProvider} request bodies, observed ${
                observedStubProviders.join(",") || "none"
            }`
        );
        const providerRequestSummary = summarizeProviderRequests(
            fixture.providerRequests,
            fixture.providerReceipts
        );
        const translatedItems = providerRequestSummary.totals.items;
        const sourceCharacters = providerRequestSummary.totals.sourceCharacters;
        const providerRequests = providerRequestSequence(
            fixture.providerRequests,
            fixture.providerReceipts
        );
        const providerRequestPhases = summarizeFixtureRequestPhases(
            fixture.providerRequests,
            fixture.providerReceipts,
            fixture.fixtureEvents
        );
        const observedPipeline = fixture.providerRequests.some(
            (body) => parseProviderWire(body)?.v === "pt3"
        )
            ? "vnext"
            : "stable";
        const localRequestCeiling =
            Number.isFinite(maxRequestsArg) && maxRequestsArg > 0
                ? Math.floor(maxRequestsArg)
                : null;
        if (localRequestCeiling) {
            assert(
                fixture.providerRequests.length <= localRequestCeiling,
                `Unexpected total request amplification: ${fixture.providerRequests.length} > ${localRequestCeiling}`
            );
        }
        assert(
            providerRequestPhases.events.lateContent,
            "Fixture did not record the late-content phase boundary"
        );
        if (requiresVnextFeatures) {
            assert(
                providerRequestPhases.events.lateAttributes,
                "Fixture did not record the late-attributes phase boundary"
            );
        }
        assert(
            providerRequestPhases.phases.initial.requests <= 8,
            `Initial document request amplification: ${providerRequestPhases.phases.initial.requests} > 8`
        );
        assert(
            providerRequestPhases.phases["late-content"].requests <= 1,
            `Late-content request amplification: ${providerRequestPhases.phases["late-content"].requests} > 1`
        );
        assert(
            providerRequestPhases.phases["late-attributes"].requests <= 1,
            `Late-attributes request amplification: ${
                providerRequestPhases.phases["late-attributes"].requests
            } > 1; requests=${JSON.stringify(
                providerRequests.slice(
                    Math.max(
                        0,
                        (providerRequestPhases.phases["late-attributes"].requestRange[0] || 1) - 1
                    )
                )
            )}`
        );
        assert(
            providerRequestSummary.recovery.totals.requests === 0,
            `Local fixture unexpectedly used ${providerRequestSummary.recovery.totals.requests} recovery requests`
        );
        assert(translatedItems >= 50, "Fixture did not exercise a meaningful multi-item batch");
        assert(
            translatedItems / fixture.providerRequests.length >= 10,
            "Packets were not compacted enough to prevent request amplification"
        );
        assert(
            pageState.tokens.includes(`${fixture.providerRequests.length} request`),
            `Banner request count is wrong: ${pageState.tokens}`
        );
        if (expectedPipeline) {
            assert(
                observedPipeline === expectedPipeline,
                `Expected ${expectedPipeline} but observed ${observedPipeline}`
            );
        }
        assert(
            fixture.providerRequests.every((body) => {
                const payload = providerPayloadText(body);
                return !payload.includes("<main") && !payload.includes("site-shell");
            }),
            "Provider payload leaked page HTML or CSS classes"
        );
        const result = {
            schemaVersion: "ai-page-browser-smoke-2",
            browser: browserVersion,
            pipeline,
            observedPipeline,
            externalProviderCost: false,
            tokenAccounting: "deterministic-local-stub-estimate",
            stubProvider,
            providerProtocol: stubProviderProtocol(stubProvider),
            observedStubProviders,
            generationRequests: fixture.providerRequests.length,
            translatedItems,
            sourceCharacters,
            averageItemsPerRequest: Number(
                (translatedItems / fixture.providerRequests.length).toFixed(1)
            ),
            providerReportedTokens: fixture.billedTokens(),
            providerPayloadBytes: fixture.providerRequests.reduce(
                (total, body) => total + Buffer.byteLength(JSON.stringify(body)),
                0
            ),
            providerRequestSummary,
            providerRequests,
            providerRequestPhases,
            bannerTokenText: pageState.tokens,
            status: pageState.status,
            progress: pageState.progress,
            spaLateContentTranslated: pageState.late.startsWith("번역 "),
            spaLateAttributesTranslated:
                !requiresVnextFeatures ||
                (pageState.inputPlaceholder.startsWith("번역 ") &&
                    pageState.inputPlaceholder.includes("Find stations") &&
                    pageState.actionAriaLabel.startsWith("번역 ") &&
                    pageState.actionAriaLabel.includes("Review changes")),
            domInvariants: {
                hrefPreserved: true,
                dataAttributePreserved: true,
                inputValuePreserved: true,
                focusPreserved: true,
                selectionPreserved: true,
                listenerPreserved: true,
            },
            runtimeExceptions: [workerClient, pageClient]
                .flatMap((client) => newEvents(client))
                .filter((event) => event.method === "Runtime.exceptionThrown").length,
        };
        assert(result.runtimeExceptions === 0, "Chrome reported runtime exceptions");
        const screenshot = await captureScreenshot(pageClient);
        if (screenshot) result.screenshot = screenshot;
        console.log(JSON.stringify(result, null, 2));
    } finally {
        pageClient?.close();
        workerClient?.close();
        if (chrome && chrome.exitCode === null) {
            chrome.kill("SIGTERM");
            await Promise.race([chromeExit, wait(5000)]);
            if (chrome.exitCode === null) {
                chrome.kill("SIGKILL");
                await Promise.race([chromeExit, wait(2000)]);
            }
        }
        await new Promise((resolve) => fixture.server.close(resolve));
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await fs.rm(profile, { recursive: true, force: true });
                break;
            } catch (error) {
                if (error.code !== "ENOTEMPTY" || attempt === 4) throw error;
                await wait(100 * (attempt + 1));
            }
        }
    }
}

run().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
});
