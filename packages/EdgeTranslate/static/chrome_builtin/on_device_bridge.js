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

    const sessionCache = new Map();
    const maxInputChars = 4000;

    function toChromeTranslatorLanguage(language) {
        return CHROME_TRANSLATOR_LANGUAGE_MAP[language] || language;
    }

    function toLanguageName(language) {
        return LANGUAGE_NAMES[language] || language || "auto-detected language";
    }

    function normalizeGeminiNanoOutput(output) {
        return String(output || "")
            .trim()
            .replace(/^```(?:text)?\s*/i, "")
            .replace(/```$/i, "")
            .replace(/^Translation:\s*/i, "")
            .trim();
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

    async function getGeminiNanoSession(from, to) {
        const languageModelApi = window.LanguageModel;
        if (!languageModelApi || typeof languageModelApi.create !== "function") {
            throw new Error("Chrome Gemini Nano Prompt API is not available in this page context.");
        }

        if (typeof languageModelApi.availability === "function") {
            const availability = await languageModelApi.availability();
            if (availability === "unavailable") {
                throw new Error("Chrome Gemini Nano model is unavailable on this device.");
            }
        }

        const sourceLanguage = toLanguageName(from);
        const targetLanguage = toLanguageName(to);
        const key = `${sourceLanguage}|${targetLanguage}`;
        if (sessionCache.has(key)) return sessionCache.get(key);

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
        sessionCache.set(key, session);
        return session;
    }

    async function translateWithGeminiNano(text, from, to) {
        const session = await getGeminiNanoSession(from, to);
        const sourceLanguage = toLanguageName(from);
        const targetLanguage = toLanguageName(to);
        const prompt = [
            `Translate the following text from ${sourceLanguage} to ${targetLanguage}.`,
            "Return only the translated text.",
            "<text>",
            String(text).slice(0, maxInputChars),
            "</text>",
        ].join("\n");
        const translated = normalizeGeminiNanoOutput(await session.prompt(prompt));
        if (!translated) throw new Error("Chrome Gemini Nano returned an empty translation.");
        return {
            originalText: text,
            mainMeaning: translated,
            translatedText: translated,
            sourceLanguage: from,
            targetLanguage: to,
        };
    }

    async function translate(detail) {
        const text = detail && detail.text ? String(detail.text) : "";
        const from = (detail && (detail.sl || detail.from)) || "auto";
        const to = (detail && (detail.tl || detail.to)) || "en";
        const engine = (detail && detail.engine) || "geminiNano";
        if (!text.trim()) {
            return {
                originalText: text,
                mainMeaning: "",
                sourceLanguage: from,
                targetLanguage: to,
            };
        }
        if (engine === "chromeBuiltin") return translateWithChromeBuiltin(text, from, to);
        return translateWithGeminiNano(text, from, to);
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
