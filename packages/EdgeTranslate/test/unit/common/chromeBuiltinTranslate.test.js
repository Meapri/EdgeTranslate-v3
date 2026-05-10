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
        expect(createMock.mock.calls[0][0]).toMatchObject({
            expectedInputs: [{ type: "text", languages: ["en"] }],
            expectedOutputs: [{ type: "text", languages: ["en"] }],
        });
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
        expect(createMock.mock.calls[0][0]).toMatchObject({
            expectedOutputs: [{ type: "text", languages: ["ja"] }],
        });
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

    it("parses Gemini Nano structured translation without pronunciation display fields", async () => {
        const promptMock = jest.fn().mockResolvedValue(
            JSON.stringify({
                translation: "안녕하세요.",
            })
        );
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ prompt: promptMock }),
        };

        const result = await translateWithChromeOnDevice("hello.", "de", "ko");
        expect(result.mainMeaning).toBe("안녕하세요.");
        expect(result.tPronunciation).toBeUndefined();
        expect(result.sPronunciation).toBeUndefined();
        expect(promptMock.mock.calls[0][0]).not.toContain("Pronunciation");
        expect(promptMock.mock.calls[0][0]).not.toContain("tPronunciation");
    });

    it("rejects copied Gemini Nano source output without a second prompt", async () => {
        const copiedSource =
            "This is a long enough source sentence that should be translated into Korean.";
        const promptMock = jest.fn().mockResolvedValue(
            JSON.stringify({
                translation: copiedSource,
            })
        );
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ prompt: promptMock }),
        };

        await expect(translateWithChromeOnDevice(copiedSource, "ru", "ko")).rejects.toThrow(
            "returned source text"
        );
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain("Do not return the source text unchanged");
    });

    it("does not expose malformed Gemini Nano JSON in the translation panel", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValue(
                '{"translation":"평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.","tPronunciation":"pyeongso pokemonseonteo online-eul iyonghae jusyeoseo gamsahamnida.'
            );
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ prompt: promptMock }),
        };

        const result = await translateWithChromeOnDevice("hello.", "ja", "ko");
        expect(result.mainMeaning).toBe("평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.");
        expect(result.mainMeaning).not.toContain('"translation"');
        expect(result.tPronunciation).toBeUndefined();
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
        expect(promptMock.mock.calls[0][0]).not.toContain("Pronunciation");
        expect(promptMock.mock.calls[0][0]).not.toContain("tPronunciation");
    });

    it("keeps malformed Gemini Nano dictionary JSON out of the result text", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValue('{"translation":"필요하다","tPronunciation":"piryohada');
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ prompt: promptMock }),
        };

        const result = await translateWithChromeOnDevice("need", "it", "ko");
        expect(result.mainMeaning).toBe("필요하다");
        expect(result.mainMeaning).not.toContain('"translation"');
        expect(result.tPronunciation).toBeUndefined();
    });

    it("normalizes common untranslated Japanese or Chinese fragments in Korean output without a second prompt", async () => {
        const promptMock = jest.fn().mockResolvedValueOnce(
            JSON.stringify({
                translation:
                    "이번에 당사 서비스 외의 어떤 수단을 통해不正하게 ログイン한 것으로 보입니다.",
            })
        );
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ prompt: promptMock }),
        };

        const result = await translateWithChromeOnDevice(
            "通过公司服务以外的手段进行不正登录。",
            "zh",
            "ko"
        );

        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain("Use Hangul Korean");
        expect(result.mainMeaning).toBe(
            "이번에 당사 서비스 외의 어떤 수단을 통해 부정하게 로그인한 것으로 보입니다."
        );
    });

    it("normalizes common untranslated fragments in raw Korean output", async () => {
        const promptStreamingMock = jest
            .fn()
            .mockResolvedValue("또한不正하게 로그인 후 メールアドレス가 변경되었습니다.");
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ promptStreaming: promptStreamingMock }),
        };

        const result = await translateWithChromeOnDevice("また不正ログイン後。", "nl", "ko");

        expect(promptStreamingMock).toHaveBeenCalledTimes(1);
        expect(result.mainMeaning).toBe("또한 부정하게 로그인 후 이메일 주소가 변경되었습니다.");
    });

    it("normalizes common untranslated fragments in non-Korean target languages without a second prompt", async () => {
        const promptMock = jest.fn().mockResolvedValueOnce(
            JSON.stringify({
                translation: "This appears to be 不正 login.",
            })
        );
        globalThis.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue({ prompt: promptMock }),
        };

        const result = await translateWithChromeOnDevice("不正ログインと思われます。", "ja", "en");

        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain("normal Latin-script form of English");
        expect(result.mainMeaning).toBe("This appears to be unauthorized login.");
    });
});
