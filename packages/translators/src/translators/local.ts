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
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_GOOGLE_AI_STUDIO_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_COMPATIBLE_MODEL = "gpt-oss-20b";
const DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL = "auto";
const DEFAULT_OPENAI_REASONING_EFFORT = "auto";
const LOCAL_TRANSLATOR_PROMPT_VERSION = "local-prompt-2026-05-25-youtube-caption-natural-v3";
const GOOGLE_AI_STUDIO_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const AI_TRANSLATION_SYSTEM_PROMPT = [
    "Translate as a high-fidelity translation engine: preserve meaning, tone, intent, nuance, register, rhythm, emotional progression, local context, and character voice while producing natural target-language prose.",
    "Output only the translation, or only the exact JSON object when JSON is requested. Do not add notes, alternatives, labels, Markdown, or process narration.",
    "Work zero-shot. Do not invent examples, do not add priming text, do not turn the task into a lesson, and do not mention your reasoning.",
    "Separate structural metadata from human-language payload before translating. Preserve only structures that are present in the input: subtitle cue numbers, timestamps, cue order, block boundaries, line breaks, speaker labels, tags, escaped entities, markup, tables, keys, placeholders, code spans, URLs, file paths, commands, and formatting tokens. Never invent subtitle cues or timestamps.",
    "Preserve numeric literals, dates, times, measurements, versions, ratings, prices, percentages, ranges, IDs, model names, product names, file names, and issue numbers exactly unless the target language has a required conventional format.",
    "Preserve proper nouns by default: personal names, organizations, brands, services, places, titles, works, events, laws, standards, model names, technical terms, and account names. Use a standard established target-language form only when it is clearly conventional in context.",
    "Do not phoneticize, respell, translate, explain, split, or normalize unfamiliar names, dates, numbers, brands, services, product names, model IDs, or technical identifiers. Keep official Latin-script names and casing as written unless the source already gives a localized form.",
    "Translate only human-language payload. Resolve ambiguity conservatively from local context, keeping subtext, irony, politeness, technical precision, humor, vulgarity, fragments, interruptions, and intentional odd phrasing.",
    "For webpage/page-translation segments, keep every segment marker exactly once, preserve segment order, translate each segment as part of the same article context, and never merge, drop, duplicate, or invent segments. Use neighboring segments for terminology, referents, tone, and named-entity consistency only.",
    "For long webpage text, prefer polished complete sentences in the target language. Keep repeated names and domain terms consistent across the batch. Avoid mojibake, random glyphs, repeated syllables, source-language leftovers, prompt leakage, and half-translated fragments.",
    "Keep inline-boundary spacing natural around links and emphasized text. Do not glue unrelated words across hyperlink boundaries unless the target language convention clearly requires it.",
    "For webpage link placeholders like [[EDGE_TRANSLATE_LINK_1]]text[[/EDGE_TRANSLATE_LINK_1]], preserve the opening and closing placeholders exactly, translate the visible text naturally, and write the surrounding sentence as one fluent sentence.",
].join(" ");

const PAGE_TRANSLATION_SYSTEM_PROMPT = [
    "Translate page segments only.",
    "Keep every [[n:r]] marker once, same order.",
    "Keep each segment's payload line count.",
    "Preserve placeholders, URLs, code, numbers, IDs, link markers, and official names.",
    "Output only the translation.",
].join(" ");

const REALTIME_CAPTION_SYSTEM_PROMPT =
    "You are a subtitle translator. Return only translated subtitles.";

