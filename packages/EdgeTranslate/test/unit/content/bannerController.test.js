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
        delete window.ytInitialPlayerResponse;
        delete window.__edgeTranslateCaptionDebug;
        delete window.__edgeTranslateCaptionDebugEvents;
        localStorage.clear();
        global.fetch = undefined;
        document.getElementById("edge-translate-realtime-caption")?.remove();
        document.body.removeAttribute("style");
        getOrSetDefaultSettings.mockResolvedValue({ HidePageTranslatorBanner: false });
        global.requestAnimationFrame = (callback) => {
            callback();
            return 1;
        };
        global.cancelAnimationFrame = jest.fn();
        chrome.storage.sync.set.mockClear();
    });

    it("shows a compact Material-style top banner for AI page translation progress", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.4-mini",
            sl: "en",
            tl: "ko",
        };
        controller.currentTranslator = "dom";
        controller.showDomPageBanner();
        await Promise.resolve();

        const banner = document.getElementById("edge-translate-dom-page-banner");
        expect(banner).not.toBeNull();
        expect(banner.shadowRoot.querySelector("[data-role='title']").textContent).toContain(
            "Page Translation"
        );
        expect(banner.shadowRoot.querySelector("[data-role='engine-label']").textContent).toBe(
            "OpenAI"
        );
        expect(banner.shadowRoot.querySelector("[data-role='model']").textContent).toBe(
            "gpt-5.4-mini"
        );
        expect(banner.shadowRoot.querySelector(".provider-logo-chatgpt").src).toContain(
            "brand/chatgpt.svg"
        );
        expect(banner.shadowRoot.querySelector("[data-role='bar']").dataset.state).toBe("starting");
        expect(banner.shadowRoot.querySelector("[data-role='status']").textContent).toContain(
            "Preparing page text"
        );
        expect(document.body.style.getPropertyValue("top")).toBe("84px");

        controller._domTotalTranslationEntries = 3;
        controller.recordDomPageTokenUsage({
            tokenUsage: {
                inputTokens: 1200,
                outputTokens: 300,
                reasoningTokens: 50,
                totalTokens: 1550,
            },
        });
        controller.markDomPageTranslationEntriesCompleted(2);
        expect(banner.shadowRoot.textContent).toContain("2 of 3 translated");
        expect(banner.shadowRoot.querySelector("[data-role='token-meta']").textContent).toBe(
            "1.6K tokens (in 1.2K / out 300 / think 50)"
        );
        expect(banner.shadowRoot.querySelector("[data-role='progress-meta']").textContent).toBe(
            "67%"
        );
        expect(banner.shadowRoot.querySelector("[data-role='progress-fill']").style.width).toBe(
            "67%"
        );
    });

    it("shows complete while the final coverage pass runs in the background", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.4-mini",
            sl: "en",
            tl: "ko",
        };
        controller.currentTranslator = "dom";
        controller.showDomPageBanner();
        await Promise.resolve();

        const banner = document.getElementById("edge-translate-dom-page-banner");
        const refs = banner.shadowRoot;

        controller._domTotalTranslationEntries = 2;
        controller.markDomPageTranslationEntriesCompleted(2);

        expect(refs.querySelector("[data-role='bar']").dataset.state).toBe("complete");
        expect(refs.querySelector("[data-role='status']").textContent).toBe(
            "Translation complete"
        );
        expect(refs.querySelector("[data-role='progress-meta']").textContent).toBe("100%");

        controller._domCoverageStableScanCount = 1;
        controller.updateDomPageBannerStatus();

        expect(refs.querySelector("[data-role='bar']").dataset.state).toBe("complete");
        expect(refs.querySelector("[data-role='status']").textContent).toBe(
            "Translation complete"
        );
    });

    it("shows complete when bounded coverage scans are exhausted after all requests finish", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.4-mini",
            sl: "en",
            tl: "ko",
        };
        controller.currentTranslator = "dom";
        controller.showDomPageBanner();
        await Promise.resolve();

        const banner = document.getElementById("edge-translate-dom-page-banner");
        const refs = banner.shadowRoot;

        controller._domTotalTranslationEntries = 3;
        controller.markDomPageTranslationEntriesCompleted(3);
        controller._domCoverageScanCount = 2;

        controller.scheduleDomPageCoverageScan();

        expect(refs.querySelector("[data-role='bar']").dataset.state).toBe("complete");
        expect(refs.querySelector("[data-role='status']").textContent).toBe(
            "Translation complete"
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
        expect(banner.dataset.visible).toBe("false");
        expect(banner.style.height).toBe("0px");
        expect(document.body.style.getPropertyValue("top")).toBe("0px");
        expect(chrome.storage.sync.set).not.toHaveBeenCalledWith({
            HidePageTranslatorBanner: true,
        });

        banner.shadowRoot.querySelector("[data-action='show']").click();
        expect(banner.dataset.visible).toBe("true");
        expect(document.body.style.getPropertyValue("top")).toBe("84px");

        controller.cancelDomPageTranslate();
        expect(document.getElementById("edge-translate-dom-page-banner")).toBeNull();
        expect(controller.currentTranslator).toBeNull();
        expect(document.body.style.getPropertyValue("top")).toBe("0px");
    });

    it("uses segmented batch jobs for AI page translation", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domMaxConcurrentTranslations = 32;
        const entries = Array.from({ length: 21 }, (_, index) => ({
            sourceText: `Paragraph ${index + 1}.`,
        }));

        expect(controller._domMaxConcurrentTranslations).toBe(32);
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 12000, maxItems: 64 });
        expect(controller.getDomPageLeadBatchOptions()).toBeNull();
        expect(
            controller.buildDomPageTranslationBatches(entries).map((batch) => batch.length)
        ).toEqual([21]);
        controller.recordDomPageBatchFailure();
        expect(controller._domMaxConcurrentTranslations).toBe(12);
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 7000, maxItems: 32 });
        expect(controller.getDomPageLeadBatchOptions()).toBeNull();
        controller.recordDomPageBatchFailure();
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 4000, maxItems: 6 });
        controller.recordDomPageBatchFailure();
        expect(controller._domMaxConcurrentTranslations).toBe(6);
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 1800, maxItems: 1 });
    });

    it("marks quiet AI page translation requests with the page profile", async () => {
        const controller = new BannerController();
        controller.channel.request = jest.fn().mockResolvedValue({
            mainMeaning: "[[1:p]]\n번역된 문장입니다.",
        });
        controller._domPageTranslateOptions = {
            engine: "openaiCompatible",
            model: "local-model",
            sl: "en",
            tl: "ko",
        };

        await controller.translateWithDomPageEngine("[[1:p]]\nOriginal sentence.", "en", "ko");

        expect(controller.channel.request).toHaveBeenCalledWith("translate_text_quiet", {
            text: "[[1:p]]\nOriginal sentence.",
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openaiCompatible",
            translationProfile: "page",
        });
    });

    it("starts AI page translation through the section dispatcher without a pre-scan", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        controller.dispatchAiPageSections = jest.fn();
        controller.collectDomPageTextNodes = jest.fn();

        controller.startFullPageBatchTranslation();

        expect(controller.dispatchAiPageSections).toHaveBeenCalledTimes(1);
        expect(controller.collectDomPageTextNodes).not.toHaveBeenCalled();
    });

    it("keeps visible AI sections streaming and batches offscreen sections", () => {
        document.body.innerHTML = `
            <article>
                <p id="visible">Visible source paragraph long enough.</p>
                <h2 id="offHead">Offscreen heading</h2>
                <p id="offBody">Offscreen source paragraph long enough.</p>
            </article>
        `;
        document.getElementById("visible").getBoundingClientRect = () => ({
            top: 10,
            bottom: 40,
            width: 200,
            height: 30,
        });
        document.getElementById("offHead").getBoundingClientRect = () => ({
            top: 5000,
            bottom: 5030,
            width: 200,
            height: 30,
        });

        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.4-mini",
            sl: "en",
            tl: "ko",
        };
        controller._domResolvedSourceLanguage = "en";
        controller._domPageRootElements = [document.body];
        controller.getAiPageSectionMinChars = () => 10;
        controller.enqueueAiPageSectionTranslation = jest.fn();
        controller.enqueueAiPageSectionBatchTranslation = jest.fn();

        controller.dispatchAiPageSections();

        expect(controller.enqueueAiPageSectionTranslation).toHaveBeenCalledTimes(1);
        expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
        expect(controller.enqueueAiPageSectionTranslation.mock.calls[0][0].plainText).toContain(
            "Visible source"
        );
        expect(controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0]).toHaveLength(1);
        expect(
            controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0][0].plainText
        ).toContain("Offscreen heading");
    });

    it("streams only the leading visible AI section and batches the rest", () => {
        document.body.innerHTML = `
            <article>
                <p id="one">${"First visible source paragraph. ".repeat(3)}</p>
                <p id="two">${"Second visible source paragraph. ".repeat(3)}</p>
                <p id="three">${"Third visible source paragraph. ".repeat(3)}</p>
            </article>
        `;
        document.querySelectorAll("p").forEach((element) => {
            element.getBoundingClientRect = () => ({
                top: 10,
                bottom: 40,
                width: 200,
                height: 30,
            });
        });

        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "openaiCompatible",
            model: "local",
            sl: "en",
            tl: "ko",
        };
        controller._domResolvedSourceLanguage = "en";
        controller._domPageRootElements = [document.body];
        controller.getAiPageSectionMinChars = () => 10;
        controller.getAiPageSectionMaxChars = () => 120;
        controller.enqueueAiPageSectionTranslation = jest.fn();
        controller.enqueueAiPageSectionBatchTranslation = jest.fn();

        controller.dispatchAiPageSections();

        expect(controller.enqueueAiPageSectionTranslation).toHaveBeenCalledTimes(1);
        expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
        expect(controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0]).toHaveLength(2);
    });

    it("splits AI page batches by estimated token budget, not just characters", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        const batches = controller.buildAiPageSectionBatches([
            { sourceHtml: "가".repeat(900), inputTokens: 720 },
            { sourceHtml: "나".repeat(900), inputTokens: 720 },
        ]);

        expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
    });

    it("splits AI page batches by estimated output budget for long visible text", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        const batches = controller.buildAiPageSectionBatches([
            {
                sourceHtml: "<p>Short markup.</p>",
                plainText: "Short source text.",
                inputTokens: 80,
                outputTokens: 900,
            },
            {
                sourceHtml: "<p>Another short markup.</p>",
                plainText: "Another short source text.",
                inputTokens: 80,
                outputTokens: 900,
            },
        ]);

        expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
    });

    it("adapts AI page batch size from response telemetry", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        const baseOptions = controller.getAiPageSectionBatchOptions();

        controller.recordAiPageSectionBatchTelemetry({
            durationMs: 900,
            inputTokens: 600,
            entries: 2,
        });
        expect(controller.getAiPageSectionBatchOptions()).toEqual(baseOptions);

        controller.recordAiPageSectionBatchTelemetry({
            durationMs: 850,
            inputTokens: 620,
            entries: 2,
        });
        const grownOptions = controller.getAiPageSectionBatchOptions();
        expect(grownOptions.maxInputTokens).toBeGreaterThan(baseOptions.maxInputTokens);
        expect(grownOptions.maxChars).toBeGreaterThan(baseOptions.maxChars);
        expect(grownOptions.maxItems).toBeGreaterThan(baseOptions.maxItems);

        controller.recordAiPageSectionBatchTelemetry({ failed: true, entries: 2 });
        const backedOffOptions = controller.getAiPageSectionBatchOptions();
        expect(backedOffOptions.maxInputTokens).toBeLessThan(grownOptions.maxInputTokens);
        expect(backedOffOptions.maxChars).toBeLessThan(grownOptions.maxChars);
        expect(backedOffOptions.maxItems).toBeLessThanOrEqual(grownOptions.maxItems);
    });

    it("keeps concurrency high for slow-but-successful batches; backs off only on failures", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller.resetAiPageSectionBatchTuning();

        expect(controller.getDomPageMaxConcurrentTranslations()).toBe(32);

        // A big bundled batch is naturally slow — that alone must NOT throttle parallelism
        // (doing so serialized the big requests and killed completion speed).
        controller.recordAiPageConcurrencyTelemetry({
            durationMs: 12000,
            queueWaitMs: 0,
            entries: 4,
        });
        expect(controller.getDomPageMaxConcurrentTranslations()).toBe(32);

        // A real failure (429 / 5xx) does back off.
        controller.recordAiPageConcurrencyTelemetry({ failed: true });
        const reduced = controller.getDomPageMaxConcurrentTranslations();
        expect(reduced).toBeLessThan(32);

        // Fast successes grow it back toward the ceiling.
        controller.recordAiPageConcurrencyTelemetry({ durationMs: 900, entries: 4 });
        controller.recordAiPageConcurrencyTelemetry({ durationMs: 850, entries: 4 });
        expect(controller.getDomPageMaxConcurrentTranslations()).toBeGreaterThan(reduced);
    });

    it("adjusts visible streaming slots from recent page latency", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller.resetAiPageSectionBatchTuning();

        expect(controller.getAiPageVisibleStreamingLimit(5)).toBe(3);

        controller.recordAiPageConcurrencyTelemetry({ durationMs: 900, entries: 4 });
        controller.recordAiPageConcurrencyTelemetry({ durationMs: 850, entries: 4 });
        expect(controller.getAiPageVisibleStreamingLimit(5)).toBe(4);

        controller.recordAiPageConcurrencyTelemetry({
            durationMs: 12000,
            queueWaitMs: 2200,
            entries: 4,
        });
        expect(controller.getAiPageVisibleStreamingLimit(5)).toBe(1);

        controller.recordAiPageConcurrencyTelemetry({
            durationMs: 850,
            queueWaitMs: 0,
            entries: 4,
        });
        controller.recordAiPageConcurrencyTelemetry({
            durationMs: 850,
            queueWaitMs: 0,
            entries: 4,
        });
        expect(controller.getAiPageVisibleStreamingLimit(5)).toBeGreaterThan(1);
    });

    it("applies batched offscreen AI section translations from marker-preserving output", async () => {
        document.body.innerHTML = `
            <article id="article">
                <p id="first">First source paragraph.</p>
                <p id="second">Second source paragraph.</p>
            </article>
        `;
        const article = document.getElementById("article");
        const first = document.getElementById("first");
        const second = document.getElementById("second");
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 1;
        controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
        controller.channel.request = jest.fn().mockResolvedValue({
            mainMeaning: [
                "[[1]]",
                "<p>첫 번째 문단입니다.</p>",
                "[[2]]",
                "<p>두 번째 문단입니다.</p>",
            ].join("\n"),
        });

        controller.enqueueAiPageSectionBatchTranslation([
            {
                section: { parent: article, children: [first], role: "paragraph" },
                segBlocks: [first],
                segTexts: ["First source paragraph."],
                cacheKey: "first",
            },
            {
                section: { parent: article, children: [second], role: "paragraph" },
                segBlocks: [second],
                segTexts: ["Second source paragraph."],
                cacheKey: "second",
            },
        ]);
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(article.textContent).toContain("첫 번째 문단입니다.");
        expect(article.textContent).toContain("두 번째 문단입니다.");
        // The translate request (has .text) — not the per-string IDB lookup (has .keys).
        const translateReq = controller.channel.request.mock.calls.find(
            (call) => call[1] && typeof call[1].text === "string"
        );
        expect(translateReq[1].text).toContain("[[1]]");
        expect(translateReq[1].text).toContain("[[2]]");
        expect(translateReq[1].text).not.toContain("[[1:p]]");
    });

    it("never re-sends a string already translated this session (per-string cache)", async () => {
        document.body.innerHTML = `
            <article id="article">
                <p id="a1">Shared label.</p>
                <p id="a2">Unique first.</p>
                <p id="b1">Shared label.</p>
                <p id="b2">Unique second.</p>
            </article>
        `;
        const article = document.getElementById("article");
        const [a1, a2, b1, b2] = ["a1", "a2", "b1", "b2"].map((id) => document.getElementById(id));
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 1;
        controller._aiSectionTranslatedChildren = new WeakSet([a1, a2, b1, b2]);

        // First batch translates "Shared label." + "Unique first." and caches both.
        controller.channel.request = jest.fn().mockResolvedValue({
            mainMeaning: ["[[1]]", "공유 라벨.", "[[2]]", "고유 첫째."].join("\n"),
        });
        controller.enqueueAiPageSectionBatchTranslation([
            {
                section: { parent: article, children: [a1, a2] },
                segBlocks: [a1, a2],
                segTexts: ["Shared label.", "Unique first."],
                cacheKey: "A",
            },
        ]);
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(a1.textContent).toBe("공유 라벨.");

        // Second batch repeats "Shared label." — it must be served from cache, NOT re-sent.
        controller.channel.request = jest
            .fn()
            .mockResolvedValue({ mainMeaning: ["[[1]]", "고유 둘째."].join("\n") });
        controller.enqueueAiPageSectionBatchTranslation([
            {
                section: { parent: article, children: [b1, b2] },
                segBlocks: [b1, b2],
                segTexts: ["Shared label.", "Unique second."],
                cacheKey: "B",
            },
        ]);
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const secondPayload = controller.channel.request.mock.calls.find(
            (call) => call[1] && typeof call[1].text === "string"
        )[1].text;
        expect(secondPayload).toContain("Unique second.");
        expect(secondPayload).not.toContain("Shared label.");
        // Both blocks are translated: the repeat from cache, the new one from the reply.
        expect(b1.textContent).toBe("공유 라벨.");
        expect(b2.textContent).toBe("고유 둘째.");
    });

    it("re-sends missing leaves when an entry cache only has partial marker output", async () => {
        document.body.innerHTML = `
            <article id="article">
                <p id="first">First source paragraph.</p>
                <p id="second">Second source paragraph.</p>
            </article>
        `;
        const article = document.getElementById("article");
        const first = document.getElementById("first");
        const second = document.getElementById("second");
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 1;
        controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
        controller.cacheDomPageTranslation(
            "partial-entry",
            ["[[2]]", "두 번째 문단입니다."].join("\n")
        );
        controller.channel.request = jest.fn().mockResolvedValue({
            mainMeaning: ["[[1]]", "첫 번째 문단입니다."].join("\n"),
        });

        controller.enqueueAiPageSectionBatchTranslation([
            {
                section: { parent: article, children: [first, second], role: "paragraph" },
                segBlocks: [first, second],
                segTexts: ["First source paragraph.", "Second source paragraph."],
                cacheKey: "partial-entry",
                originalCapture: [],
            },
        ]);
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const payload = controller.channel.request.mock.calls.find(
            (call) => call[1] && typeof call[1].text === "string"
        )[1].text;
        expect(payload).toContain("First source paragraph.");
        expect(payload).not.toContain("Second source paragraph.");
        expect(first.textContent).toBe("첫 번째 문단입니다.");
        expect(second.textContent).toBe("두 번째 문단입니다.");
    });

    it("streams completed AI section batch segments before the final response", async () => {
        document.body.innerHTML = `
            <article id="article">
                <p id="first">First source paragraph.</p>
                <p id="second">Second source paragraph.</p>
            </article>
        `;
        const article = document.getElementById("article");
        const first = document.getElementById("first");
        const second = document.getElementById("second");
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openaiCompatible", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 1;
        controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
        let resolveRequest;
        controller.channel.request = jest.fn((service) => {
            // The per-string IDB lookup resolves immediately; only the translate call is held
            // pending so the test can drive the streaming/final phases deterministically.
            if (service === "persistent_segment_get") return Promise.resolve([]);
            return new Promise((resolve) => {
                resolveRequest = resolve;
            });
        });

        controller.enqueueAiPageSectionBatchTranslation([
            {
                section: { parent: article, children: [first], role: "paragraph" },
                segBlocks: [first],
                segTexts: ["First source paragraph."],
                cacheKey: "first",
            },
            {
                section: { parent: article, children: [second], role: "paragraph" },
                segBlocks: [second],
                segTexts: ["Second source paragraph."],
                cacheKey: "second",
            },
        ]);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();

        const streamHandler = controller.channel.on.mock.calls.find(
            ([eventName]) => eventName === "translation_stream_progress"
        )[1];
        const streamId = controller.channel.request.mock.calls.find(
            (call) => call[1] && call[1].streamId
        )[1].streamId;
        streamHandler({
            streamId,
            text: "[[1]]\n첫 번째 문단입니다.\n[[2]]\n두 번째",
        });

        expect(article.textContent).toContain("첫 번째 문단입니다.");
        expect(article.textContent).toContain("Second source paragraph.");

        resolveRequest({
            mainMeaning: [
                "[[1]]",
                "<p>첫 번째 문단입니다.</p>",
                "[[2]]",
                "<p>두 번째 문단입니다.</p>",
            ].join("\n"),
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(article.textContent).toContain("첫 번째 문단입니다.");
        expect(article.textContent).toContain("두 번째 문단입니다.");
    });

    it("uses smaller DOM-ordered page batches for OpenAI models", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.5",
            sl: "en",
            tl: "ko",
        };
        const entries = Array.from({ length: 11 }, (_, index) => ({
            sourceText: `Paragraph ${index + 1}.`,
        }));

        expect(controller.getDomPageMaxConcurrentTranslations()).toBe(16);
        expect(controller.getDomPageTranslationGroupOptions()).toEqual({ maxChars: 12000 });
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 12000, maxItems: 64 });
        expect(
            controller.buildDomPageTranslationBatches(entries).map((batch) => batch.length)
        ).toEqual([11]);
        expect(
            controller
                .buildDomPageTranslationBatches(entries, { smart: false })
                .map((batch) => batch.length)
        ).toEqual([11]);
        controller.recordDomPageBatchFailure();
        expect(controller._domMaxConcurrentTranslations).toBe(12);
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 7000, maxItems: 32 });
        controller.recordDomPageBatchFailure();
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 4000, maxItems: 6 });
        controller.recordDomPageBatchFailure();
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 1800, maxItems: 1 });
    });

    it("rescans newly loaded infinite-scroll text from DOM mutations, not scroll", async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = "<main><p>Already translated.</p></main>";
            const controller = new BannerController();
            controller.currentTranslator = "dom";
            controller._domPageRootElements = [document.body];
            controller._domPageTranslateOptions = {
                engine: "googleAiStudio",
                sl: "en",
                tl: "ko",
            };
            controller.translateBatchNodes = jest.fn();
            controller.dispatchAiPageSections = jest.fn();
            controller.startDomFallback();

            window.dispatchEvent(new Event("scroll"));
            jest.advanceTimersByTime(500);
            expect(controller.dispatchAiPageSections).not.toHaveBeenCalled();

            const paragraph = document.createElement("p");
            paragraph.textContent = "New infinite scroll paragraph with enough text.";
            document.querySelector("main").appendChild(paragraph);

            await Promise.resolve();
            jest.advanceTimersByTime(500);

            expect(controller.dispatchAiPageSections).toHaveBeenCalled();

            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("does not redispatch the whole page during coverage verification", () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <main>
                    <p id="done">이미 번역된 한국어 문장입니다. 충분히 긴 본문입니다.</p>
                    <aside id="late">Late recommendation text that should not reopen verification.</aside>
                </main>
            `;
            const controller = new BannerController();
            controller.currentTranslator = "dom";
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domPageRootElements = [document.body];
            controller._domTotalTranslationEntries = 1;
            controller._domCompletedTranslationEntries = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([
                document.getElementById("done"),
            ]);
            controller.dispatchAiPageSections = jest.fn(() => 1);
            controller.collectDomPageTextNodes = jest.fn(() => []);

            controller.scheduleDomPageCoverageScan();
            jest.advanceTimersByTime(150);

            expect(controller.dispatchAiPageSections).not.toHaveBeenCalled();
            expect(controller.collectDomPageTextNodes).not.toHaveBeenCalled();
            expect(controller._domCoverageStableScanCount).toBe(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it("coverage re-sends only registered gap candidates", () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <main>
                    <p id="gap">This dropped-marker paragraph still needs translation.</p>
                    <aside id="late">Late recommendation text should stay out of coverage.</aside>
                </main>
            `;
            const controller = new BannerController();
            controller.currentTranslator = "dom";
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domPageRootElements = [document.body];
            controller._domTotalTranslationEntries = 1;
            controller._domCompletedTranslationEntries = 1;
            controller.addDomGapCandidateElement(document.getElementById("gap"));
            controller.dispatchAiPageSections = jest.fn(() => 1);

            controller.scheduleDomPageCoverageScan();
            jest.advanceTimersByTime(150);

            expect(controller.dispatchAiPageSections).toHaveBeenCalledWith({
                reason: "sweep",
                gapOnly: true,
            });
            expect(controller._domCoverageStableScanCount).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it("stops automatic coverage scans after a stable completed pass", () => {
        jest.useFakeTimers();
        try {
            const controller = new BannerController();
            controller.currentTranslator = "dom";
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domPageRootElements = [document.body];
            controller._domTotalTranslationEntries = 2;
            controller._domCompletedTranslationEntries = 2;
            controller.dispatchAiPageSections = jest.fn(() => 0);

            controller.scheduleDomPageCoverageScan();
            jest.advanceTimersByTime(150);
            controller.scheduleDomPageCoverageScan();
            jest.advanceTimersByTime(150);

            expect(controller.dispatchAiPageSections).not.toHaveBeenCalled();
            expect(controller._domCoverageScanCount).toBe(1);
            expect(controller._domCoverageStableScanCount).toBe(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it("ignores its own translated DOM mutations after completion", async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <article>
                    <p id="line">Original source paragraph that is long enough.</p>
                </article>
            `;
            const controller = new BannerController();
            controller.currentTranslator = "dom";
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "ko",
                tl: "en",
            };
            controller._domPageRootElements = [document.body];
            controller._domTotalTranslationEntries = 1;
            controller._domCompletedTranslationEntries = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([
                document.getElementById("line"),
            ]);
            controller.dispatchAiPageSections = jest.fn(() => 0);
            controller.startDomFallback();

            controller.noteDomPageOwnMutation();
            document.getElementById("line").textContent =
                "Translated English text that would otherwise look like a fresh Latin target.";
            await Promise.resolve();
            jest.advanceTimersByTime(250);
            await Promise.resolve();

            expect(controller.dispatchAiPageSections).not.toHaveBeenCalled();
            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("limits PDF page translation roots to the PDF.js viewer content", () => {
        document.body.innerHTML = `
            <div id="outerContainer">
                <div id="toolbarViewer">Download Print Zoom</div>
                <div id="viewer"><div class="page"><span>PDF page text to translate.</span></div></div>
            </div>
        `;
        const controller = new BannerController();
        controller._domPageRootElements = controller.getDomPageTranslationRoots();

        const nodes = controller.collectDomPageTextNodes(controller._domPageRootElements);

        expect(controller._domPageRootElements).toEqual([document.getElementById("viewer")]);
        expect(nodes.map((node) => node.nodeValue.trim())).toEqual(["PDF page text to translate."]);
    });

    it("makes translated PDF text layer content visible over the PDF canvas", () => {
        document.body.innerHTML = `
            <div id="outerContainer">
                <div id="viewer">
                    <div class="page">
                        <div class="textLayer"><span>PDF text layer content.</span></div>
                    </div>
                </div>
            </div>
        `;
        const controller = new BannerController();
        const node = document.querySelector(".textLayer span").firstChild;

        controller.applyWithFadeIn(node, "번역된 PDF 텍스트", "text", "PDF text layer content.");

        const translated = document.querySelector(".et-dom-pdf-translated-text");
        expect(translated).not.toBeNull();
        expect(translated.textContent.trim()).toBe("번역된 PDF 텍스트");
        expect(document.querySelector("style").textContent).toContain(
            ".textLayer .et-dom-pdf-translated-text"
        );
    });

    it("translates current YouTube captions through the quiet translation service", async () => {
        document.body.innerHTML = `
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">Hello from the uploader caption.</span>
            </div>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        getOrSetDefaultSettings.mockResolvedValueOnce({
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: { enabled: true, mode: "openai" },
            DefaultTranslator: "GoogleTranslate",
        });
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "업로더 자막에서 안녕하세요.",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledWith("translate_text_quiet", {
            text: "[[0]] Hello from the uploader caption.",
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
            textRole: "caption",
            translationProfile: "realtimeCaptionBatch",
        });
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.hidden).toBe(false);
        expect(overlay.textContent).toBe("업로더 자막에서 안녕하세요.");
        expect(overlay.style.borderRadius).toBe("18px");
        expect(overlay.style.background).toContain("rgba(18, 18, 20");
        expect(overlay.style.boxShadow).toContain("rgba(0, 0, 0");
    });

    it("does not issue duplicate live-batch requests while the same caption is in flight", async () => {
        jest.useFakeTimers();
        try {
            localStorage.setItem("edgeTranslate.captionDebug", "1");
            document.body.innerHTML = `
                <div class="ytp-caption-window-container">
                    <span class="ytp-caption-segment">Repeated visible caption.</span>
                </div>
            `;
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller.isYouTubePage = () => true;
            controller._captionOptionsCache = {
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
            };
            controller._captionOptionsCacheAt = Date.now();
            controller.channel.request.mockResolvedValueOnce({
                mainMeaning: "[[0]] 반복 자막.",
            });

            const first = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();
            await Promise.resolve();
            const second = controller.translateCurrentRealtimeCaption();

            jest.advanceTimersByTime(controller._captionBatchDelayMs);
            await first;
            await second;

            expect(controller.channel.request).toHaveBeenCalledTimes(1);
            expect(
                (window.__edgeTranslateCaptionDebugEvents || []).filter(
                    (event) => event.event === "display:fallback-request"
                )
            ).toHaveLength(1);
            expect(document.getElementById("edge-translate-realtime-caption").textContent).toBe(
                "반복 자막."
            );
        } finally {
            jest.useRealTimers();
        }
    });

    it("waits briefly for open-ended caption fragments when caption track cues are available", async () => {
        jest.useFakeTimers();
        try {
            localStorage.setItem("edgeTranslate.captionDebug", "1");
            document.body.innerHTML = `
                <div class="ytp-caption-window-container">
                    <span class="ytp-caption-segment">I am honored to be with you today at your commencement</span>
                </div>
            `;
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller.isYouTubePage = () => true;
            controller._captionStabilizeDelayMs = 500;
            controller._captionBatchDelayMs = 1;
            controller._captionPrefetchCues = controller.addYouTubeCaptionCueGroups([
                {
                    startMs: 0,
                    endMs: 5000,
                    text:
                        "I am honored to be with you today at your commencement " +
                        "from one of the finest universities in the world.",
                },
            ]);
            controller._captionOptionsCache = {
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
            };
            controller._captionOptionsCacheAt = Date.now();
            controller.channel.request.mockResolvedValueOnce({
                mainMeaning:
                    "세계 최고의 대학 중 한 곳에서 열리는 오늘 졸업식에 함께하게 되어 영광입니다.",
            });

            const first = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();
            expect(controller.channel.request).not.toHaveBeenCalled();
            expect(document.getElementById("edge-translate-realtime-caption")).toBeNull();

            document.querySelector(".ytp-caption-segment").textContent =
                "from one of the finest universities in the world.";
            const second = controller.translateCurrentRealtimeCaption();
            await first;
            await Promise.resolve();
            jest.advanceTimersByTime(controller._captionStabilizeDelayMs);
            await Promise.resolve();
            await Promise.resolve();
            jest.advanceTimersByTime(controller._captionBatchDelayMs);
            await Promise.resolve();
            await second;

            expect(controller.channel.request).toHaveBeenCalledTimes(1);
            expect(controller.channel.request).toHaveBeenCalledWith("translate_text_quiet", {
                text:
                    "[[0]] I am honored to be with you today at your commencement\n" +
                    "from one of the finest universities in the world.",
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
                textRole: "caption",
                translationProfile: "realtimeCaptionBatch",
            });
            const overlay = document.getElementById("edge-translate-realtime-caption");
            expect(overlay.hidden).toBe(false);
            expect(overlay.textContent).toBe(
                "세계 최고의 대학 중 한 곳에서 열리는 오늘 졸업식에 함께하게 되어 영광입니다."
            );
            expect(
                (window.__edgeTranslateCaptionDebugEvents || []).filter(
                    (event) => event.event === "display:stabilize-wait"
                )
            ).not.toHaveLength(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it("keeps open-ended visible fragments separate when caption track cues are unavailable", async () => {
        jest.useFakeTimers();
        try {
            localStorage.setItem("edgeTranslate.captionDebug", "1");
            document.body.innerHTML = `
                <div class="ytp-caption-window-container">
                    <span class="ytp-caption-segment">I am honored to be with you today at your commencement</span>
                </div>
            `;
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller.isYouTubePage = () => true;
            controller._captionBatchDelayMs = 1;
            controller._captionOptionsCache = {
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
            };
            controller._captionOptionsCacheAt = Date.now();
            controller.channel.request.mockResolvedValueOnce({
                mainMeaning: "[[0]] 첫 번째 조각.\n[[1]] 두 번째 조각.",
            });

            const first = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();
            document.querySelector(".ytp-caption-segment").textContent =
                "from one of the finest universities in the world.";
            const second = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();
            jest.advanceTimersByTime(controller._captionBatchDelayMs);
            await Promise.resolve();
            await Promise.all([first, second]);

            expect(controller.channel.request).toHaveBeenCalledTimes(1);
            expect(controller.channel.request).toHaveBeenCalledWith("translate_text_quiet", {
                text:
                    "[[0]] I am honored to be with you today at your commencement\n" +
                    "[[1]] from one of the finest universities in the world.",
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
                textRole: "caption",
                translationProfile: "realtimeCaptionBatch",
            });
            const overlay = document.getElementById("edge-translate-realtime-caption");
            expect(overlay.hidden).toBe(false);
            expect(
                Array.from(overlay.querySelectorAll("[data-role]")).map(
                    (line) => line.textContent
                )
            ).toEqual(["첫 번째 조각.", "두 번째 조각."]);
            expect(
                (window.__edgeTranslateCaptionDebugEvents || []).filter(
                    (event) => event.event === "display:stabilize-wait"
                )
            ).toHaveLength(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it("uses a shorter recency window for late realtime caption display decisions", () => {
        const controller = new BannerController();
        controller._captionVisibleSources = [
            {
                text: "A caption that already moved on.",
                at: 1000,
                seq: 1,
            },
        ];
        const nowSpy = jest.spyOn(Date, "now").mockReturnValue(2000);
        try {
            expect(
                controller.wasRecentlyVisibleRealtimeCaptionSource(
                    "A caption that already moved on.",
                    controller._captionLateDisplayGraceMs
                )
            ).toBe(false);
            expect(
                controller.wasRecentlyVisibleRealtimeCaptionSource(
                    "A caption that already moved on.",
                    controller._captionStabilizeWindowMs
                )
            ).toBe(true);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("accepts an explicit realtime caption state from the context menu", () => {
        const controller = new BannerController();
        controller.startRealtimeCaptionTranslation = jest.fn();
        controller.stopRealtimeCaptionTranslation = jest.fn();
        controller.saveRealtimeCaptionTranslationSetting = jest.fn();

        const stateHandler = controller.channel.on.mock.calls.find(
            ([eventName]) => eventName === "set_realtime_caption_translate"
        )?.[1];
        expect(stateHandler).toBeDefined();

        stateHandler({ enabled: true });
        expect(controller.startRealtimeCaptionTranslation).toHaveBeenCalledTimes(1);
        expect(controller.saveRealtimeCaptionTranslationSetting).not.toHaveBeenCalled();

        stateHandler({ enabled: false });
        expect(controller.stopRealtimeCaptionTranslation).toHaveBeenCalledTimes(1);
    });

    it("keeps the previous caption visible while the next live caption is translating", async () => {
        document.body.innerHTML = `
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">First caption.</span>
            </div>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({ mainMeaning: "첫 번째 자막." });

        await controller.translateCurrentRealtimeCaption();
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.hidden).toBe(false);
        expect(overlay.textContent).toBe("첫 번째 자막.");

        let resolveNext;
        controller.channel.request.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveNext = resolve;
                })
        );
        document.querySelector(".ytp-caption-segment").textContent = "Second caption.";
        const nextTranslation = controller.translateCurrentRealtimeCaption();
        await Promise.resolve();

        expect(overlay.hidden).toBe(false);
        expect(overlay.textContent).toBe("첫 번째 자막.");

        resolveNext({ mainMeaning: "두 번째 자막." });
        await nextTranslation;
        expect(overlay.hidden).toBe(false);
        const lines = overlay.querySelectorAll("[data-role]");
        expect(lines).toHaveLength(1);
        expect(lines[0].dataset.role).toBe("current-caption");
        expect(lines[0].textContent).toBe("두 번째 자막.");
        expect(lines[0].style.animation).toContain("edgeCaptionCurrentSlide");
        expect(overlay.textContent).not.toContain("첫 번째 자막.");
        expect(document.getElementById("edge-translate-realtime-caption-style")).toBeTruthy();
    });

    it("holds the last translated caption briefly when YouTube captions disappear", async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <button class="ytp-subtitles-button" aria-pressed="true"></button>
                <video src="movie.mp4"></video>
            `;
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller.showRealtimeCaptionOverlay("읽는 중인 자막.", "Caption being read.");
            const overlay = document.getElementById("edge-translate-realtime-caption");

            await controller.translateCurrentRealtimeCaption();
            expect(overlay.hidden).toBe(false);
            expect(overlay.textContent).toBe("읽는 중인 자막.");

            jest.advanceTimersByTime(1399);
            expect(overlay.hidden).toBe(false);

            jest.advanceTimersByTime(1);
            expect(overlay.hidden).toBe(true);
            expect(controller._captionDisplayItems).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("keeps an in-flight caption displayable through a transient empty YouTube caption DOM", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">Caption that briefly disappears.</span>
            </div>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        let resolveTranslation;
        controller.channel.request.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveTranslation = resolve;
                })
        );

        const translation = controller.translateCurrentRealtimeCaption();
        await Promise.resolve();
        document.querySelector(".ytp-caption-segment").textContent = "";
        await controller.translateCurrentRealtimeCaption();

        resolveTranslation({ mainMeaning: "잠깐 사라지는 자막입니다." });
        await translation;

        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.hidden).toBe(false);
        expect(overlay.textContent).toBe("잠깐 사라지는 자막입니다.");
    });

    it("does not keep extending the missing-caption hold on repeated empty polls", async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <button class="ytp-subtitles-button" aria-pressed="true"></button>
                <video src="movie.mp4"></video>
            `;
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller._captionOptionsCache = {
                sl: "en",
                tl: "ko",
                translatorId: "GoogleTranslate",
                engine: "",
            };
            controller._captionOptionsCacheAt = Date.now();
            controller._captionLastSource = "Caption that is gone.";
            controller.recordRealtimeCaptionVisibleSource("Caption that is gone.");
            controller.showRealtimeCaptionOverlay("곧 사라질 자막입니다.", "Caption that is gone.");
            const overlay = document.getElementById("edge-translate-realtime-caption");

            await controller.translateCurrentRealtimeCaption();
            jest.advanceTimersByTime(Math.floor(controller._captionHoldAfterMissingMs / 2));
            await controller.translateCurrentRealtimeCaption();
            jest.advanceTimersByTime(Math.ceil(controller._captionHoldAfterMissingMs / 2));

            expect(overlay.hidden).toBe(true);
            expect(controller._captionLastSource).toBe("");
            expect(controller._captionVisibleSources).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("hides realtime captions immediately and skips translation when YouTube captions are off", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="false"></button>
            <video src="movie.mp4"></video>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.showRealtimeCaptionOverlay("기존 번역.", "Previous.");
        const overlay = document.getElementById("edge-translate-realtime-caption");

        await controller.translateCurrentRealtimeCaption();
        await controller.prefetchYouTubeCaptionTrackAndWarmCache({ reschedule: false });

        expect(controller.channel.request).not.toHaveBeenCalled();
        expect(overlay.hidden).toBe(true);
        expect(controller._captionDisplayItems).toEqual([]);
    });

    it("translates visible caption text even when YouTube's native toggle state is stale", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="false"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">Visible caption despite stale toggle.</span>
            </div>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "표시 중인 자막입니다.",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.hidden).toBe(false);
        expect(overlay.textContent).toBe("표시 중인 자막입니다.");
    });

    it("keeps only the two most recent translated captions in the realtime overlay", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.showRealtimeCaptionOverlay("첫 번째.", "First.");
        controller.showRealtimeCaptionOverlay("두 번째.", "Second.");
        controller.showRealtimeCaptionOverlay("세 번째.", "Third.");

        const overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = overlay.querySelectorAll("[data-role]");
        expect(lines).toHaveLength(2);
        expect(lines[0].textContent).toBe("두 번째.");
        expect(lines[0].dataset.role).toBe("previous-caption");
        expect(lines[1].textContent).toBe("세 번째.");
        expect(lines[1].dataset.role).toBe("current-caption");
    });

    it("lets the user drag the realtime subtitle overlay within the viewport", () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
        Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.showRealtimeCaptionOverlay("옮길 수 있는 자막.", "Draggable caption.");

        const overlay = document.getElementById("edge-translate-realtime-caption");
        overlay.getBoundingClientRect = jest.fn(() => ({
            left: 340,
            top: 520,
            width: 520,
            height: 88,
            right: 860,
            bottom: 608,
            x: 340,
            y: 520,
        }));

        overlay.dispatchEvent(
            new MouseEvent("pointerdown", {
                bubbles: true,
                button: 0,
                clientX: 360,
                clientY: 540,
            })
        );
        document.dispatchEvent(
            new MouseEvent("pointermove", {
                bubbles: true,
                clientX: 460,
                clientY: 400,
            })
        );
        document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

        expect(overlay.style.left).toBe("440px");
        expect(overlay.style.top).toBe("380px");
        expect(overlay.style.transform).toBe("none");
    });

    it("keeps YouTube subtitle translator mode simple: AI or Google only", async () => {
        const controller = new BannerController();
        getOrSetDefaultSettings.mockResolvedValueOnce({
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: { enabled: true, mode: "googleAiStudio" },
            DefaultTranslator: "BingTranslate",
            RealtimeCaptionConfig: { translatorMode: "ai", draggableOverlay: false },
        });

        await expect(controller.getRealtimeCaptionTranslateOptions()).resolves.toEqual({
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "googleAiStudio",
            fastTranslatorId: "",
        });

        controller._captionOptionsCache = null;
        getOrSetDefaultSettings.mockResolvedValueOnce({
            languageSetting: { sl: "en", tl: "ko" },
            LocalTranslatorConfig: { enabled: true, mode: "googleAiStudio" },
            DefaultTranslator: "BingTranslate",
            RealtimeCaptionConfig: { translatorMode: "google", draggableOverlay: true },
        });

        await expect(controller.getRealtimeCaptionTranslateOptions()).resolves.toEqual({
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
            fastTranslatorId: "",
        });
        // (The overlay is always draggable now — the draggableOverlay toggle was removed
        // and hardcoded on, so it's no longer derived from RealtimeCaptionConfig.)
    });

    it("replaces fragment captions when a stabilized merged caption arrives", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.showRealtimeCaptionOverlay(
            "오늘 졸업식에 함께하게 되어 영광입니다.",
            "I am honored to be with you today at your commencement"
        );
        controller.showRealtimeCaptionOverlay("다음 자막입니다.", "A following caption.");
        controller.showRealtimeCaptionOverlay(
            "세계 최고의 대학 중 한 곳에서 열리는 오늘 졸업식에 함께하게 되어 영광입니다.",
            "I am honored to be with you today at your commencement\nfrom one of the finest universities in the world.",
            { allowExpandedReplacement: true }
        );

        const overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = overlay.querySelectorAll("[data-role]");
        expect(lines).toHaveLength(2);
        expect(lines[0].textContent).toBe(
            "세계 최고의 대학 중 한 곳에서 열리는 오늘 졸업식에 함께하게 되어 영광입니다."
        );
        expect(lines[1].textContent).toBe("다음 자막입니다.");
        expect(Array.from(lines).map((line) => line.textContent)).not.toContain(
            "오늘 졸업식에 함께하게 되어 영광입니다."
        );
        expect(overlay.dataset.expanded).toBe("true");
        expect(overlay.style.maxWidth).toBe("min(88vw, 1120px)");
        expect(overlay.style.maxHeight).toBe("34vh");
    });

    it("applies late stabilized captions by replacing the earlier fragment in place", async () => {
        jest.useFakeTimers();
        try {
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller.isYouTubePage = () => true;
            controller._captionBatchDelayMs = 1;
            controller._captionOptionsCache = {
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
            };
            controller._captionOptionsCacheAt = Date.now();
            controller.showRealtimeCaptionOverlay(
                "오늘 여러분의 졸업식에 함께하게 되어 영광입니다.",
                "I am honored to be with you today at your commencement"
            );
            controller.showRealtimeCaptionOverlay(
                "사실 저는 대학을 졸업하지 못했습니다.",
                "Truth be told, I never graduated from college."
            );
            let resolveRequest;
            controller.channel.request.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveRequest = resolve;
                    })
            );

            const mergedTranslation = controller.translateRealtimeCaptionSource(
                "I am honored to be with you today at your commencement\nfrom one of the finest universities in the world."
            );
            controller.markRealtimeCaptionMergedReplacementSource(
                "I am honored to be with you today at your commencement\nfrom one of the finest universities in the world."
            );
            await Promise.resolve();
            jest.advanceTimersByTime(controller._captionBatchDelayMs);
            await Promise.resolve();
            controller._captionLastSource =
                "And this is the closest I have ever gotten to a college graduation.";
            controller._captionLastRequestId += 1;
            controller.showRealtimeCaptionOverlay(
                "그리고 이것이 제가 대학 졸업식에 가장 가까이 다가간 순간입니다.",
                "And this is the closest I have ever gotten to a college graduation."
            );
            resolveRequest({
                mainMeaning:
                    "세계 최고의 대학 중 한 곳에서 열리는 오늘 졸업식에 함께하게 되어 영광입니다.",
            });
            await mergedTranslation;

            const overlay = document.getElementById("edge-translate-realtime-caption");
            const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
                line.textContent.trim()
            );
            // Two-row display: the late merged sentence corrected the earlier fragment's slot
            // in history — it did NOT hijack the current line — so the two newest captions stay
            // on screen with the genuinely-current caption last.
            expect(lines).toEqual([
                "사실 저는 대학을 졸업하지 못했습니다.",
                "그리고 이것이 제가 대학 졸업식에 가장 가까이 다가간 순간입니다.",
            ]);
            // The merged sentence replaced the fragment in place at the earliest history slot.
            expect(controller._captionDisplayItems[0].text).toBe(
                "세계 최고의 대학 중 한 곳에서 열리는 오늘 졸업식에 함께하게 되어 영광입니다."
            );
            expect(overlay.textContent).not.toContain(
                "오늘 여러분의 졸업식에 함께하게 되어 영광입니다."
            );
        } finally {
            jest.useRealTimers();
        }
    });

    it("keeps normal multi-line captions to two rows unless they replace fragments", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.showRealtimeCaptionOverlay("첫 번째.", "First.");
        controller.showRealtimeCaptionOverlay("두 번째.", "Second.");
        controller.showRealtimeCaptionOverlay("세 번째.", "Third.");
        controller.showRealtimeCaptionOverlay("묶인 네 번째.", "Fourth\nfragment.");

        const overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = overlay.querySelectorAll("[data-role]");
        expect(lines).toHaveLength(2);
        expect(lines[0].textContent).toBe("세 번째.");
        expect(lines[1].textContent).toBe("묶인 네 번째.");
        expect(overlay.dataset.expanded).toBe("false");
        expect(overlay.style.maxHeight).toBe("28vh");
    });

    it("does not enter three-row mode for ordinary multi-line captions that include prior text", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.showRealtimeCaptionOverlay("첫 번째 줄.", "First line");
        controller.showRealtimeCaptionOverlay("두 줄 현재 자막.", "First line\nsecond line");

        const overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
            line.textContent.trim()
        );
        expect(lines).toEqual(["두 줄 현재 자막."]);
        expect(overlay.dataset.expanded).toBe("true");
        expect(overlay.style.maxHeight).toBe("34vh");
    });

    it("returns to two caption rows after a merged replacement scrolls out", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.showRealtimeCaptionOverlay("조각 첫 줄.", "Fragment first line");
        controller.showRealtimeCaptionOverlay(
            "합쳐진 자연스러운 첫 문장.",
            "Fragment first line\ncontinued source",
            { allowExpandedReplacement: true }
        );
        controller.showRealtimeCaptionOverlay("두 번째.", "Second.");
        controller.showRealtimeCaptionOverlay("세 번째.", "Third.");

        let overlay = document.getElementById("edge-translate-realtime-caption");
        // Two-row display stays at two rows right after a merge — the merged sentence took the
        // fragment's slot in history, so the two newest captions are what's on screen.
        let rows = overlay.querySelectorAll("[data-role]");
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toBe("두 번째.");
        expect(rows[1].textContent).toBe("세 번째.");
        expect(overlay.dataset.expanded).toBe("false");

        controller.showRealtimeCaptionOverlay("네 번째.", "Fourth.");
        controller.showRealtimeCaptionOverlay("다섯 번째.", "Fifth.");

        overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = overlay.querySelectorAll("[data-role]");
        expect(lines).toHaveLength(2);
        expect(lines[0].textContent).toBe("네 번째.");
        expect(lines[1].textContent).toBe("다섯 번째.");
        expect(overlay.dataset.expanded).toBe("false");
    });

    it("does not append a fragment already covered by a merged caption", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.showRealtimeCaptionOverlay("앞 조각.", "First fragment");
        controller.showRealtimeCaptionOverlay(
            "자연스럽게 합쳐진 전체 자막.",
            "First fragment\nsecond fragment",
            { allowExpandedReplacement: true }
        );
        controller.showRealtimeCaptionOverlay("다음 자막.", "Next caption.");
        // "중복 조각" carries source "second fragment", which is already part of the merged
        // caption still on screen — it's a stray cue of an already-displayed sentence and must
        // be dropped rather than appended as a new line.
        controller.showRealtimeCaptionOverlay("중복 조각.", "second fragment");

        const overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
            line.textContent.trim()
        );
        expect(lines).toEqual(["자연스럽게 합쳐진 전체 자막.", "다음 자막."]);
    });

    it("matches caption fragments only on word boundaries for spaced scripts", () => {
        const controller = new BannerController();

        // Real prefix fragment of a growing sentence still matches.
        expect(
            controller.realtimeCaptionSourceIncludes(
                "I am honored to be with you today at your commencement",
                "I am honored to be with you today"
            )
        ).toBe(true);
        // Trailing-punctuation variants normalize to the same fragment.
        expect(
            controller.realtimeCaptionSourceIncludes("Welcome to campus.", "Welcome to campus")
        ).toBe(false); // identical after normalization → not a covering fragment
        // A short standalone word must NOT match inside a longer word.
        expect(controller.realtimeCaptionSourceIncludes("Welcome to campus", "us")).toBe(false);
        expect(controller.realtimeCaptionSourceIncludes("Let us start", "art")).toBe(false);
        // But a whole word bounded by spaces/punctuation does match.
        expect(controller.realtimeCaptionSourceIncludes("Let us start now", "us start")).toBe(true);
        // Scriptio-continua (CJK) has no inter-word spaces — plain substring still applies.
        expect(controller.realtimeCaptionSourceIncludes("私は大学生です", "大学生")).toBe(true);
    });

    it("does not drop a new short caption that is a mid-word substring of the current row", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.showRealtimeCaptionOverlay(
            "캠퍼스에 오신 것을 환영합니다.",
            "Welcome to campus"
        );
        // "Us." is a genuinely new caption; "us" only appears mid-word inside "campus", so the
        // boundary-aware guard must keep it instead of treating it as a covered fragment.
        controller.showRealtimeCaptionOverlay("우리.", "Us.");

        const overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
            line.textContent.trim()
        );
        expect(lines).toEqual(["캠퍼스에 오신 것을 환영합니다.", "우리."]);
    });

    it("treats Chrome on-device (Gemini Nano) as an AI DOM page engine", () => {
        const controller = new BannerController();
        expect(controller.isOnDeviceDomPageEngine("chromeBuiltin")).toBe(true);
        expect(controller.isOnDeviceDomPageEngine("geminiNano")).toBe(true);
        expect(controller.isOnDeviceDomPageEngine("googleAiStudio")).toBe(false);
        // On-device runs through the same [[n]] segment pipeline as the cloud AI engines.
        expect(controller.isAiDomPageEngine("chromeBuiltin")).toBe(true);
        expect(controller.isAiDomPageEngine("openai")).toBe(true);
        expect(controller.isAiDomPageEngine("googlePage")).toBe(false);
    });

    it("routes on-device page batches through the on-device bridge, not the background", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "chromeBuiltin" };
        controller.translateWithOnDeviceEngine = jest
            .fn()
            .mockResolvedValue({ mainMeaning: "[[1]]\n안녕" });
        controller.channel.request = jest.fn();

        const result = await controller.translateWithDomPageEngine("[[1]] hi", "en", "ko", "s1");

        // On-device APIs only exist in the page main world → bridge, never translate_text_quiet.
        expect(controller.translateWithOnDeviceEngine).toHaveBeenCalledWith(
            "[[1]] hi",
            "en",
            "ko",
            ""
        );
        expect(controller.channel.request).not.toHaveBeenCalled();
        expect(result.mainMeaning).toBe("[[1]]\n안녕");
    });

    it("routes cloud page batches to the background translate service with the engine", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio" };
        controller.channel.request = jest.fn().mockResolvedValue({ mainMeaning: "ok" });

        await controller.translateWithDomPageEngine("[[1]] hi", "en", "ko", "s1");

        expect(controller.channel.request).toHaveBeenCalledWith(
            "translate_text_quiet",
            expect.objectContaining({ engine: "googleAiStudio", text: "[[1]] hi", streamId: "s1" })
        );
    });

    it("keeps on-device page batches small (sequential per-segment translation)", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "chromeBuiltin" };
        const opts = controller.getAiPageSectionBatchOptions();
        expect(opts.maxItems).toBeLessThanOrEqual(4);
    });

    it("preserves the on-device engine through start-options normalization", () => {
        const controller = new BannerController();
        // Must NOT be silently coerced to a cloud engine — that would send the page to the
        // cloud LLM instead of Gemini Nano.
        expect(controller.normalizeDomPageTranslateEngine("chromeBuiltin")).toBe("chromeBuiltin");
        expect(controller.normalizeDomPageTranslateEngine("geminiNano")).toBe("chromeBuiltin");
        expect(controller.normalizeDomPageTranslateEngine("openai")).toBe("openai");
        expect(controller.normalizeDomPageTranslateEngine("whatever")).toBe("googleAiStudio");
    });

    it("keeps a dropped-marker leaf eligible for re-collection (does not mark it translated)", () => {
        document.body.innerHTML = `
            <main><article>
                <p id="p1">First paragraph with plenty of English content to translate.</p>
                <p id="p2">Second paragraph with plenty of English content to translate.</p>
            </article></main>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openai", model: "m", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domPageRootElements = [document.querySelector("main")];
        const p1 = document.getElementById("p1");
        const p2 = document.getElementById("p2");
        const entry = {
            section: { children: [p1, p2] },
            segBlocks: [p1, p2],
            segTexts: [p1.textContent, p2.textContent],
            batchUnitOf: [0, 1],
            batchCachedText: [],
            cacheKey: "k",
            originalCapture: [],
        };
        // The model dropped p1's marker — the reply only carries unit 2 (p2).
        const globalMap = new Map([[2, "두 번째 단락의 번역입니다."]]);
        controller.applyAiPageSectionBatchEntry(entry, globalMap);

        expect(p2.textContent).toContain("두 번째"); // applied
        expect(p1.textContent).toContain("First paragraph"); // dropped → still English
        // THE BUG: the old code marked the WHOLE section translated, so the dropped p1 became
        // ineligible and was never re-sent. It must stay eligible so coverage re-collects it.
        expect(controller.isAiPageSectionElementEligible(p1)).toBe(true);
        expect(controller.isAiPageSectionElementEligible(p2)).toBe(false);
    });

    it("detects dropped-marker leaves and flags a bounded partial retry", () => {
        const controller = new BannerController();
        controller._aiSectionMaxPartialRetries = 2;

        // Blocks 1 and 3 applied (1-based, matching applyPageSegments' baseIndex+i+1); the
        // model dropped block 2's marker → one unresolved leaf → flag a retry.
        const entry = {
            segBlocks: [{}, {}, {}],
            segTexts: ["a", "b", "c"],
            _segAppliedSet: new Set([1, 3]),
        };
        expect(controller.countUnresolvedEntryBlocks(entry, entry._segAppliedSet)).toBe(1);
        controller.flagAiPageEntryPartialRetry(entry, entry._segAppliedSet, true);
        expect(entry._needsPartialRetry).toBe(true);

        // Empty/whitespace blocks need no translation → not counted as unresolved.
        const allDone = {
            segBlocks: [{}, {}],
            segTexts: ["x", "   "],
            _segAppliedSet: new Set([1]),
        };
        expect(controller.countUnresolvedEntryBlocks(allDone, allDone._segAppliedSet)).toBe(0);
        controller.flagAiPageEntryPartialRetry(allDone, allDone._segAppliedSet, true);
        expect(allDone._needsPartialRetry).toBe(false);

        // Retry cap respected — a block the model simply won't translate can't loop forever.
        const capped = {
            segBlocks: [{}, {}],
            segTexts: ["a", "b"],
            _segAppliedSet: new Set([1]),
            _partialApplyAttempts: 2,
        };
        controller.flagAiPageEntryPartialRetry(capped, capped._segAppliedSet, true);
        expect(capped._needsPartialRetry).toBe(false);

        // A fully-failed (0 applied) entry is handled by the normal failure path, not here.
        const failed = { segBlocks: [{}], segTexts: ["a"], _segAppliedSet: new Set() };
        controller.flagAiPageEntryPartialRetry(failed, failed._segAppliedSet, false);
        expect(failed._needsPartialRetry).toBe(false);
    });

    it("completion sweep un-marks sections that still hold source-language text", () => {
        document.body.innerHTML = `
            <main>
                <p id="done">완전히 번역된 한국어 문장입니다 그리고 충분히 깁니다.</p>
                <p id="gap">This English paragraph was left untranslated by a dropped marker.</p>
            </main>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", tl: "ko" };
        const main = document.querySelector("main");
        controller._domPageRootElements = [main];
        const donePara = document.getElementById("done");
        const gapPara = document.getElementById("gap");
        // Both were marked translated (section declared done) — but #gap is still English.
        controller._aiSectionTranslatedChildren = new WeakSet([donePara, gapPara]);

        expect(controller.sweepUntranslatedDomPageLeaves()).toBe(true);
        // The still-English paragraph is un-marked (eligible again); the Korean one stays done.
        expect(controller._aiSectionTranslatedChildren.has(gapPara)).toBe(false);
        expect(controller._aiSectionTranslatedChildren.has(donePara)).toBe(true);

        // Convergence: the same stubborn leaf isn't swept twice.
        expect(controller.sweepUntranslatedDomPageLeaves()).toBe(false);
    });

    it("completion sweep releases every marked ancestor around a leftover source leaf", () => {
        document.body.innerHTML = `
            <main>
                <article id="article">
                    <section id="section">
                        <p id="gap">This English paragraph was left untranslated inside nested article markup.</p>
                    </section>
                </article>
            </main>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", tl: "ko" };
        controller._domPageRootElements = [document.querySelector("main")];
        const article = document.getElementById("article");
        const section = document.getElementById("section");
        const gapPara = document.getElementById("gap");

        controller._aiSectionTranslatedChildren = new WeakSet([article, section, gapPara]);

        expect(controller.sweepUntranslatedDomPageLeaves()).toBe(true);
        expect(controller._aiSectionTranslatedChildren.has(article)).toBe(false);
        expect(controller._aiSectionTranslatedChildren.has(section)).toBe(false);
        expect(controller._aiSectionTranslatedChildren.has(gapPara)).toBe(false);
        expect(controller.isAiPageSectionElementEligible(gapPara)).toBe(true);
    });

    it("never caches or applies a source-echo translation (cache can't revert text to its source)", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "googleAiStudio",
            model: "m",
            sl: "en",
            tl: "ko",
        };
        controller._domSegmentTextCache = new Map();

        // A real translation is cached + returned.
        controller.storeCachedSegmentText("Hello world", "안녕 세계");
        expect(controller.getCachedSegmentText("Hello world")).toBe("안녕 세계");

        // An echo (model returned the source) is NOT cached.
        controller.storeCachedSegmentText("Steam Deck", "Steam Deck");
        expect(controller.getCachedSegmentText("Steam Deck")).toBeNull();

        // A pre-existing echo entry (e.g. loaded from IDB by an older build) is a miss on read,
        // so the block translates fresh instead of showing its source language.
        controller._domSegmentTextCache.set(controller.segmentTextCacheKey("Download"), "Download");
        expect(controller.getCachedSegmentText("Download")).toBeNull();

        // Inline tags / segment markers don't fool the source-vs-translation comparison.
        expect(
            controller.isDomPageSourceEchoTranslation("[[1]] Read <a>more</a>", "Read <a>more</a>")
        ).toBe(true);
        expect(controller.isDomPageSourceEchoTranslation("Read more", "더 읽기")).toBe(false);
    });

    it("coalesces live caption updates while a translation request is in flight", async () => {
        document.body.innerHTML = `
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">First caption.</span>
            </div>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        const resolvers = [];
        controller.channel.request.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvers.push(resolve);
                })
        );

        const firstTranslation = controller.translateCurrentRealtimeCaption();
        await Promise.resolve();
        document.querySelector(".ytp-caption-segment").textContent = "Latest caption.";
        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller._captionPendingSource).toBe("Latest caption.");

        resolvers[0]({ mainMeaning: "첫 번째 자막." });
        await firstTranslation;
        await Promise.resolve();
        await Promise.resolve();

        expect(controller.channel.request).toHaveBeenCalledTimes(2);
        expect(controller.channel.request.mock.calls[1][1].text).toBe("Latest caption.");
        expect(controller.channel.request.mock.calls[1][1]).toMatchObject({
            textRole: "caption",
            translationProfile: "realtimeCaption",
        });

        resolvers[1]({ mainMeaning: "최신 자막." });
        await Promise.resolve();
        await Promise.resolve();

        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.hidden).toBe(false);
        const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
            line.textContent.trim()
        );
        expect(lines).toEqual(["최신 자막."]);
        expect(overlay.textContent).not.toContain("첫 번째 자막.");
    });

    it("serializes fast non-AI captions without dropping the middle pending caption", async () => {
        document.body.innerHTML = `
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">First direct caption.</span>
            </div>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        const resolvers = [];
        controller.channel.request.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvers.push(resolve);
                })
        );

        const firstTranslation = controller.translateCurrentRealtimeCaption();
        await Promise.resolve();
        document.querySelector(".ytp-caption-segment").textContent = "Second direct caption.";
        await controller.translateCurrentRealtimeCaption();
        document.querySelector(".ytp-caption-segment").textContent = "Third direct caption.";
        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller._captionPendingSources).toEqual([
            "Second direct caption.",
            "Third direct caption.",
        ]);

        resolvers[0]({ mainMeaning: "첫 번째 직접 자막." });
        await firstTranslation;
        await Promise.resolve();
        expect(controller.channel.request).toHaveBeenCalledTimes(2);
        expect(controller.channel.request.mock.calls[1][1].text).toBe("Second direct caption.");

        resolvers[1]({ mainMeaning: "두 번째 직접 자막." });
        await Promise.resolve();
        await Promise.resolve();
        expect(controller.channel.request).toHaveBeenCalledTimes(3);
        expect(controller.channel.request.mock.calls[2][1].text).toBe("Third direct caption.");

        resolvers[2]({ mainMeaning: "세 번째 직접 자막." });
        await Promise.resolve();
        await Promise.resolve();

        const overlay = document.getElementById("edge-translate-realtime-caption");
        const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
            line.textContent.trim()
        );
        expect(lines).toEqual(["세 번째 직접 자막."]);
        expect(overlay.textContent).not.toContain("두 번째 직접 자막.");
    });

    it("micro-batches live AI captions to avoid repeating prompts per tiny caption", async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <div class="ytp-caption-window-container">
                    <span class="ytp-caption-segment">First live caption.</span>
                </div>
            `;
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller._captionOptionsCache = {
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "openai",
            };
            controller._captionOptionsCacheAt = Date.now();
            controller.channel.request.mockResolvedValueOnce({
                mainMeaning: "[[0]] 첫 번째 실시간 자막.\n[[1]] 두 번째 실시간 자막.",
            });

            const first = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();
            document.querySelector(".ytp-caption-segment").textContent = "Second live caption.";
            const second = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();

            expect(controller.channel.request).not.toHaveBeenCalled();
            jest.advanceTimersByTime(controller._captionBatchDelayMs);
            await first;
            await second;

            expect(controller.channel.request).toHaveBeenCalledTimes(1);
            expect(controller.channel.request.mock.calls[0][1]).toMatchObject({
                text: "[[0]] First live caption.\n[[1]] Second live caption.",
                textRole: "caption",
                translationProfile: "realtimeCaptionBatch",
            });
            const overlay = document.getElementById("edge-translate-realtime-caption");
            const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
                line.textContent.trim()
            );
            expect(lines).toEqual(["첫 번째 실시간 자막.", "두 번째 실시간 자막."]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("renders recent fast captions from one live batch instead of only the latest", async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <div class="ytp-caption-window-container">
                    <span class="ytp-caption-segment">First fast caption.</span>
                </div>
            `;
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller._captionBatchDelayMs = 1;
            controller._captionOptionsCache = {
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
            };
            controller._captionOptionsCacheAt = Date.now();
            controller.channel.request.mockResolvedValueOnce({
                mainMeaning:
                    "[[0]] 첫 번째 빠른 자막.\n[[1]] 두 번째 빠른 자막.\n[[2]] 세 번째 빠른 자막.",
            });

            const first = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();
            document.querySelector(".ytp-caption-segment").textContent = "Second fast caption.";
            const second = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();
            document.querySelector(".ytp-caption-segment").textContent = "Third fast caption.";
            const third = controller.translateCurrentRealtimeCaption();
            await Promise.resolve();

            jest.advanceTimersByTime(controller._captionBatchDelayMs);
            await first;
            await second;
            await third;

            expect(controller.channel.request).toHaveBeenCalledTimes(1);
            expect(controller.channel.request.mock.calls[0][1].text).toBe(
                "[[0]] First fast caption.\n[[1]] Second fast caption.\n[[2]] Third fast caption."
            );
            const overlay = document.getElementById("edge-translate-realtime-caption");
            const lines = Array.from(overlay.querySelectorAll("[data-role]")).map((line) =>
                line.textContent.trim()
            );
            expect(lines).toEqual(["두 번째 빠른 자막.", "세 번째 빠른 자막."]);
            expect(overlay.textContent).not.toContain("첫 번째 빠른 자막.");
        } finally {
            jest.useRealTimers();
        }
    });

    it("does not let an older fast caption overwrite a newer displayed caption", () => {
        const controller = new BannerController();
        controller._captionModeEnabled = true;

        controller.recordRealtimeCaptionVisibleSource("Older fast caption.");
        controller.recordRealtimeCaptionVisibleSource("Newer fast caption.");

        expect(controller.canDisplayRealtimeCaptionSource("Newer fast caption.")).toBe(true);
        controller.showRealtimeCaptionOverlay("최신 빠른 자막.", "Newer fast caption.");

        expect(controller.canDisplayRealtimeCaptionSource("Older fast caption.")).toBe(false);
        if (controller.canDisplayRealtimeCaptionSource("Older fast caption.")) {
            controller.showRealtimeCaptionOverlay("오래된 빠른 자막.", "Older fast caption.");
        }

        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("최신 빠른 자막.");
        expect(overlay.textContent).not.toContain("오래된 빠른 자막.");
    });

    it("keeps live fallback translation scoped to the current visible caption", async () => {
        document.body.innerHTML = `
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">from one of the finest universities in the world.</span>
            </div>
        `;
        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.showRealtimeCaptionOverlay(
            "감사합니다. 오늘 이 졸업식에서 여러분과 함께하게 되어 영광입니다.",
            "Thank you. I am honored to be with you today at your commencement"
        );
        controller._captionLastSource = "";
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning:
                "오늘 세계 최고의 대학 중 하나인 이곳의 졸업식에 여러분과 함께하게 되어 영광입니다.",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1]).toMatchObject({
            text: "[[0]] from one of the finest universities in the world.",
            translationProfile: "realtimeCaptionBatch",
        });
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.querySelector("[data-role='current-caption']").textContent).toBe(
            "오늘 세계 최고의 대학 중 하나인 이곳의 졸업식에 여러분과 함께하게 되어 영광입니다."
        );
        expect(controller._captionDisplayItems).toHaveLength(2);
    });

    it("prefetches YouTube caption tracks and uses warmed caption translations", async () => {
        const playerResponse = {
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            baseUrl: "https://www.youtube.com/api/timedtext?v=test&lang=en",
                            languageCode: "en",
                            vssId: ".en",
                        },
                    ],
                },
            },
        };
        document.body.innerHTML = `
            <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">First prefetched caption.</span>
            </div>
        `;
        Object.defineProperty(document.querySelector("video"), "currentTime", {
            configurable: true,
            value: 1,
        });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () =>
                JSON.stringify({
                    events: [
                        {
                            tStartMs: 1000,
                            dDurationMs: 1200,
                            segs: [{ utf8: "First prefetched caption." }],
                        },
                        {
                            tStartMs: 2200,
                            dDurationMs: 1200,
                            segs: [{ utf8: "Second prefetched caption." }],
                        },
                    ],
                }),
        });

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "[[0]] 첫 번째 선번역 자막.\n[[1]] 두 번째 선번역 자막.",
        });

        await controller.prefetchYouTubeCaptionTrackAndWarmCache({ reschedule: false });
        await Promise.resolve();
        await Promise.resolve();

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][0]).toContain("fmt=json3");
        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1]).toMatchObject({
            text: "[[0]] First prefetched caption.\n[[1]] Second prefetched caption.",
            textRole: "caption",
            translationProfile: "realtimeCaptionBatch",
        });

        controller.channel.request.mockClear();
        await controller.translateCurrentRealtimeCaption();

        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(controller.channel.request).not.toHaveBeenCalled();
        expect(overlay.hidden).toBe(false);
        expect(overlay.textContent).toBe("첫 번째 선번역 자막.");
    });

    it("does not block the first visible AI translation on caption track loading", async () => {
        const playerResponse = {
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            baseUrl: "https://www.youtube.com/api/timedtext?v=test&lang=en",
                            languageCode: "en",
                            vssId: ".en",
                        },
                    ],
                },
            },
        };
        document.body.innerHTML = `
            <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">I am honored to be with you today at your commencement</span>
            </div>
        `;
        Object.defineProperty(document.querySelector("video"), "currentTime", {
            configurable: true,
            value: 2,
        });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () =>
                JSON.stringify({
                    events: [
                        {
                            tStartMs: 1000,
                            dDurationMs: 2000,
                            segs: [
                                {
                                    utf8: "I am honored to be with you today at your commencement",
                                },
                            ],
                        },
                        {
                            tStartMs: 3100,
                            dDurationMs: 2100,
                            segs: [{ utf8: "from one of the finest universities in the world." }],
                        },
                    ],
                }),
        });

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionBatchDelayMs = 1;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "[[0]] 오늘 여러분의 졸업식에 함께하게 되어 영광입니다.",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(global.fetch).not.toHaveBeenCalled();
        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1]).toMatchObject({
            text: "[[0]] I am honored to be with you today at your commencement",
            translationProfile: "realtimeCaptionBatch",
        });
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("오늘 여러분의 졸업식에 함께하게 되어 영광입니다.");
    });

    it("shows a visible-caption fallback while an AI caption track is still loading", async () => {
        const playerResponse = {
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            baseUrl: "https://www.youtube.com/api/timedtext?v=test&lang=en",
                            languageCode: "en",
                            vssId: ".en",
                        },
                    ],
                },
            },
        };
        document.body.innerHTML = `
            <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">I am honored to be with you today at your commencement</span>
            </div>
        `;
        Object.defineProperty(document.querySelector("video"), "currentTime", {
            configurable: true,
            value: 2,
        });
        global.fetch = jest.fn(
            () =>
                new Promise(() => {
                    // Keep the pretranslation track unresolved: visible captions must still render.
                })
        );

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionBatchDelayMs = 1;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "[[0]] 오늘 여러분의 졸업식에 함께하게 되어 영광입니다.",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1]).toMatchObject({
            text: "[[0]] I am honored to be with you today at your commencement",
            translationProfile: "realtimeCaptionBatch",
        });
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("오늘 여러분의 졸업식에 함께하게 되어 영광입니다.");
    });

    it("retries the same visible caption when no overlay was rendered", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">Repeat caption.</span>
            </div>
        `;

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionBatchDelayMs = 1;
        controller._captionLastSource = "Repeat caption.";
        controller._captionRenderedSource = "";
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "[[0]] 반복 자막입니다.",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("반복 자막입니다.");
    });

    it("keeps Google realtime captions to the current visible line without repeated history", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">I like it when nothing happens</span>
            </div>
        `;

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request
            .mockResolvedValueOnce({ mainMeaning: "아무것도 없을 때가 좋아" })
            .mockResolvedValueOnce({ mainMeaning: "드라마나 애니메이션에서 듣는 대사처럼" });

        await controller.translateCurrentRealtimeCaption();
        document.querySelector(".ytp-caption-segment").textContent =
            "like a line from a drama or animation";
        await controller.translateCurrentRealtimeCaption();

        const requests = controller.channel.request.mock.calls.map((call) => call[1].text);
        expect(requests).toEqual([
            "I like it when nothing happens",
            "like a line from a drama or animation",
        ]);
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("드라마나 애니메이션에서 듣는 대사처럼");
        expect(overlay.textContent).not.toContain("아무것도 없을 때가 좋아");
    });

    it("keeps Google realtime captions from using context-merged prefetch cues", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">First visible line</span>
                <span class="ytp-caption-segment">Second visible line</span>
            </div>
        `;

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.cacheRealtimeCaptionTranslation(
            controller.getRealtimeCaptionCacheKey("First visible line", {
                sl: "en",
                tl: "ko",
                translatorId: "GoogleTranslate",
                engine: "",
            }),
            "첫 번째 선번역 자막"
        );
        controller.cacheRealtimeCaptionTranslation(
            controller.getRealtimeCaptionCacheKey("Second visible line", {
                sl: "en",
                tl: "ko",
                translatorId: "GoogleTranslate",
                engine: "",
            }),
            "두 번째 선번역 자막"
        );
        controller._captionPrefetchCues = controller.addYouTubeCaptionCueGroups([
            { startMs: 0, endMs: 5000, text: "First visible line" },
            { startMs: 0, endMs: 5000, text: "Second visible line" },
        ]);
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "첫 번째 보이는 줄\n두 번째 보이는 줄",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1].text).toBe(
            "First visible line\nSecond visible line"
        );
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("첫 번째 보이는 줄\n두 번째 보이는 줄");
        expect(overlay.textContent).not.toContain("선번역");
    });

    it("uses one visible caption window for Google realtime captions", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <div class="caption-window">
                    <span class="ytp-caption-segment">Primary line one</span>
                    <span class="ytp-caption-segment">Primary line two</span>
                </div>
                <div class="caption-window">
                    <span class="ytp-caption-segment">Secondary line one</span>
                    <span class="ytp-caption-segment">Secondary line two</span>
                </div>
            </div>
        `;

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "첫 번째 대표 줄\n두 번째 대표 줄",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1].text).toBe(
            "Primary line one\nPrimary line two"
        );
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("첫 번째 대표 줄\n두 번째 대표 줄");
    });

    it("deduplicates invisible duplicate YouTube caption segments before Google translation", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">I want to find the proof to my existence</span>
                <span class="ytp-caption-segment">\u200BI want to find the proof to my existence\uFEFF</span>
            </div>
        `;

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "내 존재의 증거를 찾고 싶다",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1].text).toBe(
            "I want to find the proof to my existence"
        );
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("내 존재의 증거를 찾고 싶다");
    });

    it("collapses repeated multiline YouTube caption blocks before Google translation", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <div class="caption-window">
                    <span class="ytp-caption-segment">
                        And I'll sing my first
                        and last experiment
                        \u200BAnd I'll sing my first
                        and last experiment\uFEFF
                    </span>
                </div>
            </div>
        `;

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "그리고 첫 번째 노래를 부를게요\n그리고 마지막 실험",
        });

        await controller.translateCurrentRealtimeCaption();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1].text).toBe(
            "And I'll sing my first\nand last experiment"
        );
        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(overlay.textContent).toBe("그리고 첫 번째 노래를 부를게요\n그리고 마지막 실험");
    });

    it("skips YouTube track prefetch for Google realtime captions", async () => {
        document.body.innerHTML = `<video src="movie.mp4"></video>`;

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller._captionOptionsCache = {
            sl: "en",
            tl: "ko",
            translatorId: "GoogleTranslate",
            engine: "",
        };
        controller._captionOptionsCacheAt = Date.now();
        const loadSpy = jest.spyOn(controller, "loadYouTubeCaptionPrefetchCues");

        await controller.prefetchYouTubeCaptionTrackAndWarmCache({ reschedule: false });

        expect(loadSpy).not.toHaveBeenCalled();
    });

    it("reads YouTube captions from caption windows when segment classes change", () => {
        document.body.innerHTML = `
            <div class="ytp-caption-window-container">
                <span>First live line</span>
                <span>second live line</span>
            </div>
        `;

        const controller = new BannerController();

        expect(controller.getCurrentYouTubeCaptionText()).toBe("First live line\nsecond live line");
    });

    it("prefers YouTube's active caption track when source language is auto", () => {
        document.body.innerHTML = `<div id="movie_player"></div>`;
        document.getElementById("movie_player").getOption = jest.fn(() => ({
            languageCode: "en",
            vssId: ".en",
        }));
        const controller = new BannerController();
        const tracks = [
            { languageCode: "es", vssId: ".es", baseUrl: "https://example.test/es" },
            { languageCode: "en", vssId: ".en", baseUrl: "https://example.test/en" },
        ];

        expect(controller.pickYouTubeCaptionTrack(tracks, { sl: "auto", tl: "ko" })).toBe(
            tracks[1]
        );
    });

    it("prefers YouTube's active caption track over a stale source language setting", () => {
        document.body.innerHTML = `<div id="movie_player"></div>`;
        document.getElementById("movie_player").getOption = jest.fn(() => ({
            languageCode: "en",
            vss_id: ".en.uploaded",
        }));
        const controller = new BannerController();
        const tracks = [
            { languageCode: "es", vssId: ".es", baseUrl: "https://example.test/es" },
            {
                languageCode: "en",
                vssId: ".en.uploaded",
                baseUrl: "https://example.test/en-uploaded",
            },
            { languageCode: "en", vssId: "a.en", baseUrl: "https://example.test/en-asr" },
        ];

        expect(controller.pickYouTubeCaptionTrack(tracks, { sl: "es", tl: "ko" })).toBe(tracks[1]);
    });

    it("backs off empty YouTube caption tracks instead of refetching every poll", async () => {
        window.ytInitialPlayerResponse = {
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            languageCode: "en",
                            vssId: ".en",
                            baseUrl: "https://example.test/captions",
                        },
                    ],
                },
            },
        };
        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                text: () => Promise.resolve('{"events":[]}'),
            })
        );
        const controller = new BannerController();
        const options = {
            sl: "auto",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "googleAiStudio",
        };

        await controller.loadYouTubeCaptionPrefetchCues(options);
        await controller.loadYouTubeCaptionPrefetchCues(options);

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("falls through empty YouTube caption tracks until a usable track is found", async () => {
        window.ytInitialPlayerResponse = {
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            languageCode: "es",
                            vssId: ".es",
                            baseUrl: "https://example.test/es",
                        },
                        {
                            languageCode: "en",
                            vssId: ".en",
                            baseUrl: "https://example.test/en",
                        },
                    ],
                },
            },
        };
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('{"events":[]}'),
            })
            .mockResolvedValueOnce({
                ok: true,
                text: () =>
                    Promise.resolve(
                        '{"events":[{"tStartMs":1000,"dDurationMs":1200,"segs":[{"utf8":"Useful cue."}]}]}'
                    ),
            });
        const controller = new BannerController();
        const options = {
            sl: "es",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "googleAiStudio",
        };

        await expect(controller.loadYouTubeCaptionPrefetchCues(options)).resolves.toBe(true);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(controller._captionPrefetchCues).toHaveLength(1);
        expect(controller._captionPrefetchCues[0].text).toBe("Useful cue.");
        expect(controller._captionPrefetchTrackKey).toContain("https://example.test/en");
    });

    it("backs off an all-empty YouTube caption track list", async () => {
        window.ytInitialPlayerResponse = {
            captions: {
                playerCaptionsTracklistRenderer: {
                    captionTracks: [
                        {
                            languageCode: "es",
                            vssId: ".es",
                            baseUrl: "https://example.test/es",
                        },
                        {
                            languageCode: "en",
                            vssId: ".en",
                            baseUrl: "https://example.test/en",
                        },
                    ],
                },
            },
        };
        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                text: () => Promise.resolve('{"events":[]}'),
            })
        );
        const controller = new BannerController();
        const options = {
            sl: "auto",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "googleAiStudio",
        };

        await controller.loadYouTubeCaptionPrefetchCues(options);
        await controller.loadYouTubeCaptionPrefetchCues(options);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(controller._captionPrefetchAllEmptyKey).toContain("https://example.test/es");
    });

    it("warms nearby AI captions in one marker-preserving request", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">Cue 13.</span>
            </div>
        `;
        const video = document.querySelector("video");
        Object.defineProperty(video, "currentTime", {
            configurable: true,
            value: 12.2,
        });

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        const options = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
        };
        controller._captionOptionsCache = options;
        controller._captionOptionsCacheAt = Date.now();
        controller._captionPrefetchBatchSize = 3;
        controller._captionPrefetchMaxInFlight = 3;
        controller._captionPrefetchCues = controller.addYouTubeCaptionCueGroups(
            Array.from({ length: 30 }, (_, index) => ({
                startMs: index * 1000,
                endMs: index * 1000 + 700,
                text: `Cue ${index + 1}.`,
            }))
        );
        controller.channel.request.mockImplementation((_eventName, request) => {
            const translated = String(request.text)
                .split("\n")
                .map((line, index) => {
                    const cueNumber = line.match(/Cue (\d+)\./)?.[1] || "0";
                    return `[[${index}]] 번역 ${cueNumber}`;
                })
                .join("\n");
            return Promise.resolve({ mainMeaning: translated });
        });

        controller.warmRealtimeCaptionPrefetchCache(options);
        await Promise.resolve();
        await Promise.resolve();

        expect(controller.channel.request).toHaveBeenCalledTimes(1);
        expect(controller.channel.request.mock.calls[0][1]).toMatchObject({
            text: "[[0]] Cue 12.\n[[1]] Cue 13.\n[[2]] Cue 14.",
            translationProfile: "realtimeCaptionBatch",
        });

        controller.channel.request.mockClear();
        await controller.translateCurrentRealtimeCaption();

        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(controller.channel.request).not.toHaveBeenCalled();
        expect(overlay.textContent).toBe("번역 13");
    });

    it("warms Google fast caption cache alongside AI pretranslation when configured", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
        `;
        Object.defineProperty(document.querySelector("video"), "currentTime", {
            configurable: true,
            value: 12.2,
        });

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        const options = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openai",
            fastTranslatorId: "GoogleTranslate",
        };
        controller._captionPrefetchBatchSize = 3;
        controller._captionFastPrefetchBatchSize = 3;
        controller._captionPrefetchCues = controller.addYouTubeCaptionCueGroups(
            Array.from({ length: 30 }, (_, index) => ({
                startMs: index * 1000,
                endMs: index * 1000 + 700,
                text: `Cue ${index + 1}.`,
            }))
        );
        controller.channel.request.mockImplementation((_eventName, request) => {
            if (request.translatorId === "GoogleTranslate") {
                return Promise.resolve({ mainMeaning: `빠른 ${request.text}` });
            }
            return Promise.resolve({
                mainMeaning: String(request.text)
                    .split("\n")
                    .map((line, index) => `[[${index}]] AI ${line.replace(/^\[\[\d+]]\s*/, "")}`)
                    .join("\n"),
            });
        });

        controller.warmRealtimeCaptionPrefetchCache(options);
        await Promise.resolve();
        await Promise.resolve();

        const requests = controller.channel.request.mock.calls.map((call) => call[1]);
        expect(
            requests.filter((request) => request.translatorId === "LocalTranslate")
        ).toHaveLength(1);
        expect(
            requests.filter((request) => request.translatorId === "GoogleTranslate")
        ).toHaveLength(3);
        expect(
            controller._captionTranslationCache.get(
                controller.getRealtimeCaptionCacheKey("Cue 13.", {
                    sl: "en",
                    tl: "ko",
                    translatorId: "GoogleTranslate",
                    engine: "",
                })
            )
        ).toBe("빠른 Cue 13.");
    });

    it("shows Google fast fallback for a live AI caption without later flicker", async () => {
        jest.useFakeTimers();
        try {
            const controller = new BannerController();
            controller._captionModeEnabled = true;
            controller._captionBatchDelayMs = 1;
            const options = {
                sl: "en",
                tl: "ko",
                translatorId: "LocalTranslate",
                engine: "googleAiStudio",
                fastTranslatorId: "GoogleTranslate",
            };
            controller.recordRealtimeCaptionVisibleSource("Very fast caption.");
            controller._captionLastSource = "Very fast caption.";
            let resolveAi;
            controller.channel.request.mockImplementation((_eventName, request) => {
                if (request.translatorId === "GoogleTranslate") {
                    return Promise.resolve({ mainMeaning: "빠른 구글 자막." });
                }
                return new Promise((resolve) => {
                    resolveAi = resolve;
                });
            });

            const translation = controller.translateRealtimeCaptionSource(
                "Very fast caption.",
                options
            );
            await Promise.resolve();
            await Promise.resolve();

            let overlay = document.getElementById("edge-translate-realtime-caption");
            expect(overlay.textContent).toBe("빠른 구글 자막.");

            jest.advanceTimersByTime(controller._captionBatchDelayMs);
            await Promise.resolve();
            resolveAi({ mainMeaning: "[[0]] 더 좋은 AI 자막." });
            await translation;

            overlay = document.getElementById("edge-translate-realtime-caption");
            expect(overlay.textContent).toBe("빠른 구글 자막.");
            expect(overlay.textContent).not.toContain("더 좋은 AI 자막.");
        } finally {
            jest.useRealTimers();
        }
    });

    it("uses prefetched active cue translations for multi-line visible captions", async () => {
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">First active cue.</span>
                <span class="ytp-caption-segment">Second active cue.</span>
            </div>
        `;
        const video = document.querySelector("video");
        Object.defineProperty(video, "currentTime", {
            configurable: true,
            value: 10,
        });

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        const options = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "googleAiStudio",
        };
        controller._captionOptionsCache = options;
        controller._captionOptionsCacheAt = Date.now();
        controller._captionPrefetchCues = controller.addYouTubeCaptionCueGroups([
            {
                startMs: 9500,
                endMs: 10500,
                text: "First active cue.",
            },
            {
                startMs: 9900,
                endMs: 11000,
                text: "Second active cue.",
            },
        ]);
        controller.cacheRealtimeCaptionTranslation(
            controller.getRealtimeCaptionCacheKey("First active cue.", options),
            "첫 번째 활성 자막."
        );
        controller.cacheRealtimeCaptionTranslation(
            controller.getRealtimeCaptionCacheKey("Second active cue.", options),
            "두 번째 활성 자막."
        );

        await controller.translateCurrentRealtimeCaption();

        const overlay = document.getElementById("edge-translate-realtime-caption");
        expect(controller.channel.request).not.toHaveBeenCalled();
        expect(overlay.textContent).toBe("첫 번째 활성 자막.\n두 번째 활성 자막.");
        expect(controller._captionDisplayItems.at(-1).text).toBe(
            "첫 번째 활성 자막.\n두 번째 활성 자막."
        );
    });

    it("records caption prefetch and display debug events when enabled", async () => {
        localStorage.setItem("edgeTranslate.captionDebug", "1");
        document.body.innerHTML = `
            <button class="ytp-subtitles-button" aria-pressed="true"></button>
            <video src="movie.mp4"></video>
            <div class="ytp-caption-window-container">
                <span class="ytp-caption-segment">Debug cue.</span>
            </div>
        `;
        Object.defineProperty(document.querySelector("video"), "currentTime", {
            configurable: true,
            value: 4,
        });

        const controller = new BannerController();
        controller._captionModeEnabled = true;
        controller.isYouTubePage = () => true;
        const options = {
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "googleAiStudio",
        };
        controller._captionOptionsCache = options;
        controller._captionOptionsCacheAt = Date.now();
        controller._captionPrefetchCues = controller.addYouTubeCaptionCueGroups([
            {
                startMs: 3500,
                endMs: 4500,
                text: "Debug cue.",
            },
        ]);
        controller.cacheRealtimeCaptionTranslation(
            controller.getRealtimeCaptionCacheKey("Debug cue.", options),
            "디버그 자막."
        );

        await controller.translateCurrentRealtimeCaption();

        const events = window.__edgeTranslateCaptionDebugEvents || [];
        expect(events.map((event) => event.event)).toEqual(
            expect.arrayContaining(["display:cache-hit", "display:show"])
        );
        expect(events.find((event) => event.event === "display:cache-hit")).toMatchObject({
            mode: "direct",
        });
        expect(
            JSON.parse(document.getElementById("edge-translate-caption-debug-log").textContent)
        ).toEqual(expect.arrayContaining([expect.objectContaining({ event: "display:show" })]));
    });

    it("merges tiny final page-translation batches into the previous request", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const entries = Array.from({ length: 50 }, (_, index) => ({
            sourceText: index < 48 ? `Entry ${index + 1}.` : "Tail.",
        }));

        expect(
            controller.buildDomPageTranslationBatches(entries).map((batch) => batch.length)
        ).toEqual([50]);
    });

    it("balances medium article pages into two parallel requests", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const entries = Array.from({ length: 122 }, (_, index) => ({
            sourceText: index === 0 ? "A".repeat(4211) : `Short ${index}.`,
        }));

        expect(
            controller.buildDomPageTranslationBatches(entries).map((batch) => batch.length)
        ).toEqual([64, 58]);
    });

    it("does not force compact-looking model names into one DOM unit per request", () => {
        const controller = new BannerController();
        const entries = Array.from({ length: 4 }, (_, index) => ({
            sourceText: `Paragraph ${index + 1}.`,
        }));

        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.4-mini",
            sl: "en",
            tl: "ko",
        };
        expect(controller.getDomPageTranslationGroupOptions()).toEqual({ maxChars: 12000 });
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 12000, maxItems: 64 });
        expect(
            controller.buildDomPageTranslationBatches(entries).map((batch) => batch.length)
        ).toEqual([4]);

        controller._domPageTranslateOptions = {
            engine: "googleAiStudio",
            model: "gemma-4-27b",
            sl: "en",
            tl: "ko",
        };
        expect(controller.getDomPageTranslationGroupOptions()).toEqual({ maxChars: 12000 });
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 12000, maxItems: 64 });
        expect(
            controller.buildDomPageTranslationBatches(entries).map((batch) => batch.length)
        ).toEqual([4]);

        controller._domPageTranslateOptions = {
            engine: "googleAiStudio",
            model: "gemini-3.1-flash-lite",
            sl: "en",
            tl: "ko",
        };
        expect(controller.getDomPageBatchOptions()).toEqual({ maxChars: 12000, maxItems: 64 });
        expect(
            controller.buildDomPageTranslationBatches(entries).map((batch) => batch.length)
        ).toEqual([4]);
    });

    it("keeps page translation cache across same-page article changes but resets DOM marks", () => {
        document.body.innerHTML = `<article><p id="line">Next article sentence.</p></article>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const node = document.getElementById("line").firstChild;
        const article = document.querySelector("article");

        controller.cacheDomPageTranslation("cached-key", "캐시된 번역");
        controller._translatedSet.add(node);
        controller._translatedBlocks.add(article);
        expect(controller.isMeaningfulDomPageTextNode(node)).toBe(false);

        controller.resetDomPageRuntimeState();

        expect(controller._domTranslationCache.get("cached-key")).toBe("캐시된 번역");
        expect(controller.isMeaningfulDomPageTextNode(node)).toBe(true);
    });

    it("skips site-chrome landmarks and keeps article text", () => {
        document.body.innerHTML = `
            <header role="banner"><nav id="nav">Account Settings</nav></header>
            <main><article><p id="article">This is the main article paragraph with enough context to translate naturally.</p></article></main>
            <footer id="footer">Privacy Policy</footer>
        `;
        const controller = new BannerController();
        const navNode = document.getElementById("nav").firstChild;
        const articleNode = document.getElementById("article").firstChild;
        const footerNode = document.getElementById("footer").firstChild;

        // Global nav + footer are repetitive site chrome — skipped so they don't cost tokens.
        expect(controller.isMeaningfulDomPageTextNode(navNode)).toBe(false);
        expect(controller.isMeaningfulDomPageTextNode(footerNode)).toBe(false);
        expect(controller.isMeaningfulDomPageTextNode(articleNode)).toBe(true);
        expect(controller.collectDomPageTextNodes([document.body])).toEqual([articleNode]);
    });

    it("keeps XDA-style article prose with ad insertion marker classes", () => {
        document.body.innerHTML = `
            <main>
                <article>
                    <section id="article-body" class="article-body adsninja-injected-repeatable-ad-beforeend">
                        <div class="content-block-regular">
                            <p id="lead" class="adsninja-injected-repeatable-ad-afterend">
                                This real article paragraph has enough natural prose to translate even though its class marks an ad insertion boundary.
                            </p>
                            <div id="ad" class="an-injected">Remove Ads googletag.display('slot')</div>
                            <p id="body">
                                The second article paragraph should remain eligible after the advertising container is skipped.
                            </p>
                        </div>
                    </section>
                </article>
            </main>
        `;
        const controller = new BannerController();
        const leadNode = document.getElementById("lead").firstChild;
        const adNode = document.getElementById("ad").firstChild;
        const bodyNode = document.getElementById("body").firstChild;

        expect(controller.isMeaningfulDomPageTextNode(leadNode)).toBe(true);
        expect(controller.isMeaningfulDomPageTextNode(adNode)).toBe(false);
        expect(controller.isMeaningfulDomPageTextNode(bodyNode)).toBe(true);
        expect(controller.collectDomPageTextNodes([document.getElementById("article-body")])).toEqual([
            leadNode,
            bodyNode,
        ]);
    });

    it("includes the article headline (h1 outside main) as a translation root", () => {
        document.body.innerHTML = `
            <header class="article-header">
                <h1 id="title">My Fire TV Stick has been so much better since I enabled this hidden setting</h1>
            </header>
            <main><article>
                <p>${"This is the article body paragraph with plenty of text. ".repeat(30)}</p>
            </article></main>
            <nav><h1 id="logo">XDA</h1></nav>
        `;
        const controller = new BannerController();
        const main = document.querySelector("main");
        const roots = controller.getDomPageTranslationRoots();

        // The narrowed content root PLUS the article headline that lives outside <main>.
        expect(roots).toContain(main);
        expect(roots).toContain(document.getElementById("title"));
        // A short logo <h1> inside the global nav is NOT pulled in as content.
        expect(roots).not.toContain(document.getElementById("logo"));
    });

    it("includes comment/discussion roots outside the narrowed main content root", () => {
        document.body.innerHTML = `
            <header>Global site navigation should stay out of translation roots.</header>
            <main><article>
                <p>${"This article body paragraph has enough text to be the primary content root. ".repeat(40)}</p>
            </article></main>
            <aside id="sidebar">Trending stories and newsletter links should not become roots.</aside>
            <section id="comments">
                <article class="comment">
                    <p id="comment-text">This reader comment should also be translated after the article.</p>
                </article>
            </section>
        `;
        const controller = new BannerController();
        const roots = controller.getDomPageTranslationRoots();

        expect(roots).toContain(document.querySelector("main"));
        expect(roots).toContain(document.getElementById("comments"));
        expect(roots).not.toContain(document.getElementById("sidebar"));
    });

    it("keeps article-footer discussion threads translatable while skipping normal footer chrome", () => {
        document.body.innerHTML = `
            <main><article>
                <p>${"This article body paragraph has enough text to be the primary content root. ".repeat(40)}</p>
            </article></main>
            <footer class="article-footer">
                <section id="reader-discussion" class="discussion-thread">
                    <p id="comment-rule">We want to hear from you. Share your perspective in the comments below.</p>
                </section>
                <div class="main-icon icon thread" aria-hidden="true"></div>
            </footer>
            <footer id="site-footer">
                <p id="site-copy">About Careers Advertise Privacy Policy Contact</p>
            </footer>
        `;
        const controller = new BannerController();
        const roots = controller.getDomPageTranslationRoots();

        expect(roots).toContain(document.getElementById("reader-discussion"));
        expect(roots).not.toContain(document.querySelector(".main-icon"));
        expect(controller.isMeaningfulDomPageTextNode(document.getElementById("comment-rule").firstChild)).toBe(
            true
        );
        expect(controller.isMeaningfulDomPageTextNode(document.getElementById("site-copy").firstChild)).toBe(
            false
        );
    });

    it("detects late-loaded comment text outside the current main root", () => {
        document.body.innerHTML = `
            <main><article>
                <p>${"This article body paragraph has enough text to be the primary content root. ".repeat(40)}</p>
            </article></main>
            <section id="comments"></section>
        `;
        const controller = new BannerController();
        controller.currentTranslator = "dom";
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domPageRootElements = [document.querySelector("main")];
        const paragraph = document.createElement("p");
        paragraph.textContent = "A late reader comment appears after the article has translated.";
        document.getElementById("comments").appendChild(paragraph);

        expect(
            controller.domPageMutationHasTranslatableCandidate({
                type: "childList",
                target: document.getElementById("comments"),
                addedNodes: [paragraph],
            })
        ).toBe(true);
        expect(controller.isNodeInDomPageTranslationRoot(paragraph.firstChild)).toBe(true);
    });

    it("translates in-content navigation (TOC/breadcrumbs) but still skips site-level nav", () => {
        document.body.innerHTML = `
            <nav id="global">Home Products About Contact</nav>
            <main><article>
                <nav id="toc">Introduction Methods Results Conclusion</nav>
                <p id="body">The article body paragraph with enough text to translate naturally.</p>
            </article></main>
        `;
        const controller = new BannerController();
        const globalNav = document.getElementById("global").firstChild;
        const tocNav = document.getElementById("toc").firstChild;
        const bodyNode = document.getElementById("body").firstChild;

        // Site-level nav (outside main/article) is repetitive chrome → skipped.
        expect(controller.isMeaningfulDomPageTextNode(globalNav)).toBe(false);
        // In-content nav (a table of contents inside the article) is real reading content.
        expect(controller.isMeaningfulDomPageTextNode(tocNav)).toBe(true);
        expect(controller.isMeaningfulDomPageTextNode(bodyNode)).toBe(true);
    });

    it("skips interactive button labels (Like / Log in / AI-assistant) as chrome", () => {
        // Real-page shape (xda-developers): action + AI-assistant buttons mixed into the article.
        document.body.innerHTML = `
            <main><article>
                <p id="prose">This is real article prose worth translating.</p>
                <button class="qa-action-item">Like</button>
                <button class="sensa-button">Explain it like I'm 5</button>
                <span role="button" id="rolebtn">Log in</span>
            </article></main>
        `;
        const controller = new BannerController();
        expect(
            controller.isMeaningfulDomPageTextNode(document.getElementById("prose").firstChild)
        ).toBe(true);
        // Button labels are UI controls → kept out of the batch (fewer segments = fewer drops).
        expect(
            controller.isMeaningfulDomPageTextNode(
                document.querySelector(".qa-action-item").firstChild
            )
        ).toBe(false);
        expect(
            controller.isMeaningfulDomPageTextNode(
                document.querySelector(".sensa-button").firstChild
            )
        ).toBe(false);
        expect(
            controller.isMeaningfulDomPageTextNode(document.getElementById("rolebtn").firstChild)
        ).toBe(false);
    });

    it("separates AI page translation cache by selected model", () => {
        document.body.innerHTML = `<p id="line">Shared source sentence.</p>`;
        const controller = new BannerController();
        const node = document.getElementById("line").firstChild;
        const group = {
            role: "paragraph",
            sourceText: "Shared source sentence.",
            nodes: [node],
            texts: ["Shared source sentence."],
        };

        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.4-mini",
            sl: "en",
            tl: "ko",
        };
        const miniEntry = controller.createDomPageTranslationEntry(group);
        delete group.sessionId;
        controller._domPageTranslateOptions = {
            engine: "openai",
            model: "gpt-5.5",
            sl: "en",
            tl: "ko",
        };
        const fullEntry = controller.createDomPageTranslationEntry(group);

        expect(miniEntry.cacheKey).not.toBe(fullEntry.cacheKey);
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
            ["[[1:t]]", "「会員アカウント」に対する不正ログインの発生のご報告"].join("\n")
        );
        expect(
            controller.unwrapDomPageRoleSegmentText(
                ["[[1:t]]", "회원 계정 무단 로그인 발생 보고"].join("\n"),
                1
            )
        ).toBe("회원 계정 무단 로그인 발생 보고");
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

    it("rejects hallucinated subtitle sample output for page translation", () => {
        document.body.innerHTML = `<p id="line">The model supports local inference.</p>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const node = document.getElementById("line").firstChild;
        const entry = controller.createDomPageTranslationEntry({
            role: "paragraph",
            sourceText: "The model supports local inference.",
            nodes: [node],
            texts: ["The model supports local inference."],
        });
        const hallucinated = [
            "1",
            "00:00:00,000 --> 00:00:04,000",
            "이것은 테스트입니다. 번역이 자연스럽게 이루어지는지 확인하고 있습니다.",
            "이 모델의 가장 큰 특징은 네이티브 오디오 입력 기능입니다.",
        ].join("\n");

        expect(controller.applyDomPageTranslatedEntry(entry, hallucinated)).toBe(false);
        expect(document.getElementById("line").textContent).toBe(
            "The model supports local inference."
        );
    });

    it("retries the same DOM translation unit when one batched segment is rejected", async () => {
        document.body.innerHTML = `
            <article>
                <p id="first">First source sentence with enough article context to remain the first prioritized entry.</p>
                <p id="second">Second source sentence with enough context to justify one focused retry.</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "textNodeBatch", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 1;
        controller.channel.request
            .mockResolvedValueOnce({
                mainMeaning: [
                    "[[1:p]]",
                    "첫 번째 문장.",
                    "[[2:p]]",
                    "1",
                    "00:00:00,000 --> 00:00:04,000",
                    "이것은 테스트입니다. 번역이 자연스럽게 이루어지는지 확인하고 있습니다.",
                ].join("\n"),
            })
            .mockResolvedValueOnce({
                mainMeaning: ["[[1:p]]", "두 번째 문장."].join("\n"),
            });

        controller.translateBatchNodes([
            document.getElementById("first").firstChild,
            document.getElementById("second").firstChild,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById("first").textContent).toBe("첫 번째 문장.");
        expect(document.getElementById("second").textContent).toBe("두 번째 문장.");
        expect(controller.channel.request).toHaveBeenCalledTimes(2);
    });

    it("does not spend a separate retry on short low-value rejected fragments", () => {
        document.body.innerHTML = `<aside><span id="line">Ad</span></aside>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const node = document.getElementById("line").firstChild;
        const entry = controller.createDomPageTranslationEntry({
            role: "text",
            sourceText: "Ad",
            nodes: [node],
            texts: ["Ad"],
        });

        expect(
            controller.retryDomPageEntryTranslation(entry, 0, { reason: "suspicious-line" })
        ).toBe(false);
        expect(controller._domTranslationQueue || []).toHaveLength(0);
        expect(controller.isMeaningfulDomPageTextNode(node)).toBe(false);
    });

    it("falls back to plain text nodes when an OpenAI-compatible model ignores page markers", async () => {
        document.body.innerHTML = `
            <article>
                <p id="line">Page translation should still replace this sentence.</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = {
            engine: "openaiCompatible",
            model: "plain-translator",
            sl: "en",
            tl: "ko",
        };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 1;
        controller.channel.request.mockResolvedValueOnce({
            mainMeaning: "페이지 번역은 이 문장도 바꿔야 합니다.",
        });
        const node = document.getElementById("line").firstChild;
        const entry = controller.createDomPageTranslationEntry({
            role: "paragraph",
            sourceText: "Page translation should still replace this sentence.",
            nodes: [node],
            texts: ["Page translation should still replace this sentence."],
        });

        expect(controller.retryDomPageEntryTranslation(entry, 0, { reason: "line-count" })).toBe(
            true
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById("line").textContent).toBe(
            "페이지 번역은 이 문장도 바꿔야 합니다."
        );
        expect(controller.channel.request).toHaveBeenCalledWith("translate_text_quiet", {
            text: "Page translation should still replace this sentence.",
            sl: "en",
            tl: "ko",
            translatorId: "LocalTranslate",
            engine: "openaiCompatible",
            translationProfile: "page",
        });
    });

    it("does not retry generic text groups that fail line-count validation", () => {
        document.body.innerHTML = `
            <div id="widget">
                <span id="first">A generic navigation fragment</span>
                <span id="second">Another generic fragment with no article role</span>
            </div>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const firstNode = document.getElementById("first").firstChild;
        const secondNode = document.getElementById("second").firstChild;
        const sourceText = `${firstNode.nodeValue}\n${secondNode.nodeValue}`.repeat(8);
        const entry = controller.createDomPageTranslationEntry({
            role: "text",
            sourceText,
            nodes: [firstNode, secondNode],
            texts: [firstNode.nodeValue, secondNode.nodeValue],
        });

        expect(controller.retryDomPageEntryTranslation(entry, 0, { reason: "line-count" })).toBe(
            false
        );
        expect(controller._domTranslationQueue || []).toHaveLength(0);
        expect(controller.isMeaningfulDomPageTextNode(firstNode)).toBe(false);
        expect(controller.isMeaningfulDomPageTextNode(secondNode)).toBe(false);
    });

    it("collects comment-like text instead of treating comments as token-skipped widgets", () => {
        document.body.innerHTML = `
            <section class="article-comments">
                <p id="comment">This late comment should also be translated.</p>
            </section>
            <article>
                <p id="body">This article paragraph should remain eligible for translation.</p>
            </article>
        `;
        const controller = new BannerController();
        const commentNode = document.getElementById("comment").firstChild;
        const bodyNode = document.getElementById("body").firstChild;

        expect(controller.isMeaningfulDomPageTextNode(commentNode)).toBe(true);
        expect(controller.isMeaningfulDomPageTextNode(bodyNode)).toBe(true);
        expect(controller.collectDomPageTextNodes([document.body])).toEqual([
            commentNode,
            bodyNode,
        ]);
    });

    it("does not collect retry-exhausted nodes during coverage scans", () => {
        document.body.innerHTML = `<article><p id="line">Small failing source.</p></article>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const node = document.getElementById("line").firstChild;
        const entry = controller.createDomPageTranslationEntry({
            role: "paragraph",
            sourceText: "Small failing source.",
            nodes: [node],
            texts: ["Small failing source."],
        });

        controller.retryDomPageEntryTranslation(entry, 1);

        expect(controller.isMeaningfulDomPageTextNode(node)).toBe(false);
        expect(controller.collectDomPageTextNodes([document.body])).toEqual([]);
        expect(controller._domTranslationQueue || []).toHaveLength(0);
    });

    it("keeps parallel page translation responses applied in DOM order", async () => {
        document.body.innerHTML = `
            <article>
                <p id="first">First source sentence.</p>
                <p id="second">Second source sentence.</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "textNodeBatch", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 2;
        const firstNode = document.getElementById("first").firstChild;
        const secondNode = document.getElementById("second").firstChild;
        [firstNode, secondNode].forEach((node) => controller._domPendingTextNodes.add(node));
        const firstEntry = controller.assignDomPageApplySequence(
            controller.createDomPageTranslationEntry({
                role: "paragraph",
                sourceText: "First source sentence.",
                nodes: [firstNode],
                texts: ["First source sentence."],
            })
        );
        const secondEntry = controller.assignDomPageApplySequence(
            controller.createDomPageTranslationEntry({
                role: "paragraph",
                sourceText: "Second source sentence.",
                nodes: [secondNode],
                texts: ["Second source sentence."],
            })
        );
        let resolveFirst;
        let resolveSecond;
        const firstPromise = new Promise((resolve) => {
            resolveFirst = resolve;
        });
        const secondPromise = new Promise((resolve) => {
            resolveSecond = resolve;
        });
        controller.channel.request
            .mockImplementationOnce(() => firstPromise)
            .mockImplementationOnce(() => secondPromise);

        controller.enqueueDomPageBatchTranslation([firstEntry]);
        controller.enqueueDomPageBatchTranslation([secondEntry]);
        await Promise.resolve();

        resolveSecond({
            mainMeaning: ["[[1:p]]", "두 번째 문장."].join("\n"),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(document.getElementById("first").textContent).toBe("First source sentence.");
        expect(document.getElementById("second").textContent).toBe("Second source sentence.");

        resolveFirst({
            mainMeaning: ["[[1:p]]", "첫 번째 문장."].join("\n"),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(document.getElementById("first").textContent).toBe("첫 번째 문장.");
        expect(document.getElementById("second").textContent).toBe("두 번째 문장.");
    });

    it("does not leave ordered page applies blocked when the circuit breaker opens", async () => {
        document.body.innerHTML = `
            <article>
                <p id="first">First source sentence.</p>
                <p id="second">Second source sentence.</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "textNodeBatch", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domMaxConcurrentTranslations = 1;
        const firstNode = document.getElementById("first").firstChild;
        const secondNode = document.getElementById("second").firstChild;
        [firstNode, secondNode].forEach((node) => controller._domPendingTextNodes.add(node));
        const firstEntry = controller.assignDomPageApplySequence(
            controller.createDomPageTranslationEntry({
                role: "paragraph",
                sourceText: "First source sentence.",
                nodes: [firstNode],
                texts: ["First source sentence."],
            })
        );
        const secondEntry = controller.assignDomPageApplySequence(
            controller.createDomPageTranslationEntry({
                role: "paragraph",
                sourceText: "Second source sentence.",
                nodes: [secondNode],
                texts: ["Second source sentence."],
            })
        );
        controller._domTotalTranslationEntries = 2;
        controller._domCircuitBreakerActive = true;

        controller.enqueueDomPageBatchTranslation([firstEntry]);
        controller.enqueueDomPageBatchTranslation([secondEntry]);
        await Promise.resolve();
        await Promise.resolve();

        expect(controller._domPendingTextNodes.has(firstNode)).toBe(false);
        expect(controller._domPendingTextNodes.has(secondNode)).toBe(false);
        expect(controller._domPendingApplies.size).toBe(0);
        expect(controller._domNextApplySequence).toBe(2);
        expect(controller._domCompletedTranslationEntries).toBeGreaterThanOrEqual(2);
    });

    it("does not apply stale page translation responses after article text changes", () => {
        document.body.innerHTML = `<article><p id="line">Old article sentence.</p></article>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "textNodeBatch", sl: "en", tl: "ko" };
        const node = document.getElementById("line").firstChild;
        controller._domPendingTextNodes.add(node);
        const entry = controller.assignDomPageApplySequence(
            controller.createDomPageTranslationEntry({
                role: "paragraph",
                sourceText: "Old article sentence.",
                nodes: [node],
                texts: ["Old article sentence."],
            })
        );

        node.nodeValue = "New article sentence.";
        controller.queueDomPageEntryApply(entry, "예전 글 번역.");

        expect(document.getElementById("line").textContent).toBe("New article sentence.");
        expect(controller._domPendingTextNodes.has(node)).toBe(false);
    });

    it("does not collect original-tooltip text from translated spans for API input", () => {
        document.body.innerHTML = `<p id="line">Original sentence.</p>`;
        const controller = new BannerController();
        controller._domPageRootElements = [document.body];
        const node = document.getElementById("line").firstChild;

        controller.applyWithFadeIn(node, "번역된 문장.", "text", "Original sentence.");
        const translatedSpan = document.querySelector(".et-dom-translated-text");
        const nodes = controller.collectDomPageTextNodes(controller._domPageRootElements);

        expect(translatedSpan.textContent).toBe("번역된 문장.");
        expect(nodes).toHaveLength(0);
    });

    it("shows original text tooltip for AI page translated content", () => {
        jest.useFakeTimers();
        try {
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
            const translatedSpan = paragraph.querySelector(".et-dom-translated-text");
            const tooltipTarget = translatedSpan || paragraph;
            expect(paragraph.textContent).toBe("번역된 문장.");
            expect(tooltipTarget).not.toBeNull();
            expect(tooltipTarget.classList.contains("et-dom-original-source")).toBe(false);
            expect(document.getElementById("edge-translate-dom-original-tooltip")).toBeNull();

            tooltipTarget.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            expect(document.getElementById("edge-translate-dom-original-tooltip")).toBeNull();
            jest.advanceTimersByTime(260);
            const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip).not.toBeNull();
            expect(tooltip.dataset.visible).toBe("true");
            expect(tooltipTarget.classList.contains("et-dom-original-source")).toBe(true);
            expect(tooltip.textContent).toContain("원문 텍스트");
            expect(tooltip.textContent).toContain("Original sentence.");

            controller.cancelDomPageTranslate();
            expect(document.getElementById("edge-translate-dom-original-tooltip")).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    it("preserves hyperlink boundary spacing when translating inline text nodes", () => {
        document.body.innerHTML = `<p id="line"><a id="link">LM Studio</a> is my default runner.</p>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const paragraph = document.getElementById("line");
        const linkNode = document.getElementById("link").firstChild;
        const trailingNode = paragraph.childNodes[1];

        controller.applyWithFadeIn(linkNode, "LM Studio는", "text", "LM Studio");
        controller.applyWithFadeIn(
            trailingNode,
            "내 기본 러너입니다.",
            "text",
            " is my default runner."
        );

        expect(paragraph.textContent).toBe("LM Studio는 내 기본 러너입니다.");
    });

    it("translates HTML-native paragraphs with inline links as one natural sentence", () => {
        jest.useFakeTimers();
        let controller;
        try {
            document.body.innerHTML = `<p id="line"><a id="link" href="https://example.com/lm-studio">LM Studio</a> has been my default runner for local LLMs.</p>`;
            controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "googleAiStudio",
                sl: "en",
                tl: "ko",
            };
            const paragraph = document.getElementById("line");
            const entry = controller.createDomPageTranslationEntry({
                block: paragraph,
                role: "paragraph",
                nodes: [document.getElementById("link").firstChild, paragraph.childNodes[1]],
                texts: ["LM Studio", "has been my default runner for local LLMs."],
                sourceText: "LM Studio\nhas been my default runner for local LLMs.",
            });

            expect(entry.htmlMode).toBe(true);
            expect(entry.sourceText).toContain("<a");
            expect(
                controller.applyDomPageTranslatedEntry(
                    entry,
                    "나는 <a>LM Studio</a>를 로컬 LLM의 기본 실행기로 사용해 왔다."
                )
            ).toBe(true);

            const restoredLink = paragraph.querySelector("a");
            expect(paragraph.textContent).toBe(
                "나는 LM Studio를 로컬 LLM의 기본 실행기로 사용해 왔다."
            );
            expect(restoredLink).not.toBeNull();
            expect(restoredLink.href).toBe("https://example.com/lm-studio");
            expect(restoredLink.textContent).toBe("LM Studio");

            paragraph.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);
            const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip.textContent).toContain(
                "LM Studio has been my default runner for local LLMs."
            );
        } finally {
            if (controller) controller.cancelDomPageTranslate();
            jest.useRealTimers();
        }
    });

    it("preserves inline links when a paragraph is retried as a single group", async () => {
        document.body.innerHTML = `<p id="line"><a id="link" href="https://example.com/account">Account notice</a> is available.</p>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller.channel.request.mockResolvedValue({
            mainMeaning: "자세한 내용은 <a>계정 공지</a>를 확인해 주세요.",
        });
        const paragraph = document.getElementById("line");
        const group = {
            block: paragraph,
            role: "paragraph",
            nodes: [document.getElementById("link").firstChild, paragraph.childNodes[1]],
            texts: ["Account notice", "is available."],
            sourceText: "Account notice\nis available.",
        };

        controller.enqueueDomPageGroupTranslation(group);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const restoredLink = paragraph.querySelector("a");
        expect(paragraph.textContent).toBe("자세한 내용은 계정 공지를 확인해 주세요.");
        expect(restoredLink).not.toBeNull();
        expect(restoredLink.href).toBe("https://example.com/account");
        expect(restoredLink.textContent).toBe("계정 공지");
        expect(controller._domTranslationCache.size).toBe(1);
    });

    it("uses HTML-native payloads for linked blocks instead of link placeholders", () => {
        document.body.innerHTML = `<p id="line"><a href="https://example.com/account">Account notice</a> is available.</p>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const paragraph = document.getElementById("line");
        const group = {
            block: paragraph,
            role: "paragraph",
            nodes: [paragraph.querySelector("a").firstChild, paragraph.childNodes[1]],
            texts: ["Account notice", "is available."],
            sourceText: "Account notice\nis available.",
        };
        const entry = controller.createDomPageTranslationEntry(group);

        expect(entry.htmlMode).toBe(true);
        expect(entry.sourceText).toContain("<a");
    });

    it("shows original text for the hovered HTML-native translated block", () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `<p id="line">First original sentence.<br>Second original sentence.</p>`;
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            const paragraph = document.getElementById("line");
            const nodes = [paragraph.childNodes[0], paragraph.childNodes[2]];
            const entry = controller.createDomPageTranslationEntry({
                role: "text",
                sourceText: "First original sentence.\nSecond original sentence.",
                nodes,
                texts: ["First original sentence.", "Second original sentence."],
            });

            expect(controller.applyDomPageTranslatedEntry(entry, "첫 문장.<br>둘째 문장.")).toBe(
                true
            );

            paragraph.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);
            const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip.textContent).toContain("First original sentence.");
            expect(tooltip.textContent).toContain("Second original sentence.");

            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("shows original text for hovered AI section translated children", () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <article id="article">
                    <p id="line">Original <strong>section</strong> sentence.</p>
                </article>
            `;
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            const article = document.getElementById("article");
            const paragraph = document.getElementById("line");
            const entry = {
                cacheKey: "section-tooltip",
                segBlocks: [paragraph],
                section: {
                    parent: article,
                    children: [paragraph],
                    plainText: "Original section sentence.",
                    role: "paragraph",
                },
            };
            // dispatch snapshots the originals before any translation; mirror that here.
            entry.originalCapture = controller.captureAiPageSectionOriginalTexts(entry, 0);

            expect(
                controller.applyAiPageSectionTranslation(
                    entry,
                    `[[1]]\n번역된 <strong>섹션</strong> 문장.`
                )
            ).toBe(true);

            const translatedParagraph = document.getElementById("line");
            expect(translatedParagraph.textContent).toBe("번역된 섹션 문장.");
            translatedParagraph.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);

            const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip).not.toBeNull();
            expect(tooltip.textContent).toContain("Original section sentence.");
            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("strips source-plus-translation AI segments before apply, cache, and tooltip registration", () => {
        jest.useFakeTimers();
        try {
            const source =
                "It is easy to get swept up in the LLM race. For a while, my credit card statement was lined with a list of premium AI subscription services.";
            const korean =
                "LLM 경쟁에 휩쓸리기란 쉽습니다. 한동안 제 신용카드 명세서에는 프리미엄 AI 구독 서비스 목록이 줄지어 찍혀 있었습니다.";
            document.body.innerHTML = `
                <article id="article">
                    <p id="line">${source}</p>
                </article>
            `;
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            const article = document.getElementById("article");
            const paragraph = document.getElementById("line");
            const entry = {
                cacheKey: "bilingual-segment",
                segBlocks: [paragraph],
                segTexts: [source],
                sourceText: `[[1]]\n${source}`,
                plainText: source,
                section: {
                    parent: article,
                    children: [paragraph],
                    plainText: source,
                    role: "paragraph",
                },
            };
            entry.originalCapture = controller.captureAiPageSectionOriginalTexts(entry, 0);
            const appliedSet = new Set();

            expect(
                controller.applyAiPageSectionTranslation(
                    entry,
                    `[[1]]\n${source}\n\n${korean}`,
                    appliedSet
                )
            ).toBe(true);

            expect(paragraph.textContent).toBe(korean);
            expect(paragraph.textContent).not.toContain("It is easy");
            expect(controller.getCachedSegmentText(source)).toBe(korean);
            expect(controller._domOriginalTextByElement.get(paragraph)).toBe(source);

            paragraph.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);
            const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip.textContent).toContain(source);
            expect(tooltip.textContent).not.toContain(korean);
            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("rejects source-language paraphrases returned as AI page translations", () => {
        const source =
            "It's easy to get caught up in the LLM race. For a while, my monthly credit card statement read like a lineup of premium AI subscriptions.";
        const englishParaphrase =
            "It is easy to get swept up in the LLM race. For a while, my credit card statement was lined with a list of premium AI subscription services.";
        document.body.innerHTML = `
            <article id="article">
                <p id="line">${source}</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domPageRootElements = [document.getElementById("article")];
        const paragraph = document.getElementById("line");
        const entry = {
            cacheKey: "english-paraphrase",
            segBlocks: [paragraph],
            segTexts: [source],
            sourceText: `[[1]]\n${source}`,
            plainText: source,
            section: {
                parent: document.getElementById("article"),
                children: [paragraph],
                plainText: source,
                role: "paragraph",
            },
        };
        entry.originalCapture = controller.captureAiPageSectionOriginalTexts(entry, 0);

        expect(
            controller.applyAiPageSectionTranslation(
                entry,
                `[[1]]\n${englishParaphrase}`,
                new Set()
            )
        ).toBe(false);
        expect(paragraph.textContent).toBe(source);
        expect(controller.getCachedSegmentText(source)).toBeNull();
        expect(controller.isAiPageSectionElementEligible(paragraph)).toBe(true);
    });

    it("rejects long AI section outputs that never enter the target script", () => {
        const source =
            "Gemini can pull details from your files and turn them into a useful itinerary for your trip.";
        const englishRewrite =
            "This tool can retrieve information from documents and create a helpful travel plan for an upcoming journey.";
        document.body.innerHTML = `
            <article id="article">
                <p id="line">${source}</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        controller._domPageRootElements = [document.getElementById("article")];
        const paragraph = document.getElementById("line");
        const entry = {
            cacheKey: "english-rewrite",
            segBlocks: [paragraph],
            segTexts: [source],
            sourceText: `[[1]]\n${source}`,
            plainText: source,
            section: {
                parent: document.getElementById("article"),
                children: [paragraph],
                plainText: source,
                role: "paragraph",
            },
        };
        entry.originalCapture = controller.captureAiPageSectionOriginalTexts(entry, 0);

        expect(
            controller.applyAiPageSectionTranslation(entry, `[[1]]\n${englishRewrite}`, new Set())
        ).toBe(false);
        expect(paragraph.textContent).toBe(source);
        expect(controller.getCachedSegmentText(source)).toBeNull();
        expect(controller.isAiPageSectionElementEligible(paragraph)).toBe(true);
    });

    it("rejects source-language paraphrases from legacy DOM page batches", () => {
        const source =
            "It's easy to get caught up in the LLM race. For a while, my monthly credit card statement read like a lineup of premium AI subscriptions.";
        const englishParaphrase =
            "It is easy to get swept up in the LLM race. For a while, my credit card statement was lined with a list of premium AI subscription services.";
        document.body.innerHTML = `
            <article id="article">
                <p id="line">${source}</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        const paragraph = document.getElementById("line");
        const entry = controller.createDomPageTranslationEntry({
            block: paragraph,
            role: "paragraph",
            sourceText: source,
            nodes: [paragraph.firstChild],
            texts: [source],
        });

        controller.applyDomPageEntryNow(entry, englishParaphrase);

        expect(paragraph.textContent).toBe(source);
        expect(controller._domTranslationCache.has(entry.cacheKey)).toBe(false);
        expect(controller._domOriginalTextByElement.get(paragraph)).toBeUndefined();
    });

    it("strips source chunks from legacy DOM page batches before apply and cache", () => {
        const source =
            "It's easy to get caught up in the LLM race. For a while, my monthly credit card statement read like a lineup of premium AI subscriptions.";
        const korean =
            "LLM 경쟁에 휩쓸리기란 쉽습니다. 한동안 제 월간 신용카드 명세서에는 프리미엄 AI 구독 서비스 목록이 줄지어 찍혀 있었습니다.";
        document.body.innerHTML = `
            <article id="article">
                <p id="line">${source}</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        controller._domResolvedSourceLanguage = "en";
        const paragraph = document.getElementById("line");
        const entry = controller.createDomPageTranslationEntry({
            block: paragraph,
            role: "paragraph",
            sourceText: source,
            nodes: [paragraph.firstChild],
            texts: [source],
        });

        controller.applyDomPageEntryNow(entry, `${source}\n\n${korean}`);

        expect(paragraph.textContent).toBe(korean);
        expect(controller._domTranslationCache.get(entry.cacheKey)).toBe(korean);
        expect(controller._domOriginalTextByElement.get(paragraph)).toBe(source);
    });

    it("does not stream-apply source echoes, but keeps the target chunk from bilingual segments", () => {
        const source =
            "It is easy to get swept up in the LLM race when every service has an upgrade.";
        const second = "Another English paragraph waits for translation.";
        const korean = "모든 서비스에 업그레이드가 붙으면 LLM 경쟁에 휩쓸리기 쉽습니다.";
        document.body.innerHTML = `
            <article id="article">
                <p id="first">${source}</p>
                <p id="second">${second}</p>
            </article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const entry = {
            segBlocks: [document.getElementById("first"), document.getElementById("second")],
            segTexts: [source, second],
        };
        const appliedSet = new Set();

        controller.applyStreamedAiPageSegments(entry, `[[1]]\n${source}\n[[2]]\n`, appliedSet);
        expect(document.getElementById("first").textContent).toBe(source);
        expect(appliedSet.has(1)).toBe(false);

        controller.applyStreamedAiPageSegments(
            entry,
            `[[1]]\n${source}\n\n${korean}\n[[2]]\n`,
            appliedSet
        );
        expect(document.getElementById("first").textContent).toBe(korean);
        expect(appliedSet.has(1)).toBe(true);
    });

    it("keeps original text tooltips for streamed AI section children", async () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = `
                <article id="article">
                    <p id="first">First original sentence.</p>
                    <p id="second">Second original sentence.</p>
                </article>
            `;
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            let streamHandler = null;
            controller.channel.on = jest.fn((event, handler) => {
                if (event === "translation_stream_progress") streamHandler = handler;
            });
            controller.channel.off = jest.fn();
            controller.channel.request.mockImplementation(async (_service, payload) => {
                streamHandler({
                    streamId: payload.streamId,
                    text: `[[1]]\n첫 문장.\n[[2]]`,
                });
                return {
                    mainMeaning: `[[1]]\n첫 문장.\n[[2]]\n둘째 문장.`,
                };
            });
            const article = document.getElementById("article");
            const first = document.getElementById("first");
            const second = document.getElementById("second");
            const entry = {
                cacheKey: "streamed-section-tooltip",
                segBlocks: [first, second],
                segTexts: ["First original sentence.", "Second original sentence."],
                sourceText: "[[1]]\nFirst original sentence.\n[[2]]\nSecond original sentence.",
                plainText: "First original sentence. Second original sentence.",
                attempt: 0,
                sessionId: controller._domTranslationSessionId,
                section: {
                    parent: article,
                    children: [first, second],
                    plainText: "First original sentence. Second original sentence.",
                    role: "paragraph",
                },
            };
            entry.originalCapture = controller.captureAiPageSectionOriginalTexts(entry, 0);

            controller.enqueueAiPageSectionTranslation(entry);
            for (let i = 0; i < 5; i += 1) await Promise.resolve();

            expect(first.textContent).toBe("첫 문장.");
            expect(second.textContent).toBe("둘째 문장.");
            expect(controller.getDomOriginalTooltipTarget(first)).toBe(first);
            expect(controller.getDomOriginalTooltipTarget(second)).toBe(second);

            first.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);
            let tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip.textContent).toContain("First original sentence.");

            first.dispatchEvent(
                new MouseEvent("mouseout", {
                    bubbles: true,
                    relatedTarget: null,
                })
            );
            second.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);
            tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip.textContent).toContain("Second original sentence.");
            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("collects content text in DOM order, skipping chrome, without viewport prioritization", () => {
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

        expect(controller._domPageRootElements[0].tagName).toBe("BODY");
        // <nav> chrome is skipped; remaining content stays in DOM order (not viewport order).
        expect(nodes.map((node) => node.nodeValue.trim())).toEqual([
            "Visible article text",
            "Deferred article text",
        ]);
    });

    describe("stripPromptEchoFromTranslation", () => {
        it("removes echoed prompt instruction lines from translated text", () => {
            const controller = new BannerController();
            const input = [
                "Source language: English",
                "Target language: Korean",
                "안녕하세요. 이것은 번역된 텍스트입니다.",
            ].join("\n");
            expect(controller.stripPromptEchoFromTranslation(input)).toBe(
                "안녕하세요. 이것은 번역된 텍스트입니다."
            );
        });

        it("removes 'Output only the translation' echo lines", () => {
            const controller = new BannerController();
            const input = "Output only the translation.\n번역 결과입니다.";
            expect(controller.stripPromptEchoFromTranslation(input)).toBe("번역 결과입니다.");
        });

        it("removes bare language label lines like 'Korean:'", () => {
            const controller = new BannerController();
            const input = "Korean:\n한국어 번역 텍스트입니다.";
            expect(controller.stripPromptEchoFromTranslation(input)).toBe(
                "한국어 번역 텍스트입니다."
            );
        });

        it("collapses excessive blank lines from stripping", () => {
            const controller = new BannerController();
            const input = "Source language: en\n\n\n\nTarget language: ko\n\n\n\n실제 번역 내용.";
            expect(controller.stripPromptEchoFromTranslation(input)).toBe("실제 번역 내용.");
        });

        it("returns clean text unchanged", () => {
            const controller = new BannerController();
            const clean = "이것은 정상적인 번역 결과입니다.";
            expect(controller.stripPromptEchoFromTranslation(clean)).toBe(clean);
        });

        it("returns empty string for empty or null input", () => {
            const controller = new BannerController();
            expect(controller.stripPromptEchoFromTranslation("")).toBe("");
            expect(controller.stripPromptEchoFromTranslation(null)).toBe("");
        });
    });

    describe("isSuspiciousDomPageTranslation", () => {
        it("accepts a clean translation from a local LLM", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openaiCompatible" };
            expect(
                controller.isSuspiciousDomPageTranslation("Hello world", "안녕하세요 세계")
            ).toBe(false);
        });

        it("accepts translation with prompt echo after stripping", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openaiCompatible" };
            const translated = "Source language: English\nTarget language: Korean\n안녕하세요 세계";
            expect(controller.isSuspiciousDomPageTranslation("Hello world", translated)).toBe(
                false
            );
        });

        it("rejects translation that is entirely prompt echo with no content", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openaiCompatible" };
            const translated = "Source language: English\nTarget language: Korean";
            expect(controller.isSuspiciousDomPageTranslation("Hello world", translated)).toBe(true);
        });

        it("rejects empty translations", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openaiCompatible" };
            expect(controller.isSuspiciousDomPageTranslation("Hello", "")).toBe(true);
            expect(controller.isSuspiciousDomPageTranslation("Hello", null)).toBe(true);
        });

        it("still rejects <<<EDGE_TRANSLATE_SEGMENT_ markers", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openaiCompatible" };
            expect(
                controller.isSuspiciousDomPageTranslation(
                    "Hello",
                    "<<<EDGE_TRANSLATE_SEGMENT_1>>>번역"
                )
            ).toBe(true);
        });

        it("uses relaxed foreign token threshold for openaiCompatible", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openaiCompatible" };
            // 6 foreign tokens — below the relaxed threshold of 8
            const translated = "번역된 텍스트 about something with various words tokens here.";
            expect(controller.isSuspiciousDomPageTranslation("원문 텍스트", translated)).toBe(
                false
            );
        });

        it("uses strict foreign token threshold for openai (non-compatible)", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai" };
            // 6 foreign tokens — above the strict threshold of 4 for non-local
            const translated = "번역된 텍스트 about something with various words tokens here.";
            expect(controller.isSuspiciousDomPageTranslation("원문 텍스트", translated)).toBe(true);
        });

        it("does not flag [[n:r]] segment markers as suspicious", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openaiCompatible" };
            expect(controller.isSuspiciousDomPageTranslation("Hello", "[[1:p]]\n안녕하세요")).toBe(
                false
            );
        });
    });
});
