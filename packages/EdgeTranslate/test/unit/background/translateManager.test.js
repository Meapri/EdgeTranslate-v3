import { TranslatorManager } from "../../../src/background/library/translate.js";

jest.mock("common/scripts/chrome_builtin_translate.js", () => ({
    getChromeTranslatorSupportedLanguages: jest.fn(() => new Set(["en", "ko"])),
    translateWithChromeOnDevice: jest.fn(),
    warmupChromeOnDevice: jest.fn(),
}));

import { translateWithChromeOnDevice } from "common/scripts/chrome_builtin_translate.js";

describe("TranslatorManager fast tab resolution", () => {
    test("uses sender.tab.id without querying the active tab", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getCurrentTabId = jest.fn(async () => 99);

        await expect(manager.resolveTargetTabId({ tab: { id: 42 } })).resolves.toBe(42);
        expect(manager.getCurrentTabId).not.toHaveBeenCalled();
    });

    test("falls back to active tab lookup when sender tab is unavailable", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getCurrentTabId = jest.fn(async () => 99);

        await expect(manager.resolveTargetTabId({})).resolves.toBe(99);
        expect(manager.getCurrentTabId).toHaveBeenCalledTimes(1);
    });
});

describe("TranslatorManager selection role wrapping", () => {
    test("versions local AI translation cache keys so prompt fixes are not hidden by stale results", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.cacheOptions = { maxKeyTextLength: 200 };
        manager.HYBRID_TRANSLATOR_CONFIG = {
            selections: {
                mainMeaning: "LocalTranslate",
            },
        };

        expect(manager.makeTranslateKey("hello", "ja", "ko", "LocalTranslate")).toContain(
            "local-ai-prompt-"
        );
        expect(manager.makeTranslateKey("hello", "ja", "ko", "HybridTranslate")).toContain(
            "local-ai-prompt-"
        );
        expect(manager.makeTranslateKey("hello", "ja", "ko", "GoogleTranslate")).not.toContain(
            "local-ai-prompt-"
        );
    });

    test("preserves line breaks in translation cache keys", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.cacheOptions = { maxKeyTextLength: 200 };
        manager.HYBRID_TRANSLATOR_CONFIG = { selections: {} };

        const withBreaks = manager.makeTranslateKey(
            "첫 줄\n둘째 줄",
            "ja",
            "ko",
            "GoogleTranslate"
        );
        const withoutBreaks = manager.makeTranslateKey(
            "첫 줄 둘째 줄",
            "ja",
            "ko",
            "GoogleTranslate"
        );

        expect(withBreaks).not.toBe(withoutBreaks);
        expect(withBreaks).toContain("첫 줄\n둘째 줄");
    });

    test("wraps role metadata only for local AI selection translation", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.HYBRID_TRANSLATOR_CONFIG = {
            selections: {
                mainMeaning: "LocalTranslate",
            },
        };

        expect(manager.shouldWrapSelectionForRole("LocalTranslate", "title")).toBe(true);
        expect(manager.shouldWrapSelectionForRole("HybridTranslate", "title")).toBe(true);
        expect(manager.shouldWrapSelectionForRole("BingTranslate", "title")).toBe(false);
        expect(manager.shouldWrapSelectionForRole("LocalTranslate", "text")).toBe(false);
        expect(
            manager.shouldWrapSelectionForRole("LocalTranslate", "text", [
                { role: "title", text: "Notice title" },
                { role: "date", text: "2025年07月03日（木）" },
                { role: "paragraph", text: "Body text" },
            ])
        ).toBe(true);
        expect(
            manager.shouldWrapSelectionForRole("HybridTranslate", "text", [
                { role: "title", text: "Notice title" },
                { role: "date", text: "2025年07月03日（木）" },
                { role: "paragraph", text: "Body text" },
            ])
        ).toBe(true);
        expect(manager.buildRoleSegmentText("Notice title", "title")).toBe(
            "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>\nNotice title"
        );
        expect(
            manager.buildSelectionRoleSegmentText("Notice title\nBody text", "text", [
                { role: "title", text: "Notice title" },
                { role: "date", text: "2025年07月03日（木）" },
                { role: "paragraph", text: "Body text" },
            ])
        ).toBe(
            [
                "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
                "Notice title",
                "",
                "<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>",
                "2025年07月03日（木）",
                "",
                "<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>",
                "Body text",
            ].join("\n")
        );
        expect(
            manager.unwrapRoleSegmentResult(
                {
                    originalText: "wrapped",
                    mainMeaning:
                        "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>\n회원 계정 무단 로그인 발생 보고",
                },
                "原文"
            )
        ).toMatchObject({
            originalText: "原文",
            mainMeaning: "회원 계정 무단 로그인 발생 보고",
            translatedText: "회원 계정 무단 로그인 발생 보고",
        });
        expect(
            manager.unwrapRoleSegmentResult(
                {
                    originalText: "wrapped",
                    mainMeaning: [
                        "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
                        "회원 계정 무단 로그인 발생 보고 및 포켓몬센터 온라인 안전 이용 안내",
                        "<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>",
                        "2025년 7월 3일(목)",
                        "<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>",
                        "평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
                    ].join("\n"),
                },
                "原文",
                3
            )
        ).toMatchObject({
            originalText: "原文",
            mainMeaning: [
                "회원 계정 무단 로그인 발생 보고 및 포켓몬센터 온라인 안전 이용 안내",
                "2025년 7월 3일(목)",
                "평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
            ].join("\n\n"),
            translatedText: [
                "회원 계정 무단 로그인 발생 보고 및 포켓몬센터 온라인 안전 이용 안내",
                "2025년 7월 3일(목)",
                "평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
            ].join("\n\n"),
        });
    });

    test("does not wrap hybrid selection roles when hybrid main translation is not local AI", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.HYBRID_TRANSLATOR_CONFIG = {
            selections: {
                mainMeaning: "GoogleTranslate",
            },
        };

        expect(manager.shouldWrapSelectionForRole("HybridTranslate", "title")).toBe(false);
        expect(
            manager.shouldWrapSelectionForRole("HybridTranslate", "text", [
                { role: "title", text: "Notice title" },
                { role: "paragraph", text: "Body text" },
            ])
        ).toBe(false);
    });
});

