import { TranslationResult, TranslationTokenUsage } from "../types";
import { LRUCache } from "../utils/lru";
import { fnv1a32 } from "../utils/hash";

export type LocalTranslatorMode =
    | "chromeBuiltin"
    | "googleAiStudio"
    | "openai"
    | "openaiCompatible";

export type LocalTranslatorConfig = {
    enabled?: boolean;
    mode?: LocalTranslatorMode | string;
    apiKey?: string;
    model?: string;
    reasoningLevel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    openaiReasoningEffort?: string;
    openaiCompatibleBaseUrl?: string;
    openaiCompatibleApiKey?: string;
    openaiCompatibleModel?: string;
    timeoutMs?: number | string;
};

export type LocalTranslationOptions = {
    textRole?: string;
    translationProfile?: string;
    /**
     * Called from each SSE chunk with the full accumulated text so far. The translator
     * still returns the final aggregated result; this callback only enables progressive
     * UI updates. When omitted, the request runs without streaming.
     */
    onProgress?: (accumulatedText: string) => void;
    /**
     * LLM-only page context for selection translation: a budgeted window of the text
     * around the selection plus page title/hostname. Used purely for sense
     * disambiguation and tone — never translated, never echoed (the system prompt
     * carries the anti-echo rule). All fields are pre-capped by the caller.
     */
    selectionContext?: {
        surrounding?: string;
        title?: string;
        domain?: string;
    };
};

const LANGUAGE_NAMES: Record<string, string> = {
    auto: "auto",
    en: "English",
    ko: "Korean",
    ja: "Japanese",
    "zh-CN": "Chinese",
    "zh-TW": "Traditional Chinese",
    zh: "Chinese",
    fr: "French",
    de: "German",
    es: "Spanish",
    it: "Italian",
    pt: "Portuguese",
    ru: "Russian",
    vi: "Vietnamese",
    th: "Thai",
    id: "Indonesian",
    ar: "Arabic",
    hi: "Hindi",
    tr: "Turkish",
    nl: "Dutch",
    pl: "Polish",
    uk: "Ukrainian",
};

const CHROME_TRANSLATOR_LANGUAGE_MAP: Record<string, string> = {
    auto: "auto",
    en: "en",
    ko: "ko",
    ja: "ja",
    "zh-CN": "zh",
    "zh-TW": "zh-Hant",
    zh: "zh",
    fr: "fr",
    de: "de",
    es: "es",
    it: "it",
    pt: "pt",
    ru: "ru",
    vi: "vi",
    th: "th",
    id: "id",
    ar: "ar",
    hi: "hi",
    tr: "tr",
    nl: "nl",
    pl: "pl",
    uk: "uk",
    bg: "bg",
    bn: "bn",
    cs: "cs",
    da: "da",
    el: "el",
    fi: "fi",
    hr: "hr",
    hu: "hu",
    iw: "iw",
    kn: "kn",
    lt: "lt",
    mr: "mr",
    no: "no",
    ro: "ro",
    sk: "sk",
    sl: "sl",
    sv: "sv",
    ta: "ta",
    te: "te",
};

const SUPPORTED_LANGUAGE_CODES = new Set(Object.keys(LANGUAGE_NAMES));
const CHROME_TRANSLATOR_SUPPORTED_LANGUAGE_CODES = new Set(
    Object.keys(CHROME_TRANSLATOR_LANGUAGE_MAP)
);
// Speed-first: fail fast so the retry pipeline routes around a slow connection instead of
// waiting up to 90s on a stalled request. Real LLM completions for page-translate batches
// land in 5-15s on cloud APIs; 60s is well past the 99th percentile.
const DEFAULT_TIMEOUT_MS = 60000;
// Realtime captions are disposable: a translation that arrives after the line has
// scrolled off is useless and, worse, holds the single in-flight caption slot the
// whole time. Cap caption requests far tighter than page/selection translation so a
// stalled request frees the slot quickly and the next caption (or Google fast
// fallback) takes over.
const REALTIME_CAPTION_TIMEOUT_MS = 12000;
const DEFAULT_GOOGLE_AI_STUDIO_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_COMPATIBLE_MODEL = "gpt-oss-20b";
// Bump whenever the prompts below or the user-message layout changes so cached translations
// from older prompts are invalidated and rebuilt with the new shape.
const LOCAL_TRANSLATOR_PROMPT_VERSION = "local-prompt-2026-07-12-page-v6-semantic";
const GOOGLE_AI_STUDIO_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
// Speed-first: lift the in-process limiter to 32 to match the page-translate dispatch's
// max concurrency for googleAiStudio. The per-engine caps in banner_controller still
// enforce the right ceiling per provider; this just stops the limiter from being the
// bottleneck.
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

// Static system prompts. Keep these byte-identical across requests so runtimes/providers
// that support matching-prefix reuse can amortize prefill when their own eligibility rules
// are met; do not assume every provider caches a short prompt.
// Per-request directives (source/target language, dictionary mode) all live in the user
// message header — see buildUserMessage. Quality directives that apply uniformly (script
// rules, proper-noun handling, formatting preservation) live HERE so the cache absorbs them.
const AI_TRANSLATION_SYSTEM_PROMPT = [
    "You are a high-fidelity translation engine. Translate faithfully and naturally; preserve meaning, tone, intent, nuance.",
    "Keep the same text form (heading stays heading, sentence stays sentence). Do not summarize, explain, or add information.",
    "Output only the translation, no markdown fence or commentary.",
    "- For long webpage text and short snippets alike, keep line breaks, spacing, code, URLs, file paths, and inline placeholders intact. Respect the original formatting.",
    "- Source-language text is forbidden in the output. Before finalizing, rewrite any remaining source-language fragment.",
    "- Preserve proper nouns and official names — brand names, place names, person names, and official Latin-script names — in their original form. Use a localized or translated proper-name form only when it is clearly established.",
    "- Preserve numeric literals, dates, units, and code identifiers exactly.",
    "- Use the target language's customary writing system. For Han-script source text (Chinese, Japanese kanji), translate complete semantic units. Never create mixed-script words by combining source-script characters. Do not partially translate compound nouns. Silently scan the final answer for mixed-script words and rewrite them.",
    "- Subtitles: keep subtitle cue numbers, timestamps, and speaker labels intact.",
    "- When structured JSON is requested, return one valid JSON object only.",
    '- When the user message contains "Page:" or "Context:" lines, they are reference material for word-sense and tone only. Never translate, echo, or summarize them. Translate ONLY the text after the "Text to translate:" line.',
].join("\n");

const PAGE_HTML_TRANSLATION_SYSTEM_PROMPT =
    "Translate visible HTML text only. Preserve tags, attrs, order exactly. Output translated HTML only.";

// Sent on EVERY page-batch request (uncached on most engines), so it is kept lean — only
// load-bearing rules: the [[n]] protocol, inline-tag/number preservation + target spacing,
// the no-mixed-script rule (the #1 CJK quality failure), and the "=" keep-source sentinel.
// (Token count is mirrored by AI_PAGE_PER_REQUEST_OVERHEAD_TOK in banner_controller.js — keep
// the two in sync; the batch-size floor is derived from it.)
const PAGE_SEGMENTED_TRANSLATION_SYSTEM_PROMPT =
    "Translate each [[n]] webpage segment naturally to the target language, using neighbors and role suffixes like :title for context. Return every marker unchanged, once, in order, followed only by its translation. Preserve :row/:list JSON arrays and their length. Preserve inline tags, code, URLs, numbers and established names. Fully translate other prose; no mixed-script words or partial Han terms. For already-target text, return =; otherwise never use =.";

const REALTIME_CAPTION_SYSTEM_PROMPT =
    "You are a subtitle translator. Return only translated subtitles.";

class RequestLimiter {
    private active = 0;
    private queue: Array<() => void> = [];

    constructor(private readonly maxConcurrent: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.maxConcurrent) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        }
        this.active += 1;
        try {
            return await task();
        } finally {
            this.active -= 1;
            const next = this.queue.shift();
            if (next) next();
        }
    }
}

const localRequestLimiter = new RequestLimiter(DEFAULT_MAX_CONCURRENT_REQUESTS);

/**
 * Read an SSE (text/event-stream) response body and call onEvent for each `data:` payload.
 * Used by streaming paths in all three providers to surface partial output progressively.
 */
async function consumeSseStream(
    response: Response,
    onEvent: (data: string) => void
): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    const flushBlock = (block: string) => {
        // SSE permits LF, CRLF, or CR line endings and joins multiple data fields
        // into one event. Gemini commonly uses CRLF; waiting only for `\n\n`
        // buffered its whole response and made selection translation look non-streaming.
        const payload = block
            .split(/\r\n|\n|\r/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n")
            .trim();
        if (!payload || payload === "[DONE]") return;
        onEvent(payload);
    };
    const flushCompleteBlocks = () => {
        // A separator may itself straddle two network chunks, so retain the
        // unmatched suffix in `buffer` until the next read.
        let separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        while (separator) {
            flushBlock(buffer.slice(0, separator.index));
            buffer = buffer.slice(separator.index + separator[0].length);
            separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        }
    };
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            flushCompleteBlocks();
        }
        buffer += decoder.decode();
        flushCompleteBlocks();
        if (buffer.trim()) flushBlock(buffer);
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* noop */
        }
    }
}

async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 2,
    baseDelayMs = 500
): Promise<T> {
    let lastError: unknown;
    let accumulatedUsage: TranslationTokenUsage | undefined;
    let bestPartialOutput = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result: any = await fn();
            if (accumulatedUsage && result && typeof result === "object") {
                result.tokenUsage = mergeTokenUsage(accumulatedUsage, result.tokenUsage);
            }
            return result as T;
        } catch (error: any) {
            lastError = error;
            accumulatedUsage = mergeTokenUsage(accumulatedUsage, error?.tokenUsage);
            if (String(error?.partialOutput || "").length > bestPartialOutput.length) {
                bestPartialOutput = String(error.partialOutput);
            }
            const msg = error?.errorMsg || error?.message || "";
            const status = Number(error?.httpStatus ?? error?.status);
            const isRetryable =
                error?.providerRetryExhausted === true || error?.retryable === false
                    ? false
                    : error?.retryable === true ||
                      status === 429 ||
                      (status >= 500 && status <= 599) ||
                      /\b(?:429|500|502|503)\b|rate.?limit|too many requests/i.test(msg);
            if (!isRetryable || attempt === maxRetries) {
                if (isRetryable && error && typeof error === "object") {
                    error.providerRetryExhausted = true;
                }
                if (error && typeof error === "object") {
                    if (accumulatedUsage) error.tokenUsage = accumulatedUsage;
                    if (bestPartialOutput) error.partialOutput = bestPartialOutput;
                }
                throw error;
            }
            // Exponential backoff with full jitter so concurrent retries don't dogpile a
            // rate-limited endpoint at the exact same instant.
            const ceiling = baseDelayMs * Math.pow(2, attempt);
            const delay = Math.floor(Math.random() * ceiling) + Math.floor(baseDelayMs / 2);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastError;
}

function isRetryableTransportError(error: any) {
    const status = Number(error?.status ?? error?.httpStatus);
    const message = String(error?.message || error?.errorMsg || "");
    return (
        error?.name === "AbortError" ||
        error?.name === "TypeError" ||
        status === 429 ||
        (status >= 500 && status <= 599) ||
        /failed to fetch|fetch failed|network error|network request failed|connection (?:closed|reset|lost)|socket|econnreset|econnrefused|stream (?:closed|dropped|failed)/i.test(
            message
        )
    );
}

function normalizeMode(mode?: string): LocalTranslatorMode {
    if (mode === "chromeBuiltin" || mode === "geminiNano") return "chromeBuiltin";
    if (mode === "googleAiStudio") return "googleAiStudio";
    if (mode === "openai") return "openai";
    if (mode === "openaiCompatible") return "openaiCompatible";
    return "chromeBuiltin";
}

