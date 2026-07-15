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

jest.mock("../../../src/content/ai_page_translation/index.js", () => ({
    createAiPageTranslationSession: jest.fn(),
}));

import { getOrSetDefaultSettings } from "common/scripts/settings.js";
import { createAiPageTranslationSession } from "../../../src/content/ai_page_translation/index.js";
import { BannerController } from "../../../src/content/banner_controller.js";

function makeVnextController(overrides = {}) {
    let viewMode = "translation";
    return {
        start: jest.fn(() => Promise.resolve({ phase: "translating" })),
        stop: jest.fn((reason) => ({ phase: "cancelled", reason })),
        getStatusSnapshot: jest.fn(() => ({ phase: "idle" })),
        setViewMode: jest.fn((mode) => {
            viewMode = mode === "source" ? "source" : "translation";
            return { mode: viewMode, changed: 1, preserved: 0 };
        }),
        getViewMode: jest.fn(() => viewMode),
        ...overrides,
    };
}

describe("DOM page translation vNext banner wiring", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        localStorage.clear();
        document.body.removeAttribute("style");
        document.documentElement.removeAttribute("data-edge-translate-page-translator");
        getOrSetDefaultSettings.mockResolvedValue({ HidePageTranslatorBanner: false });
        global.requestAnimationFrame = (callback) => {
            callback();
            return 1;
        };
        global.cancelAnimationFrame = jest.fn();
        createAiPageTranslationSession.mockReset();
        createAiPageTranslationSession.mockImplementation(() => makeVnextController());
    });

    it("resolves every cloud AI page-translation request to vNext", () => {
        const controller = new BannerController();
        expect(controller.resolveAiPagePipelineVersion("vnext")).toBe("vnext");
        expect(controller.resolveAiPagePipelineVersion("auto")).toBe("vnext");
        // The former `stable` rollback switch is gone; it now collapses to vNext like every
        // other retired/unknown synced value instead of pinning users to a deleted engine.
        expect(controller.resolveAiPagePipelineVersion("stable")).toBe("vnext");
        expect(controller.resolveAiPagePipelineVersion("v2")).toBe("vnext");
        expect(controller.resolveAiPagePipelineVersion(undefined)).toBe("vnext");

        // The flag also survives config normalization (detail.aiPageConfig path).
        controller._aiPageConfig = controller.normalizeAiPageConfig({ pipelineVersion: "vnext" });
        expect(controller._aiPageConfig.pipelineVersion).toBe("vnext");
        expect(controller.resolveAiPagePipelineVersion(undefined)).toBe("vnext");
        // Retired synced values migrate to the current automatic route.
        controller._aiPageConfig = controller.normalizeAiPageConfig({ pipelineVersion: "v2" });
        expect(controller._aiPageConfig.pipelineVersion).toBe("auto");
        expect(controller.resolveAiPagePipelineVersion(undefined)).toBe("vnext");

        expect(controller.shouldUseAiPageVnext("vnext", "googleAiStudio")).toBe(true);
        expect(controller.shouldUseAiPageVnext("vnext", "openai")).toBe(true);
        expect(controller.shouldUseAiPageVnext("vnext", "openaiCompatible")).toBe(true);
        expect(controller.shouldUseAiPageVnext("vnext", "chromeBuiltin")).toBe(false);
        expect(controller.shouldUseAiPageVnext("auto", "openai")).toBe(true);
    });

    it.each(["googleAiStudio", "openai", "openaiCompatible"])(
        "takes the vnext branch for %s when the flag is set",
        (engine) => {
            const controller = new BannerController();
            controller.startDomPageTranslateVnext = jest.fn();

            controller.startDomPageTranslate({
                engine,
                sl: "en",
                tl: "ko",
                pipelineVersion: "vnext",
            });

            expect(controller.startDomPageTranslateVnext).toHaveBeenCalledTimes(1);
        }
    );

    it("keeps chromeBuiltin on the legacy v1 path even with the flag set", () => {
        const controller = new BannerController();
        controller.startDomPageTranslateVnext = jest.fn();
        controller.prefetchPersistentTranslationCache = jest.fn(() => Promise.resolve());
        controller.startDomFallback = jest.fn();
        controller.startFullPageBatchTranslation = jest.fn();

        controller.startDomPageTranslate({
            engine: "chromeBuiltin",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });

        expect(controller.startDomPageTranslateVnext).not.toHaveBeenCalled();
        expect(controller.startFullPageBatchTranslation).toHaveBeenCalledTimes(1);
        expect(createAiPageTranslationSession).not.toHaveBeenCalled();
        controller.cancelDomPageTranslate();
    });

    it("routes to vNext by default and for the retired explicit stable value", () => {
        const controller = new BannerController();
        controller.startDomPageTranslateVnext = jest.fn();

        controller.startDomPageTranslate({ engine: "openai", sl: "en", tl: "ko" });

        expect(controller.startDomPageTranslateVnext).toHaveBeenCalledTimes(1);

        // A stale synced `stable` value no longer forks to a deleted engine — it now
        // dispatches the vNext session like every other cloud request.
        controller.startDomPageTranslate({
            engine: "openai",
            sl: "en",
            tl: "ko",
            pipelineVersion: "stable",
        });
        expect(controller.startDomPageTranslateVnext).toHaveBeenCalledTimes(2);
        controller.cancelDomPageTranslate();
    });

    it("creates the vNext session with the resolved language/engine options and starts it", async () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "openai",
            model: "gpt-5.4-mini",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        await Promise.resolve();

        expect(createAiPageTranslationSession).toHaveBeenCalledTimes(1);
        const options = createAiPageTranslationSession.mock.calls[0][0];
        expect(options).toMatchObject({
            channel: controller.channel,
            root: document.body,
            sourceLanguage: "en",
            targetLanguage: "ko",
            providerProfileId: "local-ai-page",
            engine: "openai",
            modelId: "gpt-5.4-mini",
        });
        expect(typeof options.onApplied).toBe("function");
        expect(typeof options.onStatus).toBe("function");
        const session = createAiPageTranslationSession.mock.results[0].value;
        expect(session.start).toHaveBeenCalledTimes(1);
        expect(controller._activePagePipeline).not.toBeNull();
        expect(document.getElementById("edge-translate-dom-page-banner")).not.toBeNull();
        controller.cancelDomPageTranslate();
    });

    it("toggles the header button between original and translated page views", () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "openai",
            model: "gpt-5.6-luna",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        const session = createAiPageTranslationSession.mock.results[0].value;
        const host = document.getElementById("edge-translate-dom-page-banner");
        const button = host.shadowRoot.querySelector("[data-action='toggle-view']");
        const label = button.querySelector("[data-role='view-toggle-text']");

        expect(button.hidden).toBe(false);
        expect(button.getAttribute("aria-pressed")).toBe("false");
        expect(label.textContent).toBe("Original");

        button.click();
        expect(session.setViewMode).toHaveBeenLastCalledWith("source");
        expect(button.getAttribute("aria-pressed")).toBe("true");
        expect(label.textContent).toBe("Translation");

        button.click();
        expect(session.setViewMode).toHaveBeenLastCalledWith("translation");
        expect(button.getAttribute("aria-pressed")).toBe("false");
        expect(label.textContent).toBe("Original");
        controller.cancelDomPageTranslate();
    });

    it("shows sentence original over text and paragraph original over its background", () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML =
                '<p id="line">First original sentence. Second original sentence.</p>';
            const controller = new BannerController();
            controller.startDomPageTranslate({
                engine: "openai",
                model: "gpt-5.6-luna",
                sl: "en",
                tl: "ko",
                pipelineVersion: "vnext",
            });
            const options = createAiPageTranslationSession.mock.calls[0][0];
            const paragraph = document.getElementById("line");

            // The vNext committer writes first, then reports the owning element/source pair.
            paragraph.textContent = "첫 번째 번역 문장. 두 번째 번역 문장.";
            options.onApplied({
                element: paragraph,
                kind: "block",
                sourceText: "First original sentence. Second original sentence.",
                translatedText: "첫 번째 번역 문장. 두 번째 번역 문장.",
            });

            const sentenceSpans = paragraph.querySelectorAll(
                "[data-edge-translate-segment]"
            );
            expect(sentenceSpans).toHaveLength(2);
            sentenceSpans.forEach((span) => {
                expect(span.hasAttribute("data-edge-translate-owned")).toBe(true);
            });
            expect(controller._domOriginalTextByElement.get(sentenceSpans[0])).toBe(
                "First original sentence."
            );
            expect(controller._domOriginalTextByElement.get(paragraph)).toBe(
                "First original sentence. Second original sentence."
            );

            // Pointer over rendered sentence text resolves to the innermost sentence span.
            sentenceSpans[0].dispatchEvent(
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
            expect(tooltip.querySelector(".et-original-text").textContent).toBe(
                "First original sentence."
            );
            expect(sentenceSpans[0].classList.contains("et-dom-original-source")).toBe(true);

            // Pointer over the paragraph box itself resolves to the paragraph fallback.
            paragraph.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 180,
                    clientY: 190,
                })
            );
            jest.advanceTimersByTime(260);
            expect(tooltip.querySelector(".et-original-text").textContent).toBe(
                "First original sentence. Second original sentence."
            );
            expect(paragraph.classList.contains("et-dom-original-source")).toBe(true);
            expect(sentenceSpans[0].classList.contains("et-dom-original-source")).toBe(false);

            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("does not show a tooltip over empty background in a large layout container", () => {
        jest.useFakeTimers();
        try {
            document.body.innerHTML = '<div id="menu">Sign in now<span>Follow</span></div>';
            const controller = new BannerController();
            controller.startDomPageTranslate({
                engine: "openai",
                model: "gpt-5.6-luna",
                sl: "en",
                tl: "ko",
                pipelineVersion: "vnext",
            });
            const options = createAiPageTranslationSession.mock.calls[0][0];
            const menu = document.getElementById("menu");
            const directNode = menu.firstChild;
            const nestedNode = menu.querySelector("span").firstChild;
            directNode.data = "지금 로그인";
            nestedNode.data = "팔로우";

            options.onApplied({
                element: menu,
                kind: "block",
                sourceText: "Sign in nowFollow",
                translatedText: "지금 로그인팔로우",
                target: {
                    kind: "block",
                    textNodes: [
                        { nodeRef: { deref: () => directNode }, source: "Sign in now" },
                        { nodeRef: { deref: () => nestedNode }, source: "Follow" },
                    ],
                },
            });

            const exactTargets = menu.querySelectorAll(
                "[data-edge-translate-exact-original]"
            );
            expect(exactTargets).toHaveLength(2);
            expect(controller._domOriginalTextByElement.get(menu)).toBeUndefined();

            // The event target is the viewport-sized layout container, not either text span.
            menu.dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 700,
                    clientY: 500,
                })
            );
            jest.advanceTimersByTime(260);
            expect(document.getElementById("edge-translate-dom-original-tooltip")).toBeNull();

            // The same translated content still exposes its original directly over the text.
            exactTargets[0].dispatchEvent(
                new MouseEvent("mouseover", {
                    bubbles: true,
                    clientX: 120,
                    clientY: 160,
                })
            );
            jest.advanceTimersByTime(260);
            const tooltip = document.getElementById("edge-translate-dom-original-tooltip");
            expect(tooltip?.dataset.visible).toBe("true");
            expect(tooltip?.querySelector(".et-original-text")?.textContent).toBe("Sign in now");

            controller.cancelDomPageTranslate();
        } finally {
            jest.useRealTimers();
        }
    });

    it("stops the vNext session on banner close and on supersede", () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "openai",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        const first = createAiPageTranslationSession.mock.results[0].value;

        // A new translate supersedes the in-flight session.
        controller.startDomPageTranslate({
            engine: "openai",
            sl: "en",
            tl: "ja",
            pipelineVersion: "vnext",
        });
        expect(first.stop).toHaveBeenCalledWith("superseded");

        // Banner close cancels the active session.
        const second = createAiPageTranslationSession.mock.results[1].value;
        controller.cancelDomPageTranslate();
        expect(second.stop).toHaveBeenCalledWith("user-cancelled");
        expect(controller._activePagePipeline).toBeNull();
    });

    it("maps vNext status snapshots onto the banner counters and token split", async () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "googleAiStudio",
            model: "gemini-2.5-flash-lite",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        await Promise.resolve();
        const options = createAiPageTranslationSession.mock.calls[0][0];

        options.onStatus({
            phase: "translating",
            totalStrings: 10,
            translatedStrings: 4,
            failedStrings: 0,
            requestCount: 3,
            tokens: { settled: 1000, estimated: 500 },
        });

        expect(controller._domTotalTranslationEntries).toBe(10);
        expect(controller._domCompletedTranslationEntries).toBe(4);
        expect(controller._domFailedTranslationEntries).toBe(0);
        expect(controller._domApiBatchCount).toBe(3);
        expect(controller._domTokenUsage).toMatchObject({ totalTokens: 1500, estimated: true });

        const root = document.getElementById("edge-translate-dom-page-banner").shadowRoot;
        expect(root.querySelector("[data-role='status']").textContent).toBe(
            "4 of 10 strings translated"
        );
        // Token/request telemetry is tracked internally (for accounting) but no longer shown in
        // the decluttered header — there is no token-meta node to render it into.
        expect(root.querySelector("[data-role='token-meta']")).toBeNull();

        // Fully settled usage still drops the estimated marker on the tracked state.
        options.onStatus({
            phase: "translating",
            totalStrings: 10,
            translatedStrings: 6,
            failedStrings: 0,
            requestCount: 5,
            tokens: { settled: 2000, estimated: 0 },
        });
        expect(controller._domTokenUsage).toMatchObject({ totalTokens: 2000, estimated: false });
        controller.cancelDomPageTranslate();
    });

    it("keeps the progress bar monotonic and resets it for a new session", async () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "openai",
            model: "gpt-5.6-luna",
            sl: "ja",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        await Promise.resolve();
        const options = createAiPageTranslationSession.mock.calls[0][0];
        const root = document.getElementById("edge-translate-dom-page-banner").shadowRoot;
        const fill = () => root.querySelector("[data-role='progress-fill']").style.width;

        // Exact-source dedupe fan-out lands a big chunk at once → 60%.
        options.onStatus({ phase: "translating", totalStrings: 100, translatedStrings: 60 });
        expect(fill()).toBe("60%");

        // Late SPA content grows the total so the raw ratio would drop to 62/200=31% — the bar
        // must NOT retreat.
        options.onStatus({ phase: "translating", totalStrings: 200, translatedStrings: 62 });
        expect(fill()).toBe("60%");

        // Forward progress still advances.
        options.onStatus({ phase: "translating", totalStrings: 200, translatedStrings: 150 });
        expect(fill()).toBe("75%");

        // A brand-new session starts empty again (high-water mark reset).
        controller.startDomPageTranslate({
            engine: "openai",
            model: "gpt-5.6-luna",
            sl: "ja",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        await Promise.resolve();
        const options2 = createAiPageTranslationSession.mock.calls[1][0];
        options2.onStatus({ phase: "translating", totalStrings: 100, translatedStrings: 5 });
        expect(fill()).toBe("5%");
        controller.cancelDomPageTranslate();
    });

    it("renders a settled incomplete phase as 'Translation incomplete' with the string count", async () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "openai",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        await Promise.resolve();
        const options = createAiPageTranslationSession.mock.calls[0][0];
        const session = createAiPageTranslationSession.mock.results[0].value;
        const finished = {
            phase: "incomplete",
            totalStrings: 5,
            translatedStrings: 3,
            failedStrings: 2,
            requestCount: 4,
            tokens: { settled: 900, estimated: 0 },
        };
        session.getStatusSnapshot.mockReturnValue(finished);

        options.onStatus(finished);

        expect(controller._activePagePipeline.getSnapshot()).toMatchObject({
            phase: "complete",
            totalTargets: 5,
            failedTargets: 2,
            progressUnit: "strings",
            failureUnit: "strings",
        });
        expect(controller._activePagePipeline.getStatusSnapshot()).toBe(finished);
        const root = document.getElementById("edge-translate-dom-page-banner").shadowRoot;
        expect(root.querySelector("[data-role='status']").textContent).toBe(
            "Translation incomplete (2 strings failed)"
        );
        expect(root.querySelector("[data-role='bar']").dataset.state).toBe("error");
        controller.cancelDomPageTranslate();
    });

    it("fails loud on terminal error phases with the failure kind in the banner", async () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "openai",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        await Promise.resolve();
        const options = createAiPageTranslationSession.mock.calls[0][0];
        const session = createAiPageTranslationSession.mock.results[0].value;
        const errored = {
            phase: "error",
            totalStrings: 5,
            translatedStrings: 1,
            failedStrings: 4,
            requestCount: 1,
            tokens: { settled: 0, estimated: 0 },
            failure: { kind: "auth", message: "Invalid API key" },
        };
        session.getStatusSnapshot.mockReturnValue(errored);

        options.onStatus(errored);

        const root = document.getElementById("edge-translate-dom-page-banner").shadowRoot;
        expect(root.querySelector("[data-role='status']").textContent).toBe(
            "Translation failed: auth: Invalid API key"
        );
        expect(root.querySelector("[data-role='bar']").dataset.state).toBe("error");
        controller.cancelDomPageTranslate();
    });

    it("ignores late snapshots from a superseded vNext session", async () => {
        const controller = new BannerController();
        controller.startDomPageTranslate({
            engine: "openai",
            sl: "en",
            tl: "ko",
            pipelineVersion: "vnext",
        });
        const firstOptions = createAiPageTranslationSession.mock.calls[0][0];
        controller.startDomPageTranslate({
            engine: "openai",
            sl: "en",
            tl: "ja",
            pipelineVersion: "vnext",
        });
        await Promise.resolve();

        firstOptions.onStatus({
            phase: "translating",
            totalStrings: 99,
            translatedStrings: 1,
            failedStrings: 0,
            requestCount: 1,
            tokens: { settled: 0, estimated: 0 },
        });

        expect(controller._domTotalTranslationEntries).not.toBe(99);
        controller.cancelDomPageTranslate();
    });
});
