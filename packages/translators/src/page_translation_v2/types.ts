export type ProviderProtocol = "openai-responses" | "openai-chat" | "gemini-generate-content";

/**
 * The provider adapters serve two page-translation clients during the vNext rollout.
 * `legacy-v2` preserves the shipping stable/V2 prompt and output envelopes; `pt3` is the
 * block/placeholder protocol used only by vNext. The selection belongs to each request,
 * never to a mutable adapter singleton.
 */
export type PageTranslationWireProtocol = "legacy-v2" | "pt3";

/**
 * Packet-scoped recovery hints arrive across an untrusted extension-message boundary. The
 * pt3 wire maps only these fixed values to trusted provider directives; arbitrary strings are
 * ignored. `capability-drop-reasoning` is consumed by the background transport and never
 * becomes provider text.
 */
export type PageTranslationHint =
    | "reinforced-schema"
    | "reinforced-inventory"
    | "reinforced-order"
    | "reinforced-atomic"
    | "reinforced-semantic"
    | "capability-drop-reasoning";

export type PageOutputProtocol = "array-fixed" | "array-exact" | "id-object";

/**
 * Sparse wire role codes (spec §1.2). "p" (paragraph) is the default and is omitted on the
 * wire; everything else rides in the optional "r" field.
 */
export type PageTranslationRole = "p" | "h" | "li" | "cell" | "alt" | "ph" | "aria" | "val";

/** One request item on the pt3 wire: packet-local base36 alias, source text, sparse role. */
export type PageTranslationItem = {
    i: string;
    s: string;
    r?: PageTranslationRole;
};

/** [sourceTerm, targetTerm] glossary pin; the model must use the target term exactly. */
export type PageTranslationGlossEntry = [string, string];

/**
 * Session-frozen page context (spec §5.1). Built once at session start and serialized
 * byte-identically as the first block of every packet's user message.
 */
export type PageTranslationCtx = {
    title?: string;
    domain?: string;
    gloss?: PageTranslationGlossEntry[];
};

/**
 * One reply item. `t === "="` is the keep-source sentinel: the model asserts the source is
 * already entirely in the target language. Clients MUST identity-verify the claim before
 * acceptance; sentinel resolutions are session-only and never persisted (spec §1.2).
 */
export type PageTranslationReplyItem = {
    i: string;
    t: string;
};

export type PageTranslationReply = {
    x: PageTranslationReplyItem[];
};

export type CapabilitySource =
    | "profile-override"
    | "provider-metadata"
    | "runtime-probe"
    | "runtime-observation"
    | "fallback-policy";

export type Observed<T> = {
    value: T | null;
    source: CapabilitySource;
    observedAt: number;
    expiresAt?: number;
    evidence?: string;
};

export type ProviderCapabilities = {
    revision: string;
    protocol: ProviderProtocol;
    modelId: string;
    structuredOutput: Observed<Array<"json-schema" | "json-object" | "prompt-json">>;
    maxInputTokens: Observed<number>;
    maxOutputTokens: Observed<number>;
    maxCombinedTokens: Observed<number>;
    tokenCounting: Observed<"remote-exact" | "local-estimate" | "none">;
    reasoningControl: Observed<"effort" | "thinking-config" | "none">;
    temperatureSupported: Observed<boolean>;
    usageMode: Observed<"final-absolute" | "cumulative" | "delta" | "none">;
    reasoningRelation: Observed<"subset-of-output" | "additional-to-output" | "unknown">;
};

export type ProviderProfile = {
    id: string;
    revision: string;
    protocol: ProviderProtocol;
    modelId: string;
    apiKey: string;
    baseUrl?: string;
    apiVersion?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxCombinedTokens?: number;
    structuredOutput?: "json-schema" | "json-object" | "prompt-json";
    temperatureSupported?: boolean;
    reasoningControl?: "effort" | "thinking-config" | "none";
    reasoningValue?: string | number;
    outputLimitField?:
        | "max_output_tokens"
        | "max_completion_tokens"
        | "max_tokens"
        | "maxOutputTokens"
        | "omit";
    extraHeaders?: Record<string, string>;
    timeoutMs?: number;
};

