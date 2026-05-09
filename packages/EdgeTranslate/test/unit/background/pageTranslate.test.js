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

    it("migrates Chrome built-in page translation to Google page translation", async () => {
        getOrSetDefaultSettings.mockResolvedValue({
            DefaultPageTranslator: "ChromeBuiltinPageTranslate",
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: {},
        });
        const channel = { emitToTabs: jest.fn() };
        chrome.tabs.query.mockImplementation((query, callback) => callback([{ id: 42 }]));
        chrome.scripting = { executeScript: jest.fn().mockResolvedValue(undefined) };

        translatePage(channel);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.emitToTabs).toHaveBeenCalledWith(42, "start_page_translate", {
            translator: "google",
        });
        expect(channel.emitToTabs).not.toHaveBeenCalledWith(
            42,
            "start_dom_page_translate",
            expect.anything()
        );
    });

    it("runs only Google page translation when Google is selected", async () => {
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

    it("migrates legacy Local page translation to Google page translation", async () => {
        getOrSetDefaultSettings.mockResolvedValue({
            DefaultPageTranslator: "LocalPageTranslate",
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: { enabled: true, mode: "chromeBuiltin" },
        });
        const channel = { emitToTabs: jest.fn() };
        chrome.tabs.query.mockImplementation((query, callback) => callback([{ id: 42 }]));
        chrome.scripting = { executeScript: jest.fn().mockResolvedValue(undefined) };

        translatePage(channel);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(channel.emitToTabs).toHaveBeenCalledWith(42, "start_page_translate", {
            translator: "google",
        });
        expect(channel.emitToTabs).not.toHaveBeenCalledWith(
            42,
            "start_dom_page_translate",
            expect.anything()
        );
    });
});
