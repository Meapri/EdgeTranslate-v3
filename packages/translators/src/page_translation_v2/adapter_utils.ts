import {
    AttemptSummary,
    FetchLike,
    ProviderAttemptResult,
    ProviderCapabilities,
    ProviderFailure,
    ProviderProfile,
    UsageReceipt,
} from "./types";
import { parseTranslationWire, PreparedTranslationWire } from "./wire";

let attemptSequence = 0;

export function nextAttemptId(requestId: string) {
    attemptSequence += 1;
    return `${requestId}:a${attemptSequence}`;
}

export function normalizedBaseUrl(value: string | undefined, fallback: string) {
    return String(value || fallback).replace(/\/+$/, "");
}

export function requestHeaders(
    profile: ProviderProfile,
    authorization: Record<string, string>
): Record<string, string> {
    return {
        "Content-Type": "application/json",
        ...authorization,
        ...(profile.extraHeaders || {}),
    };
}

export async function readJson(response: Response): Promise<Record<string, any>> {
    try {
        return (await response.json()) as Record<string, any>;
    } catch {
        return {};
    }
}

export function providerRequestId(response: Response, payload: Record<string, any>) {
    return (
        response.headers.get("x-request-id") ||
        response.headers.get("x-goog-request-id") ||
        payload.id ||
        payload.responseId ||
        undefined
    );
}

export function attemptSummary(
    attemptId: string,
    startedAt: number,
    details: Partial<AttemptSummary> = {}
): AttemptSummary {
    return { attemptId, startedAt, finishedAt: Date.now(), ...details };
}

export function schemaFailure(
    wire: PreparedTranslationWire,
    rawText: string,
    usageReceipts: UsageReceipt[],
    attempt: AttemptSummary
): ProviderAttemptResult {
    const parsed = parseTranslationWire(rawText, wire);
    if (parsed.ok) return { ok: true, items: parsed.items, usageReceipts, attempt };
    const failure: ProviderFailure = {
        kind: "schema-invalid",
        message: parsed.errors.join(", ") || "Structured translation output was incomplete",
        retryDirective: "split",
        requestMayHaveExecuted: true,
    };
    // Positional legacy arrays cannot safely preserve partial output. ID-addressed legacy and
    // pt3 packets can retain uniquely mapped siblings for unresolved-only recovery.
    const partialItems =
        wire.wireProtocol === "legacy-v2" && wire.outputProtocol !== "id-object"
            ? []
            : parsed.items;
    return { ok: false, failure, partialItems, usageReceipts, attempt };
}

export function fallbackCapabilities(
    profile: ProviderProfile,
    defaults: {
        input: number;
        output: number;
        structured: "json-schema" | "json-object" | "prompt-json";
        tokenCounting: "remote-exact" | "local-estimate" | "none";
        reasoningRelation: "subset-of-output" | "additional-to-output" | "unknown";
    }
): ProviderCapabilities {
    const now = Date.now();
    const observed = <T>(value: T | null, source: "profile-override" | "fallback-policy") => ({
        value,
        source,
        observedAt: now,
    });
    return {
        revision: `${profile.revision}:${profile.protocol}:${profile.modelId}`,
        protocol: profile.protocol,
        modelId: profile.modelId,
        structuredOutput: observed(
            [profile.structuredOutput || defaults.structured],
            profile.structuredOutput ? "profile-override" : "fallback-policy"
        ),
        maxInputTokens: observed(
            profile.maxInputTokens || defaults.input,
            profile.maxInputTokens ? "profile-override" : "fallback-policy"
        ),
        maxOutputTokens: observed(
            profile.maxOutputTokens || defaults.output,
            profile.maxOutputTokens ? "profile-override" : "fallback-policy"
        ),
        maxCombinedTokens: observed(
            profile.maxCombinedTokens || null,
            profile.maxCombinedTokens ? "profile-override" : "fallback-policy"
        ),
        tokenCounting: observed(defaults.tokenCounting, "fallback-policy"),
        reasoningControl: observed(
            profile.reasoningControl || "none",
            profile.reasoningControl ? "profile-override" : "fallback-policy"
        ),
        temperatureSupported: observed(
            profile.temperatureSupported ?? false,
            profile.temperatureSupported !== undefined ? "profile-override" : "fallback-policy"
        ),
        usageMode: observed("final-absolute", "fallback-policy"),
        reasoningRelation: observed(defaults.reasoningRelation, "fallback-policy"),
    };
}

export function defaultFetch(): FetchLike {
    return (input, init) => fetch(input, init);
}
