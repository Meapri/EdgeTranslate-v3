import { TranslationResult } from "../types";
import { LRUCache } from "../utils/lru";
import { fnv1a32 } from "../utils/hash";

export type LocalTranslatorConfig = {
    enabled?: boolean;
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

const SUPPORTED_LANGUAGE_CODES = new Set(Object.keys(LANGUAGE_NAMES));
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

function toLanguageName(language: string) {
    return LANGUAGE_NAMES[language] || language || "auto";
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
        this.endpoint = normalizeEndpoint(config.endpoint);
        this.apiKey = (config.apiKey || "").trim();
        this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.cache.clear();
        this.inflight.clear();
    }

    supportedLanguages() {
        if (!this.enabled || !this.endpoint) return new Set<string>();
        return new Set(SUPPORTED_LANGUAGE_CODES);
    }

    detect() {
        return Promise.resolve("auto");
    }

    async translate(text: string, from: string, to: string): Promise<TranslationResult> {
        if (!text || !text.trim()) {
            return { originalText: text || "", mainMeaning: "" };
        }
        if (!this.enabled || !this.endpoint) {
            throw {
                errorType: "CONFIG_ERR",
                errorCode: "LOCAL_TRANSLATOR_ENDPOINT_MISSING",
                errorMsg: "Local translator endpoint is not configured.",
                errorAct: { api: "local", action: "translate", text, from, to },
            };
        }

        const key = `L|${from}|${to}|${fnv1a32(text)}`;
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
                errorAct: { api: "local", action: "translate", text, from, to },
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
