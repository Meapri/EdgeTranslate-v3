import { translatePage, executeGoogleScript } from "../../../src/background/library/pageTranslate.js";
import { getOrSetDefaultSettings } from "common/scripts/settings.js";

jest.mock("common/scripts/settings.js", () => ({
    DEFAULT_SETTINGS: {},
    getOrSetDefaultSettings: jest.fn(),
}));

describe("pageTranslate module", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        global.FEATURE_FLAGS = { pageTranslate: true };
    });

    it("exports page translation entry points", () => {
        expect(typeof translatePage).toBe("function");
        expect(typeof executeGoogleScript).toBe("function");
    });

    it("uses the Google AI Studio DOM engine for Local page translation when API mode is configured", async () => {
        getOrSetDefaultSettings.mockResolvedValue({
            DefaultPageTranslator: "LocalPageTranslate",
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: { enabled: true, mode: "googleAiStudio" },
        });
        const channel = { emitToTabs: jest.fn() };
        chrome.tabs.query.mockImplementation((query, callback) => callback([{ id: 42 }]));

        translatePage(channel);
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.emitToTabs).toHaveBeenCalledWith(42, "start_dom_page_translate", {
            engine: "googleAiStudio",
            sl: "en",
            tl: "ko",
        });
    });

    it("routes Chrome built-in page translation through Gemini Nano", async () => {
        getOrSetDefaultSettings.mockResolvedValue({
            DefaultPageTranslator: "ChromeBuiltinPageTranslate",
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: {},
        });
        const channel = { emitToTabs: jest.fn() };
        chrome.tabs.query.mockImplementation((query, callback) => callback([{ id: 42 }]));

        translatePage(channel);
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.emitToTabs).toHaveBeenCalledWith(42, "start_dom_page_translate", {
            engine: "geminiNano",
            sl: "en",
            tl: "ko",
        });
    });
});