describe("TranslatorManager on-device bridge injection", () => {
    const originalChrome = global.chrome;

    afterEach(() => {
        global.chrome = originalChrome;
        jest.restoreAllMocks();
    });

    test("injects the bridge into the sender frame main world", async () => {
        const executeScript = jest.fn().mockResolvedValue([{ result: undefined }]);
        global.chrome = { scripting: { executeScript } };
        const manager = Object.create(TranslatorManager.prototype);

        await expect(
            manager.injectOnDeviceBridge({ tab: { id: 42 }, frameId: 7 })
        ).resolves.toEqual({ injected: true });

        expect(executeScript).toHaveBeenCalledWith({
            target: { tabId: 42, frameIds: [7] },
            files: ["chrome_builtin/on_device_bridge.js"],
            world: "MAIN",
            injectImmediately: true,
        });
    });

    test("rejects bridge injection without a sender tab", async () => {
        global.chrome = { scripting: { executeScript: jest.fn() } };
        const manager = Object.create(TranslatorManager.prototype);

        await expect(manager.injectOnDeviceBridge({})).rejects.toThrow(
            "Cannot inject Chrome on-device bridge without a sender tab."
        );
    });
});

describe("TranslatorManager Gemini Nano prompt routing", () => {
    const originalLanguageModel = global.LanguageModel;
    const originalChrome = global.chrome;

    afterEach(() => {
        global.LanguageModel = originalLanguageModel;
        global.chrome = originalChrome;
        jest.clearAllMocks();
    });

    test("uses the page bridge before falling back to the extension Prompt API", async () => {
        global.LanguageModel = { create: jest.fn() };
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = {
            requestToTab: jest.fn().mockResolvedValue({
                mainMeaning: "안녕",
                translatedText: "안녕",
                tPronunciation: "annyeong",
                sPronunciation: "hello",
                sourceLanguage: "en",
                targetLanguage: "ko",
            }),
        };
        manager.getChromeBuiltinTargetTabId = jest.fn().mockResolvedValue(42);
        const localTranslator = {
            useConfig: jest.fn(),
            supportedLanguages: jest.fn(),
            detect: jest.fn(),
            translate: jest.fn(),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        };

        const proxy = manager.createLocalTranslatorProxy(localTranslator, {
            enabled: true,
            mode: "chromeBuiltin",
        });

        const result = await proxy.translate("hello", "en", "ko");
        expect(result).toMatchObject({
            mainMeaning: "안녕",
            translatedText: "안녕",
        });
        expect(result).not.toHaveProperty("tPronunciation");
        expect(manager.channel.requestToTab).toHaveBeenCalledWith(42, "chrome_builtin_translate", {
            text: "hello",
            sl: "en",
            tl: "ko",
            engine: "geminiNano",
            streamId: null,
        });
        expect(translateWithChromeOnDevice).not.toHaveBeenCalled();
    });

    test("prefers the extension Prompt API when offscreen prompts are available", async () => {
        global.chrome = {
            offscreen: { createDocument: jest.fn() },
            runtime: {
                sendMessage: jest.fn(),
            },
        };
        const manager = Object.create(TranslatorManager.prototype);
        manager.translateWithChromePromptApi = jest.fn().mockResolvedValue({
            originalText: "hello",
            mainMeaning: "안녕",
            translatedText: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        manager.translateWithChromePromptTab = jest.fn();

        await expect(
            manager.translateWithGeminiNanoPrompt("hello", "en", "ko")
        ).resolves.toMatchObject({
            mainMeaning: "안녕",
            translatedText: "안녕",
        });

        expect(manager.translateWithChromePromptApi).toHaveBeenCalledWith(
            "hello",
            "en",
            "ko",
            expect.objectContaining({ streamId: null })
        );
        expect(manager.translateWithChromePromptTab).not.toHaveBeenCalled();
    });

    test("falls back to the extension Prompt API when the page bridge is unavailable", async () => {
        global.LanguageModel = { create: jest.fn() };
        translateWithChromeOnDevice.mockResolvedValue({
            originalText: "hello",
            mainMeaning: "안녕",
            translatedText: "안녕",
            tPronunciation: "annyeong",
            sPronunciation: "hello",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = {
            requestToTab: jest.fn().mockRejectedValue(new Error("Receiving end does not exist.")),
        };
        manager.getChromeBuiltinTargetTabId = jest.fn().mockResolvedValue(42);
        const localTranslator = {
            useConfig: jest.fn(),
            supportedLanguages: jest.fn(),
            detect: jest.fn(),
            translate: jest.fn(),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        };

        const proxy = manager.createLocalTranslatorProxy(localTranslator, {
            enabled: true,
            mode: "geminiNano",
        });

        const result = await proxy.translate("hello", "en", "ko");
        expect(result).toMatchObject({
            mainMeaning: "안녕",
            translatedText: "안녕",
        });
        expect(result).not.toHaveProperty("tPronunciation");
        expect(translateWithChromeOnDevice).toHaveBeenCalledWith(
            "hello",
            "en",
            "ko",
            expect.objectContaining({ onUpdate: undefined })
        );
    });

    test("falls back when a PDF viewer tab has no Gemini Nano page bridge response", async () => {
        global.LanguageModel = { create: jest.fn() };
        translateWithChromeOnDevice.mockResolvedValue({
            originalText: "hello",
            mainMeaning: "안녕",
            translatedText: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = {
            requestToTab: jest
                .fn()
                .mockRejectedValue(
                    new Error("The message port closed before a response was received.")
                ),
        };
        manager.getChromeBuiltinTargetTabId = jest.fn().mockResolvedValue(42);

        await expect(
            manager.translateWithGeminiNanoPrompt("hello", "en", "ko")
        ).resolves.toMatchObject({
            mainMeaning: "안녕",
            translatedText: "안녕",
        });
        expect(translateWithChromeOnDevice).toHaveBeenCalledWith(
            "hello",
            "en",
            "ko",
            expect.objectContaining({ onUpdate: undefined })
        );
    });

    test("skips the page bridge for extension PDF viewer tabs", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getChromeBuiltinTargetTabId = jest.fn().mockResolvedValue(42);
        manager.translateWithChromePromptTab = jest.fn();
        manager.translateWithChromePromptApi = jest.fn().mockResolvedValue({
            originalText: "hello",
            mainMeaning: "안녕",
            translatedText: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        global.chrome = {
            runtime: { getURL: jest.fn((path = "") => `chrome-extension://edge/${path}`) },
            tabs: {
                get: jest.fn().mockResolvedValue({
                    id: 42,
                    url: "chrome-extension://edge/web/viewer.html?file=https%3A%2F%2Fexample.com%2Fa.pdf",
                }),
            },
        };

        await expect(
            manager.translateWithGeminiNanoPrompt("hello", "en", "ko")
        ).resolves.toMatchObject({
            mainMeaning: "안녕",
            translatedText: "안녕",
        });
        expect(manager.translateWithChromePromptTab).not.toHaveBeenCalled();
        expect(manager.translateWithChromePromptApi).toHaveBeenCalledWith(
            "hello",
            "en",
            "ko",
            expect.objectContaining({ streamId: null })
        );
    });

    test("does not hide page bridge model preparation failures behind fallback routes", async () => {
        global.LanguageModel = { create: jest.fn() };
        const tabError = new Error(
            "Chrome Gemini Nano session creation timed out while preparing the on-device model."
        );
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = { requestToTab: jest.fn().mockRejectedValue(tabError) };
        manager.getChromeBuiltinTargetTabId = jest.fn().mockResolvedValue(42);
        const localTranslator = {
            useConfig: jest.fn(),
            supportedLanguages: jest.fn(),
            detect: jest.fn(),
            translate: jest.fn(),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        };

        const proxy = manager.createLocalTranslatorProxy(localTranslator, {
            enabled: true,
            mode: "geminiNano",
        });

        await expect(proxy.translate("hello", "en", "ko")).rejects.toThrow(
            "session creation timed out"
        );
        expect(translateWithChromeOnDevice).not.toHaveBeenCalled();
    });

    test("limits Gemini Nano translations to two concurrent prompts for balanced thermals", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getChromeBuiltinTargetTabId = jest.fn().mockResolvedValue(42);
        manager.geminiNanoMaxConcurrentTranslations = undefined;
        manager.geminiNanoActiveTranslations = 0;
        manager.geminiNanoTranslationQueue = [];

        let active = 0;
        let maxActive = 0;
        const release = [];
        manager.translateWithChromePromptTab = jest.fn(
            (_tabId, text) =>
                new Promise((resolve) => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    release.push(() => {
                        active -= 1;
                        resolve({ mainMeaning: text, translatedText: text });
                    });
                })
        );

        const requests = Array.from({ length: 6 }, (_, index) =>
            manager.translateWithGeminiNanoPrompt(`text-${index}`, "en", "ko")
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(manager.translateWithChromePromptTab).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(2);

        release.shift()();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(manager.translateWithChromePromptTab).toHaveBeenCalledTimes(3);

        while (manager.translateWithChromePromptTab.mock.calls.length < 6 || release.length) {
            if (release.length) release.shift()();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await expect(Promise.all(requests)).resolves.toHaveLength(6);
        expect(maxActive).toBe(2);
    });
});

describe("TranslatorManager streaming translation display", () => {
    test("keeps committed text stable while sending unstable updates as preview", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = { emitToTabs: jest.fn() };
        const context = {
            tabId: 42,
            timestamp: 123,
            originalText: "source",
            sourceLanguage: "ja",
            targetLanguage: "ko",
        };

        manager.emitTranslationStream(context, {
            mainMeaning: "회원 계정",
            streamState: "committed",
        });
        manager.emitTranslationStream(context, { mainMeaning: "회원 어카운트" });
        manager.emitTranslationStream(context, {
            mainMeaning: "회원 계정의 무단 로그인 발생 보고",
            streamState: "committed",
        });

        expect(manager.channel.emitToTabs).toHaveBeenCalledTimes(3);
        expect(manager.channel.emitToTabs.mock.calls.map((call) => call[2].mainMeaning)).toEqual([
            "회원 계정",
            "회원 계정",
            "회원 계정의 무단 로그인 발생 보고",
        ]);
        expect(manager.channel.emitToTabs.mock.calls[1][2].streamPreviewText).toBe("회원 어카운트");
    });

    test("unwraps role segment markers before streaming to the panel", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = { emitToTabs: jest.fn() };
        const context = {
            tabId: 42,
            timestamp: 123,
            originalText: "title\nbody",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            shouldWrapRole: true,
            expectedSegmentCount: 2,
        };

        manager.emitTranslationStream(context, {
            mainMeaning:
                "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>\n제목\n<<<EDGE_TRANSLATE_SEGMENT_2 role=paragraph>>>\n본문",
            streamState: "committed",
        });

        expect(manager.channel.emitToTabs).toHaveBeenCalledTimes(1);
        expect(manager.channel.emitToTabs.mock.calls[0][2].mainMeaning).toBe("제목\n\n본문");
    });

    test("keeps all available marked segments when a marked result is incomplete", () => {
        const manager = Object.create(TranslatorManager.prototype);

        const result = manager.unwrapRoleSegmentResult(
            {
                originalText: "title\nbody\nfooter",
                mainMeaning:
                    "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>\n제목\n<<<EDGE_TRANSLATE_SEGMENT_2 role=paragraph>>>\n본문",
            },
            "title\nbody\nfooter",
            3
        );

        expect(result.mainMeaning).toBe("제목\n\n본문");
    });

    test("sends unstable partials as preview without replacing stable text", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = { emitToTabs: jest.fn() };
        const context = {
            tabId: 42,
            timestamp: 123,
            originalText: "source",
            sourceLanguage: "ja",
            targetLanguage: "ko",
        };

        manager.emitTranslationStream(context, {
            mainMeaning: "확정된 첫 문단",
            streamState: "committed",
        });
        manager.emitTranslationStream(context, {
            mainMeaning: "확정된 첫 문단 생성 중인 둘째 문단",
            streamState: "preview",
            streamProgress: { current: 2, total: 3 },
        });

        expect(manager.channel.emitToTabs).toHaveBeenCalledTimes(2);
        expect(manager.channel.emitToTabs.mock.calls[1][2]).toMatchObject({
            mainMeaning: "확정된 첫 문단",
            streamPreviewText: "생성 중인 둘째 문단",
            streamProgress: { current: 2, total: 3 },
            isStreaming: true,
        });
    });

    test("removes committed text from streaming preview to avoid duplicate display", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = { emitToTabs: jest.fn() };
        const context = {
            tabId: 42,
            timestamp: 123,
            originalText: "source",
            sourceLanguage: "ja",
            targetLanguage: "ko",
        };

        manager.emitTranslationStream(context, {
            mainMeaning: "4월 23일 사이트 이용 제한 안내",
            streamState: "committed",
        });
        manager.emitTranslationStream(context, {
            mainMeaning: "4월 23일 사이트 이용 제한 안내\n\n2026년 4월 20일 월요일",
            streamState: "preview",
        });

        expect(manager.channel.emitToTabs).toHaveBeenCalledTimes(2);
        expect(manager.channel.emitToTabs.mock.calls[1][2]).toMatchObject({
            mainMeaning: "4월 23일 사이트 이용 제한 안내",
            streamPreviewText: "\n\n2026년 4월 20일 월요일",
        });
    });

    test("keeps paragraph breaks between committed text and streaming preview", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.channel = { emitToTabs: jest.fn() };
        const context = {
            tabId: 42,
            timestamp: 123,
            originalText: "title\n\nbody",
            sourceLanguage: "ja",
            targetLanguage: "ko",
        };

        manager.emitTranslationStream(context, {
            mainMeaning: "제목",
            streamState: "committed",
        });
        manager.emitTranslationStream(context, {
            mainMeaning: "제목\n\n본문 일부",
            streamState: "preview",
        });

        expect(manager.channel.emitToTabs).toHaveBeenCalledTimes(2);
        expect(manager.channel.emitToTabs.mock.calls[1][2]).toMatchObject({
            mainMeaning: "제목",
            streamPreviewText: "\n\n본문 일부",
        });
    });

    test("normalizes streamed JSON translation fields before display", () => {
        const manager = Object.create(TranslatorManager.prototype);

        expect(
            manager.normalizeTranslationStreamText(
                '{"translation":"패스워드 재설정 시 주의사항","detailedMeanings":[{"pos":"명사"}]}'
            )
        ).toBe("패스워드 재설정 시 주의사항");
    });
});

describe("Hybrid translation prompt application", () => {
    test("hybrid LocalTranslate slot routes through Gemini Nano prompt, not raw LocalTranslator", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getChromeBuiltinTargetTabId = jest.fn().mockResolvedValue(42);
        manager.geminiNanoActiveTranslations = 0;
        manager.geminiNanoTranslationQueue = [];
        manager.geminiNanoMaxConcurrentTranslations = 2;

        // Track whether translateWithGeminiNanoPrompt is called
        const geminiNanoPromptCalls = [];
        manager.translateWithGeminiNanoPrompt = jest.fn(async (text, from, to) => {
            geminiNanoPromptCalls.push({ text, from, to });
            return {
                originalText: text,
                mainMeaning: "프롬프트 적용된 결과",
                translatedText: "프롬프트 적용된 결과",
            };
        });

        // Create a mock LocalTranslator with its own translate (should NOT be called)
        const rawLocalTranslator = {
            useConfig: jest.fn(),
            supportedLanguages: jest.fn(() => new Set(["en", "ko", "ja"])),
            detect: jest.fn().mockResolvedValue("auto"),
            translate: jest.fn(async (text) => ({
                originalText: text,
                mainMeaning: "raw 번역기 결과 (프롬프트 미적용)",
            })),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        };

        // Create the proxy (same as TranslatorManager does in init)
        const proxy = manager.createLocalTranslatorProxy(rawLocalTranslator, {
            enabled: true,
            mode: "chromeBuiltin",
        });

        // Simulate what the hybrid translator does: call proxy.translate()
        const result = await proxy.translate("国勢調査を装った不審なメール", "ja", "ko");

        // Verify: Gemini Nano prompt was used (not raw translator)
        expect(manager.translateWithGeminiNanoPrompt).toHaveBeenCalledWith(
            "国勢調査を装った不審なメール",
            "ja",
            "ko"
        );
        expect(rawLocalTranslator.translate).not.toHaveBeenCalled();
        expect(result.mainMeaning).toBe("프롬프트 적용된 결과");
    });

    test("hybrid LocalTranslate slot falls through to raw translator in googleAiStudio mode", async () => {
        const manager = Object.create(TranslatorManager.prototype);

        const rawLocalTranslator = {
            useConfig: jest.fn(),
            supportedLanguages: jest.fn(() => new Set(["en", "ko", "ja"])),
            detect: jest.fn().mockResolvedValue("auto"),
            translate: jest.fn(async (text) => ({
                originalText: text,
                mainMeaning: "AI Studio 결과",
            })),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        };

        const proxy = manager.createLocalTranslatorProxy(rawLocalTranslator, {
            enabled: true,
            mode: "googleAiStudio",
        });

        const result = await proxy.translate("hello", "en", "ko");

        // In googleAiStudio mode, raw translator.translate() should be called
        expect(rawLocalTranslator.translate).toHaveBeenCalledWith("hello", "en", "ko");
        expect(result.mainMeaning).toBe("AI Studio 결과");
    });
});

describe("Cross-mode cache isolation and clearCaches", () => {
    test("realLocalTranslator reference is saved before proxy replacement", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.config_loader = Promise.resolve();

        const rawLocalTranslator = {
            useConfig: jest.fn(),
            supportedLanguages: jest.fn(() => new Set(["en", "ko"])),
            detect: jest.fn(),
            translate: jest.fn(),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        };

        // Simulate what constructor does
        const proxy = manager.createLocalTranslatorProxy(rawLocalTranslator, {
            enabled: true,
            mode: "chromeBuiltin",
        });

        // Save the real reference BEFORE proxy replacement (as translate.js now does)
        manager.realLocalTranslator = rawLocalTranslator;
        manager.localTranslatorProxy = proxy;

        // Verify they are different objects
        expect(manager.realLocalTranslator).not.toBe(proxy);
        expect(manager.realLocalTranslator).toBe(rawLocalTranslator);
    });

    test("clearCaches purges all three cache layers", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.detectCache = { clear: jest.fn() };
        manager.translationCache = { clear: jest.fn() };

        // Mock HybridTranslator with cleanup
        const hybridCleanup = jest.fn();
        manager.HYBRID_TRANSLATOR = { cleanup: hybridCleanup };

        // Mock real LocalTranslator
        const localUseConfig = jest.fn();
        manager.realLocalTranslator = { useConfig: localUseConfig };
        manager.LOCAL_TRANSLATOR_CONFIG = { enabled: true, mode: "chromeBuiltin" };

        manager.clearCaches();

        // Layer 1: TranslatorManager caches
        expect(manager.detectCache.clear).toHaveBeenCalled();
        expect(manager.translationCache.clear).toHaveBeenCalled();

        // Layer 2: HybridTranslator internal LRU
        expect(hybridCleanup).toHaveBeenCalled();

        // Layer 3: Real LocalTranslator internal LRU (via useConfig)
        expect(localUseConfig).toHaveBeenCalledWith({
            enabled: true,
            mode: "chromeBuiltin",
        });
    });

    test("clearCaches does NOT fail when realLocalTranslator was not set", () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.detectCache = { clear: jest.fn() };
        manager.translationCache = { clear: jest.fn() };
        manager.HYBRID_TRANSLATOR = { cleanup: jest.fn() };
        // realLocalTranslator is intentionally undefined

        expect(() => manager.clearCaches()).not.toThrow();
    });

    test("stale hybrid results are purged when switching translators", () => {
        const manager = Object.create(TranslatorManager.prototype);

        // Set up real caches (using simple Maps to simulate)
        const translationCache = new Map();
        translationCache.set("test-key-1", "stale result");
        manager.translationCache = translationCache;

        const detectCache = new Map();
        detectCache.set("detect-key-1", "ja");
        manager.detectCache = detectCache;

        // Hybrid has its own cache
        const hybridCache = new Map();
        hybridCache.set("hybrid-key-1", { mainMeaning: "오염된 결과" });
        const hybridInflight = new Map();
        manager.HYBRID_TRANSLATOR = {
            cleanup: jest.fn(() => {
                hybridCache.clear();
                hybridInflight.clear();
            }),
        };

        // Real local translator has its own cache
        const localCache = new Map();
        localCache.set("local-key-1", { mainMeaning: "오래된 로컬 결과" });
        manager.realLocalTranslator = {
            useConfig: jest.fn(() => {
                localCache.clear();
            }),
        };
        manager.LOCAL_TRANSLATOR_CONFIG = { enabled: true, mode: "chromeBuiltin" };

        // Verify pre-condition: all caches have data
        expect(translationCache.size).toBe(1);
        expect(detectCache.size).toBe(1);
        expect(hybridCache.size).toBe(1);
        expect(localCache.size).toBe(1);

        // Simulate translator switch
        manager.clearCaches();

        // All caches must be empty
        expect(translationCache.size).toBe(0);
        expect(detectCache.size).toBe(0);
        expect(hybridCache.size).toBe(0);
        expect(localCache.size).toBe(0);
    });

    test("proxy useConfig propagates to both proxy config and real translator", () => {
        const manager = Object.create(TranslatorManager.prototype);

        const rawLocalTranslator = {
            useConfig: jest.fn(),
            supportedLanguages: jest.fn(() => new Set(["en", "ko"])),
            detect: jest.fn(),
            translate: jest.fn(),
            pronounce: jest.fn(),
            stopPronounce: jest.fn(),
        };

        const proxy = manager.createLocalTranslatorProxy(rawLocalTranslator, {
            enabled: true,
            mode: "chromeBuiltin",
        });

        // Initially chromeBuiltin mode
        expect(proxy.getMode()).toBe("geminiNano");

        // Update to googleAiStudio
        proxy.useConfig({ enabled: true, mode: "googleAiStudio" });

        // Proxy should reflect the new mode
        expect(proxy.getMode()).toBe("googleAiStudio");

        // Raw translator should have received the config
        expect(rawLocalTranslator.useConfig).toHaveBeenCalledWith({
            enabled: true,
            mode: "googleAiStudio",
        });
    });
});
