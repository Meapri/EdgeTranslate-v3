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
const CHROME_TRANSLATOR_CACHE_MAX = 8;
const GEMINI_NANO_SESSION_CACHE = new Map();
const GEMINI_NANO_SESSION_CACHE_MAX = 4;
const GEMINI_NANO_SESSION_INFLIGHT = new Map();
const GEMINI_NANO_RESULT_CACHE = new Map();
const LANGUAGE_DETECTION_CACHE = new Map();
const LANGUAGE_DETECTION_CACHE_MAX = 200;
const GEMINI_NANO_RESULT_CACHE_MAX = 300;
const PROMPT_API_LANGUAGE_CODES = new Set(["en", "es", "ja"]);
const DEFAULT_PROMPT_API_OUTPUT_LANGUAGE = "en";
const GEMINI_NANO_CREATE_TIMEOUT_MS = 45000;
const GEMINI_NANO_PROMPT_TIMEOUT_MS = 60000;
const GEMINI_NANO_PROMPT_VERSION = "gemini-nano-prompt-2026-06-25-16";
const GEMINI_NANO_MAX_CHUNK_CHARS = 800;
let chromeBuiltinDetectorSingleton = null;
const AI_TRANSLATION_SYSTEM_PROMPT = [
    "Translate naturally while preserving meaning, tone, intent, nuance, register, context, and character voice.",
    "Output only the translation, or only the exact JSON object when JSON is requested. Do not add notes, alternatives, labels, Markdown, or process narration.",
    "Preserve structure exactly: subtitle cue numbers, timestamps, cue order, block boundaries, line breaks, speaker labels, tags, escaped entities, markup, tables, keys, placeholders, code spans, URLs, file paths, commands, and formatting tokens.",
    "Preserve numeric literals, dates, times, measurements, versions, ratings, prices, percentages, ranges, IDs, model names, product names, file names, and issue numbers exactly unless the target language has a required conventional format.",
    "Preserve proper nouns by default: personal names, organizations, brands, services, places, titles, works, events, laws, technical terms, and account names. Use a standard established target-language form only when it is clearly conventional in context.",
    "Do not phoneticize, respell, translate, explain, or normalize unfamiliar names, dates, or numbers. Keep forms like 2024, GPT-5.5, sk-proj, iPhone, GitHub, and Pokemon-style names as written unless the source itself translates them.",
    "Translate only human-language payload. Resolve ambiguity conservatively from local context, keeping subtext, politeness, technical precision, humor, vulgarity, fragments, interruptions, and intentional odd phrasing.",
].join(" ");

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

function cloneGeminiNanoResult(result) {
    if (!result) {
        return result;
    }
    const clone = { ...result };
    if (Array.isArray(result.detailedMeanings))
        clone.detailedMeanings = [...result.detailedMeanings];
    if (Array.isArray(result.definitions)) clone.definitions = [...result.definitions];
    if (Array.isArray(result.examples)) clone.examples = [...result.examples];
    return clone;
}

function evictOldestFromMap(map, max, onEvict) {
    while (map.size >= max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        const value = map.get(oldest);
        map.delete(oldest);
        if (onEvict) onEvict(value);
    }
}

function makeGeminiNanoResultCacheKey(text, from, to, options = {}) {
    return [
        GEMINI_NANO_PROMPT_VERSION,
        String(from || "auto"),
        String(to || ""),
        String(options.draftTranslation || "").trim(),
        options.fastPostEdit ? "fast-post-edit" : "standard",
        String(text || "").trim(),
    ].join("||");
}

function getCachedGeminiNanoResult(text, from, to, options = {}) {
    const key = makeGeminiNanoResultCacheKey(text, from, to, options);
    const cached = GEMINI_NANO_RESULT_CACHE.get(key);
    return cached ? cloneGeminiNanoResult(cached) : null;
}

