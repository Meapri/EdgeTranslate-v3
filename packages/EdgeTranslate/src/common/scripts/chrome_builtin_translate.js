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
const GEMINI_NANO_SESSION_CACHE = new Map();
const PROMPT_API_LANGUAGE_CODES = new Set(["en", "es", "ja"]);
const GEMINI_NANO_CREATE_TIMEOUT_MS = 45000;
const GEMINI_NANO_PROMPT_TIMEOUT_MS = 60000;
const DICTIONARY_RESULT_SCHEMA = JSON.stringify({
    translation: "...",
    detailedMeanings: [{ pos: "...", meaning: "...", synonyms: ["..."] }],
    definitions: [{ pos: "...", meaning: "...", example: "...", synonyms: ["..."] }],
    examples: [{ source: "...", target: "..." }],
});

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
        ((globalThis.LanguageModel && typeof globalThis.LanguageModel.create === "function") ||
            (globalThis.Translator && typeof globalThis.Translator.create === "function"))
    );
}

function toLanguageName(language) {
    const normalized = toChromeTranslatorLanguage(language || "auto");
    const names = {
        auto: "the detected source language",
        en: "English",
        ko: "Korean",
        ja: "Japanese",
        zh: "Simplified Chinese",
        "zh-Hant": "Traditional Chinese",
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
        iw: "Hebrew",
    };
    return names[normalized] || normalized || language || "the source language";
}

function normalizeGeminiNanoOutput(output) {
    return String(output || "")
        .trim()
        .replace(/^```[a-zA-Z0-9_-]*\s*/g, "")
        .replace(/```$/g, "")
        .replace(/^translation\s*:\s*/i, "")
        .trim();
}

function isDictionaryCandidate(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed || trimmed.length > 64) return false;
    if (/https?:\/\//i.test(trimmed)) return false;
    if (/<<<EDGE_TRANSLATE_SEGMENT_\d+>>>/.test(trimmed)) return false;
    if (/[.!?。！？\n\r\t]/.test(trimmed)) return false;
    return trimmed.split(/\s+/).length <= 2;
}

function parseGeminiNanoDictionaryOutput(output, originalText) {
    const cleaned = normalizeGeminiNanoOutput(output);
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;

    try {
        const payload = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
        const mainMeaning = String(
            payload.translation || payload.mainMeaning || payload.translatedText || ""
        ).trim();
        if (!mainMeaning) return null;
        const toArray = (value) => (Array.isArray(value) ? value : []);
        return {
            originalText,
            mainMeaning,
            translatedText: mainMeaning,
            detailedMeanings: toArray(payload.detailedMeanings)
                .map((item) => ({
                    pos: String(item?.pos || "").trim(),
                    meaning: String(item?.meaning || "").trim(),
                    synonyms: toArray(item?.synonyms)
                        .map((word) => String(word || "").trim())
                        .filter(Boolean),
                }))
                .filter((item) => item.meaning),
            definitions: toArray(payload.definitions)
                .map((item) => ({
                    pos: String(item?.pos || "").trim(),
                    meaning: String(item?.meaning || "").trim(),
                    example: String(item?.example || "").trim(),
                    synonyms: toArray(item?.synonyms)
                        .map((word) => String(word || "").trim())
                        .filter(Boolean),
                }))
                .filter((item) => item.meaning),
            examples: toArray(payload.examples)
                .map((item) => ({
                    source: item?.source ? String(item.source).trim() : null,
                    target: item?.target ? String(item.target).trim() : null,
                }))
                .filter((item) => item.source || item.target),
        };
    } catch {
        const translationMatch = cleaned.match(/"translation"\s*:\s*"([^"]+)"/);
        const mainMeaning = String(translationMatch?.[1] || "").trim();
        if (!mainMeaning) return null;
        return {
            originalText,
            mainMeaning,
            translatedText: mainMeaning,
            detailedMeanings: [],
            definitions: [],
            examples: [],
        };
    }
}

