import { TranslationResult } from "../types";
import { LRUCache } from "../utils/lru";
import { fnv1a32 } from "../utils/hash";

export type LocalTranslatorMode = "endpoint" | "chromeBuiltin";

export type LocalTranslatorConfig = {
    enabled?: boolean;
    mode?: LocalTranslatorMode;
    endpoint?: string;
    apiKey?: string;
    timeoutMs?: number;
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
const CHROME_TRANSLATOR_SUPPORTED_LANGUAGE_CODES = new Set(Object.keys(CHROME_TRANSLATOR_LANGUAGE_MAP));
const DEFAULT_TIMEOUT_MS = 60000;
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

function normalizeMode(mode?: LocalTranslatorMode): LocalTranslatorMode {
    return mode === "chromeBuiltin" ? "chromeBuiltin" : "endpoint";
}

function toLanguageName(language: string) {
    return LANGUAGE_NAMES[language] || language || "auto";
}

function toChromeTranslatorLanguage(language: string) {
    return CHROME_TRANSLATOR_LANGUAGE_MAP[language] || language;
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
    private timeoutMs = DEFAULT_TIMEOUT_MS;
    private cache = new LRUCache<string, TranslationResult>({ max: 200, ttl: 10 * 60 * 1000 });
    private inflight = new Map<string, Promise<TranslationResult>>();

    constructor(config: LocalTranslatorConfig = {}) {
        this.useConfig(config);
    }

    useConfig(config: LocalTranslatorConfig = {}) {
        this.enabled = Boolean(config.enabled);
        this.mode = normalizeMode(config.mode);
        this.endpoint = normalizeEndpoint(config.endpoint);
        this.apiKey = (config.apiKey || "").trim();
        this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.cache.clear();
        this.inflight.clear();
    }

    supportedLanguages() {
        if (!this.enabled) return new Set<string>();
        if (this.mode === "chromeBuiltin") return new Set(CHROME_TRANSLATOR_SUPPORTED_LANGUAGE_CODES);
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

        const key = `L|${this.mode}|${from}|${to}|${fnv1a32(text)}`;
        const cached = this.cache.get(key);
        if (cached) return cached;

        const existing = this.inflight.get(key);
        if (existing) return existing;

        const request = localRequestLimiter.run(() => this.requestTranslation(text, from, to))
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
        return this.requestEndpointTranslation(text, from, to);
    }

    private async requestChromeBuiltinTranslation(text: string, from: string, to: string) {
        try {
            const translatorApi = (globalThis as any).Translator;
            if (!translatorApi || typeof translatorApi.create !== "function") {
                throw new Error("Chrome built-in Translator API is not available in this browser.");
            }

            const targetLanguage = toChromeTranslatorLanguage(to);
            const sourceLanguage = from === "auto"
                ? await this.detectChromeBuiltinLanguage(text, targetLanguage)
                : toChromeTranslatorLanguage(from);

            if (typeof translatorApi.availability === "function") {
                const availability = await translatorApi.availability({ sourceLanguage, targetLanguage });
                if (availability === "unavailable") {
                    throw new Error(`Chrome built-in Translator API does not support ${sourceLanguage} to ${targetLanguage}.`);
                }
            }

            const translator = await translatorApi.create({ sourceLanguage, targetLanguage });
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
                errorAct: { api: "local", mode: "chromeBuiltin", action: "translate", text, from, to },
            };
        }
    }

    private async detectChromeBuiltinLanguage(text: string, targetLanguage: string) {
        const detectorApi = (globalThis as any).LanguageDetector;
        if (!detectorApi || typeof detectorApi.create !== "function") {
            throw new Error("Chrome built-in Translator API requires an explicit source language when Language Detector API is unavailable.");
        }

        const detector = await detectorApi.create();
        const detections = await detector.detect(text);
        const detected = Array.isArray(detections) ? detections[0]?.detectedLanguage : undefined;
        const sourceLanguage = toChromeTranslatorLanguage(detected || "");
        if (!sourceLanguage || sourceLanguage === targetLanguage) {
            throw new Error("Chrome built-in Language Detector API could not determine a translatable source language.");
        }
        return sourceLanguage;
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
                throw new Error(payload?.error || `Local translator failed with ${response.status}`);
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
