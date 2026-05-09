import HybridTranslator from "../src/translators/hybrid";

describe("hybrid translator api", () => {
    const TRANSLATOR = new HybridTranslator(
        {
            translators: ["GoogleTranslate"],
            selections: {
                originalText: "GoogleTranslate",
                mainMeaning: "GoogleTranslate",
                tPronunciation: "GoogleTranslate",
                sPronunciation: "GoogleTranslate",
                detailedMeanings: "GoogleTranslate",
                definitions: "GoogleTranslate",
                examples: "GoogleTranslate",
                sourceLanguage: "GoogleTranslate",
                targetLanguage: "GoogleTranslate",
            },
        },
        {}
    );

    it("to detect language of English text", (done) => {
        TRANSLATOR.detect("hello")
            .then((result) => {
                expect(result).toEqual("en");
                done();
            })
            .catch((error) => {
                done(error);
            });
    });

    it("to detect language of Chinese text", (done) => {
        TRANSLATOR.detect("你好")
            .then((result) => {
                expect(result).toEqual("zh-CN");
                done();
            })
            .catch((error) => {
                done(error);
            });
    });

    it("to translate a piece of English text", (done) => {
        TRANSLATOR.translate("hello", "en", "zh-CN")
            .then((result) => {
                expect(result.mainMeaning).toEqual("你好");
                expect(result.originalText).toEqual("hello");
                done();
            })
            .catch((error) => {
                done(error);
            });
    });

    it("to translate a piece of Chinese text", (done) => {
        TRANSLATOR.translate("你好", "zh-CN", "en")
            .then((result) => {
                expect(result.mainMeaning).toEqual("Hello");
                expect(result.originalText).toEqual("你好");
                done();
            })
            .catch((error) => {
                done(error);
            });
    });

    it("requests translators selected for detail fields even when the translator list is stale", async () => {
        const translator = new HybridTranslator(
            {
                translators: ["GoogleTranslate"],
                selections: {
                    originalText: "GoogleTranslate",
                    mainMeaning: "GoogleTranslate",
                    tPronunciation: "GoogleTranslate",
                    sPronunciation: "GoogleTranslate",
                    detailedMeanings: "LocalTranslate",
                    definitions: "LocalTranslate",
                    examples: "LocalTranslate",
                    sourceLanguage: "GoogleTranslate",
                    targetLanguage: "GoogleTranslate",
                },
            },
            {}
        );

        translator.REAL_TRANSLATORS.GoogleTranslate = {
            supportedLanguages: () => new Set(["auto", "en", "ko"]),
            detect: () => Promise.resolve("en"),
            translate: () =>
                Promise.resolve({
                    originalText: "run",
                    mainMeaning: "달리다",
                    sourceLanguage: "en",
                    targetLanguage: "ko",
                }),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        } as any;
        translator.REAL_TRANSLATORS.LocalTranslate = {
            supportedLanguages: () => new Set(["auto", "en", "ko"]),
            detect: () => Promise.resolve("en"),
            translate: () =>
                Promise.resolve({
                    originalText: "run",
                    mainMeaning: "달리다",
                    detailedMeanings: [{ pos: "verb", meaning: "빠르게 움직이다" }],
                    definitions: [{ pos: "verb", meaning: "발로 빠르게 이동하다" }],
                    examples: [{ source: "I run.", target: "나는 달린다." }],
                    sourceLanguage: "en",
                    targetLanguage: "ko",
                }),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        } as any;

        const result = await translator.translate("run", "en", "ko");

        expect(result.mainMeaning).toBe("달리다");
        expect(result.detailedMeanings).toEqual([{ pos: "verb", meaning: "빠르게 움직이다" }]);
        expect(result.definitions).toEqual([{ pos: "verb", meaning: "발로 빠르게 이동하다" }]);
        expect(result.examples).toEqual([{ source: "I run.", target: "나는 달린다." }]);
    });
});