function buildGeminiNanoPrompt(text, sourceLanguage, targetLanguage) {
    if (isDictionaryCandidate(text)) {
        return [
            "Translate the following word or short term.",
            `Source language: ${toLanguageName(sourceLanguage)}.`,
            `Target language: ${toLanguageName(targetLanguage)}.`,
            "Return strict JSON only. Do not use markdown.",
            "Schema:",
            DICTIONARY_RESULT_SCHEMA,
            "Keep details concise. Write meanings, definitions, and translated examples in the target language.",
            "If a field is unknown, use an empty array.",
            "<text>",
            text,
            "</text>",
        ].join("\n");
    }

    if (/<<<EDGE_TRANSLATE_SEGMENT_\d+>>>/.test(String(text || ""))) {
        return [
            "Fast translate. Output only translated text.",
            `From: ${toLanguageName(sourceLanguage)}. To: ${toLanguageName(targetLanguage)}.`,
            "Keep every <<<EDGE_TRANSLATE_SEGMENT_N>>> marker exactly unchanged.",
            "Translate text after each marker. No notes. No markdown.",
            text,
        ].join("\n");
    }

    return [
        `Translate ${toLanguageName(sourceLanguage)} to ${toLanguageName(targetLanguage)}.`,
        "Output translation only. No notes.",
        text,
    ].join("\n");
}

function getPromptApiLanguage(language) {
    const normalized = toChromeTranslatorLanguage(language || "");
    if (!normalized || normalized === "auto") return null;
    const base = normalized.toLowerCase().split("-")[0];
    return PROMPT_API_LANGUAGE_CODES.has(base) ? base : null;
}

function getGeminiNanoCreateOptions(sourceLanguage, targetLanguage) {
    const inputLanguages = new Set(["en"]);
    const sourcePromptLanguage = getPromptApiLanguage(sourceLanguage);
    const targetPromptLanguage = getPromptApiLanguage(targetLanguage);
    if (sourcePromptLanguage) inputLanguages.add(sourcePromptLanguage);
    if (targetPromptLanguage) inputLanguages.add(targetPromptLanguage);

    const options = {
        expectedInputs: [{ type: "text", languages: Array.from(inputLanguages) }],
    };
    if (targetPromptLanguage) {
        options.expectedOutputs = [{ type: "text", languages: [targetPromptLanguage] }];
    }
    return options;
}

function withTimeout(promise, timeoutMs, message, abortController) {
    let timeoutId;
    let timedOut = false;
    const timeoutError = new Error(message);
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            timedOut = true;
            try {
                abortController?.abort?.(timeoutError);
            } catch (_) {
                // Ignore abort failures; the timeout error below is the actionable failure.
            }
            reject(timeoutError);
        }, timeoutMs);
    });
    return Promise.race([promise, timeout])
        .catch((error) => {
            if (timedOut && /abort/i.test(String(error?.message || error || ""))) {
                throw timeoutError;
            }
            throw error;
        })
        .finally(() => clearTimeout(timeoutId));
}