const DICTIONARY_OUTPUT_INSTRUCTION = [
    "Dictionary task: this input is a single word or short term. Return only one valid JSON object with this exact shape:",
    '{"translation":"...","detailedMeanings":[{"pos":"...","meaning":"...","synonyms":["..."]}],"definitions":[{"pos":"...","meaning":"...","example":"...","synonyms":["..."]}],"examples":[{"source":"...","target":"..."}]}',
    "Use the target language for translation, meanings, definitions, and translated examples. Keep source examples in the source language. For ordinary dictionary terms, provide at least one detailedMeaning, one definition, and two examples whenever possible. If a field is truly not applicable, use an empty array rather than prose. Do not wrap the JSON in Markdown.",
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

async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 2,
    baseDelayMs = 1000
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

    return (
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
        const sourceLanguage = toLanguageName(from);
        const targetLanguage = toLanguageName(to);
        const scriptRule = getScriptConstraint(to);
        const dictionaryInstruction = isDictionaryCandidate(text)
            ? DICTIONARY_OUTPUT_INSTRUCTION
            : "";
        const hasPageSegments = hasPageTranslationSegments(text);
        const hasInlineLinks = /\[\[EDGE_TRANSLATE_LINK_\d+]]/.test(text);
        if (hasPageSegments) {
            const pageParts = [
                `Translate ${sourceLanguage} -> ${targetLanguage}.`,
                scriptRule,
                hasInlineLinks ? "Keep link markers; translate visible link text." : "",
                "",
                text,
            ];
            return pageParts.filter(Boolean).join("\n");
        }
        const parts = [
            "Translate the user's text.",
            "Translate faithfully and naturally into the target language as if the result were originally written in that language.",
            "Preserve meaning, tone, intent, nuance, register, rhythm, emotional progression, and local context.",
            "Keep the same text form: heading stays heading, label stays label, sentence stays sentence, and list stays list.",
            "Do not summarize, explain, or add information.",
            "Respect the original formatting, line breaks, segment markers, placeholders, URLs, code, and markup.",
            "Use the target language's customary writing system.",
            "Preserve proper nouns and official names by default: people, organizations, brands, services, product names, model names, titles, places, laws, events, account names, technical terms, and identifiers.",
            "Use a localized or translated proper-name form only when it is clearly established by context or target-language convention. Otherwise keep the name intact, especially official Latin-script names and casing.",
            "Do not split named entities into generic translated words. Do not explain names or append glosses.",
            "For Han-script source text, translate complete semantic units. Do not partially translate compound nouns.",
            "Never create mixed-script words by combining source-script characters with target-language characters.",
            "Before finalizing, rewrite any remaining source-language fragment. Source-language text is forbidden in the output except for preserved URLs, code, IDs, and exact placeholders.",
            "Silently scan the final answer for mixed-script words.",
            `Source language: ${sourceLanguage}.`,
            `Target language: ${targetLanguage}.`,
            scriptRule,
            dictionaryInstruction,
            !hasPageSegments
                ? "For selected or drag-translated text, treat the input as a self-contained selection. If it is a phrase or UI label, return a concise natural equivalent; if it is a sentence or paragraph, preserve voice, politeness, implied meaning, and technical precision without padding."
                : "",
            !hasPageSegments
                ? "Do not over-translate proper nouns in selected text. Keep official product, app, model, repository, API, package, and company names intact unless a well-established localized form is clearly appropriate."
                : "",
            hasInlineLinks
                ? "For inline link placeholders, preserve every [[EDGE_TRANSLATE_LINK_n]] and [[/EDGE_TRANSLATE_LINK_n]] marker exactly. Translate the whole sentence naturally around the link, keep spacing natural, and do not expose placeholder text to the reader."
                : "",
            "",
            text,
        ];
        return parts.filter(Boolean).join("\n");
    }

    private buildOpenAiPrompt(
        text: string,
        from: string,
        to: string,
        options: LocalTranslationOptions = {}
    ) {
        return this.buildGoogleAiStudioPrompt(text, from, to, options);
    }

    private getTranslationSystemPrompt(text: string, options: LocalTranslationOptions = {}) {
        if (this.isRealtimeCaptionTranslation(options)) return REALTIME_CAPTION_SYSTEM_PROMPT;
        return hasPageTranslationSegments(text)
            ? PAGE_TRANSLATION_SYSTEM_PROMPT
            : AI_TRANSLATION_SYSTEM_PROMPT;
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
        return extractOpenAIMessageContent(payload?.choices?.[0]?.message);
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
            config.maxOutputTokens = Math.max(512, Math.ceil(inputLength * 4));
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
            const requestPayload = async (compatibilityMode: "minimal" | "bare") => {
                const generationConfig = this.buildGoogleAiStudioGenerationConfig(
                    text.length,
                    compatibilityMode,
                    options
                );
                const body: Record<string, any> = {
                    systemInstruction: {
                        parts: [{ text: this.getTranslationSystemPrompt(text, options) }],
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
                const response = await fetch(
                    `${GOOGLE_AI_STUDIO_ENDPOINT_BASE}/${model}:generateContent?key=${encodeURIComponent(
                        this.apiKey
                    )}`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    }
                );
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
                        content: this.getTranslationSystemPrompt(text, options),
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
                              text.length * tokenMultiplier
                          )
                ),
            });
            const requestPayload = async (includeReasoningEffort = true, tokenMultiplier = 4) => {
                const response = await fetch(OPENAI_CHAT_COMPLETIONS_ENDPOINT, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.openaiApiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(buildBody(includeReasoningEffort, tokenMultiplier)),
                    signal: controller.signal,
                });

                const payload = await response.json().catch(() => ({}));
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
                        content: this.getTranslationSystemPrompt(text, options),
                    },
                    {
                        role: "user",
                        content: this.buildOpenAiPrompt(text, from, to, options),
                    },
                ],
                ...(!isRealtimeCaption && isDictionaryCandidate(text)
                    ? { response_format: { type: "json_object" } }
                    : {}),
                max_tokens: isRealtimeCaption
                    ? Math.max(96, Math.ceil(text.length * 2))
                    : Math.max(
                          512 * Math.max(1, tokenMultiplier / 4),
                          Math.ceil(text.length * tokenMultiplier)
                      ),
                temperature: 0,
            });
            const requestPayload = async (tokenMultiplier = 4) => {
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                };
                if (this.openaiCompatibleApiKey) {
                    headers.Authorization = `Bearer ${this.openaiCompatibleApiKey}`;
                }
                const response = await fetch(this.openaiCompatibleEndpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(buildBody(tokenMultiplier)),
                    signal: controller.signal,
                });

                const payload = await response.json().catch(() => ({}));
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