function normalizeModel(model: string | undefined, fallback: string) {
    return (model || fallback).trim() || fallback;
}

function addNumbers(...values: Array<number | undefined>) {
    let total = 0;
    for (const value of values) {
        const numeric = Number(value || 0);
        if (Number.isFinite(numeric)) total += numeric;
    }
    return total;
}

function cleanTokenUsage(usage: TranslationTokenUsage): TranslationTokenUsage | undefined {
    const cleaned: TranslationTokenUsage = {};
    for (const key of [
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "cachedInputTokens",
        "totalTokens",
    ] as const) {
        const value = usage[key];
        const numeric = Number(value || 0);
        if (Number.isFinite(numeric) && numeric > 0) cleaned[key] = numeric;
    }
    if (usage.estimated === true) cleaned.estimated = true;
    return Object.keys(cleaned).length ? cleaned : undefined;
}

function mergeTokenUsage(
    a?: TranslationTokenUsage,
    b?: TranslationTokenUsage
): TranslationTokenUsage | undefined {
    return cleanTokenUsage({
        inputTokens: addNumbers(a?.inputTokens, b?.inputTokens),
        outputTokens: addNumbers(a?.outputTokens, b?.outputTokens),
        reasoningTokens: addNumbers(a?.reasoningTokens, b?.reasoningTokens),
        cachedInputTokens: addNumbers(a?.cachedInputTokens, b?.cachedInputTokens),
        totalTokens: addNumbers(a?.totalTokens, b?.totalTokens),
        estimated: a?.estimated === true || b?.estimated === true,
    });
}

// Provider token usage is a one-owner cost event. Cache hits and concurrent in-flight joiners
// reuse the linguistic result/error but must not replay the owner's usage into a second caller's
// meter. Clone failures too: mutating the shared rejection object would erase the owner's usage.
function cloneWithoutTokenUsage<T>(value: T): T {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Error) {
        const cloned = Object.assign(new Error(value.message), value) as Error & {
            tokenUsage?: TranslationTokenUsage;
        };
        cloned.name = value.name;
        cloned.stack = value.stack;
        cloned.tokenUsage = undefined;
        return cloned as unknown as T;
    }
    return {
        ...(value as Record<string, unknown>),
        tokenUsage: undefined,
    } as unknown as T;
}

function extractGoogleAiStudioTokenUsage(payload: any): TranslationTokenUsage | undefined {
    const usage = payload?.usageMetadata;
    if (!usage) return undefined;
    return cleanTokenUsage({
        inputTokens: usage.promptTokenCount,
        outputTokens: usage.candidatesTokenCount,
        reasoningTokens: usage.thoughtsTokenCount,
        cachedInputTokens: usage.cachedContentTokenCount,
        totalTokens: usage.totalTokenCount,
    });
}

function extractOpenAiTokenUsage(payload: any): TranslationTokenUsage | undefined {
    const usage = payload?.usage;
    if (!usage) return undefined;
    return cleanTokenUsage({
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
        totalTokens: usage.total_tokens,
    });
}

function finalizeAttemptTokenUsage(
    actual: TranslationTokenUsage | undefined,
    {
        systemText = "",
        userText = "",
        rawOutput = "",
        isPage = false,
    }: {
        systemText?: string;
        userText?: string;
        rawOutput?: string;
        isPage?: boolean;
    }
): TranslationTokenUsage | undefined {
    const exact = cleanTokenUsage(actual || {}) || {};
    let estimated = exact.estimated === true;
    let inputTokens = Number(exact.inputTokens || 0);
    let outputTokens = Number(exact.outputTokens || 0);

    if (!(inputTokens > 0)) {
        inputTokens = estimateTextTokens(systemText) + estimateTextTokens(userText) + 16;
        if (inputTokens > 0) estimated = true;
    }
    if (!(outputTokens > 0) && rawOutput) {
        outputTokens = isPage
            ? estimateTextTokens(stripPagePromptStructure(rawOutput)) +
              estimatePageStructuralTokens(rawOutput)
            : estimateTextTokens(rawOutput);
        if (outputTokens > 0) estimated = true;
    }

    const totalTokens =
        Number(exact.totalTokens || 0) > 0
            ? Number(exact.totalTokens)
            : addNumbers(inputTokens, outputTokens);
    return cleanTokenUsage({
        inputTokens,
        outputTokens,
        reasoningTokens: exact.reasoningTokens,
        cachedInputTokens: exact.cachedInputTokens,
        totalTokens,
        estimated,
    });
}

function attachAttemptUsageToError(
    error: any,
    context: Parameters<typeof finalizeAttemptTokenUsage>[1]
) {
    if (!error || typeof error !== "object") return error;
    error.tokenUsage = finalizeAttemptTokenUsage(error.tokenUsage, context);
    if (context.rawOutput) error.partialOutput = context.rawOutput;
    return error;
}

function createPageOutputIncompleteError(
    message: string,
    tokenUsage: TranslationTokenUsage | undefined,
    partialOutput: string
) {
    const error: any = new Error(message);
    error.errorCode = "PAGE_OUTPUT_INCOMPLETE";
    error.retryable = false;
    error.tokenUsage = tokenUsage;
    error.partialOutput = partialOutput;
    return error;
}

function isSuccessfulPageFinishReason(reason: string) {
    return /^(?:stop|eos|eos_token|end_turn)$/i.test(String(reason || ""));
}

function isTruncatedPageFinishReason(reason: string) {
    return /^(?:length|max_tokens)$/i.test(String(reason || ""));
}

function createPageTerminalError(
    provider: string,
    reason: string,
    tokenUsage: TranslationTokenUsage | undefined,
    partialOutput: string
) {
    const error: any = new Error(`${provider} stopped page translation with ${reason}.`);
    error.errorCode = "PAGE_OUTPUT_BLOCKED";
    error.retryable = false;
    error.tokenUsage = tokenUsage;
    error.partialOutput = partialOutput;
    return error;
}

function stopAfterPageRecoveryFailure(
    error: any,
    accumulatedUsage: TranslationTokenUsage | undefined
) {
    const failure =
        error && typeof error === "object"
            ? error
            : new Error(String(error || "Page recovery failed."));
    const wasRetryableTransport = isRetryableTransportError(failure);
    failure.tokenUsage = mergeTokenUsage(accumulatedUsage, failure.tokenUsage);
    // The zero-prefix recovery call was already the one bounded exception. Never let the
    // outer provider backoff replay the whole page a third time.
    failure.retryable = false;
    if (wasRetryableTransport) failure.providerRetryExhausted = true;
    return failure;
}

function toLanguageName(language: string) {
    return LANGUAGE_NAMES[language] || language || "auto";
}

function toChromeTranslatorLanguage(language: string) {
    if (!language) return language;
    const raw = String(language).trim();
    if (!raw) return raw;
    if (CHROME_TRANSLATOR_LANGUAGE_MAP[raw]) return CHROME_TRANSLATOR_LANGUAGE_MAP[raw];

    const normalized = raw.replace(/_/g, "-");
    const lower = normalized.toLowerCase();
    if (lower === "auto") return "auto";
    if (/^zh(-|$)/.test(lower)) {
        if (/tw|hk|mo|hant/.test(lower)) return "zh-Hant";
        return "zh";
    }

    const base = lower.split("-")[0];
    return CHROME_TRANSLATOR_LANGUAGE_MAP[base] || base || raw;
}

function getScriptConstraint(language: string) {
    return language ? "Use the target language's customary writing system." : "";
}

function getRealtimeCaptionStyleRule() {
    return [
        "Use natural target-language spoken-subtitle style.",
        "Avoid stiff literal translation.",
        "Reorder clauses for natural target-language timing.",
        "Keep the speaker's register and emotion in compact subtitle wording.",
    ].join(" ");
}

