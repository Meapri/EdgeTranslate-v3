import Channel from "common/scripts/channel.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import {
    toChromeTranslatorLanguage,
    translateWithChromeOnDevice,
} from "common/scripts/chrome_builtin_translate.js";
import {
    applyPageSegments,
    buildContextTranslationGroups,
    buildSafeTranslatedHtml,
    buildSegmentedTranslationText,
    captureLeafSegmentTexts,
    collectHtmlPageSections,
    findLeafBlocksInElement,
    isAlreadyInTargetLanguage,
    parsePageSegmentMap,
    serializeBlockSegment,
    splitSegmentedTranslationText,
    splitTranslatedContext,
    wrapLeafLineSegmentsInSpans,
} from "./dom_page_translate_context.js";

/**
 * Low-priority scheduling via the Prioritized Task Scheduling API. Yields to
 * user-visible work so cache house-keeping and similar background fetches don't
 * block paints. Falls back to a 0ms setTimeout for browsers without scheduler.
 *
 * Returns nothing — schedulePostTask is fire-and-forget by design. Callers that
 * need to await the work should use the relevant API result directly.
 */
function schedulePostTask(fn, priority = "background") {
    const g = typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null;
    if (g && typeof g.scheduler?.postTask === "function") {
        try {
            g.scheduler.postTask(fn, { priority });
            return;
        } catch {
            /* fall through */
        }
    }
    setTimeout(fn, 0);
}

/**
 * Run a DOM mutation inside a View Transition when available so the browser
 * crossfades old → new at zero main-thread cost. The mutation ALWAYS runs
 * synchronously (we await the update-callback completion via a sync sentinel)
 * so callers can rely on side effects being visible immediately after the
 * call returns. Falls back to a direct call on browsers without the API.
 *
 * IMPORTANT: this used to wrap mutations in document.startViewTransition and
 * pass the callback to the browser. That implementation had a subtle
 * correctness bug — the callback fires AFTER a microtask, so any state the
 * caller read synchronously (e.g. an `applied` flag set inside the callback)
 * was always stale. We now run the mutation eagerly and only use the API as
 * an opportunistic visual enhancement when the page is idle.
 */
function runWithOptionalViewTransition(mutationFn) {
    // For now: always run the mutation synchronously. The browser handles
    // smooth-rendering via the standard rAF + compositor pipeline; layering
    // View Transitions on top of our streaming/popcorn flow added complexity
    // without measurable UX benefit because individual section applies are
    // typically too short for the crossfade to be visible.
    mutationFn();
}

/**
 * Compute a short, stable hash of the current page's identity. Used as the
 * urlHash key for the persistent translation cache so we don't re-translate
 * the same URL on revisit.
 */
function computePersistentCacheUrlHash(targetLanguage) {
    if (typeof location === "undefined") return "";
    // Strip the hash + transient query params so anchor changes don't blow the cache.
    const base = `${location.origin}${location.pathname}`;
    return fnv1a32(`${base}|${targetLanguage || ""}`);
}

/**
 * Inject DNS-prefetch + preconnect hints for the AI engine's host so the
 * TCP/TLS handshake completes in parallel with our first section's build.
 * No-op on duplicate calls — the link tags carry our marker attribute.
 */
function injectDnsPrefetchForEngine(engine) {
    if (typeof document === "undefined" || !document.head) return;
    const host = {
        googleAiStudio: "https://generativelanguage.googleapis.com",
        openai: "https://api.openai.com",
    }[engine];
    if (!host) return;
    const marker = `et-prefetch-${engine}`;
    if (document.head.querySelector(`link[data-edge-translate="${marker}"]`)) return;
    for (const rel of ["dns-prefetch", "preconnect"]) {
        const link = document.createElement("link");
        link.rel = rel;
        link.href = host;
        link.crossOrigin = "anonymous";
        link.setAttribute("data-edge-translate", marker);
        document.head.appendChild(link);
    }
}

// content-visibility only pays off for block-level containers whose layout
// cost is significant. Applying it to inline children (e.g. spans within a
// translated paragraph) can cause incorrect intrinsic-size estimates and
// visible layout shift when the element scrolls into view. We restrict to
// known block-level tags.
const CONTENT_VISIBILITY_BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "ARTICLE",
    "SECTION",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "CAPTION",
    "TD",
    "TH",
    "ASIDE",
    "MAIN",
    "NAV",
    "HEADER",
    "FOOTER",
    "ADDRESS",
    "DD",
    "DT",
    "FIGURE",
]);

/**
 * Apply `content-visibility: auto` inline to translated block-level elements
 * so off-screen regions skip layout + paint until scrolled into view. We set
 * it inline (vs via a stylesheet) to avoid creating extra &lt;style&gt;
 * elements that could interfere with PDF text-layer styling.
 *
 * Skips:
 *   - inline elements (where contain-intrinsic-size: 200px would shift layout)
 *   - elements inside the PDF text layer (need absolute positioning)
 */
function markElementTranslatedForRendering(element) {
    if (!element || !element.style) return;
    if (!CONTENT_VISIBILITY_BLOCK_TAGS.has(element.tagName)) return;
    if (element.closest && element.closest(".textLayer")) return;
    try {
        element.style.contentVisibility = "auto";
        element.style.containIntrinsicSize = "auto 200px";
    } catch {
        /* style assignment can throw on cross-origin frames — best-effort */
    }
}

