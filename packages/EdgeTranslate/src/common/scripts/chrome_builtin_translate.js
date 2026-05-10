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
const PROMPT_API_DEFAULT_OUTPUT_LANGUAGE = "en";
const GEMINI_NANO_CREATE_TIMEOUT_MS = 45000;
const GEMINI_NANO_PROMPT_TIMEOUT_MS = 60000;
const DICTIONARY_RESULT_SCHEMA = JSON.stringify({
    translation: "...",
    detailedMeanings: [{ pos: "...", meaning: "...", synonyms: ["..."] }],
    definitions: [{ pos: "...", meaning: "...", example: "...", synonyms: ["..."] }],
    examples: [{ source: "...", target: "..." }],
});

const TRANSLATION_RESULT_SCHEMA = JSON.stringify({
    translation: "...",
});
const LATIN_TARGET_LANGUAGES = new Set([
    "en",
    "fr",
    "de",
    "es",
    "it",
    "pt",
    "vi",
    "id",
    "tr",
    "nl",
    "pl",
    "cs",
    "da",
    "fi",
    "hr",
    "hu",
    "lt",
    "no",
    "ro",
    "sk",
    "sl",
    "sv",
]);
const CYRILLIC_TARGET_LANGUAGES = new Set(["ru", "uk", "bg"]);
const ABJAD_TARGET_LANGUAGES = new Set(["ar", "iw"]);
const INDIC_TARGET_LANGUAGES = new Set(["hi", "bn", "kn", "mr", "ta", "te"]);
const CJK_OR_KANA_OR_HANGUL = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const CJK_OR_KANA_OR_HANGUL_OR_CYRILLIC = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ff]/;
const KANA_OR_CJK = /[\u3040-\u30ff\u3400-\u9fff]/;
const KANA_OR_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/;
const HANGUL = /[\uac00-\ud7af]/;
const TARGET_LANGUAGE_FRAGMENT_REPLACEMENTS = {
    ko: [
        [/不正ログイン/g, "부정 로그인"],
        [/([가-힣])不正하게/g, "$1 부정하게"],
        [/不正하게/g, "부정하게"],
        [/([가-힣])不正한/g, "$1 부정한"],
        [/不正한/g, "부정한"],
        [/不正/g, "부정"],
        [/ログイン/g, "로그인"],
        [/メールアドレス/g, "이메일 주소"],
        [/パスワード/g, "비밀번호"],
        [/アカウント/g, "계정"],
        [/サービス/g, "서비스"],
        [/オンライン/g, "온라인"],
        [/メンテナンス/g, "유지 보수"],
    ],
    en: [
        [/不正ログイン/g, "unauthorized login"],
        [/不正/g, "unauthorized"],
        [/ログイン/g, "login"],
        [/メールアドレス/g, "email address"],
        [/パスワード/g, "password"],
        [/アカウント/g, "account"],
    ],
};

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
        bg: "Bulgarian",
        bn: "Bengali",
        cs: "Czech",
        da: "Danish",
        el: "Greek",
        fi: "Finnish",
        hr: "Croatian",
        hu: "Hungarian",
        iw: "Hebrew",
        kn: "Kannada",
        lt: "Lithuanian",
        mr: "Marathi",
        no: "Norwegian",
        ro: "Romanian",
        sk: "Slovak",
        sl: "Slovenian",
        sv: "Swedish",
        ta: "Tamil",
        te: "Telugu",
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

function unescapeLooseJsonString(value) {
    return String(value || "")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, String.fromCharCode(34))
        .replace(/\\\\/g, "\\")
        .trim();
}

