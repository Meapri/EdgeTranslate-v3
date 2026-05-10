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
        });
        expect(translateWithChromeOnDevice).not.toHaveBeenCalled();
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
        expect(translateWithChromeOnDevice).toHaveBeenCalledWith("hello", "en", "ko");
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
        expect(translateWithChromeOnDevice).toHaveBeenCalledWith("hello", "en", "ko");
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
        expect(manager.translateWithChromePromptApi).toHaveBeenCalledWith("hello", "en", "ko");
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
