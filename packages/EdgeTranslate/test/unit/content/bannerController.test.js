jest.mock("common/scripts/channel.js", () => {
    return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        provide: jest.fn(),
        request: jest.fn(),
    }));
});

jest.mock("common/scripts/settings.js", () => ({
    DEFAULT_SETTINGS: {},
    getOrSetDefaultSettings: jest.fn(() => Promise.resolve({ HidePageTranslatorBanner: false })),
}));

jest.mock("common/scripts/chrome_builtin_translate.js", () => ({
    toChromeTranslatorLanguage: jest.fn((language) => language || "auto"),
    translateWithChromeOnDevice: jest.fn(),
}));

import { getOrSetDefaultSettings } from "common/scripts/settings.js";
import { BannerController } from "../../../src/content/banner_controller.js";

describe("DOM page translation banner", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        document.body.removeAttribute("style");
        getOrSetDefaultSettings.mockResolvedValue({ HidePageTranslatorBanner: false });
        global.requestAnimationFrame = (callback) => {
            callback();
            return 1;
        };
        global.cancelAnimationFrame = jest.fn();
        chrome.storage.sync.set.mockClear();
    });

    it("shows a Google-like top banner for Local page translation progress", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "localEndpoint", sl: "en", tl: "ko" };
        controller.showDomPageBanner();
        await Promise.resolve();

        const banner = document.getElementById("edge-translate-dom-page-banner");
        expect(banner).not.toBeNull();
        expect(banner.shadowRoot.textContent).toContain("Edge Translate");
        expect(banner.shadowRoot.textContent).toContain("Local page translation is starting");
        expect(document.body.style.getPropertyValue("top")).toBe("40px");

        controller._domTotalTranslationEntries = 3;
        controller.markDomPageTranslationEntriesCompleted(2);
        expect(banner.shadowRoot.textContent).toContain("Local page translation 2/3");
    });

    it("can hide and cancel the DOM page translation banner", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller.currentTranslator = "dom";
        controller.showDomPageBanner();
        await Promise.resolve();

        controller.toggleBanner();
        await Promise.resolve();
        const banner = document.getElementById("edge-translate-dom-page-banner");
        expect(banner.style.display).toBe("none");
        expect(chrome.storage.sync.set).toHaveBeenCalledWith({ HidePageTranslatorBanner: true });

        controller.cancelDomPageTranslate();
        expect(document.getElementById("edge-translate-dom-page-banner")).toBeNull();
        expect(controller.currentTranslator).toBeNull();
        expect(document.body.style.getPropertyValue("top")).toBe("0px");
    });
});
