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
        expect(refs.querySelector("[data-role='status']").textContent).toBe("Translation complete");
        expect(refs.querySelector("[data-role='progress-meta']").textContent).toBe("100%");

        controller._domCoverageStableScanCount = 1;
        controller.updateDomPageBannerStatus();

        expect(refs.querySelector("[data-role='bar']").dataset.state).toBe("complete");
        expect(refs.querySelector("[data-role='status']").textContent).toBe("Translation complete");
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
        expect(refs.querySelector("[data-role='status']").textContent).toBe("Translation complete");
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
        // This test isolates the stream-vs-batch split, which is orthogonal to lazy windowing;
        // disable lazy so the far-offscreen section is enqueued (batched) rather than deferred.
        controller._aiPageConfig = controller.normalizeAiPageConfig({ lazyTranslate: false });
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

    it("defers far-offscreen AI sections for lazy on-scroll translation", () => {
        document.body.innerHTML = `
            <article>
                <p id="visible">Visible source paragraph long enough to translate.</p>
                <h2 id="farHead">Far offscreen heading</h2>
                <p id="farBody">Far offscreen source paragraph long enough to translate.</p>
            </article>
        `;
        document.getElementById("visible").getBoundingClientRect = () => ({
            top: 10,
            bottom: 40,
            width: 200,
            height: 30,
        });
        // ~12 screens down (well beyond the ~3.5-screen lazy window) → must be deferred.
        document.getElementById("farHead").getBoundingClientRect = () => ({
            top: 9000,
            bottom: 9030,
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
        // Lazy on by default (constructor), but tokenBudget 0 here so only viewport distance drives
        // the deferral (not the budget) — keeps the assertion about the far section unambiguous.
        controller._aiPageConfig = controller.normalizeAiPageConfig({
            lazyTranslate: true,
            tokenBudget: 0,
        });
        controller.currentTranslator = "dom";
        controller._domResolvedSourceLanguage = "en";
        controller._domPageRootElements = [document.body];
        controller.getAiPageSectionMinChars = () => 10;
        controller.enqueueAiPageSectionTranslation = jest.fn();
        controller.enqueueAiPageSectionBatchTranslation = jest.fn();

        controller.dispatchAiPageSections();

        // The visible section streams; the far-offscreen section is deferred (never enqueued).
        expect(controller.enqueueAiPageSectionTranslation).toHaveBeenCalledTimes(1);
        expect(controller.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();
        expect(controller.enqueueAiPageSectionTranslation.mock.calls[0][0].plainText).toContain(
            "Visible source"
        );
        // The deferred section's leading element is tracked for the lazy reveal path...
        expect(controller._domHasDeferredSections).toBe(true);
        const deferredAnchors = Array.from(controller._domLazyDeferredChildren.keys());
        expect(deferredAnchors.some((el) => el.id === "farHead")).toBe(true);

        // ...and revealing it queues the section for a gap-fill (re-collection) dispatch.
        const anchor = deferredAnchors.find((el) => el.id === "farHead");
        controller.scheduleAiPageLazyReveal = jest.fn();
        controller.onAiPageLazyAnchorsIntersect([{ isIntersecting: true, target: anchor }]);
        expect(controller.scheduleAiPageLazyReveal).toHaveBeenCalledTimes(1);
        expect(controller.isElementRelatedToDomGapCandidate(anchor)).toBe(true);
    });

    it("translates the whole page in one wave when lazy translation is disabled", () => {
        document.body.innerHTML = `
            <article>
                <p id="visible">Visible source paragraph long enough to translate.</p>
                <h2 id="farHead">Far offscreen heading</h2>
                <p id="farBody">Far offscreen source paragraph long enough to translate.</p>
            </article>
        `;
        document.getElementById("visible").getBoundingClientRect = () => ({
            top: 10,
            bottom: 40,
            width: 200,
            height: 30,
        });
        document.getElementById("farHead").getBoundingClientRect = () => ({
            top: 9000,
            bottom: 9030,
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
        controller._aiPageConfig = controller.normalizeAiPageConfig({ lazyTranslate: false });
        controller._domResolvedSourceLanguage = "en";
        controller._domPageRootElements = [document.body];
        controller.getAiPageSectionMinChars = () => 10;
        controller.enqueueAiPageSectionTranslation = jest.fn();
        controller.enqueueAiPageSectionBatchTranslation = jest.fn();

        controller.dispatchAiPageSections();

        expect(controller.enqueueAiPageSectionTranslation).toHaveBeenCalledTimes(1);
        expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
        expect(controller._domHasDeferredSections).toBeFalsy();
    });

    it("excludes boilerplate sections only when the opt-in is enabled", () => {
        document.body.innerHTML = `
            <main>
                <p id="prose">Real article prose that should always translate, long enough.</p>
                <ol class="references"><li id="ref">Citation text that bloats token usage here.</li></ol>
            </main>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
        controller._domPageRootElements = [document.body];

        const ref = document.getElementById("ref");
        const prose = document.getElementById("prose");

        // Default (opt-out): boilerplate is still eligible for translation.
        controller._aiPageConfig = controller.normalizeAiPageConfig({ skipBoilerplate: false });
        expect(controller.isAiPageSectionElementEligible(prose)).toBe(true);
        expect(controller.isAiPageSectionElementEligible(ref)).toBe(true);

        // Opt-in: the citation list is skipped, real prose still translates.
        controller._aiPageConfig = controller.normalizeAiPageConfig({ skipBoilerplate: true });
        expect(controller.isAiPageSectionElementEligible(prose)).toBe(true);
        expect(controller.isAiPageSectionElementEligible(ref)).toBe(false);
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

    it("drains dozens of dropped-marker leaves across bounded sweep passes", () => {
        // 50 marked-but-still-source leaves (the model dropped their [[n]] markers in big batches).
        const leaves = Array.from({ length: 50 }, (_, i) => {
            const p = document.createElement("p");
            p.textContent = `Untranslated source paragraph number ${i} that needs a sweep.`;
            return p;
        });
        document.body.innerHTML = "";
        leaves.forEach((p) => document.body.appendChild(p));

        const controller = new BannerController();
        controller.currentTranslator = "dom";
        controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
        controller._domPageRootElements = [document.body];
        controller._aiSectionTranslatedChildren = new WeakSet(leaves);
        // Isolate the sweep's drain/cap logic from the unrelated meaningful-text filters.
        controller.isMeaningfulDomPageTextNode = (node) => Boolean(node && node.nodeValue);
        controller.isDomPageTextAlreadyInTargetLanguage = () => false;

        // First pass rescues up to maxFound (40); the second drains the remaining 10.
        expect(controller.sweepUntranslatedDomPageLeaves()).toBe(true);
        expect(controller._domGapCandidateElements.size).toBe(40);
        expect(controller.sweepUntranslatedDomPageLeaves()).toBe(true);
        expect(controller._domGapCandidateElements.size).toBe(50);
        // All leaves rescued exactly once; further sweeps find nothing and the pass cap holds.
        expect(controller.sweepUntranslatedDomPageLeaves()).toBe(false);
        expect(controller._domSweepCount).toBe(2);
        leaves.forEach((leaf) => expect(controller._domSweptElements.has(leaf)).toBe(true));
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
        const hasPdfRule = [...document.querySelectorAll("style")].some((style) =>
            style.textContent.includes(".textLayer .et-dom-pdf-translated-text")
        );
        expect(hasPdfRule).toBe(true);
    });

    it("mounts a target-language picker in the banner reflecting the current target", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "auto", tl: "ko" };
        const hostEl = document.createElement("div");
        const root = hostEl.attachShadow({ mode: "open" });
        root.innerHTML = `<div class="actions"><button data-action="hide"></button></div>`;
        document.body.appendChild(hostEl);

        controller.buildDomPageTargetMenu(root);

        const menu = root.querySelector(".et-lang-menu");
        expect(menu).not.toBeNull();
        // The trigger sits before the Hide button in the actions row.
        expect(menu.nextElementSibling.getAttribute("data-action")).toBe("hide");
        // Opening it shows the current target language as the selected option.
        controller._domBannerLangMenu.open();
        const selected = document.body.querySelector(".et-lang-popover .et-lang-option.is-selected");
        expect(selected.dataset.value).toBe("ko");
        controller._domBannerLangMenu.destroy();
    });

    it("banner target change persists the new language and flags an auto re-translate", async () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "auto", tl: "ko" };
        const setSpy = jest.fn();
        chrome.storage.sync.set = setSpy;
        sessionStorage.removeItem("edge-translate-auto-page-translate");

        controller.changeDomPageTargetLanguage("en");
        await Promise.resolve();
        await Promise.resolve();

        expect(setSpy).toHaveBeenCalledWith({ languageSetting: { tl: "en" } });
        expect(sessionStorage.getItem("edge-translate-auto-page-translate")).toBe("1");

        // Picking the same language again is a no-op (no extra persistence / flag churn).
        setSpy.mockClear();
        controller.changeDomPageTargetLanguage("ko");
        await Promise.resolve();
        expect(setSpy).not.toHaveBeenCalled();
    });

    it("auto-resumes page translation once when the reload flag is set", () => {
        jest.useFakeTimers();
        try {
            const controller = new BannerController();
            sessionStorage.setItem("edge-translate-auto-page-translate", "1");
            controller.startConfiguredAiPageTranslate = jest.fn();

            controller.maybeResumeAutoPageTranslate();
            jest.advanceTimersByTime(350);

            expect(controller.startConfiguredAiPageTranslate).toHaveBeenCalledTimes(1);
            // Flag consumed so a later plain reload does not re-trigger translation.
            expect(sessionStorage.getItem("edge-translate-auto-page-translate")).toBeNull();
        } finally {
            jest.useRealTimers();
        }
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
                Array.from(overlay.querySelectorAll("[data-role]")).map((line) => line.textContent)
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

    it("getCachedSegmentText cleans the returned value but never mutates the stored entry", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openai", model: "m", sl: "en", tl: "ko" };
        controller._domSegmentTextCache = new Map();
        const key = controller.segmentTextCacheKey("Original English source");
        // A raw bilingual value (as an older build / the persistent store might hold).
        const raw = "Original English source\n\n안녕하세요 번역입니다";
        controller._domSegmentTextCache.set(key, raw);

        // Read returns the cleaned (target-only) value...
        expect(controller.getCachedSegmentText("Original English source")).toBe("안녕하세요 번역입니다");
        // ...but the stored entry is UNCHANGED (no progressive re-sanitize/shrink on read).
        expect(controller._domSegmentTextCache.get(key)).toBe(raw);
        // ...and a second read is identical (idempotent), proving no creeping corruption.
        expect(controller.getCachedSegmentText("Original English source")).toBe("안녕하세요 번역입니다");
        expect(controller._domSegmentTextCache.get(key)).toBe(raw);
    });

    it("refreshes LRU recency on read so hot per-string entries are not evicted first", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openai", model: "m", sl: "ja", tl: "ko" };
        controller._domSegmentTextCache = new Map();
        controller.storeCachedSegmentText("本日は晴れです", "오늘은 맑습니다");
        controller.storeCachedSegmentText("ありがとう", "감사합니다");
        const keyA = controller.segmentTextCacheKey("本日は晴れです");
        const keyB = controller.segmentTextCacheKey("ありがとう");
        expect(Array.from(controller._domSegmentTextCache.keys())).toEqual([keyA, keyB]);

        // Reading A moves it to the tail (most-recently-used), so B becomes the eviction victim.
        controller.getCachedSegmentText("本日は晴れです");
        expect(Array.from(controller._domSegmentTextCache.keys())).toEqual([keyB, keyA]);
    });

    it("refreshes LRU recency when an entry-cache key is re-stored", () => {
        const controller = new BannerController();
        controller._domTranslationCache = new Map();
        controller._domTranslationCacheMax = 2000;
        controller.cacheDomPageTranslation("k1", "v1");
        controller.cacheDomPageTranslation("k2", "v2");
        controller.cacheDomPageTranslation("k1", "v1b");
        expect(Array.from(controller._domTranslationCache.keys())).toEqual(["k2", "k1"]);
        expect(controller._domTranslationCache.get("k1")).toBe("v1b");
    });

    it("clears the per-string cache on a full cancel (bounded, clean stop)", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "openai", model: "m", sl: "ja", tl: "ko" };
        controller._domSegmentTextCache = new Map();
        controller.storeCachedSegmentText("本日は晴れです", "오늘은 맑습니다");
        expect(controller._domSegmentTextCache.size).toBe(1);

        controller.currentTranslator = "dom";
        controller.cancelDomPageTranslate();
        expect(controller._domSegmentTextCache.size).toBe(0);
    });

    it("saves a per-URL persistent entry under a real urlHash even before prefetch sets it", () => {
        jest.useFakeTimers();
        try {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", model: "m", sl: "ja", tl: "ko" };
            controller._aiSectionPersistentUrlHash = ""; // prefetch hook hasn't run yet
            controller.channel.emit = jest.fn();

            controller.savePersistentTranslationCacheEntry({ cacheKey: "entry-key" }, "[[1]]\n번역");
            jest.advanceTimersByTime(1);

            expect(controller.channel.emit).toHaveBeenCalledTimes(1);
            const [event, payload] = controller.channel.emit.mock.calls[0];
            expect(event).toBe("persistent_cache_save");
            expect(payload.key).toBe("entry-key");
            expect(typeof payload.urlHash).toBe("string");
            expect(payload.urlHash.length).toBeGreaterThan(0); // not "" → recoverable on revisit
        } finally {
            jest.useRealTimers();
        }
    });

    it("reuses a per-string cache hit cleanly with consistent sentence-level hover", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", model: "m", sl: "en", tl: "ko" };
        controller._domSegmentTextCache = new Map();
        controller._aiSectionTranslatedChildren = new WeakSet();
        const source = "Source one. Source two.";
        const translation = "번역 하나. 번역 둘.";

        // A fresh translation stored its strings (as storeEntrySegmentCache does on apply)...
        controller.storeCachedSegmentText(source, translation);
        // ...and a later identical block resolves it from cache with no new request.
        expect(controller.getCachedSegmentText(source)).toBe(translation);

        document.body.innerHTML = `<p id="p">${source}</p>`;
        const leaf = document.getElementById("p");
        const ok = controller.applyCachedLeafTranslation(leaf, controller.getCachedSegmentText(source));

        // Applies cleanly (no error), swaps the text, and marks it done so it is not re-collected.
        expect(ok).toBe(true);
        expect(leaf.textContent.replace(/\s+/g, " ").trim()).toBe(translation);
        expect(controller._aiSectionTranslatedChildren.has(leaf)).toBe(true);
        // Hover-original from the CACHE path is sentence-level too (consistent with fresh path).
        const spans = leaf.querySelectorAll("[data-edge-translate-segment]");
        expect(spans.length).toBe(2);
        expect(controller._domOriginalTextByElement.get(spans[0])).toBe("Source one.");
        expect(controller._domOriginalTextByElement.get(spans[1])).toBe("Source two.");
    });

    it("does not double-wrap a cache-applied leaf when section registration revisits it", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        // The leaf holds the TRANSLATED text — registration always happens after apply.
        // (Identical leaf/original text is the keep-source case, which skips hover.)
        document.body.innerHTML = `<p id="p">번역 하나. 번역 둘.</p>`;
        const leaf = document.getElementById("p");

        // First registration (e.g. from a per-string cache hit during build) wraps + registers.
        controller.registerAiPageLeafOriginalBySentence(leaf, "Source one. Source two.");
        const firstSpans = leaf.querySelectorAll("[data-edge-translate-segment]");
        expect(firstSpans.length).toBe(2);
        expect(controller._domOriginalTextByElement.get(firstSpans[0])).toBe("Source one.");

        // A later revisit (section registration over the same leaf) must be a NO-OP — no nested
        // spans, no overwriting the correct original with translated text.
        controller.registerAiPageLeafOriginalBySentence(leaf, "WRONG translated text here.");
        const spansAfter = leaf.querySelectorAll("[data-edge-translate-segment]");
        expect(spansAfter.length).toBe(2); // still 2, not nested/doubled
        expect(leaf.querySelector("[data-edge-translate-segment] [data-edge-translate-segment]")).toBeNull();
        expect(controller._domOriginalTextByElement.get(spansAfter[0])).toBe("Source one.");
    });

    it("re-applies a cached entry payload onto a fresh identical section (revisit reuse)", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        document.body.innerHTML = `
            <article id="article"><p id="line">Alpha sentence. Beta sentence.</p></article>
        `;
        const article = document.getElementById("article");
        const paragraph = document.getElementById("line");
        const entry = {
            cacheKey: "revisit-key",
            segBlocks: [paragraph],
            segTexts: ["Alpha sentence. Beta sentence."],
            section: { parent: article, children: [paragraph], plainText: "x", role: "paragraph" },
        };
        entry.originalCapture = controller.captureAiPageSectionOriginalTexts(entry, 0);
        // Simulate a persistent-cache hit: a previously-cached [[n]] payload re-applied directly.
        const ok = controller.applyAiPageSectionTranslation(entry, "[[1]]\n알파 문장. 베타 문장.");
        expect(ok).toBe(true);
        expect(paragraph.textContent.replace(/\s+/g, " ").trim()).toBe("알파 문장. 베타 문장.");
        const spans = paragraph.querySelectorAll("[data-edge-translate-segment]");
        expect(spans.length).toBe(2);
        expect(controller._domOriginalTextByElement.get(spans[0])).toBe("Alpha sentence.");
        expect(controller._domOriginalTextByElement.get(spans[1])).toBe("Beta sentence.");
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
        expect(
            controller.collectDomPageTextNodes([document.getElementById("article-body")])
        ).toEqual([leadNode, bodyNode]);
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
                <p>${"This article body paragraph has enough text to be the primary content root. ".repeat(
                    40
                )}</p>
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
                <p>${"This article body paragraph has enough text to be the primary content root. ".repeat(
                    40
                )}</p>
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
        expect(
            controller.isMeaningfulDomPageTextNode(
                document.getElementById("comment-rule").firstChild
            )
        ).toBe(true);
        expect(
            controller.isMeaningfulDomPageTextNode(document.getElementById("site-copy").firstChild)
        ).toBe(false);
    });

    it("detects late-loaded comment text outside the current main root", () => {
        document.body.innerHTML = `
            <main><article>
                <p>${"This article body paragraph has enough text to be the primary content root. ".repeat(
                    40
                )}</p>
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

    it("registers hover-original per SENTENCE for a multi-sentence translated paragraph", () => {
        document.body.innerHTML = `
            <article id="article"><p id="line">Source one. Source two. Source three.</p></article>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const article = document.getElementById("article");
        const paragraph = document.getElementById("line");
        const entry = {
            cacheKey: "sentence-tooltip",
            segBlocks: [paragraph],
            section: { parent: article, children: [paragraph], plainText: "x", role: "paragraph" },
        };
        entry.originalCapture = controller.captureAiPageSectionOriginalTexts(entry, 0);

        expect(
            controller.applyAiPageSectionTranslation(entry, "[[1]]\n번역 하나. 번역 둘. 번역 셋.")
        ).toBe(true);

        // Each translated sentence is wrapped in a segment span with its own original sentence...
        const spans = paragraph.querySelectorAll("[data-edge-translate-segment]");
        expect(spans.length).toBe(3);
        expect(controller._domOriginalTextByElement.get(spans[0])).toBe("Source one.");
        expect(controller._domOriginalTextByElement.get(spans[1])).toBe("Source two.");
        expect(controller._domOriginalTextByElement.get(spans[2])).toBe("Source three.");
        // ...the leaf keeps the full original as a between-spans fallback, and text is intact.
        expect(controller._domOriginalTextByElement.get(paragraph)).toBe(
            "Source one. Source two. Source three."
        );
        expect(paragraph.textContent.replace(/\s+/g, " ").trim()).toBe("번역 하나. 번역 둘. 번역 셋.");
    });

    it("falls back to whole-paragraph hover-original for a single-sentence block", () => {
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        document.body.innerHTML = `<p id="p">번역된 한 문장</p>`;
        const leaf = document.getElementById("p");
        controller.registerAiPageLeafOriginalBySentence(leaf, "A single original sentence");
        expect(leaf.querySelectorAll("[data-edge-translate-segment]").length).toBe(0);
        expect(controller._domOriginalTextByElement.get(leaf)).toBe("A single original sentence");
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
            // The single path awaits the persistent-cache races + payload build before the
            // request now — flush enough microtasks for the whole chain to settle.
            for (let i = 0; i < 12; i += 1) await Promise.resolve();

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

    describe("AI page backlog promotion (continuous slot top-up)", () => {
        // Shared fixture: a visible section near the viewport plus a far-offscreen section
        // (~12 screens down) whose heading starts a new section — the far one is deferred
        // into the promotion backlog by the lazy window, exactly like the lazy-reveal test.
        const buildFarPageDom = () => {
            document.body.innerHTML = `
                <article>
                    <p id="visible">Visible source paragraph long enough to translate.</p>
                    <h2 id="farHead">Far offscreen heading</h2>
                    <p id="farBody">Far offscreen source paragraph long enough to translate.</p>
                </article>
            `;
            document.getElementById("visible").getBoundingClientRect = () => ({
                top: 10,
                bottom: 40,
                width: 200,
                height: 30,
            });
            document.getElementById("farHead").getBoundingClientRect = () => ({
                top: 9000,
                bottom: 9030,
                width: 200,
                height: 30,
            });
        };

        // Dispatch once with the real dispatcher (so the deferred entry is fully built:
        // segTexts / cacheKey / inputTokens) while the enqueue paths are mocked out — the
        // request queue stays empty, leaving every slot free for backlog promotion.
        const createControllerWithDeferredBacklog = ({
            tokenBudget = 0,
            // These tests exercise pump MECHANICS (slot top-up, validation, budget gating)
            // on a far-offscreen entry; disable the geometric prefetch horizon so distance
            // alone never blocks promotion. Horizon policy has its own describe below.
            prefetchScreens = 0,
        } = {}) => {
            buildFarPageDom();
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openai",
                model: "gpt-5.4-mini",
                sl: "en",
                tl: "ko",
            };
            controller._aiPageConfig = controller.normalizeAiPageConfig({
                lazyTranslate: true,
                tokenBudget,
                prefetchScreens,
            });
            controller.currentTranslator = "dom";
            controller._domResolvedSourceLanguage = "en";
            controller._domPageRootElements = [document.body];
            controller.getAiPageSectionMinChars = () => 10;
            controller.enqueueAiPageSectionTranslation = jest.fn();
            controller.enqueueAiPageSectionBatchTranslation = jest.fn();
            controller.scheduleDomPageCoverageScan = jest.fn();
            controller.scheduleDomPageIncrementalScan = jest.fn();
            controller.dispatchAiPageSections();
            // The enqueue mocks never lazily create the queue; the flush tail needs it.
            if (!controller._domTranslationQueue) controller._domTranslationQueue = [];
            return controller;
        };

        // Promotion is deliberately microtask-deferred (queueMicrotask); a macrotask hop
        // guarantees every scheduled promotion pass has run before we assert.
        const flushPromotionMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

        it("keeps deferred far-offscreen entries in the backlog, deduped by cacheKey", () => {
            const controller = createControllerWithDeferredBacklog();

            expect(controller._domDeferredEntryBacklog).toHaveLength(1);
            const deferred = controller._domDeferredEntryBacklog[0];
            expect(deferred.sessionId).toBe(controller._domTranslationSessionId);
            expect(deferred.plainText).toContain("Far offscreen");

            // Re-dispatch the page: release the streamed visible entry so it is re-collected
            // as the highest-priority keep, leaving the far section to defer again — the
            // identical cacheKey must dedupe instead of duplicating the backlog entry.
            const visibleEntry = controller.enqueueAiPageSectionTranslation.mock.calls[0][0];
            controller.releaseAiPageSectionEntry(visibleEntry);
            controller.dispatchAiPageSections();

            expect(controller._domDeferredEntryBacklog).toHaveLength(1);
            expect(controller._domDeferredEntryBacklog[0]).toBe(deferred);
        });

        it("promotes backlog entries when the queue drains with free slots", async () => {
            const controller = createControllerWithDeferredBacklog();
            const deferred = controller._domDeferredEntryBacklog[0];
            const farHead = document.getElementById("farHead");
            const farBody = document.getElementById("farBody");
            const totalBefore = controller._domTotalTranslationEntries;
            expect(controller._aiSectionTranslatedChildren.has(farHead)).toBe(false);

            controller.flushDomTranslationQueue();
            // Promotion rides a microtask so it never claims slots inside the flush body.
            expect(controller.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();
            await flushPromotionMicrotasks();

            expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
            const batch = controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0];
            expect(batch).toHaveLength(1);
            expect(batch[0]).toBe(deferred);
            // Committed exactly like the dispatch keep-path.
            expect(deferred.originalCapture).toBeDefined();
            expect(controller._domTotalTranslationEntries).toBe(totalBefore + 1);
            expect(controller._aiSectionTranslatedChildren.has(farHead)).toBe(true);
            expect(controller._aiSectionTranslatedChildren.has(farBody)).toBe(true);
            expect(controller._domDeferredEntryBacklog).toHaveLength(0);
        });

        it("drops a stale backlog entry to the gap-fill fallback instead of promoting it", async () => {
            const controller = createControllerWithDeferredBacklog();
            const farBody = document.getElementById("farBody");
            // The page mutated under the deferred entry — its snapshot no longer matches.
            farBody.textContent = "totally different now";

            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();

            expect(controller.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();
            expect(controller.isElementRelatedToDomGapCandidate(farBody)).toBe(true);
            expect(controller.scheduleDomPageIncrementalScan).toHaveBeenCalled();
            expect(controller._domDeferredEntryBacklog).toHaveLength(0);
        });

        it("gates non-boosted promotion behind the lazy token budget; boosted entries always promote", async () => {
            const controller = createControllerWithDeferredBacklog({ tokenBudget: 1 });
            expect(controller._domDeferredEntryBacklog).toHaveLength(1);
            const deferred = controller._domDeferredEntryBacklog[0];
            controller._domEagerPromotedTokens = 1; // eager budget exhausted

            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(controller.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();
            expect(controller._domDeferredEntryBacklog).toHaveLength(1);

            // Reveal-boosted entries bypass the budget gate.
            deferred._lazyBoost = true;
            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
            expect(controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0][0]).toBe(
                deferred
            );
            expect(controller._domDeferredEntryBacklog).toHaveLength(0);
        });

        it("geometric prefetch horizon: far entries wait for reveal, then promote on boost", async () => {
            // farHead/farBody sit at top:9000 ≈ 11.7 viewport-heights down — beyond a
            // 4-screen horizon. Eager promotion must leave them scroll-paced.
            const controller = createControllerWithDeferredBacklog({ prefetchScreens: 4 });
            expect(controller._domDeferredEntryBacklog).toHaveLength(1);
            const deferred = controller._domDeferredEntryBacklog[0];

            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(controller.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();
            expect(controller._domDeferredEntryBacklog).toHaveLength(1);

            // Horizon-blocked backlog is scroll-paced, NOT pending — the coverage/done
            // machinery must not wait on it.
            expect(controller.hasPromotableAiPageBacklogEntries()).toBe(false);

            // The reader scrolls toward it → reveal boost bypasses the horizon.
            deferred._lazyBoost = true;
            expect(controller.hasPromotableAiPageBacklogEntries()).toBe(true);
            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
            expect(controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0][0]).toBe(
                deferred
            );
            expect(controller._domDeferredEntryBacklog).toHaveLength(0);
        });

        it("geometric prefetch horizon: promotes when scrolling brings an entry inside it", async () => {
            const controller = createControllerWithDeferredBacklog({ prefetchScreens: 4 });
            expect(controller._domDeferredEntryBacklog).toHaveLength(1);
            const deferred = controller._domDeferredEntryBacklog[0];

            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(controller.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();

            // The viewport moved: the far section is now ~1 screen below the fold. The
            // rank refresh (gated by _domBacklogNeedsRank, set on scroll/reveal) must see
            // the new geometry and promote without any boost.
            document.getElementById("farHead").getBoundingClientRect = () => ({
                top: 1500,
                bottom: 1530,
                width: 200,
                height: 30,
            });
            controller._domBacklogNeedsRank = true;
            expect(controller.hasPromotableAiPageBacklogEntries()).toBe(true);
            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
            expect(controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0][0]).toBe(
                deferred
            );
        });

        it("geometric prefetch horizon: entries without geometry stay eagerly promotable", async () => {
            const controller = createControllerWithDeferredBacklog({ prefetchScreens: 4 });
            expect(controller._domDeferredEntryBacklog).toHaveLength(1);
            // Strip the mocked rect: jsdom's zero-rect default = "no usable geometry",
            // which must fall back to in-horizon (matches the lazy-window fallback).
            delete document.getElementById("farHead").getBoundingClientRect;
            controller._domBacklogNeedsRank = true;

            controller.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
        });

        it("prefetchScreens config: default 8, explicit 0 disables, invalid falls back", () => {
            const controller = new BannerController();
            const screens = (config) => controller.normalizeAiPageConfig(config).prefetchScreens;
            expect(screens({})).toBe(8);
            expect(screens({ prefetchScreens: 0 })).toBe(0);
            expect(screens({ prefetchScreens: 3 })).toBe(3);
            expect(screens({ prefetchScreens: -2 })).toBe(8);
            expect(screens({ prefetchScreens: "x" })).toBe(8);
        });

        it("invalidates the backlog and any scheduled promotion on session reset", async () => {
            const controller = createControllerWithDeferredBacklog();
            expect(controller._domDeferredEntryBacklog).toHaveLength(1);

            controller.flushDomTranslationQueue(); // schedules the promotion microtask
            controller.resetDomPageRuntimeState(); // bumps sessionId + clears the backlog

            expect(controller._domDeferredEntryBacklog).toHaveLength(0);
            await flushPromotionMicrotasks();
            // The already-scheduled promotion sees a stale sessionId and enqueues nothing.
            expect(controller.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();
        });

        it("holds the flush-tail coverage scan while promotable backlog remains", async () => {
            // Promotable backlog → the page is not done; the coverage scan must wait.
            const promotable = createControllerWithDeferredBacklog();
            promotable.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(promotable.enqueueAiPageSectionBatchTranslation).toHaveBeenCalledTimes(1);
            expect(promotable.scheduleDomPageCoverageScan).not.toHaveBeenCalled();

            // Backlog blocked SOLELY by the token budget (non-boosted) does not count as
            // promotable — the coverage machinery may proceed.
            const blocked = createControllerWithDeferredBacklog({ tokenBudget: 1 });
            blocked._domEagerPromotedTokens = 1;
            blocked.flushDomTranslationQueue();
            await flushPromotionMicrotasks();
            expect(blocked.enqueueAiPageSectionBatchTranslation).not.toHaveBeenCalled();
            expect(blocked.scheduleDomPageCoverageScan).toHaveBeenCalledTimes(1);
            expect(blocked._domDeferredEntryBacklog).toHaveLength(1);
        });

        it("releases a single entry's children when the circuit breaker drops it", async () => {
            const el = document.createElement("p");
            el.textContent = "Source sentence.";
            document.body.appendChild(el);

            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openai",
                model: "gpt-5.4-mini",
                sl: "en",
                tl: "ko",
            };
            controller.currentTranslator = "dom";
            controller.scheduleDomPageCoverageScan = jest.fn();
            controller._aiSectionTranslatedChildren = new WeakSet();
            controller._aiSectionTranslatedChildren.add(el); // marked "in flight" at dispatch
            controller._domCircuitBreakerActive = true;

            const entry = {
                sectionMode: true,
                section: { children: [el] },
                cacheKey: "x",
                segTexts: ["Source sentence."],
                segBlocks: [el],
                sourceText: "[[1:p]]\nSource sentence.",
                plainText: "Source sentence.",
                attempt: 0,
            };
            controller.enqueueAiPageSectionTranslation(entry);
            await flushPromotionMicrotasks();

            // Mirrors the batch breaker branch: the child is released (not stranded as
            // "in flight" forever) and the entry still counts as completed.
            expect(controller._aiSectionTranslatedChildren.has(el)).toBe(false);
            expect(controller._domCompletedTranslationEntries).toBe(1);
        });

        it("uses openai-specific batch tiers with a post-scale output ceiling clamp", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };

            controller._domBatchFailureCount = 0;
            expect(controller.getAiPageSectionBatchOptions()).toEqual({
                maxChars: 9500,
                maxInputTokens: 2800,
                maxOutputTokens: 3600,
                maxItems: 12,
            });
            controller._domBatchFailureCount = 1;
            expect(controller.getAiPageSectionBatchOptions()).toEqual({
                maxChars: 6000,
                maxInputTokens: 1800,
                maxOutputTokens: 2400,
                maxItems: 8,
            });
            controller._domBatchFailureCount = 2;
            expect(controller.getAiPageSectionBatchOptions()).toEqual({
                maxChars: 4000,
                maxInputTokens: 1200,
                maxOutputTokens: 1600,
                maxItems: 4,
            });

            // Batch growth can never push the estimated output past the engine's
            // first-attempt completion ceiling (otherwise full batches truncate+regenerate).
            controller._domBatchFailureCount = 0;
            controller._aiPageSectionBatchScale = 1.6;
            expect(controller.getAiPageSectionBatchOptions().maxOutputTokens).toBe(3686);

            controller._domPageTranslateOptions.engine = "openaiCompatible";
            controller._aiPageSectionBatchScale = 1.35;
            expect(controller.getAiPageSectionBatchOptions().maxOutputTokens).toBe(1382);

            // googleAiStudio has no pinned engine cap — unclamped (generous failures-0 tier).
            controller._domPageTranslateOptions.engine = "googleAiStudio";
            controller._aiPageSectionBatchScale = 1.6;
            expect(controller.getAiPageSectionBatchOptions().maxOutputTokens).toBe(
                Math.round(18000 * 1.6)
            );
        });

        it("LPT-balances cloud entries into the fewest bins within the makespan target", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            controller.getDomPageMaxConcurrentTranslations = () => 32;

            const target = controller.getAiPageUnitOutputTarget();
            const entryOut = 1500;
            // Many small uniform entries → fewest bins that fit the makespan target.
            const uniform = Array.from({ length: 16 }, () => ({
                sourceText: "x".repeat(3000),
                inputTokens: 800,
                outputTokens: entryOut,
            }));
            const batches = controller.buildAiPageSectionBatches(uniform);
            expect(batches).toHaveLength(Math.ceil((16 * entryOut) / target));
            // LPT balances: each bin is within ONE entry of the target (entries can't be
            // split), and the heaviest is within one entry of the lightest (no ragged tail).
            const outs = batches.map((b) => b.reduce((s, e) => s + e.outputTokens, 0));
            expect(Math.max(...outs)).toBeLessThanOrEqual(target + entryOut);
            expect(Math.max(...outs) - Math.min(...outs)).toBeLessThanOrEqual(entryOut);
        });

        it("splits an oversized section so no unit pins the makespan; smart batcher re-bundles", () => {
            document.body.innerHTML = `<section id="big"></section>`;
            const section = document.getElementById("big");
            // 12 dense-CJK paragraphs (~900 out each) — together well over one makespan target.
            for (let i = 0; i < 12; i += 1) {
                const p = document.createElement("p");
                p.textContent = "東京都".repeat(300);
                section.appendChild(p);
            }
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            const whole = {
                parent: section,
                children: Array.from(section.children),
                role: "paragraph",
            };
            const parts = controller.splitAiPageSectionsByOutput([whole]);
            expect(parts.length).toBeGreaterThan(1); // the giant section was split
            const target = controller.getAiPageUnitOutputTarget();
            for (const part of parts) {
                const out = part.children.reduce(
                    (sum, c) =>
                        sum + Math.ceil((c.textContent.match(/[぀-ヿ㐀-鿿]/g) || []).length * 0.8 * 1.25),
                    0
                );
                expect(out).toBeLessThanOrEqual(target + 1200); // ≤ target + one child slack
            }
            // A small section is left whole (not over-split).
            document.body.innerHTML = `<section id="s"><p>한 문장.</p><p>두 문장.</p></section>`;
            const small = document.getElementById("s");
            const keep = controller.splitAiPageSectionsByOutput([
                { parent: small, children: Array.from(small.children), role: "paragraph" },
            ]);
            expect(keep).toHaveLength(1);
        });

        it("caps a batch by leaves (markers), not just output tokens", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            controller.getDomPageMaxConcurrentTranslations = () => 32;
            const maxLeaves = controller.getAiPageMaxLeavesPerBatch();
            // 40 entries × 30 leaves = 1200 leaves but only 4000 output (≈1 unit target).
            // Output-only sizing would make ~1 batch of 1200 markers; the leaf cap forces
            // many balanced batches so no reply must echo a thousand [[n]].
            const entries = Array.from({ length: 40 }, (_, i) => ({
                sourceText: `s${i}`,
                plainText: `p${i}`,
                inputTokens: 30,
                outputTokens: 100,
                segBlocks: Array.from({ length: 30 }, () => ({})),
            }));
            const batches = controller.buildAiPageSectionBatches(entries);
            // No bin exceeds the marker cap, and the cap (not the output target) is what
            // drove the split (≥ ceil(totalLeaves/cap) bins).
            for (const b of batches) {
                const leaves = b.reduce((s, e) => s + e.segBlocks.length, 0);
                expect(leaves).toBeLessThanOrEqual(maxLeaves);
            }
            expect(batches.length).toBeGreaterThanOrEqual(Math.ceil((40 * 30) / maxLeaves));
        });

        it("coalesces runs of tiny same-tier sections, leaving normal sections whole", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            // 30 tiny infobox-style rows (all tier 4 in jsdom — no layout) + 1 normal section.
            document.body.innerHTML = `<table><tbody id="tb"></tbody></table><div id="big"></div>`;
            const tb = document.getElementById("tb");
            const tinySections = [];
            for (let i = 0; i < 30; i += 1) {
                const tr = document.createElement("tr");
                tr.innerHTML = `<th>項目${i}</th><td>値${i}</td>`;
                tb.appendChild(tr);
                tinySections.push({ parent: tb, children: [tr], role: "text" });
            }
            const big = document.getElementById("big");
            const p = document.createElement("p");
            p.textContent = "本文の長い段落です。".repeat(40);
            big.appendChild(p);
            const normal = { parent: big, children: [p], role: "paragraph" };

            const merged = controller.mergeAdjacentTinyAiPageSections([...tinySections, normal]);
            // 30 tiny rows collapse to a handful of units; the normal paragraph stays its own.
            expect(merged.length).toBeLessThan(10);
            expect(merged.length).toBeGreaterThan(1);
            expect(merged[merged.length - 1].children).toEqual([p]); // normal section intact
        });

        it("does not merge a tiny section across a viewport-tier boundary", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            document.body.innerHTML = `<p id="near">近い。</p><p id="far">遠い。</p>`;
            const near = document.getElementById("near");
            const far = document.getElementById("far");
            near.getBoundingClientRect = () => ({ top: 10, bottom: 40, width: 200, height: 30 });
            far.getBoundingClientRect = () => ({ top: 9000, bottom: 9030, width: 200, height: 30 });
            const merged = controller.mergeAdjacentTinyAiPageSections([
                { parent: document.body, children: [near], role: "text" },
                { parent: document.body, children: [far], role: "text" },
            ]);
            expect(merged).toHaveLength(2); // different tiers → never coalesced
        });

        it("shrinks the unit target while the model drops markers, and grows back when clean", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            controller.getDomPageMaxConcurrentTranslations = () => 32;
            const uniform = Array.from({ length: 16 }, () => ({
                sourceText: "x".repeat(3000),
                inputTokens: 800,
                outputTokens: 1500,
            }));
            const cleanBatches = controller.buildAiPageSectionBatches(uniform).length;

            // ~10% marker drops → quality factor bottoms → smaller target → more bins.
            controller.recordAiPageBatchQualityTelemetry({ blocks: 100, unresolved: 10 });
            controller.recordAiPageBatchQualityTelemetry({ blocks: 100, unresolved: 10 });
            expect(controller.buildAiPageSectionBatches(uniform).length).toBeGreaterThan(
                cleanBatches
            );

            // Clean replies decay the EMA → target recovers.
            for (let i = 0; i < 12; i += 1) {
                controller.recordAiPageBatchQualityTelemetry({ blocks: 100, unresolved: 0 });
            }
            expect(controller.buildAiPageSectionBatches(uniform).length).toBe(cleanBatches);
        });

        it("unit target is DERIVED from the per-request overhead budget (not a magic number), openai=cap", () => {
            const g = new BannerController();
            g._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            // overhead(~160) / max-overhead-fraction(6%) → ~2667; well under the engine cap so
            // a 32-slot engine still spreads the page; never below the 1200 hard floor.
            const unit = g.getAiPageUnitOutputTarget();
            expect(unit).toBeGreaterThanOrEqual(1200);
            expect(unit).toBeLessThan(g.getAiPageSectionBatchOptions().maxOutputTokens);
            expect(unit).toBe(Math.ceil(160 / 0.06));

            const o = new BannerController();
            o._domPageTranslateOptions = { engine: "openai", model: "gpt-5.4-mini", sl: "en", tl: "ko" };
            // openai sizes to its (clamped) output cap — bigger is impossible/pointless there.
            expect(o.getAiPageUnitOutputTarget()).toBe(
                o.getAiPageSectionBatchOptions().maxOutputTokens
            );
        });

        it("fills parallel slots on a fast engine (more bins = faster) but caps at concurrency", () => {
            const c = new BannerController();
            c._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            const unit = c.getAiPageUnitOutputTarget();
            const entries = Array.from({ length: 40 }, () => ({
                sourceText: "x".repeat(2000),
                inputTokens: 600,
                outputTokens: 1000,
                segBlocks: [{}, {}],
            }));
            const totalOut = 40 * 1000;
            // 8 slots: slot-fill caps at 8 (1 wave, fully parallel) since the page wants more.
            c.getDomPageMaxConcurrentTranslations = () => 8;
            expect(c.buildAiPageSectionBatches(entries)).toHaveLength(8);
            // 32 slots: more bins (faster) — exactly min(32, ceil(totalOut/unit)).
            c.getDomPageMaxConcurrentTranslations = () => 32;
            expect(c.buildAiPageSectionBatches(entries)).toHaveLength(
                Math.min(32, Math.ceil(totalOut / unit))
            );
        });

        it("gives up on an element after repeated GENUINE failures (stops the re-collect token runaway)", () => {
            const controller = new BannerController();
            controller._aiSectionTranslatedChildren = new WeakSet();
            const child = document.createElement("p");
            child.textContent = "繰り返し失敗する段落。";
            const entry = { section: { children: [child] } };

            // No-fault releases (breaker / stale) must NOT count toward give-up.
            for (let i = 0; i < 5; i += 1) {
                controller._aiSectionTranslatedChildren.add(child);
                controller.releaseAiPageSectionEntry(entry); // countFailure defaults false
                expect(controller._aiSectionTranslatedChildren.has(child)).toBe(false); // re-collectable
            }

            // Genuine failures: re-collectable for the first 2, then GIVEN UP (stays marked).
            controller._aiSectionTranslatedChildren.add(child);
            controller.releaseAiPageSectionEntry(entry, { countFailure: true });
            expect(controller._aiSectionTranslatedChildren.has(child)).toBe(false); // fail 1
            controller._aiSectionTranslatedChildren.add(child);
            controller.releaseAiPageSectionEntry(entry, { countFailure: true });
            expect(controller._aiSectionTranslatedChildren.has(child)).toBe(false); // fail 2
            controller._aiSectionTranslatedChildren.add(child);
            controller.releaseAiPageSectionEntry(entry, { countFailure: true });
            // fail 3 → give up: kept marked so no scan re-collects it (never an endless loop).
            expect(controller._aiSectionTranslatedChildren.has(child)).toBe(true);
        });

        it("trips the session token backstop when spend runs past the committed estimate", () => {
            const controller = new BannerController();
            controller._domTokenUsage = { outputTokens: 0 };
            controller._domAiPageEstOutCommitted = 10000; // a real page's worth committed
            controller._domAiPageBudgetExceeded = false;

            controller._domTokenUsage.outputTokens = 12000; // 1.2× — normal, with retries
            expect(controller.isAiPageOutputBudgetExceeded()).toBe(false);

            controller._domTokenUsage.outputTokens = 26000; // 2.6× — runaway
            expect(controller.isAiPageOutputBudgetExceeded()).toBe(true);
            // Latches (stays tripped even if the ratio later looks fine).
            controller._domTokenUsage.outputTokens = 0;
            expect(controller.isAiPageOutputBudgetExceeded()).toBe(true);

            // Tiny pages never trip (below the committed floor).
            const tiny = new BannerController();
            tiny._domTokenUsage = { outputTokens: 9000 };
            tiny._domAiPageEstOutCommitted = 1000;
            expect(tiny.isAiPageOutputBudgetExceeded()).toBe(false);
        });

        it("self-discovers the marker cap (AIMD): grows on clean full batches, drops on marker loss", () => {
            const c = new BannerController();
            c._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            const seed = c.getAiPageMaxLeavesPerBatch();
            // Clean batches that EXERCISED the cap → additive growth past the seed.
            for (let i = 0; i < 5; i += 1) {
                c.recordAiPageBatchQualityTelemetry({ blocks: seed, unresolved: 0 });
            }
            const grown = c.getAiPageMaxLeavesPerBatch();
            expect(grown).toBeGreaterThan(seed);
            // A real marker drop → multiplicative shrink below where it was.
            c.recordAiPageBatchQualityTelemetry({ blocks: grown, unresolved: Math.round(grown * 0.1) });
            expect(c.getAiPageMaxLeavesPerBatch()).toBeLessThan(grown);
            // Tiny clean batches (didn't exercise the cap) do NOT grow it (no false proof).
            const here = c.getAiPageMaxLeavesPerBatch();
            for (let i = 0; i < 5; i += 1) {
                c.recordAiPageBatchQualityTelemetry({ blocks: 5, unresolved: 0 });
            }
            expect(c.getAiPageMaxLeavesPerBatch()).toBe(here);
        });

        it("a given-up element cannot be reopened by sweep/mutation release (one give-up SSoT)", () => {
            const controller = new BannerController();
            controller._aiSectionTranslatedChildren = new WeakSet();
            const child = document.createElement("p");
            child.textContent = "繰り返し失敗。";
            const entry = { section: { children: [child] } };
            // 3 genuine failures → given up (kept marked by the entry release).
            for (let i = 0; i < 3; i += 1) {
                controller._aiSectionTranslatedChildren.add(child);
                controller.releaseAiPageSectionEntry(entry, { countFailure: true });
            }
            expect(controller._aiSectionTranslatedChildren.has(child)).toBe(true);
            // The OTHER release primitive (sweep/mutation) must ALSO honor give-up — not reopen it.
            controller.releaseAiPageSectionElement(child);
            expect(controller._aiSectionTranslatedChildren.has(child)).toBe(true);
            // A non-given-up sibling is still releasable by the element path.
            const ok = document.createElement("p");
            controller._aiSectionTranslatedChildren.add(ok);
            controller.releaseAiPageSectionElement(ok);
            expect(controller._aiSectionTranslatedChildren.has(ok)).toBe(false);
        });

        it("backlog promotion honors the session token backstop (no bypass of the runaway gate)", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            controller.currentTranslator = "dom";
            controller._domMaxConcurrentTranslations = 32;
            controller._domDeferredEntryBacklog = [
                { sourceText: "x", segTexts: ["x"], segBlocks: [{}], outputTokens: 100 },
            ];
            // Latch the backstop (committed >= floor, spent > 2.5x).
            controller._domAiPageEstOutCommitted = 10000;
            controller._domTokenUsage = { outputTokens: 30000 };
            expect(controller.promoteAiPageBacklogEntries()).toBe(0);
        });

        it("clears the circuit-breaker latch + pending timer on session reset (no stale cross-session flush)", () => {
            jest.useFakeTimers();
            try {
                const controller = new BannerController();
                controller.triggerDomPageCircuitBreaker();
                expect(controller._domCircuitBreakerActive).toBe(true);
                expect(controller._domCircuitBreakerTimer).not.toBeNull();
                const flush = jest.spyOn(controller, "flushDomTranslationQueue");
                // A new session starts (reset bumps sessionId + clears the breaker + its timer).
                controller.resetDomPageRuntimeState();
                expect(controller._domCircuitBreakerActive).toBe(false);
                expect(controller._domCircuitBreakerTimer).toBeNull();
                // The old 15s timer must NOT fire into the new session.
                jest.advanceTimersByTime(20000);
                expect(flush).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it("instantly resolves identifier-class leaves without sending them", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            controller._domResolvedSourceLanguage = "ja";
            // Short Latin/digit identifiers on a non-Latin source page: provable identity.
            expect(controller.isInstantKeepSourceLeafText("KH01-1067mm")).toBe(true);
            expect(controller.isInstantKeepSourceLeafText("ISBN 978-4-12-345678-9")).toBe(true);
            // Real prose still goes to the model: >2 letter-bearing words.
            expect(controller.isInstantKeepSourceLeafText("The quick brown fox")).toBe(false);
            // Kanji/kana = source script, never an identifier.
            expect(controller.isInstantKeepSourceLeafText("京阪電気鉄道")).toBe(false);
            // Latin-script SOURCE language (no script pattern) → conservative reject.
            const en = new BannerController();
            en._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
            en._domResolvedSourceLanguage = "en";
            expect(en.isInstantKeepSourceLeafText("KH01-1067mm")).toBe(false);
        });

        it("local engines keep char-targeted one-per-slot sizing (ctx-constrained)", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller.getDomPageMaxConcurrentTranslations = () => 4;
            const smallEntries = Array.from({ length: 12 }, () => ({
                sourceText: "x".repeat(1000),
                inputTokens: 100,
                outputTokens: 100,
            }));
            // 12000 chars over 4 slots → 3000-char batches → 4 batches (no output targeting).
            expect(controller.buildAiPageSectionBatches(smallEntries)).toHaveLength(4);
        });
    });

    describe("persistent prefetch (speed redesign W2)", () => {
        it("issues the persistent-cache prefetch synchronously and prefills the entry cache", async () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openai",
                model: "gpt-5.4-mini",
                sl: "en",
                tl: "ko",
            };
            controller.channel.request = jest
                .fn()
                .mockResolvedValue([{ key: "cached-entry", value: "[[1]]\n번역된 문장입니다." }]);

            const ready = controller.prefetchPersistentTranslationCache();

            // The IDB round-trip went out synchronously (before any await) so it can
            // overlap section collection and the banner reflow.
            expect(controller.channel.request).toHaveBeenCalledTimes(1);
            expect(controller.channel.request).toHaveBeenCalledWith("persistent_cache_prefetch", {
                urlHash: expect.any(String),
            });
            expect(typeof ready.then).toBe("function");

            await ready;
            expect(controller._domTranslationCache.get("cached-entry")).toBe(
                "[[1]]\n번역된 문장입니다."
            );
        });

        it("issues at most one IDB prefetch per session from the first-dispatch hook", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domPageRootElements = [document.body];
            const prefetchSpy = jest.spyOn(controller, "prefetchPersistentTranslationCache");

            controller.dispatchAiPageSections({ reason: "initial" });
            expect(prefetchSpy).toHaveBeenCalledTimes(1);
            expect(controller._domPersistentPrefetchReady).toBeDefined();

            controller.dispatchAiPageSections({ reason: "incremental" });
            expect(prefetchSpy).toHaveBeenCalledTimes(1);
        });

        it("does not re-issue the prefetch when startDomPageTranslate already set it", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domPageRootElements = [document.body];
            controller._domPersistentPrefetchReady = Promise.resolve();
            const prefetchSpy = jest.spyOn(controller, "prefetchPersistentTranslationCache");

            controller.dispatchAiPageSections({ reason: "initial" });

            expect(prefetchSpy).not.toHaveBeenCalled();
        });

        it("bounds the first-wave prefetch wait to 150ms and races only once per session", async () => {
            jest.useFakeTimers();
            try {
                const controller = new BannerController();
                controller._domPersistentPrefetchReady = new Promise(() => {}); // never settles
                let firstResolved = false;
                controller.awaitPersistentPrefetchForFirstWave().then(() => {
                    firstResolved = true;
                });
                // The latch is taken synchronously by the first caller.
                expect(controller._domFirstWaveRaceDone).toBe(true);
                await Promise.resolve();
                await Promise.resolve();
                expect(firstResolved).toBe(false); // still inside the bounded race window

                jest.advanceTimersByTime(150);
                for (let i = 0; i < 4; i += 1) await Promise.resolve();
                expect(firstResolved).toBe(true);

                // Later waves resolve immediately — the race never runs twice.
                let secondResolved = false;
                controller.awaitPersistentPrefetchForFirstWave().then(() => {
                    secondResolved = true;
                });
                for (let i = 0; i < 4; i += 1) await Promise.resolve();
                expect(secondResolved).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe("unified single-section path (speed redesign W2)", () => {
        it("applies a fully per-string-cached section with zero translate requests", async () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="first">Hello world.</p>
                    <p id="second">Good morning.</p>
                </article>
            `;
            const article = document.getElementById("article");
            const first = document.getElementById("first");
            const second = document.getElementById("second");
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
            controller.channel.request = jest.fn().mockResolvedValue([]);
            controller.channel.emit = jest.fn();
            const telemetrySpy = jest.spyOn(controller, "recordAiPageConcurrencyTelemetry");
            controller.storeCachedSegmentText("Hello world.", "안녕 세상.");
            controller.storeCachedSegmentText("Good morning.", "좋은 아침.");

            controller.enqueueAiPageSectionTranslation({
                section: { parent: article, children: [first, second], role: "paragraph" },
                segBlocks: [first, second],
                segTexts: ["Hello world.", "Good morning."],
                sourceText: "[[1]]\nHello world.\n[[2]]\nGood morning.",
                plainText: "Hello world. Good morning.",
                cacheKey: "fully-cached-single",
                attempt: 0,
            });
            for (let i = 0; i < 12; i += 1) await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));

            // Both leaves painted straight from the per-string cache — zero tokens.
            expect(first.textContent).toBe("안녕 세상.");
            expect(second.textContent).toBe("좋은 아침.");
            const translateCalls = controller.channel.request.mock.calls.filter(
                (call) => call[1] && typeof call[1].text === "string"
            );
            expect(translateCalls).toHaveLength(0);
            // Counted completed exactly once, and ~0ms cache applies never feed the
            // concurrency latency EMA.
            expect(controller._domCompletedTranslationEntries).toBe(1);
            expect(telemetrySpy).not.toHaveBeenCalled();
        });

        it("re-runs the same entry front-of-queue with only the missing block after a partial reply", async () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="first">Hello world.</p>
                    <p id="second">Good morning.</p>
                </article>
            `;
            const article = document.getElementById("article");
            const first = document.getElementById("first");
            const second = document.getElementById("second");
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
            controller.channel.emit = jest.fn();
            const translatePayloads = [];
            controller.channel.request = jest.fn((service, payload) => {
                if (!payload || typeof payload.text !== "string") return Promise.resolve([]);
                translatePayloads.push(payload.text);
                if (translatePayloads.length === 1) {
                    // The model dropped [[2]] — only the first block comes back.
                    return Promise.resolve({ mainMeaning: "[[1]]\n안녕 세상." });
                }
                return Promise.resolve({ mainMeaning: "[[1]]\n좋은 아침." });
            });

            controller.enqueueAiPageSectionTranslation({
                section: { parent: article, children: [first, second], role: "paragraph" },
                segBlocks: [first, second],
                segTexts: ["Hello world.", "Good morning."],
                sourceText: "[[1]]\nHello world.\n[[2]]\nGood morning.",
                plainText: "Hello world. Good morning.",
                cacheKey: "partial-single",
                attempt: 0,
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(translatePayloads).toHaveLength(2);
            expect(translatePayloads[0]).toContain("Hello world.");
            expect(translatePayloads[0]).toContain("Good morning.");
            // The retry rebuild excludes the landed leaf via the per-string cache: the
            // re-send renumbers from [[1]] and carries ONLY the missing block's text.
            expect(translatePayloads[1].match(/\[\[\d+]]/g)).toHaveLength(1);
            expect(translatePayloads[1]).toContain("Good morning.");
            expect(translatePayloads[1]).not.toContain("Hello world.");
            expect(first.textContent).toBe("안녕 세상.");
            expect(second.textContent).toBe("좋은 아침.");
            // The re-run is the SAME entry — counted completed exactly once.
            expect(controller._domCompletedTranslationEntries).toBe(1);
        });

        it("re-applies a cached entry payload on revisit with no request (zero tokens)", async () => {
            document.body.innerHTML = `
                <article id="article"><p id="leaf">Visible cached paragraph.</p></article>
            `;
            const article = document.getElementById("article");
            const leaf = document.getElementById("leaf");
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([leaf]);
            controller.channel.request = jest.fn();
            controller.channel.emit = jest.fn();
            controller.cacheDomPageTranslation("revisit-single", "[[1]]\n번역.");

            controller.enqueueAiPageSectionTranslation({
                section: { parent: article, children: [leaf], role: "paragraph" },
                segBlocks: [leaf],
                segTexts: ["Visible cached paragraph."],
                sourceText: "[[1]]\nVisible cached paragraph.",
                plainText: "Visible cached paragraph.",
                cacheKey: "revisit-single",
                attempt: 0,
            });
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(leaf.textContent).toBe("번역.");
            expect(controller.channel.request).not.toHaveBeenCalled();
            expect(controller._domCompletedTranslationEntries).toBe(1);
        });
    });

    describe("viewport-aware lead chunk (speed redesign W2)", () => {
        const buildTwoSectionPage = () => {
            document.body.innerHTML = `
                <article id="alpha">
                    <p id="alphaOne">${"Alpha section first paragraph sentence. ".repeat(15)}</p>
                    <p id="alphaTwo">${"Alpha section second paragraph sentence. ".repeat(15)}</p>
                </article>
                <article id="bravo">
                    <p id="bravoOne">${"Bravo section first paragraph sentence. ".repeat(15)}</p>
                    <p id="bravoTwo">${"Bravo section second paragraph sentence. ".repeat(15)}</p>
                </article>
            `;
        };

        const createController = () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                model: "local",
                sl: "en",
                tl: "ko",
            };
            // The lead-chunk choice is orthogonal to lazy windowing; disable lazy so the
            // far-from-viewport section is enqueued rather than deferred.
            controller._aiPageConfig = controller.normalizeAiPageConfig({ lazyTranslate: false });
            controller._domResolvedSourceLanguage = "en";
            controller._domPageRootElements = [document.body];
            controller.enqueueAiPageSectionTranslation = jest.fn();
            controller.enqueueAiPageSectionBatchTranslation = jest.fn();
            return controller;
        };

        it("spends the one-shot lead chunk on the best visible section, not sections[0]", () => {
            buildTwoSectionPage();
            // Document-top section sits far ABOVE the viewport (mid-page invocation);
            // the second section is the one actually on screen.
            ["alphaOne", "alphaTwo"].forEach((id) => {
                document.getElementById(id).getBoundingClientRect = () => ({
                    top: -5000,
                    bottom: -4800,
                    width: 200,
                    height: 30,
                });
            });
            document.getElementById("bravoOne").getBoundingClientRect = () => ({
                top: 10,
                bottom: 40,
                width: 200,
                height: 30,
            });
            document.getElementById("bravoTwo").getBoundingClientRect = () => ({
                top: 50,
                bottom: 80,
                width: 200,
                height: 30,
            });
            const controller = createController();

            controller.dispatchAiPageSections();

            expect(controller.enqueueAiPageSectionTranslation).toHaveBeenCalledTimes(1);
            const lead = controller.enqueueAiPageSectionTranslation.mock.calls[0][0];
            expect(lead.plainText).toContain("Bravo section first paragraph sentence.");
            // It is the SPLIT lead chunk of the visible section, not the whole section…
            expect(lead.plainText).not.toContain("Bravo section second paragraph sentence.");
            // …and the far-above document-top section did not steal the one-shot lead.
            expect(lead.plainText).not.toContain("Alpha section");
        });

        it("falls back to sections[0] for the lead when no section has a layout box", () => {
            // jsdom default rects are zero-size → every section ranks tier 4 (no tier-0),
            // so the lead must come from sections[0] — preserving the previous behavior.
            buildTwoSectionPage();
            const controller = createController();

            controller.dispatchAiPageSections();

            // Nothing ranks visible, so nothing single-streams; everything batches.
            expect(controller.enqueueAiPageSectionTranslation).not.toHaveBeenCalled();
            expect(controller.enqueueAiPageSectionBatchTranslation).toHaveBeenCalled();
            const firstBatch = controller.enqueueAiPageSectionBatchTranslation.mock.calls[0][0];
            // The first entry overall is the lead chunk split from sections[0].
            expect(firstBatch[0].plainText).toContain("Alpha section first paragraph sentence.");
            expect(firstBatch[0].plainText).not.toContain(
                "Alpha section second paragraph sentence."
            );
            expect(firstBatch[0].plainText).not.toContain("Bravo section");
        });
    });

    describe("viewport rank computed once per wave (cohesion W2)", () => {
        const entryFor = (top, bottom, inputTokens = 100) => {
            const el = document.createElement("p");
            el.getBoundingClientRect = () => ({ top, bottom, width: 200, height: bottom - top });
            return { section: { children: [el] }, inputTokens };
        };

        it("returns a rank Map covering every entry without stamping the entries", () => {
            const controller = new BannerController();
            const entries = [entryFor(10, 40), entryFor(5000, 5030), entryFor(-6000, -5970)];
            const rankMap = controller.prioritizeAiPageSectionEntriesByViewport(entries);
            expect(rankMap.size).toBe(3);
            for (const entry of entries) {
                expect(rankMap.has(entry)).toBe(true);
                // The rank lives only in the local Map — never on the entry (so it cannot leak
                // into the cross-wave backlog).
                expect(entry._viewportRank).toBeUndefined();
            }
        });

        it("rank-based lazy window matches the per-entry rect path exactly", () => {
            const controller = new BannerController();
            const vh = window.innerHeight || 800;
            const belowLimit = vh * 2.5;
            const aboveLimit = vh * 0.5;
            const cases = [
                entryFor(10, 40), // visible
                entryFor(vh + 50, vh + 80), // just below the window edge
                entryFor(vh * 4, vh * 4 + 30), // far below → outside window
                entryFor(-vh * 4, -vh * 4 + 30), // far above → outside window
            ];
            for (const entry of cases) {
                const rank = controller.getAiPageSectionViewportRank(entry, 0);
                expect(controller.isLazyWindowRankWithin(rank, belowLimit, aboveLimit)).toBe(
                    controller.isEntryWithinLazyViewportWindow(entry, belowLimit, aboveLimit)
                );
            }
        });

        it("lazy window partitions identically with and without the reused rank Map", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._aiPageConfig = controller.normalizeAiPageConfig({ lazyTranslate: true });
            const entries = [
                entryFor(10, 40),
                entryFor(window.innerHeight * 4, window.innerHeight * 4 + 30),
                entryFor(-window.innerHeight * 4, -window.innerHeight * 4 + 30),
            ];
            // Rank once (also reorders in place), then partition both ways from the SAME order.
            const rankMap = controller.prioritizeAiPageSectionEntriesByViewport(entries);
            const withMap = controller.selectAiPageEntriesForLazyWindow(entries, rankMap);
            const withoutMap = controller.selectAiPageEntriesForLazyWindow(entries);
            expect(withMap.keep).toEqual(withoutMap.keep);
            expect(withMap.deferred).toEqual(withoutMap.deferred);
        });
    });

    describe("failure salvage of streamed batch units (speed redesign W3)", () => {
        it("collects only the strictly-increasing complete prefix of streamed [[n]] units", () => {
            const controller = new BannerController();
            // Walk reached the buffer end → the positionally-last unit may be a truncated
            // mid-generation tail → dropped.
            expect(controller.collectSalvageableSegmentNumbers("[[1]]a [[2]]b [[3]]c")).toEqual([
                1, 2,
            ]);
            // Walk STOPPED by an out-of-order marker → the last collected unit is bounded
            // by the discarded marker, hence complete — kept.
            expect(controller.collectSalvageableSegmentNumbers("[[1]]a [[3]]c [[2]]x")).toEqual([
                1, 3,
            ]);
            // A duplicate marker also stops the walk and keeps the bounded prefix.
            expect(controller.collectSalvageableSegmentNumbers("[[1]]a [[1]]b")).toEqual([1]);
            expect(controller.collectSalvageableSegmentNumbers("")).toEqual([]);
        });

        it("salvages complete streamed units into the per-string cache with one persistent save", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller.channel.emit = jest.fn();
            const unitTexts = ["Hello world.", "Good morning.", "Other sentence."];
            const streamed = "[[1]]\n안녕하세요 세상.\n[[2]]\nGood morning.\n[[3]]\n좋은";

            const salvaged = controller.salvageStreamedAiPageBatchUnits(streamed, unitTexts);

            // Complete unit → cached; source echo → rejected; truncated tail → dropped.
            expect(salvaged).toBe(1);
            expect(controller.getCachedSegmentText("Hello world.")).toBe("안녕하세요 세상.");
            expect(controller.getCachedSegmentText("Good morning.")).toBeNull();
            expect(controller.getCachedSegmentText("Other sentence.")).toBeNull();
            expect(controller.channel.emit).toHaveBeenCalledTimes(1);
            const [event, detail] = controller.channel.emit.mock.calls[0];
            expect(event).toBe("persistent_segment_save");
            expect(detail.entries).toHaveLength(1);
            expect(detail.entries[0].value).toBe("안녕하세요 세상.");
        });

        it("does not emit a salvage save for an empty stream buffer", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller.channel.emit = jest.fn();

            expect(controller.salvageStreamedAiPageBatchUnits("", ["Hello world."])).toBe(0);

            expect(controller.channel.emit).not.toHaveBeenCalled();
        });

        it("salvages streamed units when the batch throws so the retry resends only the tail", async () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="first">Hello world.</p>
                    <p id="second">Good morning.</p>
                </article>
            `;
            const article = document.getElementById("article");
            const first = document.getElementById("first");
            const second = document.getElementById("second");
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
            controller.channel.emit = jest.fn();
            const translatePayloads = [];
            controller.channel.request = jest.fn((service, payload) => {
                if (!payload || typeof payload.text !== "string") return Promise.resolve([]);
                translatePayloads.push(payload.text);
                if (translatePayloads.length === 1) {
                    // Stream most of the reply, then die (network drop / timeout).
                    const streamHandler = controller.channel.on.mock.calls.find(
                        ([event]) => event === "translation_stream_progress"
                    )[1];
                    streamHandler({
                        streamId: payload.streamId,
                        text: "[[1]]\n안녕하세요 세상.\n[[2]]\n좋은",
                    });
                    return Promise.reject(new Error("stream dropped"));
                }
                return Promise.resolve({ mainMeaning: "[[1]]\n좋은 아침입니다." });
            });

            controller.enqueueAiPageSectionBatchTranslation([
                {
                    section: { parent: article, children: [first, second], role: "paragraph" },
                    segBlocks: [first, second],
                    segTexts: ["Hello world.", "Good morning."],
                    sourceText: "[[1]]\nHello world.\n[[2]]\nGood morning.",
                    plainText: "Hello world. Good morning.",
                    cacheKey: "salvage-batch",
                    attempt: 0,
                },
            ]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            // The complete streamed unit was harvested into the caches on failure…
            const saveCalls = controller.channel.emit.mock.calls.filter(
                ([event]) => event === "persistent_segment_save"
            );
            expect(saveCalls.length).toBeGreaterThanOrEqual(1);
            expect(saveCalls[0][1].entries).toHaveLength(1);
            expect(saveCalls[0][1].entries[0].value).toBe("안녕하세요 세상.");
            // …so the automatic retry regenerated ONLY the missing tail unit.
            expect(translatePayloads).toHaveLength(2);
            expect(translatePayloads[1]).toContain("Good morning.");
            expect(translatePayloads[1]).not.toContain("Hello world.");
            expect(first.textContent).toBe("안녕하세요 세상.");
            expect(second.textContent).toBe("좋은 아침입니다.");
            expect(controller._domCompletedTranslationEntries).toBe(1);
        });
    });

    describe("'=' keep-source protocol (speed redesign W3)", () => {
        it("keeps a verified '=' sentinel and deletes an unverified one from a reply map", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "ja", tl: "ko" };
            controller._domResolvedSourceLanguage = "ja";
            const entry = {
                segTexts: ["안녕하세요. 반갑습니다.", "こんにちは世界、また会いましたね。"],
            };
            const map = new Map([
                [1, "="],
                [2, "="],
            ]);

            controller.sanitizeAiPageSegmentMap(map, entry);

            // Already-target-language source: verified — the sentinel survives.
            expect(map.get(1)).toBe("=");
            // Kana/kanji source still carries source-script letters: the unverified '='
            // is deleted so the segment stays unresolved for the bounded retry path.
            expect(map.has(2)).toBe(false);
        });

        it("accepts '=' for identifier-class sources with no source-script letters", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "ja", tl: "ko" };
            controller._domResolvedSourceLanguage = "ja";

            expect(controller.isAcceptableKeepSourceSentinel("KH01-1067mm")).toBe(true);
        });

        it("strips a '= ' prefix from a normal translation (key=value protocol misread)", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            const entry = { segTexts: ["Hello world."] };
            const map = new Map([[1, "= 번역 텍스트"]]);

            controller.sanitizeAiPageSegmentMap(map, entry);

            expect(map.get(1)).toBe("번역 텍스트");
        });

        it("stores '=' session-only: the sentinel never reaches the persistent store", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            controller.channel.emit = jest.fn();
            const entry = {
                segBlocks: [document.createElement("p"), document.createElement("p")],
                segTexts: ["이미 번역된 한국어 문장입니다.", "Hello world."],
            };

            controller.storeEntrySegmentCache(
                entry,
                new Map([
                    [1, "="],
                    [2, "안녕 세상."],
                ])
            );

            // The session cache holds the (re-verified) sentinel…
            expect(controller.getCachedSegmentText("이미 번역된 한국어 문장입니다.")).toBe("=");
            expect(controller.getCachedSegmentText("Hello world.")).toBe("안녕 세상.");
            // …but only the normal unit is persisted to IDB.
            expect(controller.channel.emit).toHaveBeenCalledTimes(1);
            const [event, detail] = controller.channel.emit.mock.calls[0];
            expect(event).toBe("persistent_segment_save");
            expect(detail.entries).toHaveLength(1);
            expect(detail.entries[0].value).toBe("안녕 세상.");
        });

        it("resolves a '=' cached leaf with no DOM write and no hover original", () => {
            document.body.innerHTML = `<p id="keep">이미 번역된 한국어 문장입니다.</p>`;
            const leaf = document.getElementById("keep");
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";

            expect(controller.applyCachedLeafTranslation(leaf, "=")).toBe(true);

            expect(leaf.textContent).toBe("이미 번역된 한국어 문장입니다.");
            expect(controller._aiSectionTranslatedChildren.has(leaf)).toBe(true);
            // No hover original: the tooltip would show text identical to the screen.
            expect(controller._domOriginalTextByElement.get(leaf)).toBeUndefined();
        });

        it("finalizes a batch reply mixing '=' keep-source and a real translation", async () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="keep">안녕하세요. 반갑습니다.</p>
                    <p id="translate">Hello world.</p>
                </article>
            `;
            const article = document.getElementById("article");
            const keep = document.getElementById("keep");
            const translate = document.getElementById("translate");
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([keep, translate]);
            controller.channel.emit = jest.fn();
            controller.channel.request = jest.fn((service, payload) => {
                if (!payload || typeof payload.text !== "string") return Promise.resolve([]);
                return Promise.resolve({ mainMeaning: "[[1]]\n=\n[[2]]\n안녕 세상." });
            });
            const entry = {
                section: { parent: article, children: [keep, translate], role: "paragraph" },
                segBlocks: [keep, translate],
                segTexts: ["안녕하세요. 반갑습니다.", "Hello world."],
                sourceText: "[[1]]\n안녕하세요. 반갑습니다.\n[[2]]\nHello world.",
                plainText: "안녕하세요. 반갑습니다. Hello world.",
                cacheKey: "keep-source-mixed",
                attempt: 0,
            };

            controller.enqueueAiPageSectionBatchTranslation([entry]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            // The '=' leaf resolves with its text untouched; the other leaf translates;
            // the entry converges with no partial retry.
            expect(keep.textContent).toBe("안녕하세요. 반갑습니다.");
            expect(translate.textContent).toBe("안녕 세상.");
            expect(entry._needsPartialRetry).toBe(false);
            const translateCalls = controller.channel.request.mock.calls.filter(
                (call) => call[1] && typeof call[1].text === "string"
            );
            expect(translateCalls).toHaveLength(1);
            expect(controller._domCompletedTranslationEntries).toBe(1);
        });

        it("finalizes an all-sentinel reply without a release/re-dispatch loop", async () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="keep">안녕하세요. 반갑습니다.</p>
                </article>
            `;
            const article = document.getElementById("article");
            const keep = document.getElementById("keep");
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet();
            controller.channel.emit = jest.fn();
            controller.channel.request = jest.fn((service, payload) => {
                if (!payload || typeof payload.text !== "string") return Promise.resolve([]);
                return Promise.resolve({ mainMeaning: "[[1]]\n=" });
            });
            const entry = {
                section: { parent: article, children: [keep], role: "paragraph" },
                segBlocks: [keep],
                segTexts: ["안녕하세요. 반갑습니다."],
                sourceText: "[[1]]\n안녕하세요. 반갑습니다.",
                plainText: "안녕하세요. 반갑습니다.",
                cacheKey: "keep-source-all",
                attempt: 0,
            };

            controller.enqueueAiPageSectionBatchTranslation([entry]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            // The sentinel COUNTS as applied — without that, an all-sentinel entry would
            // report applied=0 and be released and re-dispatched forever.
            expect(keep.textContent).toBe("안녕하세요. 반갑습니다.");
            expect(entry._segApplied).toBe(1);
            expect(controller._aiSectionTranslatedChildren.has(keep)).toBe(true);
            const translateCalls = controller.channel.request.mock.calls.filter(
                (call) => call[1] && typeof call[1].text === "string"
            );
            expect(translateCalls).toHaveLength(1);
            expect(controller._domCompletedTranslationEntries).toBe(1);
        });
    });

    describe("global rAF coalescer for batch stream applies (speed redesign W3)", () => {
        const makeEntry = (block, sourceText) => ({
            segBlocks: [block],
            segTexts: [sourceText],
            batchUnitOf: [0],
            _segAppliedSet: new Set(),
        });

        it("drains all pending streams in one animation frame", () => {
            let rafCallback = null;
            let rafCalls = 0;
            global.requestAnimationFrame = (callback) => {
                rafCalls += 1;
                rafCallback = callback;
                return rafCalls;
            };
            document.body.innerHTML = `
                <p id="first">Hello world.</p>
                <p id="second">Good evening.</p>
            `;
            const first = document.getElementById("first");
            const second = document.getElementById("second");
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            const entryA = makeEntry(first, "Hello world.");
            const entryB = makeEntry(second, "Good evening.");

            controller.scheduleAiPageBatchStreamApply(
                "stream-a",
                () => [entryA],
                () => "[[1]]\n안녕 세상.\n[[2]]",
                () => false
            );
            controller.scheduleAiPageBatchStreamApply(
                "stream-b",
                () => [entryB],
                () => "[[1]]\n좋은 저녁.\n[[2]]",
                () => false
            );

            // Two pending streams coalesce into ONE scheduled frame…
            expect(rafCalls).toBe(1);
            expect(first.textContent).toBe("Hello world.");
            rafCallback();
            // …whose single drain applies both streams' completed units.
            expect(first.textContent).toBe("안녕 세상.");
            expect(second.textContent).toBe("좋은 저녁.");
            expect(entryA._segAppliedSet.has(1)).toBe(true);
            expect(entryB._segAppliedSet.has(1)).toBe(true);
        });

        it("skips a stream whose run already finished by drain time", () => {
            let rafCallback = null;
            global.requestAnimationFrame = (callback) => {
                rafCallback = callback;
                return 1;
            };
            document.body.innerHTML = `<p id="leaf">Hello world.</p>`;
            const leaf = document.getElementById("leaf");
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            const entry = makeEntry(leaf, "Hello world.");

            controller.scheduleAiPageBatchStreamApply(
                "stream-finished",
                () => [entry],
                () => "[[1]]\n안녕 세상.\n[[2]]",
                () => true // run finished — a stale drain must never apply its text
            );
            rafCallback();

            expect(leaf.textContent).toBe("Hello world.");
            expect(entry._segAppliedSet.size).toBe(0);
        });

        it("drainAiPageBatchStreamApplyFor applies synchronously and unregisters the stream", () => {
            let rafCallback = null;
            global.requestAnimationFrame = (callback) => {
                rafCallback = callback;
                return 1;
            };
            document.body.innerHTML = `<p id="leaf">Hello world.</p>`;
            const leaf = document.getElementById("leaf");
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            const entry = makeEntry(leaf, "Hello world.");
            const getText = jest.fn(() => "[[1]]\n안녕 세상.\n[[2]]");

            controller.scheduleAiPageBatchStreamApply(
                "stream-final",
                () => [entry],
                getText,
                () => false
            );
            controller.drainAiPageBatchStreamApplyFor("stream-final");

            // Applied synchronously, before the frame fires…
            expect(leaf.textContent).toBe("안녕 세상.");
            expect(getText).toHaveBeenCalledTimes(1);

            // …and the later global drain no longer sees this stream (no double apply).
            rafCallback();
            expect(getText).toHaveBeenCalledTimes(1);
        });
    });

    describe("full-page token budget default (translate the whole page)", () => {
        it("defaults the AI page token budget to 0 (no cap) and migrates the legacy 16000", () => {
            const controller = new BannerController();
            // Fresh default: no cap — the backlog drains the whole page.
            expect(controller.normalizeAiPageConfig({}).tokenBudget).toBe(0);
            // 16000 was the original shipped default with NO UI — a stored 16000 is the old
            // default persisted by getOrSetDefaultSettings, not a user choice. Migrate to 0.
            expect(controller.normalizeAiPageConfig({ tokenBudget: 16000 }).tokenBudget).toBe(0);
            // Any other explicitly-edited value is honored.
            expect(controller.normalizeAiPageConfig({ tokenBudget: 8000 }).tokenBudget).toBe(8000);
        });
    });

    describe("echo-as-keep-source (end-of-page retry token burn)", () => {
        it("resolves an echoed identifier-class segment as keep-source instead of retrying", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            controller._domResolvedSourceLanguage = "ja";
            const entry = { segTexts: ["KH01-1067mm"], segBlocks: [document.createElement("p")] };
            const map = new Map([[1, "KH01-1067mm"]]); // model echoed the identifier
            controller.sanitizeAiPageSegmentMap(map, entry);
            // Verified identity -> '=' sentinel: resolved on the FIRST reply, no retry loop.
            expect(map.get(1)).toBe("=");
        });

        it("still rejects an echo of translatable source-script text", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            controller._domResolvedSourceLanguage = "ja";
            const entry = {
                segTexts: ["京阪本線は鉄道路線である。"],
                segBlocks: [document.createElement("p")],
            };
            const map = new Map([[1, "京阪本線は鉄道路線である。"]]); // echo of real ja prose
            controller.sanitizeAiPageSegmentMap(map, entry);
            // Not verifiable as keep-source -> deleted (stays eligible for retry).
            expect(map.has(1)).toBe(false);
        });

        it("resolves an echoed already-target-language segment as keep-source", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
            controller._domResolvedSourceLanguage = "ja";
            const entry = {
                segTexts: ["이미 한국어로 된 문장입니다."],
                segBlocks: [document.createElement("p")],
            };
            const map = new Map([[1, "이미 한국어로 된 문장입니다."]]);
            controller.sanitizeAiPageSegmentMap(map, entry);
            expect(map.get(1)).toBe("=");
        });
    });

    describe("stream-credit finalize for fully stream-applied entries (adversarial review)", () => {
        const buildTwoBlockPage = () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="first">Hello world.</p>
                    <p id="second">Good morning.</p>
                </article>
            `;
            return {
                article: document.getElementById("article"),
                first: document.getElementById("first"),
                second: document.getElementById("second"),
            };
        };

        it("finalizes as SUCCESS when the final apply lands 0 new segments after the stream", () => {
            const { article, first, second } = buildTwoBlockPage();
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller.channel.emit = jest.fn();
            const entry = {
                section: { parent: article, children: [first, second], role: "paragraph" },
                segBlocks: [first, second],
                segTexts: ["Hello world.", "Good morning."],
                cacheKey: "stream-credit-direct",
                attempt: 0,
            };

            controller.buildAiPageBatchPayload([entry]);
            // Stream EVERY unit before the final apply (the [[3]] tail marker bounds
            // [[2]] as complete, so both units land via the stream path).
            controller.applyStreamedAiPageSectionBatchSegments(
                [entry],
                "[[1]]\n번역 하나.\n[[2]]\n번역 둘.\n[[3]]"
            );
            expect(entry._segAppliedSet.size).toBe(2);
            expect(first.textContent).toBe("번역 하나.");
            expect(second.textContent).toBe("번역 둘.");

            const ok = controller.applyAiPageSectionBatchEntry(
                entry,
                new Map([
                    [1, "번역 하나."],
                    [2, "번역 둘."],
                ])
            );

            // The final apply writes 0 NEW segments — the stream credit must still
            // classify the entry as translated, not "nothing ever applied".
            expect(ok).toBe(true);
            expect(controller._aiSectionTranslatedChildren.has(first)).toBe(true);
            expect(controller._aiSectionTranslatedChildren.has(second)).toBe(true);
            expect(entry._needsPartialRetry).toBe(false);
        });

        it("treats a fully streamed batch as success end-to-end: no failure, no re-dispatch", async () => {
            const { article, first, second } = buildTwoBlockPage();
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
            controller.channel.emit = jest.fn();
            const failureSpy = jest.spyOn(controller, "recordDomPageBatchFailure");
            controller.channel.request = jest.fn((service, payload) => {
                if (!payload || typeof payload.text !== "string") return Promise.resolve([]);
                const streamHandler = controller.channel.on.mock.calls.find(
                    ([event]) => event === "translation_stream_progress"
                )[1];
                // The synchronous rAF mock drains the coalesced stream apply at once, so
                // BOTH units are already on the page when the request resolves.
                streamHandler({
                    streamId: payload.streamId,
                    text: "[[1]]\n번역 하나.\n[[2]]\n번역 둘.\n[[3]]",
                });
                return Promise.resolve({ mainMeaning: "[[1]]\n번역 하나.\n[[2]]\n번역 둘." });
            });
            const entry = {
                section: { parent: article, children: [first, second], role: "paragraph" },
                segBlocks: [first, second],
                segTexts: ["Hello world.", "Good morning."],
                sourceText: "[[1]]\nHello world.\n[[2]]\nGood morning.",
                plainText: "Hello world. Good morning.",
                cacheKey: "stream-credit-batch",
                attempt: 0,
            };

            controller.enqueueAiPageSectionBatchTranslation([entry]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(first.textContent).toBe("번역 하나.");
            expect(second.textContent).toBe("번역 둘.");
            // A perfectly translated streamed batch must never be telemetried as a
            // failure (which would collapse batch scale and feed the breaker)…
            expect(failureSpy).not.toHaveBeenCalled();
            // …nor re-dispatched: exactly one translate request total.
            const translateCalls = controller.channel.request.mock.calls.filter(
                (call) => call[1] && typeof call[1].text === "string"
            );
            expect(translateCalls).toHaveLength(1);
            expect(controller._domCompletedTranslationEntries).toBe(1);
        });
    });

    describe("session bump gating for in-flight batch runs (adversarial review)", () => {
        it("suppresses salvage, persistence and accounting when the session bumps mid-flight", async () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="first">Hello world.</p>
                    <p id="second">Good morning.</p>
                </article>
            `;
            const article = document.getElementById("article");
            const first = document.getElementById("first");
            const second = document.getElementById("second");
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller._domMaxConcurrentTranslations = 1;
            controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
            controller.channel.emit = jest.fn();
            controller.channel.request = jest.fn(async (service, payload) => {
                if (!payload || typeof payload.text !== "string") return [];
                const streamHandler = controller.channel.on.mock.calls.find(
                    ([event]) => event === "translation_stream_progress"
                )[1];
                // Stream one COMPLETE unit (salvageable), then the user re-triggers
                // translation (session bump), then the request dies.
                streamHandler({
                    streamId: payload.streamId,
                    text: "[[1]]\n프랑스어 텍스트.\n[[2]]",
                });
                controller.resetDomPageRuntimeState();
                // The real re-trigger (startDomPageTranslate) zeroes the active counter
                // for the new session right after the reset.
                controller._domActiveTranslations = 0;
                throw new Error("network");
            });
            const entry = {
                section: { parent: article, children: [first, second], role: "paragraph" },
                segBlocks: [first, second],
                segTexts: ["Hello world.", "Good morning."],
                sourceText: "[[1]]\nHello world.\n[[2]]\nGood morning.",
                plainText: "Hello world. Good morning.",
                cacheKey: "session-bump-batch",
                attempt: 0,
            };

            controller.enqueueAiPageSectionBatchTranslation([entry]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            // The stale run salvaged nothing into the (new session's) caches…
            const saveCalls = controller.channel.emit.mock.calls.filter(
                ([event]) => event === "persistent_segment_save"
            );
            expect(saveCalls).toHaveLength(0);
            expect(controller.getCachedSegmentText("Hello world.")).toBeNull();
            // …queued no retry for the torn-down session…
            const translateCalls = controller.channel.request.mock.calls.filter(
                (call) => call[1] && typeof call[1].text === "string"
            );
            expect(translateCalls).toHaveLength(1);
            // …and skipped its finally-side accounting: the NEW session's active count
            // is not driven negative and its completion total is untouched.
            expect(controller._domActiveTranslations).toBe(0);
            expect(controller._domCompletedTranslationEntries).toBe(0);
        });
    });

    describe("circuit-breaker drain gap registration (adversarial review)", () => {
        const buildBreakerPage = () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="first">Hello world.</p>
                    <p id="second">Good morning.</p>
                </article>
            `;
            return {
                article: document.getElementById("article"),
                first: document.getElementById("first"),
                second: document.getElementById("second"),
            };
        };

        const buildBreakerEntries = (controller, { article, first, second }) => {
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            controller._domCircuitBreakerActive = true;
            controller._aiSectionTranslatedChildren = new WeakSet([first, second]);
            const fresh = {
                section: { parent: article, children: [first], role: "paragraph" },
                segBlocks: [first],
                segTexts: ["Hello world."],
                cacheKey: "breaker-fresh",
                attempt: 0,
            };
            const alreadyCounted = {
                section: { parent: article, children: [second], role: "paragraph" },
                segBlocks: [second],
                segTexts: ["Good morning."],
                cacheKey: "breaker-counted",
                attempt: 0,
                // A batch already counted this entry before handing it over — the
                // idempotent mark must not count it again.
                _counted: true,
            };
            return { fresh, alreadyCounted };
        };

        const expectBreakerDrainOutcome = (controller, { first, second }, fresh) => {
            // Drained children stay visible to the post-breaker coverage pass…
            expect(controller.isElementRelatedToDomGapCandidate(first)).toBe(true);
            expect(controller.isElementRelatedToDomGapCandidate(second)).toBe(true);
            // …are released (eligible for re-collection)…
            expect(controller._aiSectionTranslatedChildren.has(first)).toBe(false);
            expect(controller._aiSectionTranslatedChildren.has(second)).toBe(false);
            // …and are counted via the idempotent per-entry mark: the fresh entry once,
            // the already-counted one never again (a raw counter would double-count).
            expect(fresh._counted).toBe(true);
            expect(controller._domCompletedTranslationEntries).toBe(1);
        };

        it("single path: drained entries become gap candidates and count idempotently", async () => {
            const page = buildBreakerPage();
            const controller = new BannerController();
            const { fresh, alreadyCounted } = buildBreakerEntries(controller, page);

            controller.enqueueAiPageSectionTranslation(fresh);
            controller.enqueueAiPageSectionTranslation(alreadyCounted);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expectBreakerDrainOutcome(controller, page, fresh);
        });

        it("batch path: drained entries become gap candidates and count idempotently", async () => {
            const page = buildBreakerPage();
            const controller = new BannerController();
            const { fresh, alreadyCounted } = buildBreakerEntries(controller, page);

            controller.enqueueAiPageSectionBatchTranslation([fresh, alreadyCounted]);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expectBreakerDrainOutcome(controller, page, fresh);
        });
    });

    describe("keep-source sentinel script gating (adversarial review)", () => {
        it("rejects kanji-only Japanese but accepts identifiers and already-target hangul", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "ja", tl: "ko" };
            controller._domResolvedSourceLanguage = "ja";

            // Kanji-only Japanese: the narrow ja source pattern (kana-only) cannot vouch
            // for it, and its non-Latin letters mean real language content — never an
            // "identifier". Accepting '=' here would freeze the leaf untranslated.
            expect(controller.isAcceptableKeepSourceSentinel("京阪電気鉄道")).toBe(false);
            // Identifier class: every letter present is Latin.
            expect(controller.isAcceptableKeepSourceSentinel("KH01-1067mm")).toBe(true);
            // Already in the target language (hangul with tl ko): verified keep-source.
            expect(
                controller.isAcceptableKeepSourceSentinel("이미 번역된 한국어 문장입니다.")
            ).toBe(true);
        });
    });

    describe("sentinel persistence boundaries (adversarial review)", () => {
        it("strips the '=' line from the persisted entry payload but keeps the session copy", () => {
            document.body.innerHTML = `
                <article id="article">
                    <p id="keep">이미 번역된 한국어 문장입니다.</p>
                    <p id="translate">Hello world.</p>
                </article>
            `;
            const article = document.getElementById("article");
            const keep = document.getElementById("keep");
            const translate = document.getElementById("translate");
            const controller = new BannerController();
            controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
            controller._domResolvedSourceLanguage = "en";
            controller.channel.emit = jest.fn();
            const persistSpy = jest
                .spyOn(controller, "savePersistentTranslationCacheEntry")
                .mockImplementation(() => {});
            const entry = {
                section: { parent: article, children: [keep, translate], role: "paragraph" },
                segBlocks: [keep, translate],
                segTexts: ["이미 번역된 한국어 문장입니다.", "Hello world."],
                cacheKey: "sentinel-persist-split",
                attempt: 0,
            };

            const ok = controller.applyAiPageSectionBatchEntry(
                entry,
                new Map([
                    [1, "="],
                    [2, "안녕 세상."],
                ])
            );

            expect(ok).toBe(true);
            // The SESSION entry cache round-trips both blocks, sentinel included…
            expect(controller._domTranslationCache.get("sentinel-persist-split")).toBe(
                "[[1]]\n=\n[[2]]\n안녕 세상."
            );
            // …but the PERSISTED payload carries only the real translation — a wrong
            // '=' must never become permanent.
            expect(persistSpy).toHaveBeenCalledTimes(1);
            expect(persistSpy.mock.calls[0][1]).toBe("[[2]]\n안녕 세상.");
            expect(persistSpy.mock.calls[0][1]).not.toContain("=");
            // The per-string persistent save likewise excludes the sentinel unit.
            const saveCalls = controller.channel.emit.mock.calls.filter(
                ([event]) => event === "persistent_segment_save"
            );
            expect(saveCalls).toHaveLength(1);
            expect(saveCalls[0][1].entries).toHaveLength(1);
            expect(saveCalls[0][1].entries[0].value).toBe("안녕 세상.");
        });

        it("salvage stores a verified '=' session-only and persists only the real unit", () => {
            const controller = new BannerController();
            controller._domPageTranslateOptions = {
                engine: "openaiCompatible",
                sl: "en",
                tl: "ko",
            };
            controller._domResolvedSourceLanguage = "en";
            controller.channel.emit = jest.fn();

            const salvaged = controller.salvageStreamedAiPageBatchUnits(
                "[[1]]\n=\n[[2]]\n번역.\n[[3]]\nx",
                ["이미 번역된 한국어 문장입니다.", "Hello world.", "tail"]
            );

            // The return value counts PERSISTENT saves only — the sentinel is not one.
            expect(salvaged).toBe(1);
            // Verified '=' lands in the per-string session cache…
            expect(controller.getCachedSegmentText("이미 번역된 한국어 문장입니다.")).toBe("=");
            expect(controller.getCachedSegmentText("Hello world.")).toBe("번역.");
            // …the truncated positionally-last unit is dropped…
            expect(controller.getCachedSegmentText("tail")).toBeNull();
            // …and the persistent save carries ONLY the real translation, never '='.
            expect(controller.channel.emit).toHaveBeenCalledTimes(1);
            const [event, detail] = controller.channel.emit.mock.calls[0];
            expect(event).toBe("persistent_segment_save");
            expect(detail.entries).toHaveLength(1);
            expect(detail.entries[0].value).toBe("번역.");
        });
    });
});