export type TranslationBatchItem = {
    id: string;
    text: string;
    role?: string;
    context?: Record<string, unknown>;
};

export type TranslationBatchRequest = {
    requestId: string;
    sessionId: string;
    sourceLanguage: string;
    targetLanguage: string;
    /** Explicit request-scoped wire selection. See resolvePageTranslationWireProtocol. */
    wireProtocol?: PageTranslationWireProtocol;
    /** Required by legacy-v2; omitted by the pt3 client. */
    outputProtocol?: PageOutputProtocol;
    /** Session-frozen context block; identical object per session for prompt-cache hygiene. */
    ctx?: PageTranslationCtx;
    /** Untrusted packet hint. prepareTranslationWire allowlists any provider-visible effect. */
    hint?: string;
    maxOutputTokens: number;
    items: TranslationBatchItem[];
    /**
     * Valid, fully closed reply items recovered from a provider stream. The callback is
     * presentation-only: the final ProviderAttemptResult remains the accounting and recovery
     * authority, and callers must keep their normal CAS/validation guards when applying items.
     */
    onProgress?: (items: TranslatedBatchItem[]) => void;
};

export type UsageSource = "provider-reported" | "provider-counted" | "client-estimated";

export type UsageField = {
    value: number;
    source: UsageSource;
};

export type UsageReceipt = {
    billingEventId: string;
    requestId: string;
    attemptId: string;
    providerRequestId?: string;
    coverage: "complete" | "partial" | "unknown";
    inputTokens?: UsageField;
    outputTokens?: UsageField;
    reasoningTokens?: UsageField;
    cachedInputTokens?: UsageField;
    cacheWriteTokens?: UsageField;
    totalTokens?: UsageField;
    reasoningRelation: "subset-of-output" | "additional-to-output" | "unknown";
};

export type TranslatedBatchItem = {
    id: string;
    translatedText: string;
    /**
     * True when the model replied with the "=" keep-source sentinel; translatedText carries
     * the source text and the client must identity-verify before committing.
     */
    keepSource?: boolean;
};

export type ProviderFailureKind =
    | "auth"
    | "quota"
    | "rate-limit"
    | "transient"
    | "provider-status"
    | "timeout"
    | "cancelled"
    | "context-limit"
    | "output-limit"
    | "content-filter"
    | "model-not-found"
    | "unsupported-capability"
    | "schema-invalid"
    | "delivery-unknown";

export type RetryDirective = "never" | "same-units" | "split" | "downgrade";

export type ProviderFailure = {
    kind: ProviderFailureKind;
    message: string;
    retryDirective: RetryDirective;
    retryAfterMs?: number;
    requestMayHaveExecuted: boolean;
    httpStatus?: number;
    capabilityPatch?: Partial<ProviderCapabilities>;
};

export type AttemptSummary = {
    attemptId: string;
    providerRequestId?: string;
    httpStatus?: number;
    startedAt: number;
    finishedAt: number;
    finishReason?: string;
};

export type ProviderAttemptResult =
    | {
          ok: true;
          items: TranslatedBatchItem[];
          usageReceipts: UsageReceipt[];
          attempt: AttemptSummary;
      }
    | {
          ok: false;
          failure: ProviderFailure;
          partialItems: TranslatedBatchItem[];
          usageReceipts: UsageReceipt[];
          attempt: AttemptSummary;
      };

export type TokenCountEvidence = {
    tokens: number;
    source: "provider-counted" | "client-estimated";
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TranslationProviderAdapter {
    readonly protocol: ProviderProtocol;
    discover(profile: ProviderProfile, signal: AbortSignal): Promise<ProviderCapabilities>;
    countInput?(
        profile: ProviderProfile,
        request: TranslationBatchRequest,
        signal: AbortSignal
    ): Promise<TokenCountEvidence>;
    executeOnce(
        profile: ProviderProfile,
        request: TranslationBatchRequest,
        signal: AbortSignal
    ): Promise<ProviderAttemptResult>;
}
