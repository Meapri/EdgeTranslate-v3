import BingTranslator from "../src/translators/bing";

describe("bing translator api", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("updates IG and IID without depending on live Bing responses", async () => {
        const translator = new BingTranslator();
        jest.spyOn(translator as any, "_doUpdateTokens").mockImplementation(async function (this: any) {
            this.IG = "TESTIG123";
            this.key = "123456";
            this.token = "test-token";
            this.IID = "translator.5028";
            this.tokensInitiated = true;
        });

        await translator.updateTokens();

        expect(translator.IG).toBe("TESTIG123");
        expect(translator.IID).toBe("translator.5028");
    });

    it("translates text from English to Korean using mocked Bing responses", async () => {
        const translator = new BingTranslator();
        translator.IG = "TESTIG123";
        translator.key = "123456";
        translator.token = "test-token";
        translator.IID = "translator.5028";

        jest.spyOn(translator, "request").mockImplementation(async (constructParams: any, args: string[]) => {
            const params = constructParams.call(translator, ...args);
            if (params.url.startsWith("ttranslatev3")) {
                return [
                    {
                        detectedLanguage: { language: "en" },
                        translations: [
                            {
                                text: "안녕하세요",
                                transliteration: { text: "annyeonghaseyo" },
                            },
                        ],
                    },
                ];
            }
            if (params.url.startsWith("tlookupv3") || params.url.startsWith("texamplev3")) {
                return [];
            }
            throw new Error(`Unexpected Bing mock request: ${params.url}`);
        });

        const result = await translator.translate("Hello world", "en", "ko");

        expect(result).toMatchObject({
            originalText: "Hello world",
            mainMeaning: "안녕하세요",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
    });

    it("skips dictionary lookup and examples for long sentence translations", async () => {
        const translator = new BingTranslator();
        translator.IG = "TESTIG123";
        translator.key = "123456";
        translator.token = "test-token";
        translator.IID = "translator.5028";
        const requestedUrls: string[] = [];

        jest.spyOn(translator, "request").mockImplementation(async (constructParams: any, args: string[]) => {
            const params = constructParams.call(translator, ...args);
            requestedUrls.push(params.url);
            if (params.url.startsWith("ttranslatev3")) {
                return [
                    {
                        detectedLanguage: { language: "en" },
                        translations: [{ text: "Kindle은 기본적으로 한두 가지 일을 잘합니다." }],
                    },
                ];
            }
            return [];
        });

        const result = await translator.translate(
            "Out of the box, the Kindle is good at only one thing. Well, two.",
            "en",
            "ko"
        );

        expect(result.mainMeaning).toBe("Kindle은 기본적으로 한두 가지 일을 잘합니다.");
        expect(requestedUrls).toEqual([expect.stringMatching(/^ttranslatev3/)]);
    });

    it("keeps dictionary lookup and examples for short word translations", async () => {
        const translator = new BingTranslator();
        translator.IG = "TESTIG123";
        translator.key = "123456";
        translator.token = "test-token";
        translator.IID = "translator.5028";
        const requestedUrls: string[] = [];

        jest.spyOn(translator, "request").mockImplementation(async (constructParams: any, args: string[]) => {
            const params = constructParams.call(translator, ...args);
            requestedUrls.push(params.url);
            if (params.url.startsWith("ttranslatev3")) {
                return [
                    {
                        detectedLanguage: { language: "en" },
                        translations: [{ text: "마찰" }],
                    },
                ];
            }
            if (params.url.startsWith("tlookupv3") || params.url.startsWith("texamplev3")) {
                return [];
            }
            throw new Error(`Unexpected Bing mock request: ${params.url}`);
        });

        const result = await translator.translate("friction", "en", "ko");

        expect(result.mainMeaning).toBe("마찰");
        expect(requestedUrls).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^ttranslatev3/),
                expect.stringMatching(/^tlookupv3/),
                expect.stringMatching(/^texamplev3/),
            ])
        );
    });
});
