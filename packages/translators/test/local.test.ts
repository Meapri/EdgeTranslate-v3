import LocalTranslator from "../src/translators/local";

describe("LocalTranslator", () => {
    const originalFetch = global.fetch;

    const originalTranslator = (globalThis as any).Translator;

    afterEach(() => {
        global.fetch = originalFetch;
        (globalThis as any).Translator = originalTranslator;
        jest.restoreAllMocks();
    });

    test("posts to the configured local API and parses translated text", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, translated_text: "안녕" }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            endpoint: "https://local-translate.example.test/translate",
            apiKey: "test-key",
        });

        const result = await translator.translate("hello", "auto", "ko");

        expect(result).toMatchObject({
            originalText: "hello",
            mainMeaning: "안녕",
            sourceLanguage: "auto",
            targetLanguage: "ko",
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "https://local-translate.example.test/translate",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    "Content-Type": "application/json",
                    "X-API-Key": "test-key",
                }),
            })
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toMatchObject({
            text: "hello",
            source_language: "auto",
            target_language: "Korean",
        });
    });

    test("deduplicates concurrent identical requests", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, translated_text: "안녕" }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            endpoint: "http://local.test/translate",
        });
        const [first, second] = await Promise.all([
            translator.translate("hello", "auto", "ko"),
            translator.translate("hello", "auto", "ko"),
        ]);

        expect(first.mainMeaning).toBe("안녕");
        expect(second.mainMeaning).toBe("안녕");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("does not advertise endpoint support when endpoint is missing", () => {
        const translator = new LocalTranslator({ enabled: true, endpoint: "" });
        expect(translator.supportedLanguages().size).toBe(0);
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

    test("advertises Chrome built-in support without endpoint", () => {
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
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
            model: "gemini-2.0-flash",
        });
        const result = await translator.translate("hello", "en", "ko");

        expect(result).toMatchObject({
            originalText: "hello",
            mainMeaning: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=studio-test-key"
        );
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.temperature).toBe(0);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
        expect(body.contents[0].parts[0].text).toContain("from English to Korean");
        expect(body.contents[0].parts[0].text).toContain(
            "keep those marker lines unchanged"
        );
        expect(body.contents[0].parts[0].text).toContain("hello");
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

    test("omits thinking config for Gemma Google AI Studio models", async () => {
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

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.generationConfig.temperature).toBe(0);
        expect(body.generationConfig.thinkingConfig).toBeUndefined();
    });

    test("does not advertise Google AI Studio support when API key is missing", () => {
        const translator = new LocalTranslator({ enabled: true, mode: "googleAiStudio" });
        expect(translator.supportedLanguages().size).toBe(0);
    });
});
