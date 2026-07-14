import {
    FetchLike,
    Observed,
    ProviderAttemptResult,
    ProviderCapabilities,
    ProviderFailure,
    ProviderProfile,
    TokenCountEvidence,
    TranslationBatchRequest,
    TranslationProviderAdapter,
    UsageReceipt,
} from "./types";
import {
    attemptSummary,
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
import { normalizeOpenAIResponsesUsage } from "./usage";
import { prepareTranslationWire } from "./wire";

// Fallback capability floors, provenance "fallback-policy" — deliberately conservative
// LOWER BOUNDS, not model metadata. OpenAI exposes no capability endpoint, so the real
// window is learned at runtime: the /responses/input_tokens preflight (countInput) counts
// assembled payloads exactly, and calibrateOpenAIResponsesCapabilities raises these floors
// from observed usage receipts. Planner delivery ceilings stay decoupled (spec §2.4).
const OPENAI_RESPONSES_FALLBACK_CAPS = {
    input: 8192,
    output: 2048,
    structured: "json-schema",
    tokenCounting: "remote-exact",
    reasoningRelation: "subset-of-output",
} as const;

/**
 * Calibration hook for the fallback capability floors: a settled usage receipt proves the
 * model accepted at least that many input tokens and emitted at least that many output
 * tokens. Only fallback-policy values are ever raised — profile overrides and provider
 * metadata stay authoritative.
 */
export function calibrateOpenAIResponsesCapabilities(
    capabilities: ProviderCapabilities,
    receipt: UsageReceipt
): ProviderCapabilities {
    const now = Date.now();
    const raise = (field: Observed<number>, observed?: number): Observed<number> =>
        observed !== undefined &&
        field.source === "fallback-policy" &&
        observed > (field.value ?? 0)
            ? {
                  value: observed,
                  source: "runtime-observation",
                  observedAt: now,
                  evidence: receipt.billingEventId,
              }
            : field;
    return {
        ...capabilities,
        maxInputTokens: raise(capabilities.maxInputTokens, receipt.inputTokens?.value),
        maxOutputTokens: raise(capabilities.maxOutputTokens, receipt.outputTokens?.value),
    };
}

// Reasoning-effort suppression ladder pinned per model family: hidden thought is pure
// latency/token waste for translation. gpt-5.1+ accepts "none", first-generation gpt-5
// floors at "minimal", gpt-5*-pro mandates "high", o-series floors at "low". Non-reasoning
// models get no parameter at all so they never see an unsupported field; if a model still
// rejects it, executeOnce surfaces a downgrade directive with a reasoningControl:"none"
// capability patch and the scheduler owns the drop-and-retry.
function defaultReasoningEffort(modelId: string): string | undefined {
    if (!/^(?:gpt-5|o[1-9])/i.test(modelId) || /chat-latest/i.test(modelId)) return undefined;
    if (/^gpt-5(?:\.\d+)?-pro(?:$|-)/i.test(modelId)) return "high";
    if (/^gpt-5\.(?:[1-9]|\d{2,})(?:$|-)/i.test(modelId)) return "none";
    if (/^gpt-5/i.test(modelId)) return "minimal";
    return "low";
}

function extractResponseText(payload: Record<string, any>) {
    if (typeof payload.output_text === "string") return payload.output_text;
    const parts: string[] = [];
    for (const item of payload.output || []) {
        for (const content of item?.content || []) {
            if (content?.type === "output_text" && typeof content.text === "string") {
                parts.push(content.text);
            }
        }
    }
    return parts.join("");
}

function hasRefusal(payload: Record<string, any>) {
    return (payload.output || []).some((item: any) =>
        (item?.content || []).some((content: any) => content?.type === "refusal")
    );
}

function classifyResponseStatusFailure(
    payload: Record<string, any>,
    retryAfterMs?: number
): ProviderFailure {
    const status = String(payload.status || "");
    const code = String(payload.error?.code || "").toLowerCase();
    const message = String(
        payload.error?.message || `OpenAI response did not complete: ${status || "missing-status"}`
    );
    if (status === "cancelled") {
        return {
            kind: "cancelled",
            message,
            retryDirective: "never",
            requestMayHaveExecuted: true,
        };
    }
    if (status === "queued" || status === "in_progress") {
        return {
            kind: "delivery-unknown",
            message,
            // Reissuing a generation here can double bill. This synchronous integration does
            // not opt into background mode, so an unexpected non-terminal response is retained
            // as an unresolved original rather than regenerated blindly.
            retryDirective: "never",
            requestMayHaveExecuted: true,
        };
    }
    if (status === "failed") {
        if (code === "rate_limit_exceeded") {
            return {
                kind: "rate-limit",
                message,
                retryDirective: "same-units",
                retryAfterMs,
                requestMayHaveExecuted: true,
            };
        }
        if (code === "server_error") {
            return {
                kind: "transient",
                message,
                retryDirective: "same-units",
                requestMayHaveExecuted: true,
            };
        }
        if (code.includes("content_filter") || code.includes("policy")) {
            return {
                kind: "content-filter",
                message,
                retryDirective: "split",
                requestMayHaveExecuted: true,
            };
        }
        if (code === "invalid_prompt") {
            return {
                kind: "unsupported-capability",
                message,
                retryDirective: "never",
                requestMayHaveExecuted: true,
            };
        }
    }
    return {
        kind: "provider-status",
        message,
        retryDirective: "never",
        requestMayHaveExecuted: true,
    };
}

export class OpenAIResponsesAdapter implements TranslationProviderAdapter {
    readonly protocol = "openai-responses" as const;

    constructor(private readonly fetchImpl: FetchLike = defaultFetch()) {}

    async discover(profile: ProviderProfile, _signal: AbortSignal): Promise<ProviderCapabilities> {
        return fallbackCapabilities(profile, OPENAI_RESPONSES_FALLBACK_CAPS);
    }

    private buildBody(profile: ProviderProfile, request: TranslationBatchRequest) {
        const wire = prepareTranslationWire(request);
        const body: Record<string, unknown> = {
            model: profile.modelId,
            instructions: wire.systemPrompt,
            input: wire.userText,
            text: {
                format: {
                    type: "json_schema",
                    name: "page_translation_reply",
                    strict: true,
                    schema: wire.schema,
                },
            },
            max_output_tokens: request.maxOutputTokens,
            truncation: "disabled",
        };
        if (profile.temperatureSupported === true) body.temperature = 0;
        const effort =
            profile.reasoningControl === "effort" && typeof profile.reasoningValue === "string"
                ? profile.reasoningValue
                : profile.reasoningControl === undefined
                ? defaultReasoningEffort(profile.modelId)
                : undefined;
        if (effort) body.reasoning = { effort };
        return { body, wire };
    }

    async countInput(
        profile: ProviderProfile,
        request: TranslationBatchRequest,
        signal: AbortSignal
    ): Promise<TokenCountEvidence> {
        const base = normalizedBaseUrl(profile.baseUrl, "https://api.openai.com/v1");
        const { body } = this.buildBody(profile, request);
        // The input-token endpoint accepts the input/instructions/schema contract but rejects
        // generation-only output controls such as max_output_tokens.
        const { max_output_tokens: _maxOutputTokens, ...countBody } = body;
        const response = await this.fetchImpl(`${base}/responses/input_tokens`, {
            method: "POST",
            headers: requestHeaders(profile, { Authorization: `Bearer ${profile.apiKey}` }),
            body: JSON.stringify(countBody),
            signal,
        });
        const payload = await readJson(response);
        if (!response.ok) throw new Error(`OpenAI input token count failed: ${response.status}`);
        const tokens = Number(payload.input_tokens);
        if (!Number.isFinite(tokens)) throw new Error("OpenAI input token count was missing");
        return { tokens, source: "provider-counted" };
    }

    async executeOnce(
        profile: ProviderProfile,
        request: TranslationBatchRequest,
        signal: AbortSignal
    ): Promise<ProviderAttemptResult> {
        const startedAt = Date.now();
        const attemptId = nextAttemptId(request.requestId);
        const base = normalizedBaseUrl(profile.baseUrl, "https://api.openai.com/v1");
        const { body, wire } = this.buildBody(profile, request);
        try {
            const response = await this.fetchImpl(`${base}/responses`, {
                method: "POST",
                headers: requestHeaders(profile, { Authorization: `Bearer ${profile.apiKey}` }),
                body: JSON.stringify(body),
                signal,
            });
            const payload = await readJson(response);
            const providerId = providerRequestId(response, payload);
            const finishReason = payload.incomplete_details?.reason || payload.status;
            const attempt = attemptSummary(attemptId, startedAt, {
                providerRequestId: providerId,
                httpStatus: response.status,
                finishReason,
            });
            const usage = normalizeOpenAIResponsesUsage(payload.usage, {
                requestId: request.requestId,
                attemptId,
                providerRequestId: providerId,
            });
            const usageReceipts = usage ? [usage] : [];
            if (!response.ok) {
                const failure = classifyHttpFailure(
                    response.status,
                    payload,
                    parseRetryAfterMs(response.headers.get("retry-after"))
                );
                // Reasoning-effort drop-and-retry: when the suppression parameter itself is
                // what the model rejected, hand the scheduler a capability patch so its one
                // downgrade retry re-dispatches without the reasoning field. The adapter
                // never issues the second request itself — executeOnce stays exactly once.
                if (
                    failure.kind === "unsupported-capability" &&
                    body.reasoning !== undefined &&
                    /reasoning/i.test(failure.message)
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
            if (hasRefusal(payload)) {
                return {
                    ok: false,
                    failure: {
                        kind: "content-filter",
                        message: "OpenAI refused the page translation packet",
                        // One bounded split can isolate a blocked source string without losing
                        // otherwise safe siblings. The scheduler never retries a singleton loop.
                        retryDirective: "split",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: [],
                    usageReceipts,
                    attempt,
                };
            }
            const text = extractResponseText(payload);
            if (payload.status === "incomplete") {
                if (payload.incomplete_details?.reason === "content_filter") {
                    return {
                        ok: false,
                        failure: {
                            kind: "content-filter",
                            message: "OpenAI stopped the packet because of a content filter",
                            retryDirective: "split",
                            requestMayHaveExecuted: true,
                        },
                        partialItems: [],
                        usageReceipts,
                        attempt,
                    };
                }
                const partial = schemaFailure(wire, text, usageReceipts, attempt);
                return {
                    ok: false,
                    failure: {
                        kind:
                            payload.incomplete_details?.reason === "max_output_tokens"
                                ? "output-limit"
                                : "provider-status",
                        message: `OpenAI response was incomplete: ${finishReason || "unknown"}`,
                        retryDirective:
                            payload.incomplete_details?.reason === "max_output_tokens"
                                ? "split"
                                : "never",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: partial.ok ? partial.items : partial.partialItems,
                    usageReceipts,
                    attempt,
                };
            }
            // A 2xx HTTP response is not itself a completed generation. Responses can return
            // terminal/non-terminal status objects, and only `completed` is safe to parse and
            // commit. Missing status is treated as an abnormal provider response as well.
            if (payload.status !== "completed") {
                return {
                    ok: false,
                    failure: classifyResponseStatusFailure(
                        payload,
                        parseRetryAfterMs(response.headers.get("retry-after"))
                    ),
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
                partialItems: [],
                usageReceipts: [],
                attempt: attemptSummary(attemptId, startedAt),
            };
        }
    }
}
