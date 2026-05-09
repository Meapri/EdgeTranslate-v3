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

    it("shows a Google-like top banner for AI page translation progress", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "geminiNano", sl: "en", tl: "ko" };
        controller.showDomPageBanner();
        await Promise.resolve();

        const banner = document.getElementById("edge-translate-dom-page-banner");
        expect(banner).not.toBeNull();
        expect(banner.shadowRoot.textContent).toContain("Edge Translate");
        expect(banner.shadowRoot.textContent).toContain("Gemini Nano page translation is starting");
        expect(document.body.style.getPropertyValue("top")).toBe("40px");

        controller._domTotalTranslationEntries = 3;
        controller.markDomPageTranslationEntriesCompleted(2);
        expect(banner.shadowRoot.textContent).toContain("Gemini Nano page translation 2/3");
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

    it("uses segmented batch jobs for Gemini Nano page translation", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "geminiNano", sl: "en", tl: "ko" };
        controller._domMaxConcurrentTranslations = 4;
        const entries = Array.from({ length: 21 }, (_, index) => ({
            sourceText: `Paragraph ${index + 1}.`,
        }));

        expect(controller._domMaxConcurrentTranslations).toBe(4);
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 9000, maxItems: 14 });
        expect(controller.buildDomPageTranslationBatches(entries)).toHaveLength(2);
        controller.recordDomPageBatchFailure();
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 7000, maxItems: 8 });
        controller.recordDomPageBatchFailure();
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 5000, maxItems: 6 });
    });

    it("prioritizes article viewport text before deferred page text", () => {
        document.body.innerHTML = `
            <nav>Skip navigation text</nav>
            <article>
                <p id="visible">Visible article text</p>
                <p id="deferred">Deferred article text</p>
            </article>
        `;
        document.getElementById("visible").getBoundingClientRect = () => ({
            top: 50,
            bottom: 80,
            width: 200,
            height: 30,
        });
        document.getElementById("deferred").getBoundingClientRect = () => ({
            top: 5000,
            bottom: 5030,
            width: 200,
            height: 30,
        });

        const controller = new BannerController();
        controller._domPageRootElements = controller.getDomPageTranslationRoots();
        const nodes = controller.collectDomPageTextNodes(controller._domPageRootElements);
        const { immediate, deferred } = controller.partitionDomPageTextNodes(nodes);

        expect(controller._domPageRootElements[0].tagName).toBe("ARTICLE");
        expect(nodes.map((node) => node.nodeValue.trim())).toEqual([
            "Visible article text",
            "Deferred article text",
        ]);
        expect(immediate.map((node) => node.nodeValue.trim())).toEqual(["Visible article text"]);
        expect(deferred.map((node) => node.nodeValue.trim())).toEqual(["Deferred article text"]);
    });
});
