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

const LANGUAGE_NAMES = {
    auto: "auto-detected language",
    en: "English",
    ko: "Korean",
    ja: "Japanese",
    "zh-CN": "Simplified Chinese",
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

const GEMINI_NANO_SESSION_CACHE = new Map();
const GEMINI_NANO_MAX_INPUT_CHARS = 4000;

function toChromeTranslatorLanguage(language) {
    return CHROME_TRANSLATOR_LANGUAGE_MAP[language] || language;
}

function getChromeTranslatorSupportedLanguages() {
    return new Set(Object.keys(CHROME_TRANSLATOR_LANGUAGE_MAP));
}

function getGeminiNanoSupportedLanguages() {
    return new Set(Object.keys(LANGUAGE_NAMES));
}

function toLanguageName(language) {
    return LANGUAGE_NAMES[language] || language || "auto-detected language";
}

function isChromeBuiltinTranslatorAvailable() {
    return (
        typeof globalThis !== "undefined" &&
        globalThis.Translator &&
        typeof globalThis.Translator.create === "function"
    );
}

function isGeminiNanoLanguageModelAvailable() {
    return (
        typeof globalThis !== "undefined" &&
        globalThis.LanguageModel &&
        typeof globalThis.LanguageModel.create === "function"
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

async function translateWithChromeBuiltin(text, from, to) {
    if (!text || !String(text).trim()) {
        return {
            originalText: text || "",
            mainMeaning: "",
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

    if (typeof translatorApi.availability === "function") {
        const availability = await translatorApi.availability({ sourceLanguage, targetLanguage });
        if (availability === "unavailable") {
            throw new Error(
                `Chrome built-in Translator API does not support ${sourceLanguage} to ${targetLanguage}.`
            );
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
        translatedText: translated,
        sourceLanguage,
        targetLanguage,
    };
}

function normalizeGeminiNanoOutput(output) {
    return String(output || "")
        .trim()
        .replace(/^```(?:text)?\s*/i, "")
        .replace(/```$/i, "")
        .replace(/^Translation:\s*/i, "")
        .trim();
}

async function getGeminiNanoSession(from, to) {
    const languageModelApi = globalThis.LanguageModel;
    if (!languageModelApi || typeof languageModelApi.create !== "function") {
        throw new Error("Chrome Gemini Nano Prompt API is not available in this browser context.");
    }

    const sourceLanguage = toLanguageName(from);
    const targetLanguage = toLanguageName(to);
    const key = `${sourceLanguage}|${targetLanguage}`;
    if (GEMINI_NANO_SESSION_CACHE.has(key)) return GEMINI_NANO_SESSION_CACHE.get(key);

    if (typeof languageModelApi.availability === "function") {
        const availability = await languageModelApi.availability();
        if (availability === "unavailable") {
            throw new Error("Chrome Gemini Nano model is unavailable on this device.");
        }
    }

    const session = await languageModelApi.create({
        initialPrompts: [
            {
                role: "system",
                content: [
                    "You are a precise translation engine.",
                    "Translate user-provided text only.",
                    "Preserve meaning, tone, punctuation, line breaks, URLs, numbers, names, and HTML-like entities.",
                    "Do not explain, summarize, romanize, add notes, or wrap the answer in quotes/code fences.",
                    `Source language: ${sourceLanguage}.`,
                    `Target language: ${targetLanguage}.`,
                ].join("\n"),
            },
        ],
    });
    GEMINI_NANO_SESSION_CACHE.set(key, session);
    return session;
}

async function translateWithGeminiNano(text, from, to) {
    if (!text || !String(text).trim()) {
        return {
            originalText: text || "",
            mainMeaning: "",
            sourceLanguage: from,
            targetLanguage: to,
        };
    }

    const session = await getGeminiNanoSession(from, to);
    const safeText = String(text).slice(0, GEMINI_NANO_MAX_INPUT_CHARS);
    const sourceLanguage = toLanguageName(from);
    const targetLanguage = toLanguageName(to);
    const prompt = [
        `Translate the following text from ${sourceLanguage} to ${targetLanguage}.`,
        "Return only the translated text.",
        "<text>",
        safeText,
        "</text>",
    ].join("\n");
    const output = await session.prompt(prompt);
    const translated = normalizeGeminiNanoOutput(output);
    if (!translated) {
        throw new Error("Chrome Gemini Nano returned an empty translation.");
    }

    return {
        originalText: text,
        mainMeaning: translated,
        translatedText: translated,
        sourceLanguage: from,
        targetLanguage: to,
    };
}

async function translateWithChromeOnDevice(text, from, to, engine = "geminiNano") {
    if (engine === "chromeBuiltin") return translateWithChromeBuiltin(text, from, to);
    return translateWithGeminiNano(text, from, to);
}

export {
    getChromeTranslatorSupportedLanguages,
    getGeminiNanoSupportedLanguages,
    isChromeBuiltinTranslatorAvailable,
    isGeminiNanoLanguageModelAvailable,
    toChromeTranslatorLanguage,
    translateWithChromeBuiltin,
    translateWithChromeOnDevice,
    translateWithGeminiNano,
};
