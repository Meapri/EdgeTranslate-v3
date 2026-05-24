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
        controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
        controller.showDomPageBanner();
        await Promise.resolve();

        const banner = document.getElementById("edge-translate-dom-page-banner");
        expect(banner).not.toBeNull();
        expect(banner.shadowRoot.textContent).toContain("Edge Translate");
        expect(banner.shadowRoot.querySelector("[data-role='engine-label']").textContent).toBe(
            "OpenAI"
        );
        expect(banner.shadowRoot.querySelector(".provider-logo-chatgpt")).not.toBeNull();
        expect(banner.shadowRoot.querySelector("[data-role='bar']").dataset.state).toBe(
            "starting"
        );
        expect(banner.shadowRoot.textContent).toContain("OpenAI page translation is starting");
        expect(document.body.style.getPropertyValue("top")).toBe("46px");

        controller._domTotalTranslationEntries = 3;
        controller.markDomPageTranslationEntriesCompleted(2);
        expect(banner.shadowRoot.textContent).toContain("OpenAI page translation 2/3");
        expect(banner.shadowRoot.querySelector("[data-role='progress-meta']").textContent).toBe(
            "67%"
        );
        expect(banner.shadowRoot.querySelector("[data-role='progress-fill']").style.width).toBe(
            "67%"
        );
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

    it("uses segmented batch jobs for AI page translation", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domMaxConcurrentTranslations = 16;
        const entries = Array.from({ length: 21 }, (_, index) => ({
            sourceText: `Paragraph ${index + 1}.`,
        }));

        expect(controller._domMaxConcurrentTranslations).toBe(16);
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 16000, maxItems: 32 });
        expect(controller.buildDomPageTranslationBatches(entries)).toHaveLength(1);
        expect(controller.getDomPageBatchOptions({ fastLane: true })).toEqual({
            maxChars: 4000,
            maxItems: 6,
        });
        expect(controller.buildDomPageTranslationBatches(entries, { fastLane: true })).toHaveLength(
            4
        );
        controller.recordDomPageBatchFailure();
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 7000, maxItems: 8 });
        expect(controller.getDomPageBatchOptions({ fastLane: true })).toEqual({
            maxChars: 3500,
            maxItems: 5,
        });
        controller.recordDomPageBatchFailure();
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 5000, maxItems: 6 });
        expect(controller.getDomPageBatchOptions({ fastLane: true })).toEqual({
            maxChars: 3000,
            maxItems: 4,
        });
    });

    it("wraps single AI page translation fallbacks with DOM role metadata", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
        const group = {
            role: "title",
            sourceText: "「会員アカウント」に対する不正ログインの発生のご報告",
            nodes: [],
            texts: [],
        };
        const entry = controller.createDomPageTranslationEntry(group);

        expect(controller.buildDomPageRoleSegmentText(entry)).toBe(
            [
                "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
                "「会員アカウント」に対する不正ログインの発生のご報告",
            ].join("\n")
        );
        expect(
            controller.unwrapDomPageRoleSegmentText(
                [
                    "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
                    "회원 계정 무단 로그인 발생 보고",
                ].join("\n"),
                1
            )
        ).toBe("회원 계정 무단 로그인 발생 보고");
    });

    it("shows original text tooltip for AI page translated content", () => {
        document.body.innerHTML = `<p id="line">Original sentence.</p>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const node = document.getElementById("line").firstChild;
        const entry = controller.createDomPageTranslationEntry({
            role: "text",
            sourceText: "Original sentence.",
            nodes: [node],
            texts: ["Original sentence."],
        });

        expect(controller.applyDomPageTranslatedEntry(entry, "번역된 문장.")).toBe(true);
        const paragraph = document.getElementById("line");
        expect(paragraph.textContent).toBe("번역된 문장.");
        expect(paragraph.classList.contains("et-dom-original-source")).toBe(true);

        paragraph.dispatchEvent(
            new MouseEvent("mouseover", {
                bubbles: true,
                clientX: 120,
                clientY: 160,
            })
        );
        const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
        expect(tooltip).not.toBeNull();
        expect(tooltip.dataset.visible).toBe("true");
        expect(tooltip.textContent).toContain("원문 텍스트");
        expect(tooltip.textContent).toContain("Original sentence.");

        controller.cancelDomPageTranslate();
        expect(document.getElementById("edge-translate-dom-original-tooltip")).toBeNull();
    });

    it("prioritizes article viewport text before deferred page text", () => {
        document.body.innerHTML = `
            <nav>Skip navigation text</nav>
            <article>
                <p id="visible">Visible article text</p>
                <p id="deferred">Deferred article text</p>
            </article>
        `;
        document.querySelector("nav").getBoundingClientRect = () => ({
            top: 20,
            bottom: 40,
            width: 200,
            height: 20,
        });
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
        controller._domPageTranslateOptions = { engine: "googleAiStudio" };
        controller._domPageRootElements = controller.getDomPageTranslationRoots();
        const nodes = controller.collectDomPageTextNodes(controller._domPageRootElements);
        const { immediate, deferred } = controller.partitionDomPageTextNodes(nodes);

        expect(controller._domPageRootElements[0].tagName).toBe("BODY");
        expect(nodes.map((node) => node.nodeValue.trim())).toEqual([
            "Skip navigation text",
            "Visible article text",
            "Deferred article text",
        ]);
        expect(immediate.map((node) => node.nodeValue.trim())).toEqual([
            "Skip navigation text",
            "Visible article text",
        ]);
        expect(deferred.map((node) => node.nodeValue.trim())).toEqual(["Deferred article text"]);
    });
});