function rememberGeminiNanoResult(text, from, to, result, options = {}) {
    if (!result) return;
    const key = makeGeminiNanoResultCacheKey(text, from, to, options);
    if (GEMINI_NANO_RESULT_CACHE.size >= GEMINI_NANO_RESULT_CACHE_MAX) {
        const oldestKey = GEMINI_NANO_RESULT_CACHE.keys().next().value;
        if (oldestKey) GEMINI_NANO_RESULT_CACHE.delete(oldestKey);
    }
    GEMINI_NANO_RESULT_CACHE.set(key, cloneGeminiNanoResult(result));
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

function normalizeGeminiNanoPartialOutput(output) {
    const cleaned = normalizeGeminiNanoOutput(output);
    if (!cleaned) return "";

    const translationValue = extractLooseJsonStringField(cleaned, "translation", [
        "mainMeaning",
        "translatedText",
        "tPronunciation",
        "sPronunciation",
        "detailedMeanings",
        "definitions",
        "examples",
    ]);
    if (translationValue) return translationValue;

    const translationMatch = /["']translation["']\s*:\s*["']([\s\S]*)$/i.exec(cleaned);
    if (translationMatch) {
        return unescapeLooseJsonString(translationMatch[1].replace(/["'}\s]*$/g, ""));
    }

    const withoutPrefix = cleaned.replace(/^\{?\s*["']?translation["']?\s*:?\s*/i, "").trim();
    if (!withoutPrefix || /^[{}"':,\s]+$/.test(withoutPrefix)) return "";
    return withoutPrefix;
}

function isDictionaryCandidate(text) {
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

function parseGeminiNanoOutput(output, originalText, asDictionary) {
    const cleaned = normalizeGeminiNanoOutput(output);
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");

    const looseFallback = () => {
        const looseResult = parseLooseGeminiNanoTranslationOutput(cleaned, originalText);
        if (!looseResult) {
            if (!cleaned) return null;
            return {
                originalText,
                mainMeaning: cleaned,
                translatedText: cleaned,
            };
        }
        return asDictionary
            ? {
                  ...looseResult,
                  detailedMeanings: [],
                  definitions: [],
                  examples: [],
              }
            : looseResult;
    };

    if (jsonStart < 0 || jsonEnd <= jsonStart) return looseFallback();

    try {
        const payload = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
        const mainMeaning = String(
            payload.translation || payload.mainMeaning || payload.translatedText || ""
        ).trim();
        if (!mainMeaning) return looseFallback();

        const result = {
            originalText,
            mainMeaning,
            translatedText: mainMeaning,
        };

        if (asDictionary) {
            const toArray = (value) => (Array.isArray(value) ? value : []);
            const pickString = (item, keys) => {
                for (const key of keys) {
                    const value = item?.[key];
                    if (value !== undefined && value !== null && String(value).trim()) {
                        return String(value).trim();
                    }
                }
                return null;
            };
            Object.assign(result, {
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
                    }))
                    .filter((item) => item.source || item.target),
            });
        }
        return result;
    } catch {
        return looseFallback();
    }
}

function buildGeminiNanoPrompt(text, sourceLanguage, targetLanguage, options = {}) {
    const targetName = toLanguageName(targetLanguage);
    const sourceName =
        sourceLanguage && sourceLanguage !== "auto" ? toLanguageName(sourceLanguage) : null;
    const promptBody = String(text || "").trim();
    const draftTranslation = String(options.draftTranslation || "").trim();
    const direction = [
        sourceName
            ? `Source language: ${sourceName}.`
            : "Source language: detected source language.",
        `Target language: ${targetName}.`,
    ].join("\n");

    if (draftTranslation) {
        return [
            direction,
            "Use the draft only as a candidate translation. Correct it where needed while obeying the system prompt.",
            "",
            "SOURCE:",
            promptBody,
            "",
            "DRAFT:",
            draftTranslation,
        ].join("\n");
    }

    return [direction, "", promptBody].join("\n");
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

    return {
        expectedInputs: [{ type: "text", languages: Array.from(inputLanguages) }],
        expectedOutputs: [
            {
                type: "text",
                languages: [targetPromptLanguage || DEFAULT_PROMPT_API_OUTPUT_LANGUAGE],
            },
        ],
        temperature: 0,
        topK: 1,
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

function buildGeminiNanoSystemPrompt() {
    return AI_TRANSLATION_SYSTEM_PROMPT;
}

async function getGeminiNanoSession(sourceLanguage, targetLanguage) {
    const key = `${GEMINI_NANO_PROMPT_VERSION}|${sourceLanguage}|${targetLanguage}`;
    if (GEMINI_NANO_SESSION_CACHE.has(key)) return GEMINI_NANO_SESSION_CACHE.get(key);

    // Deduplicate concurrent session creation for the same key
    if (GEMINI_NANO_SESSION_INFLIGHT.has(key)) return GEMINI_NANO_SESSION_INFLIGHT.get(key);

    const promise = createAndWarmGeminiNanoSession(sourceLanguage, targetLanguage, key);
    GEMINI_NANO_SESSION_INFLIGHT.set(key, promise);
    try {
        return await promise;
    } finally {
        GEMINI_NANO_SESSION_INFLIGHT.delete(key);
    }
}

async function createAndWarmGeminiNanoSession(sourceLanguage, targetLanguage, cacheKey) {
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

    const makeInitialPrompts = () => [
        {
            role: "system",
            content: buildGeminiNanoSystemPrompt(),
        },
    ];

    const abortController =
        typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
    const session = await withTimeout(
        languageModelApi.create({
            ...createOptions,
            ...(abortController ? { signal: abortController.signal } : {}),
            monitor(monitor) {
                monitor.addEventListener("downloadprogress", () => {});
            },
            initialPrompts: makeInitialPrompts(),
        }),
        GEMINI_NANO_CREATE_TIMEOUT_MS,
        "Chrome Gemini Nano session creation timed out while preparing the on-device model. Gemini Nano may still be downloading or not installed yet. Open chrome://on-device-internals or chrome://components and finish the Optimization Guide On Device Model download.",
        abortController
    );

    // Warm up the on-device model by sending a trivial prompt on the first
    // session.  This forces the model weights fully into GPU/NPU memory.
    // Afterward, we create a FRESH session (with no conversation history) and
    // cache that one instead.  The second create() is near-instant because
    // the model is already loaded.
    let sessionDestroyed = false;
    try {
        if (typeof session.prompt === "function") {
            await session.prompt("Translate:\nOK");
        }
        if (typeof session.destroy === "function") {
            session.destroy();
            sessionDestroyed = true;
        }
        // Create a fresh session with timeout — the model is already loaded, so this is fast.
        const freshSession = await withTimeout(
            languageModelApi.create({
                ...createOptions,
                initialPrompts: makeInitialPrompts(),
            }),
            GEMINI_NANO_CREATE_TIMEOUT_MS,
            "Chrome Gemini Nano fresh session creation timed out after warmup."
        );
        evictOldestFromMap(GEMINI_NANO_SESSION_CACHE, GEMINI_NANO_SESSION_CACHE_MAX, (old) => {
            if (typeof old?.destroy === "function") old.destroy();
        });
        GEMINI_NANO_SESSION_CACHE.set(cacheKey, freshSession);
        return freshSession;
    } catch {
        // If the original session was already destroyed, we cannot reuse it — clear the key.
        if (sessionDestroyed) {
            GEMINI_NANO_SESSION_CACHE.delete(cacheKey);
            throw new Error(
                "Chrome Gemini Nano warm-up succeeded but fresh session creation failed."
            );
        }
        evictOldestFromMap(GEMINI_NANO_SESSION_CACHE, GEMINI_NANO_SESSION_CACHE_MAX, (old) => {
            if (typeof old?.destroy === "function") old.destroy();
        });
        GEMINI_NANO_SESSION_CACHE.set(cacheKey, session);
        return session;
    }
}

function appendPromptStreamChunk(output, chunk) {
    const value = String(chunk || "");
    if (!value) return output;
    if (value.startsWith(output)) return value;
    return `${output}${value}`;
}

async function readGeminiNanoPromptOutput(session, prompt, options = {}) {
    const { preferStreaming = true, onUpdate } = options;
    let promptSession;
    try {
        promptSession =
            session && typeof session.clone === "function" ? await session.clone() : session;
    } catch {
        // clone() failed — fall back to the original session directly
        promptSession = session;
    }
    try {
        return await readGeminiNanoPromptOutputFromSession(promptSession, prompt, {
            preferStreaming,
            onUpdate,
        });
    } finally {
        if (promptSession !== session && typeof promptSession?.destroy === "function") {
            promptSession.destroy();
        }
    }
}

async function readGeminiNanoPromptOutputFromSession(session, prompt, options = {}) {
    const { preferStreaming = true, onUpdate } = options;
    const safeOnUpdate = (value) => {
        try {
            onUpdate?.(value);
        } catch {
            /* ignore callback errors */
        }
    };
    if (preferStreaming && session && typeof session.promptStreaming === "function") {
        const stream = await session.promptStreaming(prompt);
        if (stream && typeof stream[Symbol.asyncIterator] === "function") {
            let output = "";
            for await (const chunk of stream) {
                output = appendPromptStreamChunk(output, chunk);
                safeOnUpdate(output);
            }
            return output;
        }
        if (stream && typeof stream.getReader === "function") {
            const reader = stream.getReader();
            try {
                let output = "";
                let done = false;
                while (!done) {
                    const chunk = await reader.read();
                    done = chunk.done;
                    const value = chunk.value;
                    if (done) break;
                    output = appendPromptStreamChunk(output, value);
                    safeOnUpdate(output);
                }
                return output;
            } finally {
                reader.releaseLock();
            }
        }
        return typeof stream === "string" ? stream : String(stream || "");
    }
    return session.prompt(prompt);
}

async function warmupChromeOnDevice(from, to) {
    const targetLanguage = toChromeTranslatorLanguage(to);
    const sourceLanguage = from === "auto" ? "auto" : toChromeTranslatorLanguage(from);
    await getGeminiNanoSession(sourceLanguage, targetLanguage);
    return { sourceLanguage, targetLanguage };
}

function stripSegmentMarkersForLanguageDetection(text) {
    return String(text || "")
        .replace(/<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
}

function detectSourceLanguageByScript(text, targetLanguage) {
    const source = stripSegmentMarkersForLanguageDetection(text);
    if (!source) return "auto";

    const count = (pattern) => (source.match(pattern) || []).length;
    const kana = count(/[\u3040-\u30ff]/g);
    const hangul = count(/[\uac00-\ud7af]/g);
    const cyrillic = count(/[\u0400-\u04ff]/g);
    const arabic = count(/[\u0600-\u06ff]/g);
    const han = count(/[\u3400-\u9fff]/g);

    let detected = "auto";
    if (kana > 0) detected = "ja";
    else if (hangul > 0) detected = "ko";
    else if (cyrillic > 0) detected = "ru";
    else if (arabic > 0) detected = "ar";
    else if (han > 0) detected = "zh";

    return detected && detected !== targetLanguage ? detected : "auto";
}

async function detectGeminiNanoSourceLanguage(text, targetLanguage) {
    const detectionText = stripSegmentMarkersForLanguageDetection(text);
    // Use a stable prefix as cache key so the same text always yields the same language.
    const cacheKey = `${(detectionText || "").slice(0, 200)}|${targetLanguage}`;
    if (LANGUAGE_DETECTION_CACHE.has(cacheKey)) return LANGUAGE_DETECTION_CACHE.get(cacheKey);

    let result = "auto";
    const detectorApi = globalThis.LanguageDetector;
    if (detectorApi && typeof detectorApi.create === "function" && detectionText) {
        try {
            if (!detectGeminiNanoSourceLanguage._detector) {
                detectGeminiNanoSourceLanguage._detector = await detectorApi.create();
            }
            const detector = detectGeminiNanoSourceLanguage._detector;
            const detections = await detector.detect(detectionText);
            const detected = Array.isArray(detections) ? detections[0]?.detectedLanguage : "";
            const normalized = toChromeTranslatorLanguage(detected || "");
            if (normalized && normalized !== targetLanguage) result = normalized;
        } catch {
            // Fall back to a lightweight script-based guess below.
        }
    }
    if (result === "auto") {
        result = detectSourceLanguageByScript(detectionText, targetLanguage);
    }

    // Evict oldest entries when the cache is full.
    if (LANGUAGE_DETECTION_CACHE.size >= LANGUAGE_DETECTION_CACHE_MAX) {
        const oldest = LANGUAGE_DETECTION_CACHE.keys().next().value;
        LANGUAGE_DETECTION_CACHE.delete(oldest);
    }
    LANGUAGE_DETECTION_CACHE.set(cacheKey, result);
    return result;
}

function getSegmentMarkerPattern() {
    return /<<<EDGE_TRANSLATE_SEGMENT_(\d+)(?:\s+role=([a-z-]+))?>>>/gi;
}

function parseMarkedSegments(text) {
    const source = String(text || "");
    const matches = Array.from(source.matchAll(getSegmentMarkerPattern()));
    if (!matches.length) return [];

    return matches.map((match, index) => {
        const start = match.index + match[0].length;
        const next = matches[index + 1];
        const end = next ? next.index : source.length;
        return {
            marker: match[0],
            role: match[2] || "text",
            text: source.slice(start, end).trim(),
        };
    });
}

// Preserve non-translatable formatting characters through translation.
// Uses Unicode "Symbol, Other" category (\p{So}) which naturally covers decorative
// symbols (※, →, ★, ●, ◆, ■, ▲, etc.) without hardcoding.
// ・ (U+30FB) is added explicitly as it's classified as punctuation but acts as
// a list separator that models consistently drop during translation.
const PASSTHROUGH_PUNCTUATION = /[\p{So}\u30FB]/gu;

function extractPassthroughPunctuation(text) {
    const chars = [];
    const processed = String(text || "").replace(PASSTHROUGH_PUNCTUATION, (match) => {
        const id = chars.length;
        chars.push(match);
        return `{{P${id}}}`;
    });
    return { processed, chars };
}

function restorePassthroughPunctuation(text, chars) {
    if (!chars.length) return text;
    return String(text || "").replace(/\{\{P(\d+)\}\}/g, (_, id) => {
        return chars[parseInt(id, 10)] || "";
    });
}

function unwrapSingleMarkedTranslation(translated) {
    const text = String(translated || "").trim();
    const match = /^<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>\s*([\s\S]+)$/i.exec(text);
    return match ? match[1].trim() : text;
}

function normalizeForCopiedSourceComparison(text) {
    return String(text || "")
        .replace(/<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

function removeCopiedSourceLines(translatedText, originalText) {
    const sourceNorm = normalizeForCopiedSourceComparison(originalText);
    const text = String(translatedText || "").trim();
    if (!sourceNorm || !text) return text;

    const lines = text.split(/\r?\n/);
    const keptLines = lines.filter(
        (line) => normalizeForCopiedSourceComparison(line) !== sourceNorm
    );
    const keptText = keptLines.join("\n").trim();
    return keptText && keptText !== text ? keptText : text;
}

function applyPostTranslationRules(translatedText, targetLanguage) {
    let text = String(translatedText || "");
    const lang = toChromeTranslatorLanguage(targetLanguage);
    if (lang === "ko") {
        text = text.replace(/국세\s*조사/g, "인구총조사");
    }
    return text;
}

// Smart text splitting: paragraphs → lines → sentences → hard split
function smartSplitText(text, maxLen) {
    const chunks = [];
    let current = "";
    const paragraphs = text.split(/(?<=\n\n)/);
    for (const p of paragraphs) {
        if (current.length + p.length <= maxLen) {
            current += p;
        } else {
            if (current) {
                chunks.push(current);
                current = "";
            }
            if (p.length > maxLen) {
                const lines = p.split(/(?<=\n)/);
                for (const l of lines) {
                    if (current.length + l.length <= maxLen) {
                        current += l;
                    } else {
                        if (current) chunks.push(current);
                        current = l;
                        if (current.length > maxLen) {
                            const sentences = current.split(/(?<=[.!?。！？](?:\s+|$))/);
                            current = "";
                            for (const s of sentences) {
                                if (current.length + s.length <= maxLen) {
                                    current += s;
                                } else {
                                    if (current) chunks.push(current);
                                    current = s;
                                    while (current.length > maxLen) {
                                        chunks.push(current.slice(0, maxLen));
                                        current = current.slice(maxLen);
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                current = p;
            }
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function getTranslatedChunkSeparator(previousSourceChunk, nextSourceChunk) {
    const previous = String(previousSourceChunk || "");
    const next = String(nextSourceChunk || "");
    if (/\n\s*\n\s*$/.test(previous) || /^\s*\n\s*\n/.test(next)) return "\n\n";
    if (/\n\s*$/.test(previous) || /^\s*\n/.test(next)) return "\n";
    return "";
}

async function translateWithGeminiNano(text, from, to, options = {}) {
    if (!text || !String(text).trim()) {
        return {
            originalText: text || "",
            mainMeaning: "",
            translatedText: "",
            sourceLanguage: from,
            targetLanguage: to,
        };
    }
    const cachedResult = getCachedGeminiNanoResult(text, from, to, options);
    if (cachedResult) {
        options.onUpdate?.({
            ...cachedResult,
            streamState: "committed",
            streamProgress: { current: 1, total: 1 },
        });
        return cachedResult;
    }

    const targetLanguage = toChromeTranslatorLanguage(to);
    const sourceLanguage =
        from === "auto"
            ? await detectGeminiNanoSourceLanguage(text, targetLanguage)
            : toChromeTranslatorLanguage(from);
    const session = await getGeminiNanoSession(sourceLanguage, targetLanguage);
    const dictionaryCandidate = !options.draftTranslation && isDictionaryCandidate(text);
    const emitPartialResult = (normalizedPartial, originalText = text, meta = {}) => {
        if (!normalizedPartial) return;
        options.onUpdate?.({
            originalText,
            mainMeaning: normalizedPartial,
            translatedText: normalizedPartial,
            sourceLanguage,
            targetLanguage,
            ...meta,
        });
    };
    const parseResult = (rawOutput, originalText = text, asDictionary = dictionaryCandidate) => {
        return parseGeminiNanoOutput(rawOutput, originalText, asDictionary);
    };

    const promptAndParse = async (inputText, asDictionary, onPartial) => {
        const output = await withTimeout(
            readGeminiNanoPromptOutput(
                session,
                buildGeminiNanoPrompt(inputText, sourceLanguage, targetLanguage, {
                    allowDictionary: asDictionary,
                    draftTranslation: options.draftTranslation,
                }),
                {
                    preferStreaming: !options.fastPostEdit,
                    onUpdate: (partial) => {
                        const normalized = applyPostTranslationRules(
                            normalizeGeminiNanoPartialOutput(partial),
                            targetLanguage
                        );
                        if (normalized) onPartial?.(normalized);
                    },
                }
            ),
            GEMINI_NANO_PROMPT_TIMEOUT_MS,
            "Chrome Gemini Nano prompt timed out."
        );
        const parsed = parseResult(output, inputText, asDictionary);
        if (parsed) {
            if (parsed.translatedText) {
                parsed.translatedText = applyPostTranslationRules(
                    removeCopiedSourceLines(parsed.translatedText, inputText),
                    targetLanguage
                );
            }
            if (parsed.mainMeaning) {
                parsed.mainMeaning = applyPostTranslationRules(
                    removeCopiedSourceLines(parsed.mainMeaning, inputText),
                    targetLanguage
                );
            }
        }
        return parsed;
    };

    const promptAndParseChunked = async (inputText, asDictionary, onPartial) => {
        if (asDictionary || inputText.length <= GEMINI_NANO_MAX_CHUNK_CHARS) {
            return promptAndParse(inputText, asDictionary, onPartial);
        }
        const chunks = smartSplitText(inputText, GEMINI_NANO_MAX_CHUNK_CHARS);
        let fullTranslated = "";
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            const result = await promptAndParse(chunk, false, (partial) => {
                onPartial?.(fullTranslated + partial);
            });
            if (result && result.translatedText) {
                if (fullTranslated) {
                    fullTranslated += getTranslatedChunkSeparator(chunks[index - 1], chunk);
                }
                fullTranslated += result.translatedText;
            }
        }
        return {
            originalText: inputText,
            mainMeaning: fullTranslated,
            translatedText: fullTranslated,
        };
    };

    let parsedResult;
    if (dictionaryCandidate) {
        const { processed: safeText, chars: savedChars } = extractPassthroughPunctuation(
            String(text || "").trim()
        );
        parsedResult = await promptAndParse(safeText, true, (partial) =>
            emitPartialResult(restorePassthroughPunctuation(partial, savedChars))
        );
    } else {
        const segments = parseMarkedSegments(text);
        if (segments.length) {
            const translatedSegments = [];
            for (const segment of segments) {
                const { processed: segSafe, chars: segChars } = extractPassthroughPunctuation(
                    segment.text
                );
                const segResult = await promptAndParseChunked(segSafe, false, (partial) => {
                    const restored = restorePassthroughPunctuation(partial, segChars);
                    const partialSegment = `${segment.marker}\n${unwrapSingleMarkedTranslation(
                        restored
                    )}`;
                    emitPartialResult([...translatedSegments, partialSegment].join("\n"));
                });
                if (!segResult)
                    throw new Error("Chrome Gemini Nano returned an empty translation.");
                const segTranslated = restorePassthroughPunctuation(
                    String(segResult.mainMeaning || segResult.translatedText || "").trim(),
                    segChars
                );
                translatedSegments.push(
                    `${segment.marker}\n${unwrapSingleMarkedTranslation(segTranslated)}`
                );
            }
            const translatedText = translatedSegments.join("\n");
            parsedResult = {
                originalText: text,
                mainMeaning: translatedText,
                translatedText,
            };
        } else {
            const { processed: safeText, chars: savedChars } = extractPassthroughPunctuation(
                String(text || "").trim()
            );
            parsedResult = await promptAndParseChunked(safeText, false, (partial) =>
                emitPartialResult(restorePassthroughPunctuation(partial, savedChars))
            );
            if (parsedResult) {
                parsedResult.mainMeaning = restorePassthroughPunctuation(
                    parsedResult.mainMeaning,
                    savedChars
                );
                parsedResult.translatedText = parsedResult.mainMeaning;
            }
        }
    }
    if (!parsedResult) throw new Error("Chrome Gemini Nano returned an empty translation.");

    const finalResult = {
        ...parsedResult,
        sourceLanguage,
        targetLanguage,
    };
    rememberGeminiNanoResult(text, from, to, finalResult, options);
    return finalResult;
}

async function detectChromeBuiltinLanguage(text, targetLanguage) {
    const detectorApi = globalThis.LanguageDetector;
    if (!detectorApi || typeof detectorApi.create !== "function") {
        throw new Error(
            "Chrome built-in Translator API requires an explicit source language when Language Detector API is unavailable."
        );
    }

    if (!chromeBuiltinDetectorSingleton) {
        chromeBuiltinDetectorSingleton = await detectorApi.create();
    }
    const detections = await chromeBuiltinDetectorSingleton.detect(text);
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
    if (!translatorApi || typeof translatorApi.create !== "function") {
        throw new Error("Chrome built-in Translator API is not available in this browser context.");
    }
    if (typeof translatorApi.availability === "function") {
        const availability = await translatorApi.availability({ sourceLanguage, targetLanguage });
        if (availability === "unavailable") {
            throw new Error(
                `Chrome built-in Translator API does not support ${sourceLanguage} to ${targetLanguage}.`
            );
        }
    }

    const translator = await translatorApi.create({ sourceLanguage, targetLanguage });
    evictOldestFromMap(CHROME_TRANSLATOR_CACHE, CHROME_TRANSLATOR_CACHE_MAX, (old) => {
        if (typeof old?.destroy === "function") old.destroy();
    });
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

async function translateWithChromeOnDevice(text, from, to, options = {}) {
    return translateWithGeminiNano(text, from, to, options);
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
