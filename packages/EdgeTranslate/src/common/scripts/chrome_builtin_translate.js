/* global globalThis */

const CHROME_TRANSLATOR_LANGUAGE_MAP = {
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
    he: "iw",
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

const CHROME_TRANSLATOR_CACHE = new Map();

function toChromeTranslatorLanguage(language) {
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

function getChromeTranslatorSupportedLanguages() {
    return new Set(Object.keys(CHROME_TRANSLATOR_LANGUAGE_MAP));
}

function isChromeBuiltinTranslatorAvailable() {
    return (
        typeof globalThis !== "undefined" &&
        globalThis.Translator &&
        typeof globalThis.Translator.create === "function"
    );
}

async function detectChromeBuiltinLanguage(text, targetLanguage) {
    const detectorApi = globalThis.LanguageDetector;
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

async function getChromeBuiltinTranslator(sourceLanguage, targetLanguage) {
    const key = `${sourceLanguage}|${targetLanguage}`;
    if (CHROME_TRANSLATOR_CACHE.has(key)) return CHROME_TRANSLATOR_CACHE.get(key);

    const translatorApi = globalThis.Translator;
    if (typeof translatorApi.availability === "function") {
        const availability = await translatorApi.availability({ sourceLanguage, targetLanguage });
        if (availability === "unavailable") {
            throw new Error(
                `Chrome built-in Translator API does not support ${sourceLanguage} to ${targetLanguage}.`
            );
        }
    }

    const translator = await translatorApi.create({ sourceLanguage, targetLanguage });
    CHROME_TRANSLATOR_CACHE.set(key, translator);
    return translator;
}

async function translateWithChromeBuiltin(text, from, to) {
    if (!text || !String(text).trim()) {
        return {
            originalText: text || "",
            mainMeaning: "",
            translatedText: "",
            sourceLanguage: from,
            targetLanguage: to,
        };
    }

    const translatorApi = globalThis.Translator;
    if (!translatorApi || typeof translatorApi.create !== "function") {
        throw new Error("Chrome built-in Translator API is not available in this browser context.");
    }

    const targetLanguage = toChromeTranslatorLanguage(to);
    const sourceLanguage =
        from === "auto"
            ? await detectChromeBuiltinLanguage(text, targetLanguage)
            : toChromeTranslatorLanguage(from);

    const translator = await getChromeBuiltinTranslator(sourceLanguage, targetLanguage);
    const translated = await translator.translate(text);
    if (!translated) {
        throw new Error("Chrome built-in Translator API returned an empty translation.");
    }

    return {
        originalText: text,
        mainMeaning: translated,
        translatedText: translated,
        sourceLanguage,
        targetLanguage,
    };
}

async function translateWithChromeOnDevice(text, from, to) {
    return translateWithChromeBuiltin(text, from, to);
}

export {
    getChromeTranslatorSupportedLanguages,
    isChromeBuiltinTranslatorAvailable,
    toChromeTranslatorLanguage,
    translateWithChromeBuiltin,
    translateWithChromeOnDevice,
};
