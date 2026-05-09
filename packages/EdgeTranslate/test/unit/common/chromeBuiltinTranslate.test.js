import {
    toChromeTranslatorLanguage,
    translateWithChromeOnDevice,
    warmupChromeOnDevice,
} from "../../../src/common/scripts/chrome_builtin_translate.js";

describe("Chrome built-in translator helper", () => {
    const originalTranslator = globalThis.Translator;
    const originalLanguageDetector = globalThis.LanguageDetector;
    const originalLanguageModel = globalThis.LanguageModel;

    afterEach(() => {
        globalThis.Translator = originalTranslator;
        globalThis.LanguageDetector = originalLanguageDetector;
        globalThis.LanguageModel = originalLanguageModel;
        jest.restoreAllMocks();
    });

    it("normalizes regional language codes for Chrome Translator", () => {
        expect(toChromeTranslatorLanguage("en-US")).toBe("en");
        expect(toChromeTranslatorLanguage("ko_KR")).toBe("ko");
        expect(toChromeTranslatorLanguage("zh-TW")).toBe("zh-Hant");
        expect(toChromeTranslatorLanguage("zh-Hans-CN")).toBe("zh");
        expect(toChromeTranslatorLanguage("he-IL")).toBe("iw");
    });

    it("uses Chrome Gemini Nano LanguageModel API and reuses sessions", async () => {
        const promptMock = jest.fn().mockResolvedValueOnce("안녕").mockResolvedValueOnce("세계");
        const createMock = jest.fn().mockResolvedValue({ prompt: promptMock });
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: createMock,
        };

        const first = await translateWithChromeOnDevice("hello", "en-US", "ko-KR");
        const second = await translateWithChromeOnDevice("world", "en-US", "ko-KR");

        expect(globalThis.LanguageModel.availability).toHaveBeenCalledTimes(1);
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(createMock.mock.calls[0][0].initialPrompts[0].content).toContain(
            "fast translation engine"
        );
        expect(promptMock.mock.calls[0][0]).toContain("hello");
        expect(promptMock.mock.calls[1][0]).toContain("world");
        expect(first.mainMeaning).toBe("안녕");
        expect(second.mainMeaning).toBe("세계");
    });

    it("warms up Chrome Gemini Nano sessions without prompting", async () => {
        const promptMock = jest.fn();
        const createMock = jest.fn().mockResolvedValue({ prompt: promptMock });
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: createMock,
        };

        await expect(warmupChromeOnDevice("en", "ja")).resolves.toEqual({
            sourceLanguage: "en",
            targetLanguage: "ja",
        });
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(promptMock).not.toHaveBeenCalled();
    });

    it("collects Chrome Gemini Nano promptStreaming output when available", async () => {
        async function* stream() {
            yield "안";
            yield "녕";
        }
        const promptMock = jest.fn();
        const promptStreamingMock = jest.fn().mockResolvedValue(stream());
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({
                prompt: promptMock,
                promptStreaming: promptStreamingMock,
            }),
        };

        const result = await translateWithChromeOnDevice("hello there.", "es", "ko");
        expect(result.mainMeaning).toBe("안녕");
        expect(promptStreamingMock).toHaveBeenCalled();
        expect(promptMock).not.toHaveBeenCalled();
    });

    it("parses Gemini Nano dictionary details for single-word translation", async () => {
        const promptMock = jest.fn().mockResolvedValue(
            JSON.stringify({
                translation: "달리다",
                detailedMeanings: [{ pos: "verb", meaning: "빠르게 움직이다" }],
                definitions: [{ pos: "verb", meaning: "발로 빠르게 이동하다" }],
                examples: [{ source: "I run.", target: "나는 달린다." }],
            })
        );
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ prompt: promptMock }),
        };

        const result = await translateWithChromeOnDevice("run", "fr", "ko");
        expect(result).toMatchObject({
            mainMeaning: "달리다",
            detailedMeanings: [{ pos: "verb", meaning: "빠르게 움직이다" }],
            definitions: [{ pos: "verb", meaning: "발로 빠르게 이동하다" }],
            examples: [{ source: "I run.", target: "나는 달린다." }],
        });
        expect(promptMock.mock.calls[0][0]).toContain("Return strict JSON only");
    });
});
