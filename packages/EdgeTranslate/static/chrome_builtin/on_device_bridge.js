(() => {
    if (window.__edgeTranslateOnDeviceBridgeInitialized) return;
    window.__edgeTranslateOnDeviceBridgeInitialized = true;

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
        he: "iw",
        iw: "iw",
    };

    const translatorCache = new Map();
    const TRANSLATOR_CACHE_MAX = 8;
    const geminiNanoSessionCache = new Map();
    const GEMINI_NANO_SESSION_CACHE_MAX = 4;
    const geminiNanoSessionInflight = new Map();
    const languageDetectionCache = new Map();
    const LANGUAGE_DETECTION_CACHE_MAX = 200;
    const PROMPT_API_LANGUAGE_CODES = new Set(["en", "es", "ja"]);
    const DEFAULT_PROMPT_API_OUTPUT_LANGUAGE = "en";
    const GEMINI_NANO_CREATE_TIMEOUT_MS = 45000;
    const GEMINI_NANO_PROMPT_TIMEOUT_MS = 60000;
    const GEMINI_NANO_PROMPT_VERSION = "gemini-nano-prompt-2026-06-25-16";
    const GEMINI_NANO_MAX_CHUNK_CHARS = 800;
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



    async function detectChromeBuiltinLanguage(text, targetLanguage) {
        const detectorApi = window.LanguageDetector;
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
        if (translatorCache.has(key)) return translatorCache.get(key);

        const translatorApi = window.Translator;
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
        evictOldestFromMap(translatorCache, TRANSLATOR_CACHE_MAX);
        translatorCache.set(key, translator);
        return translator;
    }

    async function translateWithChromeBuiltin(text, from, to) {
        const translatorApi = window.Translator;
        if (!translatorApi || typeof translatorApi.create !== "function") {
            throw new Error(
                "Chrome built-in Translator API is not available in this page context."
            );
        }

        const targetLanguage = toChromeTranslatorLanguage(to);
        const sourceLanguage =
            from === "auto"
                ? await detectChromeBuiltinLanguage(text, targetLanguage)
                : toChromeTranslatorLanguage(from);

        const translator = await getChromeBuiltinTranslator(sourceLanguage, targetLanguage);
        const translated = await translator.translate(text);
        if (!translated)
            throw new Error("Chrome built-in Translator API returned an empty translation.");
        return {
            originalText: text,
            mainMeaning: translated,
            translatedText: translated,
            sourceLanguage,
            targetLanguage,
        };
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
        const endPattern = new RegExp(
            `["']\\s*,\\s*(?:${nextFieldPattern})|["']\\s*[,}]\\s*$`,
            "i"
        );
        const endMatch = endPattern.exec(rest);
        const raw = endMatch ? rest.slice(0, endMatch.index) : rest.replace(/["'}\s]*$/g, "");
        return unescapeLooseJsonString(raw);
    }

    function extractGeminiNanoTranslationText(output) {
        const cleaned = normalizeGeminiNanoOutput(output);
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
                // Fall through to a loose streaming-style extraction.
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
            ]) || cleaned
        );
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

    function appendPromptStreamChunk(output, chunk) {
        const value = String(chunk || "");
        if (!value) return output;
        if (value.startsWith(output)) return value;
        return `${output}${value}`;
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
        };
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
        if (geminiNanoSessionCache.has(key)) return geminiNanoSessionCache.get(key);

        // Deduplicate concurrent session creation for the same key
        if (geminiNanoSessionInflight.has(key)) return geminiNanoSessionInflight.get(key);

        const promise = createAndWarmGeminiNanoSession(sourceLanguage, targetLanguage, key);
        geminiNanoSessionInflight.set(key, promise);
        try {
            return await promise;
        } finally {
            geminiNanoSessionInflight.delete(key);
        }
    }

    async function createAndWarmGeminiNanoSession(sourceLanguage, targetLanguage, cacheKey) {
        const languageModelApi = window.LanguageModel;
        if (!languageModelApi || typeof languageModelApi.create !== "function") {
            throw new Error(
                "Chrome Gemini Nano LanguageModel API is not available in this page context."
            );
        }
        const createOptions = getGeminiNanoCreateOptions(sourceLanguage, targetLanguage);
        if (typeof languageModelApi.availability === "function") {
            const availability = await languageModelApi.availability(createOptions);
            if (availability === "unavailable") {
                throw new Error(
                    "Chrome Gemini Nano LanguageModel API is unavailable on this device."
                );
            }
        }

        const makeInitialPrompts = () => [
            { role: "system", content: buildGeminiNanoSystemPrompt() },
        ];

        const abortController =
            typeof window.AbortController === "function" ? new window.AbortController() : null;
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
            "Chrome Gemini Nano session creation timed out while preparing the on-device model. Gemini Nano may still be downloading or not installed yet. Open chrome://on-device-internals or chrome://components and finish the Optimization Guide On Device Model download, then try again.",
            abortController
        );

        // Warm up: prompt the first session, then recreate a clean one
        let sessionDestroyed = false;
        try {
            if (typeof session.prompt === "function") {
                await session.prompt("Translate:\nOK");
            }
            if (typeof session.destroy === "function") {
                session.destroy();
                sessionDestroyed = true;
            }
            const freshSession = await withTimeout(
                languageModelApi.create({
                    ...createOptions,
                    initialPrompts: makeInitialPrompts(),
                }),
                GEMINI_NANO_CREATE_TIMEOUT_MS,
                "Chrome Gemini Nano fresh session creation timed out after warmup."
            );
            evictOldestFromMap(geminiNanoSessionCache, GEMINI_NANO_SESSION_CACHE_MAX, (old) => {
                if (typeof old?.destroy === "function") old.destroy();
            });
            geminiNanoSessionCache.set(cacheKey, freshSession);
            return freshSession;
        } catch {
            if (sessionDestroyed) {
                geminiNanoSessionCache.delete(cacheKey);
                throw new Error(
                    "Chrome Gemini Nano warm-up succeeded but fresh session creation failed."
                );
            }
            evictOldestFromMap(geminiNanoSessionCache, GEMINI_NANO_SESSION_CACHE_MAX, (old) => {
                if (typeof old?.destroy === "function") old.destroy();
            });
            geminiNanoSessionCache.set(cacheKey, session);
            return session;
        }
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
        const cacheKey = `${(detectionText || "").slice(0, 200)}|${targetLanguage}`;
        if (languageDetectionCache.has(cacheKey)) return languageDetectionCache.get(cacheKey);

        let result = "auto";
        const detectorApi = window.LanguageDetector;
        if (detectorApi && typeof detectorApi.create === "function" && detectionText) {
            try {
                const detector = await detectorApi.create();
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

        if (languageDetectionCache.size >= LANGUAGE_DETECTION_CACHE_MAX) {
            const oldest = languageDetectionCache.keys().next().value;
            languageDetectionCache.delete(oldest);
        }
        languageDetectionCache.set(cacheKey, result);
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

    // Smart text splitting: paragraphs → lines → sentences → hard split
    function smartSplitText(text, maxLen) {
        const chunks = [];
        let current = "";
        const paragraphs = text.split(/(?<=\n\n)/);
        for (const p of paragraphs) {
            if (current.length + p.length <= maxLen) {
                current += p;
            } else {
                if (current) { chunks.push(current); current = ""; }
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

    // Preserve non-translatable formatting characters through translation.
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
        const match = /^<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>\s*([\s\S]+)$/i.exec(
            text
        );
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


    async function promptGeminiNano(session, prompt, options = {}) {
        const { onUpdate, preferStreaming = true } = options;
        const promptSession =
            session && typeof session.clone === "function" ? await session.clone() : session;
        try {
            const readPrompt = async () => {
                if (preferStreaming && typeof promptSession.promptStreaming === "function") {
                    const stream = await promptSession.promptStreaming(prompt);
                    let output = "";
                    if (stream && typeof stream[Symbol.asyncIterator] === "function") {
                        for await (const chunk of stream) {
                            output = appendPromptStreamChunk(output, chunk);
                            onUpdate?.(normalizeGeminiNanoPartialOutput(output));
                        }
                        return output;
                    }
                    if (stream && typeof stream.getReader === "function") {
                        const reader = stream.getReader();
                        let done = false;
                        while (!done) {
                            const chunk = await reader.read();
                            done = chunk.done;
                            if (done) break;
                            output = appendPromptStreamChunk(output, chunk.value);
                            onUpdate?.(normalizeGeminiNanoPartialOutput(output));
                        }
                        return output;
                    }
                }
                return promptSession.prompt(prompt);
            };
            return await withTimeout(
                readPrompt(),
                GEMINI_NANO_PROMPT_TIMEOUT_MS,
                "Chrome Gemini Nano prompt timed out."
            );
        } finally {
            if (promptSession !== session && typeof promptSession?.destroy === "function") {
                promptSession.destroy();
            }
        }
    }

    async function translateWithGeminiNano(text, from, to, options = {}) {
        const targetLanguage = toChromeTranslatorLanguage(to);
        const sourceLanguage =
            from === "auto"
                ? await detectGeminiNanoSourceLanguage(text, targetLanguage)
                : toChromeTranslatorLanguage(from);
        const session = await getGeminiNanoSession(sourceLanguage, targetLanguage);
        const emitPartialResult = (partial, originalText = text, meta = {}) => {
            if (!partial) return;
            options.onUpdate?.({
                originalText,
                mainMeaning: partial,
                translatedText: partial,
                sourceLanguage,
                targetLanguage,
                ...meta,
            });
        };

        const { processed: safeText, chars: savedChars } = extractPassthroughPunctuation(
            String(text || "").trim()
        );

        const promptAndParse = async (inputText, onPartial) => {
            const output = await promptGeminiNano(
                session,
                buildGeminiNanoPrompt(inputText, sourceLanguage, targetLanguage, {
                    draftTranslation: options.draftTranslation,
                }),
                {
                    preferStreaming: !options.fastPostEdit,
                    onUpdate(partial) {
                        const normalized = applyPostTranslationRules(
                            normalizeGeminiNanoPartialOutput(partial),
                            targetLanguage
                        );
                        if (normalized) onPartial?.(normalized);
                    },
                }
            );
            const parsed = extractGeminiNanoTranslationText(output);
            return parsed
                ? applyPostTranslationRules(removeCopiedSourceLines(parsed, inputText), targetLanguage)
                : parsed;
        };

        const promptAndParseChunked = async (inputText, onPartial) => {
            if (inputText.length <= GEMINI_NANO_MAX_CHUNK_CHARS) {
                return promptAndParse(inputText, onPartial);
            }
            const chunks = smartSplitText(inputText, GEMINI_NANO_MAX_CHUNK_CHARS);
            let fullTranslated = "";
            for (const chunk of chunks) {
                const result = await promptAndParse(chunk, (partial) => {
                    onPartial?.(fullTranslated + partial);
                });
                if (result) fullTranslated += result;
            }
            return fullTranslated;
        };

        const segments = parseMarkedSegments(text);
        let translated;
        if (segments.length) {
            const translatedSegments = [];
            for (const segment of segments) {
                const { processed: segSafe, chars: segChars } = extractPassthroughPunctuation(
                    segment.text
                );
                const segResult = await promptAndParseChunked(segSafe, (partial) => {
                    const restored = restorePassthroughPunctuation(partial, segChars);
                    const partialSegment = `${segment.marker}\n${unwrapSingleMarkedTranslation(restored)}`;
                    emitPartialResult([...translatedSegments, partialSegment].join("\n"));
                });
                if (!segResult) throw new Error("Chrome Gemini Nano returned an empty translation.");
                const segTranslated = restorePassthroughPunctuation(
                    String(segResult).trim(),
                    segChars
                );
                translatedSegments.push(`${segment.marker}\n${unwrapSingleMarkedTranslation(segTranslated)}`);
            }
            translated = translatedSegments.join("\n");
        } else {
            const parsedResult = await promptAndParseChunked(safeText, (partial) =>
                emitPartialResult(restorePassthroughPunctuation(partial, savedChars))
            );
            if (parsedResult) {
                translated = restorePassthroughPunctuation(parsedResult, savedChars);
            }
        }

        if (!translated) throw new Error("Chrome Gemini Nano returned an empty translation.");

        return {
            originalText: text,
            mainMeaning: translated,
            translatedText: translated,
            sourceLanguage,
            targetLanguage,
        };
    }

    async function translate(detail, onUpdate) {
        const text = detail && detail.text ? String(detail.text) : "";
        const from = (detail && (detail.sl || detail.from)) || "auto";
        const to = (detail && (detail.tl || detail.to)) || "en";
        if (!text.trim()) {
            return {
                originalText: text,
                mainMeaning: "",
                translatedText: "",
                sourceLanguage: from,
                targetLanguage: to,
            };
        }
        if (!detail || detail.engine !== "translator") {
            return translateWithGeminiNano(text, from, to, {
                onUpdate,
                draftTranslation: detail.draftTranslation,
                fastPostEdit: detail.fastPostEdit,
            });
        }
        return translateWithChromeBuiltin(text, from, to);
    }

    window.addEventListener("message", async (event) => {
        if (event.source !== window || !event.data) return;
        if (event.data.type !== "edge_translate_on_device_request") return;
        const requestId = event.data.requestId;
        try {
            const detail = event.data.detail || {};
            const result = await translate(detail, (partial) => {
                window.postMessage(
                    {
                        type: "edge_translate_on_device_stream",
                        requestId,
                        streamId: detail.streamId,
                        result: partial,
                    },
                    "*"
                );
            });
            window.postMessage(
                {
                    type: "edge_translate_on_device_response",
                    requestId,
                    result,
                },
                "*"
            );
        } catch (error) {
            window.postMessage(
                {
                    type: "edge_translate_on_device_response",
                    requestId,
                    error: {
                        message: error && error.message ? error.message : String(error),
                    },
                },
                "*"
            );
        }
    });

    window.postMessage({ type: "edge_translate_on_device_bridge_ready" }, "*");
})();
