import {
    toChromeTranslatorLanguage,
    translateWithChromeOnDevice,
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
            "local Gemini Nano model"
        );
        expect(promptMock.mock.calls[0][0]).toContain("hello");
        expect(promptMock.mock.calls[1][0]).toContain("world");
        expect(first.mainMeaning).toBe("안녕");
        expect(second.mainMeaning).toBe("세계");
    });
});
