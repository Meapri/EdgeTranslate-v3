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
    const geminiNanoSessionCache = new Map();
    const languageDetectionCache = new Map();
    const LANGUAGE_DETECTION_CACHE_MAX = 200;
    const PROMPT_API_LANGUAGE_CODES = new Set(["en", "es", "ja"]);
    const DEFAULT_PROMPT_API_OUTPUT_LANGUAGE = "en";
    const GEMINI_NANO_CREATE_TIMEOUT_MS = 45000;
    const GEMINI_NANO_PROMPT_TIMEOUT_MS = 60000;
    const GEMINI_NANO_PROMPT_VERSION = "gemini-nano-prompt-2026-06-25-01";
    const GEMINI_NANO_PARAGRAPH_CHUNK_CHARS = 2400;
    const GEMINI_NANO_PARAGRAPH_MIN_CHARS = 900;

    const TRANSLATION_RESULT_SCHEMA = JSON.stringify({
        translation: "...",
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

    function getPrimaryScript(language) {
        const normalized = toChromeTranslatorLanguage(language || "");
        const base = normalized.split("-")[0];
        const scriptMap = {
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



    function getTargetLanguageOutputRule(targetLanguage) {
        const normalized = toChromeTranslatorLanguage(targetLanguage || "");
        if (!normalized || normalized === "auto") return null;

        const languageName = toLanguageName(normalized);
        const primaryScript = getPrimaryScript(normalized);

        return { languageName, primaryScript };
    }

    function buildGeminiNanoPrompt(text, sourceLanguage, targetLanguage, options = {}) {
        const targetName = toLanguageName(targetLanguage);
        const sourceName =
            sourceLanguage && sourceLanguage !== "auto" ? toLanguageName(sourceLanguage) : null;
        const direction = sourceName ? `${sourceName} → ${targetName}` : `→ ${targetName}`;
        const promptBody = String(text || "").trim();
        return `${direction}. Use proper local terms and strictly native script. Do not omit.\n${TRANSLATION_RESULT_SCHEMA}\n\n${promptBody}`;
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
            expectedOutputs: [
                {
                    type: "text",
                    languages: [targetPromptLanguage || DEFAULT_PROMPT_API_OUTPUT_LANGUAGE],
                },
            ],
        };
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

    function buildGeminiNanoSystemPrompt() {
        return "Professional translator. Translate naturally into the target language. Adapt institutional, administrative, and cultural terms to their proper local equivalents (avoid literal character-by-character translation). Use ONLY the target language's native script. Never leave any source script (e.g., Hanja, Kanji) mixed in the output.";
    }

    async function getGeminiNanoSession(sourceLanguage, targetLanguage) {
        const key = `${GEMINI_NANO_PROMPT_VERSION}|${sourceLanguage}|${targetLanguage}`;
        if (geminiNanoSessionCache.has(key)) return geminiNanoSessionCache.get(key);

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

        const abortController =
            typeof window.AbortController === "function" ? new window.AbortController() : null;
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
                        content: buildGeminiNanoSystemPrompt(sourceLanguage, targetLanguage),
                    },
                ],
            }),
            GEMINI_NANO_CREATE_TIMEOUT_MS,
            "Chrome Gemini Nano session creation timed out while preparing the on-device model. Gemini Nano may still be downloading or not installed yet. Open chrome://on-device-internals or chrome://components and finish the Optimization Guide On Device Model download, then try again.",
            abortController
        );

        // Warm up: prompt the first session, then recreate a clean one
        try {
            if (typeof session.prompt === "function") {
                await session.prompt("Translate:\nOK");
            }
            if (typeof session.destroy === "function") {
                session.destroy();
            }
            const freshSession = await languageModelApi.create({
                ...createOptions,
                initialPrompts: [
                    {
                        role: "system",
                        content: buildGeminiNanoSystemPrompt(sourceLanguage, targetLanguage),
                    },
                ],
            });
            geminiNanoSessionCache.set(key, freshSession);
            return freshSession;
        } catch {
            geminiNanoSessionCache.set(key, session);
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

    function findSoftBreak(text, start, maxChars) {
        const minEnd = Math.min(text.length, start + GEMINI_NANO_PARAGRAPH_MIN_CHARS);
        const maxEnd = Math.min(text.length, start + maxChars);
        const slice = text.slice(minEnd, maxEnd);
        const newlineIndex = slice.lastIndexOf("\n");
        if (newlineIndex >= 0) return minEnd + newlineIndex + 1;
        const spaceIndex = slice.lastIndexOf(" ");
        if (spaceIndex >= 0) return minEnd + spaceIndex + 1;
        return maxEnd;
    }

    function splitLongParagraphAtSentenceEnds(
        paragraph,
        maxChars = GEMINI_NANO_PARAGRAPH_CHUNK_CHARS
    ) {
        const source = String(paragraph || "");
        if (source.length <= maxChars) return [source];

        const sentenceEnds = [];
        const sentenceEndPattern = /[.!?。！？][)"'”’」』】）\]]*\s*/g;
        let match;
        while ((match = sentenceEndPattern.exec(source))) {
            sentenceEnds.push(match.index + match[0].length);
        }

        const chunks = [];
        let start = 0;
        while (source.length - start > maxChars) {
            const minEnd = start + GEMINI_NANO_PARAGRAPH_MIN_CHARS;
            const maxEnd = start + maxChars;
            const sentenceEnd = sentenceEnds.filter((end) => end > minEnd && end <= maxEnd).pop();
            const end = sentenceEnd || findSoftBreak(source, start, maxChars);
            chunks.push(source.slice(start, end).trim());
            start = end;
        }

        const tail = source.slice(start).trim();
        if (tail) chunks.push(tail);
        return chunks.filter(Boolean);
    }

    function splitTextIntoParagraphChunks(text) {
        const source = String(text || "").replace(/\r\n?/g, "\n");
        if (!source.trim()) return [];

        const parts = source.split(/(\n+)/);
        const chunks = [];
        for (let index = 0; index < parts.length; index += 2) {
            const paragraph = parts[index] || "";
            const paragraphSeparator = parts[index + 1] || "";
            if (!paragraph.trim()) {
                if (chunks.length && paragraphSeparator) {
                    chunks[chunks.length - 1].separator += paragraphSeparator;
                }
                continue;
            }

            const paragraphChunks = splitLongParagraphAtSentenceEnds(paragraph);
            paragraphChunks.forEach((chunk, chunkIndex) => {
                chunks.push({
                    text: chunk,
                    separator: chunkIndex === paragraphChunks.length - 1 ? paragraphSeparator : " ",
                });
            });
        }
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
            return chars[parseInt(id)] || "";
        });
    }

    function unwrapSingleMarkedTranslation(translated) {
        const text = String(translated || "").trim();
        const match = /^<<<EDGE_TRANSLATE_SEGMENT_\d+(?:\s+role=[a-z-]+)?>>>\s*([\s\S]+)$/i.exec(
            text
        );
        return match ? match[1].trim() : text;
    }

    function needsRefinement(translatedText, targetLanguage) {
        const text = String(translatedText || "");
        const lang = toChromeTranslatorLanguage(targetLanguage);
        if (lang === "ko" || lang === "en") {
            const cjkRegex = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
            if (cjkRegex.test(text)) return true;
        }
        if (lang === "ko") {
            const suspiciousKoreanTerms = /국세조사|총무성|문부과학성|후생노동성|경제산업성|국토교통성/i;
            if (suspiciousKoreanTerms.test(text)) return true;
        }
        return false;
    }

    async function promptGeminiNano(session, prompt, options = {}) {
        const { onUpdate } = options;
        const promptSession =
            session && typeof session.clone === "function" ? await session.clone() : session;
        try {
            const readPrompt = async () => {
                if (typeof promptSession.promptStreaming === "function") {
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
            let output = await promptGeminiNano(
                session,
                buildGeminiNanoPrompt(inputText, sourceLanguage, targetLanguage, {}),
                {
                    onUpdate(partial) {
                        const normalized = normalizeGeminiNanoPartialOutput(partial);
                        if (normalized) onPartial?.(normalized);
                    },
                }
            );
            let parsed = extractGeminiNanoTranslationText(output);

            if (parsed && needsRefinement(parsed, targetLanguage)) {
                const targetName = toLanguageName(targetLanguage);
                const refinePrompt = [
                    `Review the following translation into ${targetName}.`,
                    `Original text: ${inputText}`,
                    `Translation: ${parsed}`,
                    `Task: Rewrite the translation to use natural ${targetName} administrative and cultural terms. Replace any literal translations. Ensure NO source-language script (e.g. Hanja, Kanji) remains.`,
                    "Return ONLY the refined text. Do not omit any part.",
                ].join("\n");

                try {
                    const refinedOutput = await promptGeminiNano(session, refinePrompt, {});
                    const refinedParsed = extractGeminiNanoTranslationText(refinedOutput);
                    if (refinedParsed) {
                        parsed = refinedParsed;
                    }
                } catch (e) {
                    // Ignore refinement failures
                }
            }

            return parsed;
        };

        const segments = parseMarkedSegments(text);
        let translated;
        if (segments.length) {
            const translatedSegments = [];
            for (const segment of segments) {
                const { processed: segSafe, chars: segChars } = extractPassthroughPunctuation(
                    segment.text
                );
                const segResult = await promptAndParse(segSafe, (partial) => {
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
            const parsedResult = await promptAndParse(safeText, (partial) =>
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
            return translateWithGeminiNano(text, from, to, { onUpdate });
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