function extractLooseJsonStringField(text, field, nextFields = []) {
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

function parseLooseGeminiNanoTranslationOutput(output, originalText) {
    const cleaned = normalizeGeminiNanoOutput(output);
    if (!/["']translation["']\s*:/i.test(cleaned)) return null;

    const mainMeaning = extractLooseJsonStringField(cleaned, "translation", [
        "mainMeaning",
        "translatedText",
        "tPronunciation",
        "sPronunciation",
        "detailedMeanings",
        "definitions",
        "examples",
    ]);
    if (!mainMeaning) return null;

    return {
        originalText,
        mainMeaning,
        translatedText: mainMeaning,
    };
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
    if (jsonStart < 0) return null;
    if (jsonEnd <= jsonStart) {
        const looseResult = parseLooseGeminiNanoTranslationOutput(cleaned, originalText);
        if (!looseResult) return null;
        return {
            ...looseResult,
            detailedMeanings: [],
            definitions: [],
            examples: [],
        };
    }

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
        const looseResult = parseLooseGeminiNanoTranslationOutput(cleaned, originalText);
        if (!looseResult) return null;
        return {
            ...looseResult,
            detailedMeanings: [],
            definitions: [],
            examples: [],
        };
    }
}

function parseGeminiNanoTranslationOutput(output, originalText) {
    const cleaned = normalizeGeminiNanoOutput(output);
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
        return parseLooseGeminiNanoTranslationOutput(cleaned, originalText);
    }

    try {
        const payload = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
        const mainMeaning = String(
            payload.translation || payload.mainMeaning || payload.translatedText || ""
        ).trim();
        if (!mainMeaning) return null;
        return {
            originalText,
            mainMeaning,
            translatedText: mainMeaning,
        };
    } catch {
        return parseLooseGeminiNanoTranslationOutput(cleaned, originalText);
    }
}

function applyTargetLanguageFragmentReplacements(value, targetLanguage) {
    const normalized = toChromeTranslatorLanguage(targetLanguage || "");
    const replacements = TARGET_LANGUAGE_FRAGMENT_REPLACEMENTS[normalized];
    if (!replacements || typeof value !== "string" || !value) return value;
    return replacements.reduce(
        (text, [pattern, replacement]) => text.replace(pattern, replacement),
        value
    );
}

function normalizeTargetLanguageResult(result, targetLanguage) {
    if (!result) return result;
    const normalizeText = (value) => applyTargetLanguageFragmentReplacements(value, targetLanguage);
    const normalizeItem = (item, fields) => {
        if (!item) return item;
        return fields.reduce(
            (nextItem, field) => ({
                ...nextItem,
                [field]: normalizeText(nextItem[field]),
            }),
            item
        );
    };

    return {
        ...result,
        mainMeaning: normalizeText(result.mainMeaning),
        translatedText: normalizeText(result.translatedText),
        detailedMeanings: Array.isArray(result.detailedMeanings)
            ? result.detailedMeanings.map((item) => ({
                  ...normalizeItem(item, ["meaning"]),
                  synonyms: Array.isArray(item.synonyms)
                      ? item.synonyms.map((synonym) => normalizeText(synonym))
                      : item.synonyms,
              }))
            : result.detailedMeanings,
        definitions: Array.isArray(result.definitions)
            ? result.definitions.map((item) => ({
                  ...normalizeItem(item, ["meaning", "example"]),
                  synonyms: Array.isArray(item.synonyms)
                      ? item.synonyms.map((synonym) => normalizeText(synonym))
                      : item.synonyms,
              }))
            : result.definitions,
        examples: Array.isArray(result.examples)
            ? result.examples.map((item) => normalizeItem(item, ["target"]))
            : result.examples,
    };
}

function getTargetLanguageOutputRule(targetLanguage) {
    const normalized = toChromeTranslatorLanguage(targetLanguage || "");
    if (!normalized || normalized === "auto") return null;

    const languageName = toLanguageName(normalized);
    const baseInstruction = [
        `For ${languageName} output, translate every source-language word and sentence into natural ${languageName}.`,
        "Keep only URLs, numbers, code, brand/product names, and customary proper nouns unchanged.",
        "Do not leave untranslated source-script fragments in normal prose.",
    ].join(" ");

    if (normalized === "ko") {
        return {
            languageName,
            disallowedScriptPattern: KANA_OR_CJK,
            repairInstruction: `${baseInstruction} Use Hangul Korean for translated prose.`,
        };
    }
    if (normalized === "ja") {
        return {
            languageName,
            disallowedScriptPattern: HANGUL,
            repairInstruction: `${baseInstruction} Use natural Japanese writing for translated prose.`,
        };
    }
    if (normalized === "zh" || normalized === "zh-Hant") {
        return {
            languageName,
            disallowedScriptPattern: KANA_OR_HANGUL,
            repairInstruction: `${baseInstruction} Use ${
                normalized === "zh-Hant" ? "Traditional Chinese" : "Simplified Chinese"
            } for translated prose.`,
        };
    }
    if (LATIN_TARGET_LANGUAGES.has(normalized)) {
        return {
            languageName,
            disallowedScriptPattern: CJK_OR_KANA_OR_HANGUL_OR_CYRILLIC,
            repairInstruction: `${baseInstruction} Use the normal Latin-script form of ${languageName}.`,
        };
    }
    if (CYRILLIC_TARGET_LANGUAGES.has(normalized)) {
        return {
            languageName,
            disallowedScriptPattern: CJK_OR_KANA_OR_HANGUL,
            repairInstruction: `${baseInstruction} Use natural Cyrillic ${languageName}.`,
        };
    }
    if (ABJAD_TARGET_LANGUAGES.has(normalized) || INDIC_TARGET_LANGUAGES.has(normalized)) {
        return {
            languageName,
            disallowedScriptPattern: CJK_OR_KANA_OR_HANGUL_OR_CYRILLIC,
            repairInstruction: baseInstruction,
        };
    }
    if (normalized === "th") {
        return {
            languageName,
            disallowedScriptPattern: CJK_OR_KANA_OR_HANGUL_OR_CYRILLIC,
            repairInstruction: `${baseInstruction} Use natural Thai script for translated prose.`,
        };
    }
    return {
        languageName,
        disallowedScriptPattern: CJK_OR_KANA_OR_HANGUL_OR_CYRILLIC,
        repairInstruction: baseInstruction,
    };
}

function buildGeminiNanoPrompt(text, sourceLanguage, targetLanguage) {
    const targetRule = getTargetLanguageOutputRule(targetLanguage);
    const targetSpecificRules = targetRule
        ? [
              targetRule.repairInstruction,
              `The final answer must read as natural ${targetRule.languageName}.`,
          ]
        : [];

    if (isDictionaryCandidate(text)) {
        return [
            "Translate the following word or short term.",
            `Source language: ${toLanguageName(sourceLanguage)}.`,
            `Target language: ${toLanguageName(targetLanguage)}.`,
            "Return strict JSON only. Do not use markdown.",
            "Schema:",
            DICTIONARY_RESULT_SCHEMA,
            "Keep details concise. Write meanings, definitions, and translated examples in the target language.",
            ...targetSpecificRules,
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
            ...targetSpecificRules,
            "Translate text after each marker. No notes. No markdown.",
            text,
        ].join("\n");
    }

    return [
        `Translate ${toLanguageName(sourceLanguage)} to ${toLanguageName(targetLanguage)}.`,
        "Return strict JSON only. Do not use markdown.",
        "Schema:",
        TRANSLATION_RESULT_SCHEMA,
        "translation must contain the complete translated text.",
        ...targetSpecificRules,
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
    const outputLanguage = targetPromptLanguage || PROMPT_API_DEFAULT_OUTPUT_LANGUAGE;
    if (sourcePromptLanguage) inputLanguages.add(sourcePromptLanguage);
    if (targetPromptLanguage) inputLanguages.add(targetPromptLanguage);

    return {
        expectedInputs: [{ type: "text", languages: Array.from(inputLanguages) }],
        expectedOutputs: [{ type: "text", languages: [outputLanguage] }],
    };
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
                        "Keep URLs, numbers, line breaks, and <<<EDGE_TRANSLATE_SEGMENT_N>>> markers unchanged.",
                        "Keep proper names and brands unchanged only when that is customary in the target language.",
                        `Source language: ${toLanguageName(sourceLanguage)}.`,
                        `Target language: ${toLanguageName(targetLanguage)}.`,
                        getTargetLanguageOutputRule(targetLanguage)?.repairInstruction || "",
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
            ...normalizeTargetLanguageResult(dictionaryResult, targetLanguage),
            sourceLanguage,
            targetLanguage,
        };
    }

    const structuredResult = !dictionaryCandidate
        ? parseGeminiNanoTranslationOutput(output, text)
        : null;
    if (structuredResult) {
        return {
            ...normalizeTargetLanguageResult(structuredResult, targetLanguage),
            sourceLanguage,
            targetLanguage,
        };
    }

    const translated = applyTargetLanguageFragmentReplacements(
        normalizeGeminiNanoOutput(output),
        targetLanguage
    );
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
