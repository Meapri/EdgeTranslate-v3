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
        controller.showDomPageBanner();
        await Promise.resolve();

        const banner = document.getElementById("edge-translate-dom-page-banner");
        expect(banner).not.toBeNull();
        expect(banner.shadowRoot.textContent).toContain("Page translation");
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
        expect(banner.shadowRoot.textContent).toContain("Preparing page text");
        expect(document.body.style.getPropertyValue("top")).toBe("56px");

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
        expect(document.body.style.getPropertyValue("top")).toBe("56px");

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
        expect(controller.getReadableBlockReplacementOptions()).toEqual({ maxChars: 12000 });
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

    it("rescans newly visible infinite-scroll text after scroll", () => {
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
            controller.startDomFallback();

            const paragraph = document.createElement("p");
            paragraph.textContent = "New infinite scroll paragraph with enough text.";
            document.querySelector("main").appendChild(paragraph);

            window.dispatchEvent(new Event("scroll"));
            jest.advanceTimersByTime(500);

            const translatedNodes = controller.translateBatchNodes.mock.calls.flatMap(
                ([nodes]) => nodes || []
            );
            expect(translatedNodes).toContain(paragraph.firstChild);

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
        expect(lines).toHaveLength(2);
        expect(lines[0].dataset.role).toBe("previous-caption");
        expect(lines[0].textContent).toBe("첫 번째 자막.");
        expect(lines[0].style.animation).toContain("edgeCaptionPreviousLift");
        expect(lines[1].dataset.role).toBe("current-caption");
        expect(lines[1].textContent).toBe("두 번째 자막.");
        expect(lines[1].style.animation).toContain("edgeCaptionCurrentSlide");
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
        expect(overlay.textContent).toBe("최신 자막.");
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
            expect(overlay.textContent).toBe("두 번째 실시간 자막.");
        } finally {
            jest.useRealTimers();
        }
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
        expect(controller.getReadableBlockReplacementOptions()).toEqual({ maxChars: 12000 });
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
        expect(controller.getReadableBlockReplacementOptions()).toEqual({ maxChars: 12000 });
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

    it("keeps site chrome and article text in DOM order without priority sorting", () => {
        document.body.innerHTML = `
            <header><nav id="nav">Account Settings</nav></header>
            <main><article><p id="article">This is the main article paragraph with enough context to translate naturally.</p></article></main>
            <footer id="footer">Privacy Policy</footer>
        `;
        const controller = new BannerController();
        const navNode = document.getElementById("nav").firstChild;
        const articleNode = document.getElementById("article").firstChild;
        const footerNode = document.getElementById("footer").firstChild;

        expect(controller.isMeaningfulDomPageTextNode(navNode)).toBe(true);
        expect(controller.isMeaningfulDomPageTextNode(footerNode)).toBe(true);
        expect(controller.collectDomPageTextNodes([document.body])).toEqual([
            navNode,
            articleNode,
            footerNode,
        ]);
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
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
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

    it("skips non-article dynamic widget text while keeping article text collectible", () => {
        document.body.innerHTML = `
            <section class="article-comments">
                <p id="comment">This late comment widget should not spend page translation tokens.</p>
            </section>
            <article>
                <p id="body">This article paragraph should remain eligible for translation.</p>
            </article>
        `;
        const controller = new BannerController();
        const commentNode = document.getElementById("comment").firstChild;
        const bodyNode = document.getElementById("body").firstChild;

        expect(controller.isMeaningfulDomPageTextNode(commentNode)).toBe(false);
        expect(controller.isMeaningfulDomPageTextNode(bodyNode)).toBe(true);
        expect(controller.collectDomPageTextNodes([document.body])).toEqual([bodyNode]);
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
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
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
        controller._domPageTranslateOptions = { engine: "openai", sl: "en", tl: "ko" };
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

        controller.enqueueDomPageBatchTranslation([firstEntry]);
        controller.enqueueDomPageBatchTranslation([secondEntry]);
        controller.triggerDomPageCircuitBreaker();
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
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
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
            expect(paragraph.textContent).toBe("번역된 문장.");
            expect(translatedSpan).not.toBeNull();
            expect(translatedSpan.classList.contains("et-dom-original-source")).toBe(false);
            expect(document.getElementById("edge-translate-dom-original-tooltip")).toBeNull();

            translatedSpan.dispatchEvent(
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
            expect(translatedSpan.classList.contains("et-dom-original-source")).toBe(true);
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

    it("translates paragraphs with inline links as one natural sentence", () => {
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

            expect(entry.readableBlockReplacement.sourceText).toContain(
                "[[EDGE_TRANSLATE_LINK_1]]"
            );
            expect(
                controller.applyDomPageTranslatedEntry(
                    entry,
                    "나는 [[EDGE_TRANSLATE_LINK_1]]LM Studio[[/EDGE_TRANSLATE_LINK_1]]를 로컬 LLM의 기본 실행기로 사용해 왔다."
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
            expect(tooltip.textContent).not.toContain("EDGE_TRANSLATE_LINK");
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
            mainMeaning:
                "자세한 내용은 [[EDGE_TRANSLATE_LINK_1]]계정 공지[[/EDGE_TRANSLATE_LINK_1]]를 확인해 주세요.",
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

    it("falls back from linked block replacement to text-node context on retry", () => {
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

        expect(entry.readableBlockReplacement).not.toBeNull();

        controller.retryDomPageEntryTranslation(entry, 0);
        const retryEntry = controller.createDomPageTranslationEntry(group);

        expect(group.forceDomPageContext).toBe(true);
        expect(retryEntry.readableBlockReplacement).toBeNull();
        expect(retryEntry.sourceText).toBe("Account notice\nis available.");
    });

    it("strips leaked inline link placeholders in fallback text-node translations", () => {
        document.body.innerHTML = `<p id="line">See the account notice.</p>`;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "en", tl: "ko" };
        const node = document.getElementById("line").firstChild;

        controller.applyWithFadeIn(
            node,
            "자세한 내용은 [[EDGE_TRANSLATE_LINK_1]]회원 계정 공지[[/EDGE_TRANSLATE_LINK_1]]를 확인해 주세요.",
            "text",
            "See the account notice."
        );

        expect(document.getElementById("line").textContent).toBe(
            "자세한 내용은 회원 계정 공지를 확인해 주세요."
        );
    });

    it("shows the original text for the hovered translated fragment only", () => {
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

            expect(controller.applyDomPageTranslatedEntry(entry, "첫 문장.\n둘째 문장.")).toBe(
                true
            );
            const spans = paragraph.querySelectorAll(".et-dom-translated-text");
            expect(spans).toHaveLength(2);

            spans[0].dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);
            const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip.textContent).toContain("First original sentence.");
            expect(tooltip.textContent).not.toContain("Second original sentence.");

            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("collects full-page text without viewport prioritization", () => {
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
        expect(nodes.map((node) => node.nodeValue.trim())).toEqual([
            "Skip navigation text",
            "Visible article text",
            "Deferred article text",
        ]);
    });
});
