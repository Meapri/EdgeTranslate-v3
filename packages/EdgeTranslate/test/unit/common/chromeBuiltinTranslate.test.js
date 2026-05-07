import {
    toChromeTranslatorLanguage,
    translateWithChromeOnDevice,
} from "../../../src/common/scripts/chrome_builtin_translate.js";

describe("Chrome built-in translator helper", () => {
    const originalTranslator = globalThis.Translator;
    const originalLanguageDetector = globalThis.LanguageDetector;

    afterEach(() => {
        globalThis.Translator = originalTranslator;
        globalThis.LanguageDetector = originalLanguageDetector;
        jest.restoreAllMocks();
    });

    it("normalizes regional language codes for Chrome Translator", () => {
        expect(toChromeTranslatorLanguage("en-US")).toBe("en");
        expect(toChromeTranslatorLanguage("ko_KR")).toBe("ko");
        expect(toChromeTranslatorLanguage("zh-TW")).toBe("zh-Hant");
        expect(toChromeTranslatorLanguage("zh-Hans-CN")).toBe("zh");
        expect(toChromeTranslatorLanguage("he-IL")).toBe("iw");
    });

    it("uses Chrome Translator API and reuses translators", async () => {
        const translateMock = jest.fn().mockResolvedValueOnce("안녕").mockResolvedValueOnce("세계");
        const createMock = jest.fn().mockResolvedValue({ translate: translateMock });
        globalThis.Translator = {
            availability: jest.fn().mockResolvedValue("available"),
            create: createMock,
        };
        const first = await translateWithChromeOnDevice("hello", "en-US", "ko-KR");
        const second = await translateWithChromeOnDevice("world", "en-US", "ko-KR");

        expect(globalThis.Translator.availability).toHaveBeenCalledTimes(1);
        expect(globalThis.Translator.availability).toHaveBeenCalledWith({
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(createMock).toHaveBeenCalledWith({ sourceLanguage: "en", targetLanguage: "ko" });
        expect(translateMock).toHaveBeenNthCalledWith(1, "hello");
        expect(translateMock).toHaveBeenNthCalledWith(2, "world");
        expect(first.mainMeaning).toBe("안녕");
        expect(second.mainMeaning).toBe("세계");
    });
});