function fnv1a32(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

function estimateLlmPayloadTokens(text) {
    const value = String(text || "");
    if (!value) return 0;
    const cjkChars = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
    const otherChars = Math.max(0, value.length - cjkChars);
    return Math.ceil(cjkChars * 0.8 + otherChars / 3.6);
}

function estimateLlmOutputTokens(plainText, sourceHtml = "") {
    const visibleTokens = estimateLlmPayloadTokens(plainText || sourceHtml);
    const structuralTokens = Math.max(0, estimateLlmPayloadTokens(sourceHtml) - visibleTokens);
    return Math.ceil(visibleTokens * 1.25 + structuralTokens * 0.8);
}

/**
 * Control the visibility of page translator banners.
 */
class BannerController {
    constructor() {
        // Communication channel.
        this.channel = new Channel();

        // Active page translation mode: google or AI DOM translation.
        this.currentTranslator = null;

        // Message listener canceller.
        this.canceller = null;

        // Avoid redundant layout work
        this.lastDistance = null;
        this._moveRaf = null;
        this._domPageBannerHeight = 84;

        // DOM fallback observer state
        this._mo = null;
        this._translatedSet = new WeakSet();
        this._translatedBlocks = new WeakSet();
        this._domPendingTextNodes = new WeakSet();
        this._domFailedTextNodes = new WeakSet();
        this._scheduleBatch = null;
        this._pendingNodes = new Set();
        this._domPageTranslateOptions = { engine: "googleAiStudio", sl: "auto", tl: "en" };
        this._domResolvedSourceLanguage = null;
        this._domTranslationCache = new Map();
        this._domTranslationCacheMax = 2000;
        // Session-wide per-STRING translation cache: every unique block text is translated
        // at most once across all sections, batches and scrolls (content-hash keyed, so it
        // stays valid the whole page lifetime). Cache hits apply instantly — 0 tokens, 0
        // latency — which is the only way to cut tokens further without translating less.
        this._domSegmentTextCache = new Map();
        this._domSegmentTextCacheMax = 6000;
        this._domActiveTranslations = 0;
        this._domMaxConcurrentTranslations = 2;
        this._domPageBanner = null;
        this._domPageBannerVisible = true;
        this._domTotalTranslationEntries = 0;
        this._domCompletedTranslationEntries = 0;
        this._domBatchFailureCount = 0;
        this._aiPageSectionBatchScale = 1;
        this._aiPageSectionBatchSuccessStreak = 0;
        this._aiPageSectionBatchFailureStreak = 0;
        this._aiPageSectionBatchLatencyEmaMs = 0;
        this._aiPageConcurrencySuccessStreak = 0;
        this._aiPageConcurrencyLatencyEmaMs = 0;
        this._aiPageConcurrencyQueueWaitEmaMs = 0;
        this._aiPageDynamicMaxConcurrentTranslations = null;
        this._domTranslationSessionId = 0;
        this._domTokenUsage = {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
        };
        this._domPageRootElements = [];
        this._domCoverageScanTimer = null;
        this._domCoverageScanCount = 0;
        this._domCoverageStableScanCount = 0;
        this._domIncrementalScanTimer = null;
        this._domOwnMutationSuppressUntil = 0;
        this._domScrollScanHandler = null;
        this._onDeviceBridgePromise = null;
        this._onDeviceBridgeRequestId = 0;
        this._onDeviceBridgePending = new Map();
        this._domOriginalTextByElement = new WeakMap();
        this._domDuplicateEntries = new Map();
        this._domPendingApplies = new Map();
        this._domNextApplySequence = 0;
        this._domNextApplyToFlush = 0;
        this._domOriginalTooltip = null;
        this._domOriginalTooltipTarget = null;
        this._domOriginalTooltipHandlers = null;
        this._domOriginalTooltipStyleInjected = false;
        this._domOriginalTooltipMoveRaf = null;
        this._domOriginalTooltipPointer = null;
        this._domOriginalTooltipShowTimer = null;
        this._domOriginalTooltipPendingTarget = null;
        this._domOriginalTooltipPendingEvent = null;
        this._domOriginalTooltipHoverDelayMs = 260;
        // Grace period when leaving the segment so the cursor can reach the (now
        // anchored, scrollable) tooltip without it vanishing.
        this._domOriginalTooltipHideTimer = null;
        this._domOriginalTooltipHideDelayMs = 180;
        this._captionModeEnabled = false;
        this._captionObserver = null;
        this._captionOverlay = null;
        this._captionOverlayPosition = null;
        this._captionOverlayDragState = null;
        this._captionOverlayDraggable = true;
        this._captionLastSource = "";
        this._captionRenderedSource = "";
        this._captionPendingSource = "";
        this._captionPendingSources = [];
        this._captionPendingMax = 6;
        this._captionInFlight = false;
        this._captionInFlightSource = "";
        this._captionLastRequestId = 0;
        this._captionTranslationCache = new Map();
        this._captionTranslationCacheMax = 200;
        this._captionDebounceTimer = null;
        this._captionDebounceMs = 48;
        this._captionStabilizeTimer = null;
        this._captionStabilizePromise = null;
        this._captionStabilizeResolve = null;
        this._captionStabilizeTargetSource = "";
        this._captionStabilizeTargetVisibleSource = "";
        // Speed-first: shorter settle wait shows the translated caption sooner. The
        // trailing-punctuation cache fold + non-speech skip offset the extra re-translate
        // cost of occasionally catching a phrase a beat before it finishes growing.
        this._captionStabilizeDelayMs = 400;
        this._captionStabilizeWindowMs = 2600;
        this._captionStabilizeMaxSources = 3;
        this._captionVisibleHistoryMax = 8;
        this._captionVisibleSources = [];
        this._captionVisibleSourceSeq = 0;
        this._captionLastDisplayedVisibleSeq = 0;
        this._captionMergedReplacementSources = new Set();
        this._captionPollTimer = null;
        this._captionOptionsCache = null;
        this._captionOptionsCacheAt = 0;
        this._captionOptionsCacheTtlMs = 5000;
        this._captionHideTimer = null;
        this._captionHoldAfterMissingMs = 1400;
        this._captionLastVisibleAt = 0;
        this._captionDisplayItems = [];
        // Show only the current caption block — clean, standard-subtitle behavior.
        // (History is still kept internally for merge/dedup, just not stacked on screen.)
        this._captionDisplayMax = 1;
        this._captionSeekHandler = null;
        this._captionPrefetchTimer = null;
        this._captionPrefetchVideoId = "";
        this._captionPrefetchTrackKey = "";
        this._captionPrefetchEmptyTrackKeys = new Map();
        this._captionPrefetchAllEmptyKey = "";
        this._captionPrefetchAllEmptyAt = 0;
        this._captionPrefetchCues = [];
        this._captionPrefetchLoadPromise = null;
        this._captionPrefetchInFlight = new Set();
        this._captionPrefetchMaxInFlight = 48;
        this._captionPrefetchWindowMs = 180000;
        this._captionPrefetchBatchSize = 24;
        this._captionPrefetchBatchMaxChars = 2400;
        this._captionFastPrefetchBatchSize = 8;
        this._captionBatchQueue = new Map();
        this._captionBatchInFlight = new Map();
        this._captionBatchTimer = null;
        // Snappier flush so the first AI-batched caption appears sooner; a slightly
        // larger max amortizes the shared prompt across more cues when bursts do arrive.
        this._captionBatchDelayMs = 80;
        this._captionBatchMaxSize = 8;
        this._captionDebugEventId = 0;
        this._domPageDebugEventId = 0;
        this.handleRealtimeCaptionOverlayPointerMove =
            this.handleRealtimeCaptionOverlayPointerMove.bind(this);
        this.handleRealtimeCaptionOverlayPointerUp =
            this.handleRealtimeCaptionOverlayPointerUp.bind(this);

        this.addListeners();
    }

    /**
     * Add event and message listeners.
     */
    addListeners() {
        this.channel.on(
            "start_page_translate",
            ((detail) => {
                switch (detail.translator) {
                    case "google": {
                        // Google page translator runs in website context, so we use window.postMessage
                        // for message passing.
                        this.currentTranslator = "google";
                        // Ensure we don't attach multiple handlers
                        if (this.canceller) this.canceller();
                        let handler = this.googleMessageHandler.bind(this);
                        window.addEventListener("message", handler, { once: false });
                        this.canceller = (() => {
                            window.removeEventListener("message", handler);
                        }).bind(this);
                        break;
                    }
                    default:
                        break;
                }
            }).bind(this)
        );

        this.channel.on("command", (detail) => {
            switch (detail.command) {
                case "toggle_page_translate_banner":
                    this.toggleBanner();
                    break;
                case "cancel_page_translate":
                    this.cancelDomPageTranslate();
                    break;
                default:
                    break;
            }
        });

        // Provide Chrome on-device translation APIs from the page main world when possible.
        this.channel.provide("chrome_builtin_translate", async (params) => {
            const text = params && params.text ? params.text : "";
            const from = (params && params.sl) || (params && params.from) || "auto";
            const to = (params && params.tl) || (params && params.to) || "en";
            const streamId = params && params.streamId;
            const draftTranslation = params && params.draftTranslation;
            const fastPostEdit = Boolean(params && params.fastPostEdit);
            return this.translateWithOnDeviceEngine(
                text,
                from,
                to,
                streamId,
                draftTranslation,
                fastPostEdit
            );
        });

        // Kick off DOM fallback/on-device page translation on explicit request
        this.channel.on("start_dom_page_translate", (detail = {}) => {
            this.startDomPageTranslate(detail);
        });

        // Background may request canceling DOM fallback scheduling when banner is visible
        this.channel.on("page_translate_control", (detail) => {
            if (detail && detail.action === "cancel_dom_fallback") {
                // nothing needed here yet (fallback scheduling is background-side), keep hook for future use
            }
        });

        this.channel.on("toggle_realtime_caption_translate", () => {
            this.toggleRealtimeCaptionTranslation();
        });

        this.channel.on("set_realtime_caption_translate", (detail = {}) => {
            this.setRealtimeCaptionTranslation(Boolean(detail.enabled), { persist: false });
        });

        this.initRealtimeCaptionTranslationFromSettings();

        window.addEventListener("edge_translate_pdf_page_translate", () => {
            this.startConfiguredPdfPageTranslate();
        });

        window.addEventListener("message", this.handleOnDeviceBridgeResponse.bind(this));
    }

    startDomPageTranslate(detail = {}) {
        this._domPageTranslateOptions = {
            engine: this.normalizeDomPageTranslateEngine(detail.engine),
            sl: detail.sl || "auto",
            tl: detail.tl || "en",
            model: detail.model || "",
            translatorId: detail.translatorId || "LocalTranslate",
        };
        this.currentTranslator = "dom";
        this.resetDomPageRuntimeState();
        this._domTranslationQueue = [];
        this._domActiveTranslations = 0;
        this._domCompletedTranslationEntries = 0;
        this._domTotalTranslationEntries = 0;
        this._domBatchFailureCount = 0;
        this.resetAiPageSectionBatchTuning();
        this._domCoverageScanCount = 0;
        this._domCoverageStableScanCount = 0;
        this._domOwnMutationSuppressUntil = 0;
        this._domTokenUsage = {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
        };
        this._domMaxConcurrentTranslations = this.getDomPageMaxConcurrentTranslations();
        this._domResolvedSourceLanguage = this.resolveDomPageSourceLanguage(
            this._domPageTranslateOptions.sl
        );
        this._domPageRootElements = this.getDomPageTranslationRoots();
        this.logDomPageDebug("start", {
            source: this._domResolvedSourceLanguage,
            target: this._domPageTranslateOptions.tl,
            mode: "batch",
            maxConcurrent: this._domMaxConcurrentTranslations,
        });
        this.showDomPageBanner();
        this.startDomFallback();
        this.startFullPageBatchTranslation();
    }

    startConfiguredPdfPageTranslate() {
        getOrSetDefaultSettings(
            ["languageSetting", "LocalTranslatorConfig"],
            DEFAULT_SETTINGS
        ).then((result) => {
            const localConfig = result.LocalTranslatorConfig || {};
            const engine =
                localConfig.mode === "openai" || localConfig.mode === "openaiCompatible"
                    ? localConfig.mode
                    : "googleAiStudio";
            const model =
                engine === "openai"
                    ? localConfig.openaiModel || ""
                    : engine === "openaiCompatible"
                    ? localConfig.openaiCompatibleModel || ""
                    : localConfig.model || "";
            this.startDomPageTranslate({
                engine,
                model,
                translatorId: "LocalTranslate",
                sl: (result.languageSetting && result.languageSetting.sl) || "auto",
                tl: (result.languageSetting && result.languageSetting.tl) || "en",
            });
        });
    }

    normalizeDomPageTranslateEngine(engine) {
        if (engine === "openai") return "openai";
        if (engine === "openaiCompatible") return "openaiCompatible";
        return "googleAiStudio";
    }

    getDomPageTranslationRoots() {
        const pdfViewerRoot = document.getElementById("viewer");
        if (pdfViewerRoot && document.getElementById("outerContainer")) {
            return [pdfViewerRoot];
        }
        // Focus on the page's primary content region so we translate the article/README
        // rather than the site's global nav, header, sidebar and footer chrome. On a
        // content-heavy page (e.g. a GitHub repo) the chrome can dwarf the actual content
        // and quietly cost most of the tokens. Falls back to <body> when there is no clear
        // single main region.
        const main = this.getDomPagePrimaryContentRoot();
        if (main) return [main];
        return [document.body].filter(Boolean);
    }

    getDomPagePrimaryContentRoot() {
        const body = document.body;
        if (!body) return null;
        const bodyLen = String(body.textContent || "")
            .replace(/\s+/g, " ")
            .trim().length;
        if (bodyLen < 400) return null; // tiny page — nothing to narrow
        const textLen = (el) =>
            String((el && el.textContent) || "")
                .replace(/\s+/g, " ")
                .trim().length;
        const mains = Array.from(document.querySelectorAll("main, [role='main']")).filter(
            (el) => el.isConnected && textLen(el) >= 200
        );
        // Only narrow when there is exactly one main region and it holds the bulk of the
        // page text — otherwise we risk dropping real content on app-shell / multi-pane UIs.
        if (mains.length === 1 && textLen(mains[0]) / bodyLen >= 0.35) return mains[0];
        return null;
    }

    isYouTubePage() {
        try {
            return /(^|\.)youtube\.com$/i.test(location.hostname);
        } catch {
            return false;
        }
    }

    initRealtimeCaptionTranslationFromSettings() {
        if (!this.isYouTubePage()) return;
        getOrSetDefaultSettings("OtherSettings", DEFAULT_SETTINGS).then((result) => {
            if (result.OtherSettings?.RealtimeCaptionTranslate) {
                this.startRealtimeCaptionTranslation({ persist: false });
            }
        });
    }

    toggleRealtimeCaptionTranslation() {
        this.setRealtimeCaptionTranslation(!this._captionModeEnabled);
    }

    setRealtimeCaptionTranslation(enabled, { persist = true } = {}) {
        if (enabled) {
            this.startRealtimeCaptionTranslation();
        } else {
            this.stopRealtimeCaptionTranslation();
        }
        if (persist) this.saveRealtimeCaptionTranslationSetting(enabled);
    }

    saveRealtimeCaptionTranslationSetting(enabled) {
        getOrSetDefaultSettings("OtherSettings", DEFAULT_SETTINGS).then((result) => {
            result.OtherSettings = result.OtherSettings || {};
            result.OtherSettings.RealtimeCaptionTranslate = enabled;
            chrome.storage.sync.set(result);
        });
    }

    startRealtimeCaptionTranslation() {
        if (!this.isYouTubePage()) return;
        if (this._captionModeEnabled) return;
        this._captionModeEnabled = true;
        this.logRealtimeCaptionDebug("mode:start");
        this.ensureRealtimeCaptionOverlay();
        const schedule = () => this.scheduleRealtimeCaptionTranslation();
        this._captionObserver = new MutationObserver(schedule);
        this._captionObserver.observe(document.documentElement || document.body, {
            subtree: true,
            childList: true,
            characterData: true,
        });
        this._captionPollTimer = setInterval(schedule, 350);
        // Reset the on-screen caption when the user jumps the timeline so stale lines
        // don't linger or merge with the post-seek caption. Media 'seeking' doesn't
        // bubble, but a capture-phase document listener still catches any <video>'s seek.
        this._captionSeekHandler = () => this.resetRealtimeCaptionDisplayForSeek();
        document.addEventListener("seeking", this._captionSeekHandler, true);
        schedule();
        this.scheduleYouTubeCaptionPrefetch(0);
    }

    stopRealtimeCaptionTranslation() {
        this._captionModeEnabled = false;
        this.logRealtimeCaptionDebug("mode:stop");
        if (this._captionObserver) {
            this._captionObserver.disconnect();
            this._captionObserver = null;
        }
        if (this._captionSeekHandler) {
            document.removeEventListener("seeking", this._captionSeekHandler, true);
            this._captionSeekHandler = null;
        }
        if (this._captionDebounceTimer) {
            clearTimeout(this._captionDebounceTimer);
            this._captionDebounceTimer = null;
        }
        this.clearRealtimeCaptionStabilizeTimer();
        if (this._captionPollTimer) {
            clearInterval(this._captionPollTimer);
            this._captionPollTimer = null;
        }
        if (this._captionPrefetchTimer) {
            clearTimeout(this._captionPrefetchTimer);
            this._captionPrefetchTimer = null;
        }
        if (this._captionBatchTimer) {
            clearTimeout(this._captionBatchTimer);
            this._captionBatchTimer = null;
        }
        this.clearRealtimeCaptionHideTimer();
        this._captionLastSource = "";
        this._captionRenderedSource = "";
        this._captionPendingSource = "";
        this._captionPendingSources = [];
        this._captionVisibleSources = [];
        this._captionVisibleSourceSeq = 0;
        this._captionLastDisplayedVisibleSeq = 0;
        this._captionMergedReplacementSources.clear();
        this._captionDisplayItems = [];
        this._captionPrefetchVideoId = "";
        this._captionPrefetchTrackKey = "";
        this._captionPrefetchEmptyTrackKeys.clear();
        this._captionPrefetchAllEmptyKey = "";
        this._captionPrefetchAllEmptyAt = 0;
        this._captionPrefetchCues = [];
        this._captionPrefetchLoadPromise = null;
        this._captionPrefetchInFlight.clear();
        this._captionBatchQueue.clear();
        this._captionBatchInFlight.clear();
        this._captionInFlight = false;
        this._captionInFlightSource = "";
        this._captionLastRequestId += 1;
        if (this._captionOverlay) {
            this._captionOverlay.style.opacity = "0";
            this._captionOverlay.hidden = true;
        }
    }

    /**
     * Clear the on-screen caption + sequencing state after a timeline seek so the
     * post-seek caption starts from a clean slate (no stale lines, no cross-merge,
     * no out-of-order suppression). The fetched transcript cache is kept — it's still
     * valid for the same video, so post-seek cues can still be served from it.
     */
    resetRealtimeCaptionDisplayForSeek() {
        if (!this._captionModeEnabled) return;
        this.clearRealtimeCaptionStabilizeTimer();
        this.clearRealtimeCaptionHideTimer();
        if (this._captionDebounceTimer) {
            clearTimeout(this._captionDebounceTimer);
            this._captionDebounceTimer = null;
        }
        this._captionBatchQueue.clear();
        this._captionLastSource = "";
        this._captionRenderedSource = "";
        this._captionPendingSource = "";
        this._captionPendingSources = [];
        this._captionVisibleSources = [];
        this._captionVisibleSourceSeq = 0;
        this._captionLastDisplayedVisibleSeq = 0;
        this._captionMergedReplacementSources.clear();
        this._captionDisplayItems = [];
        // Invalidate any in-flight translation so a pre-seek result can't paint over
        // the new position; its handler will see a stale request id and drop it.
        this._captionLastRequestId += 1;
        this.hideRealtimeCaptionOverlayNow();
        this.logRealtimeCaptionDebug("seek:reset");
    }

    isRealtimeCaptionDebugEnabled() {
        try {
            return (
                localStorage.getItem("edgeTranslate.captionDebug") === "1" ||
                window.__edgeTranslateCaptionDebug === true
            );
        } catch {
            return false;
        }
    }

    logRealtimeCaptionDebug(event, detail = {}) {
        if (!this.isRealtimeCaptionDebugEnabled()) return;
        const payload = {
            id: ++this._captionDebugEventId,
            event,
            at: Date.now(),
            videoTimeMs: Math.round(this.getCurrentVideoTimeMs()),
            ...detail,
        };
        try {
            window.__edgeTranslateCaptionDebugEvents =
                window.__edgeTranslateCaptionDebugEvents || [];
            window.__edgeTranslateCaptionDebugEvents.push(payload);
            if (window.__edgeTranslateCaptionDebugEvents.length > 500) {
                window.__edgeTranslateCaptionDebugEvents.splice(
                    0,
                    window.__edgeTranslateCaptionDebugEvents.length - 500
                );
            }
            this.mirrorRealtimeCaptionDebugEvents(window.__edgeTranslateCaptionDebugEvents);
        } catch {
            // Debug storage is best-effort.
        }
        try {
            console.log("[ET][Caption]", event, payload);
        } catch {
            // Console may be unavailable in test-like contexts.
        }
    }

    mirrorRealtimeCaptionDebugEvents(events) {
        try {
            const documentElement = document?.documentElement;
            if (!documentElement) return;
            let node = document.getElementById("edge-translate-caption-debug-log");
            if (!node) {
                node = document.createElement("script");
                node.id = "edge-translate-caption-debug-log";
                node.type = "application/json";
                node.dataset.edgeTranslateDebug = "caption";
                documentElement.appendChild(node);
            }
            node.textContent = JSON.stringify(events.slice(-120));
        } catch {
            // DOM mirroring is diagnostic-only.
        }
    }

    isDomPageDebugEnabled() {
        try {
            return (
                localStorage.getItem("edgeTranslate.domPageDebug") === "1" ||
                window.__edgeTranslateDomPageDebug === true
            );
        } catch {
            return false;
        }
    }

    logDomPageDebug(event, detail = {}) {
        const debugEnabled = this.isDomPageDebugEnabled();
        // The in-memory ring buffer is cheap; the DOM mirror + console log are not.
        // Skip both entirely when debug is off to avoid burning cycles on the hot path.
        try {
            const buffer = (window.__edgeTranslateDomPageDebugEvents =
                window.__edgeTranslateDomPageDebugEvents || []);
            const payload = {
                id: ++this._domPageDebugEventId,
                event,
                at: Date.now(),
                engine: this._domPageTranslateOptions?.engine || "",
                active: this._domActiveTranslations,
                queued: this._domTranslationQueue?.length || 0,
                completed: this._domCompletedTranslationEntries,
                total: this._domTotalTranslationEntries,
                ...detail,
            };
            buffer.push(payload);
            if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
            if (debugEnabled) {
                this.mirrorDomPageDebugEvents(buffer);
                try {
                    console.log("[ET][DomPage]", event, payload);
                } catch {
                    // Console may be unavailable in test-like contexts.
                }
            }
        } catch {
            // Debug storage is best-effort.
        }
    }

    mirrorDomPageDebugEvents(events) {
        try {
            const documentElement = document?.documentElement;
            if (!documentElement) return;
            let node = document.getElementById("edge-translate-dom-page-debug-log");
            if (!node) {
                node = document.createElement("script");
                node.id = "edge-translate-dom-page-debug-log";
                node.type = "application/json";
                node.dataset.edgeTranslateDebug = "dom-page";
                documentElement.appendChild(node);
            }
            node.textContent = JSON.stringify(events.slice(-160));
        } catch {
            // DOM mirroring is diagnostic-only.
        }
    }

    ensureRealtimeCaptionOverlay() {
        if (this._captionOverlay && this._captionOverlay.isConnected) return this._captionOverlay;
        this.ensureRealtimeCaptionAnimationStyle();
        const overlay = document.createElement("div");
        overlay.id = "edge-translate-realtime-caption";
        Object.assign(overlay.style, {
            position: "fixed",
            left: "50%",
            bottom: "clamp(92px, 18vh, 180px)",
            transform: "translateX(-50%)",
            maxWidth: "min(88vw, 1120px)",
            maxHeight: "28vh",
            padding: "10px 18px",
            borderRadius: "18px",
            border: "1px solid rgba(255, 255, 255, .14)",
            background: "rgba(18, 18, 20, .68)",
            color: "#f8fbff",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "5px",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
            fontSize: "21px",
            fontWeight: "600",
            lineHeight: "1.32",
            letterSpacing: "0",
            textAlign: "center",
            textShadow: "0 1px 2px rgba(0, 0, 0, .55)",
            boxShadow: "0 10px 28px rgba(0, 0, 0, .26), inset 0 1px 0 rgba(255, 255, 255, .10)",
            backdropFilter: "blur(18px) saturate(1.15)",
            WebkitBackdropFilter: "blur(18px) saturate(1.15)",
            overflow: "hidden",
            overflowWrap: "break-word",
            whiteSpace: "pre-wrap",
            pointerEvents: "auto",
            userSelect: "none",
            touchAction: "none",
            cursor: this._captionOverlayDraggable ? "grab" : "default",
            zIndex: "2147483647",
            opacity: "0",
            transition: "opacity 120ms cubic-bezier(.2, 0, 0, 1)",
        });
        overlay.addEventListener("pointerdown", (event) =>
            this.handleRealtimeCaptionOverlayPointerDown(event)
        );
        overlay.hidden = true;
        document.documentElement.appendChild(overlay);
        this._captionOverlay = overlay;
        this.applyRealtimeCaptionOverlayPosition(overlay);
        return overlay;
    }

    applyRealtimeCaptionOverlayPosition(overlay = this._captionOverlay) {
        if (!overlay) return;
        overlay.style.cursor = this._captionOverlayDraggable ? "grab" : "default";
        if (!this._captionOverlayPosition) {
            Object.assign(overlay.style, {
                left: "50%",
                top: "auto",
                bottom: "clamp(92px, 18vh, 180px)",
                transform: "translateX(-50%)",
            });
            return;
        }
        const width = overlay.offsetWidth || Math.min(window.innerWidth * 0.88, 1120);
        const height = overlay.offsetHeight || 96;
        const left = Math.min(
            Math.max(8, this._captionOverlayPosition.left),
            window.innerWidth - width - 8
        );
        const top = Math.min(
            Math.max(8, this._captionOverlayPosition.top),
            window.innerHeight - height - 8
        );
        this._captionOverlayPosition = { left, top };
        Object.assign(overlay.style, {
            left: `${left}px`,
            top: `${top}px`,
            bottom: "auto",
            transform: "none",
        });
    }

    handleRealtimeCaptionOverlayPointerDown(event) {
        if (!this._captionOverlayDraggable || event.button !== 0) return;
        const overlay = this._captionOverlay;
        if (!overlay) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = overlay.getBoundingClientRect();
        this._captionOverlayDragState = {
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            width: rect.width,
            height: rect.height,
        };
        overlay.style.cursor = "grabbing";
        document.addEventListener("pointermove", this.handleRealtimeCaptionOverlayPointerMove);
        document.addEventListener("pointerup", this.handleRealtimeCaptionOverlayPointerUp, {
            once: true,
        });
    }

    handleRealtimeCaptionOverlayPointerMove(event) {
        const overlay = this._captionOverlay;
        const drag = this._captionOverlayDragState;
        if (!overlay || !drag) return;
        event.preventDefault();
        const left = Math.min(
            Math.max(8, event.clientX - drag.offsetX),
            window.innerWidth - drag.width - 8
        );
        const top = Math.min(
            Math.max(8, event.clientY - drag.offsetY),
            window.innerHeight - drag.height - 8
        );
        this._captionOverlayPosition = { left, top };
        Object.assign(overlay.style, {
            left: `${left}px`,
            top: `${top}px`,
            bottom: "auto",
            transform: "none",
        });
    }

    handleRealtimeCaptionOverlayPointerUp() {
        document.removeEventListener("pointermove", this.handleRealtimeCaptionOverlayPointerMove);
        if (this._captionOverlay) {
            this._captionOverlay.style.cursor = this._captionOverlayDraggable ? "grab" : "default";
        }
        this._captionOverlayDragState = null;
    }

    ensureRealtimeCaptionAnimationStyle() {
        if (document.getElementById("edge-translate-realtime-caption-style")) return;
        const style = document.createElement("style");
        style.id = "edge-translate-realtime-caption-style";
        style.textContent = `
            @keyframes edgeCaptionPreviousLift {
                from {
                    opacity: 1;
                    transform: translate3d(0, 12px, 0) scale(1.015);
                    filter: blur(.2px);
                }
                to {
                    opacity: .68;
                    transform: translate3d(0, 0, 0) scale(.985);
                    filter: blur(0);
                }
            }
            @keyframes edgeCaptionCurrentSlide {
                from {
                    opacity: 0;
                    transform: translate3d(0, 10px, 0) scale(.985);
                    filter: blur(.6px);
                }
                to {
                    opacity: 1;
                    transform: translate3d(0, 0, 0) scale(1);
                    filter: blur(0);
                }
            }
            @media (prefers-reduced-motion: reduce) {
                #edge-translate-realtime-caption [data-role] {
                    animation: none !important;
                    transform: none !important;
                    filter: none !important;
                }
            }
            #edge-translate-realtime-caption #edge-translate-caption-close-btn {
                position: absolute;
                top: 8px;
                right: 8px;
                width: 20px;
                height: 20px;
                border: 0;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.16);
                color: rgba(255, 255, 255, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                opacity: 0;
                pointer-events: none;
                transition: opacity 200ms var(--m3-spring-fast), background-color 200ms ease, color 200ms ease, transform 200ms var(--m3-spring-fast);
                padding: 0;
                box-sizing: border-box;
                z-index: 10000;
            }
            #edge-translate-realtime-caption:hover #edge-translate-caption-close-btn {
                opacity: 1;
                pointer-events: auto;
            }
            #edge-translate-realtime-caption #edge-translate-caption-close-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                color: #fff;
                transform: scale(1.1);
            }
            #edge-translate-realtime-caption #edge-translate-caption-close-btn:active {
                transform: scale(0.9);
            }
        `;
        document.documentElement.appendChild(style);
    }

    clearRealtimeCaptionHideTimer() {
        if (!this._captionHideTimer) return;
        clearTimeout(this._captionHideTimer);
        this._captionHideTimer = null;
    }

    showRealtimeCaptionOverlay(text, sourceText, { replaceHistory = false } = {}) {
        const overlay = this.ensureRealtimeCaptionOverlay();
        this.clearRealtimeCaptionHideTimer();
        if (replaceHistory) this._captionDisplayItems = [];
        const changed = this.pushRealtimeCaptionDisplayItem(text, sourceText);
        if (changed) this.renderRealtimeCaptionOverlay();
        overlay.hidden = false;
        overlay.style.opacity = "1";
        this._captionRenderedSource = sourceText;
        this._captionLastVisibleAt = Date.now();
    }

    pushRealtimeCaptionDisplayItem(text, sourceText) {
        const translatedText = String(text || "").trim();
        const source = String(sourceText || "");
        if (!translatedText) return false;
        const lastItem = this._captionDisplayItems.at(-1);
        if (lastItem?.source === source && lastItem?.text === translatedText) return false;
        // Never let a fragment cover the caption that's already shown: if the incoming
        // source is contained in the current one (i.e. it's an individual cue of the
        // merged sentence on screen), keep the full sentence and drop the fragment.
        // This holds even when the group resolution missed and the two translations
        // come from different engines (fragment text ≠ part of the sentence text).
        if (lastItem && this.realtimeCaptionSourceIncludes(lastItem.source, source)) return false;

        let replacedFragment = false;
        const nextItems = this._captionDisplayItems.filter((item) => {
            const duplicate = item.source === source || item.text === translatedText;
            const replacedByMergedSource =
                this.realtimeCaptionSourceIncludes(source, item.source) ||
                this.realtimeCaptionSourceIncludes(translatedText, item.text);
            if (replacedByMergedSource) replacedFragment = true;
            return !duplicate && !replacedByMergedSource;
        });
        // The newest caption always goes LAST so it renders as the current line —
        // never spliced into the middle (that could show a stale line as current).
        nextItems.push({ source, text: translatedText, expanded: replacedFragment });
        this._captionDisplayItems = nextItems;
        const historyMax = Math.max(
            this._captionDisplayMax + this._captionStabilizeMaxSources + 2,
            6
        );
        if (this._captionDisplayItems.length > historyMax) {
            this._captionDisplayItems = this._captionDisplayItems.slice(-historyMax);
        }
        return true;
    }

    realtimeCaptionSourceIncludes(sourceText, fragmentText) {
        const source = this.normalizeRealtimeCaptionCacheText(sourceText);
        const fragment = this.normalizeRealtimeCaptionCacheText(fragmentText);
        return Boolean(source && fragment && source !== fragment && source.includes(fragment));
    }

    getRealtimeCaptionDisplayMax() {
        // Always cap at the configured count — no quietly expanding to a taller stack
        // when a caption merged a fragment (that was the source of the cluttered look).
        return this._captionDisplayMax;
    }

    renderRealtimeCaptionOverlay() {
        const overlay = this.ensureRealtimeCaptionOverlay();
        overlay.replaceChildren();
        const displayMax = this.getRealtimeCaptionDisplayMax();
        const items = this._captionDisplayItems.slice(-displayMax);
        const expanded = items.some((item) => item.expanded);
        overlay.dataset.expanded = expanded ? "true" : "false";
        overlay.style.maxHeight = expanded ? "34vh" : "28vh";
        items.forEach((item, index) => {
            const isCurrent = index === items.length - 1;
            const line = document.createElement("div");
            line.dataset.role = isCurrent ? "current-caption" : "previous-caption";
            line.textContent = item.text;
            Object.assign(line.style, {
                maxWidth: "100%",
                opacity: isCurrent ? "1" : ".68",
                fontSize: isCurrent ? "1em" : ".86em",
                fontWeight: isCurrent ? "650" : "520",
                lineHeight: isCurrent ? "1.32" : "1.24",
                transformOrigin: "center bottom",
                willChange: "transform, opacity, filter",
                animation: isCurrent
                    ? "edgeCaptionCurrentSlide 190ms 35ms cubic-bezier(.2, 0, 0, 1) both"
                    : "edgeCaptionPreviousLift 180ms cubic-bezier(.2, 0, 0, 1) both",
                textWrap: isCurrent ? "wrap" : "balance",
                overflowWrap: "break-word",
            });
            overlay.appendChild(line);
        });

        // Create close button
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.id = "edge-translate-caption-close-btn";
        closeBtn.setAttribute("aria-label", "Close subtitle translation");
        closeBtn.innerHTML =
            "<svg viewBox='0 0 24 24' style='width: 12px; height: 12px; fill: currentColor; display: block;'><path d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'/></svg>";
        closeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
        closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
        closeBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.setRealtimeCaptionTranslation(false);
        });
        overlay.appendChild(closeBtn);
    }

    scheduleRealtimeCaptionOverlayHide(delay = this._captionHoldAfterMissingMs) {
        const overlay = this._captionOverlay;
        if (!overlay || overlay.hidden) return;
        this.clearRealtimeCaptionHideTimer();
        this._captionHideTimer = setTimeout(() => {
            this._captionHideTimer = null;
            if (!this._captionModeEnabled) return;
            overlay.style.opacity = "0";
            overlay.hidden = true;
            this._captionDisplayItems = [];
            this._captionRenderedSource = "";
            this._captionLastDisplayedVisibleSeq = 0;
        }, delay);
    }

    hideRealtimeCaptionOverlayNow() {
        this.clearRealtimeCaptionHideTimer();
        this.clearRealtimeCaptionStabilizeTimer();
        if (this._captionOverlay) {
            this._captionOverlay.style.opacity = "0";
            this._captionOverlay.hidden = true;
        }
        this._captionDisplayItems = [];
        this._captionRenderedSource = "";
        this._captionLastDisplayedVisibleSeq = 0;
    }

    clearRealtimeCaptionStabilizeTimer() {
        if (this._captionStabilizeTimer) {
            clearTimeout(this._captionStabilizeTimer);
            this._captionStabilizeTimer = null;
        }
        if (this._captionStabilizeResolve) {
            this._captionStabilizeResolve(false);
        }
        this._captionStabilizePromise = null;
        this._captionStabilizeResolve = null;
        this._captionStabilizeTargetSource = "";
        this._captionStabilizeTargetVisibleSource = "";
    }

    scheduleRealtimeCaptionTranslation() {
        if (!this._captionModeEnabled) return;
        if (this._captionDebounceTimer) clearTimeout(this._captionDebounceTimer);
        this._captionDebounceTimer = setTimeout(() => {
            this._captionDebounceTimer = null;
            this.translateCurrentRealtimeCaption();
        }, this._captionDebounceMs);
        this.scheduleYouTubeCaptionPrefetch();
    }

    scheduleYouTubeCaptionPrefetch(delay = 300) {
        if (
            !this._captionModeEnabled ||
            this._captionPrefetchTimer ||
            !this.isYouTubeVideoActive()
        ) {
            return;
        }
        this._captionPrefetchTimer = setTimeout(() => {
            this._captionPrefetchTimer = null;
            this.prefetchYouTubeCaptionTrackAndWarmCache();
        }, delay);
    }

    getCurrentYouTubeCaptionText({ singleWindow = false } = {}) {
        const normalize = (value) =>
            String(value || "")
                .replace(/[\u200B-\u200D\uFEFF]/g, "")
                .replace(/\u00a0/g, " ")
                .replace(/[ \t\f\v]+/g, " ")
                .replace(/ *\n */g, "\n")
                .trim();
        const splitCaptionLines = (value) => normalize(value).split("\n").filter(Boolean);
        const isVisible = (node) => {
            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!element) return false;
            const ariaHidden = element.closest("[aria-hidden='true']");
            if (ariaHidden) return false;
            const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
            return !style || (style.display !== "none" && style.visibility !== "hidden");
        };
        const fromNodes = (nodes) => {
            const seen = new Set();
            return Array.from(nodes)
                .filter(isVisible)
                .flatMap((node) => splitCaptionLines(node.textContent))
                .filter(Boolean)
                .filter((text) => {
                    if (seen.has(text)) return false;
                    seen.add(text);
                    return true;
                });
        };
        const collapseRepeatedLineBlock = (lines) => {
            const normalizedLines = lines.map((line) =>
                this.normalizeRealtimeCaptionCacheText(line)
            );
            const lineCount = normalizedLines.length;
            for (let blockSize = 1; blockSize <= Math.floor(lineCount / 2); blockSize += 1) {
                if (lineCount % blockSize !== 0) continue;
                let repeated = true;
                for (let index = blockSize; index < lineCount; index += 1) {
                    if (normalizedLines[index] !== normalizedLines[index % blockSize]) {
                        repeated = false;
                        break;
                    }
                }
                if (repeated) return lines.slice(0, blockSize);
            }
            return lines;
        };
        const getContainerLines = (container) => {
            const segmentLines = fromNodes(
                container.querySelectorAll(
                    ".ytp-caption-segment, .caption-visual-line, [class*='caption-segment']"
                )
            );
            if (segmentLines.length) return segmentLines;
            const genericLines = fromNodes(container.querySelectorAll("span, div"));
            return genericLines.length
                ? genericLines
                : [normalize(container.textContent)].filter(Boolean);
        };
        const containers = Array.from(
            document.querySelectorAll(".ytp-caption-window-container, .caption-window")
        ).filter(isVisible);
        const captionWindows = containers.filter((container) =>
            container.classList?.contains("caption-window")
        );
        const selectedContainers =
            singleWindow && captionWindows.length ? [captionWindows[0]] : containers;
        const containerLines = selectedContainers.flatMap(getContainerLines);
        const lines = containerLines.length
            ? containerLines
            : fromNodes(
                  document.querySelectorAll(".ytp-caption-segment, [class*='caption-segment']")
              );
        const uniqueLines = [];
        const seenLines = new Set();
        for (const line of lines) {
            const key = this.normalizeRealtimeCaptionCacheText(line);
            if (key && !seenLines.has(key)) {
                seenLines.add(key);
                uniqueLines.push(line);
            }
        }
        return collapseRepeatedLineBlock(uniqueLines).join("\n").trim();
    }

    getYouTubeVideoElement() {
        return document.querySelector("video");
    }

    isYouTubeVideoActive() {
        const video = this.getYouTubeVideoElement();
        if (!video) return this.hasVisibleYouTubeCaptionText();
        if (video.ended) return false;
        if (video.readyState === 0 && !video.currentSrc && !video.src) {
            return this.hasVisibleYouTubeCaptionText();
        }
        return true;
    }

    isYouTubeNativeCaptionToggleOn() {
        const button = document.querySelector(".ytp-subtitles-button");
        if (!button) return null;
        const ariaPressed = button.getAttribute("aria-pressed");
        if (ariaPressed === "true") return true;
        if (ariaPressed === "false") return false;
        const ariaLabel = String(button.getAttribute("aria-label") || "").toLowerCase();
        if (/off|disable|사용 중지|끄기/.test(ariaLabel)) return true;
        if (/on|enable|사용|켜기/.test(ariaLabel)) return false;
        return null;
    }

    hasVisibleYouTubeCaptionText() {
        return Boolean(this.getCurrentYouTubeCaptionText());
    }

    normalizeRealtimeCaptionVisibleSource(sourceText) {
        return String(sourceText || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t\f\v]+/g, " ")
            .replace(/ *\n */g, "\n")
            .trim();
    }

    recordRealtimeCaptionVisibleSource(sourceText) {
        const normalized = this.normalizeRealtimeCaptionVisibleSource(sourceText);
        if (!normalized) return;
        const now = Date.now();
        this._captionVisibleSources = this._captionVisibleSources.filter(
            (entry) => now - entry.at <= this._captionStabilizeWindowMs
        );
        const last = this._captionVisibleSources.at(-1);
        if (last?.text === normalized) {
            last.at = now;
        } else {
            this._captionVisibleSources.push({
                text: normalized,
                at: now,
                seq: ++this._captionVisibleSourceSeq,
            });
        }
        if (this._captionVisibleSources.length > this._captionVisibleHistoryMax) {
            this._captionVisibleSources = this._captionVisibleSources.slice(
                -this._captionVisibleHistoryMax
            );
        }
    }

    isRealtimeCaptionOpenEnded(sourceText) {
        const normalized = this.normalizeRealtimeCaptionVisibleSource(sourceText);
        if (!normalized) return false;
        return !/[.!?。！？…)"'”’\]]$/.test(normalized);
    }

    buildStabilizedRealtimeCaptionSource(sourceText) {
        const now = Date.now();
        const recent = this._captionVisibleSources
            .filter((entry) => now - entry.at <= this._captionStabilizeWindowMs)
            .slice(-this._captionStabilizeMaxSources);
        const current = this.normalizeRealtimeCaptionVisibleSource(sourceText);
        if (current && !recent.some((entry) => entry.text === current)) {
            recent.push({ text: current, at: now });
        }
        const texts = [];
        recent.forEach((entry) => {
            const text = this.normalizeRealtimeCaptionVisibleSource(entry.text);
            if (!text) return;
            if (texts.some((existing) => existing.includes(text))) return;
            for (let index = texts.length - 1; index >= 0; index -= 1) {
                if (text.includes(texts[index])) texts.splice(index, 1);
            }
            texts.push(text);
        });
        return texts.join("\n").trim();
    }

    shouldStabilizeRealtimeCaptionSource(sourceText, requestSourceText, options = {}) {
        if (!sourceText || !requestSourceText) return false;
        const cacheKey = this.getRealtimeCaptionCacheKey(requestSourceText, options);
        if (this._captionTranslationCache.has(cacheKey)) return false;
        if (this.isRealtimeCaptionOpenEnded(sourceText)) return true;
        const now = Date.now();
        return this._captionVisibleSources
            .slice(0, -1)
            .some(
                (entry) =>
                    now - entry.at <= this._captionStabilizeWindowMs &&
                    this.isRealtimeCaptionOpenEnded(entry.text) &&
                    !sourceText.includes(entry.text)
            );
    }

    waitForRealtimeCaptionStability(sourceText, requestSourceText) {
        if (
            this._captionStabilizeTimer &&
            this._captionStabilizeTargetVisibleSource === sourceText &&
            this._captionStabilizeTargetSource === requestSourceText &&
            this._captionStabilizePromise
        ) {
            return this._captionStabilizePromise;
        }
        this.clearRealtimeCaptionStabilizeTimer();
        this._captionStabilizeTargetSource = requestSourceText;
        this._captionStabilizeTargetVisibleSource = sourceText;
        this.logRealtimeCaptionDebug("display:stabilize-wait", {
            chars: requestSourceText.length,
            visibleChars: sourceText.length,
        });
        this._captionStabilizePromise = new Promise((resolve) => {
            this._captionStabilizeResolve = resolve;
            this._captionStabilizeTimer = setTimeout(() => {
                this._captionStabilizeTimer = null;
                this._captionStabilizePromise = null;
                this._captionStabilizeResolve = null;
                const currentSource = this.getCurrentYouTubeCaptionText();
                if (!this._captionModeEnabled || !currentSource) {
                    resolve(false);
                    return;
                }
                this.recordRealtimeCaptionVisibleSource(currentSource);
                const stabilizedSource =
                    this.buildStabilizedRealtimeCaptionSource(currentSource) || currentSource;
                this._captionStabilizeTargetSource = "";
                this._captionStabilizeTargetVisibleSource = "";
                resolve(stabilizedSource);
            }, this._captionStabilizeDelayMs);
        });
        return this._captionStabilizePromise;
    }

    isYouTubeCaptionTranslationAllowed() {
        if (!this.isYouTubeVideoActive()) return false;
        if (this.hasVisibleYouTubeCaptionText()) return true;
        const nativeToggleOn = this.isYouTubeNativeCaptionToggleOn();
        if (nativeToggleOn === false) return false;
        if (nativeToggleOn === true) return true;
        return false;
    }

    async getRealtimeCaptionTranslateOptions() {
        const now = Date.now();
        if (
            this._captionOptionsCache &&
            now - this._captionOptionsCacheAt < this._captionOptionsCacheTtlMs
        ) {
            return this._captionOptionsCache;
        }
        const result = await getOrSetDefaultSettings(
            [
                "languageSetting",
                "LocalTranslatorConfig",
                "DefaultTranslator",
                "RealtimeCaptionConfig",
            ],
            DEFAULT_SETTINGS
        );
        const localConfig = result.LocalTranslatorConfig || {};
        const aiMode =
            localConfig.mode === "googleAiStudio" ||
            localConfig.mode === "openai" ||
            localConfig.mode === "openaiCompatible";
        const captionConfig = result.RealtimeCaptionConfig || {};
        const translatorMode = captionConfig.translatorMode === "google" ? "google" : "ai";
        const useAi = localConfig.enabled && aiMode && translatorMode === "ai";
        const translatorId =
            translatorMode === "google"
                ? "GoogleTranslate"
                : useAi
                ? "LocalTranslate"
                : "GoogleTranslate";
        const engine = translatorId === "LocalTranslate" ? localConfig.mode : "";
        // The caption overlay is always draggable — there's no downside to it, so
        // we dropped the toggle rather than carry a needless setting.
        this._captionOverlayDraggable = true;
        this.applyRealtimeCaptionOverlayPosition();
        const options = {
            sl: result.languageSetting?.sl || "auto",
            tl: result.languageSetting?.tl || "en",
            translatorId,
            engine,
            fastTranslatorId: "",
        };
        this._captionOptionsCache = options;
        this._captionOptionsCacheAt = now;
        return options;
    }

    getRealtimeCaptionFastOptions(options = {}) {
        const fastTranslatorId = options.fastTranslatorId || "";
        if (!fastTranslatorId || fastTranslatorId === options.translatorId) return null;
        return {
            sl: options.sl,
            tl: options.tl,
            translatorId: fastTranslatorId,
            engine: "",
        };
    }

    normalizeRealtimeCaptionCacheText(text) {
        return (
            String(text || "")
                .replace(/[\u200B-\u200D\uFEFF]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                // Fold trailing punctuation so a rolling cue and its punctuated close
                // ("Hello" / "Hello." / "Hello\u2026") map to one cache entry instead of
                // each re-spending a translation. (\s already covers nbsp.)
                .replace(
                    /[\s.,!?;:\u2026\u00B7"'\u201D\u2019\u300D\u300F\uFF09)\]\u2013\u2014-]+$/u,
                    ""
                )
                .trim()
        );
    }

    isNonSpeechCaption(text) {
        const raw = String(text || "").trim();
        if (!raw) return false;
        // A cue made up only of bracketed sound descriptors ([Music], (applause))
        // and/or bare musical notes carries no language to translate. Cues that mix
        // notes with lyrics ("♪ Hello ♪") keep real text and translate normally.
        const stripped = raw
            .replace(/\[[^\]]*\]/g, "")
            .replace(/\([^)]*\)/g, "")
            .replace(/[♪♫♬🎵🎶]/gu, "")
            .replace(/\s+/g, "");
        return stripped.length === 0;
    }

    getRealtimeCaptionCacheKey(text, options) {
        const normalizedText = this.normalizeRealtimeCaptionCacheText(text);
        return `${options.engine || options.translatorId}|${options.sl}|${
            options.tl
        }|${normalizedText}`;
    }

    cacheRealtimeCaptionTranslation(key, value) {
        if (!key || !value) return;
        if (this._captionTranslationCache.has(key)) this._captionTranslationCache.delete(key);
        this._captionTranslationCache.set(key, value);
        while (this._captionTranslationCache.size > this._captionTranslationCacheMax) {
            const oldestKey = this._captionTranslationCache.keys().next().value;
            this._captionTranslationCache.delete(oldestKey);
        }
    }

    getYouTubeVideoId() {
        try {
            const url = new URL(location.href);
            if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
            return url.searchParams.get("v") || "";
        } catch {
            return "";
        }
    }

    getYouTubePlayerResponse() {
        const pageResponse = window.ytInitialPlayerResponse;
        if (pageResponse?.captions) return pageResponse;
        const scripts = Array.from(document.querySelectorAll("script"));
        for (const script of scripts) {
            const text = script.textContent || "";
            const markerIndex = text.indexOf("ytInitialPlayerResponse");
            if (markerIndex < 0) continue;
            const jsonStart = text.indexOf("{", markerIndex);
            const jsonText = this.extractBalancedJsonObject(text, jsonStart);
            if (!jsonText) continue;
            try {
                const parsed = JSON.parse(jsonText);
                if (parsed?.captions) return parsed;
            } catch {
                // Keep scanning: YouTube can emit several bootstrap scripts.
            }
        }
        return null;
    }

    extractBalancedJsonObject(text, startIndex) {
        if (startIndex < 0) return "";
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let index = startIndex; index < text.length; index += 1) {
            const char = text[index];
            if (inString) {
                if (escape) {
                    escape = false;
                } else if (char === "\\") {
                    escape = true;
                } else if (char.charCodeAt(0) === 34) {
                    inString = false;
                }
                continue;
            }
            if (char.charCodeAt(0) === 34) {
                inString = true;
            } else if (char === "{") {
                depth += 1;
            } else if (char === "}") {
                depth -= 1;
                if (depth === 0) return text.slice(startIndex, index + 1);
            }
        }
        return "";
    }

    getYouTubeCaptionTracks() {
        const response = this.getYouTubePlayerResponse();
        const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        return Array.isArray(tracks) ? tracks.filter((track) => track?.baseUrl) : [];
    }

    normalizeCaptionLanguageCode(language) {
        return String(language || "")
            .toLowerCase()
            .split("-")[0];
    }

    getYouTubePlayerElement() {
        return (
            document.getElementById("movie_player") || document.querySelector(".html5-video-player")
        );
    }

    getYouTubeActiveCaptionTrack() {
        try {
            const player = this.getYouTubePlayerElement();
            if (!player || typeof player.getOption !== "function") return null;
            const track = player.getOption("captions", "track");
            return track && typeof track === "object" ? track : null;
        } catch {
            return null;
        }
    }

    captionTracksMatch(candidate, activeTrack) {
        if (!candidate || !activeTrack) return false;
        const candidateVssId = String(candidate.vssId || "");
        const activeVssId = String(activeTrack.vssId || activeTrack.vss_id || "");
        if (candidateVssId && activeVssId && candidateVssId === activeVssId) return true;

        const candidateLanguage = this.normalizeCaptionLanguageCode(candidate.languageCode);
        const activeLanguage = this.normalizeCaptionLanguageCode(
            activeTrack.languageCode || activeTrack.langCode || activeTrack.lang
        );
        return Boolean(candidateLanguage && activeLanguage && candidateLanguage === activeLanguage);
    }

    pickYouTubeCaptionTrack(tracks, options) {
        return this.getYouTubeCaptionTrackCandidates(tracks, options)[0] || null;
    }

    getYouTubeCaptionTrackCandidates(tracks, options) {
        const candidates = tracks.filter((track) => track?.baseUrl);
        if (!candidates.length) return [];
        const sourceLanguage = this.normalizeCaptionLanguageCode(options.sl);
        const targetLanguage = this.normalizeCaptionLanguageCode(options.tl);
        const nonTarget =
            targetLanguage && targetLanguage !== "auto"
                ? candidates.filter(
                      (track) =>
                          this.normalizeCaptionLanguageCode(track.languageCode) !== targetLanguage
                  )
                : candidates;
        const activeTrack = this.getYouTubeActiveCaptionTrack();
        const activeCandidate = nonTarget.find((track) =>
            this.captionTracksMatch(track, activeTrack)
        );
        const ordered = [];
        const pushCandidate = (track) => {
            if (!track || ordered.includes(track)) return;
            ordered.push(track);
        };
        pushCandidate(activeCandidate);
        if (sourceLanguage && sourceLanguage !== "auto") {
            const exact = candidates.find(
                (track) => this.normalizeCaptionLanguageCode(track.languageCode) === sourceLanguage
            );
            pushCandidate(exact);
        }
        nonTarget.filter((track) => !/^a\./.test(track.vssId || "")).forEach(pushCandidate);
        nonTarget.forEach(pushCandidate);
        candidates.forEach(pushCandidate);
        return ordered;
    }

    getYouTubeCaptionTrackUrl(track) {
        try {
            const url = new URL(track.baseUrl, location.href);
            url.searchParams.set("fmt", "json3");
            return url.toString();
        } catch {
            return track.baseUrl || "";
        }
    }

    async fetchYouTubeCaptionCues(track) {
        const url = this.getYouTubeCaptionTrackUrl(track);
        if (!url || typeof fetch !== "function") return [];
        this.logRealtimeCaptionDebug("track:fetch", {
            languageCode: track.languageCode || "",
            vssId: track.vssId || "",
        });
        const response = await fetch(url, { credentials: "include" });
        if (!response?.ok) {
            this.logRealtimeCaptionDebug("track:fetch-fail", { status: response?.status || 0 });
            return [];
        }
        const body = await response.text();
        const cues = body.trim().startsWith("{")
            ? this.parseYouTubeJsonCaptionCues(body)
            : this.parseYouTubeXmlCaptionCues(body);
        const compacted = this.addYouTubeCaptionCueGroups(this.compactYouTubeCaptionCues(cues));
        this.logRealtimeCaptionDebug("track:loaded", {
            cues: compacted.length,
            firstStartMs: compacted[0]?.startMs || 0,
            lastStartMs: compacted[compacted.length - 1]?.startMs || 0,
        });
        return compacted;
    }

    parseYouTubeJsonCaptionCues(body) {
        try {
            const payload = JSON.parse(body);
            const events = Array.isArray(payload.events) ? payload.events : [];
            return events
                .map((event) => {
                    const text = (event.segs || [])
                        .map((segment) => segment?.utf8 || "")
                        .join("")
                        .replace(/\s+/g, " ")
                        .trim();
                    if (!text) return null;
                    const startMs = Number(event.tStartMs) || 0;
                    const durationMs = Number(event.dDurationMs) || 0;
                    return { startMs, endMs: startMs + durationMs, text };
                })
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    parseYouTubeXmlCaptionCues(body) {
        try {
            const documentXml = new DOMParser().parseFromString(body, "text/xml");
            return Array.from(documentXml.querySelectorAll("text"))
                .map((node) => {
                    const text = String(node.textContent || "")
                        .replace(/\s+/g, " ")
                        .trim();
                    if (!text) return null;
                    const startMs = Math.round(Number(node.getAttribute("start") || 0) * 1000);
                    const durationMs = Math.round(Number(node.getAttribute("dur") || 0) * 1000);
                    return { startMs, endMs: startMs + durationMs, text };
                })
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    compactYouTubeCaptionCues(cues) {
        const compacted = [];
        for (const cue of cues) {
            const text = String(cue?.text || "")
                .replace(/\s+/g, " ")
                .trim();
            if (!text) continue;
            const previous = compacted[compacted.length - 1];
            if (previous?.text === text) {
                previous.endMs = Math.max(previous.endMs, cue.endMs || previous.endMs);
                continue;
            }
            compacted.push({ ...cue, text });
        }
        return compacted;
    }

    // Merge consecutive cues that form one sentence so the prefetch path can
    // translate (and show) the whole sentence at once — far more natural than
    // translating each mid-sentence fragment in isolation. Each member cue gets the
    // shared `groupText`; the warm step caches the sentence translation under every
    // member's key, so the live display serves it whenever any part is on screen.
    addYouTubeCaptionCueGroups(cues) {
        const sentenceEnd = /[.!?…。！？؟]["'”’」』)\]]*$/;
        // Only sentence-merge tracks that actually punctuate (manual / quality
        // captions). Auto-generated tracks usually have no punctuation, where merging
        // would just glue unrelated cues — leave those one-per-cue.
        const punctuated = cues.filter((cue) =>
            sentenceEnd.test(String(cue.text || "").trim())
        ).length;
        const useSentenceGroups = cues.length >= 4 && punctuated / cues.length >= 0.15;
        if (!useSentenceGroups) {
            return cues.map((cue, index) => {
                cue.groupText = cue.text;
                cue.groupId = index;
                cue.cueIndex = index;
                cue.normText = this.normalizeRealtimeCaptionCacheText(cue.text);
                return cue;
            });
        }
        const MAX_GROUP_CUES = 4;
        const MAX_GROUP_GAP_MS = 1500;
        const MAX_GROUP_CHARS = 260;
        let groupId = 0;
        let i = 0;
        while (i < cues.length) {
            let end = i;
            let chars = 0;
            for (let j = i; j < cues.length; j++) {
                const cue = cues[j];
                chars += String(cue.text || "").length + 1;
                end = j;
                const endsSentence = sentenceEnd.test(String(cue.text || "").trim());
                const next = cues[j + 1];
                const gap = next ? next.startMs - cue.endMs : Infinity;
                const reachedCap = j - i + 1 >= MAX_GROUP_CUES || chars >= MAX_GROUP_CHARS;
                if (endsSentence || reachedCap || gap > MAX_GROUP_GAP_MS) break;
            }
            const groupText = cues
                .slice(i, end + 1)
                .map((cue) => cue.text)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
            for (let k = i; k <= end; k++) {
                cues[k].groupText = groupText;
                cues[k].groupId = groupId;
                cues[k].cueIndex = k;
                cues[k].normText = this.normalizeRealtimeCaptionCacheText(cues[k].text);
            }
            groupId += 1;
            i = end + 1;
        }
        return cues;
    }

    getCurrentVideoTimeMs() {
        const video = this.getYouTubeVideoElement();
        const currentTime = Number(video?.currentTime);
        return Number.isFinite(currentTime) ? Math.max(0, currentTime * 1000) : 0;
    }

    async loadYouTubeCaptionPrefetchCues(options) {
        if (this._captionPrefetchCues.length) return true;
        if (this._captionPrefetchLoadPromise) {
            await this._captionPrefetchLoadPromise;
            return Boolean(this._captionPrefetchCues.length);
        }
        this._captionPrefetchLoadPromise = (async () => {
            const videoId = this.getYouTubeVideoId();
            if (videoId && videoId !== this._captionPrefetchVideoId) {
                this._captionPrefetchVideoId = videoId;
                this._captionPrefetchTrackKey = "";
                this._captionPrefetchEmptyTrackKeys.clear();
                this._captionPrefetchAllEmptyKey = "";
                this._captionPrefetchAllEmptyAt = 0;
                this._captionPrefetchCues = [];
            }
            const tracks = this.getYouTubeCaptionTrackCandidates(
                this.getYouTubeCaptionTracks(),
                options
            );
            if (!tracks.length) {
                return false;
            }
            const allTracksKey = tracks
                .map(
                    (track) =>
                        `${track.languageCode || ""}:${track.vssId || ""}:${track.baseUrl || ""}`
                )
                .join("|");
            if (
                allTracksKey &&
                allTracksKey === this._captionPrefetchAllEmptyKey &&
                Date.now() - this._captionPrefetchAllEmptyAt < 30000
            ) {
                this.logRealtimeCaptionDebug("track:all-empty-skip", {
                    tracks: tracks.length,
                });
                return false;
            }
            let triedTrack = false;
            for (const track of tracks) {
                const trackKey = `${track.baseUrl}|${track.languageCode || ""}|${
                    track.vssId || ""
                }`;
                if (
                    trackKey === this._captionPrefetchTrackKey &&
                    this._captionPrefetchCues.length
                ) {
                    return false;
                }
                const emptyAt = this._captionPrefetchEmptyTrackKeys.get(trackKey) || 0;
                if (Date.now() - emptyAt < 30000) {
                    this.logRealtimeCaptionDebug("track:empty-skip", {
                        languageCode: track.languageCode || "",
                        vssId: track.vssId || "",
                    });
                    continue;
                }
                triedTrack = true;
                const cues = await this.fetchYouTubeCaptionCues(track);
                if (!cues.length) {
                    this._captionPrefetchEmptyTrackKeys.set(trackKey, Date.now());
                    continue;
                }
                this._captionPrefetchEmptyTrackKeys.clear();
                this._captionPrefetchAllEmptyKey = "";
                this._captionPrefetchAllEmptyAt = 0;
                this._captionPrefetchTrackKey = trackKey;
                this._captionPrefetchCues = cues;
                this.logRealtimeCaptionDebug("track:ready", { cues: cues.length });
                return true;
            }
            if (triedTrack && allTracksKey) {
                this._captionPrefetchAllEmptyKey = allTracksKey;
                this._captionPrefetchAllEmptyAt = Date.now();
                this.logRealtimeCaptionDebug("track:all-empty", { tracks: tracks.length });
            }
            return false;
        })().finally(() => {
            this._captionPrefetchLoadPromise = null;
        });
        return this._captionPrefetchLoadPromise;
    }

    async prefetchYouTubeCaptionTrackAndWarmCache({ reschedule = true } = {}) {
        if (!this._captionModeEnabled || !this.isYouTubeVideoActive()) {
            this.hideRealtimeCaptionOverlayNow();
            return;
        }
        try {
            const options = await this.getRealtimeCaptionTranslateOptions();
            if (this.isGoogleRealtimeCaptionTranslator(options)) return;
            await this.loadYouTubeCaptionPrefetchCues(options);
            this.warmRealtimeCaptionPrefetchCache(options);
        } catch {
            // Prefetch is opportunistic; visible-caption translation remains authoritative.
        } finally {
            if (reschedule) this.scheduleYouTubeCaptionPrefetch(350);
        }
    }

    warmRealtimeCaptionPrefetchCache(options) {
        if (!this._captionPrefetchCues.length) return;
        const currentMs = this.getCurrentVideoTimeMs();
        const windowEndMs = currentMs + this._captionPrefetchWindowMs;
        const entries = [];
        let charCount = 0;
        let started = 0;
        let index = this._captionPrefetchCues.findIndex((cue) => cue.endMs >= currentMs - 500);
        if (index < 0) return;

        const seenGroups = new Set();
        while (
            index < this._captionPrefetchCues.length &&
            started < this._captionPrefetchBatchSize
        ) {
            if (this._captionPrefetchInFlight.size >= this._captionPrefetchMaxInFlight) {
                break;
            }
            const cue = this._captionPrefetchCues[index];
            if (cue.startMs > windowEndMs) break;
            // Translate one entry per SENTENCE GROUP (not per fragment cue).
            const groupText = cue.groupText || cue.text;
            if (seenGroups.has(groupText)) {
                index += 1;
                continue;
            }
            seenGroups.add(groupText);
            const entry = this.createRealtimeCaptionPrefetchEntry(groupText, options);
            if (entry) {
                entry.memberTexts =
                    cue.groupId != null
                        ? this._captionPrefetchCues
                              .filter((other) => other.groupId === cue.groupId)
                              .map((other) => other.text)
                        : [cue.text];
                const nextChars = charCount + entry.sourceText.length + 8;
                if (entries.length && nextChars > this._captionPrefetchBatchMaxChars) break;
                entries.push(entry);
                charCount = nextChars;
                started += 1;
            }
            index += 1;
        }
        this.logRealtimeCaptionDebug("prefetch:window", {
            entries: entries.length,
            inFlight: this._captionPrefetchInFlight.size,
            windowEndMs,
        });
        this.prefetchRealtimeCaptionSources(entries, options);
        const fastOptions = this.getRealtimeCaptionFastOptions(options);
        if (fastOptions) {
            const fastEntries = entries
                .slice(0, this._captionFastPrefetchBatchSize)
                .map((entry) => {
                    const fastEntry = this.createRealtimeCaptionPrefetchEntry(
                        entry.sourceText,
                        fastOptions
                    );
                    if (fastEntry) fastEntry.memberTexts = entry.memberTexts;
                    return fastEntry;
                })
                .filter(Boolean);
            this.prefetchRealtimeCaptionSourcesIndividually(fastEntries, fastOptions);
        }
    }

    createRealtimeCaptionPrefetchEntry(sourceText, options) {
        const cacheKey = this.getRealtimeCaptionCacheKey(sourceText, options);
        if (
            !cacheKey ||
            this._captionTranslationCache.has(cacheKey) ||
            this._captionPrefetchInFlight.has(cacheKey)
        ) {
            return null;
        }
        return { cacheKey, sourceText };
    }

    prefetchRealtimeCaptionSource(sourceText, options) {
        const entry = this.createRealtimeCaptionPrefetchEntry(sourceText, options);
        if (!entry) return false;
        return this.prefetchRealtimeCaptionSources([entry], options);
    }

    prefetchRealtimeCaptionSourcesIndividually(entries, options) {
        const limitedEntries = entries.slice(0, this._captionFastPrefetchBatchSize);
        if (!limitedEntries.length) return false;
        limitedEntries.forEach((entry) => {
            this.prefetchRealtimeCaptionSources([entry], options);
        });
        return true;
    }

    prefetchRealtimeCaptionSources(entries, options) {
        if (!entries.length) return false;
        entries.forEach((entry) => this._captionPrefetchInFlight.add(entry.cacheKey));
        const isBatch = entries.length > 1;
        const text = isBatch
            ? entries.map((entry, index) => `[[${index}]] ${entry.sourceText}`).join("\n")
            : entries[0].sourceText;
        const request = {
            text,
            sl: options.sl,
            tl: options.tl,
            translatorId: options.translatorId,
            textRole: "caption",
            translationProfile: isBatch ? "realtimeCaptionBatch" : "realtimeCaption",
        };
        if (options.engine) request.engine = options.engine;
        this.logRealtimeCaptionDebug("prefetch:request", {
            entries: entries.length,
            isBatch,
            chars: text.length,
            engine: options.engine || options.translatorId || "",
        });
        // Cache the sentence translation under the group key AND each member cue's key,
        // so the display hits the full natural translation for any fragment on screen.
        const cacheGroupEntry = (entry, value) => {
            if (!entry || !value) return;
            this.cacheRealtimeCaptionTranslation(entry.cacheKey, value);
            (entry.memberTexts || []).forEach((memberText) => {
                const memberKey = this.getRealtimeCaptionCacheKey(memberText, options);
                if (memberKey && memberKey !== entry.cacheKey) {
                    this.cacheRealtimeCaptionTranslation(memberKey, value);
                }
            });
        };
        Promise.resolve(this.channel.request("translate_text_quiet", request))
            .then((result) => {
                const translated = String(
                    result?.mainMeaning || result?.translatedText || ""
                ).trim();
                if (!translated || result?.translationFailed) {
                    this.logRealtimeCaptionDebug("prefetch:empty", {
                        entries: entries.length,
                        failed: Boolean(result?.translationFailed),
                    });
                    return;
                }
                if (!isBatch) {
                    cacheGroupEntry(entries[0], translated);
                    this.logRealtimeCaptionDebug("prefetch:cached", { entries: 1 });
                    return;
                }
                const parsed = this.parseRealtimeCaptionBatchTranslation(
                    translated,
                    entries.length
                );
                let cachedCount = 0;
                entries.forEach((entry, index) => {
                    if (parsed[index]) {
                        cacheGroupEntry(entry, parsed[index]);
                        cachedCount += 1;
                    }
                });
                this.logRealtimeCaptionDebug("prefetch:cached", {
                    entries: entries.length,
                    cached: cachedCount,
                });
            })
            .catch((error) => {
                this.logRealtimeCaptionDebug("prefetch:error", {
                    message: error?.message || String(error || ""),
                });
            })
            .finally(() => {
                entries.forEach((entry) => this._captionPrefetchInFlight.delete(entry.cacheKey));
            });
        return true;
    }

    // Map an on-screen caption fragment to its prefetched sentence-group text, so the
    // whole sentence is translated/shown as one canonical unit. Returns the original
    // text when there's no multi-cue group (no transcript, auto-captions, single-cue).
    //
    // TEXT-first matching: a small video-time vs caption-display offset used to drop the
    // ±700ms time window and leave the sentence un-merged. We now find the cue by text
    // and only use time to disambiguate repeated lines, so the merge is reliable.
    resolveRealtimeCaptionGroupSource(sourceText) {
        if (!this._captionPrefetchCues.length) return sourceText;
        const normSource = this.normalizeRealtimeCaptionCacheText(sourceText);
        if (!normSource) return sourceText;
        const matches = this._captionPrefetchCues.filter((cue) => {
            const cueNorm = cue.normText || this.normalizeRealtimeCaptionCacheText(cue.text);
            return (
                cueNorm &&
                (cueNorm === normSource ||
                    cueNorm.includes(normSource) ||
                    normSource.includes(cueNorm))
            );
        });
        if (!matches.length) return sourceText;
        // Repeated lines: pick the cue nearest the current playback time.
        if (matches.length > 1) {
            const currentMs = this.getCurrentVideoTimeMs();
            matches.sort(
                (a, b) =>
                    Math.abs((a.startMs + a.endMs) / 2 - currentMs) -
                    Math.abs((b.startMs + b.endMs) / 2 - currentMs)
            );
        }
        const best = matches[0];
        if (best.groupId == null) return sourceText;
        const groupText = best.groupText;
        if (!groupText || groupText === best.text) return sourceText;
        const normGroup = this.normalizeRealtimeCaptionCacheText(groupText);
        if (!normGroup) return sourceText;
        // Only override when the on-screen text is genuinely part of the group.
        return normGroup.includes(normSource) ? groupText : sourceText;
    }

    dedupeRealtimeCaptionCuesByGroup(cues) {
        if (!cues || cues.length <= 1) return cues || [];
        const seen = new Set();
        const result = [];
        for (const cue of cues) {
            const key = cue.groupId != null ? `g${cue.groupId}` : cue.text;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(cue);
        }
        return result;
    }

    getActivePrefetchedCaptionCues(sourceText = "") {
        if (!this._captionPrefetchCues.length) return [];
        const currentMs = this.getCurrentVideoTimeMs();
        const normalizedSource = this.normalizeRealtimeCaptionCacheText(sourceText);
        const active = this._captionPrefetchCues.filter(
            (cue) => cue.startMs <= currentMs + 700 && cue.endMs >= currentMs - 700
        );
        if (!normalizedSource || !active.length) return active;
        const exact = active.filter(
            (cue) => this.normalizeRealtimeCaptionCacheText(cue.text) === normalizedSource
        );
        if (exact.length) return exact;
        const joined = this.normalizeRealtimeCaptionCacheText(
            active.map((cue) => cue.text).join("\n")
        );
        if (joined === normalizedSource) return active;
        return active.filter((cue) => {
            const cueText = this.normalizeRealtimeCaptionCacheText(cue.text);
            return (
                cueText &&
                (normalizedSource.includes(cueText) || cueText.includes(normalizedSource))
            );
        });
    }

    findPrefetchedRealtimeCaptionTranslation(sourceText, options) {
        const lookupOptions = [options, this.getRealtimeCaptionFastOptions(options)].filter(
            Boolean
        );
        for (const candidateOptions of lookupOptions) {
            const direct = this._captionTranslationCache.get(
                this.getRealtimeCaptionCacheKey(sourceText, candidateOptions)
            );
            if (direct) {
                this.logRealtimeCaptionDebug("display:cache-hit", {
                    mode:
                        candidateOptions.translatorId === options.translatorId
                            ? "direct"
                            : "fast-direct",
                    sourceLength: sourceText.length,
                });
                return {
                    text: direct,
                    fast: candidateOptions.translatorId !== options.translatorId,
                };
            }
        }
        // Collapse cues that belong to the same sentence group so a sentence whose
        // fragments are both on screen isn't joined (and shown) twice.
        const activeCues = this.dedupeRealtimeCaptionCuesByGroup(
            this.getActivePrefetchedCaptionCues(sourceText)
        );
        if (activeCues.length) {
            for (const candidateOptions of lookupOptions) {
                const translated = activeCues
                    .map((cue) =>
                        this._captionTranslationCache.get(
                            this.getRealtimeCaptionCacheKey(cue.text, candidateOptions)
                        )
                    )
                    .filter(Boolean);
                if (translated.length === activeCues.length) {
                    this.logRealtimeCaptionDebug("display:cache-hit", {
                        mode:
                            candidateOptions.translatorId === options.translatorId
                                ? "active-cues"
                                : "fast-active-cues",
                        cues: activeCues.length,
                    });
                    return {
                        text: translated.join("\n"),
                        fast: candidateOptions.translatorId !== options.translatorId,
                    };
                }
                this.logRealtimeCaptionDebug("display:cache-partial", {
                    mode:
                        candidateOptions.translatorId === options.translatorId
                            ? "active-cues"
                            : "fast-active-cues",
                    cues: activeCues.length,
                    cached: translated.length,
                });
            }
        }
        this.logRealtimeCaptionDebug("display:cache-miss", {
            sourceLength: sourceText.length,
            activeCues: activeCues.length,
        });
        return null;
    }

    getRealtimeCaptionContextRequest(sourceText) {
        return this.getRealtimeCaptionContextRequestForOptions(
            sourceText,
            this._captionOptionsCache || {}
        );
    }

    getRealtimeCaptionContextRequestForOptions(sourceText, options) {
        return {
            sourceText,
            contextCues: [],
            cacheKey: this.getRealtimeCaptionCacheKey(sourceText, options),
        };
    }

    isRealtimeCaptionRequestStillCurrent(sourceText) {
        if (!this._captionModeEnabled) return false;
        return sourceText === this._captionLastSource;
    }

    canApplyLateMergedRealtimeCaption(sourceText) {
        if (!String(sourceText || "").includes("\n")) return false;
        return this._captionDisplayItems.some((item) =>
            this.realtimeCaptionSourceIncludes(sourceText, item.source)
        );
    }

    markRealtimeCaptionMergedReplacementSource(sourceText) {
        if (!String(sourceText || "").includes("\n")) return;
        const source = this.normalizeRealtimeCaptionCacheText(sourceText);
        if (!source) return;
        this._captionMergedReplacementSources.add(source);
        if (this._captionMergedReplacementSources.size > 20) {
            const [oldest] = this._captionMergedReplacementSources;
            this._captionMergedReplacementSources.delete(oldest);
        }
    }

    shouldUseExpandedCaptionReplacement(sourceText) {
        const source = this.normalizeRealtimeCaptionCacheText(sourceText);
        return (
            Boolean(source && this._captionMergedReplacementSources.has(source)) &&
            this.canApplyLateMergedRealtimeCaption(sourceText)
        );
    }

    getRealtimeCaptionVisibleSourceSeq(sourceText) {
        const source = this.normalizeRealtimeCaptionVisibleSource(sourceText);
        if (!source) return 0;
        const exact = this._captionVisibleSources.find((entry) => entry.text === source);
        if (exact?.seq) return exact.seq;
        return source
            .split(/\n+/)
            .map((line) => this.normalizeRealtimeCaptionVisibleSource(line))
            .filter(Boolean)
            .reduce((maxSeq, line) => {
                const entry = this._captionVisibleSources.find((item) => item.text === line);
                return Math.max(maxSeq, entry?.seq || 0);
            }, 0);
    }

    canDisplayRealtimeCaptionSource(sourceText, { allowOlderReplacement = false } = {}) {
        const seq = this.getRealtimeCaptionVisibleSourceSeq(sourceText);
        if (!seq) return true;
        if (!allowOlderReplacement && seq < this._captionLastDisplayedVisibleSeq) return false;
        this._captionLastDisplayedVisibleSeq = Math.max(this._captionLastDisplayedVisibleSeq, seq);
        return true;
    }

    wasRecentlyVisibleRealtimeCaptionSource(sourceText) {
        const source = this.normalizeRealtimeCaptionVisibleSource(sourceText);
        if (!source) return false;
        const now = Date.now();
        return this._captionVisibleSources.some(
            (entry) => now - entry.at <= this._captionStabilizeWindowMs && entry.text === source
        );
    }

    enqueueRealtimeCaptionPendingSource(sourceText) {
        const source = this.normalizeRealtimeCaptionVisibleSource(sourceText);
        if (!source || source === this._captionInFlightSource) return;
        this._captionPendingSources = this._captionPendingSources.filter((item) => item !== source);
        this._captionPendingSources.push(source);
        if (this._captionPendingSources.length > this._captionPendingMax) {
            this._captionPendingSources = this._captionPendingSources.slice(
                -this._captionPendingMax
            );
        }
        this._captionPendingSource = this._captionPendingSources.at(-1) || "";
    }

    shiftRealtimeCaptionPendingSource() {
        const source = this._captionPendingSources.shift() || "";
        this._captionPendingSource = this._captionPendingSources.at(-1) || "";
        return source;
    }

    showRealtimeCaptionTranslatedText(translated, sourceText, options = {}) {
        if (!translated) return;
        this.logRealtimeCaptionDebug("display:show", {
            sourceLength: String(sourceText || "").length,
            translatedLength: String(translated || "").length,
            lines: String(translated || "")
                .split(/\n+/)
                .filter(Boolean).length,
        });
        this.showRealtimeCaptionOverlay(translated, sourceText, options);
    }

    isGoogleRealtimeCaptionTranslator(options = {}) {
        return options?.translatorId === "GoogleTranslate" && !options?.engine;
    }

    requestRealtimeCaptionFastFallback(sourceText, options) {
        const fastOptions = this.getRealtimeCaptionFastOptions(options);
        if (!fastOptions || this.shouldUseExpandedCaptionReplacement(sourceText)) return null;
        const cacheKey = this.getRealtimeCaptionCacheKey(sourceText, fastOptions);
        if (!cacheKey || this._captionTranslationCache.has(cacheKey)) return null;
        this._captionPrefetchInFlight.add(cacheKey);
        const request = {
            text: sourceText,
            sl: fastOptions.sl,
            tl: fastOptions.tl,
            translatorId: fastOptions.translatorId,
            textRole: "caption",
            translationProfile: "realtimeCaptionFast",
        };
        this.logRealtimeCaptionDebug("display:fast-fallback-request", {
            translatorId: fastOptions.translatorId,
            chars: sourceText.length,
        });
        const fastPromise = Promise.resolve(this.channel.request("translate_text_quiet", request))
            .then((result) => {
                const translated = String(
                    result?.mainMeaning || result?.translatedText || ""
                ).trim();
                if (!translated || result?.translationFailed) return "";
                this.cacheRealtimeCaptionTranslation(cacheKey, translated);
                if (
                    !this._captionModeEnabled ||
                    this._captionRenderedSource === sourceText ||
                    (!this.isRealtimeCaptionRequestStillCurrent(sourceText) &&
                        !this.wasRecentlyVisibleRealtimeCaptionSource(sourceText)) ||
                    !this.canDisplayRealtimeCaptionSource(sourceText)
                ) {
                    return translated;
                }
                this.showRealtimeCaptionTranslatedText(translated, sourceText);
                return translated;
            })
            .catch(() => "")
            .finally(() => {
                this._captionPrefetchInFlight.delete(cacheKey);
            });
        return fastPromise;
    }

    shouldBatchRealtimeCaptionTranslation(options) {
        return (
            options?.translatorId === "LocalTranslate" &&
            (options.engine === "openai" ||
                options.engine === "googleAiStudio" ||
                options.engine === "openaiCompatible")
        );
    }

    queueRealtimeCaptionBatchTranslation(sourceText, options) {
        const cacheKey = this.getRealtimeCaptionCacheKey(sourceText, options);
        const cached = this._captionTranslationCache.get(cacheKey);
        if (cached) return Promise.resolve(cached);
        const inFlight = this._captionBatchInFlight.get(cacheKey);
        if (inFlight) {
            this.logRealtimeCaptionDebug("display:fallback-join", {
                mode: "live-batch",
                chars: sourceText.length,
            });
            return inFlight;
        }
        this.logRealtimeCaptionDebug("display:fallback-request", {
            mode: "live-batch",
            chars: sourceText.length,
        });
        const queued = new Promise((resolve) => {
            const existing = this._captionBatchQueue.get(cacheKey);
            if (existing) {
                existing.resolvers.push(resolve);
            } else {
                this._captionBatchQueue.set(cacheKey, {
                    cacheKey,
                    sourceText,
                    options,
                    resolvers: [resolve],
                });
            }
            if (this._captionBatchQueue.size >= this._captionBatchMaxSize) {
                this.flushRealtimeCaptionBatchQueue();
            } else if (!this._captionBatchTimer) {
                this._captionBatchTimer = setTimeout(() => {
                    this._captionBatchTimer = null;
                    this.flushRealtimeCaptionBatchQueue();
                }, this._captionBatchDelayMs);
            }
        });
        this._captionBatchInFlight.set(cacheKey, queued);
        queued.finally(() => {
            if (this._captionBatchInFlight.get(cacheKey) === queued) {
                this._captionBatchInFlight.delete(cacheKey);
            }
        });
        return queued;
    }

    flushRealtimeCaptionBatchQueue() {
        if (this._captionBatchTimer) {
            clearTimeout(this._captionBatchTimer);
            this._captionBatchTimer = null;
        }
        const entries = Array.from(this._captionBatchQueue.values()).slice(
            0,
            this._captionBatchMaxSize
        );
        entries.forEach((entry) => this._captionBatchQueue.delete(entry.cacheKey));
        if (!entries.length) return;
        if (this._captionBatchQueue.size) {
            this._captionBatchTimer = setTimeout(() => {
                this._captionBatchTimer = null;
                this.flushRealtimeCaptionBatchQueue();
            }, this._captionBatchDelayMs);
        }

        const options = entries[0].options;
        const batchText = entries
            .map((entry, index) => `[[${index}]] ${entry.sourceText}`)
            .join("\n");
        const request = {
            text: batchText,
            sl: options.sl,
            tl: options.tl,
            translatorId: options.translatorId,
            textRole: "caption",
            translationProfile: "realtimeCaptionBatch",
        };
        if (options.engine) request.engine = options.engine;

        Promise.resolve(this.channel.request("translate_text_quiet", request))
            .then((result) => {
                const translatedText = String(
                    result?.mainMeaning || result?.translatedText || ""
                ).trim();
                const parsed = this.parseRealtimeCaptionBatchTranslation(
                    translatedText,
                    entries.length
                );
                entries.forEach((entry, index) => {
                    const translated =
                        parsed[index] || (entries.length === 1 ? translatedText : "");
                    if (translated && !result?.translationFailed) {
                        this.cacheRealtimeCaptionTranslation(entry.cacheKey, translated);
                    }
                    entry.resolvers.forEach((resolve) => resolve(translated));
                });
            })
            .catch(() => {
                entries.forEach((entry) => entry.resolvers.forEach((resolve) => resolve("")));
            });
    }

    parseRealtimeCaptionBatchTranslation(text, expectedCount) {
        const output = Array.from({ length: expectedCount }, () => "");
        const fallbackLines = [];
        String(text || "")
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .forEach((line) => {
                const markerMatch = line.match(/^\[\[(\d+)]]\s*(.+)$/);
                if (markerMatch) {
                    const index = Number(markerMatch[1]);
                    if (index >= 0 && index < expectedCount) output[index] = markerMatch[2].trim();
                    return;
                }
                const numberedMatch = line.match(/^(\d+)[).:-]\s*(.+)$/);
                if (numberedMatch) {
                    const oneBasedIndex = Number(numberedMatch[1]) - 1;
                    if (oneBasedIndex >= 0 && oneBasedIndex < expectedCount) {
                        output[oneBasedIndex] = numberedMatch[2].trim();
                        return;
                    }
                }
                fallbackLines.push(line);
            });
        fallbackLines.forEach((line, index) => {
            if (index < expectedCount && !output[index]) output[index] = line;
        });
        return output;
    }

    async translateCurrentRealtimeCaption() {
        if (!this._captionModeEnabled) return;
        if (!this.isYouTubeCaptionTranslationAllowed()) {
            this._captionLastSource = "";
            this._captionPendingSource = "";
            this._captionPendingSources = [];
            this._captionVisibleSources = [];
            this._captionVisibleSourceSeq = 0;
            this._captionLastDisplayedVisibleSeq = 0;
            this._captionMergedReplacementSources.clear();
            this.clearRealtimeCaptionStabilizeTimer();
            this._captionLastRequestId += 1;
            this.hideRealtimeCaptionOverlayNow();
            return;
        }
        const options = await this.getRealtimeCaptionTranslateOptions();
        const googleCaptionMode = this.isGoogleRealtimeCaptionTranslator(options);
        const sourceText = this.getCurrentYouTubeCaptionText({
            singleWindow: googleCaptionMode,
        });
        if (!sourceText) {
            this._captionLastSource = "";
            this._captionPendingSource = "";
            this._captionPendingSources = [];
            this._captionVisibleSources = [];
            this._captionVisibleSourceSeq = 0;
            this._captionLastDisplayedVisibleSeq = 0;
            this._captionMergedReplacementSources.clear();
            this.clearRealtimeCaptionStabilizeTimer();
            this._captionLastRequestId += 1;
            this.scheduleRealtimeCaptionOverlayHide();
            return;
        }
        this.recordRealtimeCaptionVisibleSource(sourceText);
        // Sound-only cues ([Music], ♪) need no translation — show them verbatim,
        // instantly, with zero tokens. Dedup so a held note doesn't re-render.
        if (this.isNonSpeechCaption(sourceText)) {
            if (sourceText !== this._captionLastSource) {
                this.clearRealtimeCaptionStabilizeTimer();
                this.clearRealtimeCaptionHideTimer();
                this._captionLastSource = sourceText;
                this.showRealtimeCaptionTranslatedText(sourceText, sourceText);
            }
            return;
        }
        // If this fragment belongs to a prefetched sentence group, translate and show
        // the WHOLE sentence as one canonical unit. Both the fast (Google) fallback and
        // the AI translation then run on the same text, so a fragment translation and
        // the merged sentence can never both appear (the group is already complete, so
        // stabilization is unnecessary).
        const groupSource = this.resolveRealtimeCaptionGroupSource(sourceText);
        if (groupSource !== sourceText) {
            this.recordRealtimeCaptionVisibleSource(groupSource);
            this.clearRealtimeCaptionStabilizeTimer();
            if (groupSource === this._captionLastSource) {
                const overlayVisible = this._captionOverlay && !this._captionOverlay.hidden;
                if (overlayVisible && this._captionRenderedSource === groupSource) return;
                if (this._captionInFlight && this._captionInFlightSource === groupSource) return;
            }
            this.clearRealtimeCaptionHideTimer();
            this._captionLastSource = groupSource;
            if (this._captionInFlight) {
                this.enqueueRealtimeCaptionPendingSource(groupSource);
                return;
            }
            await this.translateRealtimeCaptionSource(groupSource, options);
            return;
        }
        const stabilizedCandidate =
            this.buildStabilizedRealtimeCaptionSource(sourceText) || sourceText;
        let requestSourceText = sourceText;
        if (
            !googleCaptionMode &&
            this.shouldStabilizeRealtimeCaptionSource(sourceText, stabilizedCandidate, options)
        ) {
            const stabilized = await this.waitForRealtimeCaptionStability(
                sourceText,
                stabilizedCandidate
            );
            if (!stabilized || !this._captionModeEnabled) return;
            requestSourceText = stabilized;
            this.markRealtimeCaptionMergedReplacementSource(requestSourceText);
        } else {
            this.clearRealtimeCaptionStabilizeTimer();
        }
        if (requestSourceText === this._captionLastSource) {
            const overlayVisible = this._captionOverlay && !this._captionOverlay.hidden;
            if (overlayVisible && this._captionRenderedSource === requestSourceText) return;
            if (this._captionInFlight && this._captionInFlightSource === requestSourceText) return;
        }
        this.clearRealtimeCaptionHideTimer();
        this._captionLastSource = requestSourceText;
        if (this._captionInFlight) {
            this.enqueueRealtimeCaptionPendingSource(requestSourceText);
            return;
        }
        await this.translateRealtimeCaptionSource(requestSourceText, options);
    }

    async translateRealtimeCaptionSource(sourceText, preparedOptions = null) {
        if (!this._captionModeEnabled || !sourceText) return;
        const requestId = ++this._captionLastRequestId;
        let directRequestStarted = false;
        try {
            const options = preparedOptions || (await this.getRealtimeCaptionTranslateOptions());
            const contextRequest = this.getRealtimeCaptionContextRequestForOptions(
                sourceText,
                options
            );
            const requestSourceText = contextRequest.sourceText;
            const cacheKey =
                contextRequest.cacheKey ||
                this.getRealtimeCaptionCacheKey(requestSourceText, options);
            const googleCaptionMode = this.isGoogleRealtimeCaptionTranslator(options);
            const cached = googleCaptionMode
                ? null
                : this.findPrefetchedRealtimeCaptionTranslation(sourceText, options);
            if (cached?.text) {
                const allowExpandedReplacement =
                    this.shouldUseExpandedCaptionReplacement(sourceText);
                if (
                    !this.isRealtimeCaptionRequestStillCurrent(sourceText) &&
                    !this.wasRecentlyVisibleRealtimeCaptionSource(sourceText)
                ) {
                    return;
                }
                if (
                    !this.canDisplayRealtimeCaptionSource(sourceText, {
                        allowOlderReplacement: allowExpandedReplacement,
                    })
                ) {
                    return;
                }
                this.showRealtimeCaptionTranslatedText(cached.text, sourceText, {
                    allowExpandedReplacement,
                    replaceHistory: googleCaptionMode,
                });
                return;
            }
            if (this.shouldBatchRealtimeCaptionTranslation(options)) {
                this.requestRealtimeCaptionFastFallback(sourceText, options);
                const translated = await this.queueRealtimeCaptionBatchTranslation(
                    requestSourceText,
                    options
                );
                const canApplyLateMerge = this.shouldUseExpandedCaptionReplacement(sourceText);
                const canApplyRecentCaption =
                    sourceText === this._captionLastSource ||
                    this.wasRecentlyVisibleRealtimeCaptionSource(sourceText);
                if (
                    !this._captionModeEnabled ||
                    (!canApplyRecentCaption && !canApplyLateMerge) ||
                    (requestId !== this._captionLastRequestId &&
                        !canApplyRecentCaption &&
                        !canApplyLateMerge)
                ) {
                    return;
                }
                if (!translated) return;
                if (
                    !this.canDisplayRealtimeCaptionSource(sourceText, {
                        allowOlderReplacement: canApplyLateMerge,
                    })
                ) {
                    return;
                }
                this.cacheRealtimeCaptionTranslation(cacheKey, translated);
                if (
                    options.fastTranslatorId &&
                    this._captionRenderedSource === sourceText &&
                    !canApplyLateMerge
                ) {
                    return;
                }
                this.showRealtimeCaptionTranslatedText(translated, sourceText, {
                    allowExpandedReplacement: canApplyLateMerge,
                });
                return;
            }
            this._captionInFlight = true;
            this._captionInFlightSource = sourceText;
            directRequestStarted = true;
            this.logRealtimeCaptionDebug("display:fallback-request", {
                mode: "direct",
                chars: requestSourceText.length,
            });
            const request = {
                text: requestSourceText,
                sl: options.sl,
                tl: options.tl,
                translatorId: options.translatorId,
                textRole: "caption",
                translationProfile: "realtimeCaption",
            };
            if (options.engine) request.engine = options.engine;
            const result = await this.channel.request("translate_text_quiet", request);
            const canApplyRecentCaption =
                sourceText === this._captionLastSource ||
                this.wasRecentlyVisibleRealtimeCaptionSource(sourceText);
            if (
                !this._captionModeEnabled ||
                !canApplyRecentCaption ||
                (requestId !== this._captionLastRequestId && !canApplyRecentCaption)
            ) {
                return;
            }
            const translated = String(result?.mainMeaning || result?.translatedText || "").trim();
            if (!translated || result?.translationFailed) return;
            const allowExpandedReplacement = this.shouldUseExpandedCaptionReplacement(sourceText);
            if (
                !this.canDisplayRealtimeCaptionSource(sourceText, {
                    allowOlderReplacement: allowExpandedReplacement,
                })
            ) {
                return;
            }
            this.cacheRealtimeCaptionTranslation(cacheKey, translated);
            this.showRealtimeCaptionTranslatedText(translated, sourceText, {
                allowExpandedReplacement,
                replaceHistory: this.isGoogleRealtimeCaptionTranslator(options),
            });
        } catch {
            if (
                requestId === this._captionLastRequestId &&
                sourceText === this._captionLastSource
            ) {
                this.scheduleRealtimeCaptionOverlayHide();
            }
        } finally {
            if (directRequestStarted) {
                this._captionInFlight = false;
                this._captionInFlightSource = "";
                const pendingSource = this.shiftRealtimeCaptionPendingSource();
                if (
                    this._captionModeEnabled &&
                    pendingSource &&
                    pendingSource !== sourceText &&
                    (pendingSource === this._captionLastSource ||
                        this.wasRecentlyVisibleRealtimeCaptionSource(pendingSource))
                ) {
                    this.translateRealtimeCaptionSource(pendingSource);
                }
            }
        }
    }

    startFullPageBatchTranslation() {
        this._domCoverageStableScanCount = 0;
        this.dispatchAiPageSections({ reason: "initial" });
    }

    scanDomPageForNewTextNodes() {
        if (this.currentTranslator !== "dom") return;
        if (this._domCircuitBreakerActive) return;
        this._domPageRootElements = this.getDomPageTranslationRoots();
        const enqueued = this.dispatchAiPageSections({ reason: "incremental" });
        if (enqueued > 0) this._domCoverageStableScanCount = 0;
        return enqueued;
    }

    scheduleDomPageIncrementalScan(delay = 200) {
        if (this.currentTranslator !== "dom") return;
        if (this._domCircuitBreakerActive) return;
        const now = Date.now();
        if (!this._domIncrementalScanTimer) this._domIncrementalScanFirstScheduledAt = now;
        // Coalesce bursts, but never defer past maxDefer — a page that mutates non-stop
        // (timers, live regions) must not stall translation by perpetually resetting the timer.
        const maxDefer = 600;
        const elapsed = now - (this._domIncrementalScanFirstScheduledAt || now);
        const effectiveDelay = Math.max(0, Math.min(delay, maxDefer - elapsed));
        if (this._domIncrementalScanTimer) clearTimeout(this._domIncrementalScanTimer);
        this._domIncrementalScanTimer = setTimeout(() => {
            this._domIncrementalScanTimer = null;
            this._domIncrementalScanFirstScheduledAt = 0;
            this.scanDomPageForNewTextNodes();
        }, effectiveDelay);
    }

    scheduleDomPageCoverageScan() {
        if (this.currentTranslator !== "dom") return;
        if (this._domCircuitBreakerActive) return;
        if (this._domCoverageScanTimer) return;
        if (this._domCoverageScanCount >= 5) return;
        if (this.isDomPageTranslationComplete() && this._domCoverageStableScanCount >= 1) return;
        this._domCoverageScanTimer = setTimeout(() => {
            this._domCoverageScanTimer = null;
            if (this.currentTranslator !== "dom") return;
            if (this._domCircuitBreakerActive) return;
            if (this._domTranslationQueue?.length || this._domActiveTranslations > 0) return;
            if (this.isDomPageTranslationComplete() && this._domCoverageStableScanCount >= 1) {
                return;
            }
            this._domCoverageScanCount += 1;
            const enqueued = this.dispatchAiPageSections({ reason: "coverage" });
            if (enqueued > 0) {
                this._domCoverageStableScanCount = 0;
            } else if (this.isDomPageTranslationComplete()) {
                this._domCoverageStableScanCount += 1;
            }
        }, 150);
    }

    isDomPageTranslationComplete() {
        return (
            this._domTotalTranslationEntries > 0 &&
            this._domCompletedTranslationEntries >= this._domTotalTranslationEntries
        );
    }

    noteDomPageOwnMutation(durationMs = 900) {
        const until = Date.now() + durationMs;
        this._domOwnMutationSuppressUntil = Math.max(this._domOwnMutationSuppressUntil || 0, until);
    }

    isDomPageOwnMutationSuppressed() {
        return Date.now() < (this._domOwnMutationSuppressUntil || 0);
    }

    isDomPageExtensionNode(node) {
        let element = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        while (element && element !== document.documentElement) {
            const id = String(element.id || "");
            const className =
                typeof element.className === "string"
                    ? element.className
                    : element.getAttribute && element.getAttribute("class");
            if (id.startsWith("edge-translate-") || id.startsWith("edge_translate_")) {
                return true;
            }
            if (/\b(?:edge-translate-|et-dom-)/.test(String(className || ""))) {
                return true;
            }
            element = element.parentElement;
        }
        return false;
    }

    isDomPageMutationTextCandidate(node, { allowTranslatedSection = false } = {}) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        if (this.isDomPageExtensionNode(node)) return false;
        const parent = node.parentElement;
        if (!allowTranslatedSection && this.isElementMarkedAsTranslatedAiSection(parent)) {
            return false;
        }
        if (!this.isMeaningfulDomPageTextNode(node)) return false;
        const targetLang = this._domPageTranslateOptions?.tl || "";
        if (this.isDomPageTextAlreadyInTargetLanguage(node.nodeValue, targetLang)) return false;
        return true;
    }

    findDomPageMutationCandidate(node, { ownSuppressed = false } = {}) {
        const empty = { found: false, marked: false };
        if (!node || this.isDomPageExtensionNode(node)) return empty;

        if (node.nodeType === Node.TEXT_NODE) {
            const marked = this.isElementMarkedAsTranslatedAiSection(node.parentElement);
            if (marked && ownSuppressed) return empty;
            if (this.isDomPageMutationTextCandidate(node, { allowTranslatedSection: marked })) {
                return { found: true, marked };
            }
            return empty;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return empty;
        if (this.isElementMarkedAsTranslatedAiSection(node) && ownSuppressed) return empty;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
            const marked = this.isElementMarkedAsTranslatedAiSection(textNode.parentElement);
            if (marked && ownSuppressed) continue;
            if (this.isDomPageMutationTextCandidate(textNode, { allowTranslatedSection: marked })) {
                return { found: true, marked };
            }
        }
        return empty;
    }

    domPageMutationHasTranslatableCandidate(mutation) {
        if (!mutation || this.isDomPageExtensionNode(mutation.target)) return false;
        const ownSuppressed = this.isDomPageOwnMutationSuppressed();

        if (mutation.type === "characterData") {
            const candidate = this.findDomPageMutationCandidate(mutation.target, {
                ownSuppressed,
            });
            if (candidate.found && candidate.marked) {
                this.releaseAiPageSectionElement(mutation.target);
            }
            return candidate.found;
        }

        if (mutation.type !== "childList") return false;
        for (const node of Array.from(mutation.addedNodes || [])) {
            const candidate = this.findDomPageMutationCandidate(node, { ownSuppressed });
            if (!candidate.found) continue;
            if (candidate.marked) this.releaseAiPageSectionElement(mutation.target);
            return true;
        }
        return false;
    }

    isNodeInDomPageTranslationRoot(node) {
        if (!this._domPageRootElements || !this._domPageRootElements.length) return true;
        return this._domPageRootElements.some((root) => root && root.contains(node));
    }

    isDomPageWidgetTextNode(node) {
        let element = node && node.parentElement;
        while (element && element !== document.documentElement) {
            const className =
                typeof element.className === "string"
                    ? element.className
                    : element.getAttribute && element.getAttribute("class");
            const signature = [
                element.id || "",
                className || "",
                element.getAttribute && element.getAttribute("role"),
                element.getAttribute && element.getAttribute("aria-label"),
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            const normalized = signature.replace(/[_\s]+/g, "-");
            if (
                /(^|-)newsletter($|-)/.test(normalized) ||
                /(^|-)quill($|-)/.test(normalized) ||
                /(^|-)login($|-)/.test(normalized) ||
                /(^|-)follow($|-)/.test(normalized) ||
                /(^|-)(popup|modal)($|-)/.test(normalized) ||
                /(^|-)(ads?|advert|advertisement|sponsor|promo|promotion)($|-)/.test(normalized)
            ) {
                return true;
            }
            element = element.parentElement;
        }
        return false;
    }

    // Text inside standard non-content ARIA landmarks (global nav, banner, footer, search)
    // is repetitive site chrome — skip it so we don't spend tokens re-translating menus and
    // footers on every page.
    isDomPageChromeTextNode(node) {
        const el = node && node.parentElement;
        if (!el || !el.closest) return false;
        return Boolean(
            el.closest(
                "nav,footer,[role='navigation'],[role='banner'],[role='contentinfo'],[role='search']"
            )
        );
    }

    // Non-linguistic text never needs translation: pure numbers/symbols, and single tokens
    // that are plainly identifiers — URLs, file names, paths, hex hashes, version strings.
    // Common on code-host UIs (file lists, commit hashes, counts) and pure waste to send.
    isLowValueDomPageText(text) {
        const value = String(text || "").trim();
        if (!value) return true;
        // No word-forming letter at all → numbers, dates-as-digits, prices, symbols, hashes.
        if (!/\p{L}/u.test(value)) return true;
        // A single whitespace-free token that looks like code, not prose.
        if (!/\s/.test(value)) {
            if (/^(?:https?:\/\/|www\.|mailto:)/i.test(value)) return true; // url
            if (/^[\w-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(value)) return true; // domain / domain/path
            if (/^[\w.-]+\.[a-z0-9]{1,8}$/i.test(value) && /[._-]/.test(value)) return true; // file.ext
            if (/^[0-9a-f]{7,40}$/i.test(value)) return true; // hex hash
            if (/^@?[\w-]+(?:\/[\w.-]+)+$/.test(value)) return true; // path / org/repo / @scope/pkg
            if (/^v?\d+(?:\.\d+){1,}(?:[-+][\w.]+)?$/i.test(value)) return true; // version
        }
        return false;
    }

    isMeaningfulDomPageTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        if (!this.isNodeInDomPageTranslationRoot(node)) return false;
        const text = String(node.nodeValue || "").trim();
        if (text.length < 2) return false;
        const p = node.parentElement;
        if (!p) return false;
        if (this.isDomPageWidgetTextNode(node)) return false;
        if (this.isLowValueDomPageText(text)) return false;
        if (this.isDomPageChromeTextNode(node)) return false;
        const tn = p.tagName;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION)$/i.test(tn)) return false;
        let ancestor = p;
        while (ancestor && ancestor !== document.documentElement) {
            if (this._translatedBlocks.has(ancestor)) return false;
            if (ancestor.classList && ancestor.classList.contains("et-dom-translated-text")) {
                return false;
            }
            ancestor = ancestor.parentElement;
        }
        if (this._translatedSet.has(node)) return false;
        if (this._domPendingTextNodes.has(node)) return false;
        if (this._domFailedTextNodes.has(node)) return false;
        return true;
    }
    collectDomPageTextNodes(roots) {
        const nodes = [];
        const targetLang = this._domPageTranslateOptions?.tl || "";
        for (const root of roots || []) {
            if (!root) continue;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (!this.isMeaningfulDomPageTextNode(node)) continue;
                if (this.isDomPageTextAlreadyInTargetLanguage(node.nodeValue, targetLang)) continue;
                nodes.push(node);
            }
        }
        return nodes;
    }

    enqueueDomPageTextTreeForMutation(node, enqueue) {
        if (!node) return;
        const targetLang = this._domPageTranslateOptions?.tl || "";
        if (node.nodeType === Node.TEXT_NODE) {
            if (!this.isMeaningfulDomPageTextNode(node)) return;
            if (this.isDomPageTextAlreadyInTargetLanguage(node.nodeValue, targetLang)) return;
            enqueue(node);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
            if (!this.isMeaningfulDomPageTextNode(textNode)) continue;
            if (this.isDomPageTextAlreadyInTargetLanguage(textNode.nodeValue, targetLang)) continue;
            enqueue(textNode);
        }
    }

    /**
     * Returns true when text is already mostly in the target language and can be skipped.
     * Uses two cached regexes and two .match() calls — no per-character loop.
     * Latin-script targets are not detected (English shares the alphabet with many others).
     */
    isDomPageTextAlreadyInTargetLanguage(text, targetLang) {
        const value = String(text || "");
        if (value.length < 4) return false;
        const lang = String(targetLang || "")
            .toLowerCase()
            .split(/[-_]/)[0];
        const pattern = BannerController._targetLangPatterns?.[lang];
        if (!pattern) return false;
        const letters = value.match(pattern.letter);
        if (!letters || letters.length < 4) return false;
        const targets = value.match(pattern.target);
        if (!targets) return false;
        return targets.length / letters.length >= 0.8;
    }

    async ensureOnDeviceBridge() {
        if (this._onDeviceBridgePromise) return this._onDeviceBridgePromise;

        this._onDeviceBridgePromise = this.injectOnDeviceBridgeViaBackground().catch(() =>
            this.injectOnDeviceBridgeViaScriptTag()
        );

        return this._onDeviceBridgePromise;
    }

    async injectOnDeviceBridgeViaBackground() {
        if (!this.channel || typeof this.channel.request !== "function") {
            throw new Error("Extension background bridge injector is unavailable.");
        }
        await this.channel.request("inject_on_device_bridge");
    }

    injectOnDeviceBridgeViaScriptTag() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                window.removeEventListener("message", readyHandler);
                reject(new Error("Chrome on-device translation bridge did not become ready."));
            }, 3000);

            const readyHandler = (event) => {
                if (event.source !== window || !event.data) return;
                if (event.data.type !== "edge_translate_on_device_bridge_ready") return;
                clearTimeout(timeout);
                window.removeEventListener("message", readyHandler);
                resolve();
            };

            window.addEventListener("message", readyHandler);

            const existing = document.getElementById("edge-translate-on-device-bridge");
            if (existing) existing.remove();

            const script = document.createElement("script");
            script.id = "edge-translate-on-device-bridge";
            script.src = chrome.runtime.getURL("chrome_builtin/on_device_bridge.js");
            script.async = false;
            script.onerror = () => {
                clearTimeout(timeout);
                window.removeEventListener("message", readyHandler);
                reject(new Error("Failed to inject Chrome on-device translation bridge."));
            };
            (document.documentElement || document.head || document.body).appendChild(script);
        });
    }

    requestOnDeviceBridge(detail) {
        return new Promise((resolve, reject) => {
            const requestId = `et-${Date.now()}-${++this._onDeviceBridgeRequestId}`;
            const timeout = setTimeout(() => {
                this._onDeviceBridgePending.delete(requestId);
                reject(new Error("Chrome on-device translation bridge request timed out."));
            }, 60000);

            this._onDeviceBridgePending.set(requestId, { resolve, reject, timeout });
            window.postMessage(
                {
                    type: "edge_translate_on_device_request",
                    requestId,
                    detail,
                },
                "*"
            );
        });
    }

    handleOnDeviceBridgeResponse(event) {
        if (event.source !== window || !event.data) return;
        if (event.data.type === "edge_translate_on_device_stream") {
            const pending = this._onDeviceBridgePending.get(event.data.requestId);
            if (!pending) return;
            if (event.data.streamId) {
                this.channel.emit("chrome_prompt_stream", {
                    streamId: event.data.streamId,
                    result: event.data.result,
                });
            }
            return;
        }
        if (event.data.type !== "edge_translate_on_device_response") return;

        const pending = this._onDeviceBridgePending.get(event.data.requestId);
        if (!pending) return;
        this._onDeviceBridgePending.delete(event.data.requestId);
        clearTimeout(pending.timeout);

        if (event.data.error) {
            pending.reject(
                new Error(event.data.error.message || "Chrome on-device translation failed.")
            );
        } else {
            pending.resolve(event.data.result);
        }
    }

    async translateWithOnDeviceEngine(text, from, to, streamId, draftTranslation, fastPostEdit) {
        try {
            await this.ensureOnDeviceBridge();
            return await this.requestOnDeviceBridge({
                text,
                sl: from,
                tl: to,
                engine: "chromeBuiltin",
                streamId,
                draftTranslation,
                fastPostEdit,
            });
        } catch (bridgeError) {
            try {
                return await translateWithChromeOnDevice(text, from, to, {
                    draftTranslation,
                    fastPostEdit,
                });
            } catch (contentError) {
                throw bridgeError || contentError;
            }
        }
    }

    async translateWithDomPageEngine(text, from, to, streamId = "") {
        const payload = {
            text,
            sl: from,
            tl: to,
            translatorId: "LocalTranslate",
            engine: this._domPageTranslateOptions.engine,
            translationProfile: "page",
        };
        if (streamId) payload.streamId = streamId;
        return await this.channel.request("translate_text_quiet", payload);
    }

    isAiDomPageEngine(engine = this._domPageTranslateOptions?.engine) {
        return engine === "googleAiStudio" || engine === "openai" || engine === "openaiCompatible";
    }

    getDomPageTranslationGroupOptions() {
        // Cap groups at the per-engine batch ceiling so context-translation requests fit a single round-trip
        // (and, for openaiCompatible, fit a single local LLM slot).
        const engine = this._domPageTranslateOptions.engine;
        if (engine === "openaiCompatible") return { maxChars: 2400 };
        return { maxChars: 12000 };
    }

    getDomPageBatchOptions() {
        const engine = this._domPageTranslateOptions.engine;
        const failures = this._domBatchFailureCount;
        // Speed-first sizing. Larger batches let one LLM call cover many entries, slashing
        // per-request overhead (TLS, queueing, prompt prefill). Combined with high
        // concurrency below, the page-translate banner reaches "everything translated"
        // significantly faster than the conservative split-by-tens approach.
        if (engine === "openaiCompatible") {
            // Local LLM: still slot-constrained (~4k n_ctx per --parallel slot). Push
            // batches and concurrency to the slot limit but stop there.
            if (failures >= 3) return { maxChars: 500, maxItems: 1 };
            if (failures >= 2) return { maxChars: 1000, maxItems: 4 };
            if (failures >= 1) return { maxChars: 1600, maxItems: 8 };
            return { maxChars: 2400, maxItems: 16 };
        }
        // Cloud providers (googleAiStudio, openai, default): a single request can carry
        // 64 entries / 12000 chars without trouble. The first batch fills immediately and
        // streaming surfaces translations to the DOM as they arrive within that one call.
        if (failures >= 3) return { maxChars: 1800, maxItems: 1 };
        if (failures >= 2) return { maxChars: 4000, maxItems: 6 };
        if (failures >= 1) return { maxChars: 7000, maxItems: 32 };
        return { maxChars: 12000, maxItems: 64 };
    }

    /**
     * Speed-first: there is no separate lead batch. The first batch IS the full-size
     * batch, and streaming surfaces translations to the DOM as they arrive within that
     * call. A tiny lead batch would just add a serial round-trip before the real work
     * starts, which is exactly the opposite of what we want.
     */
    getDomPageLeadBatchOptions() {
        return null;
    }

    /**
     * Sort entries in-place so viewport-visible content translates first. Cheap: a single
     * batched layout read (the browser coalesces consecutive getBoundingClientRect calls).
     * No-op for short pages where the overhead would outweigh the win.
     *
     * Tiers: 0=visible, 1=just-below, 2=above, 3=far. Document order preserved within a tier.
     */
    prioritizeDomPageEntriesByViewport(entries) {
        // Articles with 8+ blocks already benefit from viewport prioritization — the visible
        // window typically holds 3-6 blocks, so sorting them first cuts time-to-first-paint by
        // ~30% on medium articles. A single batched layout read (getBoundingClientRect calls
        // are coalesced by the browser) is cheap enough that we don't need a higher threshold.
        if (!entries || entries.length < 8) return;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
        const tiers = new Int8Array(entries.length);
        for (let i = 0; i < entries.length; i++) {
            const el = entries[i]?.group?.nodes?.[0]?.parentElement;
            if (!el || typeof el.getBoundingClientRect !== "function") {
                tiers[i] = 4;
                continue;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                tiers[i] = 4;
            } else if (rect.bottom > 0 && rect.top < viewportHeight) {
                tiers[i] = 0;
            } else if (rect.top >= viewportHeight && rect.top < viewportHeight * 2) {
                tiers[i] = 1;
            } else if (rect.bottom <= 0 && rect.bottom >= -viewportHeight) {
                tiers[i] = 2;
            } else {
                tiers[i] = 3;
            }
        }
        // Stable sort by tier (preserve document order within a tier).
        const indices = entries.map((_, i) => i);
        indices.sort((a, b) => tiers[a] - tiers[b] || a - b);
        const sorted = indices.map((i) => entries[i]);
        for (let i = 0; i < entries.length; i++) entries[i] = sorted[i];
    }

    getDomPageMaxConcurrentTranslations() {
        const engine = this._domPageTranslateOptions.engine;
        const failures = this._domBatchFailureCount;
        let base;
        // openaiCompatible is hard-capped by the local server's `--parallel` slot count
        // (typically 8). Going beyond that just queues at the server.
        if (engine === "openaiCompatible") {
            if (failures >= 3) base = 2;
            else if (failures >= 2) base = 4;
            else if (failures >= 1) base = 6;
            else base = 8;
        } else if (engine === "googleAiStudio") {
            // Gemini AI Studio has effectively per-request limits that scale with the
            // model; 2.5-flash-lite easily handles 32 simultaneous connections from one
            // origin. Push hard on the first attempt; back off only after real failures.
            if (failures >= 3) base = 6;
            else if (failures >= 2) base = 8;
            else if (failures >= 1) base = 12;
            else base = 32;
        } else if (engine === "openai") {
            // OpenAI tiers vary; 16 is the conservative speed-first ceiling that paid
            // accounts handle without 429s, with the same back-off curve as googleAiStudio.
            if (failures >= 3) base = 6;
            else if (failures >= 2) base = 8;
            else if (failures >= 1) base = 12;
            else base = 16;
        } else if (failures >= 3) {
            // Default / unknown engine: mirror openai.
            base = 6;
        } else if (failures >= 2) {
            base = 8;
        } else if (failures >= 1) {
            base = 12;
        } else {
            base = 16;
        }
        const dynamic = Number.isFinite(this._aiPageDynamicMaxConcurrentTranslations)
            ? this._aiPageDynamicMaxConcurrentTranslations
            : base;
        return Math.max(1, Math.min(base, dynamic));
    }

    recordDomPageBatchFailure() {
        this._domBatchFailureCount += 1;
        this._domMaxConcurrentTranslations = this.getDomPageMaxConcurrentTranslations();
        if (this._domBatchFailureCount >= 5) {
            this.triggerDomPageCircuitBreaker();
        }
    }

    recordDomPageBatchSuccess() {
        if (this._domBatchFailureCount > 0) this._domBatchFailureCount -= 1;
        this._domMaxConcurrentTranslations = this.getDomPageMaxConcurrentTranslations();
    }

    resetAiPageSectionBatchTuning() {
        this._aiPageSectionBatchScale = 1;
        this._aiPageSectionBatchSuccessStreak = 0;
        this._aiPageSectionBatchFailureStreak = 0;
        this._aiPageSectionBatchLatencyEmaMs = 0;
        this._aiPageConcurrencySuccessStreak = 0;
        this._aiPageConcurrencyLatencyEmaMs = 0;
        this._aiPageConcurrencyQueueWaitEmaMs = 0;
        this._aiPageDynamicMaxConcurrentTranslations = this.getAiPageConcurrencyLimits().initial;
        this._domMaxConcurrentTranslations = this.getDomPageMaxConcurrentTranslations();
    }

    getAiPageConcurrencyLimits() {
        const engine = this._domPageTranslateOptions.engine;
        if (engine === "openaiCompatible") {
            return { min: 2, initial: 8, max: 8, growAfter: 2, fastMs: 3800, slowMs: 12000 };
        }
        if (engine === "googleAiStudio") {
            return { min: 6, initial: 32, max: 32, growAfter: 2, fastMs: 2400, slowMs: 9000 };
        }
        if (engine === "openai") {
            return { min: 4, initial: 16, max: 16, growAfter: 2, fastMs: 3200, slowMs: 11000 };
        }
        return { min: 4, initial: 16, max: 16, growAfter: 2, fastMs: 3200, slowMs: 11000 };
    }

    setAiPageDynamicConcurrency(value) {
        const { min, max } = this.getAiPageConcurrencyLimits();
        const next = Math.min(max, Math.max(min, Math.round(value)));
        this._aiPageDynamicMaxConcurrentTranslations = next;
        this._domMaxConcurrentTranslations = this.getDomPageMaxConcurrentTranslations();
    }

    recordAiPageConcurrencyTelemetry({
        failed = false,
        durationMs = 0,
        queueWaitMs = 0,
        entries = 0,
    } = {}) {
        const { growAfter, fastMs, slowMs } = this.getAiPageConcurrencyLimits();
        const current = Number.isFinite(this._aiPageDynamicMaxConcurrentTranslations)
            ? this._aiPageDynamicMaxConcurrentTranslations
            : this.getAiPageConcurrencyLimits().initial;
        const measuredDuration = Number(durationMs) || 0;
        const hasQueueWaitSample = Number.isFinite(Number(queueWaitMs));
        const measuredWait = hasQueueWaitSample ? Math.max(0, Number(queueWaitMs)) : 0;

        if (measuredDuration > 0) {
            this._aiPageConcurrencyLatencyEmaMs = this._aiPageConcurrencyLatencyEmaMs
                ? this._aiPageConcurrencyLatencyEmaMs * 0.7 + measuredDuration * 0.3
                : measuredDuration;
        }
        if (hasQueueWaitSample) {
            this._aiPageConcurrencyQueueWaitEmaMs = this._aiPageConcurrencyQueueWaitEmaMs
                ? this._aiPageConcurrencyQueueWaitEmaMs * 0.7 + measuredWait * 0.3
                : measuredWait;
        }

        if (failed) {
            this._aiPageConcurrencySuccessStreak = 0;
            this.setAiPageDynamicConcurrency(Math.max(current - 2, current * 0.75));
            return;
        }

        // Only a backed-up LOCAL queue means we have too many requests in flight. A single
        // request just being slow is expected for big bundled batches and must NOT throttle
        // parallelism — doing so serialized the big requests and killed completion speed.
        // (Real server overload still backs off via the `failed` branch on 429/5xx above.)
        const queueIsBackingUp =
            this._domTranslationQueue?.length > 0 &&
            this._aiPageConcurrencyQueueWaitEmaMs > Math.max(1200, slowMs * 0.5);
        if (queueIsBackingUp) {
            this._aiPageConcurrencySuccessStreak = 0;
            this.setAiPageDynamicConcurrency(current - 1);
            return;
        }

        if (measuredDuration > 0 && measuredDuration <= fastMs && entries > 0) {
            this._aiPageConcurrencySuccessStreak += 1;
            if (this._aiPageConcurrencySuccessStreak >= growAfter) {
                this._aiPageConcurrencySuccessStreak = 0;
                this.setAiPageDynamicConcurrency(current + 1);
            }
        }
    }

    getAiPageSectionBatchScaleLimits() {
        const engine = this._domPageTranslateOptions.engine;
        if (engine === "openaiCompatible") {
            return {
                min: 0.5,
                max: 1.35,
                growAfter: 2,
                fastMs: 4200,
                slowMs: 14000,
            };
        }
        return {
            min: 0.6,
            max: 1.6,
            growAfter: 2,
            fastMs: 2800,
            slowMs: 10000,
        };
    }

    getAiPageSectionBatchScale() {
        const { min, max } = this.getAiPageSectionBatchScaleLimits();
        const scale = Number.isFinite(this._aiPageSectionBatchScale)
            ? this._aiPageSectionBatchScale
            : 1;
        return Math.min(max, Math.max(min, scale));
    }

    setAiPageSectionBatchScale(scale) {
        const { min, max } = this.getAiPageSectionBatchScaleLimits();
        this._aiPageSectionBatchScale = Math.min(max, Math.max(min, scale));
    }

    scaleAiPageSectionBatchOptions(options) {
        const scale = this.getAiPageSectionBatchScale();
        if (scale === 1) return options;
        return {
            maxChars: Math.max(1, Math.round(options.maxChars * scale)),
            maxInputTokens: Math.max(1, Math.round(options.maxInputTokens * scale)),
            maxOutputTokens: Math.max(1, Math.round(options.maxOutputTokens * scale)),
            maxItems:
                scale > 1
                    ? Math.max(1, Math.ceil(options.maxItems * Math.min(scale, 1.25)))
                    : Math.max(1, Math.floor(options.maxItems * scale)),
        };
    }

    recordAiPageSectionBatchTelemetry({
        failed = false,
        durationMs = 0,
        inputTokens = 0,
        queueWaitMs = 0,
        entries = 0,
    } = {}) {
        const { growAfter, fastMs, slowMs } = this.getAiPageSectionBatchScaleLimits();
        const currentScale = this.getAiPageSectionBatchScale();
        this.recordAiPageConcurrencyTelemetry({
            failed,
            durationMs,
            queueWaitMs,
            entries,
        });

        if (failed) {
            this._aiPageSectionBatchFailureStreak += 1;
            this._aiPageSectionBatchSuccessStreak = 0;
            const shrink = this._aiPageSectionBatchFailureStreak >= 2 ? 0.65 : 0.8;
            this.setAiPageSectionBatchScale(currentScale * shrink);
            return;
        }

        this._aiPageSectionBatchFailureStreak = 0;
        this._aiPageSectionBatchSuccessStreak += 1;

        const measuredDuration = Number(durationMs) || 0;
        if (measuredDuration > 0) {
            this._aiPageSectionBatchLatencyEmaMs = this._aiPageSectionBatchLatencyEmaMs
                ? this._aiPageSectionBatchLatencyEmaMs * 0.7 + measuredDuration * 0.3
                : measuredDuration;
        }

        if (measuredDuration >= slowMs) {
            this._aiPageSectionBatchSuccessStreak = 0;
            this.setAiPageSectionBatchScale(currentScale * 0.86);
            return;
        }

        if (
            measuredDuration > 0 &&
            measuredDuration <= fastMs &&
            entries > 0 &&
            inputTokens > 0 &&
            this._aiPageSectionBatchSuccessStreak >= growAfter
        ) {
            this._aiPageSectionBatchSuccessStreak = 0;
            this.setAiPageSectionBatchScale(currentScale * 1.12);
        }
    }

    /**
     * Circuit breaker: pause translation for 15s when too many consecutive failures.
     * Prevents burning API tokens on persistent errors (e.g., invalid key, rate limit).
     */
    triggerDomPageCircuitBreaker() {
        if (this._domCircuitBreakerActive) return;
        this._domCircuitBreakerActive = true;
        this.updateDomPageBannerStatus("error");
        setTimeout(() => {
            this._domCircuitBreakerActive = false;
            this._domBatchFailureCount = 0;
            this.updateDomPageBannerStatus();
            this.flushDomTranslationQueue();
            this.scheduleDomPageCoverageScan();
        }, 15000);
    }

    shouldUseDomPageRoleSegment() {
        return true;
    }

    buildDomPageRoleSegmentText(entry) {
        if (!this.shouldUseDomPageRoleSegment()) return entry.sourceText;
        return buildSegmentedTranslationText([entry]);
    }

    unwrapDomPageRoleSegmentText(translated, entryCount = 1) {
        if (!this.shouldUseDomPageRoleSegment()) return translated;
        const parts = splitSegmentedTranslationText(translated, entryCount);
        return parts && parts.length === entryCount ? parts[0] : translated;
    }

    /**
     * Strip known prompt echo / instruction leakage from a translated string.
     * Local LLMs (e.g. llama.cpp, Ollama) sometimes echo parts of the system
     * or user prompt in their output. This helper removes those fragments so
     * they don't trigger the suspicious-translation filter.
     */
    stripPromptEchoFromTranslation(text) {
        if (!text) return "";
        // Only strip prompt echo from the LEADING block of the output. Models that echo the
        // instruction header always do so at the start; matching mid-output is dangerous
        // because legitimate translations of English-source content can naturally begin
        // a line with words like "Translate", "Preserve", or "Source" without being echoes.
        // We also require an exact instruction phrase (not the bare word "Translate") so
        // a translation that happens to start with "Translate the article" is safe.
        // Allow blank lines between echoes (some models pad echoes with extra newlines).
        const leadingEcho =
            /^\s*(?:Source language|Target language|Translate the user'?s text|Translate faithfully|Output only the translation|Use the target language'?s writing system|Preserve proper nouns and official names|Keep link markers|Keep markers\.?|Translate [A-Za-z-]+ ->|[A-Za-z][A-Za-z -]*>[A-Za-z][A-Za-z -]*)[^\n]*\n?/i;
        const leadingLanguageLabel = /^\s*[A-Z][a-z]+:\s*\n/;
        let str = String(text);
        // Cap iterations so a pathological input can't loop. Real echoes are 1-4 lines.
        for (let i = 0; i < 8; i += 1) {
            if (leadingEcho.test(str)) {
                str = str.replace(leadingEcho, "");
                continue;
            }
            if (leadingLanguageLabel.test(str)) {
                str = str.replace(leadingLanguageLabel, "");
                continue;
            }
            break;
        }
        return str.replace(/\n{3,}/g, "\n\n").trim();
    }

    isSuspiciousDomPageTranslation(sourceText, translatedText) {
        const source = String(sourceText || "").trim();
        const translated = this.stripPromptEchoFromTranslation(translatedText);
        if (!translated) return true;

        const sourceHasSubtitleCue = /\d{1,4}\s*\r?\n?\s*\d{2}:\d{2}:\d{2}[,.]?\d{3}\s*-->/i.test(
            source
        );
        const translatedHasSubtitleCue =
            /\d{1,4}\s*\r?\n?\s*\d{2}:\d{2}:\d{2}[,.]?\d{3}\s*-->/i.test(translated);
        if (!sourceHasSubtitleCue && translatedHasSubtitleCue) return true;

        if (/<<<EDGE_TRANSLATE_SEGMENT_/i.test(translated)) {
            return true;
        }

        if (
            !/테스트|test/i.test(source) &&
            /이것은 테스트입니다|번역이 자연스럽게 이루어지는지 확인/i.test(translated)
        ) {
            return true;
        }

        if (source.length > 0 && translated.length > Math.max(500, source.length * 8)) {
            return true;
        }

        const sourceTokens = new Set(
            (source.match(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g) || []).map((t) => t.toLowerCase())
        );
        const translatedTokens = (translated.match(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g) || []).map((t) =>
            t.toLowerCase()
        );
        const foreignTokens = translatedTokens.filter((token) => !sourceTokens.has(token));

        // Relax the foreign-token threshold for OpenAI-compatible (local) engines.
        // Small local models inject more English fragments than cloud APIs.
        const isLocalEngine =
            this._domPageTranslateOptions &&
            this._domPageTranslateOptions.engine === "openaiCompatible";
        const foreignThreshold = isLocalEngine ? 8 : 4;
        const foreignMargin = isLocalEngine ? 5 : 2;
        if (
            foreignTokens.length >= foreignThreshold &&
            foreignTokens.length > sourceTokens.size + foreignMargin
        ) {
            return true;
        }

        return false;
    }

    canUseDomPageTranslation(sourceText, translatedText) {
        return !this.isSuspiciousDomPageTranslation(sourceText, translatedText);
    }

    resetDomPageRuntimeState() {
        this._domTranslationSessionId += 1;
        this._translatedSet = new WeakSet();
        this._translatedBlocks = new WeakSet();
        this._domPendingTextNodes = new WeakSet();
        this._domFailedTextNodes = new WeakSet();
        this._domOriginalTextByElement = new WeakMap();
        this._domDuplicateEntries = new Map();
        this._domPendingApplies = new Map();
        this._domNextApplySequence = 0;
        this._domNextApplyToFlush = 0;
        this._aiSectionLeadDispatched = false;
        this._aiSectionFirstDispatchHooksRan = false;
        this._aiSectionPersistentUrlHash = "";
        this.resetAiPageSectionBatchTuning();
        if (this._domIncrementalScanTimer) {
            clearTimeout(this._domIncrementalScanTimer);
            this._domIncrementalScanTimer = null;
        }
        if (this._domCoverageScanTimer) {
            clearTimeout(this._domCoverageScanTimer);
            this._domCoverageScanTimer = null;
        }
        this._domCoverageStableScanCount = 0;
        this._domOwnMutationSuppressUntil = 0;
        this._pendingNodes.clear();
        if (this._scheduleBatch) {
            cancelAnimationFrame(this._scheduleBatch);
            this._scheduleBatch = null;
        }
    }

    /**
     * Build a translation entry for a group, following Google Page Translate's strategy:
     * walk the block's DOM, wrap each text node in a <t i="N"> tag, and send the HTML to the
     * model. The model translates only the text inside each <t> tag and preserves all
     * surrounding HTML structure (bolds, links, italics, etc.). On reply we parse the HTML
     * back and apply each translated text to its original text node — keeping the entire
     * inline structure of the original DOM intact.
     *
     * For blocks containing functional non-text inline content we cannot rebuild (images,
     * iframes, code, form controls), we degrade to per-text-node group translation.
     */
    /**
     * AI-engine page translation dispatcher. Collects semantic sections from the page roots,
     * skips ones already translated this session, dedupes by cacheKey, and enqueues one
     * translation per section. No markers, no batching — each section is its own request.
     */
    dispatchAiPageSections({ reason = "scan" } = {}) {
        if (!this._aiSectionTranslatedChildren) {
            this._aiSectionTranslatedChildren = new WeakSet();
        }
        // Side-effects we want on the very first dispatch of a translation session:
        //   - DNS prefetch + TCP preconnect for the AI engine's host so the TLS
        //     handshake overlaps with our section collection (~100-200ms saved).
        //   - Inject the content-visibility stylesheet so translated regions get
        //     off-screen layout skipping for free.
        //   - Prefetch the persistent IDB cache for this URL so repeat visits paint
        //     instantly from cached translations.
        if (!this._aiSectionFirstDispatchHooksRan) {
            this._aiSectionFirstDispatchHooksRan = true;
            const engine = this._domPageTranslateOptions && this._domPageTranslateOptions.engine;
            injectDnsPrefetchForEngine(engine);
            this.prefetchPersistentTranslationCache();
        }
        let sections = collectHtmlPageSections(this._domPageRootElements, {
            maxChars: this.getAiPageSectionMaxChars(),
            minChars: this.getAiPageSectionMinChars(),
            isEligibleElement: (element) => this.isAiPageSectionElementEligible(element),
            recurseNestedContainers: true,
        });
        if (!sections.length) return 0;

        // Lead-chunk fast path: on the very first dispatch of a translation session, split
        // the first section's children into a small prefix (~1-2k chars) so it completes
        // in ~0.5-1s and the user sees a translated paragraph almost immediately, while
        // the remaining full-size sections stream in the background.
        if (!this._aiSectionLeadDispatched) {
            this._aiSectionLeadDispatched = true;
            const leadChars = this.getAiPageSectionLeadChars();
            const split = this.splitSectionLeadChunk(sections[0], leadChars);
            if (split) sections = [split.lead, split.remainder, ...sections.slice(1)];
        }

        const { tl } = this._domPageTranslateOptions;
        const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
        const model = this._domPageTranslateOptions.model || "";
        const enqueued = [];
        for (const section of sections) {
            // Skip sections whose children are all already translated.
            const untranslatedChildren = section.children.filter((c) =>
                this.isAiPageSectionElementEligible(c)
            );
            if (!untranslatedChildren.length) continue;
            const effectiveSection = {
                parent: section.parent,
                children: untranslatedChildren,
                plainText: untranslatedChildren
                    .map((c) =>
                        String(c.textContent || "")
                            .replace(/\s+/g, " ")
                            .trim()
                    )
                    .filter(Boolean)
                    .join(" "),
                role: section.role,
            };
            if (!effectiveSection.plainText) continue;
            // Same-language fast path: cheap script-based heuristic that detects pages
            // already in the target language (e.g. user hit Translate on a Korean page
            // with KO target). Skip the API call entirely and just mark children as
            // "translated" so the rescan loop doesn't keep flagging them.
            if (isAlreadyInTargetLanguage(effectiveSection.plainText, tl)) {
                for (const child of untranslatedChildren) {
                    this._aiSectionTranslatedChildren.add(child);
                    markElementTranslatedForRendering(child);
                }
                continue;
            }
            // Google-style payload: flatten the section to its leaf blocks and send each as
            // a plain-text [[n]] segment (text + attribute-free inline tags only — no
            // structural HTML). The model never sees or regenerates a single layout tag, so
            // the payload is small, generation is fast, and the reply can't break the page.
            const segBlocks = [];
            const segTexts = [];
            let cachedApplied = 0;
            for (const child of untranslatedChildren) {
                for (const leaf of findLeafBlocksInElement(child)) {
                    // Per-leaf gate: drop leaves that are pure chrome / non-linguistic /
                    // already-target-language so a file name or commit hash riding inside an
                    // otherwise-translatable section never costs a segment.
                    if (!this.isAiPageSectionElementEligible(leaf)) continue;
                    const text = serializeBlockSegment(leaf);
                    if (!text) continue;
                    // Already translated this session (repeated string, SPA re-render, scroll
                    // back)? Apply straight from the per-string cache here — 0 tokens, instant —
                    // and keep it out of the request. This is what stops tokens from climbing as
                    // dynamic pages keep re-adding the same content.
                    const cached = this.getCachedSegmentText(text);
                    if (cached != null && this.applyCachedLeafTranslation(leaf, cached)) {
                        cachedApplied += 1;
                        continue;
                    }
                    segBlocks.push(leaf);
                    segTexts.push(text);
                }
            }
            if (!segBlocks.length) {
                // Whole section came from cache — mark its children done so the rescan loop
                // stops re-collecting them, then move on with no request at all.
                if (cachedApplied) {
                    for (const child of untranslatedChildren) {
                        this._aiSectionTranslatedChildren.add(child);
                        markElementTranslatedForRendering(child);
                    }
                }
                continue;
            }
            const sourceText = buildSegmentedTranslationText(
                segTexts.map((text) => ({ text })),
                { compactMarkers: true }
            );
            const cacheKey = [
                this._domPageTranslateOptions.engine,
                model,
                "seg",
                sl,
                tl,
                fnv1a32(segTexts.join(" ")),
            ].join("|");
            const entry = {
                sectionMode: true,
                section: effectiveSection,
                segBlocks,
                segTexts,
                sourceText,
                plainText: effectiveSection.plainText,
                inputTokens: estimateLlmPayloadTokens(sourceText),
                outputTokens: estimateLlmOutputTokens(effectiveSection.plainText, sourceText),
                cacheKey,
                attempt: 0,
                sessionId: this._domTranslationSessionId,
            };
            // Snapshot the per-leaf original text now (before any translation overwrites
            // it) so the hover-to-see-original tooltip can be wired up on apply.
            entry.originalCapture = this.captureAiPageSectionOriginalTexts(entry, 0);
            // Mark children as pending so subsequent scans skip them while in flight.
            for (const child of untranslatedChildren) {
                this._aiSectionTranslatedChildren.add(child);
            }
            enqueued.push(entry);
        }
        if (!enqueued.length) return 0;
        this._domTotalTranslationEntries += enqueued.length;
        this._domCoverageStableScanCount = 0;
        this.updateDomPageBannerStatus();
        this.logDomPageDebug("ai-section-dispatch", {
            reason,
            sections: sections.length,
            enqueued: enqueued.length,
        });
        this.prioritizeAiPageSectionEntriesByViewport(enqueued);
        const visibleEntries = [];
        const offscreenEntries = [];
        for (const entry of enqueued) {
            if (this.getAiPageSectionViewportTier(entry) === 0) visibleEntries.push(entry);
            else offscreenEntries.push(entry);
        }
        const streamingLimit = this.getAiPageVisibleStreamingLimit(visibleEntries.length);
        visibleEntries
            .slice(0, streamingLimit)
            .forEach((entry) => this.enqueueAiPageSectionTranslation(entry));
        const batchEntries = visibleEntries.slice(streamingLimit).concat(offscreenEntries);
        this.buildAiPageSectionBatches(batchEntries).forEach((batch) =>
            this.enqueueAiPageSectionBatchTranslation(batch)
        );
        return enqueued.length;
    }

    getAiPageSectionMaxChars() {
        const engine = this._domPageTranslateOptions.engine;
        // openaiCompatible runs on a local server with a small per-slot context (~4k n_ctx).
        // Keep sections compact so each fits comfortably inside one slot.
        if (engine === "openaiCompatible") return 2400;
        // Cloud (Gemini 2.5 Flash Lite / OpenAI gpt-5-mini class) handle ~5k tokens
        // (~20k chars) comfortably and a larger section means fewer round-trips for
        // the same total content. Streaming partial apply means perceived ttfb
        // doesn't degrade with section size — the first paragraph still pops in
        // within ~1s once the lead chunk is dispatched separately.
        return 20000;
    }

    getAiPageSectionMinChars() {
        return 600;
    }

    /**
     * Soft cap for the FIRST section dispatched on a page. We split the first
     * section's children into a tiny lead chunk so the user sees the very first
     * translated paragraph within ~0.5-1s, then continue with full-size sections
     * for throughput. Returns 0 to disable the split entirely.
     */
    getAiPageSectionLeadChars() {
        const engine = this._domPageTranslateOptions.engine;
        if (engine === "openaiCompatible") return 800;
        return 2000;
    }

    /**
     * Split a section's children into a small lead chunk + remainder so the
     * first translated paragraph lands within ~1s while the full-size sections
     * keep streaming behind. Returns null when no split is needed (single child
     * or already small enough).
     */
    splitSectionLeadChunk(section, leadChars) {
        if (!section || !section.children || section.children.length < 2) return null;
        if (!leadChars) return null;
        const normalize = (el) =>
            String((el && el.textContent) || "")
                .replace(/\s+/g, " ")
                .trim();
        let leadCount = 1;
        let acc = normalize(section.children[0]).length;
        for (let i = 1; i < section.children.length; i += 1) {
            const len = normalize(section.children[i]).length;
            if (acc + len > leadChars) break;
            acc += len;
            leadCount = i + 1;
        }
        if (leadCount === 0 || leadCount === section.children.length) return null;
        const buildSection = (children) => ({
            parent: section.parent,
            children,
            plainText: children.map(normalize).filter(Boolean).join(" "),
            role: section.role,
        });
        return {
            lead: buildSection(section.children.slice(0, leadCount)),
            remainder: buildSection(section.children.slice(leadCount)),
        };
    }

    getAiPageVisibleStreamingLimit(visibleCount = 0) {
        const engine = this._domPageTranslateOptions.engine;
        if (visibleCount <= 0) return 0;
        const concurrency = this.getDomPageMaxConcurrentTranslations();
        const latency = this._aiPageConcurrencyLatencyEmaMs || 0;
        const wait = this._aiPageConcurrencyQueueWaitEmaMs || 0;
        const { fastMs, slowMs } = this.getAiPageConcurrencyLimits();

        if (engine === "openaiCompatible") {
            if (concurrency <= 2 || latency >= slowMs || wait > 1600) {
                return Math.min(1, visibleCount);
            }
            if (concurrency >= 6 && latency > 0 && latency <= fastMs) {
                return Math.min(2, visibleCount);
            }
            return Math.min(1, visibleCount);
        }

        if (latency >= slowMs || wait > 1800) {
            return Math.min(1, visibleCount);
        }
        if (concurrency >= 12 && latency > 0 && latency <= fastMs) {
            return Math.min(4, visibleCount);
        }
        if (concurrency >= 8) return Math.min(3, visibleCount);
        return Math.min(2, visibleCount);
    }

    isElementMarkedAsTranslatedAiSection(element) {
        if (!element || !this._aiSectionTranslatedChildren) return false;
        let current = element;
        while (current && current !== document.documentElement) {
            if (this._aiSectionTranslatedChildren.has(current)) return true;
            current = current.parentElement;
        }
        return false;
    }

    isAiPageSectionElementEligible(element) {
        if (!element || !element.isConnected) return false;
        if (this.isElementMarkedAsTranslatedAiSection(element)) return false;
        if (element.closest && element.closest("[hidden],[aria-hidden='true']")) return false;
        const targetLang = this._domPageTranslateOptions?.tl || "";
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (!this.isMeaningfulDomPageTextNode(node)) continue;
            if (this.isDomPageTextAlreadyInTargetLanguage(node.nodeValue, targetLang)) continue;
            return true;
        }
        return false;
    }

    getAiPageSectionViewportTier(entry) {
        return this.getAiPageSectionViewportRank(entry).tier;
    }

    getAiPageSectionViewportRank(entry, index = 0) {
        const element = entry?.section?.children?.[0];
        const fallback = { tier: 4, distance: Number.MAX_SAFE_INTEGER, index };
        if (!element || typeof element.getBoundingClientRect !== "function") return fallback;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return fallback;
        const visibleTop = Math.max(0, rect.top);
        const visibleBottom = Math.min(viewportHeight, rect.bottom);
        const visiblePx = Math.max(0, visibleBottom - visibleTop);
        if (visiblePx > 0) {
            return {
                tier: 0,
                distance: Math.max(0, rect.top),
                visiblePx: -visiblePx,
                inputTokens: entry.inputTokens || 0,
                index,
            };
        }
        if (rect.top >= viewportHeight && rect.top < viewportHeight * 2) {
            return {
                tier: 1,
                distance: rect.top - viewportHeight,
                visiblePx: 0,
                index,
            };
        }
        if (rect.bottom <= 0 && rect.bottom >= -viewportHeight) {
            return {
                tier: 2,
                distance: Math.abs(rect.bottom),
                visiblePx: 0,
                index,
            };
        }
        return {
            tier: 3,
            distance:
                rect.top >= viewportHeight ? rect.top - viewportHeight : Math.abs(rect.bottom),
            visiblePx: 0,
            index,
        };
    }

    prioritizeAiPageSectionEntriesByViewport(entries) {
        if (!entries || entries.length < 2) return;
        const ranked = entries.map((entry, index) => ({
            entry,
            ...this.getAiPageSectionViewportRank(entry, index),
        }));
        ranked.sort(
            (a, b) =>
                a.tier - b.tier ||
                a.distance - b.distance ||
                (a.visiblePx || 0) - (b.visiblePx || 0) ||
                (a.inputTokens || 0) - (b.inputTokens || 0) ||
                a.index - b.index
        );
        for (let i = 0; i < ranked.length; i += 1) entries[i] = ranked[i].entry;
    }

    getAiPageSectionBatchOptions() {
        const engine = this._domPageTranslateOptions.engine;
        const failures = this._domBatchFailureCount;
        let options;
        if (engine === "openaiCompatible") {
            if (failures >= 2) {
                options = {
                    maxChars: 1400,
                    maxInputTokens: 520,
                    maxOutputTokens: 650,
                    maxItems: 1,
                };
            } else if (failures >= 1) {
                options = {
                    maxChars: 2200,
                    maxInputTokens: 780,
                    maxOutputTokens: 950,
                    maxItems: 2,
                };
            } else {
                options = {
                    maxChars: 3800,
                    maxInputTokens: 1200,
                    maxOutputTokens: 1450,
                    maxItems: 4,
                };
            }
            return this.scaleAiPageSectionBatchOptions(options);
        }
        if (failures >= 2) {
            options = {
                maxChars: 6000,
                maxInputTokens: 1800,
                maxOutputTokens: 2400,
                maxItems: 2,
            };
        } else if (failures >= 1) {
            options = {
                maxChars: 10000,
                maxInputTokens: 3000,
                maxOutputTokens: 4200,
                maxItems: 4,
            };
        } else {
            // Aggressive bundling by COUNT, not size: pack many small sections into one
            // request (maxItems 8 -> 24) so a page full of little blocks goes out as a few
            // batches instead of dozens. maxChars / output-token caps are unchanged, so each
            // batch's reply stays within the model's output budget — no truncation/retries
            // (important on Gemini 3, where we don't pin maxOutputTokens). The concurrency cap
            // runs the batches in parallel, and a slow batch no longer throttles concurrency.
            options = {
                maxChars: 24000,
                maxInputTokens: 7000,
                maxOutputTokens: 9000,
                maxItems: 24,
            };
        }
        return this.scaleAiPageSectionBatchOptions(options);
    }

    buildAiPageSectionBatches(entries) {
        if (!entries || !entries.length) return [];
        const { maxChars, maxInputTokens, maxOutputTokens, maxItems } =
            this.getAiPageSectionBatchOptions();
        const batches = [];
        let current = [];
        let currentChars = 0;
        let currentInputTokens = 0;
        let currentOutputTokens = 0;
        for (const entry of entries) {
            const len = String(entry?.sourceText || "").length;
            const inputTokens =
                entry?.inputTokens || estimateLlmPayloadTokens(entry?.sourceText || "");
            const outputTokens =
                entry?.outputTokens ||
                estimateLlmOutputTokens(entry?.plainText || "", entry?.sourceText || "");
            const wouldOverflowItems = current.length >= maxItems;
            const wouldOverflowChars = current.length > 0 && currentChars + len > maxChars;
            const wouldOverflowTokens =
                current.length > 0 && currentInputTokens + inputTokens > maxInputTokens;
            const wouldOverflowOutput =
                current.length > 0 && currentOutputTokens + outputTokens > maxOutputTokens;
            if (
                wouldOverflowItems ||
                wouldOverflowChars ||
                wouldOverflowTokens ||
                wouldOverflowOutput
            ) {
                batches.push(current);
                current = [];
                currentChars = 0;
                currentInputTokens = 0;
                currentOutputTokens = 0;
            }
            current.push(entry);
            currentChars += len;
            currentInputTokens += inputTokens;
            currentOutputTokens += outputTokens;
        }
        if (current.length) batches.push(current);
        return batches;
    }

    // Apply a [[n]] segment reply onto the entry's leaf blocks by writing text-node
    // values (structure never touched). `appliedSet` (shared with the stream handler)
    // de-dupes segments already written so the final apply only fills the remainder.
    // Marks children translated, registers per-leaf originals for the hover tooltip
    // (once), and caches — but only after at least one segment has landed.
    applyAiPageSectionTranslation(entry, translatedText, appliedSet = null) {
        if (!entry || !entry.segBlocks || !entry.segBlocks.length) return false;
        const map = parsePageSegmentMap(translatedText);
        if (!map.size) return false;
        this.noteDomPageOwnMutation();
        // Synchronous mutation (optionally inside a View Transition) so `applied` is
        // settled before we read it.
        let applied = 0;
        runWithOptionalViewTransition(() => {
            applied = applyPageSegments(entry.segBlocks, map, 0, appliedSet);
        });
        this.storeEntrySegmentCache(entry, map);
        return this.finalizeAppliedAiPageEntry(entry, translatedText, applied);
    }

    // Apply one entry's blocks out of a deduped global batch reply: each block resolves its
    // translation through its unit index (entry.batchUnitOf), so duplicate strings that were
    // sent once still land on every block. Caches a renumbered standalone [[n]] payload so a
    // later single/batch cache hit can re-apply it directly.
    applyAiPageSectionBatchEntry(entry, globalMap) {
        if (!entry || !entry.segBlocks || !entry.segBlocks.length) return false;
        if (!entry._segAppliedSet) entry._segAppliedSet = new Set();
        const localMap = this.entryLocalSegmentMap(entry, globalMap);
        let applied = 0;
        if (localMap.size) {
            this.noteDomPageOwnMutation();
            runWithOptionalViewTransition(() => {
                applied = applyPageSegments(entry.segBlocks, localMap, 0, entry._segAppliedSet);
            });
        }
        this.storeEntrySegmentCache(entry, localMap);
        const cacheText = this.buildEntrySegmentCacheText(entry, localMap);
        return this.finalizeAppliedAiPageEntry(entry, cacheText, applied);
    }

    // Apply a per-string-cache hit straight onto a single leaf at dispatch time — text-node
    // write only (structure untouched), mark it translated, and wire its hover-original
    // tooltip. Returns false if the cached text doesn't cleanly map onto the leaf.
    applyCachedLeafTranslation(leaf, cachedText) {
        if (!leaf || !leaf.isConnected || cachedText == null) return false;
        if (!this._aiSectionTranslatedChildren) {
            this._aiSectionTranslatedChildren = new WeakSet();
        }
        const original = String(leaf.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
        this.noteDomPageOwnMutation();
        let applied = 0;
        runWithOptionalViewTransition(() => {
            applied = applyPageSegments([leaf], new Map([[1, cachedText]]), 0, null);
        });
        if (!applied) return false;
        this._aiSectionTranslatedChildren.add(leaf);
        markElementTranslatedForRendering(leaf);
        if (original) this.registerDomOriginalText(leaf, original);
        return true;
    }

    // Feed each block's (source text -> translation) into the per-string session cache so the
    // same string is never sent to the model again this page session.
    storeEntrySegmentCache(entry, map) {
        if (!entry || !entry.segTexts || !map || !map.size) return;
        for (let i = 0; i < entry.segBlocks.length; i += 1) {
            const translation = map.get(i + 1);
            if (translation != null) this.storeCachedSegmentText(entry.segTexts[i], translation);
        }
    }

    // Resolve an entry's blocks against the deduped global map into a local 1:1
    // [[i+1]] -> translation map. `maxCompleteUnit` drops units still mid-stream.
    entryLocalSegmentMap(entry, globalMap, maxCompleteUnit = Infinity) {
        const local = new Map();
        const unitOf = entry.batchUnitOf;
        const cached = entry.batchCachedText;
        for (let i = 0; i < entry.segBlocks.length; i += 1) {
            // Session-cached block: resolve immediately, independent of the model reply.
            if (cached && cached[i] != null) {
                local.set(i + 1, cached[i]);
                continue;
            }
            if (!globalMap || !globalMap.size) continue;
            const unit = unitOf ? unitOf[i] : i;
            if (unit < 0) continue; // cache miss recorded but no fallback — skip
            if (unit + 1 > maxCompleteUnit) continue;
            const content = globalMap.get(unit + 1);
            if (content != null) local.set(i + 1, content);
        }
        return local;
    }

    // Reconstruct an entry's own [[1..k]] payload from its resolved local map so it can be
    // cached and re-applied independently later.
    buildEntrySegmentCacheText(entry, localMap) {
        const parts = [];
        for (let i = 0; i < entry.segBlocks.length; i += 1) {
            const content = localMap.get(i + 1);
            if (content == null) continue;
            parts.push(`[[${i + 1}]]\n${content}`);
        }
        return parts.join("\n");
    }

    // Shared post-apply bookkeeping: mark children translated, register per-leaf originals
    // for the hover tooltip (once), cache. Returns false (releasing the entry) only when
    // nothing has ever been applied for it.
    finalizeAppliedAiPageEntry(entry, cacheText, appliedThisCall) {
        if (!this._aiSectionTranslatedChildren) {
            this._aiSectionTranslatedChildren = new WeakSet();
        }
        entry._segApplied = (entry._segApplied || 0) + (appliedThisCall || 0);
        if (!entry._segApplied) {
            this.releaseAiPageSectionEntry(entry);
            return false;
        }
        for (const child of entry.section.children) {
            if (!child) continue;
            this._aiSectionTranslatedChildren.add(child);
            // content-visibility: auto lets off-screen translated regions skip
            // layout/paint until scrolled into view — huge win on long pages.
            markElementTranslatedForRendering(child);
        }
        // Register originals exactly once — wrapLeafLineSegmentsInSpans mutates the leaf,
        // so a second pass would nest spans.
        if (!entry._registered) {
            entry._registered = true;
            this.registerAiPageSectionOriginalTexts(entry, entry.originalCapture || [], 0);
        }
        if (cacheText) {
            this.cacheDomPageTranslation(entry.cacheKey, cacheText);
            // Fire-forget save to the IDB-backed persistent cache so a revisit to
            // this URL paints instantly without re-translating.
            this.savePersistentTranslationCacheEntry(entry, cacheText);
        }
        return true;
    }

    // Streaming partial apply for the single-section path: write whatever [[n]] segments
    // have fully arrived so far. Text-only writes, no marking/caching (the final apply
    // does that once). `appliedSet` carries across chunks so nothing is written twice.
    applyStreamedAiPageSegments(entry, accumulatedText, appliedSet) {
        if (!entry || !entry.segBlocks || !accumulatedText) return;
        // The last marker's content may still be mid-generation — drop it so we never
        // apply a half-translated segment (the next chunk / final apply completes it).
        const maxComplete = this.highestCompletePageSegment(accumulatedText);
        if (maxComplete < 1) return;
        const full = parsePageSegmentMap(accumulatedText);
        if (!full.size) return;
        const ready = new Map();
        for (const [n, content] of full) {
            if (n <= maxComplete) ready.set(n, content);
        }
        if (!ready.size) return;
        this.noteDomPageOwnMutation();
        applyPageSegments(entry.segBlocks, ready, 0, appliedSet);
    }

    // Index of the last [[n]] marker that is definitely complete: every marker except the
    // final one in the buffer (whose content may still be streaming).
    highestCompletePageSegment(text) {
        const markerRe = /\[\[(\d+)(?::[a-z0-9-]+)?]]/gi;
        let last = 0;
        let prev = 0;
        let m;
        while ((m = markerRe.exec(text)) !== null) {
            prev = last;
            last = Number(m[1]) || 0;
        }
        // `prev` is the second-to-last marker number — the last fully-delimited segment.
        return prev;
    }

    /**
     * On the very first dispatch of a translation session, ask the background
     * SW for all cached translations for this URL + target language and prefill
     * our in-memory LRU. Subsequent section dispatches that hit cached entries
     * apply instantly without any API call.
     */
    prefetchPersistentTranslationCache() {
        try {
            const tl = this._domPageTranslateOptions && this._domPageTranslateOptions.tl;
            if (!tl) return;
            const urlHash = computePersistentCacheUrlHash(tl);
            if (!urlHash) return;
            this._aiSectionPersistentUrlHash = urlHash;
            if (!this.channel || typeof this.channel.request !== "function") return;
            schedulePostTask(() => {
                let pending;
                try {
                    pending = this.channel.request("persistent_cache_prefetch", { urlHash });
                } catch {
                    return;
                }
                if (!pending || typeof pending.then !== "function") return;
                pending
                    .then((entries) => {
                        if (!Array.isArray(entries) || !entries.length) return;
                        for (const { key, value } of entries) {
                            if (!key || !value) continue;
                            this.cacheDomPageTranslation(key, value);
                        }
                    })
                    .catch(() => null);
            }, "user-visible");
        } catch {
            /* persistent cache is opportunistic — never block translation */
        }
    }

    savePersistentTranslationCacheEntry(entry, translatedHtml) {
        try {
            if (!entry?.cacheKey || !translatedHtml) return;
            if (!this.channel || typeof this.channel.emit !== "function") return;
            const urlHash = this._aiSectionPersistentUrlHash || "";
            schedulePostTask(() => {
                try {
                    this.channel.emit("persistent_cache_save", {
                        urlHash,
                        key: entry.cacheKey,
                        value: translatedHtml,
                    });
                } catch {
                    /* noop */
                }
            }, "background");
        } catch {
            /* noop */
        }
    }

    /**
     * Capture per-LEAF + per-SEGMENT original texts before a section swap so
     * we can pair them with the corresponding translated targets after apply.
     *
     * Returns a 2D array: result[childIndex] is an array of leaf descriptors
     *   [{ segmentTexts: [s1, s2, ...] }, ...]
     * where segmentTexts has one entry per &lt;br&gt;-separated line inside the
     * leaf. Single-line leaves get a one-element array; pages that pack all
     * paragraphs into one &lt;p&gt; with &lt;br&gt; (very common in legacy news
     * markup) get one entry per visible line.
     */
    captureAiPageSectionOriginalTexts(entry, startIndex = 0) {
        const children = entry?.section?.children || [];
        const out = [];
        for (let i = Math.max(0, startIndex); i < children.length; i += 1) {
            out.push(captureLeafSegmentTexts(children[i]));
        }
        return out;
    }

    /**
     * After the section swap, walk the translated child's leaves and register
     * each captured segment text on the positionally-matching target. For
     * single-segment leaves we register on the leaf itself. For multi-segment
     * leaves (i.e. one &lt;p&gt; with multiple &lt;br&gt; lines) we wrap each
     * &lt;br&gt;-separated segment in a `<span data-edge-translate-segment>` and
     * register the original on that span — so the hover tooltip shows just the
     * line the cursor is on instead of the whole paragraph blob.
     */
    registerAiPageSectionOriginalTexts(entry, perChildCaptures, startIndex = 0, endIndex = null) {
        const children = entry?.section?.children || [];
        const start = Math.max(0, startIndex);
        const end =
            endIndex == null
                ? Math.min(children.length, start + (perChildCaptures?.length || 0))
                : Math.min(children.length, endIndex);
        for (let index = start; index < end; index += 1) {
            const child = children[index];
            if (!child) continue;
            const captured = perChildCaptures?.[index - start];
            if (!Array.isArray(captured) || !captured.length) continue;
            const translatedLeaves = findLeafBlocksInElement(child);
            const pairCount = Math.min(translatedLeaves.length, captured.length);
            for (let i = 0; i < pairCount; i += 1) {
                const transLeaf = translatedLeaves[i];
                const { segmentTexts } = captured[i] || {};
                if (!transLeaf || !Array.isArray(segmentTexts) || !segmentTexts.length) {
                    continue;
                }
                if (segmentTexts.length === 1) {
                    if (segmentTexts[0]) {
                        this.registerDomOriginalText(transLeaf, segmentTexts[0]);
                    }
                    continue;
                }
                // Multi-segment leaf: wrap translated <br>-separated lines in
                // spans and register per-span original text.
                const spans = wrapLeafLineSegmentsInSpans(transLeaf);
                const spanPair = Math.min(spans.length, segmentTexts.length);
                for (let j = 0; j < spanPair; j += 1) {
                    if (spans[j] && segmentTexts[j]) {
                        this.registerDomOriginalText(spans[j], segmentTexts[j]);
                    }
                }
            }
        }
    }

    releaseAiPageSectionEntry(entry) {
        if (!this._aiSectionTranslatedChildren) return;
        for (const child of entry?.section?.children || []) {
            this._aiSectionTranslatedChildren.delete(child);
        }
    }

    releaseAiPageSectionElement(element) {
        if (!element || !this._aiSectionTranslatedChildren) return;
        let current = element.nodeType === Node.ELEMENT_NODE ? element : element.parentElement;
        while (current && current !== document.documentElement) {
            if (this._aiSectionTranslatedChildren.delete(current)) return;
            current = current.parentElement;
        }
    }

    enqueueAiPageSectionTranslation(entry) {
        const queuedAt = Date.now();
        const run = async () => {
            if (this._domCircuitBreakerActive) {
                this.markDomPageTranslationEntriesCompleted();
                return;
            }
            this._domActiveTranslations += 1;
            const queueWaitMs = Math.max(0, Date.now() - queuedAt);
            let requestDurationMs = 0;
            // Streaming partial apply: as the SSE buffer grows, write each completed [[n]]
            // segment onto its leaf block. The reader sees translations popcorn into place
            // instead of waiting 3-8s for the full response. `appliedSegments` is shared
            // with the final apply so nothing is written twice.
            const streamId = `et-section-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
            const appliedSegments = new Set();
            // rAF-throttled stream apply: SSE chunks can arrive 50-100×/second from fast
            // models, but the DOM only paints at 60fps. Coalesce intermediate events into
            // one apply per animation frame so we don't thrash the DOM and so React-like
            // listeners on the page aren't overwhelmed.
            let streamLatestText = "";
            let streamRafScheduled = false;
            let streamingFinished = false;
            const flushStreamApply = () => {
                streamRafScheduled = false;
                if (streamingFinished) return;
                const accumulated = streamLatestText;
                if (!accumulated) return;
                try {
                    this.applyStreamedAiPageSegments(entry, accumulated, appliedSegments);
                } catch {
                    /* stream-apply must never throw — final response still recovers */
                }
            };
            const streamHandler = (event) => {
                if (!event || event.streamId !== streamId) return;
                streamLatestText = event.text || "";
                if (streamRafScheduled) return;
                streamRafScheduled = true;
                if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(flushStreamApply);
                } else {
                    setTimeout(flushStreamApply, 16);
                }
            };
            try {
                this.channel.on("translation_stream_progress", streamHandler);
            } catch {
                /* channel may not expose .on in test contexts */
            }
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const cached = this._domTranslationCache.get(entry.cacheKey);
                let translatedText = cached;
                if (!translatedText) {
                    const startedAt = Date.now();
                    this.logDomPageDebug("ai-section:request", {
                        chars: entry.sourceText.length,
                        plainChars: entry.plainText.length,
                        inputTokens: entry.inputTokens,
                    });
                    const result = await this.translateWithDomPageEngine(
                        entry.sourceText,
                        sl,
                        tl,
                        streamId
                    );
                    this.recordDomPageTokenUsage(result);
                    requestDurationMs = Date.now() - startedAt;
                    this.logDomPageDebug("ai-section:response", {
                        durationMs: requestDurationMs,
                        failed: Boolean(result && result.translationFailed),
                        streamApplied: appliedSegments.size,
                    });
                    if (result && result.translationFailed) {
                        throw new Error(result.errorMsg || "AI page section translation failed.");
                    }
                    translatedText = result.mainMeaning || result.translatedText || "";
                    if (!translatedText || !translatedText.trim()) {
                        throw new Error("AI page section returned empty translation.");
                    }
                }

                // Flush any pending throttled stream apply BEFORE the final apply so the
                // shared appliedSegments reflects everything the stream path wrote.
                // Otherwise an SSE chunk that arrived between the last rAF tick and the
                // request resolving would be re-applied redundantly.
                if (streamRafScheduled) flushStreamApply();
                if (!this.applyAiPageSectionTranslation(entry, translatedText, appliedSegments)) {
                    throw new Error("AI page section apply rejected.");
                }

                this.recordAiPageConcurrencyTelemetry({
                    durationMs: requestDurationMs,
                    queueWaitMs,
                    entries: 1,
                });
                this.recordDomPageBatchSuccess();
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this.recordAiPageConcurrencyTelemetry({
                    failed: true,
                    durationMs: requestDurationMs,
                    queueWaitMs,
                    entries: 1,
                });
                this.recordDomPageBatchFailure();
                // One automatic retry; further failures leave the section as the original
                // text so the reader at least sees something readable.
                if (entry.attempt < 1 && this._domBatchFailureCount < 5) {
                    entry.attempt += 1;
                    this._domTotalTranslationEntries += 1;
                    if (!this._domTranslationQueue) this._domTranslationQueue = [];
                    this._domTranslationQueue.unshift(run);
                } else {
                    this.releaseAiPageSectionEntry(entry);
                }
            } finally {
                // Mark stream as finished BEFORE detaching the listener so any rAF that
                // was already scheduled (and fires after the request resolves) skips its
                // apply work — entry.section.children may have moved on by then.
                streamingFinished = true;
                try {
                    this.channel.off("translation_stream_progress", streamHandler);
                } catch {
                    /* noop */
                }
                this.markDomPageTranslationEntriesCompleted();
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    enqueueAiPageSectionBatchTranslation(entries, attempt = 0, options = {}) {
        if (!entries || !entries.length) return;
        const queuedAt = Date.now();
        const run = async () => {
            if (this._domCircuitBreakerActive) {
                entries.forEach((entry) => this.releaseAiPageSectionEntry(entry));
                this.markDomPageTranslationEntriesCompleted(entries.length);
                return;
            }
            this._domActiveTranslations += 1;
            const queueWaitMs = Math.max(0, Date.now() - queuedAt);
            let pendingEntries = entries.slice();
            let batchStartedAt = 0;
            let batchDurationMs = 0;
            let batchInputTokens = 0;
            let batchEntryCount = 0;
            const streamId = `et-section-batch-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
            const streamHandler = (event) => {
                if (!event || event.streamId !== streamId) return;
                this.applyStreamedAiPageSectionBatchSegments(pendingEntries, event.text);
            };
            try {
                this.channel.on("translation_stream_progress", streamHandler);
            } catch {
                /* channel may not expose .on in test contexts */
            }
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const uncachedEntries = [];
                for (const entry of pendingEntries) {
                    const cached = this._domTranslationCache.get(entry.cacheKey);
                    if (cached && this.applyAiPageSectionTranslation(entry, cached, null)) continue;
                    uncachedEntries.push(entry);
                }
                pendingEntries = uncachedEntries;

                if (pendingEntries.length) {
                    // One deduped [[n]] payload over every unique block text in the batch; each
                    // entry records batchUnitOf so the reply maps back onto all of its blocks.
                    // Blocks already in the per-string cache are resolved here and excluded.
                    const batchedSourceText = this.buildAiPageBatchPayload(pendingEntries);
                    if (!batchedSourceText) {
                        // Every block was already translated this session — apply straight from
                        // the per-string cache with NO request (0 tokens, instant).
                        const emptyMap = new Map();
                        for (const entry of pendingEntries) {
                            this.applyAiPageSectionBatchEntry(entry, emptyMap);
                        }
                        this.recordDomPageBatchSuccess();
                        return;
                    }
                    batchStartedAt = Date.now();
                    batchInputTokens = estimateLlmPayloadTokens(batchedSourceText);
                    batchEntryCount = pendingEntries.length;
                    this.logDomPageDebug("ai-section-batch:request", {
                        entries: pendingEntries.length,
                        chars: batchedSourceText.length,
                        inputTokens: batchInputTokens,
                        batchScale: this.getAiPageSectionBatchScale(),
                    });
                    const result = await this.translateWithDomPageEngine(
                        batchedSourceText,
                        sl,
                        tl,
                        streamId
                    );
                    this.recordDomPageTokenUsage(result);
                    batchDurationMs = Date.now() - batchStartedAt;
                    this.logDomPageDebug("ai-section-batch:response", {
                        entries: pendingEntries.length,
                        durationMs: batchDurationMs,
                        failed: Boolean(result && result.translationFailed),
                        batchScale: this.getAiPageSectionBatchScale(),
                    });
                    if (result && result.translationFailed) {
                        throw new Error(
                            result.errorMsg || "AI page section batch translation failed."
                        );
                    }
                    const translated = result.mainMeaning || result.translatedText || "";
                    const globalMap = parsePageSegmentMap(translated);
                    // Forgiving apply: each entry resolves its blocks through batchUnitOf out of
                    // the deduped global reply. A dropped marker only leaves that one block in
                    // the source language; it never fails the whole batch.
                    const failedEntries = [];
                    for (const entry of pendingEntries) {
                        if (!this.applyAiPageSectionBatchEntry(entry, globalMap)) {
                            failedEntries.push(entry);
                        }
                    }
                    if (failedEntries.length) {
                        this.recordAiPageSectionBatchTelemetry({
                            failed: true,
                            durationMs: batchDurationMs,
                            inputTokens: batchInputTokens,
                            queueWaitMs,
                            entries: batchEntryCount,
                        });
                        this.recordDomPageBatchFailure();
                        this.retryAiPageSectionBatchEntries(failedEntries, attempt);
                    } else {
                        this.recordAiPageSectionBatchTelemetry({
                            durationMs: batchDurationMs,
                            inputTokens: batchInputTokens,
                            queueWaitMs,
                            entries: batchEntryCount,
                        });
                        this.recordDomPageBatchSuccess();
                    }
                } else {
                    this.recordDomPageBatchSuccess();
                }
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this.recordAiPageSectionBatchTelemetry({
                    failed: true,
                    durationMs:
                        batchDurationMs || (batchStartedAt ? Date.now() - batchStartedAt : 0),
                    inputTokens: batchInputTokens,
                    queueWaitMs,
                    entries: pendingEntries.length,
                });
                this.recordDomPageBatchFailure();
                this.retryAiPageSectionBatchEntries(
                    pendingEntries.filter((entry) => !entry._segApplied),
                    attempt
                );
            } finally {
                try {
                    this.channel.off("translation_stream_progress", streamHandler);
                } catch {
                    /* noop */
                }
                this.markDomPageTranslationEntriesCompleted(entries.length);
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        if (options.front) this._domTranslationQueue.unshift(run);
        else this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    // Build the batch request payload with DEDUP: identical block texts (repeated UI
    // strings — "Edit", "Reply", nav labels…) collapse to a single [[n]] unit, so the model
    // translates each unique string once. Every entry records batchUnitOf (block -> unit)
    // to resolve the reply back onto all of its blocks.
    buildAiPageBatchPayload(entries) {
        const unitTexts = [];
        const unitIndexByText = new Map();
        for (const entry of entries) {
            entry._segAppliedSet = new Set();
            entry.batchCachedText = new Array((entry.segTexts || []).length);
            entry.batchUnitOf = (entry.segTexts || []).map((text, i) => {
                // Already translated this session? Resolve from the per-string cache and keep
                // it OUT of the request entirely (0 tokens). Marked with unit -1.
                const cached = this.getCachedSegmentText(text);
                if (cached != null) {
                    entry.batchCachedText[i] = cached;
                    return -1;
                }
                let idx = unitIndexByText.get(text);
                if (idx == null) {
                    idx = unitTexts.length;
                    unitTexts.push(text);
                    unitIndexByText.set(text, idx);
                }
                return idx;
            });
        }
        return buildSegmentedTranslationText(
            unitTexts.map((text) => ({ text })),
            { compactMarkers: true }
        );
    }

    // Streaming partial apply for a batch: write whatever global units have fully arrived
    // onto each entry's leaf blocks (text-only; the final apply marks/caches once).
    applyStreamedAiPageSectionBatchSegments(entries, accumulatedText) {
        if (!entries?.length || !accumulatedText) return;
        const maxComplete = this.highestCompletePageSegment(accumulatedText);
        if (maxComplete < 1) return;
        const globalMap = parsePageSegmentMap(accumulatedText);
        if (!globalMap.size) return;
        this.noteDomPageOwnMutation();
        for (const entry of entries) {
            if (!entry.batchUnitOf || !entry._segAppliedSet) continue;
            const localMap = this.entryLocalSegmentMap(entry, globalMap, maxComplete);
            if (localMap.size) {
                applyPageSegments(entry.segBlocks, localMap, 0, entry._segAppliedSet);
            }
        }
    }

    retryAiPageSectionBatchEntries(entries, attempt = 0) {
        if (!entries || !entries.length) return;
        if (attempt >= 1 || this._domBatchFailureCount >= 5) {
            entries.forEach((entry) => this.releaseAiPageSectionEntry(entry));
            return;
        }
        this._domTotalTranslationEntries += entries.length;
        if (entries.length > 1) {
            const mid = Math.ceil(entries.length / 2);
            this.enqueueAiPageSectionBatchTranslation(entries.slice(mid), attempt + 1, {
                front: true,
            });
            this.enqueueAiPageSectionBatchTranslation(entries.slice(0, mid), attempt + 1, {
                front: true,
            });
            return;
        }
        const [entry] = entries;
        entry.attempt = 1;
        this.enqueueAiPageSectionTranslation(entry);
    }

    createDomPageTranslationEntry(group) {
        const { tl } = this._domPageTranslateOptions;
        const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
        const sessionId =
            group && group.sessionId !== undefined
                ? group.sessionId
                : this._domTranslationSessionId;
        if (group && group.sessionId === undefined) group.sessionId = sessionId;
        const block = group?.block || group?.nodes?.[0]?.parentElement || null;
        const role = group?.role || "text";

        // HTML-native path: when the engine is an LLM and the block is safe to round-trip
        // through innerHTML, send the model raw HTML and apply with structure validation +
        // critical-attribute restoration. Kept for callers that build entries via this
        // method (legacy tests + the per-group fallback inside enqueueDomPageGroupTranslation).
        if (block && this.isHtmlNativeEntryEligible(block)) {
            const plainText = this.computeDomPageBlockPlainText(block);
            const innerHtml = block.innerHTML;
            const cacheKey = [
                this._domPageTranslateOptions.engine,
                this._domPageTranslateOptions.model || "",
                role,
                sl,
                tl,
                fnv1a32(plainText),
            ].join("|");
            return {
                group,
                block,
                htmlMode: true,
                htmlElement: block,
                plainText,
                role,
                sourceText: innerHtml,
                cacheKey,
                sessionId,
            };
        }

        const wrapped = this.isHtmlWrapEligible(block)
            ? this.serializeBlockForHtmlWrap(block)
            : null;
        const sourceText = wrapped ? wrapped.html : group?.sourceText || "";
        const sourceTextForCache = wrapped ? wrapped.plainText : sourceText;
        const cacheKey = [
            this._domPageTranslateOptions.engine,
            this._domPageTranslateOptions.model || "",
            role,
            sl,
            tl,
            fnv1a32(sourceTextForCache),
        ].join("|");
        return {
            group,
            block: wrapped ? block : null,
            wrappedNodes: wrapped ? wrapped.nodes : null,
            wrappedPlainText: wrapped ? wrapped.plainText : "",
            role,
            sourceText,
            cacheKey,
            sessionId,
        };
    }

    computeDomPageBlockPlainText(block) {
        return String((block && block.textContent) || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * HTML-native eligibility: the block must be a real element with translatable text and
     * HTML-native eligibility: real element with translatable text and no media/widgets
     * we'd irrevocably lose if re-rendered. Permits common inline content because
     * restoreHtmlCriticalAttributes copies attrs from original on apply.
     */
    isHtmlNativeEntryEligible(block) {
        if (!block || block.nodeType !== Node.ELEMENT_NODE) return false;
        const engine = this._domPageTranslateOptions && this._domPageTranslateOptions.engine;
        if (engine !== "openaiCompatible" && engine !== "googleAiStudio" && engine !== "openai") {
            return false;
        }
        if (
            block.querySelector(
                "script,style,iframe,canvas,object,embed,video,audio,svg,math,select,textarea,input,pre,code,kbd,samp"
            )
        ) {
            return false;
        }
        if (!block.textContent || !block.textContent.trim()) return false;
        if (block.innerHTML.length > 6000) return false;
        return true;
    }

    /**
     * Eligible when the block exists, has at least one text node, and contains no functional
     * content we'd irrevocably destroy by re-rendering (images, buttons, code, embeds, forms).
     */
    isHtmlWrapEligible(block) {
        if (!block || !block.querySelector || block.nodeType !== Node.ELEMENT_NODE) return false;
        if (
            block.querySelector(
                "img,button,canvas,code,embed,iframe,input,kbd,math,object,picture,pre,samp,script,select,style,svg,textarea,video,audio"
            )
        ) {
            return false;
        }
        return Boolean(block.textContent && block.textContent.trim());
    }

    /**
     * Walk the block's children and emit a compact HTML string in which every meaningful
     * text node is wrapped in <t i="N"> ... </t>. Returns:
     *   - html: the string to send to the model
     *   - nodes: a Map<number, TextNode> for back-applying translations
     *   - plainText: stripped text (for cache keys and the suspicious-output check)
     */
    serializeBlockForHtmlWrap(block) {
        const nodes = new Map();
        const plainParts = [];
        let nextId = 0;
        const buf = [];
        const ALLOWED_INLINE_TAGS = new Set([
            "a",
            "abbr",
            "b",
            "bdi",
            "bdo",
            "cite",
            "del",
            "dfn",
            "em",
            "i",
            "ins",
            "mark",
            "q",
            "s",
            "small",
            "span",
            "strong",
            "sub",
            "sup",
            "time",
            "u",
            "wbr",
            "br",
            "p",
            "div",
            "ul",
            "ol",
            "li",
        ]);
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const raw = String(node.nodeValue || "");
                if (!raw.trim()) {
                    if (raw) buf.push(this.escapeHtmlForWrap(raw));
                    return;
                }
                const id = ++nextId;
                nodes.set(id, node);
                plainParts.push(raw);
                buf.push(`<t i="${id}">`);
                buf.push(this.escapeHtmlForWrap(raw));
                buf.push("</t>");
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const tag = node.tagName.toLowerCase();
            if (!ALLOWED_INLINE_TAGS.has(tag)) {
                // Unknown / structural element — render its text content but skip the tag itself
                // so the prompt stays focused on translatable language.
                for (const child of node.childNodes) walk(child);
                return;
            }
            if (tag === "br") {
                buf.push("<br>");
                return;
            }
            buf.push(`<${tag}>`);
            for (const child of node.childNodes) walk(child);
            buf.push(`</${tag}>`);
        };
        for (const child of block.childNodes) walk(child);
        return {
            html: buf.join(""),
            nodes,
            plainText: this.normalizeBlockText(plainParts.join(" ")),
        };
    }

    escapeHtmlForWrap(text) {
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    /**
     * Parse the model's response HTML and return a Map<number, string> of translated text
     * keyed by the i="N" attribute. Robust to extra whitespace, missing closing tags, and
     * partial matches — every successfully parsed <t i="N">…</t> still gets applied.
     */
    parseHtmlWrapResponse(translatedHtml) {
        const result = new Map();
        if (!translatedHtml) return result;
        // Regex first (forgiving on whitespace/quotes). DOMParser would also work but is
        // heavier and stricter; the regex covers the typical model outputs cleanly.
        const re = /<t\s+i=["']?(\d+)["']?\s*>([\s\S]*?)<\/t\s*>/gi;
        let m;
        while ((m = re.exec(translatedHtml)) !== null) {
            const id = Number(m[1]);
            if (!Number.isFinite(id)) continue;
            // Strip any nested HTML tags the model may have introduced, keep visible text.
            const text = m[2].replace(/<[^>]+>/g, "");
            result.set(id, this.decodeHtmlEntities(text).trim());
        }
        return result;
    }

    decodeHtmlEntities(text) {
        return String(text)
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, String.fromCharCode(34))
            .replace(/&#39;/g, "'");
    }

    normalizeBlockText(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    assignDomPageApplySequence(entry) {
        if (!entry) return entry;
        if (!Number.isFinite(entry.applySequence)) {
            entry.applySequence = this._domNextApplySequence;
            this._domNextApplySequence += 1;
        }
        return entry;
    }

    queueDomPageEntryApply(entry, translated) {
        if (!this.isDomPageEntryCurrentSession(entry)) return;
        if (Number.isFinite(entry?.applySequence)) {
            this._domPendingApplies.set(entry.applySequence, {
                entry,
                translated,
            });
            this.flushDomPagePendingApplies();
            return;
        }
        this.applyDomPageEntryNow(entry, translated);
    }

    applyDomPageEntryNow(entry, translated) {
        if (!this.isDomPageEntryCurrentSession(entry)) return;
        if (!this.isDomPageEntryStillCurrent(entry)) {
            this.releaseDomPageEntryPending(entry);
            return;
        }
        this.noteDomPageOwnMutation();
        if (this.applyDomPageTranslatedEntry(entry, translated)) {
            this.cacheDomPageTranslation(entry.cacheKey, translated);
            this.markDomPageEntryApplied(entry);
            this.fanOutDomPageDuplicates(entry, translated);
        } else {
            this.releaseDomPageEntryPending(entry);
        }
    }

    flushDomPagePendingApplies() {
        if (!this._domPendingApplies) return;
        while (this._domPendingApplies.has(this._domNextApplyToFlush)) {
            const pending = this._domPendingApplies.get(this._domNextApplyToFlush);
            this._domPendingApplies.delete(this._domNextApplyToFlush);
            this._domNextApplyToFlush += 1;
            if (pending && !pending.skip) {
                this.applyDomPageEntryNow(pending.entry, pending.translated);
            }
        }
    }

    releaseDomPageApplySequence(entry) {
        if (!Number.isFinite(entry?.applySequence)) return;
        if (entry.applySequence < this._domNextApplyToFlush) return;
        this._domPendingApplies.set(entry.applySequence, {
            entry,
            skip: true,
        });
        this.flushDomPagePendingApplies();
    }

    /**
     * Apply a primary's translation to all queued duplicates that share its cacheKey.
     * Duplicates are not counted in completion totals (they piggyback on the primary's slot).
     */
    fanOutDomPageDuplicates(primary, translated) {
        const bucket = primary && this._domDuplicateEntries?.get(primary.cacheKey);
        if (!bucket || !bucket.length) return;
        this._domDuplicateEntries.delete(primary.cacheKey);
        for (const dup of bucket) {
            if (!this.isDomPageEntryCurrentSession(dup)) continue;
            if (!this.isDomPageEntryStillCurrent(dup)) {
                this.releaseDomPageEntryPending(dup);
                continue;
            }
            // Re-validate per duplicate: group.nodes differ, so split/segment checks must rerun.
            const rejection = this.getDomPageEntryRejectionReason(dup, translated);
            if (rejection) {
                this.releaseDomPageEntryPending(dup);
                continue;
            }
            if (this.applyDomPageTranslatedEntry(dup, translated)) {
                this.markDomPageEntryApplied(dup);
            } else {
                this.releaseDomPageEntryPending(dup);
            }
        }
    }

    canQueueDomPageEntryTranslation(entry, translated) {
        return !this.getDomPageEntryRejectionReason(entry, translated);
    }

    /**
     * Only check whether the translation is genuinely garbage. Per-line / per-marker validation
     * is gone: HTML-wrap apply handles partial matches gracefully on its own.
     *
     * For wrapped entries we compare against the wrapped plainText (visible text only) since
     * sourceText is the full HTML payload including <t> tags.
     */
    getDomPageEntryRejectionReason(entry, translated) {
        const source =
            (entry.htmlMode && entry.plainText) || entry.wrappedPlainText || entry.sourceText;
        if (!this.canUseDomPageTranslation(source, translated)) {
            return "suspicious-output";
        }
        return "";
    }

    shouldUsePlainDomPageNodeFallback(entry, reason = "") {
        if (this._domPageTranslateOptions.engine !== "openaiCompatible") return false;
        if (!entry?.group?.nodes?.length) return false;
        return [
            "line-count",
            "marker-missing",
            "suspicious-line",
            "inline-link-placeholder",
        ].includes(reason);
    }

    fallbackDomPageEntryToPlainNodes(entry) {
        if (!entry?.group?.nodes?.length) return false;
        this.enqueueDomPageEntryNodeTranslations(entry);
        return true;
    }

    skipDomPageEntryApply(entry) {
        if (!this.isDomPageEntryCurrentSession(entry)) return;
        this.releaseDomPageEntryPending(entry);
        this.releaseDomPageApplySequence(entry);
    }

    cacheDomPageTranslation(cacheKey, translated) {
        if (!cacheKey || !translated) return;
        if (this._domTranslationCache.size >= this._domTranslationCacheMax) {
            const oldest = this._domTranslationCache.keys().next().value;
            if (oldest !== undefined) this._domTranslationCache.delete(oldest);
        }
        this._domTranslationCache.set(cacheKey, translated);
    }

    // Per-string cache: key by engine|model|sl|tl|hash so a switch of engine/language never
    // reuses a stale translation.
    segmentTextCacheKey(text) {
        const opts = this._domPageTranslateOptions || {};
        const sl = this._domResolvedSourceLanguage || opts.sl || "";
        return [opts.engine, opts.model || "", sl, opts.tl || "", fnv1a32(String(text || ""))].join(
            "|"
        );
    }

    getCachedSegmentText(text) {
        if (!text || !this._domSegmentTextCache) return null;
        const value = this._domSegmentTextCache.get(this.segmentTextCacheKey(text));
        return value == null ? null : value;
    }

    storeCachedSegmentText(text, translation) {
        if (!text || translation == null || translation === "") return;
        if (!this._domSegmentTextCache) this._domSegmentTextCache = new Map();
        const key = this.segmentTextCacheKey(text);
        // Re-insert to keep most-recent at the tail (simple insertion-order LRU).
        if (this._domSegmentTextCache.has(key)) {
            this._domSegmentTextCache.delete(key);
        } else if (this._domSegmentTextCache.size >= (this._domSegmentTextCacheMax || 6000)) {
            const oldest = this._domSegmentTextCache.keys().next().value;
            if (oldest !== undefined) this._domSegmentTextCache.delete(oldest);
        }
        this._domSegmentTextCache.set(key, translation);
    }

    markDomPageEntryApplied(entry) {
        const nodes = entry?.group?.nodes || [];
        nodes.forEach((node) => {
            this._domPendingTextNodes.delete(node);
            this._translatedSet.add(node);
        });
    }

    releaseDomPageEntryPending(entry) {
        const nodes = entry?.group?.nodes || [];
        nodes.forEach((node) => this._domPendingTextNodes.delete(node));
    }

    isDomPageEntryCurrentSession(entry) {
        return (
            !entry ||
            entry.sessionId === undefined ||
            entry.sessionId === this._domTranslationSessionId
        );
    }

    normalizeDomPageNodeText(text) {
        return String(text || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    isDomPageEntryStillCurrent(entry) {
        const group = entry && entry.group;
        if (!group || !group.nodes || !group.nodes.length) return true;
        return group.nodes.every((node, index) => {
            if (!node || !node.isConnected) return false;
            return (
                this.normalizeDomPageNodeText(node.nodeValue) ===
                this.normalizeDomPageNodeText(group.texts[index])
            );
        });
    }

    retryDomPageEntryTranslation(entry, attempt = 0, options = {}) {
        if (!entry || !entry.group) return false;
        const reason = options.reason || "";
        if (this.shouldUsePlainDomPageNodeFallback(entry, reason)) {
            // Fallback grows total by group.nodes.length internally; no extra accounting needed here.
            return this.fallbackDomPageEntryToPlainNodes(entry);
        }
        if (!this.shouldRetryDomPageEntryTranslation(entry, attempt, reason)) {
            this.markDomPageEntryFailed(entry);
            this.skipDomPageEntryApply(entry);
            return false;
        }
        // At this point we're retrying a real network/API error (validation failures returned false above).
        // Bump total by 1 so the completion counter stays balanced when this retry eventually finishes.
        this._domTotalTranslationEntries += 1;
        this.enqueueDomPageGroupTranslation(entry.group, attempt + 1, {
            front: true,
            ...options,
        });
        return true;
    }

    shouldRetryDomPageEntryTranslation(entry, attempt, reason = "") {
        if (!entry || attempt >= 1) return false;
        // Deterministic format failures (line-count, marker missing, link placeholders) usually
        // repeat on the same prompt, but suspicious/hallucinated output inside a larger batch can
        // recover when retried as one focused unit.
        if (reason && !["suspicious-output", "suspicious-line"].includes(reason)) return false;
        const role = entry.role || entry.group?.role || "text";
        const sourceLength = String(entry.sourceText || "").trim().length;
        const contentRoles = ["paragraph", "list-item", "caption", "table-header"];
        if (role === "title" || role === "date") return sourceLength >= 8;
        if (contentRoles.includes(role)) return sourceLength >= 40;
        return sourceLength >= 120;
    }

    markDomPageEntryFailed(entry) {
        const nodes = entry?.group?.nodes || [];
        nodes.forEach((node) => {
            this._domPendingTextNodes.delete(node);
            this._domFailedTextNodes.add(node);
        });
    }

    applyDomPageTranslatedEntry(entry, translated) {
        if (!translated) return false;
        if (entry.htmlMode && entry.htmlElement && entry.htmlElement.isConnected) {
            return this.applyDomPageHtmlNativeEntry(entry, translated);
        }
        // HTML-wrap path (Google-style): parse <t i="N">…</t> wrappers from the response and
        // apply each translation to its original text node. Inline structure (bolds, links,
        // italics) stays intact because we only mutate text-node values, never the DOM tree.
        if (entry.block && entry.block.isConnected && entry.wrappedNodes?.size) {
            const idMap = this.parseHtmlWrapResponse(translated);
            const block = entry.block;
            const wrappedNodes = entry.wrappedNodes;
            // Pre-compute which nodes have a matching translation so we can decide before fading
            // whether the apply will produce any visible change.
            const pendingUpdates = [];
            for (const [id, node] of wrappedNodes) {
                const text = idMap.get(id);
                if (text == null || !node.parentElement) continue;
                pendingUpdates.push({
                    node,
                    text: this.preserveDomTextNodeBoundaryWhitespace(node, text),
                });
            }
            if (pendingUpdates.length > 0) {
                this.registerDomOriginalText(block, entry.wrappedPlainText || entry.sourceText);
                this.fadeInDomPageBlock(block, () => {
                    for (const { node, text } of pendingUpdates) {
                        node.nodeValue = text;
                        this._translatedSet.add(node);
                        this._domPendingTextNodes.delete(node);
                    }
                });
                this._translatedBlocks.add(block);
                return true;
            }
            // Parsing produced zero matches — model probably stripped the tags. Fall through to
            // a wholesale plain-text replacement so the block still gets translated.
            const sanitized = this.sanitizeDomPageTranslatedText(translated).replace(
                /<\/?t\s*[^>]*>/gi,
                ""
            );
            if (!sanitized) return false;
            this.registerDomOriginalText(block, entry.wrappedPlainText || entry.sourceText);
            this.fadeInDomPageBlock(block, () => {
                block.textContent = sanitized;
                for (const node of wrappedNodes.values()) {
                    this._domPendingTextNodes.delete(node);
                    this._translatedSet.add(node);
                }
            });
            this._translatedBlocks.add(block);
            return true;
        }
        // Block not eligible for HTML wrap (functional inline content). Translate per text node
        // using the group's nodes and the existing line-split helper.
        const group = entry.group;
        if (!group?.nodes?.length) return false;
        const parts = splitTranslatedContext(translated, group.nodes.length);
        if (!parts) {
            // The model gave us a coherent translation, but couldn't line-split it back to the
            // group's text nodes (often happens when the model merges several paragraphs into
            // one fluent sentence). The OLD behavior — dump the merged blob into the first node
            // and clear every other node to "" — caused entries to literally disappear from the
            // page whenever the merged blob sanitized to empty (or even when it didn't, because
            // siblings still ended up blank). Return false so the caller leaves the original
            // text in place, releases the entry from the pending queue, and lets the retry
            // pipeline ask the model again. Worst case the paragraph stays in the source
            // language — never silently empty.
            return false;
        }
        // Track whether at least one node got a real translation; if every applyWithFadeIn
        // bailed (because sanitize emptied the part), tell the caller the entry was not
        // applied so the original text stays intact and the retry pipeline can recover.
        let appliedAny = false;
        group.nodes.forEach((node, index) => {
            if (parts[index] && node.parentElement) {
                if (this.applyWithFadeIn(node, parts[index], "text", group.texts[index])) {
                    appliedAny = true;
                }
            }
        });
        return appliedAny;
    }

    /**
     * Apply an HTML-native translation. The translated string is the block's new innerHTML.
     * buildSafeTranslatedHtml does the heavy lifting: parses the payload into a detached
     * container, strips dangerous descendants (script, iframe, on* handlers, javascript: URLs),
     * and restores every critical attribute (href, src, alt, srcset, id, class, style, data-*,
     * aria-*) from the original element so the model can't rewrite page identifiers or links.
     *
     * Returns false when the validator rejects the payload (empty, malformed, or stripped to
     * nothing after sanitize). false leaves the original block intact — the caller releases
     * the entry from pending state and the retry pipeline can try again.
     */
    /**
     * Apply an HTML-native entry: parse the model's HTML response, sanitize, restore
     * critical attrs from the original block, then swap innerHTML. Returns false (no
     * mutation) on any structural / sanitize / suspicious-output rejection.
     */
    applyDomPageHtmlNativeEntry(entry, translated) {
        const block = entry.htmlElement;
        if (!block || !block.isConnected) return false;
        const safeContainer = buildSafeTranslatedHtml(block, translated);
        if (!safeContainer) return false;
        const sourcePlain = entry.plainText || this.computeDomPageBlockPlainText(block);
        const translatedPlain = String(safeContainer.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
        if (!translatedPlain) return false;
        if (!this.canUseDomPageTranslation(sourcePlain, translatedPlain)) return false;
        if (
            sourcePlain &&
            translatedPlain.length < Math.max(2, Math.floor(sourcePlain.length / 8))
        ) {
            return false;
        }
        this.registerDomOriginalText(block, sourcePlain);
        this.fadeInDomPageBlock(block, () => {
            block.innerHTML = safeContainer.innerHTML;
            const textWalker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let textNode = textWalker.nextNode();
            while (textNode) {
                this._translatedSet.add(textNode);
                this._domPendingTextNodes.delete(textNode);
                textNode = textWalker.nextNode();
            }
        });
        this._translatedBlocks.add(block);
        return true;
    }

    sanitizeDomPageTranslatedText(text) {
        return this.stripPromptEchoFromTranslation(String(text || ""));
    }

    sanitizeDomPageOriginalText(text) {
        return String(text || "")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .trim();
    }

    enqueueDomPageEntryNodeTranslations(entry) {
        const group = entry && entry.group;
        if (!group || !group.nodes || !group.nodes.length) return;
        this._domTotalTranslationEntries += group.nodes.length;
        this.updateDomPageBannerStatus();
        group.nodes.forEach((node, index) => {
            this.enqueueDomPageNodeTranslation({
                node,
                parent: node.parentElement,
                text: group.texts[index] || String(node.nodeValue || "").trim(),
            });
        });
    }

    /**
     * Apply translated text with a subtle fade-in for smooth UX.
     *
     * Returns false (without mutating the DOM) when sanitize produces an empty string —
     * this guards against the prompt-echo stripper accidentally collapsing the whole
     * translation, which would otherwise blank the original node and make the entry
     * disappear from the page.
     */
    applyWithFadeIn(node, translated, type, originalText) {
        translated = this.sanitizeDomPageTranslatedText(translated);
        if (!translated || !translated.trim()) return false;
        if (type === "text") {
            this.noteDomPageOwnMutation();
            return this.applyTextNodeTranslationWithOriginalChunks(node, translated, originalText);
        }
        const el = type === "block" ? node : node.parentElement;
        if (!el || !el.style) {
            this.noteDomPageOwnMutation();
            if (type === "block") node.textContent = translated;
            else node.nodeValue = translated;
            return true;
        }
        if (this.isPdfViewerTextLayerElement(el)) {
            this.ensureDomPageStyle();
            el.classList.add("et-dom-pdf-translated-text");
        }
        this.noteDomPageOwnMutation();
        this.registerDomOriginalText(el, originalText);
        this.fadeInDomPageBlock(el, () => {
            if (type === "block") node.textContent = translated;
            else node.nodeValue = translated;
        });
        return true;
    }

    applyTextNodeTranslationWithOriginalChunks(node, translated, originalText) {
        translated = this.sanitizeDomPageTranslatedText(translated);
        if (!translated || !translated.trim()) return false;
        const parent = node && node.parentElement;
        if (!parent) {
            if (node) node.nodeValue = this.preserveDomTextNodeBoundaryWhitespace(node, translated);
            return true;
        }
        const pairs = this.buildDomOriginalDisplayPairs(translated, originalText);
        const fragment = document.createDocumentFragment();
        const spans = [];
        const isPdfLayer = this.isPdfViewerTextLayerElement(parent);
        this.ensureDomPageStyle();
        pairs.forEach((pair, index) => {
            if (index > 0) fragment.appendChild(document.createTextNode(pair.separator || " "));
            const span = document.createElement("span");
            span.className = "et-dom-translated-text";
            if (isPdfLayer) {
                span.classList.add("et-dom-pdf-translated-text");
            }
            const isFirst = index === 0;
            const isLast = index === pairs.length - 1;
            span.textContent = this.preserveDomTextNodeBoundaryWhitespace(node, pair.translated, {
                leading: isFirst,
                trailing: isLast,
            });
            this.registerDomOriginalText(span, pair.original);
            fragment.appendChild(span);
            spans.push(span);
        });

        if (!spans.length) {
            node.nodeValue = this.preserveDomTextNodeBoundaryWhitespace(node, translated);
            return;
        }

        parent.replaceChild(fragment, node);
        spans.forEach((span) => {
            this.fadeInDomPageBlock(span, () => {});
        });
    }

    preserveDomTextNodeBoundaryWhitespace(node, translated, options = {}) {
        const value = String(translated || "");
        if (!value) return value;
        const raw = String((node && node.nodeValue) || "");
        const useLeading = options.leading !== false;
        const useTrailing = options.trailing !== false;
        const leading = useLeading ? raw.match(/^\s+/)?.[0] || "" : "";
        const trailing = useTrailing ? raw.match(/\s+$/)?.[0] || "" : "";
        const normalizedLeading = leading ? " " : "";
        const normalizedTrailing = trailing ? " " : "";
        return `${normalizedLeading}${value.trim()}${normalizedTrailing}`;
    }

    isPdfViewerTextLayerElement(element) {
        return Boolean(
            document.getElementById("outerContainer") &&
                element &&
                element.closest &&
                element.closest("#viewer .textLayer")
        );
    }

    ensureDomPageStyle() {
        if (this._domPageStyleInjected) return;
        this._domPageStyleInjected = true;
        const style = document.createElement("style");
        // PDF text-layer translated content carries a soft Liquid Glass chip so it
        // reads cleanly above the canvas at any zoom level. light-dark() picks the
        // tint automatically from the page's color-scheme.
        style.textContent = `
            .textLayer .et-dom-pdf-translated-text {
                color-scheme: light dark;
                color: light-dark(#1d1d1f, #f2f2f7) !important;
                background: light-dark(rgba(255, 255, 255, 0.78), rgba(28, 28, 30, 0.78)) !important;
                backdrop-filter: blur(12px) saturate(170%) !important;
                -webkit-backdrop-filter: blur(12px) saturate(170%) !important;
                border-radius: 4px !important;
                box-decoration-break: clone !important;
                -webkit-box-decoration-break: clone !important;
                box-shadow:
                    0 0.5px 0 light-dark(rgba(255, 255, 255, 0.60), rgba(255, 255, 255, 0.08)) inset,
                    0 0 0 0.5px light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08)) !important;
                text-shadow: 0 0 1px light-dark(rgba(255, 255, 255, 0.85), transparent) !important;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Material 3 Expressive entrance for a translated block.
     *
     * Hides the block, mutates DOM while invisible, then fades + slides + settles back into
     * place using M3 motion tokens:
     *   • Opacity: 280ms with Emphasized Decelerate `cubic-bezier(.05,.7,.1,1)` (smooth, no overshoot)
     *   • Transform (translateY + scale): 380ms with a soft spring `cubic-bezier(.2,1.18,.32,1)`
     *     for the subtle "쫀쫀" springiness that defines Expressive motion.
     *
     * Respects `prefers-reduced-motion: reduce` — falls back to an instant swap.
     * Uses `translate3d` to force a compositor layer so dozens of paragraphs can animate
     * simultaneously without main-thread cost.
     */
    fadeInDomPageBlock(block, mutateFn) {
        let ran = false;
        const runMutate = () => {
            if (ran) return;
            ran = true;
            try {
                mutateFn();
            } catch {
                /* mutation may fail if the block detaches mid-flight */
            }
        };
        if (!block || !block.style || !block.isConnected) {
            runMutate();
            return;
        }
        // Respect the OS-level reduce-motion preference.
        let reduceMotion = false;
        try {
            reduceMotion =
                typeof window.matchMedia === "function" &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch {
            /* matchMedia may be unavailable in non-browser contexts */
        }
        if (reduceMotion) {
            runMutate();
            return;
        }

        // Inline elements (like <span> tags created for text node replacements) cannot be promoted
        // to GPU compositor layers without triggering severe layout rendering bugs (rendering empty/blank).
        // For these display: inline elements, we skip transform/will-change and transition opacity only.
        const isInline =
            block.tagName === "SPAN" || block.classList.contains("et-dom-translated-text");

        const prevTransition = block.style.transition;
        const prevOpacity = block.style.opacity;
        const prevTransform = block.style.transform;
        const prevWillChange = block.style.willChange;

        const m3Emphasized =
            "linear(0, 0.005, 0.018 1.5%, 0.066 3.7%, 0.171 7.5%, 0.346 13.6%, 0.547 21%, 0.722 29.4%, 0.853 38.4%, 0.937 47.7%, 0.978 56.8%, 0.997 67.4%, 1)";

        if (isInline) {
            block.style.transition = "none";
            block.style.opacity = "0";
            // Force synchronous layout pass to commit the opacity: 0 state before running mutations
            void block.offsetWidth;
            runMutate();

            if (typeof requestAnimationFrame !== "function") {
                block.style.removeProperty("opacity");
                block.style.removeProperty("transition");
                return;
            }
            requestAnimationFrame(() => {
                if (!block.isConnected) return;
                block.style.transition = `opacity 280ms ${m3Emphasized}`;
                block.style.opacity = "1";
                setTimeout(() => {
                    if (!block.isConnected) return;
                    if (prevTransition) block.style.transition = prevTransition;
                    else block.style.removeProperty("transition");
                    if (prevOpacity) block.style.opacity = prevOpacity;
                    else block.style.removeProperty("opacity");
                }, 420);
            });
            return;
        }

        // Promote to a compositor layer up-front so the first frame doesn't pop.
        block.style.willChange = "opacity, transform";
        block.style.transition = "none";
        block.style.opacity = "0";
        block.style.transform = "translate3d(0, 6px, 0) scale(0.985)";
        // Synchronous reflow guarantees the "hidden" state is committed before we mutate text.
        void block.offsetWidth;
        runMutate();
        if (typeof requestAnimationFrame !== "function") {
            block.style.removeProperty("opacity");
            block.style.removeProperty("transform");
            block.style.removeProperty("transition");
            block.style.removeProperty("will-change");
            return;
        }
        requestAnimationFrame(() => {
            if (!block.isConnected) return;
            // M3 Expressive: opacity uses Emphasized Decelerate; transform uses a real spring
            // via Chrome-native linear() easing for the signature "쫀쫀" Expressive feel.
            const m3Spring =
                "linear(0, 0.046 4%, 0.196 9%, 0.523 19%, 0.81 28%, 1.012 37%, 1.099 45%, 1.108 53%, 1.069 64%, 1.014 76%, 0.987 86%, 1)";
            block.style.transition = [
                `opacity 280ms ${m3Emphasized}`,
                `transform 380ms ${m3Spring}`,
            ].join(", ");
            block.style.opacity = "1";
            block.style.transform = "translate3d(0, 0, 0) scale(1)";
            setTimeout(() => {
                if (!block.isConnected) return;
                if (prevTransition) block.style.transition = prevTransition;
                else block.style.removeProperty("transition");
                if (prevOpacity) block.style.opacity = prevOpacity;
                else block.style.removeProperty("opacity");
                if (prevTransform) block.style.transform = prevTransform;
                else block.style.removeProperty("transform");
                if (prevWillChange) block.style.willChange = prevWillChange;
                else block.style.removeProperty("will-change");
            }, 420);
        });
    }

    buildDomOriginalDisplayPairs(translated, originalText) {
        const translatedText = String(translated || "").trim();
        const sourceText = String(originalText || "").trim();
        if (!translatedText) return [];
        if (!sourceText || Math.max(translatedText.length, sourceText.length) < 360) {
            return [{ translated: translatedText, original: sourceText || translatedText }];
        }

        const originalChunks = this.splitDomOriginalTooltipText(sourceText);
        if (originalChunks.length <= 1) {
            return [{ translated: translatedText, original: sourceText }];
        }
        const translatedChunks = this.splitDomOriginalTooltipText(
            translatedText,
            Math.max(80, Math.ceil(translatedText.length / originalChunks.length))
        );
        const alignedTranslated =
            translatedChunks.length === originalChunks.length
                ? translatedChunks
                : this.splitTextIntoApproximateCount(translatedText, originalChunks.length);
        if (alignedTranslated.length !== originalChunks.length) {
            return [{ translated: translatedText, original: sourceText }];
        }
        return alignedTranslated.map((chunk, index) => ({
            translated: chunk,
            original: originalChunks[index],
        }));
    }

    splitDomOriginalTooltipText(text, targetLength = 220) {
        const source = String(text || "").trim();
        if (!source) return [];
        const byLine = source
            .split(/\r?\n+/)
            .map((part) => part.trim())
            .filter(Boolean);
        if (byLine.length > 1) return byLine;

        const sentenceParts =
            source
                .match(/[^.!?。！？]+[.!?。！？]?/g)
                ?.map((part) => part.trim())
                .filter(Boolean) || [];
        const parts = sentenceParts.length > 1 ? sentenceParts : source.split(/\s+/);
        if (parts.length <= 1) return [source];

        const chunks = [];
        let current = "";
        parts.forEach((part) => {
            const next = current ? `${current} ${part}` : part;
            if (current && next.length > targetLength) {
                chunks.push(current);
                current = part;
            } else {
                current = next;
            }
        });
        if (current) chunks.push(current);
        return chunks.length ? chunks : [source];
    }

    splitTextIntoApproximateCount(text, count) {
        const source = String(text || "").trim();
        if (!source || count <= 1) return source ? [source] : [];
        const targetLength = Math.max(80, Math.ceil(source.length / count));
        let chunks = this.splitDomOriginalTooltipText(source, targetLength);
        if (chunks.length === count) return chunks;
        if (chunks.length < count) return chunks;

        while (chunks.length > count) {
            let bestIndex = 0;
            let bestLength = Infinity;
            for (let i = 0; i < chunks.length - 1; i++) {
                const combinedLength = chunks[i].length + chunks[i + 1].length;
                if (combinedLength < bestLength) {
                    bestLength = combinedLength;
                    bestIndex = i;
                }
            }
            chunks.splice(bestIndex, 2, `${chunks[bestIndex]} ${chunks[bestIndex + 1]}`);
        }
        return chunks;
    }

    registerDomOriginalText(element, originalText) {
        const text = this.sanitizeDomPageOriginalText(originalText);
        if (!element || !text) return;
        const existing = this._domOriginalTextByElement.get(element);
        const next =
            existing && !existing.includes(text) ? `${existing}\n\n${text}` : existing || text;
        this._domOriginalTextByElement.set(element, next);
        this.ensureDomOriginalTooltipHandlers();
    }

    ensureDomOriginalTooltipHandlers() {
        if (this._domOriginalTooltipHandlers) return;
        this._domOriginalTooltipHandlers = {
            over: (event) => this.handleDomOriginalTooltipOver(event),
            move: (event) => this.trackDomOriginalTooltipShowPointer(event),
            out: (event) => this.handleDomOriginalTooltipOut(event),
        };
        document.addEventListener("mouseover", this._domOriginalTooltipHandlers.over, true);
        document.addEventListener("mousemove", this._domOriginalTooltipHandlers.move, true);
        document.addEventListener("mouseout", this._domOriginalTooltipHandlers.out, true);
    }

    ensureDomOriginalTooltip() {
        if (!this._domOriginalTooltipStyleInjected) {
            this._domOriginalTooltipStyleInjected = true;
            if (!document.getElementById("edge-translate-dom-original-tooltip-style")) {
                const style = document.createElement("style");
                style.id = "edge-translate-dom-original-tooltip-style";
                style.textContent = `
                /* iOS 26 Liquid Glass tooltip — translucent panel that floats over the
                   page with a soft blur, multi-layer highlight, and spring entrance. */
                #edge-translate-dom-original-tooltip {
                    color-scheme: light dark;
                    --etip-glass-base: light-dark(rgba(255, 255, 255, 0.74), rgba(28, 28, 30, 0.66));
                    --etip-edge-top: light-dark(rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0.10));
                    --etip-edge-bottom: light-dark(rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.32));
                    --etip-outline: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.10));
                    --etip-text: light-dark(#1d1d1f, #f2f2f7);
                    --etip-muted: light-dark(#6e6e73, #aeaeb2);
                    --etip-accent: light-dark(#0a84ff, #64d2ff);
                    --etip-spring: linear(0, 0.052 3.3%, 0.197 6.7%, 0.547 14%, 0.832 21.5%, 1.029 29.5%, 1.097 36%, 1.111 43.5%, 1.074 52.5%, 1.018 65%, 0.992 75.5%, 0.999 88.5%, 1);
                }
                .et-dom-original-source {
                    background: light-dark(rgba(10, 132, 255, 0.12), rgba(100, 210, 255, 0.16)) !important;
                    border-radius: 6px !important;
                    box-shadow: 0 0 0 1.5px light-dark(rgba(10, 132, 255, 0.20), rgba(100, 210, 255, 0.28)) !important;
                    cursor: help !important;
                    transition: background 220ms ease, box-shadow 220ms ease !important;
                }
                #edge-translate-dom-original-tooltip {
                    position: fixed;
                    z-index: 2147483647;
                    width: min(480px, calc(100vw - 32px));
                    max-height: min(76vh, calc(100vh - 24px));
                    overflow: hidden auto;
                    overscroll-behavior: contain;
                    box-sizing: border-box;
                    padding: 0;
                    border-radius: 22px;
                    isolation: isolate;
                    background: var(--etip-glass-base);
                    backdrop-filter: blur(40px) saturate(190%) contrast(110%);
                    -webkit-backdrop-filter: blur(40px) saturate(190%) contrast(110%);
                    box-shadow:
                        0 1.5px 0 light-dark(rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.14)) inset,
                        0 -1px 0 var(--etip-edge-bottom) inset,
                        1px 0 0 -0.5px light-dark(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.06)) inset,
                        -1px 0 0 -0.5px light-dark(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.06)) inset,
                        0 0 0 0.5px var(--etip-outline),
                        0 22px 60px rgba(0, 0, 0, 0.22),
                        0 6px 18px rgba(0, 0, 0, 0.10),
                        0 1px 2px rgba(0, 0, 0, 0.12);
                    color: var(--etip-text);
                    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", system-ui, sans-serif;
                    font-size: 14px;
                    line-height: 1.55;
                    letter-spacing: -0.1px;
                    pointer-events: none;
                    opacity: 0;
                    transform: translateY(-8px) scale(0.84);
                    transform-origin: top left;
                    filter: blur(10px) saturate(140%);
                    transition: opacity 240ms ease, transform 420ms var(--etip-spring), filter 280ms ease;
                }
                /* Top-edge sheen + diagonal highlight via pseudo-elements. */
                #edge-translate-dom-original-tooltip::before {
                    content: "";
                    position: absolute;
                    inset: 0;
                    border-radius: inherit;
                    pointer-events: none;
                    background:
                        linear-gradient(180deg, light-dark(rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.06)) 0%, transparent 30%),
                        linear-gradient(135deg, transparent 0%, transparent 55%, light-dark(rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.03)) 100%);
                    mix-blend-mode: screen;
                    z-index: -1;
                }
                #edge-translate-dom-original-tooltip[data-visible="true"] {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                    filter: blur(0) saturate(210%);
                    /* Interactive only while shown, so its long content can be hovered
                       and scrolled; it never blocks the page while hidden. */
                    pointer-events: auto;
                }
                #edge-translate-dom-original-tooltip .et-original-header {
                    position: sticky;
                    top: 0;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 12px 18px 10px;
                    color: var(--etip-muted);
                    background: linear-gradient(180deg, light-dark(rgba(255,255,255,0.18), rgba(28,28,30,0.22)) 0%, light-dark(rgba(255,255,255,0.04), rgba(28,28,30,0.08)) 100%);
                    backdrop-filter: blur(20px) saturate(170%);
                    -webkit-backdrop-filter: blur(20px) saturate(170%);
                    border-bottom: 0.5px solid var(--etip-outline);
                    font-size: 13px;
                    font-weight: 600;
                    letter-spacing: -0.1px;
                }
                #edge-translate-dom-original-tooltip .et-original-icon {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    border-radius: 8px;
                    background: light-dark(rgba(10, 132, 255, 0.14), rgba(100, 210, 255, 0.18));
                    color: var(--etip-accent);
                    font-size: 14px;
                    font-weight: 700;
                    box-shadow:
                        0 0.5px 0 light-dark(rgba(255,255,255,0.55), rgba(255,255,255,0.10)) inset,
                        0 0 0 0.5px light-dark(rgba(10, 132, 255, 0.20), rgba(100, 210, 255, 0.20));
                }
                #edge-translate-dom-original-tooltip .et-original-text {
                    padding: 14px 20px 18px;
                    white-space: pre-wrap;
                    word-break: break-word;
                    font-size: 15px;
                    color: var(--etip-text);
                }
                @media (prefers-reduced-motion: reduce) {
                    #edge-translate-dom-original-tooltip {
                        transition: opacity 100ms ease;
                        transform: none !important;
                        filter: none !important;
                    }
                }
            `;
                document.head.appendChild(style);
            }
        }

        if (!this._domOriginalTooltip) {
            const tooltip = document.createElement("div");
            tooltip.id = "edge-translate-dom-original-tooltip";
            tooltip.setAttribute("role", "tooltip");
            tooltip.setAttribute("aria-hidden", "true");
            tooltip.innerHTML = `
                <div class="et-original-header">
                    <span class="et-original-icon">G</span>
                    <span>원문 텍스트</span>
                </div>
                <div class="et-original-text"></div>
            `;
            document.documentElement.appendChild(tooltip);
            this._domOriginalTooltip = tooltip;
            // The tooltip surface is a plain iOS-style frosted blur owned by its
            // injected CSS (#edge-translate-dom-original-tooltip backdrop-filter).
        }
    }

    getDomOriginalTooltipTarget(target) {
        let element =
            target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
        while (element && element !== document.documentElement) {
            if (this._domOriginalTextByElement.get(element)) return element;
            element = element.parentElement;
        }
        return null;
    }

    handleDomOriginalTooltipOver(event) {
        const tooltip = this._domOriginalTooltip;
        if (tooltip && tooltip.contains(event.target)) {
            // Cursor is over the tooltip itself — keep it open so it can be scrolled.
            this.cancelScheduledHideDomOriginalTooltip();
            return;
        }
        const target = this.getDomOriginalTooltipTarget(event.target);
        if (!target) return;
        if (target === this._domOriginalTooltipTarget) {
            this.cancelScheduledHideDomOriginalTooltip();
            return;
        }
        if (target === this._domOriginalTooltipPendingTarget) {
            this._domOriginalTooltipPendingEvent = event;
            return;
        }
        this.hideDomOriginalTooltip();
        this.scheduleDomOriginalTooltipShow(target, event);
    }

    scheduleDomOriginalTooltipShow(target, event) {
        this.cancelPendingDomOriginalTooltipShow();
        this._domOriginalTooltipPendingTarget = target;
        this._domOriginalTooltipPendingEvent = event;
        this._domOriginalTooltipShowTimer = setTimeout(() => {
            const pendingTarget = this._domOriginalTooltipPendingTarget;
            const pendingEvent = this._domOriginalTooltipPendingEvent;
            this._domOriginalTooltipShowTimer = null;
            this._domOriginalTooltipPendingTarget = null;
            this._domOriginalTooltipPendingEvent = null;
            if (!pendingTarget || !pendingTarget.isConnected) return;
            this.showDomOriginalTooltip(pendingTarget, pendingEvent || event);
        }, this._domOriginalTooltipHoverDelayMs);
    }

    cancelPendingDomOriginalTooltipShow() {
        if (this._domOriginalTooltipShowTimer) {
            clearTimeout(this._domOriginalTooltipShowTimer);
            this._domOriginalTooltipShowTimer = null;
        }
        this._domOriginalTooltipPendingTarget = null;
        this._domOriginalTooltipPendingEvent = null;
    }

    showDomOriginalTooltip(target, event) {
        this.ensureDomOriginalTooltip();
        this._domOriginalTooltipTarget = target;
        target.classList.add("et-dom-original-source");
        const text = this._domOriginalTextByElement.get(target);
        const textElement = this._domOriginalTooltip.querySelector(".et-original-text");
        if (textElement) textElement.textContent = text;
        this._domOriginalTooltip.dataset.visible = "true";
        this._domOriginalTooltip.setAttribute("aria-hidden", "false");
        this.positionDomOriginalTooltip(event);
    }

    handleDomOriginalTooltipOut(event) {
        if (this._domOriginalTooltipPendingTarget) {
            const pendingTarget = this._domOriginalTooltipPendingTarget;
            const related = event.relatedTarget;
            if (!related || !pendingTarget.contains || !pendingTarget.contains(related)) {
                this.cancelPendingDomOriginalTooltipShow();
            }
        }
        const target = this._domOriginalTooltipTarget;
        if (!target) return;
        const related = event.relatedTarget;
        const tooltip = this._domOriginalTooltip;
        // Keep it open while the cursor is over the source segment OR over the tooltip
        // itself (entering/scrolling it), so long originals stay reachable. Hide only
        // when the cursor leaves both — on a short delay so it can cross the gap.
        if (related) {
            if (target.contains && target.contains(related)) {
                this.cancelScheduledHideDomOriginalTooltip();
                return;
            }
            if (tooltip && tooltip.contains && tooltip.contains(related)) {
                this.cancelScheduledHideDomOriginalTooltip();
                return;
            }
        }
        this.scheduleHideDomOriginalTooltip();
    }

    scheduleHideDomOriginalTooltip(delay = this._domOriginalTooltipHideDelayMs) {
        this.cancelScheduledHideDomOriginalTooltip();
        this._domOriginalTooltipHideTimer = setTimeout(() => {
            this._domOriginalTooltipHideTimer = null;
            this.hideDomOriginalTooltip();
        }, delay);
    }

    cancelScheduledHideDomOriginalTooltip() {
        if (this._domOriginalTooltipHideTimer) {
            clearTimeout(this._domOriginalTooltipHideTimer);
            this._domOriginalTooltipHideTimer = null;
        }
    }

    // While a show is pending, keep the latest pointer so the tooltip first appears
    // next to the cursor. Once it's visible it stays put (no cursor-follow) so its
    // scrollbar is reachable.
    trackDomOriginalTooltipShowPointer(event) {
        if (this._domOriginalTooltipPendingTarget) {
            this._domOriginalTooltipPendingEvent = event;
        }
    }

    positionDomOriginalTooltip(event) {
        if (this._domOriginalTooltipPendingTarget) {
            this._domOriginalTooltipPendingEvent = event;
        }
        const tooltip = this._domOriginalTooltip;
        if (!tooltip || tooltip.dataset.visible !== "true") return;
        this._domOriginalTooltipPointer = {
            clientX: event.clientX,
            clientY: event.clientY,
        };
        if (this._domOriginalTooltipMoveRaf) return;
        this._domOriginalTooltipMoveRaf = requestAnimationFrame(() => {
            this._domOriginalTooltipMoveRaf = null;
            this.applyDomOriginalTooltipPosition();
        });
    }

    applyDomOriginalTooltipPosition() {
        const tooltip = this._domOriginalTooltip;
        const pointer = this._domOriginalTooltipPointer;
        if (!tooltip || !pointer || tooltip.dataset.visible !== "true") return;
        const margin = 14;
        const width = tooltip.offsetWidth || 560;
        const height = tooltip.offsetHeight || 220;
        let left = pointer.clientX + 14;
        let top = pointer.clientY + 18;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || width;
        const viewportHeight =
            window.innerHeight || document.documentElement.clientHeight || height;
        if (left + width + margin > viewportWidth) left = pointer.clientX - width - 14;
        if (top + height + margin > viewportHeight) top = pointer.clientY - height - 14;
        tooltip.style.left = `${Math.max(margin, left)}px`;
        tooltip.style.top = `${Math.max(margin, top)}px`;
    }

    hideDomOriginalTooltip() {
        this.cancelPendingDomOriginalTooltipShow();
        this.cancelScheduledHideDomOriginalTooltip();
        if (!this._domOriginalTooltip) return;
        if (this._domOriginalTooltipTarget) {
            this._domOriginalTooltipTarget.classList.remove("et-dom-original-source");
        }
        this._domOriginalTooltip.dataset.visible = "false";
        this._domOriginalTooltip.setAttribute("aria-hidden", "true");
        this._domOriginalTooltipTarget = null;
        this._domOriginalTooltipPointer = null;
    }

    destroyDomOriginalTooltip() {
        if (this._domOriginalTooltipHandlers) {
            document.removeEventListener("mouseover", this._domOriginalTooltipHandlers.over, true);
            document.removeEventListener("mousemove", this._domOriginalTooltipHandlers.move, true);
            document.removeEventListener("mouseout", this._domOriginalTooltipHandlers.out, true);
            this._domOriginalTooltipHandlers = null;
        }
        if (this._domOriginalTooltip) {
            this._domOriginalTooltip.remove();
            this._domOriginalTooltip = null;
        }
        if (this._domOriginalTooltipMoveRaf) {
            cancelAnimationFrame(this._domOriginalTooltipMoveRaf);
            this._domOriginalTooltipMoveRaf = null;
        }
        this.cancelPendingDomOriginalTooltipShow();
        this.cancelScheduledHideDomOriginalTooltip();
        const style = document.getElementById("edge-translate-dom-original-tooltip-style");
        if (style) style.remove();
        this._domOriginalTooltipTarget = null;
        this._domOriginalTooltipStyleInjected = false;
        this._domOriginalTooltipPointer = null;
    }

    buildDomPageTranslationBatches(entries, options = {}) {
        const batchOptions = this.getDomPageBatchOptions(options);
        if (!batchOptions) return [];
        if (!entries.length) return [];
        if (options.smart !== false) {
            const leadOptions = this.getDomPageLeadBatchOptions();
            if (leadOptions && entries.length > leadOptions.maxItems) {
                const leadCount = Math.min(leadOptions.maxEntries, entries.length);
                const leadingEntries = entries.slice(0, leadCount);
                const restEntries = entries.slice(leadCount);
                return [
                    ...this.buildDomPageTranslationBatchesWithLimits(leadingEntries, leadOptions),
                    ...this.buildDomPageTranslationBatchesWithLimits(restEntries, batchOptions),
                ];
            }
        }

        return this.buildDomPageTranslationBatchesWithLimits(entries, batchOptions);
    }

    buildDomPageTranslationBatchesWithLimits(entries, batchOptions) {
        if (!entries.length) return [];
        const { maxItems, maxChars } = batchOptions;

        const batches = [];
        let current = [];
        let currentChars = 0;

        for (const entry of entries) {
            const len = String(entry.sourceText || "").length;
            const wouldOverflowItems = current.length >= maxItems;
            const wouldOverflowChars = current.length > 0 && currentChars + len > maxChars;
            if (wouldOverflowItems || wouldOverflowChars) {
                batches.push(current);
                current = [];
                currentChars = 0;
            }
            current.push(entry);
            currentChars += len;
        }

        if (current.length) batches.push(current);
        this.mergeSmallDomPageTailBatch(batches, batchOptions);
        return batches;
    }

    mergeSmallDomPageTailBatch(batches, batchOptions) {
        if (!batches || batches.length < 2) return;
        const tail = batches[batches.length - 1];
        const previous = batches[batches.length - 2];
        if (!tail || !previous) return;
        const tailChars = tail.reduce(
            (total, entry) => total + String(entry?.sourceText || "").length,
            0
        );
        const previousChars = previous.reduce(
            (total, entry) => total + String(entry?.sourceText || "").length,
            0
        );
        const tinyTailByItems = tail.length <= Math.max(2, Math.floor(batchOptions.maxItems / 8));
        const tinyTailByChars = tailChars <= 600;
        const hasCharRoom = previousChars + tailChars <= batchOptions.maxChars;
        const hasItemRoom = previous.length + tail.length <= batchOptions.maxItems + 8;
        if (!tinyTailByItems || !tinyTailByChars || !hasCharRoom || !hasItemRoom) return;
        previous.push(...tail);
        batches.pop();
    }

    getDomPageTranslatorLabel() {
        return this.getDomPageTranslatorMeta().label;
    }

    getDomPageTranslatorMeta() {
        const model = String(this._domPageTranslateOptions.model || "").trim();
        switch (this._domPageTranslateOptions.engine) {
            case "googleAiStudio":
                return {
                    label: "Google AI Studio",
                    model,
                    logo: this.getProviderLogoHtml("gemini", "Gemini"),
                };
            case "openai":
                return {
                    label: "OpenAI",
                    model,
                    logo: this.getProviderLogoHtml("chatgpt", "ChatGPT"),
                };
            case "openaiCompatible":
                return {
                    label: "OpenAI-compatible",
                    model,
                    logo: this.getProviderLogoHtml("chatgpt", "OpenAI-compatible"),
                };
            default:
                return {
                    label: "Google AI Studio",
                    model,
                    logo: this.getProviderLogoHtml("gemini", "Gemini"),
                };
        }
    }

    getProviderLogoHtml(provider, alt) {
        return `<img class="provider-logo provider-logo-${provider}" src="${this.getBrandAssetUrl(
            `${provider}.svg`
        )}" alt="${alt}" />`;
    }

    getBrandAssetUrl(fileName) {
        if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
            const url = chrome.runtime.getURL(`brand/${fileName}`);
            if (url) return url;
        }
        return `brand/${fileName}`;
    }

    recordDomPageTokenUsage(result) {
        const usage = result && result.tokenUsage;
        if (!usage) return;
        const target = this._domTokenUsage || {};
        for (const key of [
            "inputTokens",
            "outputTokens",
            "reasoningTokens",
            "cachedInputTokens",
            "totalTokens",
        ]) {
            const value = Number(usage[key] || 0);
            if (Number.isFinite(value) && value > 0) {
                target[key] = (Number(target[key] || 0) || 0) + value;
            }
        }
        this._domTokenUsage = target;
        this.updateDomPageBannerStatus();
    }

    getDomPageTokenUsageText() {
        const usage = this._domTokenUsage || {};
        const total = Number(usage.totalTokens || 0);
        if (!Number.isFinite(total) || total <= 0) return "";
        const input = Number(usage.inputTokens || 0);
        const output = Number(usage.outputTokens || 0);
        const reasoning = Number(usage.reasoningTokens || 0);
        const parts = [`${this.formatDomPageTokenCount(total)} tokens`];
        const detail = [];
        if (input > 0) detail.push(`in ${this.formatDomPageTokenCount(input)}`);
        if (output > 0) detail.push(`out ${this.formatDomPageTokenCount(output)}`);
        if (reasoning > 0) detail.push(`think ${this.formatDomPageTokenCount(reasoning)}`);
        if (detail.length) parts.push(`(${detail.join(" / ")})`);
        return parts.join(" ");
    }

    formatDomPageTokenCount(value) {
        const numeric = Number(value || 0);
        if (!Number.isFinite(numeric) || numeric <= 0) return "0";
        if (numeric >= 1000000) return `${(numeric / 1000000).toFixed(1)}M`;
        if (numeric >= 10000) return `${Math.round(numeric / 1000)}K`;
        if (numeric >= 1000) return `${(numeric / 1000).toFixed(1)}K`;
        return String(Math.round(numeric));
    }

    showDomPageBanner() {
        this.ensureDomPageBanner();
        this.updateDomPageBannerStatus();
        this.setDomPageBannerVisible(true);
    }

    ensureDomPageBanner() {
        let host = document.getElementById("edge-translate-dom-page-banner");
        if (!host) {
            host = document.createElement("div");
            host.id = "edge-translate-dom-page-banner";
            host.style.cssText = [
                "position: fixed",
                "top: 0",
                "left: 0",
                "right: 0",
                `height: ${this._domPageBannerHeight}px`,
                "z-index: 2147483647",
                "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
                "pointer-events: none",
                // iOS-18 fluid collapse of the reserved strip when the bar leaves.
                "transition: height 360ms cubic-bezier(0.22, 1, 0.36, 1)",
            ].join(";");
            const root = host.attachShadow({ mode: "open" });
            root.innerHTML = `
                <style>
                    /* iOS 26 Liquid Glass — multi-layer translucency with the signature
                       top-edge highlight, deep saturate+blur, and spring-physics motion. */
                    :host {
                        color-scheme: light dark;
                        /* Apple single accent: Action Blue (#0066cc), Sky Blue on dark. */
                        --et-primary: light-dark(#0066cc, #2997ff);
                        --et-on-primary: #ffffff;
                        --et-primary-container: light-dark(rgba(0, 102, 204, 0.12), rgba(41, 151, 255, 0.20));
                        --et-on-primary-container: light-dark(#0066cc, #cce4ff);
                        /* Liquid Glass tint. Apple HIG's "Regular" Material aim is for
                           text behind to fade into an unreadable wash. We use ~0.72 opacity
                           in light and ~0.62 in dark — high enough to dominate the backdrop
                           but still let saturated color bleed through (the "vibrancy" effect). */
                        --et-glass-base: light-dark(rgba(255, 255, 255, 0.72), rgba(28, 28, 30, 0.62));
                        --et-glass-base-hover: light-dark(rgba(255, 255, 255, 0.80), rgba(44, 44, 46, 0.70));
                        /* Edge reflections: bright top + side highlights, dark bottom shadow
                           to simulate a curved glass dome. */
                        --et-glass-edge-top: light-dark(rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.14));
                        --et-glass-edge-side: light-dark(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.08));
                        --et-glass-edge-bottom: light-dark(rgba(0, 0, 0, 0.10), rgba(0, 0, 0, 0.36));
                        --et-glass-outline: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.10));
                        --et-specular: light-dark(rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.18));
                        --et-surface-container: light-dark(rgba(255, 255, 255, 0.55), rgba(60, 60, 67, 0.40));
                        --et-text: light-dark(#1d1d1f, #f2f2f7);
                        --et-muted: light-dark(#6e6e73, #aeaeb2);
                        --et-success: light-dark(#34c759, #30d158);
                        --et-error: light-dark(#ff3b30, #ff453a);
                        --pulse-color: color-mix(in oklab, var(--et-primary) 36%, transparent);
                        --et-progress-track: light-dark(rgba(120, 120, 128, 0.16), rgba(120, 120, 128, 0.32));
                        /* Apple card radius (DESIGN.md lg = 18px). */
                        --et-radius: 18px;
                        /* iOS-18 elevation: soft, layered, never heavy. */
                        --et-elevation: 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
                        --et-elevation-hover: 0 14px 36px rgba(0, 0, 0, 0.16), 0 4px 12px rgba(0, 0, 0, 0.08);
                        /* Spotlight enter/exit — byte-identical to the result panel's
                           MotionFloatingSpotlightIn / MotionFloatingSpotlightOut. */
                        --et-spotlight-in: 210ms cubic-bezier(0.2, 0, 0, 1);
                        --et-spotlight-out: 170ms cubic-bezier(0.32, 0, 0.67, 0);
                        /* Soft spring for micro-interactions. */
                        --ios-spring-soft: linear(0, 0.018 1.4%, 0.075 3.2%, 0.183 5.7%, 0.351 8.9%, 0.554 13.2%, 0.762 18.6%, 0.929 25.4%, 1.033 33.2%, 1.077 42.2%, 1.066 53.8%, 1.025 68%, 1.005 81.6%, 1);
                        --ios-glide: linear(0, 0.009, 0.035 2.1%, 0.078 3.6%, 0.182 6.7%, 0.323 10.5%, 0.496 14.9%, 0.679 19.8%, 0.84 25.4%, 0.937 31.5%, 0.984 38.3%, 1);
                    }
                    /* iOS-18 header card: a continuous rounded rectangle (not a pill)
                       on clean thin-material glass. One crisp top-edge highlight + a
                       hairline separator + soft layered elevation — no "glass dome"
                       multi-inset stack. The ::after adds a single soft top gloss. */
                    .bar {
                        position: relative;
                        margin: 10px 18px;
                        height: 54px;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 14px;
                        box-sizing: border-box;
                        padding: 0 16px 5px;
                        color: var(--et-text);
                        background: var(--et-glass-base);
                        border-radius: var(--et-radius);
                        font-size: 13px;
                        line-height: 1.2;
                        pointer-events: auto;
                        isolation: isolate;
                        overflow: hidden;
                        /* Clean thin-material frost — strong blur + a touch of saturation
                           for vibrancy, without the harsh contrast push. */
                        backdrop-filter: blur(32px) saturate(185%);
                        -webkit-backdrop-filter: blur(32px) saturate(185%);
                        box-shadow:
                            inset 0 1px 0 var(--et-glass-edge-top),
                            0 0 0 0.5px var(--et-glass-outline),
                            var(--et-elevation);
                        /* Chromium-native enter/exit, iPadOS-Spotlight style: the bar
                           materializes IN PLACE — focusing in from a soft blur with a
                           gentle scale-up and fade, exactly like the result panel — and
                           reverses on exit. No slide. @starting-style animates the first
                           mount; the hidden state (below) is the dismissed target. Pure
                           CSS — filter none↔blur means no compositing layer at rest. */
                        transform: none;
                        opacity: 1;
                        filter: none;
                        transition:
                            transform var(--et-spotlight-in),
                            opacity var(--et-spotlight-in),
                            filter var(--et-spotlight-in),
                            box-shadow 320ms var(--ios-glide),
                            background 280ms ease;
                    }
                    @starting-style {
                        .bar {
                            opacity: 0;
                            transform: scale(0.98);
                            filter: blur(12px) saturate(0.86) brightness(1.04);
                        }
                    }
                    /* Single soft top gloss — the glass catches light at the top edge.
                       Clean and flat, the iOS-18 way (no diagonal corner streak). */
                    .bar::after {
                        content: "";
                        position: absolute;
                        inset: 0;
                        border-radius: inherit;
                        pointer-events: none;
                        background: linear-gradient(180deg, light-dark(rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.05)) 0%, transparent 34%);
                        z-index: 0;
                    }
                    .bar > * { position: relative; z-index: 1; }
                    .bar:hover {
                        transform: translateY(-2px);
                        background: var(--et-glass-base-hover);
                        box-shadow:
                            inset 0 1px 0 var(--et-glass-edge-top),
                            0 0 0 0.5px var(--et-glass-outline),
                            var(--et-elevation-hover);
                    }
                    /* State accents — a tinted hairline + a soft colored lift; the glass
                       surface and top highlight stay constant. */
                    .bar[data-state="starting"],
                    .bar[data-state="running"] {
                        box-shadow:
                            inset 0 1px 0 var(--et-glass-edge-top),
                            0 0 0 0.5px color-mix(in oklab, var(--et-primary) 45%, var(--et-glass-outline)),
                            0 8px 24px color-mix(in oklab, var(--et-primary) 22%, rgba(0, 0, 0, 0.12)),
                            0 2px 8px rgba(0, 0, 0, 0.06);
                    }
                    .bar[data-state="complete"] {
                        box-shadow:
                            inset 0 1px 0 var(--et-glass-edge-top),
                            0 0 0 0.5px color-mix(in oklab, var(--et-success) 45%, var(--et-glass-outline)),
                            0 8px 24px color-mix(in oklab, var(--et-success) 20%, rgba(0, 0, 0, 0.12)),
                            0 2px 8px rgba(0, 0, 0, 0.06);
                    }
                    .bar[data-state="error"] {
                        box-shadow:
                            inset 0 1px 0 var(--et-glass-edge-top),
                            0 0 0 0.5px color-mix(in oklab, var(--et-error) 48%, var(--et-glass-outline)),
                            0 8px 24px color-mix(in oklab, var(--et-error) 22%, rgba(0, 0, 0, 0.12)),
                            0 2px 8px rgba(0, 0, 0, 0.06);
                    }
                    /* Dismissed target — the bar blurs out and eases down in scale in
                       place (Spotlight dismiss); pointer-events off so it never blocks. */
                    :host([data-visible="false"]) .bar {
                        opacity: 0;
                        transform: scale(0.98);
                        filter: blur(10px) saturate(0.88) brightness(1.04);
                        pointer-events: none;
                        /* Exit uses the panel's faster out-curve (the rest state's
                           transition governs the enter direction). */
                        transition:
                            transform var(--et-spotlight-out),
                            opacity var(--et-spotlight-out),
                            filter var(--et-spotlight-out);
                    }
                    .main {
                        display: flex;
                        align-items: center;
                        min-width: 0;
                        gap: 12px;
                    }
                    .status-dot {
                        position: relative;
                        width: 9px;
                        height: 9px;
                        border-radius: 50%;
                        flex: 0 0 auto;
                        background: var(--et-primary);
                        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.4) inset, 0 0 6px color-mix(in oklab, var(--et-primary) 50%, transparent);
                        transition: all 320ms var(--ios-spring-soft);
                    }
                    .bar[data-state="starting"] .status-dot,
                    .bar[data-state="running"] .status-dot {
                        animation: pulse-breath 1.8s ease-in-out infinite;
                    }
                    .text {
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        min-width: 0;
                        gap: 2px;
                    }
                    .summary {
                        display: flex;
                        align-items: center;
                        min-width: 0;
                        gap: 8px;
                    }
                    .title {
                        color: var(--et-text);
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        font-size: 13px;
                        font-weight: 600;
                        letter-spacing: -0.2px;
                    }
                    /* Inset glass pills — slightly recessed via inner shadow so the
                       primary glass surface still dominates. */
                    .provider, .model {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        border-radius: 11px;
                        padding: 2px 10px;
                        height: 22px;
                        box-sizing: border-box;
                        font-size: 11px;
                        font-weight: 600;
                        letter-spacing: -0.1px;
                        background: var(--et-surface-container);
                        backdrop-filter: blur(16px) saturate(180%);
                        -webkit-backdrop-filter: blur(16px) saturate(180%);
                        box-shadow:
                            0 0.5px 0 light-dark(rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.08)) inset,
                            0 -0.5px 0 light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.20)) inset,
                            0 0 0 0.5px light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
                        transition: transform 280ms var(--ios-spring-soft), background 220ms ease;
                    }
                    .provider {
                        color: var(--et-on-primary-container);
                        background: var(--et-primary-container);
                    }
                    .model {
                        color: var(--et-muted);
                    }
                    .provider:hover, .model:hover {
                        transform: translateY(-0.5px) scale(1.025);
                    }
                    .provider span, .model span {
                        min-width: 0;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }
                    .provider-logo {
                        width: 14px;
                        height: 14px;
                        flex: 0 0 auto;
                        object-fit: contain;
                    }
                    .provider-logo-chatgpt {
                        border-radius: 4px;
                    }
                    .status {
                        color: var(--et-muted);
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        max-width: min(50vw, 520px);
                        font-size: 11px;
                        font-weight: 600;
                        letter-spacing: -0.05px;
                    }
                    .actions {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        flex: 0 0 auto;
                    }
                    .progress-meta {
                        min-width: 36px;
                        box-sizing: border-box;
                        color: var(--et-primary);
                        font-size: 11px;
                        font-weight: 600;
                        text-align: right;
                        font-variant-numeric: tabular-nums;
                        letter-spacing: -0.1px;
                    }
                    .bar[data-state="complete"] .progress-meta {
                        color: var(--et-success);
                    }
                    .bar[data-state="error"] .progress-meta {
                        color: var(--et-error);
                    }
                    .token-meta {
                        display: none;
                        max-width: 220px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        box-sizing: border-box;
                        padding: 3px 10px;
                        border-radius: 11px;
                        background: var(--et-surface-container);
                        color: var(--et-muted);
                        font-size: 11px;
                        font-weight: 600;
                        font-variant-numeric: tabular-nums;
                        backdrop-filter: blur(16px) saturate(180%);
                        -webkit-backdrop-filter: blur(16px) saturate(180%);
                        box-shadow:
                            0 0.5px 0 light-dark(rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.06)) inset,
                            0 0 0 0.5px light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.06));
                    }
                    /* Liquid Glass button: convex glass capsule with inset highlight on
                       top edge and a tightly-clipped backdrop blur. */
                    button {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        border: 0;
                        border-radius: 16px;
                        background: var(--et-surface-container);
                        color: var(--et-text);
                        cursor: pointer;
                        font: inherit;
                        height: 32px;
                        padding: 0 12px;
                        font-size: 12px;
                        font-weight: 600;
                        letter-spacing: -0.1px;
                        backdrop-filter: blur(20px) saturate(180%);
                        -webkit-backdrop-filter: blur(20px) saturate(180%);
                        box-shadow:
                            0 0.5px 0 light-dark(rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.08)) inset,
                            0 -0.5px 0 light-dark(rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.22)) inset,
                            0 0 0 0.5px light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
                        transition: transform 280ms var(--ios-spring-soft), background 220ms ease, box-shadow 220ms ease;
                    }
                    button svg {
                        width: 14px;
                        height: 14px;
                        flex: 0 0 auto;
                        fill: currentColor;
                    }
                    button:hover {
                        transform: translateY(-0.5px) scale(1.06);
                        background: light-dark(rgba(255, 255, 255, 0.78), rgba(72, 72, 74, 0.70));
                    }
                    /* Squish on press — non-uniform scale gives a gummy press feel. */
                    button:active {
                        transform: scale(0.92, 1.04);
                        transition-duration: 120ms;
                    }
                    .close {
                        color: var(--et-muted);
                        padding: 0;
                        width: 32px;
                        height: 32px;
                        border-radius: 9999px;
                    }
                    .close:hover {
                        color: var(--et-text);
                        transform: rotate(90deg) scale(1.12);
                    }
                    .close:active {
                        transform: rotate(180deg) scale(0.88);
                    }
                    .progress {
                        position: absolute;
                        left: 22px;
                        right: 22px;
                        bottom: 3px;
                        height: 3px;
                        overflow: hidden;
                        background: var(--et-progress-track);
                        border-radius: 9999px;
                    }
                    /* iOS-18 determinate fill: a clean rounded bar that springs to
                       its width; a glossy highlight sweeps across while running. */
                    .progress-fill {
                        position: relative;
                        width: 0%;
                        height: 100%;
                        background: linear-gradient(90deg,
                            color-mix(in oklab, var(--et-primary) 78%, white),
                            var(--et-primary));
                        border-radius: 9999px;
                        overflow: hidden;
                        box-shadow:
                            0 0 10px color-mix(in oklab, var(--et-primary) 50%, transparent),
                            0 0 0 0.5px rgba(255, 255, 255, 0.30) inset;
                        transition: width 520ms var(--ios-spring-soft), background 280ms ease;
                    }
                    .progress-fill::after {
                        content: "";
                        position: absolute;
                        inset: 0;
                        border-radius: inherit;
                        background: linear-gradient(90deg, transparent 12%, rgba(255, 255, 255, 0.5) 50%, transparent 88%);
                        transform: translateX(-100%);
                        opacity: 0;
                    }
                    .bar[data-state="running"] .progress-fill::after {
                        opacity: 1;
                        animation: progress-sheen 1.9s var(--ios-glide) infinite;
                    }
                    /* iOS-18 indeterminate: a short rounded pill glides across the
                       track on a soft ease while the run spins up. */
                    .bar[data-state="starting"] .progress-fill {
                        width: 42% !important;
                        background: linear-gradient(90deg,
                            transparent,
                            color-mix(in oklab, var(--et-primary) 80%, white) 35%,
                            var(--et-primary) 50%,
                            color-mix(in oklab, var(--et-primary) 80%, white) 65%,
                            transparent);
                        box-shadow: 0 0 10px color-mix(in oklab, var(--et-primary) 42%, transparent);
                        animation: progress-indeterminate 1.5s var(--ios-glide) infinite;
                    }
                    .bar[data-state="error"] .status-dot {
                        background: var(--et-error);
                        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.4) inset, 0 0 8px color-mix(in oklab, var(--et-error) 55%, transparent);
                    }
                    .bar[data-state="error"] .progress-fill {
                        width: 100%;
                        background: linear-gradient(90deg, var(--et-error), color-mix(in oklab, var(--et-error) 70%, white));
                        box-shadow: 0 0 8px color-mix(in oklab, var(--et-error) 40%, transparent);
                    }
                    .bar[data-state="complete"] .status-dot {
                        background: var(--et-success);
                        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.4) inset, 0 0 8px color-mix(in oklab, var(--et-success) 55%, transparent);
                    }
                    .bar[data-state="complete"] .progress-fill {
                        background: linear-gradient(90deg, var(--et-success), color-mix(in oklab, var(--et-success) 70%, white));
                        box-shadow: 0 0 8px color-mix(in oklab, var(--et-success) 40%, transparent);
                    }
                    /* Restore floater — mini Liquid Glass pill that lives at the top
                       when the banner is hidden. */
                    .restore {
                        position: fixed;
                        top: 10px;
                        right: 16px;
                        display: none;
                        align-items: center;
                        gap: 6px;
                        height: 34px;
                        padding: 0 15px;
                        border-radius: 17px;
                        background: var(--et-glass-base);
                        color: var(--et-primary);
                        font: inherit;
                        font-size: 12px;
                        font-weight: 600;
                        letter-spacing: -0.1px;
                        pointer-events: auto;
                        backdrop-filter: blur(32px) saturate(185%);
                        -webkit-backdrop-filter: blur(32px) saturate(185%);
                        box-shadow:
                            inset 0 1px 0 var(--et-glass-edge-top),
                            0 0 0 0.5px var(--et-glass-outline),
                            var(--et-elevation);
                        /* Dismissed resting state; the visible state transitions in
                           with the same Spotlight blur-scale as the bar. The
                           "display ... allow-discrete" transition animates the
                           display none↔inline-flex toggle the Chromium-native way. */
                        opacity: 0;
                        transform: scale(0.9);
                        filter: blur(8px);
                        transition:
                            transform var(--et-spotlight-in),
                            opacity var(--et-spotlight-in),
                            filter var(--et-spotlight-in),
                            box-shadow var(--et-spotlight-in),
                            display 210ms allow-discrete;
                    }
                    :host([data-visible="false"]) .restore {
                        display: inline-flex;
                        opacity: 1;
                        transform: none;
                        filter: none;
                    }
                    @starting-style {
                        :host([data-visible="false"]) .restore {
                            opacity: 0;
                            transform: scale(0.9);
                            filter: blur(8px);
                        }
                    }
                    .restore:hover {
                        transform: translateY(-1px);
                        box-shadow:
                            inset 0 1px 0 var(--et-glass-edge-top),
                            0 0 0 0.5px var(--et-glass-outline),
                            var(--et-elevation-hover);
                    }
                    .restore:active {
                        transform: scale(0.94);
                    }
                    .sr-only {
                        position: absolute;
                        width: 1px;
                        height: 1px;
                        padding: 0;
                        margin: -1px;
                        overflow: hidden;
                        clip: rect(0, 0, 0, 0);
                        white-space: nowrap;
                        border: 0;
                    }
                    /* Indeterminate pill travelling across the track. */
                    @keyframes progress-indeterminate {
                        0%   { transform: translateX(-120%); }
                        100% { transform: translateX(280%); }
                    }
                    /* Gloss highlight sweeping across the determinate fill, with a
                       brief pause at the far edge between passes. */
                    @keyframes progress-sheen {
                        0%        { transform: translateX(-100%); }
                        65%, 100% { transform: translateX(100%); }
                    }
                    @keyframes pulse-breath {
                        0% {
                            transform: scale(0.88);
                            box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.45) inset, 0 0 0 0px var(--pulse-color), 0 0 4px var(--pulse-color);
                        }
                        50% {
                            transform: scale(1.18);
                            box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.45) inset, 0 0 0 10px transparent, 0 0 12px color-mix(in oklab, var(--et-primary) 60%, transparent);
                        }
                        100% {
                            transform: scale(0.88);
                            box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.45) inset, 0 0 0 0px transparent, 0 0 4px var(--pulse-color);
                        }
                    }
                    @media (max-width: 640px) {
                        .bar {
                            margin: 8px 8px;
                            gap: 8px;
                            padding-left: 12px;
                            padding-right: 8px;
                        }
                        .provider { max-width: 100px; }
                        .model { max-width: 100px; }
                        .status { max-width: 32vw; }
                        .token-meta { max-width: 100px; }
                        .progress-meta { display: none; }
                        .hide .button-text { display: none; }
                    }
                    @media (prefers-reduced-motion: reduce) {
                        .progress-fill,
                        button {
                            transition: none;
                        }
                        .bar,
                        .restore,
                        :host([data-visible="false"]) .bar,
                        :host([data-visible="false"]) .restore {
                            transition: none;
                        }
                        .bar[data-state="starting"] .progress-fill {
                            animation: none;
                            transform: none;
                            width: 100% !important;
                        }
                        .bar[data-state="running"] .progress-fill::after {
                            animation: none;
                            opacity: 0;
                        }
                        .bar[data-state="starting"] .status-dot,
                        .bar[data-state="running"] .status-dot {
                            animation: none;
                        }
                    }
                </style>
                <div class="bar" role="status" aria-live="polite" data-role="bar">
                    <div class="main">
                        <span class="status-dot" aria-hidden="true"></span>
                        <div class="text">
                            <div class="summary">
                                <span class="title" data-role="title">AI Page Translation</span>
                                <span class="provider" data-role="engine"></span>
                                <span class="model" data-role="model"></span>
                            </div>
                            <span class="status" data-role="status"></span>
                        </div>
                    </div>
                    <div class="actions">
                        <span class="token-meta" data-role="token-meta"></span>
                        <span class="progress-meta" data-role="progress-meta"></span>
                        <button type="button" class="hide" data-action="hide" aria-label="Hide translation bar">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M2.1 3.51 3.51 2.1 21.9 20.49l-1.41 1.41-3.08-3.08A11.46 11.46 0 0 1 12 20C7 20 2.73 16.89 1 12.5a11.82 11.82 0 0 1 4.2-5.34L2.1 3.51Zm5.66 6.25A4.68 4.68 0 0 0 7.5 12a4.5 4.5 0 0 0 4.5 4.5c.78 0 1.51-.2 2.15-.55l-1.69-1.69a2.48 2.48 0 0 1-2.72-2.72L7.76 9.76ZM12 5c5 0 9.27 3.11 11 7.5a11.7 11.7 0 0 1-3.18 4.35l-2.84-2.84c.33-.61.52-1.29.52-2.01A4.5 4.5 0 0 0 12 7.5c-.72 0-1.4.19-2.01.52L7.82 5.85A11.57 11.57 0 0 1 12 5Zm0 4.5A2.5 2.5 0 1 1 14.5 12c0 .16-.02.32-.05.47L11.53 9.55c.15-.03.31-.05.47-.05Z" />
                            </svg>
                            <span class="button-text">Hide</span>
                        </button>
                        <button type="button" class="close" data-action="close" aria-label="Close translation">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M18.3 5.71 16.89 4.3 12 9.17 7.11 4.3 5.7 5.71 10.59 10.6 5.7 15.49l1.41 1.41L12 12.03l4.89 4.87 1.41-1.41-4.89-4.89 4.89-4.89Z" />
                            </svg>
                        </button>
                    </div>
                    <div class="progress" aria-hidden="true">
                        <div class="progress-fill" data-role="progress-fill"></div>
                    </div>
                </div>
                <button type="button" class="restore" data-action="show">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 5c5 0 9.27 3.11 11 7.5C21.27 16.89 17 20 12 20S2.73 16.89 1 12.5C2.73 8.11 7 5 12 5Zm0 2C8.29 7 5.11 9.1 3.18 12.5 5.11 15.9 8.29 18 12 18s6.89-2.1 8.82-5.5C18.89 9.1 15.71 7 12 7Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
                    </svg>
                    <span>Show translation</span>
                </button>
            `;
            root.querySelector("[data-action='hide']").addEventListener("click", () => {
                this.setDomPageBannerVisible(false);
            });
            root.querySelector("[data-action='show']").addEventListener("click", () => {
                this.setDomPageBannerVisible(true);
            });
            root.querySelector("[data-action='close']").addEventListener("click", () => {
                this.cancelDomPageTranslate();
            });
            // The bar and restore pill are plain iOS-style frosted blur surfaces;
            // their backdrop-filter, edge shadows and sheen live in the injected
            // CSS above (.bar / .restore). No engine, no pointer-tracking effects.
            (document.documentElement || document.body).appendChild(host);
            // Ease the page-content shift (movePage drives body { top }) so the
            // page glides up/down in step with the bar's spring, iOS-18 style.
            if (!document.getElementById("edge-translate-page-shift-style")) {
                const shiftStyle = document.createElement("style");
                shiftStyle.id = "edge-translate-page-shift-style";
                shiftStyle.textContent =
                    "body{transition:top 360ms cubic-bezier(0.22,1,0.36,1)!important;}" +
                    "@media (prefers-reduced-motion:reduce){body{transition:none!important;}}";
                (document.head || document.documentElement).appendChild(shiftStyle);
            }
        }
        this._domPageBanner = host;
        return host;
    }

    setDomPageBannerVisible(visible) {
        const host = this.ensureDomPageBanner();
        this._domPageBannerVisible = visible;
        host.style.display = "block";
        host.dataset.visible = visible ? "true" : "false";
        // Toggling data-visible drives the bar/restore CSS state transitions; the
        // host height + page shift ease in step via their own CSS transitions
        // (host `transition: height`, injected `body { transition: top }`). All
        // native — no JS timers coordinating the motion.
        host.style.height = visible ? `${this._domPageBannerHeight}px` : "0";
        this.movePage("top", visible ? this._domPageBannerHeight : 0, true);
    }

    /**
     * Schedule a banner repaint. Called from many spots (every entry completion);
     * coalesces multiple updates in the same JS turn into a single rAF flush.
     */
    updateDomPageBannerStatus(state, message) {
        if (state === "error") {
            // Errors are explicit user-visible state changes; paint immediately.
            this._domBannerPendingError = { message: message || "" };
            this.flushDomPageBannerStatus();
            return;
        }
        if (this._domBannerRafScheduled) return;
        this._domBannerRafScheduled = true;
        const run = () => {
            this._domBannerRafScheduled = false;
            this.flushDomPageBannerStatus();
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 16);
    }

    getDomPageBannerRefs() {
        if (this._domBannerRefs && this._domBannerRefs.host?.isConnected) {
            return this._domBannerRefs;
        }
        const host =
            this._domPageBanner || document.getElementById("edge-translate-dom-page-banner");
        if (!host || !host.shadowRoot) return null;
        const root = host.shadowRoot;
        const refs = {
            host,
            bar: root.querySelector("[data-role='bar']"),
            engine: root.querySelector("[data-role='engine']"),
            model: root.querySelector("[data-role='model']"),
            status: root.querySelector("[data-role='status']"),
            progressFill: root.querySelector("[data-role='progress-fill']"),
            progressMeta: root.querySelector("[data-role='progress-meta']"),
            tokenMeta: root.querySelector("[data-role='token-meta']"),
        };
        if (!refs.bar || !refs.status) return null;
        this._domBannerRefs = refs;
        // Initialize last-rendered snapshot so the first flush always paints.
        this._domBannerLastRendered = {};
        this._domBannerEngineRendered = "";
        return refs;
    }

    flushDomPageBannerStatus() {
        const refs = this.getDomPageBannerRefs();
        if (!refs) return;
        const meta = this.getDomPageTranslatorMeta();
        // Engine label and model name don't change mid-session — write once.
        const engineKey = `${meta.label}|${meta.logo}|${meta.model || ""}`;
        if (engineKey !== this._domBannerEngineRendered) {
            this._domBannerEngineRendered = engineKey;
            if (refs.engine) {
                refs.engine.innerHTML = `${meta.logo}<span data-role="engine-label">${meta.label}</span>`;
            }
            if (refs.model) {
                refs.model.textContent = meta.model || "";
                refs.model.hidden = !meta.model;
            }
        }
        const tokenText = this.getDomPageTokenUsageText();
        const last = this._domBannerLastRendered;
        if (this._domBannerPendingError) {
            const message = this._domBannerPendingError.message;
            this._domBannerPendingError = null;
            const statusText = message
                ? `Translation failed: ${String(message).slice(0, 120)}`
                : "Translation failed";
            if (last.state !== "error") {
                refs.bar.dataset.state = "error";
                last.state = "error";
            }
            if (last.statusText !== statusText) {
                refs.status.textContent = statusText;
                last.statusText = statusText;
            }
            if (refs.progressFill && last.fillWidth !== "100%") {
                refs.progressFill.style.width = "100%";
                last.fillWidth = "100%";
            }
            if (refs.progressMeta && last.percentText !== "Error") {
                refs.progressMeta.textContent = "Error";
                last.percentText = "Error";
            }
            this.applyTokenMetaText(refs.tokenMeta, tokenText, last);
            return;
        }
        this.applyTokenMetaText(refs.tokenMeta, tokenText, last);
        const total = this._domTotalTranslationEntries;
        if (!total) {
            if (last.state !== "starting") {
                refs.bar.dataset.state = "starting";
                last.state = "starting";
            }
            const startingText = "Preparing page text";
            if (last.statusText !== startingText) {
                refs.status.textContent = startingText;
                last.statusText = startingText;
            }
            if (refs.progressFill && last.fillWidth !== "") {
                refs.progressFill.style.width = "";
                last.fillWidth = "";
            }
            if (refs.progressMeta && last.percentText !== "") {
                refs.progressMeta.textContent = "";
                last.percentText = "";
            }
            return;
        }
        const completed = Math.min(this._domCompletedTranslationEntries, total);
        const percent = Math.round((completed / total) * 100);
        const nextState = completed >= total ? "complete" : "running";
        if (last.state !== nextState) {
            refs.bar.dataset.state = nextState;
            last.state = nextState;
        }
        const nextStatus =
            completed >= total ? "Translation complete" : `${completed} of ${total} translated`;
        if (last.statusText !== nextStatus) {
            refs.status.textContent = nextStatus;
            last.statusText = nextStatus;
        }
        const nextFill = `${percent}%`;
        if (refs.progressFill && last.fillWidth !== nextFill) {
            refs.progressFill.style.width = nextFill;
            last.fillWidth = nextFill;
        }
        if (refs.progressMeta && last.percentText !== nextFill) {
            refs.progressMeta.textContent = nextFill;
            last.percentText = nextFill;
        }
    }

    applyTokenMetaText(tokenMeta, tokenText, last) {
        if (!tokenMeta) return;
        if (last.tokenText === tokenText) return;
        last.tokenText = tokenText;
        tokenMeta.textContent = tokenText;
        tokenMeta.title = tokenText ? `API token usage: ${tokenText}` : "";
        tokenMeta.style.display = tokenText ? "inline-flex" : "none";
    }

    markDomPageTranslationEntriesCompleted(count = 1) {
        this._domCompletedTranslationEntries += count;
        this.updateDomPageBannerStatus();
    }

    cancelDomPageTranslate() {
        if (this._domTranslationQueue) this._domTranslationQueue.length = 0;
        this._pendingNodes.clear();
        if (this._scheduleBatch) {
            cancelAnimationFrame(this._scheduleBatch);
            this._scheduleBatch = null;
        }
        if (this._domCoverageScanTimer) {
            clearTimeout(this._domCoverageScanTimer);
            this._domCoverageScanTimer = null;
        }
        if (this._domIncrementalScanTimer) {
            clearTimeout(this._domIncrementalScanTimer);
            this._domIncrementalScanTimer = null;
        }
        if (this._domScrollScanHandler) {
            window.removeEventListener("scroll", this._domScrollScanHandler, true);
            document.removeEventListener("scroll", this._domScrollScanHandler, true);
            window.removeEventListener("resize", this._domScrollScanHandler);
            this._domScrollScanHandler = null;
        }
        if (this._mo) {
            this._mo.disconnect();
            this._mo = null;
        }
        const host = document.getElementById("edge-translate-dom-page-banner");
        if (host) host.remove();
        const shiftStyle = document.getElementById("edge-translate-page-shift-style");
        if (shiftStyle) shiftStyle.remove();
        this.destroyDomOriginalTooltip();
        this._domPageBanner = null;
        this._domBannerRefs = null;
        this._domBannerLastRendered = null;
        this._domBannerEngineRendered = "";
        this._domTranslationCache.clear();
        this._domTotalTranslationEntries = 0;
        this._domCompletedTranslationEntries = 0;
        this.resetDomPageRuntimeState();
        this._domCoverageScanCount = 0;
        this._domCoverageStableScanCount = 0;
        this._domOwnMutationSuppressUntil = 0;
        this._domTokenUsage = {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
        };
        if (this.currentTranslator === "dom") this.currentTranslator = null;
        this.movePage("top", 0, true);
    }

    /**
     * Toggle the visibility of banner frame.
     *
     * @param {boolean} visible the visibility of banner frame.
     * @returns {void} nothing
     */
    toggleBannerFrame(visible) {
        switch (this.currentTranslator) {
            case "google": {
                let banner = document.getElementById(":0.container");
                if (banner !== null && banner !== undefined) {
                    banner.style.visibility = visible ? "visible" : "hidden";
                    return;
                }
                break;
            }
            default:
                break;
        }
    }

    /**
     * Move the page body.
     *
     * @param {String} property indicates which style property to use for moving. Google uses "top".
     *
     * @param {Number} distance the distance to move.
     * @param {boolean} absolute whether the distance is relative or absolute.
     */
    movePage(property, distance, absolute) {
        let orig = document.body.style.getPropertyValue(property);
        const current = parseInt(orig || "0", 10) || 0;
        const target = absolute ? distance : current + distance;
        if (current === target) return;
        if (this._moveRaf) cancelAnimationFrame(this._moveRaf);
        this._moveRaf = requestAnimationFrame(() => {
            try {
                const nextRule = `${property}: ${target}px !important;`;
                const pattern = new RegExp(`${property}:.*;`, "g");
                if (pattern.test(document.body.style.cssText)) {
                    document.body.style.cssText = document.body.style.cssText.replace(
                        pattern,
                        nextRule
                    );
                } else {
                    document.body.style.setProperty(property, `${target}px`, "important");
                }
            } catch {
                document.body.style.setProperty(property, `${target}px`, "important");
            }
        });
    }

    /**
     * Handle messages sent by Google page translator.
     *
     * @param {Object} msg the message content.
     * @returns {void} nothing
     */
    googleMessageHandler(msg) {
        let data;
        try {
            if (typeof msg.data !== "string") return;
            data = JSON.parse(msg.data);
        } catch {
            return;
        }
        if (!data.type || data.type !== "edge_translate_page_translate_event") return;

        switch (data.event) {
            case "page_moved":
                // The "page_moved" event may be sent when the banner is created or destroyed.
                // If the distance property is positive, it means the banner is created, and
                // the page has been moved down. Else if it is negative, it means the banner is
                // destroyed, and the banner has been moved up.
                // Skip duplicate distances to avoid redundant layout work
                if (typeof data.distance === "number" && data.distance === this.lastDistance) {
                    break;
                }
                this.lastDistance = data.distance;

                getOrSetDefaultSettings("HidePageTranslatorBanner", DEFAULT_SETTINGS).then(
                    (result) => {
                        if (result.HidePageTranslatorBanner) {
                            this.toggleBannerFrame(false);
                            // Keep top at 0px.
                            this.movePage("top", 0, true);
                        } else if (data.distance > 0) {
                            // Ensure page is positioned for banner if user allows it
                            this.toggleBannerFrame(true);
                            this.movePage("top", 40, true);
                        }
                    }
                );

                // If the banner is destroyed, we should cancel listeners.
                if (data.distance <= 0) {
                    if (this.canceller) this.canceller();
                    this.canceller = null;
                    this.currentTranslator = null;
                }
                break;
            default:
                break;
        }
    }

    /**
     * Toggle the visibility of the banner.
     *
     * @returns {void} nothing
     */
    toggleBanner() {
        if (!this.currentTranslator) return;

        if (this.currentTranslator === "dom") {
            this.setDomPageBannerVisible(!this._domPageBannerVisible);
            return;
        }

        getOrSetDefaultSettings("HidePageTranslatorBanner", DEFAULT_SETTINGS).then((result) => {
            result.HidePageTranslatorBanner = !result.HidePageTranslatorBanner;
            chrome.storage.sync.set(result);

            switch (this.currentTranslator) {
                case "google": {
                    if (result.HidePageTranslatorBanner) {
                        // Hide the banner.
                        this.toggleBannerFrame(false);
                        this.movePage("top", 0, true);
                    } else {
                        // Show the banner.
                        this.toggleBannerFrame(true);
                        this.movePage("top", 40, true);
                    }
                    break;
                }
                default:
                    break;
            }
        });
    }

    resolveDomPageSourceLanguage(configuredSourceLanguage) {
        if (configuredSourceLanguage && configuredSourceLanguage !== "auto") {
            return toChromeTranslatorLanguage(configuredSourceLanguage);
        }

        const pageLanguage =
            document.documentElement?.getAttribute("lang") ||
            document.body?.getAttribute("lang") ||
            document
                .querySelector("meta[http-equiv='content-language']")
                ?.getAttribute("content") ||
            "";
        const normalized = toChromeTranslatorLanguage(pageLanguage);
        if (normalized && normalized !== "auto") return normalized;
        return configuredSourceLanguage || "auto";
    }

    /**
     * Start DOM fallback translation observer with aggressive filtering.
     */
    startDomFallback() {
        if (this._mo) return;
        this._mo = new MutationObserver((mutations) => {
            let shouldScan = false;
            for (const m of mutations) {
                if (!this.domPageMutationHasTranslatableCandidate(m)) continue;
                shouldScan = true;
                if (m.type === "characterData") this.releaseAiPageSectionElement(m.target);
            }
            if (!shouldScan) return;
            this._domCoverageStableScanCount = 0;
            this._domPageRootElements = this.getDomPageTranslationRoots();
            // Coalesce mutation bursts (SPA re-renders, lazy-load) into ONE dispatch so newly
            // added content is bundled into fewer, larger requests instead of a stream of tiny
            // ones — fewer per-request overheads, fewer tokens.
            this.scheduleDomPageIncrementalScan(280);
        });
        this._mo.observe(document.documentElement || document.body, {
            subtree: true,
            childList: true,
            characterData: true,
        });
        // Wait for the scroll to settle, then dispatch the newly revealed content as one
        // bundle rather than firing a fresh request set on every scroll tick.
        this._domScrollScanHandler = () => this.scheduleDomPageIncrementalScan(360);
        window.addEventListener("scroll", this._domScrollScanHandler, {
            passive: true,
            capture: true,
        });
        document.addEventListener("scroll", this._domScrollScanHandler, {
            passive: true,
            capture: true,
        });
        window.addEventListener("resize", this._domScrollScanHandler, { passive: true });
    }

    /**
     * Translate a batch of text nodes with block-level context first.
     * Nodes are sorted by DOM document order to ensure top-to-bottom translation.
     */
    translateBatchNodes(nodes) {
        if (this._domCircuitBreakerActive) return;
        // AI engines go through the section-level path: no markers, no per-block batching,
        // one LLM call per semantic section, raw HTML in / raw HTML out. The text-node
        // collection that fed this function is ignored — the section collector walks the
        // root containers directly so the model sees full structural context.
        const engine = this._domPageTranslateOptions && this._domPageTranslateOptions.engine;
        if (this.isAiDomPageEngine(engine)) {
            this.dispatchAiPageSections();
            return;
        }
        const eligibleNodes = [];
        for (const n of nodes) {
            const p = n.parentElement;
            if (!p || this._translatedSet.has(n) || this._domPendingTextNodes.has(n)) continue;
            let ancestor = p;
            let insideTranslatedBlock = false;
            while (ancestor && ancestor !== document.documentElement) {
                if (this._translatedBlocks.has(ancestor)) {
                    insideTranslatedBlock = true;
                    break;
                }
                ancestor = ancestor.parentElement;
            }
            if (insideTranslatedBlock) continue;
            const text = String(n.nodeValue || "").trim();
            if (text.length < 2) continue;
            eligibleNodes.push(n);
            this._domPendingTextNodes.add(n);
        }
        if (!eligibleNodes.length) return;

        const groupOptions = this.getDomPageTranslationGroupOptions();
        const groups = buildContextTranslationGroups(eligibleNodes, groupOptions);
        if (!groups.length) {
            eligibleNodes.forEach((node) => this._domPendingTextNodes.delete(node));
            return;
        }
        if (this.getDomPageBatchOptions()) {
            const rawEntries = groups.map((group) => this.createDomPageTranslationEntry(group));
            // HTML-native dedupe: when buildContextTranslationGroups splits one block into
            // multiple groups, the same block would produce several htmlMode entries pointing
            // at the same element. Drop duplicates so we don't burn tokens re-translating
            // identical innerHTML and so concurrent applies don't race.
            const seenHtmlBlocks = new WeakSet();
            const entries = [];
            for (const entry of rawEntries) {
                if (entry.htmlMode && entry.htmlElement) {
                    if (seenHtmlBlocks.has(entry.htmlElement)) continue;
                    seenHtmlBlocks.add(entry.htmlElement);
                }
                entries.push(entry);
            }
            entries.forEach((entry) => this.assignDomPageApplySequence(entry));
            const uncachedEntries = [];
            entries.forEach((entry) => {
                const cached = this._domTranslationCache.get(entry.cacheKey);
                if (cached) {
                    this.queueDomPageEntryApply(entry, cached);
                    return;
                }
                uncachedEntries.push(entry);
            });
            // Deduplicate: same sourceText (cacheKey) → translate once, fan out to siblings.
            // Lowered threshold to 12 because typical articles repeat boilerplate (navigation
            // labels, "Share", "Read more", date stamps, footer links) and the bucketing cost
            // is negligible vs. the savings on every avoided API call.
            let primaries = uncachedEntries;
            if (uncachedEntries.length >= 12) {
                primaries = [];
                const duplicateBuckets = new Map();
                for (const entry of uncachedEntries) {
                    if (!entry.cacheKey) {
                        primaries.push(entry);
                        continue;
                    }
                    if (!duplicateBuckets.has(entry.cacheKey)) {
                        duplicateBuckets.set(entry.cacheKey, []);
                        primaries.push(entry);
                    } else {
                        duplicateBuckets.get(entry.cacheKey).push(entry);
                    }
                }
                this._domDuplicateEntries = duplicateBuckets;
            } else {
                this._domDuplicateEntries.clear();
            }
            // Sort by viewport proximity so visible content translates first.
            this.prioritizeDomPageEntriesByViewport(primaries);
            const batches = this.buildDomPageTranslationBatches(primaries);
            this._domTotalTranslationEntries += batches.length;
            this.updateDomPageBannerStatus();
            this.logDomPageDebug("batch-mode", {
                groups: groups.length,
                batches: batches.length,
                entries: uncachedEntries.length,
            });
            batches.forEach((batch) => this.enqueueDomPageBatchTranslation(batch));
            return;
        }
        this._domTotalTranslationEntries += groups.length;
        this.updateDomPageBannerStatus();
        groups.forEach((group) => {
            const entry = this.createDomPageTranslationEntry(group);
            this.enqueueDomPageGroupTranslation(entry.group);
        });
    }

    enqueueDomPageBatchTranslation(entries, options = {}) {
        const run = async () => {
            if (this._domCircuitBreakerActive) {
                entries.forEach((entry) => this.skipDomPageEntryApply(entry));
                this.markDomPageTranslationEntriesCompleted();
                return;
            }
            this._domActiveTranslations += 1;
            // Subscribe to streaming progress for this batch: apply each completed segment to the
            // DOM the moment it lands so the user sees text appear progressively. Falls back to
            // the standard "wait then apply" path if the channel doesn't emit (e.g. cache hit).
            const streamId = `et-stream-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
            const appliedSegmentIndices = new Set();
            const streamHandler = (event) => {
                if (!event || event.streamId !== streamId) return;
                this.applyStreamedBatchSegments(entries, event.text, appliedSegmentIndices);
            };
            try {
                this.channel.on("translation_stream_progress", streamHandler);
            } catch {
                /* channel may not expose .on in some test contexts */
            }
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const batchedSourceText = buildSegmentedTranslationText(entries);
                const startedAt = Date.now();
                this.logDomPageDebug("batch-request:start", {
                    entries: entries.length,
                    chars: batchedSourceText.length,
                });
                const result = await this.translateWithDomPageEngine(
                    batchedSourceText,
                    sl,
                    tl,
                    streamId
                );
                this.recordDomPageTokenUsage(result);
                this.logDomPageDebug("batch-request:response", {
                    entries: entries.length,
                    durationMs: Date.now() - startedAt,
                    failed: Boolean(result && result.translationFailed),
                    translatedChars: String(
                        (result && (result.mainMeaning || result.translatedText)) || ""
                    ).length,
                    error: result && result.translationFailed ? result.errorMsg || "" : "",
                });
                if (result && result.translationFailed) {
                    throw new Error(result.errorMsg || "Page translation request failed.");
                }
                const translated = result.mainMeaning || result.translatedText;
                const translatedParts = splitSegmentedTranslationText(translated, entries.length);

                if (!translatedParts) {
                    this.recordDomPageBatchFailure();
                    if (entries.length > 1) {
                        const mid = Math.ceil(entries.length / 2);
                        this.enqueueDomPageBatchTranslation(entries.slice(mid), { front: true });
                        this.enqueueDomPageBatchTranslation(entries.slice(0, mid), { front: true });
                    } else if (
                        this.shouldUsePlainDomPageNodeFallback(entries[0], "marker-missing")
                    ) {
                        this.fallbackDomPageEntryToPlainNodes(entries[0]);
                    } else {
                        [...entries]
                            .reverse()
                            .forEach((entry) =>
                                this.enqueueDomPageGroupTranslation(entry.group, 0, { front: true })
                            );
                    }
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }

                let rejectedEntryCount = 0;
                entries.forEach((entry, index) => {
                    const part = translatedParts[index];
                    // If the streaming handler already applied this entry mid-stream, skip; the
                    // final response is just confirmation. (preparedParts/Fragment are cleared
                    // on each new validation, so we use the translated-set check instead.)
                    if (appliedSegmentIndices.has(index)) return;
                    const rejectionReason = this.getDomPageEntryRejectionReason(entry, part);
                    if (!rejectionReason) {
                        this.queueDomPageEntryApply(entry, part);
                    } else {
                        rejectedEntryCount += 1;
                        this.retryDomPageEntryTranslation(entry, 0, { reason: rejectionReason });
                    }
                });
                if (rejectedEntryCount > 0) this.recordDomPageBatchFailure();
                else this.recordDomPageBatchSuccess();
                this.markDomPageTranslationEntriesCompleted();
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this.recordDomPageBatchFailure();
                if (entries.length > 1 && this._domBatchFailureCount < 5) {
                    const mid = Math.ceil(entries.length / 2);
                    // 1 batch became 2 sub-batches; reserve a slot for the extra unit.
                    this._domTotalTranslationEntries += 1;
                    this.enqueueDomPageBatchTranslation(entries.slice(mid), { front: true });
                    this.enqueueDomPageBatchTranslation(entries.slice(0, mid), { front: true });
                } else {
                    entries.forEach((entry) => this.retryDomPageEntryTranslation(entry, 0));
                }
                this.markDomPageTranslationEntriesCompleted();
            } finally {
                try {
                    this.channel.off("translation_stream_progress", streamHandler);
                } catch {
                    /* noop */
                }
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        if (options.front) this._domTranslationQueue.unshift(run);
        else this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    /**
     * Scan an in-flight streamed batch response for newly-completed [[n:r]] segments and apply
     * each to the matching entry as soon as its closing boundary is visible in the buffer.
     * A segment is "complete" when another marker (or stream end) appears after it.
     */
    applyStreamedBatchSegments(entries, accumulatedText, appliedSet) {
        if (!entries?.length || !accumulatedText) return;
        const markerRe = /\[\[(\d+)(?::[a-z][a-z0-9-]*)?\]\]/g;
        const matches = [];
        let m;
        while ((m = markerRe.exec(accumulatedText)) !== null) {
            matches.push({
                index: matches.length,
                at: m.index,
                length: m[0].length,
                n: Number(m[1]),
            });
        }
        // Only segments followed by ANOTHER marker are known-complete. The last marker's payload
        // may still be in flight — leave it for the final response handler.
        for (let i = 0; i < matches.length - 1; i++) {
            const segNum = matches[i].n;
            const entryIndex = segNum - 1;
            if (entryIndex < 0 || entryIndex >= entries.length) continue;
            if (appliedSet.has(entryIndex)) continue;
            const entry = entries[entryIndex];
            if (!entry) continue;
            const start = matches[i].at + matches[i].length;
            const end = matches[i + 1].at;
            const part = accumulatedText.slice(start, end).trim();
            if (!part) continue;
            const rejectionReason = this.getDomPageEntryRejectionReason(entry, part);
            if (rejectionReason) continue; // let the final handler retry / fallback
            this.queueDomPageEntryApply(entry, part);
            appliedSet.add(entryIndex);
        }
    }

    enqueueDomPageGroupTranslation(group, attempt = 0, options = {}) {
        const run = async () => {
            if (this._domCircuitBreakerActive) {
                this.skipDomPageEntryApply({ group });
                this.markDomPageTranslationEntriesCompleted();
                return;
            }
            this._domActiveTranslations += 1;
            const entry = this.createDomPageTranslationEntry(group);
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                let translated = this._domTranslationCache.get(entry.cacheKey);
                if (!translated) {
                    const requestText = this.buildDomPageRoleSegmentText(entry);
                    const result = await this.translateWithDomPageEngine(requestText, sl, tl);
                    this.recordDomPageTokenUsage(result);
                    if (result && result.translationFailed) {
                        throw new Error(result.errorMsg || "Page translation request failed.");
                    }
                    translated = this.unwrapDomPageRoleSegmentText(
                        result.mainMeaning || result.translatedText,
                        1
                    );
                    if (!this.canUseDomPageTranslation(entry.sourceText, translated)) {
                        throw new Error("Suspicious page translation output rejected.");
                    }
                }

                // HTML-native single-entry: translated is the block's new innerHTML.
                if (entry.htmlMode && entry.htmlElement && entry.htmlElement.isConnected) {
                    const rejectionReason = this.getDomPageEntryRejectionReason(entry, translated);
                    if (rejectionReason) {
                        this.retryDomPageEntryTranslation(entry, attempt, {
                            reason: rejectionReason,
                        });
                        this.markDomPageTranslationEntriesCompleted();
                        return;
                    }
                    this.queueDomPageEntryApply(entry, translated);
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }

                const translatedParts = splitTranslatedContext(translated, group.nodes.length);
                if (!translatedParts) {
                    if (this.shouldUsePlainDomPageNodeFallback(entry, "line-count")) {
                        this.fallbackDomPageEntryToPlainNodes(entry);
                        this.markDomPageTranslationEntriesCompleted();
                        return;
                    }
                    this.retryDomPageEntryTranslation(entry, attempt, { reason: "line-count" });
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }
                if (
                    translatedParts.some((part, index) =>
                        this.isSuspiciousDomPageTranslation(group.texts[index], part)
                    )
                ) {
                    if (this.shouldUsePlainDomPageNodeFallback(entry, "suspicious-line")) {
                        this.fallbackDomPageEntryToPlainNodes(entry);
                        this.markDomPageTranslationEntriesCompleted();
                        return;
                    }
                    this.retryDomPageEntryTranslation(entry, attempt, {
                        reason: "suspicious-line",
                    });
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }

                this.queueDomPageEntryApply(entry, translated);
                this.markDomPageTranslationEntriesCompleted();
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this.retryDomPageEntryTranslation(entry, attempt);
                this.markDomPageTranslationEntriesCompleted();
            } finally {
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        if (options.front) this._domTranslationQueue.unshift(run);
        else this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    enqueueDomPageNodeTranslation(item) {
        const run = async () => {
            this._domActiveTranslations += 1;
            const startedAt = Date.now();
            this.logDomPageDebug("node-request:start", {
                chars: String(item.text || "").length,
            });
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const cacheKey = `${this._domPageTranslateOptions.engine}|${sl}|${tl}|${item.text}`;
                let translated = this._domTranslationCache.get(cacheKey);
                if (!translated) {
                    const result = await this.translateWithDomPageEngine(item.text, sl, tl);
                    this.recordDomPageTokenUsage(result);
                    this.logDomPageDebug("node-request:response", {
                        chars: String(item.text || "").length,
                        durationMs: Date.now() - startedAt,
                        failed: Boolean(result && result.translationFailed),
                        translatedChars: String(
                            (result && (result.mainMeaning || result.translatedText)) || ""
                        ).length,
                        error: result && result.translationFailed ? result.errorMsg || "" : "",
                    });
                    if (result && result.translationFailed) {
                        throw new Error(result.errorMsg || "Page translation request failed.");
                    }
                    translated = result.mainMeaning || result.translatedText;
                    if (!this.canUseDomPageTranslation(item.text, translated)) {
                        this.logDomPageDebug("node-request:rejected", {
                            reason: "suspicious-output",
                            chars: String(item.text || "").length,
                            translatedPreview: String(translated || "").slice(0, 120),
                        });
                        throw new Error("Suspicious page translation output rejected.");
                    }
                    this.cacheDomPageTranslation(cacheKey, translated);
                }
                if (translated && item.node.parentElement === item.parent) {
                    this.applyWithFadeIn(item.node, translated, "text", item.text);
                    this._translatedSet.add(item.node);
                    this.logDomPageDebug("node-apply:success", {
                        chars: String(item.text || "").length,
                    });
                }
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this.logDomPageDebug("node-request:error", {
                    chars: String(item.text || "").length,
                    error: error && error.message ? error.message : String(error || ""),
                });
                this._translatedSet.delete(item.node);
            } finally {
                this._domPendingTextNodes.delete(item.node);
                this.markDomPageTranslationEntriesCompleted();
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    flushDomTranslationQueue() {
        if (!this._domTranslationQueue) return;
        while (
            this._domTranslationQueue.length &&
            this._domActiveTranslations < this._domMaxConcurrentTranslations
        ) {
            const next = this._domTranslationQueue.shift();
            next();
        }
        if (!this._domTranslationQueue.length && this._domActiveTranslations === 0) {
            this.scheduleDomPageCoverageScan();
        }
    }
}

// Precompiled patterns for target-language detection. Two regexes per language:
//   letter: any letter (script-specific letters + Latin) — denominator
//   target: just the target-script letters — numerator
// Both are global so .match() returns the full match list for cheap counting.
BannerController._targetLangPatterns = {
    ko: { letter: /[\p{L}]/gu, target: /[가-힯ᄀ-ᇿ㄰-㆏]/g },
    ja: { letter: /[\p{L}]/gu, target: /[぀-ゟ゠-ヿｦ-ﾟ]/g },
    zh: { letter: /[\p{L}]/gu, target: /[㐀-䶿一-鿿豈-﫿]/g },
    ru: { letter: /[\p{L}]/gu, target: /[Ѐ-ӿ]/g },
    uk: { letter: /[\p{L}]/gu, target: /[Ѐ-ӿ]/g },
    bg: { letter: /[\p{L}]/gu, target: /[Ѐ-ӿ]/g },
    sr: { letter: /[\p{L}]/gu, target: /[Ѐ-ӿ]/g },
    ar: { letter: /[\p{L}]/gu, target: /[؀-ۿݐ-ݿ]/g },
    fa: { letter: /[\p{L}]/gu, target: /[؀-ۿݐ-ݿ]/g },
    ur: { letter: /[\p{L}]/gu, target: /[؀-ۿݐ-ݿ]/g },
    th: { letter: /[\p{L}]/gu, target: /[฀-๿]/g },
    hi: { letter: /[\p{L}]/gu, target: /[ऀ-ॿ]/g },
    mr: { letter: /[\p{L}]/gu, target: /[ऀ-ॿ]/g },
    ne: { letter: /[\p{L}]/gu, target: /[ऀ-ॿ]/g },
    he: { letter: /[\p{L}]/gu, target: /[֐-׿]/g },
    yi: { letter: /[\p{L}]/gu, target: /[֐-׿]/g },
};

// Create the object.
window.EdgeTranslateBannerController = new BannerController();

export { BannerController };
