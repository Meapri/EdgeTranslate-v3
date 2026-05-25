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

    it("keeps Google page translation when Google is selected", async () => {
        getOrSetDefaultSettings.mockResolvedValue({
            DefaultPageTranslator: "GooglePageTranslate",
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: {},
        });
        const channel = { emitToTabs: jest.fn() };
        chrome.tabs.query.mockImplementation((query, callback) => callback([{ id: 42 }]));
        chrome.scripting = { executeScript: jest.fn() };
        chrome.scripting.executeScript.mockResolvedValue(undefined);

        translatePage(channel);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.emitToTabs).toHaveBeenCalledTimes(1);
        expect(channel.emitToTabs).toHaveBeenCalledWith(42, "start_page_translate", {
            translator: "google",
        });
        expect(channel.emitToTabs).not.toHaveBeenCalledWith(
            42,
            "start_dom_page_translate",
            expect.anything()
        );
    });

    it("runs OpenAI AI page translation when AI page translation is selected", async () => {
        getOrSetDefaultSettings.mockResolvedValue({
            DefaultPageTranslator: "AIPageTranslate",
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: { enabled: true, mode: "openai", openaiModel: "gpt-5.4-mini" },
        });
        const channel = { emitToTabs: jest.fn() };
        chrome.tabs.query.mockImplementation((query, callback) => callback([{ id: 42 }]));

        translatePage(channel);
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.emitToTabs).toHaveBeenCalledTimes(1);
        expect(channel.emitToTabs).toHaveBeenCalledWith(42, "start_dom_page_translate", {
            engine: "openai",
            model: "gpt-5.4-mini",
            translatorId: "LocalTranslate",
            sl: "en",
            tl: "ko",
        });
    });

    it("routes legacy AI page translation values to the new AI page translator", async () => {
        getOrSetDefaultSettings.mockResolvedValue({
            DefaultPageTranslator: "LocalPageTranslate",
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: {
                enabled: true,
                mode: "googleAiStudio",
                model: "gemini-2.5-flash-lite",
            },
        });
        const channel = { emitToTabs: jest.fn() };
        chrome.tabs.query.mockImplementation((query, callback) => callback([{ id: 42 }]));

        translatePage(channel);
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.emitToTabs).toHaveBeenCalledWith(42, "start_dom_page_translate", {
            engine: "googleAiStudio",
            model: "gemini-2.5-flash-lite",
            translatorId: "LocalTranslate",
            sl: "en",
            tl: "ko",
        });
    });
});
