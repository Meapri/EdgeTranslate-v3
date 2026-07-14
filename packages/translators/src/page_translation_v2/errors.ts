import { ProviderFailure } from "./types";

function messageFromPayload(payload: unknown) {
    if (!payload || typeof payload !== "object")
        return String(payload || "Provider request failed");
    const value = payload as Record<string, any>;
    return String(
        value.error?.message || value.message || value.error || "Provider request failed"
    );
}

function googleErrorDetails(payload: unknown): Record<string, any>[] {
    if (!payload || typeof payload !== "object") return [];
    const details = (payload as Record<string, any>).error?.details;
    return Array.isArray(details)
        ? details.filter(
              (detail): detail is Record<string, any> =>
                  Boolean(detail) && typeof detail === "object" && !Array.isArray(detail)
          )
        : [];
}

function googleDetailType(detail: Record<string, any>) {
    return String(detail["@type"] || detail.type || "");
}

function parseGoogleDurationMs(value: unknown): number | undefined {
    if (typeof value === "string") {
        const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
        if (!match) return undefined;
        const milliseconds = Number(match[1]) * 1000;
        return Number.isFinite(milliseconds) ? Math.round(milliseconds) : undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const duration = value as Record<string, any>;
    const seconds = Number(duration.seconds || 0);
    const nanos = Number(duration.nanos || 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0) {
        return undefined;
    }
    return Math.round(seconds * 1000 + nanos / 1_000_000);
}

function geminiRetryAfterMs(payload: unknown, headerRetryAfterMs?: number) {
    let detailRetryAfterMs: number | undefined;
    for (const detail of googleErrorDetails(payload)) {
        if (!googleDetailType(detail).endsWith("google.rpc.RetryInfo")) continue;
        const parsed = parseGoogleDurationMs(detail.retryDelay);
        if (parsed === undefined) continue;
        detailRetryAfterMs = Math.max(detailRetryAfterMs || 0, parsed);
    }
    if (headerRetryAfterMs === undefined) return detailRetryAfterMs;
    if (detailRetryAfterMs === undefined) return headerRetryAfterMs;
    return Math.max(headerRetryAfterMs, detailRetryAfterMs);
}

function geminiHasSessionPermanentQuota(payload: unknown) {
    for (const detail of googleErrorDetails(payload)) {
        if (!googleDetailType(detail).endsWith("google.rpc.QuotaFailure")) continue;
        const violations = Array.isArray(detail.violations) ? detail.violations : [];
        for (const violation of violations) {
            if (!violation || typeof violation !== "object" || Array.isArray(violation)) continue;
            const value = violation as Record<string, any>;
            const quotaValue = Number(value.quotaValue);
            if (value.quotaValue !== undefined && Number.isFinite(quotaValue) && quotaValue <= 0) {
                return true;
            }
            const quotaIdentity = `${String(value.quotaId || "")} ${String(
                value.quotaMetric || ""
            )}`.toLowerCase();
            if (/(?:per[_ -]?day|daily|\brpd\b|\btpd\b)/.test(quotaIdentity)) return true;
        }
    }
    return false;
}

export function classifyHttpFailure(
    status: number,
    payload: unknown,
    retryAfterMs?: number,
    options: { provider?: "openai" | "gemini" | "compatible" } = {}
): ProviderFailure {
    const message = messageFromPayload(payload);
    const lower = message.toLowerCase();
    if (status === 401 || status === 403) {
        return {
            kind: "auth",
            message,
            retryDirective: "never",
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    // Gemini uses HTTP 429 RESOURCE_EXHAUSTED for both short-window throttling and
    // session-long quota exhaustion. Prefer the structured QuotaFailure/RetryInfo contract;
    // when it is absent, retain the retryable fallback instead of guessing from prose alone.
    if (status === 429 && options.provider === "gemini") {
        if (geminiHasSessionPermanentQuota(payload)) {
            return {
                kind: "quota",
                message,
                retryDirective: "never",
                requestMayHaveExecuted: false,
                httpStatus: status,
            };
        }
        return {
            kind: "rate-limit",
            message,
            retryDirective: "same-units",
            retryAfterMs: geminiRetryAfterMs(payload, retryAfterMs),
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    if (/billing|insufficient[_ -]?quota|quota exhausted/.test(lower)) {
        return {
            kind: "quota",
            message,
            retryDirective: "never",
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    if (status === 429) {
        return {
            kind: "rate-limit",
            message,
            retryDirective: "same-units",
            retryAfterMs,
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    if (/context|input.*too (?:large|long)|maximum context/.test(lower)) {
        return {
            kind: "context-limit",
            message,
            retryDirective: "split",
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    if (
        (status === 400 || status === 422 || status === 404 || status === 405 || status === 501) &&
        /unsupported|unknown (?:field|parameter)|not supported|unrecognized/.test(lower)
    ) {
        return {
            kind: "unsupported-capability",
            message,
            retryDirective: "downgrade",
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    if (status === 404 && /model/.test(lower)) {
        return {
            kind: "model-not-found",
            message,
            retryDirective: "never",
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    if (status === 408) {
        return {
            kind: "timeout",
            message,
            retryDirective: "same-units",
            requestMayHaveExecuted: false,
            httpStatus: status,
        };
    }
    if (status >= 500) {
        return {
            kind: "transient",
            message,
            retryDirective: "same-units",
            requestMayHaveExecuted: status !== 503,
            httpStatus: status,
        };
    }
    return {
        kind: "delivery-unknown",
        message,
        retryDirective: "never",
        requestMayHaveExecuted: false,
        httpStatus: status,
    };
}

export function classifyThrownFailure(error: unknown): ProviderFailure {
    const value = error as { name?: string; message?: string };
    if (value?.name === "AbortError") {
        return {
            kind: "cancelled",
            message: value.message || "Request was cancelled",
            retryDirective: "never",
            requestMayHaveExecuted: true,
        };
    }
    if (
        value?.name === "TypeError" ||
        /network|fetch|socket|connection|econn|timed?\s*out/i.test(value?.message || "")
    ) {
        return {
            kind: "transient",
            message: value?.message || "Network request failed",
            retryDirective: "same-units",
            requestMayHaveExecuted: true,
        };
    }
    return {
        kind: "delivery-unknown",
        message: value?.message || String(error || "Network request failed"),
        retryDirective: "never",
        requestMayHaveExecuted: true,
    };
}

export function parseRetryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
