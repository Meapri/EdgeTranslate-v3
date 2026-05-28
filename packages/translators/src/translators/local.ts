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
     * UI updates. When omitted, the request runs without streaming (legacy behavior).
     */
    onProgress?: (accumulatedText: string) => void;
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
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_GOOGLE_AI_STUDIO_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_COMPATIBLE_MODEL = "gpt-oss-20b";
const DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL = "auto";
const DEFAULT_OPENAI_REASONING_EFFORT = "auto";
const LOCAL_TRANSLATOR_PROMPT_VERSION = "local-prompt-2026-05-28-balanced-v1";
const GOOGLE_AI_STUDIO_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const AI_TRANSLATION_SYSTEM_PROMPT = [
    "You are a high-fidelity translation engine. Translate faithfully and naturally into the target language, preserving meaning, tone, register, nuance, and the original voice.",
    "Output ONLY the translation — or only the exact JSON object when JSON is requested. No notes, no labels, no Markdown, no commentary.",
    "Preserve every structural token exactly: line breaks, whitespace, placeholders, URLs, file paths, code spans, numbers, dates, IDs, and formatting markup. Never invent or drop them.",
    "Preserve proper nouns and official names by default (people, brands, products, models, places, technical identifiers). Use a localized form only when it is clearly the established convention. Do not phoneticize, gloss, or split named entities; keep official Latin-script names and casing as written.",
    "For long or batched text, keep terminology and named-entity choices consistent across the entire output. Avoid mojibake, repeated syllables, source-language leftovers, and prompt leakage.",
    "For inline link placeholders shaped like [[EDGE_TRANSLATE_LINK_1]]…[[/EDGE_TRANSLATE_LINK_1]], copy both bracket tags exactly (keep the same number) and translate only the visible text between them as part of the surrounding sentence.",
].join(" ");

// PAGE prompt: pages arrive as HTML where each text node is wrapped in <t i="N">…</t>,
// possibly inside other inline tags (<strong>, <a>, <em>, …). The model must translate only
// the text inside <t> wrappers and preserve every other tag and attribute exactly.
const PAGE_TRANSLATION_SYSTEM_PROMPT = [
    "You translate web page segments. Each segment starts with a [[n:r]] marker on its own line, followed by HTML content.",
    "Keep every [[n:r]] marker exactly once, in the original order, with the same number and role.",
    'Inside each segment, translate ONLY the text between <t i="N"> and </t> tags. Keep every <t i="N">…</t> wrapper exactly, including its i="N" attribute and matching number. Do not merge, split, drop, reorder, or invent wrappers.',
    "Preserve any other HTML tags (<strong>, <em>, <a>, <b>, <i>, <span>, …) exactly as written. Preserve URLs, code, numbers, IDs, and proper nouns.",
    "Output only the [[n:r]] markers and their translated HTML segments. No Markdown wrapping, no commentary.",
].join(" ");

const REALTIME_CAPTION_SYSTEM_PROMPT = [
    "You are a subtitle translator. Output only the translation in the target language, concise and natural.",
    "Preserve cue numbers, timestamps, speaker labels, names, and numeric literals exactly as in the source.",
].join(" ");

const DICTIONARY_OUTPUT_INSTRUCTION = [
    "Dictionary task: the input is a single word or short term. Return one valid JSON object only, with this exact shape:",
    '{"translation":"...","detailedMeanings":[{"pos":"...","meaning":"...","synonyms":["..."]}],"definitions":[{"pos":"...","meaning":"...","example":"...","synonyms":["..."]}],"examples":[{"source":"...","target":"..."}]}',
    "Write translation, meanings, definitions, and target examples in the target language; keep source examples in the source language.",
    "For ordinary terms, provide at least one detailedMeaning, one definition, and two examples. Use an empty array when a field truly does not apply. No Markdown around the JSON.",
].join(" ");

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
        for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            onEvent(payload);
        }
    };
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
                flushBlock(buffer.slice(0, sep));
                buffer = buffer.slice(sep + 2);
            }
        }
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
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            const msg = error?.errorMsg || error?.message || "";
            const isRetryable = /429|500|502|503|rate/i.test(msg);
            if (!isRetryable || attempt === maxRetries) throw error;
            await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
        }
    }
    throw lastError;
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

