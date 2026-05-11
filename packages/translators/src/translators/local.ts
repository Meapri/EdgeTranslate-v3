import { TranslationResult } from "../types";
import { LRUCache } from "../utils/lru";
import { fnv1a32 } from "../utils/hash";

export type LocalTranslatorMode = "chromeBuiltin" | "googleAiStudio";

export type LocalTranslatorConfig = {
    enabled?: boolean;
    mode?: LocalTranslatorMode | string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number | string;
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
const LOCAL_TRANSLATOR_PROMPT_VERSION = "local-prompt-2026-06-25-01";
const GOOGLE_AI_STUDIO_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;


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

function normalizeMode(mode?: string): LocalTranslatorMode {
    if (mode === "chromeBuiltin" || mode === "geminiNano") return "chromeBuiltin";
    if (mode === "googleAiStudio") return "googleAiStudio";
    return "chromeBuiltin";
}

function normalizeModel(model?: string) {
    return (model || DEFAULT_GOOGLE_AI_STUDIO_MODEL).trim() || DEFAULT_GOOGLE_AI_STUDIO_MODEL;
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

function getPrimaryScript(language: string) {
    const normalized = toChromeTranslatorLanguage(language || "");
    const base = normalized.split("-")[0];
    const scriptMap: Record<string, string> = {
        ko: "Hangul",
        ja: "Hiragana, Katakana, and Kanji",
        zh: "Simplified Chinese",
        "zh-Hant": "Traditional Chinese",
        ru: "Cyrillic",
        uk: "Cyrillic",
        bg: "Cyrillic",
        ar: "Arabic",
        iw: "Hebrew",
        he: "Hebrew",
        th: "Thai",
        el: "Greek",
        hi: "Devanagari",
        bn: "Bengali",
        ta: "Tamil",
        te: "Telugu",
        kn: "Kannada",
        mr: "Devanagari",
    };
    return scriptMap[normalized] || scriptMap[base] || "Latin alphabet";
}

function getTextFormPreservationRules() {
    return ["Do not shorten or summarize. Translate the complete text."];
}

function getTargetLanguageScriptRule(language: string) {
    const primaryScript = getPrimaryScript(language);
    return `Localize institutional and cultural terms to their natural equivalents in the target language (avoid literal translations). Every word in the output must be exclusively in the ${primaryScript} script. Translate or transliterate all names, brands, terms, headings, and labels into ${primaryScript}. If unsure, transliterate into ${primaryScript} rather than keeping the source script.`;
}

function getTargetLanguageFinalCheck(language: string) {
    const targetLanguage = toLanguageName(language);
    return `Final check: output must be pure ${targetLanguage}.`;
}

function isDictionaryCandidate(text: string) {
    const trimmed = String(text || "").trim();
    if (!trimmed || trimmed.length > 64) return false;
    if (/https?:\/\//i.test(trimmed)) return false;
    if (/<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/.test(trimmed)) return false;
    if (/[.!?。！？\n\r\t]/.test(trimmed)) return false;
    if (/^[「『“"'].*[」』”"']\s*\S+/.test(trimmed)) return false;

    const cjkChars = trimmed.match(
        /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g
    );
    if (cjkChars && cjkChars.length > 8) return false;

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



function asArray(value: any) {
    return Array.isArray(value) ? value : [];
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
        return {
            originalText: fallbackText,
            mainMeaning,
            detailedMeanings: asArray(payload.detailedMeanings)
                .map((item) => ({
                    pos: String(item?.pos || "").trim(),
                    meaning: String(item?.meaning || "").trim(),
                    synonyms: asArray(item?.synonyms)
                        .map((word) => String(word || "").trim())
                        .filter(Boolean),
                }))
                .filter((item) => item.meaning),
            definitions: asArray(payload.definitions)
                .map((item) => ({
                    pos: String(item?.pos || "").trim(),
                    meaning: String(item?.meaning || "").trim(),
                    example: String(item?.example || "").trim(),
                    synonyms: asArray(item?.synonyms)
                        .map((word) => String(word || "").trim())
                        .filter(Boolean),
                }))
                .filter((item) => item.meaning),
            examples: asArray(payload.examples)
                .map((item) => ({
                    source: item?.source ? String(item.source).trim() : null,
                    target: item?.target ? String(item.target).trim() : null,
                }))
                .filter((item) => item.source || item.target),
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
        this.model = normalizeModel(config.model);
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
        return new Set<string>();
    }

    detect() {
        return Promise.resolve("auto");
    }

    async translate(text: string, from: string, to: string): Promise<TranslationResult> {
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

        const key = `L|${LOCAL_TRANSLATOR_PROMPT_VERSION}|${this.mode}|${from}|${to}|${fnv1a32(
            text
        )}`;
        const cached = this.cache.get(key);
        if (cached) return cached;

        const existing = this.inflight.get(key);
        if (existing) return existing;

        const request = localRequestLimiter
            .run(() => this.requestTranslation(text, from, to))
            .then((result) => {
                this.cache.set(key, result);
                return result;
            })
            .finally(() => this.inflight.delete(key));

        this.inflight.set(key, request);
        return request;
    }

    private async requestTranslation(text: string, from: string, to: string) {
        if (this.mode === "chromeBuiltin") {
            return this.requestChromeBuiltinTranslation(text, from, to);
        }
        if (this.mode === "googleAiStudio") {
            return this.requestGoogleAiStudioTranslation(text, from, to);
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

    private buildGoogleAiStudioPrompt(text: string, from: string, to: string) {
        const sourceLanguage = toLanguageName(from);
        const targetLanguage = toLanguageName(to);
        if (isDictionaryCandidate(text)) {
            return [
                "You are a bilingual dictionary and translation engine.",
                `Translate the user's word or short term from ${sourceLanguage} to ${targetLanguage}.`,
                getTargetLanguageScriptRule(to),
                "Return strict JSON only. Do not use markdown.",
                "Schema:",
                '{"translation":"...","detailedMeanings":[{"pos":"...","meaning":"...","synonyms":["..."]}],"definitions":[{"pos":"...","meaning":"...","example":"...","synonyms":["..."]}],"examples":[{"source":"...","target":"..."}]}',
                "Keep details concise. Write meanings, definitions, and translated examples in the target language.",
                "If a field is unknown, use an empty array.",
                "",
                text,
            ].join("\n");
        }
        if (/<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/.test(text)) {
            return [
                "You are a translation engine.",
                `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
                "Return only the translated marked text. Do not add explanations, quotes, markdown, or alternatives.",
                getTargetLanguageScriptRule(to),
                "Copy each <<<EDGE_TRANSLATE_SEGMENT_N role=...>>> marker exactly once, then translate only the text that follows it.",
                "Use role metadata only for form: role=title stays a concise noun-style heading, not a polite sentence; role=date translates only the date.",
                "Keep the source layout inside each segment, including line breaks, blank lines, list items, bullets or numbering, and heading/body separation.",
                ...getTextFormPreservationRules(),
                getTargetLanguageFinalCheck(to),
                "",
                text,
            ].join("\n");
        }
        return [
            "You are a translation engine.",
            `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
            "Return only the translated text. Do not add explanations, quotes, markdown, or alternatives.",
            getTargetLanguageScriptRule(to),
            "Preserve the visible source layout: paragraph breaks, line breaks, list item boundaries, bullets or numbering, and heading/body separation.",
            ...getTextFormPreservationRules(),
            getTargetLanguageFinalCheck(to),
            "",
            text,
        ].join("\n");
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

    private buildGoogleAiStudioGenerationConfig() {
        const generationConfig: Record<string, any> = {
            candidateCount: 1,
            temperature: 0,
            topK: 1,
        };
        if (!/^gemma-/i.test(this.model)) {
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        return generationConfig;
    }



    private async requestGoogleAiStudioTranslation(text: string, from: string, to: string) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const model = encodeURIComponent(this.model);
            const response = await fetch(
                `${GOOGLE_AI_STUDIO_ENDPOINT_BASE}/${model}:generateContent?key=${encodeURIComponent(
                    this.apiKey
                )}`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                role: "user",
                                parts: [{ text: this.buildGoogleAiStudioPrompt(text, from, to) }],
                            },
                        ],
                        generationConfig: this.buildGoogleAiStudioGenerationConfig(),
                    }),
                    signal: controller.signal,
                }
            );

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(
                    payload?.error?.message ||
                        `Google AI Studio request failed with ${response.status}`
                );
            }

            const rawOutput = this.parseGoogleAiStudioResponse(payload);
            const structured = isDictionaryCandidate(text)
                ? parseStructuredDictionaryOutput(rawOutput, text)
                : null;
            if (structured) {
                return {
                    ...structured,
                    translatedText: structured.mainMeaning,
                    sourceLanguage: from,
                    targetLanguage: to,
                } as TranslationResult;
            }

            const translated = parsePlainTranslationOutput(rawOutput);
            if (!translated) {
                throw new Error("Google AI Studio returned an empty translation.");
            }

            return {
                originalText: text,
                mainMeaning: translated,
                sourceLanguage: from,
                targetLanguage: to,
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

    pronounce() {
        return Promise.reject(new Error("Local translator does not support TTS."));
    }

    stopPronounce() {}
}

export default LocalTranslator;
