import {
    FetchLike,
    ProviderAttemptResult,
    ProviderCapabilities,
    ProviderProfile,
    TokenCountEvidence,
    TranslationBatchRequest,
    TranslationProviderAdapter,
} from "./types";
import {
    attemptSummary,
    consumeSse,
    defaultFetch,
    fallbackCapabilities,
    nextAttemptId,
    normalizedBaseUrl,
    providerRequestId,
    readJson,
    requestHeaders,
    schemaFailure,
} from "./adapter_utils";
import { classifyHttpFailure, classifyThrownFailure, parseRetryAfterMs } from "./errors";
import { normalizeGeminiUsage } from "./usage";
import { parsePageTranslationProgress, prepareTranslationWire } from "./wire";

function normalizedModelId(modelId: string) {
    return modelId.replace(/^models\//, "");
}

// gemini-3* families misbehave with an explicit output ceiling on structured replies;
// the packet planner's output-token sizing (spec §2.4) is the real bound there.
function omitsOutputLimit(modelId: string) {
    return /^gemini-3(?:\.|-|$)/i.test(modelId);
}

// Family-aware reasoning floor from the GenerateContent thinking contract. Gemini 3 uses
// thinkingLevel (3 Pro cannot use `minimal`; 3 Flash/Flash-Lite cannot be fully disabled).
// Gemini 2.5 uses thinkingBudget (Pro's minimum is 128, Flash families allow zero). Unknown
// and non-thinking models receive no field: guessing a control is more likely to cause a 400
// than to save tokens. An explicit profile reasoningControl always wins.
function defaultThinkingConfig(modelId: string): Record<string, unknown> | undefined {
    const model = normalizedModelId(modelId);
    if (/^gemini-3(?:\.\d+)?-pro(?:$|-)/i.test(model)) {
        return { thinkingLevel: "low" };
    }
    if (/^gemini-3(?:\.\d+)?-(?:flash|flash-lite)(?:$|-)/i.test(model)) {
        return { thinkingLevel: "minimal" };
    }
    if (/^gemini-2\.5-pro(?:$|-)/i.test(model)) {
        return { thinkingBudget: 128 };
    }
    if (/^gemini-2\.5-(?:flash|flash-lite)(?:$|-)/i.test(model)) {
        return { thinkingBudget: 0 };
    }
    return undefined;
}

function extractGeminiText(payload: Record<string, any>) {
    return (payload.candidates?.[0]?.content?.parts || [])
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
}

const GEMINI_CONTENT_FILTER_REASONS = new Set([
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_RECITATION",
]);

export class GeminiGenerateContentAdapter implements TranslationProviderAdapter {
    readonly protocol = "gemini-generate-content" as const;

    constructor(private readonly fetchImpl: FetchLike = defaultFetch()) {}

    async discover(profile: ProviderProfile, signal: AbortSignal): Promise<ProviderCapabilities> {
        const fallback = fallbackCapabilities(profile, {
            input: 8192,
            output: 2048,
            structured: "json-schema",
            tokenCounting: "remote-exact",
            reasoningRelation: "additional-to-output",
        });
        const base = normalizedBaseUrl(
            profile.baseUrl,
            "https://generativelanguage.googleapis.com/v1beta"
        );
        try {
            const response = await this.fetchImpl(
                `${base}/models/${encodeURIComponent(normalizedModelId(profile.modelId))}`,
                {
                    headers: requestHeaders(profile, { "x-goog-api-key": profile.apiKey }),
                    signal,
                }
            );
            const payload = await readJson(response);
            if (!response.ok) return fallback;
            const now = Date.now();
            const input = Number(payload.inputTokenLimit);
            const output = Number(payload.outputTokenLimit);
            if (Number.isFinite(input) && input > 0 && !profile.maxInputTokens) {
                fallback.maxInputTokens = {
                    value: input,
                    source: "provider-metadata",
                    observedAt: now,
                };
            }
            if (Number.isFinite(output) && output > 0 && !profile.maxOutputTokens) {
                fallback.maxOutputTokens = {
                    value: output,
                    source: "provider-metadata",
                    observedAt: now,
                };
            }
            fallback.revision = `${fallback.revision}:${payload.version || "metadata"}`;
            return fallback;
        } catch {
            return fallback;
        }
    }

    private buildGenerateContentRequest(
        profile: ProviderProfile,
        request: TranslationBatchRequest
    ) {
        const wire = prepareTranslationWire(request);
        const model = normalizedModelId(profile.modelId);
        const generationConfig: Record<string, unknown> = {
            responseMimeType: "application/json",
            responseJsonSchema: wire.schema,
        };
        if (!omitsOutputLimit(model)) generationConfig.maxOutputTokens = request.maxOutputTokens;
        // Google recommends leaving Gemini 3.x sampling controls at their optimized defaults.
        if (profile.temperatureSupported === true && !/^gemini-3(?:\.|-|$)/i.test(model)) {
            generationConfig.temperature = 0;
        }
        if (profile.reasoningControl === "thinking-config") {
            if (typeof profile.reasoningValue === "number") {
                generationConfig.thinkingConfig = { thinkingBudget: profile.reasoningValue };
            } else if (typeof profile.reasoningValue === "string") {
                generationConfig.thinkingConfig = { thinkingLevel: profile.reasoningValue };
            }
        } else if (profile.reasoningControl === undefined) {
            const defaultConfig = defaultThinkingConfig(model);
            if (defaultConfig) generationConfig.thinkingConfig = defaultConfig;
        }
        return {
            body: {
                systemInstruction: { parts: [{ text: wire.systemPrompt }] },
                contents: [{ role: "user", parts: [{ text: wire.userText }] }],
                generationConfig,
            },
            wire,
        };
    }

    async countInput(
        profile: ProviderProfile,
        request: TranslationBatchRequest,
        signal: AbortSignal
    ): Promise<TokenCountEvidence> {
        const base = normalizedBaseUrl(
            profile.baseUrl,
            "https://generativelanguage.googleapis.com/v1beta"
        );
        const model = normalizedModelId(profile.modelId);
        const { body } = this.buildGenerateContentRequest(profile, request);
        const response = await this.fetchImpl(
            `${base}/models/${encodeURIComponent(model)}:countTokens`,
            {
                method: "POST",
                headers: requestHeaders(profile, { "x-goog-api-key": profile.apiKey }),
                body: JSON.stringify({
                    generateContentRequest: { model: `models/${model}`, ...body },
                }),
                signal,
            }
        );
        const payload = await readJson(response);
        if (!response.ok) throw new Error(`Gemini token count failed: ${response.status}`);
        const tokens = Number(payload.totalTokens);
        if (!Number.isFinite(tokens)) throw new Error("Gemini token count was missing");
        return { tokens, source: "provider-counted" };
    }

    async executeOnce(
        profile: ProviderProfile,
        request: TranslationBatchRequest,
        signal: AbortSignal
    ): Promise<ProviderAttemptResult> {
        const startedAt = Date.now();
        const attemptId = nextAttemptId(request.requestId);
        const base = normalizedBaseUrl(
            profile.baseUrl,
            "https://generativelanguage.googleapis.com/v1beta"
        );
        const model = normalizedModelId(profile.modelId);
        const { body, wire } = this.buildGenerateContentRequest(profile, request);
        const streaming = typeof request.onProgress === "function";
        let streamedText = "";
        try {
            const response = await this.fetchImpl(
                `${base}/models/${encodeURIComponent(model)}:${
                    streaming ? "streamGenerateContent?alt=sse" : "generateContent"
                }`,
                {
                    method: "POST",
                    headers: requestHeaders(profile, {
                        "x-goog-api-key": profile.apiKey,
                        ...(streaming ? { Accept: "text/event-stream" } : {}),
                    }),
                    body: JSON.stringify(body),
                    signal,
                }
            );
            let payload: Record<string, any>;
            if (!streaming || !response.ok) {
                payload = await readJson(response);
            } else {
                let lastPayload: Record<string, any> = {};
                let lastCandidate: Record<string, any> = {};
                let usageMetadata: Record<string, any> | undefined;
                await consumeSse(response, (data) => {
                    let event: Record<string, any>;
                    try {
                        event = JSON.parse(data);
                    } catch {
                        return;
                    }
                    lastPayload = event;
                    const candidate = event.candidates?.[0];
                    if (candidate) {
                        lastCandidate = candidate;
                        streamedText += extractGeminiText(event);
                    }
                    if (event.usageMetadata) usageMetadata = event.usageMetadata;
                    const items = parsePageTranslationProgress(streamedText, wire);
                    if (items.length) {
                        try {
                            request.onProgress?.(items);
                        } catch {
                            /* presentation progress is best-effort */
                        }
                    }
                });
                payload = {
                    ...lastPayload,
                    candidates: [
                        {
                            ...lastCandidate,
                            content: { role: "model", parts: [{ text: streamedText }] },
                        },
                    ],
                    ...(usageMetadata ? { usageMetadata } : {}),
                };
            }
            const providerId = providerRequestId(response, payload);
            const finishReason =
                payload.candidates?.[0]?.finishReason || payload.promptFeedback?.blockReason;
            const attempt = attemptSummary(attemptId, startedAt, {
                providerRequestId: providerId,
                httpStatus: response.status,
                finishReason,
            });
            const usage = normalizeGeminiUsage(payload.usageMetadata, {
                requestId: request.requestId,
                attemptId,
                providerRequestId: providerId,
            });
            const usageReceipts = usage ? [usage] : [];
            if (!response.ok) {
                const failure = classifyHttpFailure(
                    response.status,
                    payload,
                    parseRetryAfterMs(response.headers.get("retry-after")),
                    { provider: "gemini" }
                );
                // Match the OpenAI capability downgrade contract: if a model rejects only the
                // latency-saving thinking field, let the scheduler retry the unresolved items
                // once without that field. The adapter itself still executes exactly once.
                if (
                    failure.kind === "unsupported-capability" &&
                    body.generationConfig.thinkingConfig !== undefined &&
                    /thinking/i.test(failure.message)
                ) {
                    failure.capabilityPatch = {
                        reasoningControl: {
                            value: "none",
                            source: "runtime-observation",
                            observedAt: Date.now(),
                            evidence: failure.message,
                        },
                    };
                }
                return {
                    ok: false,
                    failure,
                    partialItems: [],
                    usageReceipts,
                    attempt,
                };
            }
            if (
                payload.promptFeedback?.blockReason ||
                GEMINI_CONTENT_FILTER_REASONS.has(finishReason)
            ) {
                return {
                    ok: false,
                    failure: {
                        kind: "content-filter",
                        message: `Gemini blocked the packet: ${finishReason || "unknown"}`,
                        retryDirective: "split",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: [],
                    usageReceipts,
                    attempt,
                };
            }
            const text = extractGeminiText(payload);
            if (finishReason === "MAX_TOKENS") {
                const partial = schemaFailure(wire, text, usageReceipts, attempt);
                return {
                    ok: false,
                    failure: {
                        kind: "output-limit",
                        message: "Gemini reached its output limit",
                        retryDirective: "split",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: partial.ok ? partial.items : partial.partialItems,
                    usageReceipts,
                    attempt,
                };
            }
            if (finishReason === "MALFORMED_RESPONSE") {
                return {
                    ok: false,
                    failure: {
                        kind: "schema-invalid",
                        message: "Gemini returned a malformed structured response",
                        retryDirective: "split",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: [],
                    usageReceipts,
                    attempt,
                };
            }
            // A final GenerateContent response is only committable after an explicit STOP.
            // Missing finishReason means generation has not been proven to have terminated.
            if (finishReason !== "STOP") {
                return {
                    ok: false,
                    failure: {
                        kind: "provider-status",
                        message: `Gemini did not complete the packet: ${
                            finishReason || "missing-finish-reason"
                        }`,
                        retryDirective: "same-units",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: [],
                    usageReceipts,
                    attempt,
                };
            }
            return schemaFailure(wire, text, usageReceipts, attempt);
        } catch (error) {
            return {
                ok: false,
                failure: classifyThrownFailure(error),
                partialItems: parsePageTranslationProgress(streamedText, wire),
                usageReceipts: [],
                attempt: attemptSummary(attemptId, startedAt),
            };
        }
    }
}