function isDictionaryCandidate(text: string) {
    const trimmed = String(text || "").trim();
    if (!trimmed || trimmed.length > 64) return false;
    if (/https?:\/\//i.test(trimmed)) return false;
    if (
        /\[\[\d+(?::[a-z][a-z0-9-]*)?]]/.test(trimmed) ||
        /<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/.test(trimmed)
    ) {
        return false;
    }
    if (/[.!?。！？\n\r\t]/.test(trimmed)) return false;
    if (/^[「『“"'].*[」』”"']\s*\S+/.test(trimmed)) return false;

    const cjkChars = trimmed.match(
        /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g
    );
    if (cjkChars && cjkChars.length > 4) return false;

    return trimmed.split(/\s+/).length <= 2;
}

function isDictionaryTranslationRequest(text: string, options: LocalTranslationOptions = {}) {
    // Page payloads win over the short-term dictionary heuristic. In particular,
    // compact `[[1]]\nHome` used to be treated as a dictionary lookup because the
    // old exclusion recognized only role-suffixed markers (`[[1:p]]`). That forced
    // JSON mode and disabled streaming on the first visible page segment.
    if (isPageTranslationRequest(text, options)) {
        return false;
    }
    return isDictionaryCandidate(text);
}

function isPageTranslationRequest(text: string, options: LocalTranslationOptions = {}) {
    return options.translationProfile === "page" || hasPageTranslationSegments(text);
}

function stripCodeFence(text: string) {
    return String(text || "")
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/i, "")
        .trim();
}

function unescapeLooseJsonString(value: string) {
    return String(value || "")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, String.fromCharCode(34))
        .replace(/\\\\/g, "\\")
        .trim();
}

function extractLooseJsonStringField(text: string, field: string, nextFields: string[] = []) {
    const source = String(text || "");
    const keyMatch = new RegExp(`["']${field}["']\\s*:\\s*["']`, "i").exec(source);
    if (!keyMatch) return "";

    const valueStart = keyMatch.index + keyMatch[0].length;
    const nextFieldPattern = nextFields.length
        ? nextFields.map((key) => `["']${key}["']\\s*:`).join("|")
        : "$^";
    const rest = source.slice(valueStart);
    const endPattern = new RegExp(`["']\\s*,\\s*(?:${nextFieldPattern})|["']\\s*[,}]\\s*$`, "i");
    const endMatch = endPattern.exec(rest);
    const raw = endMatch ? rest.slice(0, endMatch.index) : rest.replace(/["'}\s]*$/g, "");
    return unescapeLooseJsonString(raw);
}

/**
 * Strip prompt echo / instruction leakage from raw LLM output.
 * Small local models (e.g. llama.cpp, Ollama) sometimes prefix the
 * translation with echoed prompt lines like "Source language: English."
 * or "Target language: Korean." — remove them so they don't pollute the
 * final translation.
 */
function stripPromptEcho(text: string) {
    if (!text) return "";
    return text
        .replace(
            /^[ \t]*(Source language|Target language|Translate|Output only the translation|Translate the user'?s text|Translate faithfully|Preserve meaning|Use the target language'?s|Preserve proper nouns)[^\n]*$/gim,
            ""
        )
        .replace(/^[ \t]*[A-Z][a-z]+:\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function parsePlainTranslationOutput(output: string) {
    const cleaned = stripCodeFence(output);
    if (!cleaned) return "";

    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try {
            const payload = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
            const translated = String(
                payload.translation || payload.mainMeaning || payload.translatedText || ""
            ).trim();
            if (translated) return translated;
        } catch {
            // Fall through to loose JSON field extraction.
        }
    }

    return stripPromptEcho(
        extractLooseJsonStringField(cleaned, "translation", [
            "mainMeaning",
            "translatedText",
            "tPronunciation",
            "sPronunciation",
            "detailedMeanings",
            "definitions",
            "examples",
        ]) || cleaned.trim()
    );
}

// Page replies may legitimately translate documentation containing a JSON example
// such as {"translation":"foo"}. The generic selection/dictionary parser extracts
// that field and would collapse an entire marker batch to "foo". Page mode only
// removes transport wrappers/reasoning/prompt echo; marker parsing remains owned by
// the page controller.
function parsePageTranslationOutput(output: string, dropIncompleteTail = false) {
    let cleaned = stripCodeFence(output);
    // Thinking-capable compatible servers may leak a leading reasoning block that itself
    // mentions our marker protocol. Remove only complete blocks anchored before the reply;
    // never touch a <think> code example after the first real marker.
    cleaned = cleaned.replace(/^(?:\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*)+/i, "");
    // The stream may still be inside reasoning. Until its closing tag arrives there is no
    // trustworthy page payload to parse; markers inside the thought text are not segments.
    if (/^\s*<think(?:ing)?>/i.test(cleaned)) return "";
    const firstMarker = cleaned.search(/\[\[\d+(?::[a-z][a-z0-9-]*)?]]/i);
    // A page reply must begin at its first marker. Dropping a leading reasoning/
    // commentary preamble this way does not mistake a translated <think> code example
    // inside a segment for model reasoning. Once markers begin, every following line
    // is user-visible payload: a valid English translation may itself start with
    // "Translate", "Source language", or another phrase recognized as prompt echo.
    cleaned =
        firstMarker >= 0
            ? cleaned.slice(firstMarker).trim()
            : stripPromptEcho(stripReasoningArtifacts(cleaned));
    if (!dropIncompleteTail || !cleaned) return cleaned;
    const markers = Array.from(cleaned.matchAll(/\[\[\d+(?::[a-z][a-z0-9-]*)?]]/gi));
    if (markers.length <= 1) return "";
    return cleaned.slice(0, markers[markers.length - 1].index).trim();
}

function getKoreanMixedScriptFragments(text: string) {
    const fragments = new Set<string>();
    const tokens = String(text || "").match(/[^\s.,!?。！？()[\]{}"']+/g) || [];
    for (const token of tokens) {
        if (
            /[\uAC00-\uD7AF]/.test(token) &&
            /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(token)
        ) {
            fragments.add(token);
        }
    }
    return Array.from(fragments);
}

function isAcceptableKoreanFragmentRepair(source: string, translation: string) {
    const repaired = String(translation || "").trim();
    if (!source || !repaired) return false;
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(repaired)) return false;
    const compactSourceLength = source.replace(/\s+/g, "").length;
    const compactRepairLength = repaired.replace(/\s+/g, "").length;
    return compactRepairLength <= Math.max(compactSourceLength * 2, compactSourceLength + 4);
}

function parseGeminiNanoScriptRepairs(output: string) {
    const cleaned = stripCodeFence(output);
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return [];
    try {
        const payload = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
        return asArray(payload?.repairs)
            .map((item) => ({
                source: String(item?.source || "").trim(),
                translation: String(item?.translation || "").trim(),
            }))
            .filter((item) => item.source && item.translation);
    } catch {
        return [];
    }
}

function extractOpenAIMessageContent(message: any) {
    const content = message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                return part?.text || "";
            })
            .join("")
            .trim();
    }
    return "";
}

function extractOpenAIChoiceText(choice: any) {
    const messageContent = extractOpenAIMessageContent(choice?.message);
    if (messageContent) return messageContent;

    const deltaContent = extractOpenAIMessageContent(choice?.delta);
    if (deltaContent) return deltaContent;

    if (typeof choice?.text === "string") return choice.text.trim();
    if (typeof choice?.content === "string") return choice.content.trim();
    if (typeof choice?.message === "string") return choice.message.trim();
    return "";
}

function extractOpenAIResponseText(payload: any) {
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    for (const choice of choices) {
        const text = extractOpenAIChoiceText(choice);
        if (text) return text;
    }

    if (typeof payload?.output_text === "string") return payload.output_text.trim();
    if (typeof payload?.text === "string") return payload.text.trim();
    if (typeof payload?.response === "string") return payload.response.trim();
    if (typeof payload?.content === "string") return payload.content.trim();

    const output = Array.isArray(payload?.output) ? payload.output : [];
    return output
        .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
        .map((part: any) => part?.text || part?.content || "")
        .join("")
        .trim();
}

/**
 * Strip chain-of-thought artifacts that local reasoning models emit *inline* in
 * the message content. DeepSeek-R1, Qwen-QwQ / Qwen3-thinking, gpt-oss and the
 * like are the popular choices for OpenAI-compatible local servers (llama.cpp,
 * Ollama, LM Studio, vLLM), and most of those surface the reasoning as
 * <think>…</think> blocks in `content` rather than a separate reasoning_content
 * field — so without this the "translation" would carry the model's thinking.
 * A no-op for ordinary models (no tags present).
 */
function stripReasoningArtifacts(text: string) {
    let out = String(text || "");
    if (!out) return out;
    // Remove fully-formed reasoning blocks anywhere in the text.
    out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
    // Stray closing tag (opener already stripped or never streamed): keep only
    // what follows the final close, if anything.
    const lastClose = out.toLowerCase().lastIndexOf("</think");
    if (lastClose !== -1) {
        const after = out.slice(out.indexOf(">", lastClose) + 1);
        if (after.trim()) out = after;
    }
    // Stray opening tag (output truncated mid-reasoning): everything from it on is
    // reasoning, so keep only the text before it.
    const firstOpen = out.search(/<think(?:ing)?>/i);
    if (firstOpen !== -1) out = out.slice(0, firstOpen);
    return out.trim();
}

function countPageSegmentMarkers(text: string) {
    const matches = String(text || "").match(
        /\[\[\d+(?::[a-z][a-z0-9-]*)?]]|<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/g
    );
    return matches ? matches.length : 0;
}

function hasPageTranslationSegments(text: string) {
    return countPageSegmentMarkers(text) > 0;
}

function estimateTextTokens(text: string) {
    const value = String(text || "");
    if (!value) return 0;
    const compactCjkChars = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || [])
        .length;
    const otherChars = Math.max(0, value.length - compactCjkChars);
    return Math.ceil(compactCjkChars * 0.8 + otherChars / 3.6);
}

function stripPagePromptStructure(text: string) {
    return String(text || "")
        .replace(/\[\[\d+(?::[a-z][a-z0-9-]*)?]]/g, " ")
        .replace(/<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/g, " ")
        .replace(/<[^>]+>/g, " ");
}

function estimatePageStructuralTokens(text: string) {
    const value = String(text || "");
    const visible = stripPagePromptStructure(value);
    const structuralChars = Math.max(0, value.length - visible.length);
    return Math.ceil(structuralChars / 5.5) + countPageSegmentMarkers(value) * 3;
}

function estimatePageOutputTokenBudget(
    text: string,
    tokenMultiplier: number,
    floor: number,
    ceiling: number
) {
    const visibleTokens = estimateTextTokens(stripPagePromptStructure(text));
    const structuralTokens = estimatePageStructuralTokens(text);
    const multiplier = tokenMultiplier >= 8 ? 1.85 : 1.28;
    const safety = tokenMultiplier >= 8 ? 96 : 40;
    const estimate = Math.ceil(visibleTokens * multiplier + structuralTokens + safety);
    return Math.min(ceiling, Math.max(floor, estimate));
}

function buildOpenAiCompletionLimit(model: string, tokenBudget: number) {
    const budget = Math.max(16, Math.ceil(tokenBudget));
    if (/^gpt-5/i.test(model || "")) {
        return { max_completion_tokens: budget };
    }
    return { max_tokens: budget };
}

// Model families whose EVERY snapshot accepts completion budgets well beyond the legacy
// 4096 cap. Gating on the family (not "not legacy") keeps unknown/proxy model names on
// the safe 4096 ceiling — a too-high cap is a hard 400, not a truncation. gpt-4o is
// deliberately EXCLUDED: gpt-4o-2024-05-13 caps at 4096 while later snapshots take 16384,
// and the banner cannot know which snapshot serves the alias. o-series is excluded too —
// it takes max_completion_tokens, which buildOpenAiCompletionLimit only sends for gpt-5.
function supportsLargeCompletionBudget(model: string) {
    return /^(gpt-5|gpt-4\.1)/i.test(model || "");
}

function normalizeOpenAiCompatibleEndpoint(baseUrl?: string) {
    const trimmed = String(baseUrl || "").trim();
    if (!trimmed) return "";
    const withoutTrailingSlash = trimmed.replace(/\/+$/g, "");
    if (/\/chat\/completions$/i.test(withoutTrailingSlash)) return withoutTrailingSlash;
    if (/\/v1$/i.test(withoutTrailingSlash)) return `${withoutTrailingSlash}/chat/completions`;
    return `${withoutTrailingSlash}/v1/chat/completions`;
}

function asArray(value: any) {
    return Array.isArray(value) ? value : [];
}

function getFirstArray(payload: any, keys: string[]) {
    for (const key of keys) {
        const value = payload?.[key];
        if (Array.isArray(value)) return value;
    }
    return [];
}

function parseStructuredDictionaryOutput(output: string, fallbackText: string) {
    const cleaned = stripCodeFence(output);
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;

    try {
        const payload = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
        const mainMeaning = String(
            payload.translation || payload.mainMeaning || payload.translatedText || ""
        ).trim();
        if (!mainMeaning) return null;
        const pickString = (item: any, keys: string[]) => {
            for (const key of keys) {
                const value = item?.[key];
                if (value !== undefined && value !== null && String(value).trim()) {
                    return String(value).trim();
                }
            }
            return null;
        };
        const detailedMeanings = getFirstArray(payload, [
            "detailedMeanings",
            "detailed_meanings",
            "meanings",
            "senses",
        ])
            .map((item) => {
                if (typeof item === "string") {
                    return { pos: "", meaning: item.trim(), synonyms: [] };
                }
                return {
                    pos: String(
                        item?.pos || item?.partOfSpeech || item?.part_of_speech || ""
                    ).trim(),
                    meaning: String(
                        item?.meaning || item?.definition || item?.translation || ""
                    ).trim(),
                    synonyms: asArray(item?.synonyms)
                        .map((word) => String(word || "").trim())
                        .filter(Boolean),
                };
            })
            .filter((item) => item.meaning);
        const definitions = getFirstArray(payload, ["definitions", "definitionEntries"])
            .map((item) => {
                if (typeof item === "string") {
                    return { pos: "", meaning: item.trim(), example: "", synonyms: [] };
                }
                return {
                    pos: String(
                        item?.pos || item?.partOfSpeech || item?.part_of_speech || ""
                    ).trim(),
                    meaning: String(
                        item?.meaning || item?.definition || item?.translation || ""
                    ).trim(),
                    example: String(
                        item?.example || item?.sourceExample || item?.sentence || ""
                    ).trim(),
                    synonyms: asArray(item?.synonyms)
                        .map((word) => String(word || "").trim())
                        .filter(Boolean),
                };
            })
            .filter((item) => item.meaning);
        const examples = getFirstArray(payload, ["examples", "exampleSentences"])
            .map((item) => {
                if (typeof item === "string") {
                    return { source: item.trim(), target: null };
                }
                return {
                    source: pickString(item, [
                        "source",
                        "sourceExample",
                        "sourceText",
                        "example",
                        "sentence",
                    ]),
                    target: pickString(item, [
                        "target",
                        "targetExample",
                        "targetText",
                        "translation",
                        "translated",
                    ]),
                };
            })
            .filter((item) => item.source || item.target);

        return {
            originalText: fallbackText,
            mainMeaning,
            detailedMeanings,
            definitions,
            examples,
        } as TranslationResult;
    } catch {
        return null;
    }
}

class LocalTranslator {
    private enabled = false;
    private mode: LocalTranslatorMode = "chromeBuiltin";
    private apiKey = "";
    private model = DEFAULT_GOOGLE_AI_STUDIO_MODEL;
    private openaiApiKey = "";
    private openaiModel = DEFAULT_OPENAI_MODEL;
    private openaiCompatibleBaseUrl = "";
    private openaiCompatibleEndpoint = "";
    private openaiCompatibleApiKey = "";
    private openaiCompatibleModel = DEFAULT_OPENAI_COMPATIBLE_MODEL;
    private timeoutMs = DEFAULT_TIMEOUT_MS;
    private cache = new LRUCache<string, TranslationResult>({ max: 200, ttl: 10 * 60 * 1000 });
    private inflight = new Map<string, Promise<TranslationResult>>();
    private chromeTranslatorCache = new Map<string, any>();

    constructor(config: LocalTranslatorConfig = {}) {
        this.useConfig(config);
    }

    useConfig(config: LocalTranslatorConfig = {}) {
        this.enabled = Boolean(config.enabled);
        this.mode = normalizeMode(config.mode);
        this.apiKey = (config.apiKey || "").trim();
        this.model = normalizeModel(config.model, DEFAULT_GOOGLE_AI_STUDIO_MODEL);
        this.openaiApiKey = (config.openaiApiKey || "").trim();
        this.openaiModel = normalizeModel(config.openaiModel, DEFAULT_OPENAI_MODEL);
        this.openaiCompatibleBaseUrl = (config.openaiCompatibleBaseUrl || "").trim();
        this.openaiCompatibleEndpoint = normalizeOpenAiCompatibleEndpoint(
            this.openaiCompatibleBaseUrl
        );
        this.openaiCompatibleApiKey = (config.openaiCompatibleApiKey || "").trim();
        this.openaiCompatibleModel = normalizeModel(
            config.openaiCompatibleModel,
            DEFAULT_OPENAI_COMPATIBLE_MODEL
        );
        this.timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
        this.cache.clear();
        this.inflight.clear();
        this.chromeTranslatorCache.clear();
    }

    supportedLanguages() {
        if (!this.enabled) return new Set<string>();
        if (this.mode === "chromeBuiltin") {
            return new Set(CHROME_TRANSLATOR_SUPPORTED_LANGUAGE_CODES);
        }
        if (this.mode === "googleAiStudio") {
            if (!this.apiKey || !this.model) return new Set<string>();
            return new Set(SUPPORTED_LANGUAGE_CODES);
        }
        if (this.mode === "openai") {
            if (!this.openaiApiKey || !this.openaiModel) return new Set<string>();
            return new Set(SUPPORTED_LANGUAGE_CODES);
        }
        if (this.mode === "openaiCompatible") {
            if (!this.openaiCompatibleEndpoint || !this.openaiCompatibleModel)
                return new Set<string>();
            return new Set(SUPPORTED_LANGUAGE_CODES);
        }
        return new Set<string>();
    }

    detect() {
        return Promise.resolve("auto");
    }

    async translate(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ): Promise<TranslationResult> {
        if (!text || !text.trim()) {
            return { originalText: text || "", mainMeaning: "" };
        }
        if (!this.enabled) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "LOCAL_TRANSLATOR_DISABLED",
                errorMsg: "Local translator is disabled.",
                errorAct: { api: "local", action: "translate", text, from, to },
            };
        }
        if (this.mode === "googleAiStudio" && !this.apiKey) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "GOOGLE_AI_STUDIO_API_KEY_MISSING",
                errorMsg: "Google AI Studio API key is not configured.",
                errorAct: {
                    api: "local",
                    mode: "googleAiStudio",
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        }
        if (this.mode === "openai" && !this.openaiApiKey) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "OPENAI_API_KEY_MISSING",
                errorMsg: "OpenAI API key is not configured.",
                errorAct: {
                    api: "local",
                    mode: "openai",
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        }
        if (this.mode === "openaiCompatible" && !this.openaiCompatibleEndpoint) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "OPENAI_COMPATIBLE_BASE_URL_MISSING",
                errorMsg: "OpenAI-compatible API base URL is not configured.",
                errorAct: {
                    api: "local",
                    mode: "openaiCompatible",
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        }
        if (this.mode === "openaiCompatible" && !this.openaiCompatibleModel) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "OPENAI_COMPATIBLE_MODEL_MISSING",
                errorMsg: "OpenAI-compatible API model is not configured.",
                errorAct: {
                    api: "local",
                    mode: "openaiCompatible",
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        }

        const providerModel =
            this.mode === "openai"
                ? this.openaiModel
                : this.mode === "openaiCompatible"
                ? `${this.openaiCompatibleEndpoint}|${this.openaiCompatibleModel}`
                : this.mode === "googleAiStudio"
                ? this.model
                : "";
        const profileKey = this.getTranslationProfileKey(options);
        const key = `L|${LOCAL_TRANSLATOR_PROMPT_VERSION}|${profileKey}|${
            this.mode
        }|${providerModel}|${from}|${to}|${fnv1a32(text)}`;
        const cached = this.cache.get(key);
        if (cached) return cached;

        const existing = this.inflight.get(key);
        if (existing) {
            // One provider request has one cost event. Joiners receive the translation but
            // not a duplicate copy of that request's usage accounting — including rejection
            // metadata, which otherwise made two callers charge one failed fetch twice.
            return existing.then(
                (result) => cloneWithoutTokenUsage(result),
                (error) => {
                    throw cloneWithoutTokenUsage(error);
                }
            );
        }

        const request = localRequestLimiter
            .run(() => this.requestTranslation(text, from, to, options))
            .then((result) => {
                // Token usage is a cost event for this provider call, not part of the
                // reusable translation. A cache hit must never replay historical spend.
                this.cache.set(key, { ...result, tokenUsage: undefined });
                return result;
            })
            .finally(() => this.inflight.delete(key));

        this.inflight.set(key, request);
        return request;
    }

    private getTranslationProfileKey(options: LocalTranslationOptions = {}) {
        if (this.isRealtimeCaptionBatchTranslation(options)) return "realtimeCaptionBatch";
        if (this.isRealtimeCaptionTranslation(options)) return "realtimeCaption";
        if (options.translationProfile === "page") return "page";
        return "default";
    }

    private isRealtimeCaptionBatchTranslation(options: LocalTranslationOptions = {}) {
        return options.translationProfile === "realtimeCaptionBatch";
    }

    private isRealtimeCaptionTranslation(options: LocalTranslationOptions = {}) {
        return (
            this.isRealtimeCaptionBatchTranslation(options) ||
            options.translationProfile === "realtimeCaption" ||
            String(options.textRole || "").toLowerCase() === "caption"
        );
    }

    /** Per-request abort timeout — captions get the tight cap (see constant). */
    private requestTimeoutMsFor(options: LocalTranslationOptions = {}) {
        return this.isRealtimeCaptionTranslation(options)
            ? Math.min(this.timeoutMs, REALTIME_CAPTION_TIMEOUT_MS)
            : this.timeoutMs;
    }

    private async requestTranslation(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        if (this.mode === "chromeBuiltin") {
            return this.requestChromeBuiltinTranslation(text, from, to);
        }
        // Captions fail immediately. Page requests also make exactly ONE provider call:
        // the page controller owns transport recovery because it can first salvage completed
        // streamed markers and then resend only the unresolved tail after a shared cooldown.
        // Retrying here would blindly replay the whole batch before the controller can salvage
        // it, multiplying both token spend and a 429 burst. Selection/dictionary keeps the
        // generic provider retry limit because it has no page-level recovery pipeline.
        const isPageTranslation = isPageTranslationRequest(text, options);
        const retries = this.isRealtimeCaptionTranslation(options) || isPageTranslation ? 0 : 2;
        if (this.mode === "googleAiStudio") {
            return retryWithBackoff(
                () => this.requestGoogleAiStudioTranslation(text, from, to, options),
                retries
            );
        }
        if (this.mode === "openai") {
            return retryWithBackoff(
                () => this.requestOpenAiTranslation(text, from, to, options),
                retries
            );
        }
        if (this.mode === "openaiCompatible") {
            return retryWithBackoff(
                () => this.requestOpenAiCompatibleTranslation(text, from, to, options),
                retries
            );
        }
        return this.requestChromeBuiltinTranslation(text, from, to);
    }

    private async requestChromeBuiltinTranslation(text: string, from: string, to: string) {
        try {
            const translatorApi = (globalThis as any).Translator;
            if (!translatorApi || typeof translatorApi.create !== "function") {
                throw new Error("Chrome built-in Translator API is not available in this browser.");
            }

            const targetLanguage = toChromeTranslatorLanguage(to);
            const sourceLanguage =
                from === "auto"
                    ? await this.detectChromeBuiltinLanguage(text, targetLanguage)
                    : toChromeTranslatorLanguage(from);

            const translator = await this.getChromeBuiltinTranslator(
                sourceLanguage,
                targetLanguage
            );
            const translated = await translator.translate(text);
            if (!translated) {
                throw new Error("Chrome built-in Translator API returned an empty translation.");
            }

            return {
                originalText: text,
                mainMeaning: translated,
                sourceLanguage,
                targetLanguage,
            } as TranslationResult;
        } catch (error: any) {
            throw {
                errorType: "API_ERR",
                errorCode: "CHROME_BUILTIN_TRANSLATOR_ERROR",
                errorMsg: error?.message || "Chrome built-in Translator API request failed.",
                errorAct: {
                    api: "local",
                    mode: "chromeBuiltin",
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        }
    }

    private async getChromeBuiltinTranslator(sourceLanguage: string, targetLanguage: string) {
        const key = `${sourceLanguage}|${targetLanguage}`;
        if (this.chromeTranslatorCache.has(key)) return this.chromeTranslatorCache.get(key);

        const translatorApi = (globalThis as any).Translator;
        if (typeof translatorApi.availability === "function") {
            const availability = await translatorApi.availability({
                sourceLanguage,
                targetLanguage,
            });
            if (availability === "unavailable") {
                throw new Error(
                    `Chrome built-in Translator API does not support ${sourceLanguage} to ${targetLanguage}.`
                );
            }
        }

        const translator = await translatorApi.create({ sourceLanguage, targetLanguage });
        this.chromeTranslatorCache.set(key, translator);
        return translator;
    }

    private async detectChromeBuiltinLanguage(text: string, targetLanguage: string) {
        const detectorApi = (globalThis as any).LanguageDetector;
        if (!detectorApi || typeof detectorApi.create !== "function") {
            throw new Error(
                "Chrome built-in Translator API requires an explicit source language when Language Detector API is unavailable."
            );
        }

        const detector = await detectorApi.create();
        const detections = await detector.detect(text);
        const detected = Array.isArray(detections) ? detections[0]?.detectedLanguage : undefined;
        const sourceLanguage = toChromeTranslatorLanguage(detected || "");
        if (!sourceLanguage || sourceLanguage === targetLanguage) {
            throw new Error(
                "Chrome built-in Language Detector API could not determine a translatable source language."
            );
        }
        return sourceLanguage;
    }

    private buildRealtimeCaptionPrompt(text: string, from: string, to: string) {
        const sourceLanguage = toLanguageName(from);
        const targetLanguage = toLanguageName(to);
        const scriptRule = getScriptConstraint(to);
        const styleRule = getRealtimeCaptionStyleRule();
        return [
            `Task: ${sourceLanguage} -> ${targetLanguage} YouTube subtitle.`,
            `Style: ${styleRule}`,
            "Rules: translate meaning, not word order; if fragment, keep a natural subtitle fragment; keep line breaks; preserve names, numbers, URLs; no notes.",
            scriptRule ? `Script: ${scriptRule}` : "",
            "Text:",
            text,
        ]
            .filter(Boolean)
            .join("\n");
    }

    private buildRealtimeCaptionBatchPrompt(text: string, from: string, to: string) {
        const sourceLanguage = toLanguageName(from);
        const targetLanguage = toLanguageName(to);
        const scriptRule = getScriptConstraint(to);
        const styleRule = getRealtimeCaptionStyleRule();
        return [
            `Task: ${sourceLanguage} -> ${targetLanguage} YouTube subtitle cues.`,
            `Style: ${styleRule}`,
            "Rules: use all cues as context; keep each [[n]] marker once and in order; each marker gets the natural subtitle for that moment; translate meaning, not word order; avoid repeated or missing meaning; preserve names, numbers, URLs; no notes.",
            scriptRule ? `Script: ${scriptRule}` : "",
            "Text:",
            text,
        ]
            .filter(Boolean)
            .join("\n");
    }

    private buildGoogleAiStudioPrompt(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        return this.buildUserMessage(text, from, to, options);
    }

    private buildOpenAiPrompt(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        return this.buildUserMessage(text, from, to, options);
    }

    /**
     * Per-request directives (source/target language, dictionary task, page link rules) live
     * in the user message header — the system prompt stays byte-identical across requests so
     * KV/prompt caches can amortize the prefill.
     */
    private buildUserMessage(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        if (this.isRealtimeCaptionBatchTranslation(options)) {
            return this.buildRealtimeCaptionBatchPrompt(text, from, to);
        }
        if (this.isRealtimeCaptionTranslation(options)) {
            return this.buildRealtimeCaptionPrompt(text, from, to);
        }

        const sourceLanguage = from ? toLanguageName(from) : "";
        const targetLanguage = to ? toLanguageName(to) : "";

        // Page mode covers both raw-HTML section payloads and marker-batched payloads.
        // Either way we want the same lean directive header — the system prompt carries the
        // HTML preservation rules and the structural guarantees.
        if (options.translationProfile === "page" || hasPageTranslationSegments(text)) {
            const header =
                sourceLanguage && targetLanguage ? `${sourceLanguage}>${targetLanguage}` : "";
            return header ? `${header}\n${text}` : text;
        }

        const langLine =
            sourceLanguage && targetLanguage
                ? `Source language: ${sourceLanguage}. Target language: ${targetLanguage}.`
                : sourceLanguage
                ? `Source language: ${sourceLanguage}.`
                : targetLanguage
                ? `Target language: ${targetLanguage}.`
                : "";
        const headerLines = [
            "Translate the user's text.",
            langLine,
            "Preserve proper nouns and official names. Use the target language's writing system.",
        ];
        const isDictionary = isDictionaryTranslationRequest(text, options);
        if (isDictionary) {
            headerLines.push(
                'Dictionary entry. Return only one valid JSON object: {"translation":"...","detailedMeanings":[{"pos":"","meaning":"","synonyms":[]}],"definitions":[{"pos":"","meaning":"","example":"","synonyms":[]}],"examples":[{"source":"","target":""}]}.',
                "Provide at least one detailedMeaning, one definition, and two examples for ordinary terms; use empty arrays when truly not applicable.",
                "Write translation, meanings, definitions, and target examples in the target language; keep source examples in the source language."
            );
        }

        // LLM-only page context (selection translation). Reference material, clearly fenced:
        // the static system prompt carries the matching anti-echo rule, and a sentinel line
        // separates the context from the actual payload so the model can't conflate them.
        const context = options.selectionContext;
        if (context && (context.surrounding || context.title || context.domain)) {
            const pageLine = [context.title, context.domain ? `(${context.domain})` : ""]
                .filter(Boolean)
                .join(" ");
            if (pageLine) headerLines.push(`Page: ${pageLine}`);
            if (context.surrounding) {
                headerLines.push(
                    `Context (surrounding page text — reference only, translate NONE of it): """${context.surrounding}"""`
                );
                if (isDictionary) {
                    headerLines.push(
                        "Pick the word-sense that fits this Context; order detailedMeanings with the contextual sense first."
                    );
                }
            }
            headerLines.push("Text to translate:");
        }
        const header = headerLines.filter(Boolean).join("\n");
        return header ? `${header}\n${text}` : text;
    }

    private getTranslationSystemPrompt(
        text: string,
        _from: string = "",
        _to: string = "",
        options: LocalTranslationOptions = {}
    ) {
        if (this.isRealtimeCaptionTranslation(options)) return REALTIME_CAPTION_SYSTEM_PROMPT;
        // Page-mode dispatch wins regardless of whether the payload uses [[n:r]] markers.
        // A legacy section-level caller can still send validated HTML without markers and
        // therefore needs the compatibility prompt's HTML preservation rules.
        if (options.translationProfile === "page" || hasPageTranslationSegments(text)) {
            if (hasPageTranslationSegments(text)) {
                return PAGE_SEGMENTED_TRANSLATION_SYSTEM_PROMPT;
            }
            return PAGE_HTML_TRANSLATION_SYSTEM_PROMPT;
        }
        return AI_TRANSLATION_SYSTEM_PROMPT;
    }

    private parseGoogleAiStudioResponse(payload: any) {
        const parts = payload?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
            return parts
                .map((part) => part?.text || "")
                .join("")
                .trim();
        }
        return (payload?.text || payload?.output || "").trim();
    }

    private parseOpenAiResponse(payload: any, preservePageMarkup = false) {
        const output = extractOpenAIResponseText(payload);
        return preservePageMarkup ? output : stripReasoningArtifacts(output);
    }

    private getGoogleAiStudioCompatibilityModes(options: LocalTranslationOptions = {}) {
        if (this.shouldStartGoogleAiStudioWithBareRequest(options)) {
            return ["bare", "minimal"] as const;
        }
        return ["minimal", "bare"] as const;
    }

    private shouldStartGoogleAiStudioWithBareRequest(options: LocalTranslationOptions = {}) {
        void options;
        if (this.buildGoogleAiStudioThinkingConfig()) return false;
        const model = this.model.toLowerCase();
        return /^gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:$|-)/.test(model);
    }

    private shouldAvoidGoogleAiStudioOutputLimit() {
        return /^gemini-3(?:\.|-|$)/i.test(this.model);
    }

    private isGemini3ProModel() {
        return /^gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:$|-)/i.test(this.model);
    }

    private isGemini25Model() {
        return /^gemini-2\.5/i.test(this.model);
    }

    private isGemini25ProModel() {
        return /^gemini-2\.5-pro(?:$|-)/i.test(this.model);
    }

    private isGemini3FlashLiteModel() {
        return /^gemini-(?:3(?:\.\d+)?-flash-lite|flash-lite-latest)(?:$|-)/i.test(this.model);
    }

    private isGemini3FlashModel() {
        return /^gemini-(?:3(?:\.\d+)?-flash|flash-latest)(?:$|-)/i.test(this.model);
    }

    private isGemini3Model() {
        return /^gemini-3(?:\.|-|$)/i.test(this.model);
    }

    private buildGoogleAiStudioThinkingConfig() {
        // Reasoning/"thinking" is pure waste for translation. Turn it fully OFF wherever the
        // model allows it, and fall back to the lowest provider-required level otherwise.
        if (this.isGemini3ProModel()) {
            // Gemini 3 Pro mandates thinking — give it the minimum level.
            return { thinkingLevel: "low" };
        }
        if (this.isGemini25ProModel()) {
            // Gemini 2.5 Pro cannot disable thinking; 128 is its documented minimum.
            return { thinkingBudget: 128 };
        }
        if (this.isGemini25Model()) {
            // Gemini 2.5 flash/flash-lite accepts a zero budget, which disables thinking
            // entirely (no reasoning tokens billed).
            return { thinkingBudget: 0 };
        }
        if (this.isGemini3FlashLiteModel() || this.isGemini3FlashModel()) {
            // Gemini 3 Flash/Flash-Lite cannot be fully disabled. `minimal` is the official
            // high-throughput floor and avoids the much slower dynamic default.
            return { thinkingLevel: "minimal" };
        }
        return undefined;
    }

    private buildGoogleAiStudioGenerationConfig(
        inputLength?: number,
        compatibilityMode: "minimal" | "bare" = "minimal",
        options: LocalTranslationOptions = {},
        isDictionary = false
    ) {
        if (compatibilityMode === "bare") return undefined;
        // Gemini 3.x is optimized for its default sampling parameters; Google recommends
        // omitting temperature/top-p/top-k for this family. Older models retain temperature 0.
        const config: Record<string, any> = this.isGemini3Model() ? {} : { temperature: 0 };
        const thinkingConfig = this.buildGoogleAiStudioThinkingConfig();
        if (thinkingConfig) config.thinkingConfig = thinkingConfig;
        // Dictionary entries are structured JSON: constrained decoding via the native JSON
        // mime type eliminates code fences / prose-wrapped JSON (parity with the OpenAI
        // path's response_format json_object). Mime-only — no responseSchema, which degrades
        // on flash-lite-class models for nested schemas.
        if (isDictionary) config.responseMimeType = "application/json";
        if (this.isRealtimeCaptionTranslation(options)) {
            config.maxOutputTokens = Math.max(96, Math.ceil((inputLength || 24) * 2));
            return config;
        }
        if (inputLength && !this.shouldAvoidGoogleAiStudioOutputLimit()) {
            // Translation output is roughly proportional to input length. Cap generously so large page batches
            // (10k+ chars) don't get truncated and trigger retries — Gemini bills only for actual output tokens.
            config.maxOutputTokens = Math.max(512, Math.ceil(inputLength * 2));
        }
        return config;
    }

    private isGoogleAiStudioTruncatedPayload(payload: any) {
        return payload?.candidates?.[0]?.finishReason === "MAX_TOKENS";
    }

    private shouldRetryGoogleAiStudioWithCompatibilityConfig(error: any) {
        if (error?.name === "AbortError") return false;
        const status = Number(error?.status || 0);
        if (status && status !== 400 && status !== 422) return false;
        const message = String(error?.message || error?.errorMsg || error || "").toLowerCase();
        if (!message || /not\s+found|permission|api key|quota|billing|rate limit/.test(message)) {
            return false;
        }
        return /generationconfig|generation config|thinkingconfig|thinking|budget|topk|candidatecount|temperature|maxoutputtokens|unknown field|invalid argument|unsupported|not supported/.test(
            message
        );
    }

    private buildKoreanScriptRepairPrompt(
        sourceText: string,
        translatedText: string,
        fragments: string[]
    ) {
        return [
            "Repair only the listed problematic fragments in the Korean translation.",
            "Do not retranslate the whole sentence or paragraph.",
            "Keep the same grammatical span as the fragment.",
            'Return only JSON: {"repairs":[{"source":"...","translation":"..."}]}',
            "",
            "Original source text:",
            sourceText,
            "",
            "Current Korean translation:",
            translatedText,
            "",
            "Problematic fragments:",
            ...fragments.map((fragment) => `- ${fragment}`),
        ].join("\n");
    }

    private async repairKoreanMixedScriptTranslation(
        translated: string,
        sourceText: string,
        to: string
    ) {
        if (toChromeTranslatorLanguage(to) !== "ko") return { translated };
        const fragments = getKoreanMixedScriptFragments(translated);
        if (!fragments.length) return { translated };

        const generationConfig = this.buildGoogleAiStudioGenerationConfig(
            translated.length,
            this.shouldStartGoogleAiStudioWithBareRequest() ? "bare" : "minimal"
        );
        const body: Record<string, any> = {
            systemInstruction: {
                parts: [
                    {
                        text: "You repair Korean mixed-script translation fragments. Output only JSON.",
                    },
                ],
            },
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            text: this.buildKoreanScriptRepairPrompt(
                                sourceText,
                                translated,
                                fragments
                            ),
                        },
                    ],
                },
            ],
        };
        if (generationConfig) body.generationConfig = generationConfig;

        const response = await fetch(
            `${GOOGLE_AI_STUDIO_ENDPOINT_BASE}/${encodeURIComponent(
                this.model
            )}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            }
        );
        const payload = await response.json().catch(() => ({}));
        const tokenUsage = extractGoogleAiStudioTokenUsage(payload);
        if (!response.ok) return { translated, tokenUsage };

        const repairs = parseGeminiNanoScriptRepairs(this.parseGoogleAiStudioResponse(payload));
        let repairedText = translated;
        for (const repair of repairs) {
            if (!fragments.includes(repair.source)) continue;
            if (!isAcceptableKoreanFragmentRepair(repair.source, repair.translation)) continue;
            repairedText = repairedText.replace(repair.source, repair.translation);
        }
        return { translated: repairedText, tokenUsage };
    }

    private async requestGoogleAiStudioTranslation(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        let controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMsFor(options));
        const resetRequestDeadline = () => {
            clearTimeout(timeoutId);
            controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMsFor(options));
        };
        const isPageTranslation = isPageTranslationRequest(text, options);
        try {
            const isRealtimeCaption = this.isRealtimeCaptionTranslation(options);
            const model = encodeURIComponent(this.model);
            const isDictionary =
                !isRealtimeCaption && isDictionaryTranslationRequest(text, options);
            // Dictionary lookups return structured JSON — streaming would flash raw JSON
            // fragments in the panel preview, so they run non-streaming (OpenAI parity).
            const useStreaming = typeof options.onProgress === "function" && !isDictionary;
            const systemText = this.getTranslationSystemPrompt(text, from, to, options);
            const userText = this.buildGoogleAiStudioPrompt(text, from, to, options);
            const requestPayload = async (
                compatibilityMode: "minimal" | "bare",
                outputScale = 1
            ) => {
                const generationConfig = this.buildGoogleAiStudioGenerationConfig(
                    text.length,
                    compatibilityMode,
                    options,
                    isDictionary
                );
                if (generationConfig?.maxOutputTokens && outputScale > 1) {
                    generationConfig.maxOutputTokens = Math.ceil(
                        generationConfig.maxOutputTokens * outputScale
                    );
                }
                const body: Record<string, any> = {
                    systemInstruction: {
                        parts: [{ text: systemText }],
                    },
                    contents: [
                        {
                            role: "user",
                            parts: [
                                {
                                    text: userText,
                                },
                            ],
                        },
                    ],
                };
                if (generationConfig) body.generationConfig = generationConfig;
                const endpoint = useStreaming
                    ? `${GOOGLE_AI_STUDIO_ENDPOINT_BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
                          this.apiKey
                      )}`
                    : `${GOOGLE_AI_STUDIO_ENDPOINT_BASE}/${model}:generateContent?key=${encodeURIComponent(
                          this.apiKey
                      )}`;
                let response: Response;
                try {
                    response = await fetch(endpoint, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            ...(useStreaming ? { Accept: "text/event-stream" } : {}),
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                } catch (error) {
                    throw attachAttemptUsageToError(error, {
                        systemText,
                        userText,
                        isPage: isPageTranslation,
                    });
                }
                if (!useStreaming) {
                    const payload = await response.json().catch(() => ({}));
                    if (!response.ok) {
                        const error: any = new Error(
                            payload?.error?.message ||
                                `Google AI Studio request failed with ${response.status}`
                        );
                        error.status = response.status;
                        throw attachAttemptUsageToError(error, {
                            systemText,
                            userText,
                            rawOutput: this.parseGoogleAiStudioResponse(payload),
                            isPage: isPageTranslation,
                        });
                    }
                    return payload;
                }
                if (!response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    const error: any = new Error(
                        payload?.error?.message ||
                            `Google AI Studio request failed with ${response.status}`
                    );
                    error.status = response.status;
                    throw attachAttemptUsageToError(error, {
                        systemText,
                        userText,
                        rawOutput: this.parseGoogleAiStudioResponse(payload),
                        isPage: isPageTranslation,
                    });
                }
                // Streaming SSE: each event is a partial candidate; assemble incrementally.
                let accumulated = "";
                let finishReason = "";
                let usageMetadata: any = null;
                let lastCandidate: any = null;
                try {
                    await consumeSseStream(response, (data) => {
                        try {
                            const json = JSON.parse(data);
                            const candidate = json.candidates?.[0];
                            if (candidate) {
                                lastCandidate = candidate;
                                const parts = candidate.content?.parts;
                                if (Array.isArray(parts)) {
                                    for (const part of parts) {
                                        if (typeof part?.text === "string" && part.text) {
                                            accumulated += part.text;
                                        }
                                    }
                                    try {
                                        options.onProgress?.(accumulated);
                                    } catch {
                                        /* noop */
                                    }
                                }
                                if (candidate.finishReason)
                                    finishReason = String(candidate.finishReason);
                            }
                            if (json.usageMetadata) usageMetadata = json.usageMetadata;
                        } catch {
                            /* skip malformed event */
                        }
                    });
                } catch (error) {
                    const actual = usageMetadata
                        ? extractGoogleAiStudioTokenUsage({ usageMetadata })
                        : undefined;
                    if (actual && error && typeof error === "object") {
                        (error as any).tokenUsage = actual;
                    }
                    throw attachAttemptUsageToError(error, {
                        systemText,
                        userText,
                        rawOutput: accumulated,
                        isPage: isPageTranslation,
                    });
                }
                // Synthesize a payload object shaped like the non-streaming response so the
                // downstream parsing code (parseGoogleAiStudioResponse, etc.) works unchanged.
                const synthesizedCandidate = {
                    ...(lastCandidate || {}),
                    content: { parts: [{ text: accumulated }] },
                    ...(finishReason ? { finishReason } : {}),
                };
                return {
                    candidates: [synthesizedCandidate],
                    ...(usageMetadata ? { usageMetadata } : {}),
                };
            };
            let payload: any;
            let tokenUsage: TranslationTokenUsage | undefined;
            let successfulCompatibilityMode: "minimal" | "bare" | null = null;
            const compatibilityModes = this.getGoogleAiStudioCompatibilityModes(options);
            for (let index = 0; index < compatibilityModes.length; index += 1) {
                const mode = compatibilityModes[index];
                const isLastMode = index === compatibilityModes.length - 1;
                try {
                    payload = await requestPayload(mode);
                    const rawAttemptOutput = this.parseGoogleAiStudioResponse(payload);
                    tokenUsage = mergeTokenUsage(
                        tokenUsage,
                        finalizeAttemptTokenUsage(extractGoogleAiStudioTokenUsage(payload), {
                            systemText,
                            userText,
                            rawOutput: rawAttemptOutput,
                            isPage: isPageTranslation,
                        })
                    );
                    if (
                        this.isGoogleAiStudioTruncatedPayload(payload) &&
                        !isPageTranslation &&
                        !isLastMode
                    ) {
                        continue;
                    }
                    if (
                        !this.parseGoogleAiStudioResponse(payload) &&
                        !isPageTranslation &&
                        !isLastMode
                    ) {
                        continue;
                    }
                    successfulCompatibilityMode = mode;
                    break;
                } catch (error: any) {
                    tokenUsage = mergeTokenUsage(tokenUsage, error?.tokenUsage);
                    const canRetry =
                        !isLastMode && this.shouldRetryGoogleAiStudioWithCompatibilityConfig(error);
                    if (!canRetry) {
                        if (error && typeof error === "object") error.tokenUsage = tokenUsage;
                        throw error;
                    }
                }
            }

            let rawOutput = this.parseGoogleAiStudioResponse(payload);
            let googleFinishReason = String(payload?.candidates?.[0]?.finishReason || "");
            if (
                isPageTranslation &&
                googleFinishReason &&
                !isSuccessfulPageFinishReason(googleFinishReason) &&
                !isTruncatedPageFinishReason(googleFinishReason)
            ) {
                throw createPageTerminalError(
                    "Google AI Studio",
                    googleFinishReason,
                    tokenUsage,
                    rawOutput
                );
            }
            const structured =
                !isRealtimeCaption && isDictionaryTranslationRequest(text, options)
                    ? parseStructuredDictionaryOutput(rawOutput, text)
                    : null;
            if (structured) {
                return {
                    ...structured,
                    translatedText: structured.mainMeaning,
                    sourceLanguage: from,
                    targetLanguage: to,
                    tokenUsage,
                } as TranslationResult;
            }

            let pageOutputIncomplete =
                isPageTranslation &&
                (isTruncatedPageFinishReason(googleFinishReason) ||
                    (useStreaming && !googleFinishReason));
            let translated = isPageTranslation
                ? parsePageTranslationOutput(rawOutput, pageOutputIncomplete)
                : parsePlainTranslationOutput(rawOutput);
            if (
                !translated &&
                pageOutputIncomplete &&
                countPageSegmentMarkers(text) <= 1 &&
                successfulCompatibilityMode === "minimal" &&
                Number(
                    this.buildGoogleAiStudioGenerationConfig(
                        text.length,
                        successfulCompatibilityMode,
                        options,
                        isDictionary
                    )?.maxOutputTokens || 0
                ) > 0
            ) {
                const priorUsage = tokenUsage;
                let retryPayload: Awaited<ReturnType<typeof requestPayload>>;
                try {
                    resetRequestDeadline();
                    retryPayload = await requestPayload(successfulCompatibilityMode, 2);
                } catch (error: any) {
                    throw stopAfterPageRecoveryFailure(error, priorUsage);
                }
                const retryRawOutput = this.parseGoogleAiStudioResponse(retryPayload);
                tokenUsage = mergeTokenUsage(
                    priorUsage,
                    finalizeAttemptTokenUsage(extractGoogleAiStudioTokenUsage(retryPayload), {
                        systemText,
                        userText,
                        rawOutput: retryRawOutput,
                        isPage: true,
                    })
                );
                payload = retryPayload;
                rawOutput = retryRawOutput;
                googleFinishReason = String(payload?.candidates?.[0]?.finishReason || "");
                if (
                    googleFinishReason &&
                    !isSuccessfulPageFinishReason(googleFinishReason) &&
                    !isTruncatedPageFinishReason(googleFinishReason)
                ) {
                    throw createPageTerminalError(
                        "Google AI Studio",
                        googleFinishReason,
                        tokenUsage,
                        rawOutput
                    );
                }
                pageOutputIncomplete =
                    isTruncatedPageFinishReason(googleFinishReason) ||
                    (useStreaming && !googleFinishReason);
                translated = parsePageTranslationOutput(rawOutput, pageOutputIncomplete);
            }
            if (!translated) {
                if (pageOutputIncomplete) {
                    throw createPageOutputIncompleteError(
                        "Google AI Studio returned no complete page segment before truncation.",
                        tokenUsage,
                        rawOutput
                    );
                }
                const emptyError: any = new Error(
                    "Google AI Studio returned an empty translation."
                );
                emptyError.tokenUsage = tokenUsage;
                emptyError.partialOutput = rawOutput;
                throw emptyError;
            }
            try {
                // Skip the optional repair round-trip on profiles where the second call costs
                // more than the fragments it would fix: realtime captions need low latency,
                // page batches contain per-segment markers and run dozens of requests so a
                // second call per batch would multiply token cost.
                const shouldSkipRepair =
                    this.isRealtimeCaptionTranslation(options) ||
                    options.translationProfile === "page" ||
                    hasPageTranslationSegments(text);
                if (shouldSkipRepair) {
                    return {
                        originalText: text,
                        mainMeaning: translated,
                        sourceLanguage: from,
                        targetLanguage: to,
                        tokenUsage,
                    } as TranslationResult;
                }
                const repairResult = await this.repairKoreanMixedScriptTranslation(
                    translated,
                    text,
                    to
                );
                translated = repairResult.translated;
                tokenUsage = mergeTokenUsage(tokenUsage, repairResult.tokenUsage);
            } catch {
                // Keep the primary translation if the optional repair pass fails.
            }

            return {
                originalText: text,
                mainMeaning: translated,
                sourceLanguage: from,
                targetLanguage: to,
                tokenUsage,
            } as TranslationResult;
        } catch (error: any) {
            throw {
                errorType: "API_ERR",
                errorCode:
                    error?.errorCode ||
                    (error?.name === "AbortError" ? "TIMEOUT" : "GOOGLE_AI_STUDIO_ERROR"),
                errorMsg: error?.message || "Google AI Studio request failed.",
                httpStatus: Number(error?.status) || undefined,
                retryable:
                    error?.retryable === false
                        ? false
                        : isRetryableTransportError(error) &&
                          !(
                              isPageTranslation &&
                              (error?.name === "AbortError" ||
                                  countPageSegmentMarkers(error?.partialOutput || "") > 1)
                          ),
                providerRetryExhausted: error?.providerRetryExhausted === true,
                tokenUsage: error?.tokenUsage,
                partialOutput: error?.partialOutput,
                errorAct: {
                    api: "local",
                    mode: "googleAiStudio",
                    model: this.model,
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private shouldUseOpenAiReasoningEffort() {
        return (
            /^(?:gpt-5|o[1-9])/i.test(this.openaiModel) && !/chat-latest/i.test(this.openaiModel)
        );
    }

    private getOpenAiReasoningEffort(options: LocalTranslationOptions = {}) {
        void options;
        if (!this.shouldUseOpenAiReasoningEffort()) return "";
        if (/^gpt-5(?:\.\d+)?-pro(?:$|-)/i.test(this.openaiModel)) {
            return "high";
        }
        if (/^gpt-5\.(?:[1-9]|\d{2,})(?:$|-)/i.test(this.openaiModel)) return "none";
        if (/^gpt-5/i.test(this.openaiModel)) {
            return "minimal";
        }
        return "low";
    }

    private shouldRetryOpenAiWithoutReasoningConfig(payload: any) {
        const message = String(payload?.error?.message || "").toLowerCase();
        return /reasoning_effort|reasoning effort|unsupported parameter|unknown parameter|invalid.*reasoning/.test(
            message
        );
    }

    private async requestOpenAiTranslation(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        let controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMsFor(options));
        const resetRequestDeadline = () => {
            clearTimeout(timeoutId);
            controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMsFor(options));
        };
        const isPageTranslation = isPageTranslationRequest(text, options);
        try {
            const isRealtimeCaption = this.isRealtimeCaptionTranslation(options);
            const reasoningEffort = this.getOpenAiReasoningEffort(options);
            const systemText = this.getTranslationSystemPrompt(text, from, to, options);
            const userText = this.buildOpenAiPrompt(text, from, to, options);
            // GPT-5.x and o-series reasoning models only accept the default temperature, so
            // sending an explicit value triggers a 400 from the API.
            const supportsTemperature = !this.shouldUseOpenAiReasoningEffort();
            const buildBody = (includeReasoningEffort = true, tokenMultiplier = 4) => ({
                model: this.openaiModel,
                messages: [
                    {
                        role: "system",
                        content: systemText,
                    },
                    {
                        role: "user",
                        content: userText,
                    },
                ],
                ...(supportsTemperature ? { temperature: 0 } : {}),
                ...(!isRealtimeCaption && isDictionaryTranslationRequest(text, options)
                    ? { response_format: { type: "json_object" } }
                    : {}),
                ...(includeReasoningEffort && reasoningEffort
                    ? { reasoning_effort: reasoningEffort }
                    : {}),
                ...buildOpenAiCompletionLimit(
                    this.openaiModel,
                    isRealtimeCaption
                        ? Math.max(96, text.length * 2)
                        : isPageTranslation
                        ? estimatePageOutputTokenBudget(
                              text,
                              tokenMultiplier,
                              tokenMultiplier >= 8 ? 640 : 384,
                              // Modern models take a high first-attempt ceiling so an
                              // oversized atomic section completes in ONE stream instead
                              // of paying gen(4096) + a full regeneration; legacy models
                              // keep the universal 4096/8192 truncate-then-retry path.
                              supportsLargeCompletionBudget(this.openaiModel)
                                  ? tokenMultiplier >= 8
                                      ? 16384
                                      : 12288
                                  : tokenMultiplier >= 8
                                  ? 8192
                                  : 4096
                          )
                        : Math.max(
                              512 * Math.max(1, tokenMultiplier / 4),
                              Math.ceil(text.length * (tokenMultiplier >= 8 ? 3 : 2))
                          )
                ),
            });
            // Streaming is incompatible with response_format JSON (used for dictionary entries).
            const useStreaming =
                typeof options.onProgress === "function" &&
                !(isDictionaryTranslationRequest(text, options) && !isRealtimeCaption);
            const requestPayload = async (includeReasoningEffort = true, tokenMultiplier = 4) => {
                const headers: Record<string, string> = {
                    Authorization: `Bearer ${this.openaiApiKey}`,
                    "Content-Type": "application/json",
                    ...(useStreaming ? { Accept: "text/event-stream" } : {}),
                };
                const body = buildBody(includeReasoningEffort, tokenMultiplier) as Record<
                    string,
                    unknown
                >;
                if (useStreaming) {
                    body.stream = true;
                    // OpenAI emits token usage for a streamed completion only when
                    // requested. The final usage-only chunk keeps the page token meter
                    // and the output-runaway guard accurate.
                    body.stream_options = { include_usage: true };
                }
                let response: Response;
                try {
                    response = await fetch(OPENAI_CHAT_COMPLETIONS_ENDPOINT, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                } catch (error) {
                    throw attachAttemptUsageToError(error, {
                        systemText,
                        userText,
                        isPage: isPageTranslation,
                    });
                }
                if (!useStreaming || !response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    const rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                    return {
                        response,
                        payload,
                        tokenUsage: finalizeAttemptTokenUsage(extractOpenAiTokenUsage(payload), {
                            systemText,
                            userText,
                            rawOutput,
                            isPage: isPageTranslation,
                        }),
                    };
                }
                let accumulated = "";
                let finishReason = "";
                let usage: any = null;
                try {
                    await consumeSseStream(response, (data) => {
                        try {
                            const json = JSON.parse(data);
                            const choice = json.choices?.[0];
                            const delta = choice?.delta?.content ?? choice?.message?.content;
                            if (delta) {
                                accumulated += String(delta);
                                try {
                                    options.onProgress?.(accumulated);
                                } catch {
                                    /* noop */
                                }
                            }
                            if (choice?.finish_reason) finishReason = String(choice.finish_reason);
                            if (json.usage) usage = json.usage;
                        } catch {
                            /* skip malformed event */
                        }
                    });
                } catch (error) {
                    const actual = usage ? extractOpenAiTokenUsage({ usage }) : undefined;
                    if (actual && error && typeof error === "object") {
                        (error as any).tokenUsage = actual;
                    }
                    throw attachAttemptUsageToError(error, {
                        systemText,
                        userText,
                        rawOutput: accumulated,
                        isPage: isPageTranslation,
                    });
                }
                const payload = {
                    choices: [
                        {
                            message: { content: accumulated },
                            finish_reason: finishReason,
                        },
                    ],
                    ...(usage ? { usage } : {}),
                };
                return {
                    response,
                    payload,
                    tokenUsage: finalizeAttemptTokenUsage(extractOpenAiTokenUsage(payload), {
                        systemText,
                        userText,
                        rawOutput: accumulated,
                        isPage: isPageTranslation,
                    }),
                };
            };

            let includeReasoningConfig = true;
            let firstAttempt = await requestPayload(includeReasoningConfig, 4);
            let { response, payload } = firstAttempt;
            let tokenUsage = firstAttempt.tokenUsage;
            if (
                !response.ok &&
                reasoningEffort &&
                this.shouldRetryOpenAiWithoutReasoningConfig(payload)
            ) {
                includeReasoningConfig = false;
                const retry = await requestPayload(includeReasoningConfig, 4);
                tokenUsage = mergeTokenUsage(tokenUsage, retry.tokenUsage);
                ({ response, payload } = retry);
            }
            if (!response.ok) {
                const requestError: any = new Error(
                    payload?.error?.message || `OpenAI API request failed with ${response.status}`
                );
                requestError.status = response.status;
                requestError.tokenUsage = tokenUsage;
                requestError.partialOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                throw requestError;
            }
            let rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
            let finishReason = String(payload?.choices?.[0]?.finish_reason || "");
            // Retry on true truncation (finish_reason "length") and on a streamed reply
            // that ended WITHOUT any finish_reason — an SSE stream cut mid-generation
            // (proxy drop, server error event) would otherwise pass off a truncated page
            // reply as success. A completed reply ("stop") with missing [[n]] markers is
            // NOT retried: near-deterministic at temperature 0, a full re-roll reproduces
            // the same gaps for 2x tokens, while the page pipeline already heals missing
            // markers with a missing-leaves-only request.
            const shouldRetryForCompletion =
                !isRealtimeCaption &&
                !isPageTranslation &&
                (isTruncatedPageFinishReason(finishReason) || (useStreaming && !finishReason));
            if (shouldRetryForCompletion) {
                const retry = await requestPayload(includeReasoningConfig, 8);
                tokenUsage = mergeTokenUsage(tokenUsage, retry.tokenUsage);
                if (retry.response.ok) {
                    payload = retry.payload;
                    rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                    finishReason = String(payload?.choices?.[0]?.finish_reason || "");
                }
            }
            if (
                isPageTranslation &&
                finishReason &&
                !isSuccessfulPageFinishReason(finishReason) &&
                !isTruncatedPageFinishReason(finishReason)
            ) {
                throw createPageTerminalError("OpenAI API", finishReason, tokenUsage, rawOutput);
            }
            const structured =
                !this.isRealtimeCaptionTranslation(options) &&
                isDictionaryTranslationRequest(text, options)
                    ? parseStructuredDictionaryOutput(rawOutput, text)
                    : null;
            if (structured) {
                return {
                    ...structured,
                    translatedText: structured.mainMeaning,
                    sourceLanguage: from,
                    targetLanguage: to,
                    tokenUsage,
                } as TranslationResult;
            }

            let pageOutputIncomplete =
                isPageTranslation &&
                (isTruncatedPageFinishReason(finishReason) || (useStreaming && !finishReason));
            let translated = isPageTranslation
                ? parsePageTranslationOutput(rawOutput, pageOutputIncomplete)
                : parsePlainTranslationOutput(rawOutput);
            // A truncated multi-marker page is cheaper to split in the controller. A single
            // atomic leaf has nothing to split, so only when ZERO complete prefix exists do
            // one larger-budget attempt; this is the bounded quality exception to the
            // no-full-reroll page rule.
            if (!translated && pageOutputIncomplete && countPageSegmentMarkers(text) <= 1) {
                const priorUsage = tokenUsage;
                let retry: Awaited<ReturnType<typeof requestPayload>>;
                try {
                    resetRequestDeadline();
                    retry = await requestPayload(includeReasoningConfig, 8);
                } catch (error) {
                    throw stopAfterPageRecoveryFailure(error, priorUsage);
                }
                tokenUsage = mergeTokenUsage(priorUsage, retry.tokenUsage);
                if (!retry.response.ok) {
                    const retryError: any = new Error(
                        retry.payload?.error?.message ||
                            `OpenAI API request failed with ${retry.response.status}`
                    );
                    retryError.status = retry.response.status;
                    retryError.tokenUsage = retry.tokenUsage;
                    retryError.partialOutput = this.parseOpenAiResponse(
                        retry.payload,
                        isPageTranslation
                    );
                    throw stopAfterPageRecoveryFailure(retryError, priorUsage);
                }
                payload = retry.payload;
                rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                finishReason = String(payload?.choices?.[0]?.finish_reason || "");
                if (
                    finishReason &&
                    !isSuccessfulPageFinishReason(finishReason) &&
                    !isTruncatedPageFinishReason(finishReason)
                ) {
                    throw createPageTerminalError(
                        "OpenAI API",
                        finishReason,
                        tokenUsage,
                        rawOutput
                    );
                }
                pageOutputIncomplete =
                    isTruncatedPageFinishReason(finishReason) || (useStreaming && !finishReason);
                translated = parsePageTranslationOutput(rawOutput, pageOutputIncomplete);
            }
            if (!translated) {
                if (pageOutputIncomplete) {
                    throw createPageOutputIncompleteError(
                        "OpenAI API returned no complete page segment before truncation.",
                        tokenUsage,
                        rawOutput
                    );
                }
                const emptyError: any = new Error("OpenAI API returned an empty translation.");
                emptyError.tokenUsage = tokenUsage;
                emptyError.partialOutput = rawOutput;
                throw emptyError;
            }

            return {
                originalText: text,
                mainMeaning: translated,
                sourceLanguage: from,
                targetLanguage: to,
                tokenUsage,
            } as TranslationResult;
        } catch (error: any) {
            throw {
                errorType: "API_ERR",
                errorCode:
                    error?.errorCode ||
                    (error?.name === "AbortError" ? "TIMEOUT" : "OPENAI_API_ERROR"),
                errorMsg: error?.message || "OpenAI API request failed.",
                httpStatus: Number(error?.status) || undefined,
                retryable:
                    error?.retryable === false
                        ? false
                        : isRetryableTransportError(error) &&
                          !(
                              isPageTranslation &&
                              (error?.name === "AbortError" ||
                                  countPageSegmentMarkers(error?.partialOutput || "") > 1)
                          ),
                providerRetryExhausted: error?.providerRetryExhausted === true,
                tokenUsage: error?.tokenUsage,
                partialOutput: error?.partialOutput,
                errorAct: {
                    api: "local",
                    mode: "openai",
                    model: this.openaiModel,
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async requestOpenAiCompatibleTranslation(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        let controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMsFor(options));
        const resetRequestDeadline = () => {
            clearTimeout(timeoutId);
            controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMsFor(options));
        };
        const isPageTranslation = isPageTranslationRequest(text, options);
        try {
            const isRealtimeCaption = this.isRealtimeCaptionTranslation(options);
            const systemText = this.getTranslationSystemPrompt(text, from, to, options);
            const userText = this.buildOpenAiPrompt(text, from, to, options);
            const buildBody = (tokenMultiplier = 4) => ({
                model: this.openaiCompatibleModel,
                messages: [
                    {
                        role: "system",
                        content: systemText,
                    },
                    {
                        role: "user",
                        content: userText,
                    },
                ],
                // Skip response_format JSON for openaiCompatible so local LLM servers
                // (llama-server, vLLM, TGI) that don't implement it stay compatible.
                // Cap max_tokens to fit inside a typical local server slot (~4k n_ctx per
                // slot when --parallel > 1). Floor at 512 so short selections still get
                // enough room for a complete dictionary-style response.
                max_tokens: isRealtimeCaption
                    ? Math.min(768, Math.max(128, Math.ceil(text.length * 2)))
                    : isPageTranslation
                    ? estimatePageOutputTokenBudget(
                          text,
                          tokenMultiplier,
                          tokenMultiplier >= 8 ? 512 : 256,
                          tokenMultiplier >= 8 ? 2304 : 1536
                      )
                    : Math.min(
                          tokenMultiplier >= 8 ? 3072 : 1536,
                          Math.max(512, Math.ceil(text.length * (tokenMultiplier >= 8 ? 2.5 : 1.5)))
                      ),
                temperature: 0,
                // llama.cpp / vLLM / TGI honor this; unknown servers ignore unknown fields.
                // A stable system-prompt prefix lets compatible local runtimes reuse KV
                // state when they support this extension.
                cache_prompt: true,
                // Disable chain-of-thought for translation — it's pure latency/token waste.
                // Qwen3 & friends read enable_thinking from chat_template_kwargs (vLLM/sglang/
                // llama.cpp); reasoning_effort covers servers that expose the OpenAI knob.
                // Unknown servers ignore unknown fields, and any leaked <think> is still
                // stripped from the output downstream.
                chat_template_kwargs: { enable_thinking: false },
                reasoning_effort: "low",
            });
            // Dictionary lookups produce JSON — never stream them into the panel preview.
            const useStreaming =
                typeof options.onProgress === "function" &&
                !(isDictionaryTranslationRequest(text, options) && !isRealtimeCaption);
            const requestPayload = async (tokenMultiplier = 4) => {
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                    ...(useStreaming ? { Accept: "text/event-stream" } : {}),
                };
                if (this.openaiCompatibleApiKey) {
                    headers.Authorization = `Bearer ${this.openaiCompatibleApiKey}`;
                }
                const body = buildBody(tokenMultiplier);
                if (useStreaming) (body as Record<string, unknown>).stream = true;
                let response: Response;
                try {
                    response = await fetch(this.openaiCompatibleEndpoint, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                } catch (error) {
                    throw attachAttemptUsageToError(error, {
                        systemText,
                        userText,
                        isPage: isPageTranslation,
                    });
                }
                if (!useStreaming || !response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    const rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                    return {
                        response,
                        payload,
                        tokenUsage: finalizeAttemptTokenUsage(extractOpenAiTokenUsage(payload), {
                            systemText,
                            userText,
                            rawOutput,
                            isPage: isPageTranslation,
                        }),
                    };
                }
                // Streaming path: parse SSE deltas, accumulate text, surface progress.
                let accumulated = "";
                let finishReason = "";
                let usage: any = null;
                try {
                    await consumeSseStream(response, (data) => {
                        try {
                            const json = JSON.parse(data);
                            const choice = json.choices?.[0];
                            const delta = choice?.delta?.content ?? choice?.message?.content;
                            if (delta) {
                                accumulated += String(delta);
                                try {
                                    // Surface the reasoning-stripped text so a thinking
                                    // model's <think> stream doesn't flash in the panel.
                                    options.onProgress?.(stripReasoningArtifacts(accumulated));
                                } catch {
                                    /* ignore listener errors */
                                }
                            }
                            if (choice?.finish_reason) finishReason = String(choice.finish_reason);
                            if (json.usage) usage = json.usage;
                        } catch {
                            /* malformed SSE event — skip */
                        }
                    });
                } catch (error) {
                    const actual = usage ? extractOpenAiTokenUsage({ usage }) : undefined;
                    if (actual && error && typeof error === "object") {
                        (error as any).tokenUsage = actual;
                    }
                    throw attachAttemptUsageToError(error, {
                        systemText,
                        userText,
                        rawOutput: accumulated,
                        isPage: isPageTranslation,
                    });
                }
                // Synthesize a payload object compatible with the non-streaming code path below.
                const payload = {
                    choices: [
                        {
                            message: { content: accumulated },
                            finish_reason: finishReason,
                        },
                    ],
                    ...(usage ? { usage } : {}),
                };
                return {
                    response,
                    payload,
                    tokenUsage: finalizeAttemptTokenUsage(extractOpenAiTokenUsage(payload), {
                        systemText,
                        userText,
                        rawOutput: accumulated,
                        isPage: isPageTranslation,
                    }),
                };
            };

            const firstAttempt = await requestPayload(4);
            let { response, payload } = firstAttempt;
            let tokenUsage = firstAttempt.tokenUsage;
            if (!response.ok) {
                const requestError: any = new Error(
                    payload?.error?.message ||
                        `OpenAI-compatible API request failed with ${response.status}`
                );
                requestError.status = response.status;
                requestError.tokenUsage = tokenUsage;
                requestError.partialOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                throw requestError;
            }
            let rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
            let finishReason = String(payload?.choices?.[0]?.finish_reason || "");
            // Truncation retry (+ streamed replies that ended with NO finish_reason — an
            // SSE cut mid-generation, common on local servers under load). Marker gaps in
            // COMPLETED replies are healed by the page pipeline's missing-leaves-only
            // re-request, not a full re-roll.
            const shouldRetryForCompletion =
                !isRealtimeCaption &&
                !isPageTranslation &&
                (isTruncatedPageFinishReason(finishReason) || (useStreaming && !finishReason));
            if (shouldRetryForCompletion) {
                const retry = await requestPayload(8);
                tokenUsage = mergeTokenUsage(tokenUsage, retry.tokenUsage);
                if (retry.response.ok) {
                    payload = retry.payload;
                    rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                    finishReason = String(payload?.choices?.[0]?.finish_reason || "");
                }
            }
            if (
                isPageTranslation &&
                finishReason &&
                !isSuccessfulPageFinishReason(finishReason) &&
                !isTruncatedPageFinishReason(finishReason)
            ) {
                throw createPageTerminalError(
                    "OpenAI-compatible API",
                    finishReason,
                    tokenUsage,
                    rawOutput
                );
            }
            const structured =
                !this.isRealtimeCaptionTranslation(options) &&
                isDictionaryTranslationRequest(text, options)
                    ? parseStructuredDictionaryOutput(rawOutput, text)
                    : null;
            if (structured) {
                return {
                    ...structured,
                    translatedText: structured.mainMeaning,
                    sourceLanguage: from,
                    targetLanguage: to,
                    tokenUsage,
                } as TranslationResult;
            }

            let pageOutputIncomplete =
                isPageTranslation &&
                (isTruncatedPageFinishReason(finishReason) || (useStreaming && !finishReason));
            let translated = isPageTranslation
                ? parsePageTranslationOutput(rawOutput, pageOutputIncomplete)
                : parsePlainTranslationOutput(rawOutput);
            if (!translated && pageOutputIncomplete && countPageSegmentMarkers(text) <= 1) {
                const priorUsage = tokenUsage;
                let retry: Awaited<ReturnType<typeof requestPayload>>;
                try {
                    resetRequestDeadline();
                    retry = await requestPayload(8);
                } catch (error) {
                    throw stopAfterPageRecoveryFailure(error, priorUsage);
                }
                tokenUsage = mergeTokenUsage(priorUsage, retry.tokenUsage);
                if (!retry.response.ok) {
                    const retryError: any = new Error(
                        retry.payload?.error?.message ||
                            `OpenAI-compatible API request failed with ${retry.response.status}`
                    );
                    retryError.status = retry.response.status;
                    retryError.tokenUsage = retry.tokenUsage;
                    retryError.partialOutput = this.parseOpenAiResponse(
                        retry.payload,
                        isPageTranslation
                    );
                    throw stopAfterPageRecoveryFailure(retryError, priorUsage);
                }
                payload = retry.payload;
                rawOutput = this.parseOpenAiResponse(payload, isPageTranslation);
                finishReason = String(payload?.choices?.[0]?.finish_reason || "");
                if (
                    finishReason &&
                    !isSuccessfulPageFinishReason(finishReason) &&
                    !isTruncatedPageFinishReason(finishReason)
                ) {
                    throw createPageTerminalError(
                        "OpenAI-compatible API",
                        finishReason,
                        tokenUsage,
                        rawOutput
                    );
                }
                pageOutputIncomplete =
                    isTruncatedPageFinishReason(finishReason) || (useStreaming && !finishReason);
                translated = parsePageTranslationOutput(rawOutput, pageOutputIncomplete);
            }
            if (!translated) {
                if (pageOutputIncomplete) {
                    throw createPageOutputIncompleteError(
                        "OpenAI-compatible API returned no complete page segment before truncation.",
                        tokenUsage,
                        rawOutput
                    );
                }
                const emptyError: any = new Error(
                    "OpenAI-compatible API returned an empty translation."
                );
                emptyError.tokenUsage = tokenUsage;
                emptyError.partialOutput = rawOutput;
                throw emptyError;
            }

            return {
                originalText: text,
                mainMeaning: translated,
                sourceLanguage: from,
                targetLanguage: to,
                tokenUsage,
            } as TranslationResult;
        } catch (error: any) {
            throw {
                errorType: "API_ERR",
                errorCode:
                    error?.errorCode ||
                    (error?.name === "AbortError" ? "TIMEOUT" : "OPENAI_COMPATIBLE_API_ERROR"),
                errorMsg: error?.message || "OpenAI-compatible API request failed.",
                httpStatus: Number(error?.status) || undefined,
                retryable:
                    error?.retryable === false
                        ? false
                        : isRetryableTransportError(error) &&
                          !(
                              isPageTranslation &&
                              (error?.name === "AbortError" ||
                                  countPageSegmentMarkers(error?.partialOutput || "") > 1)
                          ),
                providerRetryExhausted: error?.providerRetryExhausted === true,
                tokenUsage: error?.tokenUsage,
                partialOutput: error?.partialOutput,
                errorAct: {
                    api: "local",
                    mode: "openaiCompatible",
                    model: this.openaiCompatibleModel,
                    baseUrl: this.openaiCompatibleBaseUrl,
                    action: "translate",
                    text,
                    from,
                    to,
                },
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    pronounce() {
        return Promise.reject(new Error("Local translator does not support TTS."));
    }

    stopPronounce() {}
}

export default LocalTranslator;
