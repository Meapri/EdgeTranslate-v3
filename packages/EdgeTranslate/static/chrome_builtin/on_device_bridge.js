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

    async function getGeminiNanoSession(sourceLanguage, targetLanguage) {
        const key = `${sourceLanguage}|${targetLanguage}`;
        if (geminiNanoSessionCache.has(key)) return geminiNanoSessionCache.get(key);

        const languageModelApi = window.LanguageModel;
        if (!languageModelApi || typeof languageModelApi.create !== "function") {
            throw new Error("Chrome Gemini Nano LanguageModel API is not available in this page context.");
        }
        if (typeof languageModelApi.availability === "function") {
            const availability = await languageModelApi.availability();
            if (availability === "unavailable") {
                throw new Error("Chrome Gemini Nano LanguageModel API is unavailable on this device.");
            }
        }

        const session = await languageModelApi.create({
            initialPrompts: [
                {
                    role: "system",
                    content: [
                        "You are a precise translation engine powered by the local Gemini Nano model.",
                        "Translate user-provided text only.",
                        "Preserve meaning, tone, punctuation, line breaks, URLs, numbers, names, and HTML-like entities.",
                        "If segment marker lines like <<<EDGE_TRANSLATE_SEGMENT_1>>> appear, keep those marker lines unchanged and translate only the text between them.",
                        "Do not explain, summarize, romanize, add notes, or wrap the answer in quotes/code fences.",
                        `Source language: ${toLanguageName(sourceLanguage)}.`,
                        `Target language: ${toLanguageName(targetLanguage)}.`,
                    ].join("\n"),
                },
            ],
        });
        geminiNanoSessionCache.set(key, session);
        return session;
    }

    async function translateWithGeminiNano(text, from, to) {
        const targetLanguage = toChromeTranslatorLanguage(to);
        const sourceLanguage = from === "auto" ? "auto" : toChromeTranslatorLanguage(from);
        const session = await getGeminiNanoSession(sourceLanguage, targetLanguage);
        const output = await session.prompt(
            [
                `Translate the following text from ${toLanguageName(sourceLanguage)} to ${toLanguageName(
                    targetLanguage
                )}.`,
                "Return only the translated text.",
                "<text>",
                text,
                "</text>",
            ].join("\n")
        );
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

    async function translate(detail) {
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
            return translateWithGeminiNano(text, from, to);
        }
        return translateWithChromeBuiltin(text, from, to);
    }

    window.addEventListener("message", async (event) => {
        if (event.source !== window || !event.data) return;
        if (event.data.type !== "edge_translate_on_device_request") return;
        const requestId = event.data.requestId;
        try {
            const result = await translate(event.data.detail || {});
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
