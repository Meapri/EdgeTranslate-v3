import LocalTranslator from "../src/translators/local";

describe("LocalTranslator", () => {
    const originalFetch = global.fetch;

    const originalTranslator = (globalThis as any).Translator;

    afterEach(() => {
        global.fetch = originalFetch;
        (globalThis as any).Translator = originalTranslator;
        jest.restoreAllMocks();
    });

    test("translates with Chrome built-in Translator API mode", async () => {
        const translateMock = jest.fn().mockResolvedValue("안녕");
        const createMock = jest.fn().mockResolvedValue({ translate: translateMock });
        const availabilityMock = jest.fn().mockResolvedValue("available");
        (globalThis as any).Translator = {
            availability: availabilityMock,
            create: createMock,
        };

        const translator = new LocalTranslator({ enabled: true, mode: "chromeBuiltin" });
        const result = await translator.translate("hello", "en", "ko");

        expect(availabilityMock).toHaveBeenCalledTimes(1);
        expect(availabilityMock).toHaveBeenCalledWith({
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        expect(createMock).toHaveBeenCalledWith({ sourceLanguage: "en", targetLanguage: "ko" });
        expect(translateMock).toHaveBeenCalledWith("hello");
        expect(result).toMatchObject({
            originalText: "hello",
            mainMeaning: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
    });

    test("normalizes regional Chrome Translator language codes and reuses the translator", async () => {
        const translateMock = jest.fn().mockResolvedValue("안녕");
        const createMock = jest.fn().mockResolvedValue({ translate: translateMock });
        const availabilityMock = jest.fn().mockResolvedValue("available");
        (globalThis as any).Translator = {
            availability: availabilityMock,
            create: createMock,
        };

        const translator = new LocalTranslator({ enabled: true, mode: "chromeBuiltin" });
        await translator.translate("hello", "en-US", "ko-KR");
        await translator.translate("world", "en-US", "ko-KR");

        expect(availabilityMock).toHaveBeenCalledTimes(1);
        expect(availabilityMock).toHaveBeenCalledWith({
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(createMock).toHaveBeenCalledWith({ sourceLanguage: "en", targetLanguage: "ko" });
        expect(translateMock).toHaveBeenCalledTimes(2);
    });

    test("advertises Chrome built-in support without a server endpoint", () => {
        const translator = new LocalTranslator({ enabled: true, mode: "chromeBuiltin" });
        expect(translator.supportedLanguages().has("ko")).toBe(true);
        expect(translator.supportedLanguages().has("en")).toBe(true);
    });

    test("migrates legacy removed on-device mode to Chrome Translator API", async () => {
        const chromeTranslateMock = jest.fn().mockResolvedValue("안녕");
        const chromeCreateMock = jest.fn().mockResolvedValue({ translate: chromeTranslateMock });
        (globalThis as any).Translator = {
            availability: jest.fn().mockResolvedValue("available"),
            create: chromeCreateMock,
        };
        const translator = new LocalTranslator({ enabled: true, mode: "geminiNano" });
        const result = await translator.translate("hello", "en", "ko");

        expect(chromeCreateMock).toHaveBeenCalledWith({
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        expect(chromeTranslateMock).toHaveBeenCalledWith("hello");
        expect(result).toMatchObject({
            originalText: "hello",
            mainMeaning: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
    });

    test("translates with Google AI Studio mode and selected model", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [{ text: "안녕" }],
                        },
                    },
                ],
                usageMetadata: {
                    promptTokenCount: 31,
                    candidatesTokenCount: 7,
                    totalTokenCount: 38,
                },
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
        });
        const result = await translator.translate("hello there.", "en", "ko");

        expect(result).toMatchObject({
            originalText: "hello there.",
            mainMeaning: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
            tokenUsage: {
                inputTokens: 31,
                outputTokens: 7,
                totalTokens: 38,
            },
        });
        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=studio-test-key"
        );
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.systemInstruction.parts[0].text).toContain("high-fidelity translation engine");
        expect(body.systemInstruction.parts[0].text).toContain("Output only the translation");
        expect(body.systemInstruction.parts[0].text).toContain("subtitle cue numbers");
        expect(body.systemInstruction.parts[0].text).toContain("Preserve numeric literals");
        expect(body.systemInstruction.parts[0].text).toContain("Preserve proper nouns");
        expect(body.systemInstruction.parts[0].text).toContain("official Latin-script names");
        expect(body.systemInstruction.parts[0].text).toContain("long webpage text");
        expect(body.generationConfig.temperature).toBe(0);
        expect(body.generationConfig.maxOutputTokens).toBe(512);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
        expect(body.generationConfig.candidateCount).toBeUndefined();
        expect(body.generationConfig.topK).toBeUndefined();
        expect(body.contents[0].parts[0].text).toContain("Source language: English");
        expect(body.contents[0].parts[0].text).toContain("Target language: Korean");
        expect(body.contents[0].parts[0].text).toContain(
            "Preserve proper nouns and official names"
        );
        expect(body.contents[0].parts[0].text).not.toContain("Translate or transliterate names");
        expect(body.contents[0].parts[0].text).not.toContain("marked segments");
        expect(body.contents[0].parts[0].text).toContain("hello there.");
    });

    test("includes fenced selection context with a sentinel and a static anti-echo rule", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "은행" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
        });
        await translator.translate("They sat by the bank watching the river flow.", "en", "ko", {
            selectionContext: {
                surrounding: "The fishermen spent the afternoon by the river bank with their rods.",
                title: "A Day at the River",
                domain: "example.org",
            },
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const userText = body.contents[0].parts[0].text;
        // Context is fenced, labeled reference-only, and separated by the sentinel line.
        expect(userText).toContain("Page: A Day at the River (example.org)");
        expect(userText).toContain("Context (surrounding page text — reference only");
        expect(userText).toContain('"""The fishermen spent the afternoon');
        expect(userText).toContain("Text to translate:");
        // The payload comes AFTER the sentinel so the model cannot conflate it with context.
        expect(userText.indexOf("Text to translate:")).toBeLessThan(
            userText.indexOf("They sat by the bank watching the river flow.")
        );
        // The static system prompt carries the matching anti-echo rule (cache-stable).
        expect(body.systemInstruction.parts[0].text).toContain("reference material for word-sense");
        expect(body.systemInstruction.parts[0].text).toContain("Text to translate:");
    });

    test("omits context plumbing entirely when no selection context is provided", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
        });
        await translator.translate("hello there.", "en", "ko");
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const userText = body.contents[0].parts[0].text;
        expect(userText).not.toContain("Page:");
        expect(userText).not.toContain("Context (");
        expect(userText).not.toContain("Text to translate:");
    });

    test("dictionary lookups use Gemini JSON mime, contextual sense ranking, and no streaming", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: '{"translation":"은행"}' }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
        });
        const onProgress = jest.fn();
        await translator.translate("bank", "en", "ko", {
            onProgress,
            selectionContext: {
                surrounding: "He deposited the cheque at the bank before noon.",
                title: "",
                domain: "",
            },
        });

        // Non-streaming endpoint despite onProgress (JSON must not stream into the preview).
        expect(String(fetchMock.mock.calls[0][0])).toContain(":generateContent?");
        expect(String(fetchMock.mock.calls[0][0])).not.toContain("streamGenerateContent");
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.responseMimeType).toBe("application/json");
        const userText = body.contents[0].parts[0].text;
        expect(userText).toContain("Dictionary entry.");
        expect(userText).toContain("contextual sense first");
        expect(userText).toContain("He deposited the cheque");
    });

    test("translates with an OpenAI-compatible chat completions endpoint", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [
                    {
                        message: { content: "안녕" },
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: 21,
                    completion_tokens: 3,
                    total_tokens: 24,
                },
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openaiCompatible",
            openaiCompatibleBaseUrl: "http://localhost:1234/v1",
            openaiCompatibleApiKey: "local-key",
            openaiCompatibleModel: "local-model",
        });
        const result = await translator.translate("hello there.", "en", "ko");

        expect(result).toMatchObject({
            originalText: "hello there.",
            mainMeaning: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
            tokenUsage: {
                inputTokens: 21,
                outputTokens: 3,
                totalTokens: 24,
            },
        });
        expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/v1/chat/completions");
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
            Authorization: "Bearer local-key",
            "Content-Type": "application/json",
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.model).toBe("local-model");
        expect(body.temperature).toBe(0);
        expect(body.max_tokens).toBeGreaterThanOrEqual(512);
        expect(body.messages[0].content).toContain("high-fidelity translation engine");
        expect(body.messages[1].content).toContain("Source language: English");
        expect(body.messages[1].content).toContain("Target language: Korean");
    });

    test("normalizes OpenAI-compatible base URLs and allows local endpoints without API keys", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "안녕" }, finish_reason: "stop" }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openaiCompatible",
            openaiCompatibleBaseUrl: "http://localhost:1234",
            openaiCompatibleModel: "local-model",
        });
        await translator.translate("hello.", "en", "ko");

        expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/v1/chat/completions");
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });

    test("reads OpenAI-compatible text-style completion responses", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ text: "[[1:p]]\n페이지 번역 결과입니다.", finish_reason: "stop" }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openaiCompatible",
            openaiCompatibleBaseUrl: "http://localhost:5000/v1",
            openaiCompatibleModel: "Hy-MT2-1.8B",
        });
        const result = await translator.translate("[[1:p]]\nPage translation source.", "en", "ko", {
            translationProfile: "page",
        });

        expect(result.mainMeaning).toBe("[[1:p]]\n페이지 번역 결과입니다.");
    });

    test("uses ultra-light Google AI Studio prompts for realtime captions", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "다시 오신 걸 환영합니다." }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
            reasoningLevel: "high",
        });
        const result = await translator.translate("Welcome back.", "en", "ko", {
            textRole: "caption",
            translationProfile: "realtimeCaption",
        });

        expect(result.mainMeaning).toBe("다시 오신 걸 환영합니다.");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.systemInstruction.parts[0].text).toBe(
            "You are a subtitle translator. Return only translated subtitles."
        );
        expect(body.contents[0].parts[0].text).toContain(
            "Task: English -> Korean YouTube subtitle."
        );
        expect(body.contents[0].parts[0].text).toContain(
            "Style: Use natural target-language spoken-subtitle style. Avoid stiff literal translation."
        );
        expect(body.contents[0].parts[0].text).toContain(
            "Reorder clauses for natural target-language timing."
        );
        expect(body.contents[0].parts[0].text).toContain(
            "Rules: translate meaning, not word order; if fragment, keep a natural subtitle fragment; keep line breaks; preserve names, numbers, URLs; no notes."
        );
        expect(body.contents[0].parts[0].text).not.toContain("Korean:");
        expect(body.contents[0].parts[0].text).not.toContain(
            "Preserve proper nouns and official names"
        );
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
        expect(body.generationConfig.maxOutputTokens).toBe(96);
    });

    test("uses marker-preserving Google AI Studio prompts for realtime caption batches", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    text: "[[0]] 안녕하세요.\n[[1]] 바로 시작하겠습니다.",
                                },
                            ],
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
        });
        const result = await translator.translate(
            "[[0]] Hey everyone.\n[[1]] Let's get started.",
            "en",
            "ko",
            {
                textRole: "caption",
                translationProfile: "realtimeCaptionBatch",
            }
        );

        expect(result.mainMeaning).toContain("[[0]] 안녕하세요.");
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.contents[0].parts[0].text).toContain(
            "Task: English -> Korean YouTube subtitle cues."
        );
        expect(body.contents[0].parts[0].text).toContain(
            "Style: Use natural target-language spoken-subtitle style. Avoid stiff literal translation."
        );
        expect(body.contents[0].parts[0].text).toContain(
            "Reorder clauses for natural target-language timing."
        );
        expect(body.contents[0].parts[0].text).toContain(
            "Rules: use all cues as context; keep each [[n]] marker once and in order; each marker gets the natural subtitle for that moment; translate meaning, not word order; avoid repeated or missing meaning; preserve names, numbers, URLs; no notes."
        );
        expect(body.contents[0].parts[0].text).not.toContain("preserve cue boundaries");
        expect(body.contents[0].parts[0].text).not.toContain("Korean:");
        expect(body.contents[0].parts[0].text).toContain("[[1]] Let's get started.");
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    test("uses minimum required thinking config for Gemini 3 Flash models", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-3.5-flash",
        });
        const result = await translator.translate("hello", "en", "ko");

        expect(result.mainMeaning).toBe("안녕");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.topK).toBeUndefined();
        expect(body.generationConfig.candidateCount).toBeUndefined();
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
        expect(body.generationConfig.temperature).toBe(0);
        expect(body.generationConfig.maxOutputTokens).toBeUndefined();
    });

    test("turns thinking fully off for Gemini 3 Flash-Lite models", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-3.1-flash-lite",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        // Flash-Lite accepts a zero budget — disable thinking entirely.
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    test("uses compact page-translation guidance for proper nouns and inline HTML", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [{ text: "[[1:p]]\nLM Studio는 llama.cpp를 지원합니다." }],
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });
        await translator.translate(
            "[[1:p]]\n<p>LM Studio supports <a>llama.cpp</a>.</p>",
            "en",
            "ko"
        );

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const prompt = body.contents[0].parts[0].text;
        expect(body.systemInstruction.parts[0].text).toContain("Translate each [[n]] segment");
        expect(body.systemInstruction.parts[0].text).toContain(
            "Output every [[n]] marker exactly once"
        );
        expect(body.systemInstruction.parts[0].text).not.toContain(
            "subtitle cue numbers, timestamps"
        );
        expect(prompt).toContain("English>Korean");
        expect(prompt).toContain("Keep markers.");
        expect(prompt).not.toContain("same number of translated payload lines");
        expect(prompt).not.toContain("Use neighboring segments only to keep terminology");
        expect(prompt).toContain("<a>llama.cpp</a>");
    });

    test("uses the shortest page prompt for raw HTML sections", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "<p>안녕하세요.</p>" }, finish_reason: "stop" }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openaiCompatible",
            openaiCompatibleBaseUrl: "http://localhost:5000/v1",
            openaiCompatibleModel: "Hy-MT2-1.8B",
        });
        await translator.translate("<p>Hello.</p>", "en", "ko", {
            translationProfile: "page",
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.messages[0].content).toBe(
            "Translate visible HTML text only. Preserve tags, attrs, order exactly. Output translated HTML only."
        );
        expect(body.messages[1].content).toBe("English>Korean\n<p>Hello.</p>");
        expect(body.max_tokens).toBe(256);
    });

    test("uses minimum required Gemini 3 Pro thinking level", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-3.1-pro-preview",
            reasoningLevel: "low",
        });
        await translator.translate("hello", "en", "ko");

        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=studio-test-key"
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
        expect(body.generationConfig.maxOutputTokens).toBeUndefined();
    });

    test("ignores configured Gemini 3 Flash reasoning and uses the minimum", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-3.5-flash",
            reasoningLevel: "high",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    });

    test("ignores configured Gemini 2.5 reasoning and turns thinking off", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
            reasoningLevel: "medium",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    test("uses the official Gemini 2.5 thinking-off value when supported", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
            reasoningLevel: "none",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    test("falls back to bare Google AI Studio requests when minimal config returns empty output", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: "안녕" }] } }],
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-pro",
        });
        const result = await translator.translate("hello", "en", "ko");

        expect(result.mainMeaning).toBe("안녕");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(retryBody.generationConfig).toBeUndefined();
    });

    test("falls back to bare Google AI Studio requests when output is truncated", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            finishReason: "MAX_TOKENS",
                            content: { parts: [{ text: "Online -> 포켓몬센터 온라인." }] },
                        },
                    ],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        text: "[[1:p]]평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
                                    },
                                ],
                            },
                        },
                    ],
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.5-flash",
        });
        const result = await translator.translate(
            "[[1:p]]\n平素よりポケモンセンターオンラインをご利用いただき、ありがとうございます。",
            "auto",
            "ko"
        );

        expect(result.mainMeaning).toBe(
            "[[1:p]]평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다."
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(retryBody.generationConfig).toBeUndefined();
    });

    test("falls back to bare Google AI Studio requests when compatible config is rejected", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({
                    error: {
                        message: "GenerationConfig.maxOutputTokens is not supported by this model.",
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: "안녕" }] } }],
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemma-4-31b-it",
        });
        const result = await translator.translate("hello", "en", "ko");

        expect(result.mainMeaning).toBe("안녕");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(retryBody.generationConfig).toBeUndefined();
    });

    test("falls back to bare Google AI Studio requests when thinking budget is rejected", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({
                    error: {
                        message: "Budget 0 is invalid. This model only works in thinking mode.",
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: "안녕" }] } }],
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-3.5-flash",
        });
        const result = await translator.translate("hello", "en", "ko");

        expect(result.mainMeaning).toBe("안녕");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(retryBody.generationConfig).toBeUndefined();
    });

    test("parses accidental Google AI Studio JSON while preserving translated line breaks", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    text: [
                                        "```json",
                                        JSON.stringify({
                                            translation: "공지 제목\n\n본문 첫 줄\n- 목록 항목",
                                            detailedMeanings: [{ pos: "noun" }],
                                        }),
                                        "```",
                                    ].join("\n"),
                                },
                            ],
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });
        const result = await translator.translate(
            "Notice title\n\nBody line\n- List item",
            "en",
            "ko"
        );

        expect(result.mainMeaning).toBe("공지 제목\n\n본문 첫 줄\n- 목록 항목");
        expect(result.mainMeaning).not.toContain("detailedMeanings");
    });

    test("deduplicates concurrent identical Google AI Studio requests", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });
        const [first, second] = await Promise.all([
            translator.translate("hello world", "en", "ko"),
            translator.translate("hello world", "en", "ko"),
        ]);

        expect(first.mainMeaning).toBe("안녕");
        expect(second.mainMeaning).toBe("안녕");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("adds dictionary details for local single-word Google AI Studio translation", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    text: JSON.stringify({
                                        translation: "달리다",
                                        detailedMeanings: [
                                            {
                                                pos: "verb",
                                                meaning: "빠르게 움직이다",
                                                synonyms: ["뛰다"],
                                            },
                                        ],
                                        definitions: [
                                            {
                                                pos: "verb",
                                                meaning: "발로 빠르게 이동하다",
                                                example: "그는 매일 달린다.",
                                            },
                                        ],
                                        examples: [
                                            {
                                                sourceExample: "I run every morning.",
                                                targetExample: "나는 매일 아침 달린다.",
                                            },
                                        ],
                                    }),
                                },
                            ],
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });
        const result = await translator.translate("run", "en", "ko");

        expect(result).toMatchObject({
            mainMeaning: "달리다",
            detailedMeanings: [{ pos: "verb", meaning: "빠르게 움직이다" }],
            definitions: [{ pos: "verb", meaning: "발로 빠르게 이동하다" }],
            examples: [{ source: "I run every morning.", target: "나는 매일 아침 달린다." }],
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.systemInstruction.parts[0].text).toContain("Output only the translation");
        expect(body.contents[0].parts[0].text).toContain("Source language: English");
        expect(body.contents[0].parts[0].text).toContain("Target language: Korean");
        expect(body.contents[0].parts[0].text).toContain("Return only one valid JSON object");
        expect(body.contents[0].parts[0].text).toContain("detailedMeanings");
    });

    test("uses normal Google AI Studio translation prompt for long CJK headlines", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    text: "회원 계정에 대한 부정 로그인 발생 보고와 안전한 이용을 위한 안내",
                                },
                            ],
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });
        const source =
            "「会員アカウント」に対する不正ログインの発生のご報告と安全にご利用いただくためのお願い";
        const result = await translator.translate(source, "ja", "ko");

        expect(result.mainMeaning).toBe(
            "회원 계정에 대한 부정 로그인 발생 보고와 안전한 이용을 위한 안내"
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.systemInstruction.parts[0].text).toContain(
            "preserve meaning, tone, intent, nuance"
        );
        expect(body.contents[0].parts[0].text).toContain("Source language: Japanese");
        expect(body.contents[0].parts[0].text).toContain("Target language: Korean");
        expect(body.contents[0].parts[0].text).not.toContain(
            "idiomatic target-language terminology"
        );
        expect(body.contents[0].parts[0].text).not.toContain("prefer concise noun-phrase style");
        expect(body.contents[0].parts[0].text).not.toContain("무단 로그인");
        expect(body.contents[0].parts[0].text).not.toContain("word or short term");
    });

    test("defaults Google AI Studio to the low-cost Flash-Lite model", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });
        await translator.translate("hello", "en", "ko");

        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=studio-test-key"
        );
    });

    test("uses compatible config for non-Gemini Google AI Studio models", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemma-4-31b-it",
        });
        await translator.translate("hello", "en", "ko");

        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=studio-test-key"
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.temperature).toBe(0);
        expect(body.generationConfig.maxOutputTokens).toBe(512);
        expect(body.generationConfig.candidateCount).toBeUndefined();
        expect(body.generationConfig.topK).toBeUndefined();
        expect(body.generationConfig.thinkingConfig).toBeUndefined();
    });

    test("ignores Google AI Studio auto reasoning and uses the minimum", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: "안녕" }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-3.5-flash",
            reasoningLevel: "auto",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    });

    test("does not advertise Google AI Studio support when API key is missing", () => {
        const translator = new LocalTranslator({ enabled: true, mode: "googleAiStudio" });
        expect(translator.supportedLanguages().size).toBe(0);
    });

    test("translates with OpenAI API mode and selected model", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: "안녕",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 44,
                    completion_tokens: 5,
                    total_tokens: 49,
                    completion_tokens_details: { reasoning_tokens: 2 },
                    prompt_tokens_details: { cached_tokens: 9 },
                },
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.5",
        });
        const result = await translator.translate("hello there.", "en", "ko");

        expect(result).toMatchObject({
            originalText: "hello there.",
            mainMeaning: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
            tokenUsage: {
                inputTokens: 44,
                outputTokens: 5,
                reasoningTokens: 2,
                cachedInputTokens: 9,
                totalTokens: 49,
            },
        });
        expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            method: "POST",
            headers: {
                Authorization: "Bearer openai-test-key",
                "Content-Type": "application/json",
            },
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.model).toBe("gpt-5.5");
        expect(body.reasoning_effort).toBe("none");
        expect(body.temperature).toBeUndefined();
        expect(body.response_format).toBeUndefined();
        expect(body.max_completion_tokens).toBeGreaterThan(0);
        expect(body.max_tokens).toBeUndefined();
        expect(body.messages[0].role).toBe("system");
        expect(body.messages[0].content).toContain("high-fidelity translation engine");
        expect(body.messages[0].content).toContain("Output only the translation");
        expect(body.messages[0].content).toContain("subtitle cue numbers");
        expect(body.messages[0].content).toContain("Preserve numeric literals");
        expect(body.messages[0].content).toContain("Preserve proper nouns");
        expect(body.messages[0].content).toContain("official Latin-script names");
        expect(body.messages[1].content).toContain("Source language: English");
        expect(body.messages[1].content).toContain("Target language: Korean");
        expect(body.messages[1].content).toContain("Preserve proper nouns and official names");
        expect(body.messages[1].content).not.toContain("Translate or transliterate names");
        expect(body.messages[1].content).toContain("hello there.");
    });

    test("uses ultra-light OpenAI prompts and tiny output budget for realtime captions", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "곧 시작합니다." } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.4-mini",
            openaiReasoningEffort: "high",
        });
        const result = await translator.translate("Starting soon.", "en", "ko", {
            textRole: "caption",
            translationProfile: "realtimeCaption",
        });

        expect(result.mainMeaning).toBe("곧 시작합니다.");
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.messages[0].content).toBe(
            "You are a subtitle translator. Return only translated subtitles."
        );
        expect(body.messages[1].content).toContain("Task: English -> Korean YouTube subtitle.");
        expect(body.messages[1].content).toContain(
            "Style: Use natural target-language spoken-subtitle style. Avoid stiff literal translation."
        );
        expect(body.messages[1].content).toContain(
            "Reorder clauses for natural target-language timing."
        );
        expect(body.messages[1].content).toContain(
            "Rules: translate meaning, not word order; if fragment, keep a natural subtitle fragment; keep line breaks; preserve names, numbers, URLs; no notes."
        );
        expect(body.messages[1].content).not.toContain("Korean:");
        expect(body.messages[1].content).not.toContain("Preserve proper nouns and official names");
        expect(body.reasoning_effort).toBe("none");
        expect(body.max_completion_tokens).toBe(96);
        expect(body.response_format).toBeUndefined();
    });

    test("ignores explicit OpenAI reasoning effort and uses no reasoning", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "안녕" } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.5",
            openaiReasoningEffort: "high",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.reasoning_effort).toBe("none");
    });

    test("does NOT re-roll OpenAI page translations when a completed reply omits markers", async () => {
        // finish_reason "stop" with a missing [[n]] marker: at temperature 0 a full re-roll
        // near-deterministically reproduces the same gap for 2x tokens. The page pipeline
        // heals missing markers with a missing-leaves-only request — the engine must NOT
        // pay a second full generation.
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [
                    {
                        finish_reason: "stop",
                        message: {
                            content: ["[[1:p]]", "첫 번째 문장."].join("\n"),
                        },
                    },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.4-mini",
        });
        const result = await translator.translate(
            ["[[1:p]]", "First sentence.", "[[2:p]]", "Second sentence."].join("\n"),
            "en",
            "ko"
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.mainMeaning).toContain("[[1:p]]");
        expect(result.tokenUsage).toMatchObject({
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
        });
    });

    test("retries OpenAI page translations with a larger budget on true truncation", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            finish_reason: "length",
                            message: {
                                content: ["[[1:p]]", "첫 번째 문장.", "[[2:p]]", "두 번"].join(
                                    "\n"
                                ),
                            },
                        },
                    ],
                    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            finish_reason: "stop",
                            message: {
                                content: [
                                    "[[1:p]]",
                                    "첫 번째 문장.",
                                    "[[2:p]]",
                                    "두 번째 문장.",
                                ].join("\n"),
                            },
                        },
                    ],
                    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.4-mini",
        });
        const result = await translator.translate(
            ["[[1:p]]", "First sentence.", "[[2:p]]", "Second sentence."].join("\n"),
            "en",
            "ko"
        );

        expect(result.mainMeaning).toContain("[[2:p]]");
        expect(result.tokenUsage).toMatchObject({
            inputTokens: 200,
            outputTokens: 60,
            totalTokens: 260,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(secondBody.max_completion_tokens).toBeGreaterThan(firstBody.max_completion_tokens);
    });

    test("gates the OpenAI page first-attempt completion ceiling on the model family", async () => {
        // A page payload big enough that the estimated output exceeds every ceiling, so the
        // request budget IS the ceiling: modern families (gpt-5/gpt-4.1/gpt-4o/o-series) may
        // stream up to 12288 tokens in one attempt; legacy/unknown models keep the safe 4096
        // (a too-high cap on a legacy model is a hard 400, not a truncation).
        const hugePage = `[[1:p]]\n${"lorem ipsum dolor sit amet ".repeat(3000)}`;
        const reply = {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ finish_reason: "stop", message: { content: "[[1:p]]\n번역." } }],
            }),
        };

        let fetchMock = jest.fn().mockResolvedValue(reply);
        global.fetch = fetchMock as any;
        const modern = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.4-mini",
        });
        await modern.translate(hugePage, "en", "ko");
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_completion_tokens).toBe(12288);

        fetchMock = jest.fn().mockResolvedValue(reply);
        global.fetch = fetchMock as any;
        const legacy = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-4-turbo",
        });
        await legacy.translate(hugePage, "en", "ko");
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(4096);
    });

    test("uses no reasoning for OpenAI GPT 5.4 mini even when xhigh is configured", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "안녕" } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.4-mini",
            openaiReasoningEffort: "xhigh",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.reasoning_effort).toBe("none");
    });

    test("uses no reasoning for OpenAI GPT 5.4 mini even when minimal is configured", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "안녕" } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.4-mini",
            openaiReasoningEffort: "minimal",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.reasoning_effort).toBe("none");
    });

    test("uses minimum legacy GPT-5 reasoning regardless of configured value", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "안녕" } }],
            }),
        });
        global.fetch = fetchMock as any;

        const minimalTranslator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5",
            openaiReasoningEffort: "minimal",
        });
        await minimalTranslator.translate("hello", "en", "ko");

        const xhighTranslator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5",
            openaiReasoningEffort: "xhigh",
        });
        await xhighTranslator.translate("hello", "en", "ko");

        const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(firstBody.reasoning_effort).toBe("minimal");
        expect(secondBody.reasoning_effort).toBe("minimal");
    });

    test("uses minimum OpenAI o-series reasoning", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "안녕" } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "o3",
            openaiReasoningEffort: "xhigh",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.reasoning_effort).toBe("low");
    });

    test("does not send OpenAI reasoning effort to non-reasoning models", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "안녕" } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-4o-mini",
            openaiReasoningEffort: "high",
        });
        await translator.translate("hello", "en", "ko");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.reasoning_effort).toBeUndefined();
    });

    test("retries OpenAI without reasoning effort when the API rejects the parameter", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({
                    error: {
                        message: "Unsupported parameter: reasoning_effort",
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: "안녕" } }],
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.5",
            openaiReasoningEffort: "high",
        });
        await translator.translate("hello", "en", "ko");

        const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(firstBody.reasoning_effort).toBe("none");
        expect(retryBody.reasoning_effort).toBeUndefined();
    });

    test("adds dictionary details for OpenAI single-word translation", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                translation: "달리다",
                                detailedMeanings: [
                                    {
                                        pos: "verb",
                                        meaning: "빠르게 움직이다",
                                        synonyms: ["뛰다"],
                                    },
                                ],
                                definitions: [
                                    {
                                        pos: "verb",
                                        meaning: "발로 빠르게 이동하다",
                                        example: "그는 매일 달린다.",
                                    },
                                ],
                                examples: [
                                    {
                                        source: "I run every morning.",
                                        target: "나는 매일 아침 달린다.",
                                    },
                                ],
                            }),
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
        });
        const result = await translator.translate("run", "en", "ko");

        expect(result).toMatchObject({
            mainMeaning: "달리다",
            detailedMeanings: [{ pos: "verb", meaning: "빠르게 움직이다" }],
            definitions: [{ pos: "verb", meaning: "발로 빠르게 이동하다" }],
            examples: [{ source: "I run every morning.", target: "나는 매일 아침 달린다." }],
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.messages[0].content).toContain("Output only the translation");
        expect(body.messages[1].content).toContain("Source language: English");
        expect(body.messages[1].content).toContain("Return only one valid JSON object");
        expect(body.messages[1].content).toContain("detailedMeanings");
        expect(body.messages[1].content).toContain("definitions");
        expect(body.messages[1].content).toContain("examples");
        expect(body.response_format).toEqual({ type: "json_object" });
    });

    test("parses OpenAI dictionary variants with snake_case and string arrays", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                translation: "달리다",
                                detailed_meanings: ["빠르게 움직이다"],
                                definitions: ["발로 빠르게 이동하다"],
                                examples: ["I run every morning."],
                            }),
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
        });
        const result = await translator.translate("run", "en", "ko");

        expect(result).toMatchObject({
            mainMeaning: "달리다",
            detailedMeanings: [{ pos: "", meaning: "빠르게 움직이다" }],
            definitions: [{ pos: "", meaning: "발로 빠르게 이동하다" }],
            examples: [{ source: "I run every morning." }],
        });
    });

    test("does not advertise OpenAI support when API key is missing", () => {
        const translator = new LocalTranslator({ enabled: true, mode: "openai" });
        expect(translator.supportedLanguages().size).toBe(0);
    });

    test("retries a streamed page reply that ended without finish_reason with a larger budget", async () => {
        // An SSE stream cut mid-generation (proxy drop, server error event) ends with
        // content but NO finish_reason — passing it off as success would hand the page
        // pipeline a truncated reply. The engine must retry once at the larger budget.
        const encoder = new TextEncoder();
        const makeSseResponse = (events: string[]) => {
            const chunks = events.map((event) => encoder.encode(`data: ${event}\n\n`));
            let index = 0;
            return {
                ok: true,
                status: 200,
                body: {
                    getReader: () => ({
                        read: async () =>
                            index < chunks.length
                                ? { done: false, value: chunks[index++] }
                                : { done: true, value: undefined },
                        releaseLock: () => undefined,
                    }),
                },
            };
        };

        const fetchMock = jest
            .fn()
            // First attempt: deltas arrive, then the stream dies without finish_reason.
            .mockResolvedValueOnce(
                makeSseResponse([
                    JSON.stringify({
                        choices: [{ delta: { content: "[[1:p]]\n첫 번째 문장.\n[[2:p]]\n두 번" } }],
                    }),
                ])
            )
            // Retry: the full reply completes with finish_reason "stop".
            .mockResolvedValueOnce(
                makeSseResponse([
                    JSON.stringify({
                        choices: [
                            {
                                delta: {
                                    content: "[[1:p]]\n첫 번째 문장.\n[[2:p]]\n두 번째 문장.",
                                },
                            },
                        ],
                    }),
                    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
                ])
            );
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-5.4-mini",
        });
        const onProgress = jest.fn();
        const result = await translator.translate(
            ["[[1:p]]", "First sentence.", "[[2:p]]", "Second sentence."].join("\n"),
            "en",
            "ko",
            { onProgress }
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(firstBody.stream).toBe(true);
        expect(secondBody.stream).toBe(true);
        // The retry runs at the larger token multiplier: a strictly larger budget.
        expect(secondBody.max_completion_tokens).toBeGreaterThan(
            firstBody.max_completion_tokens
        );
        expect(result.mainMeaning).toContain("두 번째 문장.");
        expect(onProgress).toHaveBeenCalled();
    });

    test("excludes gpt-4o from the large page completion budget but includes gpt-4.1-mini", async () => {
        // gpt-4o is deliberately excluded from supportsLargeCompletionBudget: the
        // gpt-4o-2024-05-13 snapshot hard-caps completions at 4096 and the alias may
        // still serve it — a too-high cap is a hard 400, not a recoverable truncation.
        // gpt-4.1 models all take the large first-attempt ceiling.
        const hugePage = `[[1:p]]\n${"lorem ipsum dolor sit amet ".repeat(3000)}`;
        const reply = {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ finish_reason: "stop", message: { content: "[[1:p]]\n번역." } }],
            }),
        };

        let fetchMock = jest.fn().mockResolvedValue(reply);
        global.fetch = fetchMock as any;
        const gpt4o = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-4o",
        });
        await gpt4o.translate(hugePage, "en", "ko");
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(4096);

        fetchMock = jest.fn().mockResolvedValue(reply);
        global.fetch = fetchMock as any;
        const gpt41Mini = new LocalTranslator({
            enabled: true,
            mode: "openai",
            openaiApiKey: "openai-test-key",
            openaiModel: "gpt-4.1-mini",
        });
        await gpt41Mini.translate(hugePage, "en", "ko");
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(12288);
    });
});
