import Channel from "common/scripts/channel.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import {
    toChromeTranslatorLanguage,
    translateWithChromeOnDevice,
} from "common/scripts/chrome_builtin_translate.js";
import {
    buildContextTranslationGroups,
    buildSegmentedTranslationText,
    createReadableBlockReplacement,
    splitSegmentedTranslationText,
    splitTranslatedContext,
} from "./dom_page_translate_context.js";

function fnv1a32(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
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
        this._domActiveTranslations = 0;
        this._domMaxConcurrentTranslations = 2;
        this._domPageBanner = null;
        this._domPageBannerVisible = true;
        this._domTotalTranslationEntries = 0;
        this._domCompletedTranslationEntries = 0;
        this._domBatchFailureCount = 0;
        this._domTranslationSessionId = 0;
        this._domApplySequence = 0;
        this._domNextApplySequence = 0;
        this._domPendingApplies = new Map();
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
        this._domIncrementalScanTimer = null;
        this._domScrollScanHandler = null;
        this._onDeviceBridgePromise = null;
        this._onDeviceBridgeRequestId = 0;
        this._onDeviceBridgePending = new Map();
        this._domOriginalTextByElement = new WeakMap();
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
        this._captionStabilizeDelayMs = 520;
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
        this._captionDisplayMax = 2;
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
        this._captionBatchDelayMs = 120;
        this._captionBatchMaxSize = 6;
        this._captionDebugEventId = 0;
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
        this._domCoverageScanCount = 0;
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
        return [document.body].filter(Boolean);
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
                transition: opacity 200ms cubic-bezier(0.34, 1.8, 0.5, 1), background-color 200ms ease, color 200ms ease, transform 200ms cubic-bezier(0.34, 1.8, 0.5, 1);
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

        let replacedFragment = false;
        let replacementIndex = -1;
        const nextItems = [];
        this._captionDisplayItems.forEach((item) => {
            const duplicate = item.source === source || item.text === translatedText;
            const replacedByMergedSource =
                this.realtimeCaptionSourceIncludes(source, item.source) ||
                this.realtimeCaptionSourceIncludes(translatedText, item.text);
            if (replacedByMergedSource) {
                replacedFragment = true;
                if (replacementIndex < 0) replacementIndex = nextItems.length;
            }
            if (!duplicate && !replacedByMergedSource) nextItems.push(item);
        });
        const nextItem = {
            source,
            text: translatedText,
            expanded: replacedFragment,
        };
        if (replacementIndex >= 0) {
            nextItems.splice(replacementIndex, 0, nextItem);
        } else {
            nextItems.push(nextItem);
        }
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
        const recentItems = this._captionDisplayItems.slice(-Math.max(3, this._captionDisplayMax));
        return recentItems.some((item) => item.expanded)
            ? Math.max(3, this._captionDisplayMax)
            : this._captionDisplayMax;
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
        this._captionOverlayDraggable = captionConfig.draggableOverlay !== false;
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
        return String(text || "")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim();
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

    addYouTubeCaptionCueGroups(cues) {
        return cues.map((cue, index) => {
            cue.groupText = cue.text;
            cue.groupId = index;
            cue.cueIndex = index;
            return cue;
        });
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

        while (
            index < this._captionPrefetchCues.length &&
            started < this._captionPrefetchBatchSize
        ) {
            if (this._captionPrefetchInFlight.size >= this._captionPrefetchMaxInFlight) {
                break;
            }
            const cue = this._captionPrefetchCues[index];
            if (cue.startMs > windowEndMs) break;
            const entry = this.createRealtimeCaptionPrefetchEntry(cue.text, options);
            if (entry) {
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
                .map((entry) =>
                    this.createRealtimeCaptionPrefetchEntry(entry.sourceText, fastOptions)
                )
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
                    this.cacheRealtimeCaptionTranslation(entries[0].cacheKey, translated);
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
                        this.cacheRealtimeCaptionTranslation(entry.cacheKey, parsed[index]);
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
        const activeCues = this.getActivePrefetchedCaptionCues(sourceText);
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
        const nodes = this.collectDomPageTextNodes(this._domPageRootElements);
        if (nodes.length) this.translateBatchNodes(nodes);
    }

    scanDomPageForNewTextNodes() {
        if (this.currentTranslator !== "dom") return;
        if (this._domCircuitBreakerActive) return;
        this._domPageRootElements = this.getDomPageTranslationRoots();
        const nodes = this.collectDomPageTextNodes(this._domPageRootElements);
        if (nodes.length) this.translateBatchNodes(nodes);
    }

    scheduleDomPageIncrementalScan(delay = 450) {
        if (this.currentTranslator !== "dom") return;
        if (this._domCircuitBreakerActive) return;
        if (this._domIncrementalScanTimer) clearTimeout(this._domIncrementalScanTimer);
        this._domIncrementalScanTimer = setTimeout(() => {
            this._domIncrementalScanTimer = null;
            this.scanDomPageForNewTextNodes();
        }, delay);
    }

    scheduleDomPageCoverageScan() {
        if (this.currentTranslator !== "dom") return;
        if (this._domCircuitBreakerActive) return;
        if (this._domCoverageScanTimer) return;
        if (this._domCoverageScanCount >= 5) return;
        this._domCoverageScanTimer = setTimeout(() => {
            this._domCoverageScanTimer = null;
            if (this.currentTranslator !== "dom") return;
            if (this._domCircuitBreakerActive) return;
            if (this._domTranslationQueue?.length || this._domActiveTranslations > 0) return;
            this._domCoverageScanCount += 1;
            const nodes = this.collectDomPageTextNodes(this._domPageRootElements);
            if (nodes.length) {
                this.translateBatchNodes(nodes);
            }
        }, 350);
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
                /(^|-)comments?($|-)/.test(normalized) ||
                /(^|-)threads?($|-)/.test(normalized) ||
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

    isMeaningfulDomPageTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        if (!this.isNodeInDomPageTranslationRoot(node)) return false;
        const text = String(node.nodeValue || "").trim();
        if (text.length < 2) return false;
        const p = node.parentElement;
        if (!p) return false;
        if (this.isDomPageWidgetTextNode(node)) return false;
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
        for (const root of roots || []) {
            if (!root) continue;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (this.isMeaningfulDomPageTextNode(node)) nodes.push(node);
            }
        }
        return nodes;
    }

    enqueueDomPageTextTreeForMutation(node, enqueue) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            if (this.isMeaningfulDomPageTextNode(node)) enqueue(node);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
            if (this.isMeaningfulDomPageTextNode(textNode)) enqueue(textNode);
        }
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

    async translateWithDomPageEngine(text, from, to) {
        return await this.channel.request("translate_text_quiet", {
            text,
            sl: from,
            tl: to,
            translatorId: "LocalTranslate",
            engine: this._domPageTranslateOptions.engine,
            translationProfile: "page",
        });
    }

    getDomPageTranslationGroupOptions() {
        return { maxChars: 12000 };
    }

    getReadableBlockReplacementOptions() {
        return { maxChars: 12000 };
    }

    getDomPageBatchOptions() {
        if (
            this._domPageTranslateOptions.engine === "openai" ||
            this._domPageTranslateOptions.engine === "openaiCompatible"
        ) {
            if (this._domBatchFailureCount >= 3) return { maxChars: 1800, maxItems: 1 };
            if (this._domBatchFailureCount >= 2) return { maxChars: 4000, maxItems: 6 };
            if (this._domBatchFailureCount >= 1) return { maxChars: 7000, maxItems: 32 };
            return { maxChars: 12000, maxItems: 64 };
        }
        if (this._domBatchFailureCount >= 3) return { maxChars: 1800, maxItems: 1 };
        if (this._domBatchFailureCount >= 2) return { maxChars: 4000, maxItems: 6 };
        if (this._domBatchFailureCount >= 1) return { maxChars: 7000, maxItems: 32 };
        return { maxChars: 12000, maxItems: 64 };
    }

    getDomPageLeadBatchOptions() {
        return null;
    }

    getDomPageMaxConcurrentTranslations() {
        const engine = this._domPageTranslateOptions.engine;
        if (this._domBatchFailureCount >= 3) return 6;
        if (this._domBatchFailureCount >= 1) return 12;
        if (engine === "openai" || engine === "openaiCompatible") return 16;
        if (engine === "googleAiStudio") return 32;
        return 8;
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

    /**
     * Circuit breaker: pause translation for 30s when too many consecutive failures.
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
        }, 30000);
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
        return (
            String(text)
                // Full instruction lines that may be echoed verbatim.
                .replace(
                    /^[ \t]*(Source language|Target language|Translate|Output only the translation|Translate the user'?s text|Translate faithfully|Preserve meaning|Use the target language'?s|Preserve proper nouns)[^\n]*$/gim,
                    ""
                )
                // Bare "Korean:" / "English:" language labels the model may emit.
                .replace(/^[ \t]*[A-Z][a-z]+:\s*$/gm, "")
                .replace(/\n{3,}/g, "\n\n")
                .trim()
        );
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

        if (
            /<<<EDGE_TRANSLATE_SEGMENT_/i.test(
                translated
            )
        ) {
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
        this._domApplySequence = 0;
        this._domNextApplySequence = 0;
        this._domPendingApplies = new Map();
        if (this._domIncrementalScanTimer) {
            clearTimeout(this._domIncrementalScanTimer);
            this._domIncrementalScanTimer = null;
        }
        this._pendingNodes.clear();
        if (this._scheduleBatch) {
            cancelAnimationFrame(this._scheduleBatch);
            this._scheduleBatch = null;
        }
    }

    createDomPageTranslationEntry(group, options = {}) {
        const { tl } = this._domPageTranslateOptions;
        const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
        const sessionId =
            group && group.sessionId !== undefined
                ? group.sessionId
                : this._domTranslationSessionId;
        if (group && group.sessionId === undefined) group.sessionId = sessionId;
        const forceContext = options.forceContext || group?.forceDomPageContext;
        const readableBlockReplacement = forceContext
            ? null
            : createReadableBlockReplacement(
                  group,
                  this.getReadableBlockReplacementOptions(options)
              );
        const sourceText = readableBlockReplacement
            ? readableBlockReplacement.sourceText
            : group.sourceText;
        const role = readableBlockReplacement
            ? readableBlockReplacement.role || group.role
            : group.role;
        const cacheMode = readableBlockReplacement ? "readable-block" : "context";
        const cacheKey = [
            this._domPageTranslateOptions.engine,
            this._domPageTranslateOptions.model || "",
            cacheMode,
            role,
            sl,
            tl,
            fnv1a32(sourceText),
        ].join("|");
        return {
            group,
            readableBlockReplacement,
            role,
            sourceText,
            cacheKey,
            sessionId,
        };
    }

    assignDomPageApplySequence(entry) {
        if (!entry || entry.applySequence !== undefined) return entry;
        const group = entry.group;
        if (group && group.applySequence !== undefined) {
            entry.applySequence = group.applySequence;
            return entry;
        }
        entry.applySequence = this._domApplySequence;
        if (group) group.applySequence = entry.applySequence;
        this._domApplySequence += 1;
        return entry;
    }

    queueDomPageEntryApply(entry, translated) {
        if (!this.isDomPageEntryCurrentSession(entry)) return;
        this.assignDomPageApplySequence(entry);
        this._domPendingApplies.set(entry.applySequence, {
            entry,
            translated,
            skipped: false,
        });
        this.flushDomPageOrderedApplies();
    }

    canQueueDomPageEntryTranslation(entry, translated) {
        return !this.getDomPageEntryRejectionReason(entry, translated);
    }

    getDomPageEntryRejectionReason(entry, translated) {
        if (!this.canUseDomPageTranslation(entry.sourceText, translated)) {
            return "suspicious-output";
        }
        const replacement = entry.readableBlockReplacement;
        if (replacement?.inlineLinks?.length) {
            return this.createDomPageInlineLinkFragment(translated, replacement.inlineLinks)
                ? ""
                : "inline-link-placeholder";
        }
        if (!replacement) {
            const group = entry.group;
            const parts = splitTranslatedContext(translated, group.nodes.length);
            if (!parts) return "line-count";
            return parts.some((part, index) =>
                this.isSuspiciousDomPageTranslation(group.texts[index], part)
            )
                ? "suspicious-line"
                : "";
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
        this.assignDomPageApplySequence(entry);
        this.releaseDomPageEntryPending(entry);
        this._domPendingApplies.set(entry.applySequence, {
            entry,
            translated: "",
            skipped: true,
        });
        this.flushDomPageOrderedApplies();
    }

    flushDomPageOrderedApplies() {
        while (this._domPendingApplies.has(this._domNextApplySequence)) {
            const item = this._domPendingApplies.get(this._domNextApplySequence);
            this._domPendingApplies.delete(this._domNextApplySequence);
            this._domNextApplySequence += 1;
            if (!this.isDomPageEntryCurrentSession(item.entry)) continue;
            if (item.skipped) continue;
            if (!this.isDomPageEntryStillCurrent(item.entry)) {
                this.releaseDomPageEntryPending(item.entry);
                continue;
            }
            if (this.applyDomPageTranslatedEntry(item.entry, item.translated)) {
                this.cacheDomPageTranslation(item.entry.cacheKey, item.translated);
                this.markDomPageEntryApplied(item.entry);
            } else {
                this.releaseDomPageEntryPending(item.entry);
            }
        }
    }

    cacheDomPageTranslation(cacheKey, translated) {
        if (!cacheKey || !translated) return;
        if (this._domTranslationCache.size >= this._domTranslationCacheMax) {
            const oldest = this._domTranslationCache.keys().next().value;
            if (oldest !== undefined) this._domTranslationCache.delete(oldest);
        }
        this._domTranslationCache.set(cacheKey, translated);
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
            return this.fallbackDomPageEntryToPlainNodes(entry);
        }
        if (!this.shouldRetryDomPageEntryTranslation(entry, attempt, reason)) {
            this.markDomPageEntryFailed(entry);
            this.skipDomPageEntryApply(entry);
            return false;
        }
        if (entry.readableBlockReplacement) {
            entry.group.forceDomPageContext = true;
        }
        this.enqueueDomPageGroupTranslation(entry.group, attempt + 1, {
            front: true,
            ...options,
        });
        return true;
    }

    shouldRetryDomPageEntryTranslation(entry, attempt, reason = "") {
        if (!entry || attempt >= 1) return false;
        const role = entry.role || entry.group?.role || "text";
        const sourceLength = String(entry.sourceText || "").trim().length;
        const contentRoles = ["paragraph", "list-item", "caption", "table-header"];
        if (entry.readableBlockReplacement) return true;
        if (reason === "line-count") {
            if (role === "title" || role === "date") return sourceLength >= 8;
            return contentRoles.includes(role) && sourceLength >= 80;
        }
        if (role === "title" || role === "date") return sourceLength >= 8;
        if (contentRoles.includes(role)) {
            return sourceLength >= 40;
        }
        if (reason === "suspicious-output" && sourceLength >= 120) return true;
        return false;
    }

    markDomPageEntryFailed(entry) {
        const nodes = entry?.group?.nodes || [];
        nodes.forEach((node) => {
            this._domPendingTextNodes.delete(node);
            this._domFailedTextNodes.add(node);
        });
        if (entry?.group) {
            entry.group.forceDomPageContext = false;
        }
    }

    applyDomPageTranslatedEntry(entry, translated) {
        if (!translated) return false;
        const { group, readableBlockReplacement } = entry;
        if (!this.canUseDomPageTranslation(entry.sourceText, translated)) return false;

        if (readableBlockReplacement) {
            const block = readableBlockReplacement.block;
            if (block && block.isConnected) {
                if (
                    !this.applyDomPageReadableBlockReplacement(readableBlockReplacement, translated)
                ) {
                    return false;
                }
                this._translatedBlocks.add(block);
                return true;
            }
            return false;
        }

        const translatedParts = splitTranslatedContext(translated, group.nodes.length);
        if (!translatedParts) return false;
        if (
            translatedParts.some((part, index) =>
                this.isSuspiciousDomPageTranslation(group.texts[index], part)
            )
        ) {
            return false;
        }

        group.nodes.forEach((node, index) => {
            if (translatedParts[index] && node.parentElement) {
                this.applyWithFadeIn(node, translatedParts[index], "text", group.texts[index]);
            }
        });
        return true;
    }

    applyDomPageReadableBlockReplacement(readableBlockReplacement, translated) {
        const block = readableBlockReplacement && readableBlockReplacement.block;
        if (!block) return false;
        if (readableBlockReplacement.inlineLinks && readableBlockReplacement.inlineLinks.length) {
            const fragment = this.createDomPageInlineLinkFragment(
                translated,
                readableBlockReplacement.inlineLinks
            );
            if (!fragment) return false;
            this.registerDomOriginalText(block, readableBlockReplacement.sourceText);
            this.ensureDomFadeStyle();
            block.style.opacity = "0";
            block.classList.add("et-fade-in");
            block.replaceChildren(fragment);
            requestAnimationFrame(() => {
                block.style.opacity = "1";
                setTimeout(() => {
                    block.classList.remove("et-fade-in");
                    block.style.removeProperty("opacity");
                }, 300);
            });
            return true;
        }
        this.applyWithFadeIn(block, translated, "block", readableBlockReplacement.sourceText);
        return true;
    }

    sanitizeDomPageTranslatedText(text) {
        return this.stripPromptEchoFromTranslation(
            String(text || "")
                .replace(/\[\[EDGE_TRANSLATE_LINK_\d+]]/g, "")
                .replace(/\[\[\/EDGE_TRANSLATE_LINK_\d+]]/g, "")
        );
    }

    sanitizeDomPageOriginalText(text) {
        return String(text || "")
            .replace(/\[\[EDGE_TRANSLATE_LINK_\d+]]/g, "")
            .replace(/\[\[\/EDGE_TRANSLATE_LINK_\d+]]/g, "")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .trim();
    }

    createDomPageInlineLinkFragment(translated, links) {
        const text = String(translated || "");
        const markerPattern =
            /\[\[EDGE_TRANSLATE_LINK_(\d+)]]([\s\S]*?)\[\[\/EDGE_TRANSLATE_LINK_\1]]/g;
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let restoredCount = 0;
        let match;
        while ((match = markerPattern.exec(text))) {
            const index = Number(match[1]) - 1;
            const link = links[index];
            if (!link) return null;
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }
            const anchor = document.createElement("a");
            anchor.href = link.href;
            if (link.title) anchor.title = link.title;
            if (link.target) anchor.target = link.target;
            if (link.rel) anchor.rel = link.rel;
            anchor.textContent = String(match[2] || "").trim() || link.text || link.href;
            fragment.appendChild(anchor);
            lastIndex = markerPattern.lastIndex;
            restoredCount += 1;
        }
        if (restoredCount !== links.length) return null;
        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
        return fragment;
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
     */
    applyWithFadeIn(node, translated, type, originalText) {
        translated = this.sanitizeDomPageTranslatedText(translated);
        if (type === "text") {
            return this.applyTextNodeTranslationWithOriginalChunks(node, translated, originalText);
        }
        const el = type === "block" ? node : node.parentElement;
        if (!el || !el.style) {
            if (type === "block") node.textContent = translated;
            else node.nodeValue = translated;
            return;
        }
        if (this.isPdfViewerTextLayerElement(el)) {
            el.classList.add("et-dom-pdf-translated-text");
        }
        this.registerDomOriginalText(el, originalText);
        this.ensureDomFadeStyle();
        el.style.opacity = "0";
        el.classList.add("et-fade-in");
        if (type === "block") node.textContent = translated;
        else node.nodeValue = translated;
        requestAnimationFrame(() => {
            el.style.opacity = "1";
            setTimeout(() => {
                el.classList.remove("et-fade-in");
                el.style.removeProperty("opacity");
            }, 300);
        });
    }

    applyTextNodeTranslationWithOriginalChunks(node, translated, originalText) {
        translated = this.sanitizeDomPageTranslatedText(translated);
        const parent = node && node.parentElement;
        if (!parent) {
            if (node) node.nodeValue = this.preserveDomTextNodeBoundaryWhitespace(node, translated);
            return;
        }
        const pairs = this.buildDomOriginalDisplayPairs(translated, originalText);
        const fragment = document.createDocumentFragment();
        const spans = [];
        pairs.forEach((pair, index) => {
            if (index > 0) fragment.appendChild(document.createTextNode(pair.separator || " "));
            const span = document.createElement("span");
            span.className = "et-dom-translated-text";
            if (this.isPdfViewerTextLayerElement(parent)) {
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

        this.ensureDomFadeStyle();
        spans.forEach((span) => {
            span.style.opacity = "0";
            span.classList.add("et-fade-in");
        });
        parent.replaceChild(fragment, node);
        requestAnimationFrame(() => {
            spans.forEach((span) => {
                span.style.opacity = "1";
                setTimeout(() => {
                    span.classList.remove("et-fade-in");
                    span.style.removeProperty("opacity");
                }, 300);
            });
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

    ensureDomFadeStyle() {
        if (this._domFadeStyleInjected) return;
        this._domFadeStyleInjected = true;
        const style = document.createElement("style");
        style.textContent = `
            .et-fade-in{transition:opacity .1s ease-in;}
            .textLayer .et-dom-pdf-translated-text {
                color: #202124 !important;
                background: rgba(255,255,255,.86) !important;
                border-radius: 2px !important;
                box-decoration-break: clone !important;
                -webkit-box-decoration-break: clone !important;
                text-shadow: 0 0 1px rgba(255,255,255,.9) !important;
            }
        `;
        document.head.appendChild(style);
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
            move: (event) => this.positionDomOriginalTooltip(event),
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
                .et-dom-original-source {
                    background: rgba(26, 115, 232, 0.14) !important;
                    border-radius: 4px !important;
                    box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.08) !important;
                    cursor: help !important;
                }
                #edge-translate-dom-original-tooltip {
                    position: fixed;
                    z-index: 2147483647;
                    width: min(480px, calc(100vw - 32px));
                    max-height: min(320px, calc(100vh - 32px));
                    overflow: auto;
                    box-sizing: border-box;
                    padding: 0;
                    border: 1px solid #dadce0;
                    border-radius: 8px;
                    background: #fff;
                    box-shadow: 0 1px 2px rgba(60, 64, 67, 0.16), 0 8px 24px rgba(60, 64, 67, 0.18);
                    color: #202124;
                    font-family: Roboto, Arial, "Noto Sans", "Apple SD Gothic Neo", sans-serif;
                    font-size: 14px;
                    line-height: 1.55;
                    pointer-events: none;
                    opacity: 0;
                    transform: translateY(6px) scale(0.98);
                    transform-origin: top left;
                    transition: opacity 120ms cubic-bezier(0.2, 0, 0, 1), transform 120ms cubic-bezier(0.2, 0, 0, 1);
                }
                #edge-translate-dom-original-tooltip[data-visible="true"] {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
                #edge-translate-dom-original-tooltip .et-original-header {
                    position: sticky;
                    top: 0;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 12px 16px 9px;
                    color: #5f6368;
                    background: #fff;
                    border-bottom: 1px solid #f1f3f4;
                    font-size: 13px;
                    font-weight: 600;
                }
                #edge-translate-dom-original-tooltip .et-original-icon {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    border-radius: 6px;
                    background: #e8f0fe;
                    color: #1a73e8;
                    font-size: 15px;
                    font-weight: 700;
                }
                #edge-translate-dom-original-tooltip .et-original-text {
                    padding: 14px 18px 18px;
                    white-space: pre-wrap;
                    word-break: break-word;
                    font-size: 15px;
                    color: #202124;
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
        const target = this.getDomOriginalTooltipTarget(event.target);
        if (!target || target === this._domOriginalTooltipTarget) return;
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
        if (related && target.contains && target.contains(related)) return;
        this.hideDomOriginalTooltip();
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
            ].join(";");
            const root = host.attachShadow({ mode: "open" });
            root.innerHTML = `
                <style>
                    :host {
                        color-scheme: light;
                        --et-primary: #1A73E8;
                        --et-primary-container: #E8F0FE;
                        --et-on-primary-container: #174EA6;
                        --et-surface: linear-gradient(135deg, rgba(244, 248, 255, 0.90), rgba(255, 255, 255, 0.85));
                        --et-surface-container: rgba(26, 115, 232, 0.06);
                        --et-outline: rgba(26, 115, 232, 0.12);
                        --et-outline-variant: rgba(26, 115, 232, 0.06);
                        --et-text: #1F1F1F;
                        --et-muted: #5F6368;
                        --et-success: #386A20;
                        --et-error: #B3261E;
                        --pulse-color: rgba(26, 115, 232, 0.20);
                        --et-progress-track: rgba(26, 115, 232, 0.08);
                    }
                    @media (prefers-color-scheme: dark) {
                        :host {
                            color-scheme: dark;
                            --et-primary: #8AB4F8;
                            --et-primary-container: #185ABC;
                            --et-on-primary-container: #E8F0FE;
                            --et-surface: linear-gradient(135deg, rgba(32, 33, 36, 0.90), rgba(20, 21, 24, 0.85));
                            --et-surface-container: rgba(138, 180, 248, 0.06);
                            --et-outline: rgba(138, 180, 248, 0.12);
                            --et-outline-variant: rgba(138, 180, 248, 0.06);
                            --et-text: #E8EAED;
                            --et-muted: #9AA0A6;
                            --et-success: #B2F195;
                            --et-error: #F2B8B5;
                            --pulse-color: rgba(138, 180, 248, 0.20);
                            --et-progress-track: rgba(138, 180, 248, 0.08);
                        }
                    }
                    .bar {
                        position: relative;
                        margin: 12px 24px;
                        height: 60px;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 16px;
                        box-sizing: border-box;
                        padding: 0 24px 8px;
                        color: var(--et-text);
                        background: var(--et-surface);
                        border: 1px solid var(--et-outline);
                        border-radius: 999px;
                        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.02), inset 0 1px 0 rgba(255, 255, 255, 0.5);
                        font-size: 13px;
                        line-height: 1.2;
                        pointer-events: auto;
                        backdrop-filter: blur(28px) saturate(190%);
                        -webkit-backdrop-filter: blur(28px) saturate(190%);
                        animation: spring-entrance 450ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
                        transition: all 300ms cubic-bezier(0.25, 1, 0.5, 1);
                    }
                    .bar:hover {
                        transform: translateY(1px) scale(1.008);
                        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.5);
                        border-color: rgba(26, 115, 232, 0.24);
                    }
                    @media (prefers-color-scheme: dark) {
                        .bar:hover {
                            border-color: rgba(138, 180, 248, 0.24);
                        }
                    }
                    .bar[data-state="starting"],
                    .bar[data-state="running"] {
                        border-color: rgba(26, 115, 232, 0.3);
                        box-shadow: 0 4px 24px rgba(26, 115, 232, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                    }
                    @media (prefers-color-scheme: dark) {
                        .bar[data-state="starting"],
                        .bar[data-state="running"] {
                            border-color: rgba(138, 180, 248, 0.3);
                            box-shadow: 0 4px 24px rgba(138, 180, 248, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                        }
                    }
                    .bar[data-state="complete"] {
                        border-color: rgba(56, 106, 32, 0.3);
                        box-shadow: 0 4px 24px rgba(56, 106, 32, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                    }
                    @media (prefers-color-scheme: dark) {
                        .bar[data-state="complete"] {
                            border-color: rgba(178, 241, 149, 0.3);
                            box-shadow: 0 4px 24px rgba(178, 241, 149, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                        }
                    }
                    .bar[data-state="error"] {
                        border-color: rgba(179, 38, 30, 0.3);
                        box-shadow: 0 4px 24px rgba(179, 38, 30, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                    }
                    @media (prefers-color-scheme: dark) {
                        .bar[data-state="error"] {
                            border-color: rgba(242, 184, 181, 0.3);
                            box-shadow: 0 4px 24px rgba(242, 184, 181, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                        }
                    }
                    :host([data-visible="false"]) .bar {
                        display: none;
                    }
                    .main {
                        display: flex;
                        align-items: center;
                        min-width: 0;
                        gap: 12px;
                    }
                    .status-dot {
                        position: relative;
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        flex: 0 0 auto;
                        background: var(--et-primary);
                        transition: all 300ms cubic-bezier(0.34, 1.8, 0.5, 1);
                    }
                    .bar[data-state="starting"] .status-dot,
                    .bar[data-state="running"] .status-dot {
                        animation: pulse-breath 1.6s ease-in-out infinite;
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
                        font-weight: 700;
                        letter-spacing: -0.1px;
                    }
                    .provider {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        border-radius: 8px;
                        padding: 2px 10px;
                        color: var(--et-on-primary-container);
                        background: var(--et-primary-container);
                        border: 1px solid var(--et-outline);
                        font-size: 11px;
                        font-weight: 600;
                        height: 22px;
                        box-sizing: border-box;
                        transition: all 300ms cubic-bezier(0.34, 1.8, 0.5, 1);
                    }
                    .provider:hover {
                        transform: translateY(-1px) scale(1.03);
                        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.06);
                    }
                    .provider span {
                        min-width: 0;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }
                    .model {
                        display: inline-flex;
                        align-items: center;
                        padding: 2px 8px;
                        height: 22px;
                        border-radius: 8px;
                        border: 1px solid var(--et-outline-variant);
                        background: var(--et-surface-container);
                        font-size: 10px;
                        font-weight: 600;
                        color: var(--et-muted);
                        box-sizing: border-box;
                        transition: all 300ms cubic-bezier(0.34, 1.8, 0.5, 1);
                    }
                    .model:hover {
                        transform: translateY(-1px) scale(1.03);
                        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.04);
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
                        font-weight: 500;
                    }
                    .actions {
                        display: flex;
                        align-items: center;
                        gap: 8px;
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
                        border-radius: 8px;
                        background: var(--et-surface-container);
                        color: var(--et-muted);
                        border: 1px solid var(--et-outline-variant);
                        font-size: 11px;
                        font-weight: 500;
                        font-variant-numeric: tabular-nums;
                    }
                    button {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        border: 0;
                        border-radius: 16px;
                        background: transparent;
                        color: var(--et-on-primary-container);
                        cursor: pointer;
                        font: inherit;
                        height: 32px;
                        padding: 0 14px;
                        font-size: 12px;
                        font-weight: 600;
                        transition: all 250ms cubic-bezier(0.25, 1, 0.5, 1);
                    }
                    button svg {
                        width: 14px;
                        height: 14px;
                        flex: 0 0 auto;
                        fill: currentColor;
                    }
                    button:hover {
                        background: var(--et-primary-container);
                        transform: scale(1.06);
                    }
                    button:active {
                        transform: scale(0.92);
                    }
                    .hide {
                        background: var(--et-surface-container);
                        border: 1px solid var(--et-outline);
                    }
                    .hide:hover {
                        background: var(--et-primary-container);
                        color: var(--et-on-primary-container);
                        border-color: transparent;
                        transform: scale(1.06);
                    }
                    .hide:active {
                        transform: scale(0.92);
                    }
                    .close {
                        color: var(--et-muted);
                        padding: 0;
                        width: 32px;
                        height: 32px;
                        border-radius: 50%;
                        transition: all 350ms cubic-bezier(0.25, 1, 0.5, 1);
                    }
                    .close:hover {
                        background: var(--et-surface-container);
                        color: var(--et-text);
                        transform: rotate(90deg) scale(1.1);
                    }
                    .close:active {
                        transform: rotate(180deg) scale(0.9);
                    }
                    .progress {
                        position: absolute;
                        left: 24px;
                        right: 24px;
                        bottom: 4px;
                        height: 4px;
                        overflow: hidden;
                        background: var(--et-progress-track);
                        border-radius: 999px;
                    }
                    .progress-fill {
                        width: 0%;
                        height: 100%;
                        background: var(--et-primary);
                        border-radius: 999px;
                        transition: width 350ms cubic-bezier(0.34, 1.8, 0.5, 1);
                    }
                    .bar[data-state="starting"] .progress-fill {
                        width: 100% !important;
                        background: linear-gradient(90deg, transparent, var(--et-primary) 50%, transparent);
                        background-size: 200% 100%;
                        animation: shimmer 1.5s infinite linear;
                    }
                    .bar[data-state="error"] .status-dot {
                        background: var(--et-error);
                        box-shadow: 0 0 0 4px rgba(179, 38, 30, 0.2);
                    }
                    @media (prefers-color-scheme: dark) {
                        .bar[data-state="error"] .status-dot {
                            box-shadow: 0 0 0 4px rgba(242, 184, 181, 0.2);
                        }
                    }
                    .bar[data-state="error"] .progress-fill {
                        width: 100%;
                        background: var(--et-error);
                    }
                    .bar[data-state="complete"] .status-dot {
                        background: var(--et-success);
                        box-shadow: 0 0 0 4px rgba(56, 106, 32, 0.2);
                    }
                    @media (prefers-color-scheme: dark) {
                        .bar[data-state="complete"] .status-dot {
                            box-shadow: 0 0 0 4px rgba(178, 241, 149, 0.2);
                        }
                    }
                    .bar[data-state="complete"] .progress-fill {
                        background: var(--et-success);
                    }
                    .restore {
                        position: fixed;
                        top: 10px;
                        right: 16px;
                        display: none;
                        align-items: center;
                        gap: 6px;
                        height: 32px;
                        padding: 0 14px;
                        border: 1px solid var(--et-outline);
                        border-radius: 16px;
                        background: var(--et-surface);
                        color: var(--et-primary);
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
                        font: inherit;
                        font-size: 12px;
                        font-weight: 600;
                        pointer-events: auto;
                        backdrop-filter: blur(16px);
                        -webkit-backdrop-filter: blur(16px);
                        transition: all 300ms cubic-bezier(0.25, 1, 0.5, 1);
                    }
                    :host([data-visible="false"]) .restore {
                        display: inline-flex;
                        animation: spring-entrance 450ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
                    }
                    .restore:hover {
                        background: var(--et-primary-container);
                        color: var(--et-on-primary-container);
                        border-color: transparent;
                        transform: scale(1.06);
                    }
                    .restore:active {
                        transform: scale(0.92);
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
                    @keyframes spring-entrance {
                        0% {
                            transform: translateY(-24px) scale(0.95);
                            opacity: 0;
                            filter: blur(4px);
                        }
                        100% {
                            transform: translateY(0) scale(1);
                            opacity: 1;
                            filter: blur(0);
                        }
                    }
                    @keyframes shimmer {
                        0% { background-position: 200% 0; }
                        100% { background-position: -200% 0; }
                    }
                    @keyframes pulse-breath {
                        0% {
                            transform: scale(0.9);
                            box-shadow: 0 0 0 0px var(--pulse-color);
                        }
                        50% {
                            transform: scale(1.15);
                            box-shadow: 0 0 0 10px transparent;
                        }
                        100% {
                            transform: scale(0.9);
                            box-shadow: 0 0 0 0px transparent;
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
                        .bar[data-state="starting"] .progress-fill {
                            animation: none;
                            transform: none;
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
            (document.documentElement || document.body).appendChild(host);
        }
        this._domPageBanner = host;
        return host;
    }

    setDomPageBannerVisible(visible) {
        const host = this.ensureDomPageBanner();
        this._domPageBannerVisible = visible;
        host.style.display = "block";
        host.dataset.visible = visible ? "true" : "false";
        host.style.height = visible ? `${this._domPageBannerHeight}px` : "0";
        this.movePage("top", visible ? this._domPageBannerHeight : 0, true);
    }

    updateDomPageBannerStatus(state, message) {
        const host =
            this._domPageBanner || document.getElementById("edge-translate-dom-page-banner");
        if (!host || !host.shadowRoot) return;
        const bar = host.shadowRoot.querySelector("[data-role='bar']");
        const engine = host.shadowRoot.querySelector("[data-role='engine']");
        const model = host.shadowRoot.querySelector("[data-role='model']");
        const status = host.shadowRoot.querySelector("[data-role='status']");
        const progressFill = host.shadowRoot.querySelector("[data-role='progress-fill']");
        const progressMeta = host.shadowRoot.querySelector("[data-role='progress-meta']");
        const tokenMeta = host.shadowRoot.querySelector("[data-role='token-meta']");
        if (!bar || !status) return;
        const meta = this.getDomPageTranslatorMeta();
        const label = meta.label;
        if (engine) {
            engine.innerHTML = `${meta.logo}<span data-role="engine-label">${label}</span>`;
        }
        if (model) {
            model.textContent = meta.model || "";
            model.hidden = !meta.model;
        }
        if (state === "error") {
            bar.dataset.state = "error";
            status.textContent = message
                ? `Translation failed: ${String(message).slice(0, 120)}`
                : "Translation failed";
            if (progressFill) progressFill.style.width = "100%";
            if (progressMeta) progressMeta.textContent = "Error";
            if (tokenMeta) {
                const tokenText = this.getDomPageTokenUsageText();
                tokenMeta.textContent = tokenText;
                tokenMeta.style.display = tokenText ? "inline-flex" : "none";
            }
            return;
        }
        const tokenText = this.getDomPageTokenUsageText();
        if (tokenMeta) {
            tokenMeta.textContent = tokenText;
            tokenMeta.title = tokenText ? `API token usage: ${tokenText}` : "";
            tokenMeta.style.display = tokenText ? "inline-flex" : "none";
        }
        const total = this._domTotalTranslationEntries;
        if (!total) {
            bar.dataset.state = "starting";
            status.textContent = "Preparing page text";
            if (progressFill) progressFill.style.width = "";
            if (progressMeta) progressMeta.textContent = "";
            return;
        }
        const completed = Math.min(this._domCompletedTranslationEntries, total);
        const percent = Math.round((completed / total) * 100);
        bar.dataset.state = completed >= total ? "complete" : "running";
        status.textContent =
            completed >= total ? "Translation complete" : `${completed} of ${total} translated`;
        if (progressFill) progressFill.style.width = `${percent}%`;
        if (progressMeta) progressMeta.textContent = `${percent}%`;
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
        this.destroyDomOriginalTooltip();
        this._domPageBanner = null;
        this._domTranslationCache.clear();
        this._domTotalTranslationEntries = 0;
        this._domCompletedTranslationEntries = 0;
        this.resetDomPageRuntimeState();
        this._domCoverageScanCount = 0;
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
        const enqueue = (node) => {
            this._pendingNodes.add(node);
            if (this._scheduleBatch) return;
            this._scheduleBatch = requestAnimationFrame(() => {
                this._scheduleBatch = null;
                const batch = Array.from(this._pendingNodes);
                this._pendingNodes.clear();
                this.translateBatchNodes(batch);
            });
        };
        this._mo = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === "childList") {
                    this._domPageRootElements = this.getDomPageTranslationRoots();
                    m.addedNodes &&
                        m.addedNodes.forEach((n) =>
                            this.enqueueDomPageTextTreeForMutation(n, enqueue)
                        );
                    this.scheduleDomPageIncrementalScan(250);
                } else if (m.type === "characterData") {
                    const tn = m.target;
                    this._translatedSet.delete(tn);
                    this._domPendingTextNodes.delete(tn);
                    this._domFailedTextNodes.delete(tn);
                    if (this.isMeaningfulDomPageTextNode(tn)) enqueue(tn);
                }
            }
        });
        this._mo.observe(document.documentElement || document.body, {
            subtree: true,
            childList: true,
            characterData: true,
        });
        this._domScrollScanHandler = () => this.scheduleDomPageIncrementalScan(500);
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
            const entries = groups.map((group) =>
                this.assignDomPageApplySequence(this.createDomPageTranslationEntry(group))
            );
            const uncachedEntries = [];
            entries.forEach((entry) => {
                const cached = this._domTranslationCache.get(entry.cacheKey);
                if (cached) {
                    this.queueDomPageEntryApply(entry, cached);
                    return;
                }
                uncachedEntries.push(entry);
            });
            const batches = this.buildDomPageTranslationBatches(uncachedEntries);
            this._domTotalTranslationEntries += batches.length;
            this.updateDomPageBannerStatus();
            batches.forEach((batch) => this.enqueueDomPageBatchTranslation(batch));
            return;
        }
        this._domTotalTranslationEntries += groups.length;
        this.updateDomPageBannerStatus();
        groups.forEach((group) => {
            const entry = this.assignDomPageApplySequence(
                this.createDomPageTranslationEntry(group)
            );
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
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const batchedSourceText = buildSegmentedTranslationText(entries);
                const result = await this.translateWithDomPageEngine(batchedSourceText, sl, tl);
                this.recordDomPageTokenUsage(result);
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
                    this.enqueueDomPageBatchTranslation(entries.slice(mid), { front: true });
                    this.enqueueDomPageBatchTranslation(entries.slice(0, mid), { front: true });
                } else {
                    entries.forEach((entry) => this.retryDomPageEntryTranslation(entry, 0));
                }
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

    enqueueDomPageGroupTranslation(group, attempt = 0, options = {}) {
        const run = async () => {
            if (this._domCircuitBreakerActive) {
                this.skipDomPageEntryApply({ group });
                this.markDomPageTranslationEntriesCompleted();
                return;
            }
            this._domActiveTranslations += 1;
            const entry = this.assignDomPageApplySequence(
                this.createDomPageTranslationEntry(group)
            );
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const { readableBlockReplacement } = entry;
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

                if (readableBlockReplacement) {
                    const block = readableBlockReplacement.block;
                    const rejectionReason = this.getDomPageEntryRejectionReason(entry, translated);
                    if (rejectionReason) {
                        this.retryDomPageEntryTranslation(entry, attempt, {
                            reason: rejectionReason,
                        });
                        this.markDomPageTranslationEntriesCompleted();
                        return;
                    }
                    if (translated && block && block.isConnected) {
                        this.queueDomPageEntryApply(entry, translated);
                    } else {
                        this.skipDomPageEntryApply(entry);
                    }
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
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const cacheKey = `${this._domPageTranslateOptions.engine}|${sl}|${tl}|${item.text}`;
                let translated = this._domTranslationCache.get(cacheKey);
                if (!translated) {
                    const result = await this.translateWithDomPageEngine(item.text, sl, tl);
                    this.recordDomPageTokenUsage(result);
                    if (result && result.translationFailed) {
                        throw new Error(result.errorMsg || "Page translation request failed.");
                    }
                    translated = result.mainMeaning || result.translatedText;
                    if (!this.canUseDomPageTranslation(item.text, translated)) {
                        throw new Error("Suspicious page translation output rejected.");
                    }
                    this.cacheDomPageTranslation(cacheKey, translated);
                }
                if (translated && item.node.parentElement === item.parent) {
                    this.applyWithFadeIn(item.node, translated, "text", item.text);
                    this._translatedSet.add(item.node);
                }
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this._translatedSet.delete(item.node);
            } finally {
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

// Create the object.
window.EdgeTranslateBannerController = new BannerController();

export { BannerController };
