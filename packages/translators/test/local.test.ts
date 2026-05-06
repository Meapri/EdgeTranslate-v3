import LocalTranslator from "../src/translators/local";

describe("LocalTranslator", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
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
            style: "natural, concise, faithful",
            max_tokens: 96,
        });
    });

    test("deduplicates concurrent identical requests", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, translated_text: "안녕" }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({ enabled: true, endpoint: "http://local.test/translate" });
        const [first, second] = await Promise.all([
            translator.translate("hello", "auto", "ko"),
            translator.translate("hello", "auto", "ko"),
        ]);

        expect(first.mainMeaning).toBe("안녕");
        expect(second.mainMeaning).toBe("안녕");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("does not advertise support when endpoint is missing", () => {
        const translator = new LocalTranslator({ endpoint: "" });
        expect(translator.supportedLanguages().size).toBe(0);
    });
});
