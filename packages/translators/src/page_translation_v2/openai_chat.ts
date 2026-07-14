import {
    FetchLike,
    ProviderAttemptResult,
    ProviderCapabilities,
    ProviderProfile,
    TranslationBatchRequest,
    TranslationProviderAdapter,
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
import { normalizeOpenAIChatUsage } from "./usage";
import { prepareTranslationWire } from "./wire";

// Small local models under-provision structured output badly below this; the effective
// output ceiling sent to a compatible server is floored here (spec §1.2).
const COMPAT_OUTPUT_TOKEN_FLOOR = 1024;

// Tolerant reply extraction for compatible servers (lineage: local.ts page-mode parse).
// Strict schema enforcement is not available on prompt-json servers, so transport wrappers
// are peeled before JSON parsing: markdown code fences and complete leading <think> blocks.
// A reply still inside an unterminated <think> block has no trustworthy payload yet.
function tolerantReplyText(raw: unknown): string {
    let cleaned = String(raw ?? "")
        .trim()
        .replace(/^(?:\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*)+/i, "");
    if (/^\s*<think(?:ing)?>/i.test(cleaned)) return "";
    cleaned = cleaned
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/i, "");
    return cleaned.trim();
}

export class OpenAIChatCompatibleAdapter implements TranslationProviderAdapter {
    readonly protocol = "openai-chat" as const;

    constructor(private readonly fetchImpl: FetchLike = defaultFetch()) {}

    async discover(profile: ProviderProfile, _signal: AbortSignal): Promise<ProviderCapabilities> {
        return fallbackCapabilities(profile, {
            input: 4096,
            output: 1024,
            structured: "prompt-json",
            tokenCounting: "local-estimate",
            reasoningRelation: "subset-of-output",
        });
    }

    private buildBody(profile: ProviderProfile, request: TranslationBatchRequest) {
        const wire = prepareTranslationWire(request);
        const body: Record<string, unknown> = {
            model: profile.modelId,
            messages: [
                { role: "system", content: wire.systemPrompt },
                { role: "user", content: wire.userText },
            ],
            // Compat suppression/caching trio (spec §1.2). llama.cpp honors cache_prompt —
            // the byte-identical system+ctx prefix lets it reuse KV state; Qwen-style
            // servers read enable_thinking from chat_template_kwargs; reasoning_effort
            // covers servers exposing the OpenAI knob. Unknown servers ignore unknown
            // fields, and any leaked <think> is still stripped by the tolerant parse.
            cache_prompt: true,
            chat_template_kwargs: { enable_thinking: false },
            reasoning_effort:
                profile.reasoningControl === "effort" && typeof profile.reasoningValue === "string"
                    ? profile.reasoningValue
                    : "low",
        };
        if (profile.structuredOutput === "json-schema") {
            body.response_format = {
                type: "json_schema",
                json_schema: {
                    name: "page_translation_reply",
                    strict: true,
                    schema: wire.schema,
                },
            };
        } else if (profile.structuredOutput === "json-object") {
            body.response_format = { type: "json_object" };
        }
        // gpt-5-family chat endpoints reject max_tokens in favor of max_completion_tokens.
        const field =
            profile.outputLimitField ||
            (/^gpt-5/i.test(profile.modelId) ? "max_completion_tokens" : "max_tokens");
        if (field !== "omit") {
            body[field] = Math.max(COMPAT_OUTPUT_TOKEN_FLOOR, request.maxOutputTokens);
        }
        if (profile.temperatureSupported === true) body.temperature = 0;
        return { body, wire };
    }

    async executeOnce(
        profile: ProviderProfile,
        request: TranslationBatchRequest,
        signal: AbortSignal
    ): Promise<ProviderAttemptResult> {
        const startedAt = Date.now();
        const attemptId = nextAttemptId(request.requestId);
        const base = normalizedBaseUrl(profile.baseUrl, "http://localhost:8000/v1");
        const { body, wire } = this.buildBody(profile, request);
        try {
            const response = await this.fetchImpl(`${base}/chat/completions`, {
                method: "POST",
                headers: requestHeaders(
                    profile,
                    profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}
                ),
                body: JSON.stringify(body),
                signal,
            });
            const payload = await readJson(response);
            const providerId = providerRequestId(response, payload);
            const finishReason = payload.choices?.[0]?.finish_reason;
            const attempt = attemptSummary(attemptId, startedAt, {
                providerRequestId: providerId,
                httpStatus: response.status,
                finishReason,
            });
            const usage = normalizeOpenAIChatUsage(payload.usage, {
                requestId: request.requestId,
                attemptId,
                providerRequestId: providerId,
            });
            const usageReceipts = usage ? [usage] : [];
            if (!response.ok) {
                return {
                    ok: false,
                    failure: classifyHttpFailure(
                        response.status,
                        payload,
                        parseRetryAfterMs(response.headers.get("retry-after"))
                    ),
                    partialItems: [],
                    usageReceipts,
                    attempt,
                };
            }
            if (finishReason === "content_filter") {
                return {
                    ok: false,
                    failure: {
                        kind: "content-filter",
                        message: "Chat-compatible provider blocked the packet",
                        retryDirective: "split",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: [],
                    usageReceipts,
                    attempt,
                };
            }
            const text = tolerantReplyText(payload.choices?.[0]?.message?.content);
            if (finishReason === "length") {
                const partial = schemaFailure(wire, text, usageReceipts, attempt);
                return {
                    ok: false,
                    failure: {
                        kind: "output-limit",
                        message: "Chat-compatible provider reached its output limit",
                        retryDirective: "split",
                        requestMayHaveExecuted: true,
                    },
                    partialItems: partial.ok ? partial.items : partial.partialItems,
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
