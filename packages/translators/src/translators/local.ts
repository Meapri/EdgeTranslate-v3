import { TranslationResult } from "../types";
import { LRUCache } from "../utils/lru";
import { fnv1a32 } from "../utils/hash";

export type LocalTranslatorMode = "endpoint" | "chromeBuiltin" | "googleAiStudio";

export type LocalTranslatorConfig = {
    enabled?: boolean;
    mode?: LocalTranslatorMode | string;
    endpoint?: string;
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
const GOOGLE_AI_STUDIO_ENDPOINT_BASE =
    "https://generativelanguage.googleapis.com/v1beta/models";
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

function normalizeEndpoint(endpoint?: string) {
    return (endpoint || "").trim();
}

function normalizeMode(mode?: string): LocalTranslatorMode {
    if (mode === "chromeBuiltin" || mode === "geminiNano") return "chromeBuiltin";
    if (mode === "googleAiStudio") return "googleAiStudio";
    return "endpoint";
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

function parseTranslatedText(payload: any) {
    return (
        payload?.translated_text ||
        payload?.translatedText ||
        payload?.translation ||
        payload?.result ||
        payload?.text ||
        ""
    );
}

class LocalTranslator {
    private enabled = false;
    private mode: LocalTranslatorMode = "endpoint";
    private endpoint = "";
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
        this.endpoint = normalizeEndpoint(config.endpoint);
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
        if (!this.endpoint) return new Set<string>();
        return new Set(SUPPORTED_LANGUAGE_CODES);
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
        if (this.mode === "endpoint" && !this.endpoint) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "LOCAL_TRANSLATOR_ENDPOINT_MISSING",
                errorMsg: "Local translator endpoint is not configured.",
                errorAct: { api: "local", action: "translate", text, from, to },
            };
        }
        if (this.mode === "googleAiStudio" && !this.apiKey) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "GOOGLE_AI_STUDIO_API_KEY_MISSING",
                errorMsg: "Google AI Studio API key is not configured.",
                errorAct: { api: "local", mode: "googleAiStudio", action: "translate", text, from, to },
            };
        }

        const key = `L|${this.mode}|${from}|${to}|${fnv1a32(text)}`;
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
        return this.requestEndpointTranslation(text, from, to);
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
        return [
            "You are a translation engine.",
            `Translate the user's text from ${sourceLanguage} to ${targetLanguage}.`,
            "Return only the translated text. Do not add explanations, quotes, markdown, or alternatives.",
            "Preserve line breaks and formatting where possible.",
            "If the text contains segment marker lines like <<<EDGE_TRANSLATE_SEGMENT_1>>>, keep those marker lines unchanged and translate only the text between them.",
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
            temperature: 0,
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
                    payload?.error?.message || `Google AI Studio request failed with ${response.status}`
                );
            }

            const translated = this.parseGoogleAiStudioResponse(payload);
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
                errorCode:
                    error?.name === "AbortError" ? "TIMEOUT" : "GOOGLE_AI_STUDIO_ERROR",
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

    private async requestEndpointTranslation(text: string, from: string, to: string) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const headers: Record<string, string> = {
                "Content-Type": "application/json",
            };
            if (this.apiKey) {
                headers["X-API-Key"] = this.apiKey;
            }

            const response = await fetch(this.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    text,
                    source_language: toLanguageName(from),
                    target_language: toLanguageName(to),
                }),
                signal: controller.signal,
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.success === false) {
                throw new Error(
                    payload?.error || `Local translator failed with ${response.status}`
                );
            }

            const translated = parseTranslatedText(payload);
            if (!translated) {
                throw new Error("Local translator returned an empty translation.");
            }

            return {
                originalText: text,
                mainMeaning: translated,
                sourceLanguage: payload?.source_language || payload?.detected_language || from,
                targetLanguage: to,
            } as TranslationResult;
        } catch (error: any) {
            throw {
                errorType: "API_ERR",
                errorCode: error?.name === "AbortError" ? "TIMEOUT" : "LOCAL_TRANSLATOR_ERROR",
                errorMsg: error?.message || "Local translator request failed.",
                errorAct: { api: "local", mode: "endpoint", action: "translate", text, from, to },
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