async function getGeminiNanoSession(sourceLanguage, targetLanguage) {
    const key = `${sourceLanguage}|${targetLanguage}`;
    if (GEMINI_NANO_SESSION_CACHE.has(key)) return GEMINI_NANO_SESSION_CACHE.get(key);

    const languageModelApi = globalThis.LanguageModel;
    if (!languageModelApi || typeof languageModelApi.create !== "function") {
        throw new Error(
            "Chrome Gemini Nano LanguageModel API is not available in this browser context."
        );
    }

    const createOptions = getGeminiNanoCreateOptions(sourceLanguage, targetLanguage);
    if (typeof languageModelApi.availability === "function") {
        const availability = await languageModelApi.availability(createOptions);
        if (availability === "unavailable") {
            throw new Error("Chrome Gemini Nano LanguageModel API is unavailable on this device.");
        }
    }

    const abortController =
        typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
    const session = await withTimeout(
        languageModelApi.create({
            ...createOptions,
            ...(abortController ? { signal: abortController.signal } : {}),
            monitor(monitor) {
                monitor.addEventListener("downloadprogress", () => {});
            },
            initialPrompts: [
                {
                    role: "system",
                    content: [
                        "You are a fast translation engine.",
                        "Translate only. No explanations, notes, markdown, or quotes.",
                        "Keep URLs, numbers, names, line breaks, and <<<EDGE_TRANSLATE_SEGMENT_N>>> markers unchanged.",
                        `Source language: ${toLanguageName(sourceLanguage)}.`,
                        `Target language: ${toLanguageName(targetLanguage)}.`,
                    ].join("\n"),
                },
            ],
        }),
        GEMINI_NANO_CREATE_TIMEOUT_MS,
        "Chrome Gemini Nano session creation timed out while preparing the on-device model. Gemini Nano may still be downloading or not installed yet. Open chrome://on-device-internals or chrome://components and finish the Optimization Guide On Device Model download, then try again.",
        abortController
    );
    GEMINI_NANO_SESSION_CACHE.set(key, session);
    return session;
}

async function readGeminiNanoPromptOutput(session, prompt, options = {}) {
    const { preferStreaming = true } = options;
    if (preferStreaming && session && typeof session.promptStreaming === "function") {
        const stream = await session.promptStreaming(prompt);
        if (stream && typeof stream[Symbol.asyncIterator] === "function") {
            let output = "";
            for await (const chunk of stream) output += String(chunk || "");
            return output;
        }
        if (stream && typeof stream.getReader === "function") {
            const reader = stream.getReader();
            let output = "";
            let done = false;
            while (!done) {
                const chunk = await reader.read();
                done = chunk.done;
                const value = chunk.value;
                if (done) break;
                output += String(value || "");
            }
            return output;
        }
        return stream;
    }
    return session.prompt(prompt);
}

async function warmupChromeOnDevice(from, to) {
    const targetLanguage = toChromeTranslatorLanguage(to);
    const sourceLanguage = from === "auto" ? "auto" : toChromeTranslatorLanguage(from);
    await getGeminiNanoSession(sourceLanguage, targetLanguage);
    return { sourceLanguage, targetLanguage };
}

async function translateWithGeminiNano(text, from, to) {
    if (!text || !String(text).trim()) {
        return {
            originalText: text || "",
            mainMeaning: "",
            translatedText: "",
            sourceLanguage: from,
            targetLanguage: to,
        };
    }

    const targetLanguage = toChromeTranslatorLanguage(to);
    const sourceLanguage = from === "auto" ? "auto" : toChromeTranslatorLanguage(from);
    const session = await getGeminiNanoSession(sourceLanguage, targetLanguage);
    const dictionaryCandidate = isDictionaryCandidate(text);
    const output = await withTimeout(
        readGeminiNanoPromptOutput(
            session,
            buildGeminiNanoPrompt(text, sourceLanguage, targetLanguage),
            { preferStreaming: !dictionaryCandidate }
        ),
        GEMINI_NANO_PROMPT_TIMEOUT_MS,
        "Chrome Gemini Nano prompt timed out."
    );
    const dictionaryResult = dictionaryCandidate
        ? parseGeminiNanoDictionaryOutput(output, text)
        : null;
    if (dictionaryResult) {
        return {
            ...dictionaryResult,
            sourceLanguage,
            targetLanguage,
        };
    }

    const translated = normalizeGeminiNanoOutput(output);
    if (!translated) throw new Error("Chrome Gemini Nano returned an empty translation.");

    return {
        originalText: text,
        mainMeaning: translated,
        translatedText: translated,
        sourceLanguage,
        targetLanguage,
    };
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
    return translateWithGeminiNano(text, from, to);
}

export {
    getChromeTranslatorSupportedLanguages,
    isChromeBuiltinTranslatorAvailable,
    toChromeTranslatorLanguage,
    translateWithChromeBuiltin,
    translateWithGeminiNano,
    translateWithChromeOnDevice,
    warmupChromeOnDevice,
};
