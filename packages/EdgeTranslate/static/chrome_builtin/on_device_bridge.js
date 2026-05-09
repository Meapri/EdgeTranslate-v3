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
    const PROMPT_API_LANGUAGE_CODES = new Set(["en", "es", "ja", "de", "fr"]);
    const GEMINI_NANO_CREATE_TIMEOUT_MS = 45000;
    const GEMINI_NANO_PROMPT_TIMEOUT_MS = 60000;

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
        if (geminiNanoSessionCache.has(key)) return geminiNanoSessionCache.get(key);

        const languageModelApi = window.LanguageModel;
        if (!languageModelApi || typeof languageModelApi.create !== "function") {
            throw new Error("Chrome Gemini Nano LanguageModel API is not available in this page context.");
        }
        const createOptions = getGeminiNanoCreateOptions(sourceLanguage, targetLanguage);
        if (typeof languageModelApi.availability === "function") {
            const availability = await languageModelApi.availability(createOptions);
            if (availability === "unavailable") {
                throw new Error("Chrome Gemini Nano LanguageModel API is unavailable on this device.");
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
        geminiNanoSessionCache.set(key, session);
        return session;
    }

    async function translateWithGeminiNano(text, from, to) {
        const targetLanguage = toChromeTranslatorLanguage(to);
        const sourceLanguage = from === "auto" ? "auto" : toChromeTranslatorLanguage(from);
        const session = await getGeminiNanoSession(sourceLanguage, targetLanguage);
        const prompt = /<<<EDGE_TRANSLATE_SEGMENT_\d+>>>/.test(text)
            ? [
                  "Fast translate. Output only translated text.",
                  `From: ${toLanguageName(sourceLanguage)}. To: ${toLanguageName(targetLanguage)}.`,
                  "Keep every <<<EDGE_TRANSLATE_SEGMENT_N>>> marker exactly unchanged.",
                  "Translate text after each marker. No notes. No markdown.",
                  text,
              ].join("\n")
            : [
                  `Translate ${toLanguageName(sourceLanguage)} to ${toLanguageName(
                      targetLanguage
                  )}.`,
                  "Output translation only. No notes.",
                  text,
              ].join("\n");
        const output = await withTimeout(
            session.prompt(prompt),
            GEMINI_NANO_PROMPT_TIMEOUT_MS,
            "Chrome Gemini Nano prompt timed out."
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