function normalizeGoogleAiStudioReasoningLevel(value: string | undefined) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase();
    if (["auto", "none", "minimal", "low", "medium", "high"].includes(normalized)) {
        return normalized;
    }
    return DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL;
}

function normalizeOpenAiReasoningEffort(value: string | undefined) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase();
    if (["auto", "none", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
        return normalized;
    }
    return DEFAULT_OPENAI_REASONING_EFFORT;
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
    for (const [key, value] of Object.entries(usage) as Array<
        [keyof TranslationTokenUsage, number | undefined]
    >) {
        const numeric = Number(value || 0);
        if (Number.isFinite(numeric) && numeric > 0) cleaned[key] = numeric;
    }
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
    });
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
        /\[\[\d+:[a-z][a-z0-9-]*]]/.test(trimmed) ||
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

function countPageSegmentMarkers(text: string) {
    const matches = String(text || "").match(
        /\[\[\d+:[a-z][a-z0-9-]*]]|<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/g
    );
    return matches ? matches.length : 0;
}

function hasPageTranslationSegments(text: string) {
    return countPageSegmentMarkers(text) > 0;
}

function buildOpenAiCompletionLimit(model: string, tokenBudget: number) {
    const budget = Math.max(16, Math.ceil(tokenBudget));
    if (/^gpt-5/i.test(model || "")) {
        return { max_completion_tokens: budget };
    }
    return { max_tokens: budget };
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
    private reasoningLevel = DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL;
    private openaiApiKey = "";
    private openaiModel = DEFAULT_OPENAI_MODEL;
    private openaiReasoningEffort = DEFAULT_OPENAI_REASONING_EFFORT;
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
        this.reasoningLevel = normalizeGoogleAiStudioReasoningLevel(config.reasoningLevel);
        this.openaiApiKey = (config.openaiApiKey || "").trim();
        this.openaiModel = normalizeModel(config.openaiModel, DEFAULT_OPENAI_MODEL);
        this.openaiReasoningEffort = normalizeOpenAiReasoningEffort(config.openaiReasoningEffort);
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
        if (existing) return existing;

        const request = localRequestLimiter
            .run(() => this.requestTranslation(text, from, to, options))
            .then((result) => {
                this.cache.set(key, result);
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

    private async requestTranslation(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        if (this.mode === "chromeBuiltin") {
            return this.requestChromeBuiltinTranslation(text, from, to);
        }
        if (this.mode === "googleAiStudio") {
            return retryWithBackoff(() =>
                this.requestGoogleAiStudioTranslation(text, from, to, options)
            );
        }
        if (this.mode === "openai") {
            return retryWithBackoff(() => this.requestOpenAiTranslation(text, from, to, options));
        }
        if (this.mode === "openaiCompatible") {
            return retryWithBackoff(() =>
                this.requestOpenAiCompatibleTranslation(text, from, to, options)
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
        if (this.isRealtimeCaptionBatchTranslation(options)) {
            return this.buildRealtimeCaptionBatchPrompt(text, from, to);
        }
        if (this.isRealtimeCaptionTranslation(options)) {
            return this.buildRealtimeCaptionPrompt(text, from, to);
        }
        // All instructions, language directives, and the script rule live in the system prompt
        // (see getTranslationSystemPrompt). The user message contains ONLY the text to translate
        // so the model never confuses meta-instructions for content to render in the output.
        return text;
    }

    private buildOpenAiPrompt(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        return this.buildGoogleAiStudioPrompt(text, from, to, options);
    }

    private getTranslationSystemPrompt(
        text: string,
        from: string = "",
        to: string = "",
        options: LocalTranslationOptions = {}
    ) {
        if (this.isRealtimeCaptionTranslation(options)) return REALTIME_CAPTION_SYSTEM_PROMPT;
        const base = hasPageTranslationSegments(text)
            ? PAGE_TRANSLATION_SYSTEM_PROMPT
            : AI_TRANSLATION_SYSTEM_PROMPT;
        // Append the per-request directives. Putting them in the system prompt (rather than the
        // user message) keeps the user message a clean payload — the model can't echo these into
        // its translation output.
        const sourceLanguage = from ? toLanguageName(from) : "";
        const targetLanguage = to ? toLanguageName(to) : "";
        const scriptRule = to ? getScriptConstraint(to) : "";
        const dictionaryInstruction =
            !this.isRealtimeCaptionTranslation(options) && isDictionaryCandidate(text)
                ? DICTIONARY_OUTPUT_INSTRUCTION
                : "";
        const dynamic = [
            sourceLanguage ? `Source language: ${sourceLanguage}.` : "",
            targetLanguage ? `Target language: ${targetLanguage}.` : "",
            scriptRule,
            dictionaryInstruction,
        ]
            .filter(Boolean)
            .join(" ");
        return dynamic ? `${base} ${dynamic}` : base;
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

    private parseOpenAiResponse(payload: any) {
        return extractOpenAIResponseText(payload);
    }

    private getGoogleAiStudioCompatibilityModes(options: LocalTranslationOptions = {}) {
        if (this.shouldStartGoogleAiStudioWithBareRequest(options)) {
            return ["bare", "minimal"] as const;
        }
        return ["minimal", "bare"] as const;
    }

    private shouldStartGoogleAiStudioWithBareRequest(options: LocalTranslationOptions = {}) {
        if (this.buildGoogleAiStudioThinkingConfig(options)) return false;
        const model = this.model.toLowerCase();
        return /^gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:$|-)/.test(model);
    }

    private shouldAvoidGoogleAiStudioOutputLimit() {
        return /^gemini-3(?:\.|-|$)/i.test(this.model);
    }

    private isGemini3Model() {
        return /^gemini-(?:3(?:\.|-)|flash-latest|flash-lite-latest|pro-latest)/i.test(this.model);
    }

    private isGemini3ProModel() {
        return /^gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:$|-)/i.test(this.model);
    }

    private isGemini3FlashModel() {
        return /^gemini-(?:3(?:\.\d+)?-flash|3(?:\.\d+)?-flash-lite|flash-latest|flash-lite-latest)(?:$|-)/i.test(
            this.model
        );
    }

    private isGemini25Model() {
        return /^gemini-2\.5/i.test(this.model);
    }

    private isGemini25ProModel() {
        return /^gemini-2\.5-pro(?:$|-)/i.test(this.model);
    }

    private getEffectiveGoogleAiStudioReasoningLevel(options: LocalTranslationOptions = {}) {
        if (!this.isRealtimeCaptionTranslation(options)) return this.reasoningLevel;
        if (this.isGemini3ProModel()) return "low";
        if (this.isGemini3FlashModel()) return "minimal";
        if (this.isGemini25Model()) return this.isGemini25ProModel() ? "low" : "none";
        return "auto";
    }

    private buildGoogleAiStudioThinkingConfig(options: LocalTranslationOptions = {}) {
        const level = this.getEffectiveGoogleAiStudioReasoningLevel(options);
        if (level === "auto") return undefined;
        if (this.isGemini3Model()) {
            if (this.isGemini3ProModel()) {
                if (level !== "low" && level !== "high") return undefined;
                return { thinkingLevel: level };
            }
            if (this.isGemini3FlashModel()) {
                if (!["minimal", "low", "medium", "high"].includes(level)) return undefined;
                return { thinkingLevel: level };
            }
            return undefined;
        }
        if (!this.isGemini25Model()) return undefined;

        if (level === "none") {
            return this.isGemini25ProModel() ? undefined : { thinkingBudget: 0 };
        }
        const budgetByLevel: Record<string, number> = {
            minimal: 1024,
            low: 1024,
            medium: 8192,
            high: 24576,
        };
        const thinkingBudget = budgetByLevel[level];
        return typeof thinkingBudget === "number" ? { thinkingBudget } : undefined;
    }

    private buildGoogleAiStudioGenerationConfig(
        inputLength?: number,
        compatibilityMode: "minimal" | "bare" = "minimal",
        options: LocalTranslationOptions = {}
    ) {
        if (compatibilityMode === "bare") return undefined;
        const config: Record<string, any> = { temperature: 0 };
        const thinkingConfig = this.buildGoogleAiStudioThinkingConfig(options);
        if (thinkingConfig) config.thinkingConfig = thinkingConfig;
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const isRealtimeCaption = this.isRealtimeCaptionTranslation(options);
            const model = encodeURIComponent(this.model);
            const useStreaming = typeof options.onProgress === "function";
            const requestPayload = async (compatibilityMode: "minimal" | "bare") => {
                const generationConfig = this.buildGoogleAiStudioGenerationConfig(
                    text.length,
                    compatibilityMode,
                    options
                );
                const body: Record<string, any> = {
                    systemInstruction: {
                        parts: [{ text: this.getTranslationSystemPrompt(text, from, to, options) }],
                    },
                    contents: [
                        {
                            role: "user",
                            parts: [
                                {
                                    text: this.buildGoogleAiStudioPrompt(text, from, to, options),
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
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(useStreaming ? { Accept: "text/event-stream" } : {}),
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!useStreaming) {
                    const payload = await response.json().catch(() => ({}));
                    if (!response.ok) {
                        const error: any = new Error(
                            payload?.error?.message ||
                                `Google AI Studio request failed with ${response.status}`
                        );
                        error.status = response.status;
                        throw error;
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
                    throw error;
                }
                // Streaming SSE: each event is a partial candidate; assemble incrementally.
                let accumulated = "";
                let finishReason = "";
                let usageMetadata: any = null;
                let lastCandidate: any = null;
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
                            if (candidate.finishReason) finishReason = String(candidate.finishReason);
                        }
                        if (json.usageMetadata) usageMetadata = json.usageMetadata;
                    } catch {
                        /* skip malformed event */
                    }
                });
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
            const compatibilityModes = this.getGoogleAiStudioCompatibilityModes(options);
            for (let index = 0; index < compatibilityModes.length; index += 1) {
                const mode = compatibilityModes[index];
                const isLastMode = index === compatibilityModes.length - 1;
                try {
                    payload = await requestPayload(mode);
                    tokenUsage = mergeTokenUsage(
                        tokenUsage,
                        extractGoogleAiStudioTokenUsage(payload)
                    );
                    if (this.isGoogleAiStudioTruncatedPayload(payload) && !isLastMode) {
                        continue;
                    }
                    if (!this.parseGoogleAiStudioResponse(payload) && !isLastMode) {
                        continue;
                    }
                    break;
                } catch (error) {
                    const canRetry =
                        !isLastMode && this.shouldRetryGoogleAiStudioWithCompatibilityConfig(error);
                    if (!canRetry) throw error;
                }
            }

            const rawOutput = this.parseGoogleAiStudioResponse(payload);
            const structured =
                !isRealtimeCaption && isDictionaryCandidate(text)
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

            let translated = parsePlainTranslationOutput(rawOutput);
            if (!translated) {
                throw new Error("Google AI Studio returned an empty translation.");
            }
            try {
                if (this.isRealtimeCaptionTranslation(options)) {
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
                errorCode: error?.name === "AbortError" ? "TIMEOUT" : "GOOGLE_AI_STUDIO_ERROR",
                errorMsg: error?.message || "Google AI Studio request failed.",
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
        if (this.isRealtimeCaptionTranslation(options)) {
            if (!this.shouldUseOpenAiReasoningEffort()) return "";
            if (/^gpt-5(?:\.\d+)?-pro(?:$|-)/i.test(this.openaiModel)) return "high";
            if (/^gpt-5\.(?:[1-9]|\d{2,})(?:$|-)/i.test(this.openaiModel)) return "none";
            if (/^gpt-5/i.test(this.openaiModel)) return "minimal";
            return "low";
        }
        if (this.openaiReasoningEffort === "auto") return "";
        if (!this.shouldUseOpenAiReasoningEffort()) return "";
        if (/^gpt-5(?:\.\d+)?-pro(?:$|-)/i.test(this.openaiModel)) {
            return this.openaiReasoningEffort === "high" ? "high" : "";
        }
        if (/^gpt-5\.(?:[2-9]|\d{2,})(?:$|-)/i.test(this.openaiModel)) {
            return ["none", "low", "medium", "high", "xhigh"].includes(this.openaiReasoningEffort)
                ? this.openaiReasoningEffort
                : "";
        }
        if (/^gpt-5\.1-codex-max(?:$|-)/i.test(this.openaiModel)) {
            return ["none", "medium", "high", "xhigh"].includes(this.openaiReasoningEffort)
                ? this.openaiReasoningEffort
                : "";
        }
        if (/^gpt-5\.1(?:$|-)/i.test(this.openaiModel)) {
            return ["none", "low", "medium", "high"].includes(this.openaiReasoningEffort)
                ? this.openaiReasoningEffort
                : "";
        }
        if (/^gpt-5/i.test(this.openaiModel)) {
            return ["minimal", "low", "medium", "high"].includes(this.openaiReasoningEffort)
                ? this.openaiReasoningEffort
                : "";
        }
        return ["low", "medium", "high", "xhigh"].includes(this.openaiReasoningEffort)
            ? this.openaiReasoningEffort
            : "";
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const isRealtimeCaption = this.isRealtimeCaptionTranslation(options);
            const reasoningEffort = this.getOpenAiReasoningEffort(options);
            const expectedPageSegments = countPageSegmentMarkers(text);
            const buildBody = (includeReasoningEffort = true, tokenMultiplier = 4) => ({
                model: this.openaiModel,
                messages: [
                    {
                        role: "system",
                        content: this.getTranslationSystemPrompt(text, from, to, options),
                    },
                    {
                        role: "user",
                        content: this.buildOpenAiPrompt(text, from, to, options),
                    },
                ],
                ...(!isRealtimeCaption && isDictionaryCandidate(text)
                    ? { response_format: { type: "json_object" } }
                    : {}),
                ...(includeReasoningEffort && reasoningEffort
                    ? { reasoning_effort: reasoningEffort }
                    : {}),
                ...buildOpenAiCompletionLimit(
                    this.openaiModel,
                    isRealtimeCaption
                        ? Math.max(96, text.length * 2)
                        : Math.max(
                              512 * Math.max(1, tokenMultiplier / 4),
                              Math.ceil(text.length * (tokenMultiplier >= 8 ? 3 : 2))
                          )
                ),
            });
            // Streaming is incompatible with response_format JSON (used for dictionary entries).
            const useStreaming =
                typeof options.onProgress === "function" &&
                !(isDictionaryCandidate(text) && !isRealtimeCaption);
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
                if (useStreaming) body.stream = true;
                const response = await fetch(OPENAI_CHAT_COMPLETIONS_ENDPOINT, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!useStreaming || !response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    return { response, payload };
                }
                let accumulated = "";
                let finishReason = "";
                let usage: any = null;
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
                const payload = {
                    choices: [
                        {
                            message: { content: accumulated },
                            finish_reason: finishReason,
                        },
                    ],
                    ...(usage ? { usage } : {}),
                };
                return { response, payload };
            };

            let includeReasoningConfig = true;
            let { response, payload } = await requestPayload(includeReasoningConfig, 4);
            if (
                !response.ok &&
                reasoningEffort &&
                this.shouldRetryOpenAiWithoutReasoningConfig(payload)
            ) {
                includeReasoningConfig = false;
                ({ response, payload } = await requestPayload(includeReasoningConfig, 4));
            }
            if (!response.ok) {
                throw new Error(
                    payload?.error?.message || `OpenAI API request failed with ${response.status}`
                );
            }
            let tokenUsage = extractOpenAiTokenUsage(payload);
            let rawOutput = this.parseOpenAiResponse(payload);
            const outputSegments = countPageSegmentMarkers(rawOutput);
            const finishReason = String(payload?.choices?.[0]?.finish_reason || "");
            const shouldRetryForCompletion =
                !isRealtimeCaption &&
                (finishReason === "length" ||
                    (expectedPageSegments > 0 && outputSegments < expectedPageSegments));
            if (shouldRetryForCompletion) {
                const retry = await requestPayload(includeReasoningConfig, 8);
                if (retry.response.ok) {
                    tokenUsage = mergeTokenUsage(
                        tokenUsage,
                        extractOpenAiTokenUsage(retry.payload)
                    );
                    payload = retry.payload;
                    rawOutput = this.parseOpenAiResponse(payload);
                }
            }
            const structured =
                !this.isRealtimeCaptionTranslation(options) && isDictionaryCandidate(text)
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

            const translated = parsePlainTranslationOutput(rawOutput);
            if (!translated) {
                throw new Error("OpenAI API returned an empty translation.");
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
                errorCode: error?.name === "AbortError" ? "TIMEOUT" : "OPENAI_API_ERROR",
                errorMsg: error?.message || "OpenAI API request failed.",
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const isRealtimeCaption = this.isRealtimeCaptionTranslation(options);
            const expectedPageSegments = countPageSegmentMarkers(text);
            const buildBody = (tokenMultiplier = 4) => ({
                model: this.openaiCompatibleModel,
                messages: [
                    {
                        role: "system",
                        content: this.getTranslationSystemPrompt(text, from, to, options),
                    },
                    {
                        role: "user",
                        content: this.buildOpenAiPrompt(text, from, to, options),
                    },
                ],
                // Remove response_format JSON block for openaiCompatible to ensure high compatibility with local LLM servers (like llama-server).
                // Cap max_tokens to fit inside a typical local server slot (~4k n_ctx per slot when --parallel > 1).
                max_tokens: isRealtimeCaption
                    ? Math.min(768, Math.max(128, Math.ceil(text.length * 2)))
                    : Math.min(
                          tokenMultiplier >= 8 ? 3072 : 1536,
                          Math.max(
                              384,
                              Math.ceil(text.length * (tokenMultiplier >= 8 ? 2.5 : 1.5))
                          )
                      ),
                temperature: 0,
                // llama.cpp / vLLM / TGI honor this; unknown servers ignore unknown fields.
                // Enables KV-cache reuse for the (identical-across-requests) system prompt prefix,
                // which makes prefill 5–10x cheaper on each concurrent request.
                cache_prompt: true,
            });
            const useStreaming = typeof options.onProgress === "function";
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
                const response = await fetch(this.openaiCompatibleEndpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!useStreaming || !response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    return { response, payload };
                }
                // Streaming path: parse SSE deltas, accumulate text, surface progress.
                let accumulated = "";
                let finishReason = "";
                let usage: any = null;
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
                                /* ignore listener errors */
                            }
                        }
                        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
                        if (json.usage) usage = json.usage;
                    } catch {
                        /* malformed SSE event — skip */
                    }
                });
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
                return { response, payload };
            };

            let { response, payload } = await requestPayload(4);
            if (!response.ok) {
                throw new Error(
                    payload?.error?.message ||
                        `OpenAI-compatible API request failed with ${response.status}`
                );
            }
            let tokenUsage = extractOpenAiTokenUsage(payload);
            let rawOutput = this.parseOpenAiResponse(payload);
            const outputSegments = countPageSegmentMarkers(rawOutput);
            const finishReason = String(payload?.choices?.[0]?.finish_reason || "");
            const shouldRetryForCompletion =
                !isRealtimeCaption &&
                (finishReason === "length" ||
                    (expectedPageSegments > 0 && outputSegments < expectedPageSegments));
            if (shouldRetryForCompletion) {
                const retry = await requestPayload(8);
                if (retry.response.ok) {
                    tokenUsage = mergeTokenUsage(
                        tokenUsage,
                        extractOpenAiTokenUsage(retry.payload)
                    );
                    payload = retry.payload;
                    rawOutput = this.parseOpenAiResponse(payload);
                }
            }
            const structured =
                !this.isRealtimeCaptionTranslation(options) && isDictionaryCandidate(text)
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

            const translated = parsePlainTranslationOutput(rawOutput);
            if (!translated) {
                throw new Error("OpenAI-compatible API returned an empty translation.");
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
                    error?.name === "AbortError" ? "TIMEOUT" : "OPENAI_COMPATIBLE_API_ERROR",
                errorMsg: error?.message || "OpenAI-compatible API request failed.",
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
