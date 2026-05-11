import {
    toChromeTranslatorLanguage,
    translateWithChromeOnDevice,
    warmupChromeOnDevice,
} from "../../../src/common/scripts/chrome_builtin_translate.js";

/**
 * Helper: create a LanguageModel mock that supports the create-warm-recreate
 * pattern.  create() is called twice per new language pair:
 *   1. warmup session: receives a trivial prompt("Translate:\nOK"), then destroy()
 *   2. clean session:  used for actual translations (prompt / clone / promptStreaming)
 *
 * `translationPrompt` is the mock for prompts on the CLEAN (real) session.
 * The warmup prompt always resolves to "OK".
 */
function mockGeminiNano(translationPrompt, extraSessionProps = {}) {
    const warmupPrompt = jest.fn().mockResolvedValue("OK");
    const warmupDestroy = jest.fn();
    const warmupSession = { prompt: warmupPrompt, destroy: warmupDestroy };

    const realSession = { prompt: translationPrompt, ...extraSessionProps };

    const createMock = jest
        .fn()
        .mockResolvedValueOnce(warmupSession)   // 1st create → warmup
        .mockResolvedValue(realSession);         // 2nd+ create → real session

    globalThis.LanguageModel = {
        availability: jest.fn().mockResolvedValue("available"),
        create: createMock,
    };
    return { createMock, warmupPrompt, warmupDestroy, realSession, translationPrompt };
}

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
        const { createMock } = mockGeminiNano(promptMock);

        const first = await translateWithChromeOnDevice("hello", "en-US", "ko-KR");
        const second = await translateWithChromeOnDevice("world", "en-US", "ko-KR");

        // 2 creates for the first language pair (warmup + real), then reused
        expect(createMock).toHaveBeenCalledTimes(2);
        // The second create (real session) should have the system prompt
        expect(createMock.mock.calls[1][0].initialPrompts[0].content).toMatch(
            /professional translator/i
        );
        expect(promptMock.mock.calls[0][0]).toContain("hello");
        expect(promptMock.mock.calls[1][0]).toContain("world");
        expect(first.mainMeaning).toBe("안녕");
        expect(second.mainMeaning).toBe("세계");
    });

    it("warms up Chrome Gemini Nano sessions without prompting", async () => {
        const promptMock = jest.fn();
        const { createMock } = mockGeminiNano(promptMock);

        await expect(warmupChromeOnDevice("en", "ja")).resolves.toEqual({
            sourceLanguage: "en",
            targetLanguage: "ja",
        });
        // warmup + real session creation
        expect(createMock).toHaveBeenCalledTimes(2);
        // The real session's prompt should NOT have been called (warmup only warms up the first session)
        expect(promptMock).not.toHaveBeenCalled();
    });

    it("uses streaming Chrome Gemini Nano prompts and keeps the final translation stable", async () => {
        const promptMock = jest.fn().mockResolvedValue('{"translation":"안녕"}');
        async function* streamTranslation() {
            yield '{"translation":"안';
            yield '녕"}';
        }
        const promptStreamingMock = jest.fn().mockResolvedValue(streamTranslation());
        mockGeminiNano(promptMock, { promptStreaming: promptStreamingMock });

        const updates = [];
        const result = await translateWithChromeOnDevice("hello there.", "es", "ko", {
            onUpdate: (partial) => updates.push(partial.mainMeaning),
        });
        expect(result.mainMeaning).toBe("안녕");
        expect(promptStreamingMock).toHaveBeenCalled();
        expect(promptMock).not.toHaveBeenCalled();
        expect(updates).toEqual(["안", "안녕"]);
    });

    it("does not expose dictionary JSON fields while streaming translations", async () => {
        const promptMock = jest.fn();
        async function* streamTranslation() {
            yield '{"translation":"Uwagi dotyczące resetowania hasła","detailedMeanings":[{"pos":"명사","meaning":"사전 설명"}]}';
        }
        const promptStreamingMock = jest.fn().mockResolvedValue(streamTranslation());
        mockGeminiNano(promptMock, { promptStreaming: promptStreamingMock });

        const updates = [];
        const result = await translateWithChromeOnDevice("Merhaba.", "tr", "pl", {
            onUpdate: (partial) => updates.push(partial.mainMeaning),
        });

        expect(result.mainMeaning).toBe("Uwagi dotyczące resetowania hasła");
        expect(promptStreamingMock).toHaveBeenCalled();
        expect(promptMock).not.toHaveBeenCalled();
        expect(updates).toEqual(["Uwagi dotyczące resetowania hasła"]);
        expect(updates.join("\n")).not.toContain("detailedMeanings");
        expect(updates.join("\n")).not.toContain('"pos"');
    });

    it("clones the base Gemini Nano session for each translation prompt", async () => {
        const destroyMock = jest.fn();
        const clonedPromptMock = jest.fn().mockResolvedValue("안녕");
        const cloneMock = jest.fn().mockResolvedValue({
            prompt: clonedPromptMock,
            destroy: destroyMock,
        });
        mockGeminiNano(jest.fn(), { clone: cloneMock });

        const result = await translateWithChromeOnDevice("مرحبا.", "ar", "ko");

        expect(result.mainMeaning).toBe("안녕");
        expect(cloneMock).toHaveBeenCalledTimes(1);
        expect(clonedPromptMock).toHaveBeenCalledTimes(1);
        expect(destroyMock).toHaveBeenCalledTimes(1);
    });

    it("sends long Gemini Nano translations as one prompt without sentence chunking", async () => {
        const promptMock = jest.fn().mockResolvedValue("полный перевод");
        mockGeminiNano(promptMock);
        const source =
            "一つ目です。二つ目です。三つ目です。四つ目です。五つ目です。六つ目です。七つ目です。";

        const result = await translateWithChromeOnDevice(source, "ja", "ru");

        expect(result.mainMeaning).toBe("полный перевод");
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain(source);
    });

    it("sends very long paragraphs as-is without splitting", async () => {
        const promptMock = jest.fn().mockResolvedValueOnce("komplette deutsche Übersetzung");
        mockGeminiNano(promptMock);
        const longParagraph = `${"長い説明です。".repeat(420)}終わりです。`;

        const result = await translateWithChromeOnDevice(longParagraph, "ja", "de");

        expect(result.mainMeaning).toBe("komplette deutsche Übersetzung");
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain("長い説明です。");
        expect(promptMock.mock.calls[0][0]).toContain(
            "→ German"
        );
    });

    it("sends multi-paragraph text as-is in a single prompt", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValueOnce("premier paragraphe\n\ndeuxième paragraphe");
        mockGeminiNano(promptMock);
        const source = "第一段落です。\n\n第二段落です。";

        const result = await translateWithChromeOnDevice(source, "ja", "fr");

        expect(result.mainMeaning).toBe("premier paragraphe\n\ndeuxième paragraphe");
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain("第一段落です。");
        expect(promptMock.mock.calls[0][0]).toContain("第二段落です。");
        expect(promptMock.mock.calls[0][0]).toContain("Do not omit");
    });

    it("sends multi-line text as-is in a single prompt", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValueOnce("primeira linha\nsegunda linha\nterceira linha");
        mockGeminiNano(promptMock);
        const source = "第一行です。\n第二行です。\n第三行です。";

        const result = await translateWithChromeOnDevice(source, "ja", "pt");

        expect(result.mainMeaning).toBe("primeira linha\nsegunda linha\nterceira linha");
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain("第一行です。");
        expect(promptMock.mock.calls[0][0]).toContain("第二行です。");
        expect(promptMock.mock.calls[0][0]).toContain("第三行です。");
    });

    it("uses translation prompts for short headings inside multi-line selections", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValueOnce("wachtwoord opnieuw instellen\ntekst.");
        mockGeminiNano(promptMock);
        const source = "＜パスワード再設定時の注意事項＞\n本文です。";

        const result = await translateWithChromeOnDevice(source, "ja", "nl");

        expect(result.mainMeaning).toBe("wachtwoord opnieuw instellen\ntekst.");
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).not.toContain("One word or short term");
        expect(promptMock.mock.calls[0][0]).not.toContain("detailedMeanings");
    });

    it("keeps medium-length Japanese clause-heavy paragraphs in one Gemini Nano prompt", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValue(
                "포켓몬센터 온라인을 이용해 주셔서 감사합니다. 부정하게 입수한 로그인 정보를 사용했습니다."
            );
        mockGeminiNano(promptMock);
        const source =
            "平素よりポケモンセンターオンラインをご利用いただき、ありがとうございます。この度、弊社サービス以外から何らかの手段で不正に入手したログインID（メールアドレス）とパスワードの情報を用いて、ポケモンセンターオンラインに不正ログインを行ったと思われる事象が発生していることを確認いたしましたため、被害の拡大防止のため緊急メンテナンスを実施させていただいておりました。";

        const result = await translateWithChromeOnDevice(source, "ja", "ko");

        expect(result.mainMeaning).toBe(
            "포켓몬센터 온라인을 이용해 주셔서 감사합니다. 부정하게 입수한 로그인 정보를 사용했습니다."
        );
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).toContain(
            "→ Korean"
        );
    });

    it("translates marked Gemini Nano segments without sentence chunking", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValue(
                "<<<EDGE_TRANSLATE_SEGMENT_1 role=paragraph>>>\nالجزء الأول والجزء الثاني"
            );
        mockGeminiNano(promptMock);
        const source = [
            "<<<EDGE_TRANSLATE_SEGMENT_1 role=paragraph>>>",
            "一つ目です。二つ目です。三つ目です。四つ目です。",
        ].join("\n");

        const result = await translateWithChromeOnDevice(source, "ja", "ar");

        expect(result.mainMeaning).toBe(
            "<<<EDGE_TRANSLATE_SEGMENT_1 role=paragraph>>>\nالجزء الأول والجزء الثاني"
        );
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(promptMock.mock.calls[0][0]).not.toContain("<<<EDGE_TRANSLATE_SEGMENT");
        expect(promptMock.mock.calls[0][0]).not.toContain("One word or short term");
    });

    it("detects auto source language before prompting Gemini Nano", async () => {
        const promptMock = jest.fn().mockResolvedValue(
            JSON.stringify({
                translation: "Повідомлення про безпеку облікового запису",
            })
        );
        const detectMock = jest.fn().mockResolvedValue([{ detectedLanguage: "ja" }]);
        const { createMock } = mockGeminiNano(promptMock);
        globalThis.LanguageDetector = {
            create: jest.fn().mockResolvedValue({ detect: detectMock }),
        };

        const result = await translateWithChromeOnDevice(
            [
                "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
                "「会員アカウント」に対する不正ログインの発生のご報告",
            ].join("\n"),
            "auto",
            "uk"
        );

        expect(result.sourceLanguage).toBe("ja");
        // The real session create (2nd call) carries the language config
        expect(createMock.mock.calls[1][0]).toMatchObject({
            expectedInputs: [{ type: "text", languages: ["en", "ja"] }],
        });
        expect(promptMock.mock.calls[0][0]).toContain("→ Ukrainian");
        expect(promptMock.mock.calls[0][0]).not.toContain(
            "<<<EDGE_TRANSLATE_SEGMENT"
        );
        expect(promptMock.mock.calls[0][0]).not.toContain("<<<EDGE_TRANSLATE_SEGMENT");
        expect(detectMock.mock.calls[0][0]).not.toContain("EDGE_TRANSLATE_SEGMENT");
    });

    it("parses Gemini Nano structured translation without pronunciation display fields", async () => {
        const promptMock = jest.fn().mockResolvedValue(
            JSON.stringify({
                translation: "안녕하세요.",
            })
        );
        mockGeminiNano(promptMock);

        const result = await translateWithChromeOnDevice("hello.", "de", "ko");
        expect(result.mainMeaning).toBe("안녕하세요.");
        expect(result.tPronunciation).toBeUndefined();
        expect(result.sPronunciation).toBeUndefined();
        expect(promptMock.mock.calls[0][0]).not.toContain("Pronunciation");
        expect(promptMock.mock.calls[0][0]).not.toContain("tPronunciation");
    });

    it("throws when Gemini Nano copies source text unchanged", async () => {
        const copiedSource =
            "This is a long enough source sentence that should be translated into Korean.";
        const promptMock = jest.fn().mockResolvedValue(
            JSON.stringify({
                translation: copiedSource,
            })
        );
        mockGeminiNano(promptMock);

        const result = await translateWithChromeOnDevice(copiedSource, "ru", "ko");
        // Without fallback, copied source is returned as-is
        expect(result.mainMeaning).toBe(copiedSource);
    });

    it("does not expose malformed Gemini Nano JSON in the translation panel", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValue(
                '{"translation":"평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.","tPronunciation":"pyeongso pokemonseonteo online-eul iyonghae jusyeoseo gamsahamnida.'
            );
        mockGeminiNano(promptMock);

        const result = await translateWithChromeOnDevice("Merhaba.", "tr", "ko");
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
        mockGeminiNano(promptMock);

        const result = await translateWithChromeOnDevice("run", "fr", "ko");
        expect(result).toMatchObject({
            mainMeaning: "달리다",
            detailedMeanings: [{ pos: "verb", meaning: "빠르게 움직이다" }],
            definitions: [{ pos: "verb", meaning: "발로 빠르게 이동하다" }],
            examples: [{ source: "I run.", target: "나는 달린다." }],
        });
        expect(promptMock.mock.calls[0][0]).toContain("translation");
        expect(promptMock.mock.calls[0][0]).not.toContain("Pronunciation");
        expect(promptMock.mock.calls[0][0]).not.toContain("tPronunciation");
    });

    it("treats long CJK headlines as normal translations instead of dictionary terms", async () => {
        const source =
            "「会員アカウント」に対する不正ログインの発生のご報告と安全にご利用いただくためのお願い";
        const promptMock = jest.fn().mockResolvedValue(
            JSON.stringify({
                translation:
                    "Rapport om obehörig inloggning på medlemskonto och vägledning för säker användning",
            })
        );
        mockGeminiNano(promptMock);

        const result = await translateWithChromeOnDevice(source, "ja", "sv");

        expect(result.mainMeaning).toBe(
            "Rapport om obehörig inloggning på medlemskonto och vägledning för säker användning"
        );
        expect(promptMock.mock.calls[0][0]).toContain("→ Swedish");
        expect(promptMock.mock.calls[0][0]).toContain("Do not omit");
        expect(promptMock.mock.calls[0][0]).not.toContain("One word or short term");
    });

    it("keeps malformed Gemini Nano dictionary JSON out of the result text", async () => {
        const promptMock = jest
            .fn()
            .mockResolvedValue('{"translation":"필요하다","tPronunciation":"piryohada');
        mockGeminiNano(promptMock);

        const result = await translateWithChromeOnDevice("need", "it", "ko");
        expect(result.mainMeaning).toBe("필요하다");
        expect(result.mainMeaning).not.toContain('"translation"');
        expect(result.tPronunciation).toBeUndefined();
    });


    it("instructs Korean Gemini Nano output to avoid mixed-script Japanese or Chinese fragments", async () => {
        const promptMock = jest.fn().mockResolvedValueOnce(
            JSON.stringify({
                translation: "국세조사 사칭 의심스러운 이메일",
            })
        );
        mockGeminiNano(promptMock);

        const result = await translateWithChromeOnDevice(
            "国勢調査を装った不審なメール",
            "sv",
            "ko"
        );

        expect(result.mainMeaning).toBe("국세조사 사칭 의심스러운 이메일");
        expect(promptMock).toHaveBeenCalledTimes(2);
        expect(promptMock.mock.calls[0][0]).toContain(
            "→ Korean"
        );
        expect(promptMock.mock.calls[0][0]).not.toContain("One word or short term");
    });


});

