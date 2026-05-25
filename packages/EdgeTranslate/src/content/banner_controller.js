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
        this._domPageBannerHeight = 56;

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
        this._captionLastSource = "";
        this._captionRenderedSource = "";
        this._captionPendingSource = "";
        this._captionInFlight = false;
        this._captionInFlightSource = "";
        this._captionLastRequestId = 0;
        this._captionTranslationCache = new Map();
        this._captionTranslationCacheMax = 200;
        this._captionDebounceTimer = null;
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
        this._captionPrefetchCues = [];
        this._captionPrefetchLoadPromise = null;
        this._captionPrefetchInFlight = new Set();
        this._captionPrefetchMaxInFlight = 12;
        this._captionPrefetchWindowMs = 90000;
        this._captionPrefetchBatchSize = 8;
        this._captionPrefetchBatchMaxChars = 900;
        this._captionBatchQueue = new Map();
        this._captionBatchTimer = null;
        this._captionBatchDelayMs = 220;
        this._captionBatchMaxSize = 4;

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
            const engine = localConfig.mode === "openai" ? "openai" : "googleAiStudio";
            const model =
                engine === "openai" ? localConfig.openaiModel || "" : localConfig.model || "";
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
        if (this._captionObserver) {
            this._captionObserver.disconnect();
            this._captionObserver = null;
        }
        if (this._captionDebounceTimer) {
            clearTimeout(this._captionDebounceTimer);
            this._captionDebounceTimer = null;
        }
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
        this._captionDisplayItems = [];
        this._captionPrefetchVideoId = "";
        this._captionPrefetchTrackKey = "";
        this._captionPrefetchCues = [];
        this._captionPrefetchLoadPromise = null;
        this._captionPrefetchInFlight.clear();
        this._captionBatchQueue.clear();
        this._captionInFlight = false;
        this._captionInFlightSource = "";
        this._captionLastRequestId += 1;
        if (this._captionOverlay) {
            this._captionOverlay.style.opacity = "0";
            this._captionOverlay.hidden = true;
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
            maxWidth: "min(78vw, 900px)",
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
            pointerEvents: "none",
            zIndex: "2147483647",
            opacity: "0",
            transition: "opacity 120ms cubic-bezier(.2, 0, 0, 1)",
        });
        overlay.hidden = true;
        document.documentElement.appendChild(overlay);
        this._captionOverlay = overlay;
        return overlay;
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
        this.pushRealtimeCaptionDisplayItem(text, sourceText);
        this.renderRealtimeCaptionOverlay();
        overlay.hidden = false;
        overlay.style.opacity = "1";
        this._captionRenderedSource = sourceText;
        this._captionLastVisibleAt = Date.now();
    }

    pushRealtimeCaptionDisplayItem(text, sourceText) {
        const translatedText = String(text || "").trim();
        const source = String(sourceText || "");
        if (!translatedText) return;
        this._captionDisplayItems = this._captionDisplayItems.filter(
            (item) => item.source !== source && item.text !== translatedText
        );
        this._captionDisplayItems.push({ source, text: translatedText });
        if (this._captionDisplayItems.length > this._captionDisplayMax) {
            this._captionDisplayItems = this._captionDisplayItems.slice(-this._captionDisplayMax);
        }
    }

    renderRealtimeCaptionOverlay() {
        const overlay = this.ensureRealtimeCaptionOverlay();
        overlay.replaceChildren();
        const items = this._captionDisplayItems.slice(-this._captionDisplayMax);
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
                textWrap: "balance",
                overflowWrap: "break-word",
            });
            overlay.appendChild(line);
        });
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
        }, delay);
    }

    hideRealtimeCaptionOverlayNow() {
        this.clearRealtimeCaptionHideTimer();
        if (this._captionOverlay) {
            this._captionOverlay.style.opacity = "0";
            this._captionOverlay.hidden = true;
        }
        this._captionDisplayItems = [];
        this._captionRenderedSource = "";
    }

    scheduleRealtimeCaptionTranslation() {
        if (!this._captionModeEnabled) return;
        if (this._captionDebounceTimer) clearTimeout(this._captionDebounceTimer);
        this._captionDebounceTimer = setTimeout(() => {
            this._captionDebounceTimer = null;
            this.translateCurrentRealtimeCaption();
        }, 80);
        this.scheduleYouTubeCaptionPrefetch();
    }

    scheduleYouTubeCaptionPrefetch(delay = 600) {
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

    getCurrentYouTubeCaptionText() {
        const normalize = (value) =>
            String(value || "")
                .replace(/\u00a0/g, " ")
                .replace(/[ \t\f\v]+/g, " ")
                .replace(/ *\n */g, "\n")
                .trim();
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
                .map((node) => normalize(node.textContent))
                .filter(Boolean)
                .filter((text) => {
                    if (seen.has(text)) return false;
                    seen.add(text);
                    return true;
                });
        };
        const containers = Array.from(
            document.querySelectorAll(".ytp-caption-window-container, .caption-window")
        ).filter(isVisible);
        const containerLines = containers.flatMap((container) => {
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
        });
        const lines = containerLines.length
            ? containerLines
            : fromNodes(
                  document.querySelectorAll(".ytp-caption-segment, [class*='caption-segment']")
              );
        return lines.join("\n").trim();
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
            ["languageSetting", "LocalTranslatorConfig", "DefaultTranslator"],
            DEFAULT_SETTINGS
        );
        const localConfig = result.LocalTranslatorConfig || {};
        const aiMode = localConfig.mode === "googleAiStudio" || localConfig.mode === "openai";
        const options = {
            sl: result.languageSetting?.sl || "auto",
            tl: result.languageSetting?.tl || "en",
            translatorId:
                localConfig.enabled && aiMode ? "LocalTranslate" : result.DefaultTranslator,
            engine: localConfig.enabled && aiMode ? localConfig.mode : "",
        };
        this._captionOptionsCache = options;
        this._captionOptionsCacheAt = now;
        return options;
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

    pickYouTubeCaptionTrack(tracks, options) {
        const candidates = tracks.filter((track) => track?.baseUrl);
        if (!candidates.length) return null;
        const sourceLanguage = this.normalizeCaptionLanguageCode(options.sl);
        const targetLanguage = this.normalizeCaptionLanguageCode(options.tl);
        if (sourceLanguage && sourceLanguage !== "auto") {
            const exact = candidates.find(
                (track) => this.normalizeCaptionLanguageCode(track.languageCode) === sourceLanguage
            );
            if (exact) return exact;
        }
        const nonTarget =
            targetLanguage && targetLanguage !== "auto"
                ? candidates.filter(
                      (track) =>
                          this.normalizeCaptionLanguageCode(track.languageCode) !== targetLanguage
                  )
                : candidates;
        return (
            nonTarget.find((track) => !/^a\./.test(track.vssId || "")) ||
            nonTarget[0] ||
            candidates[0]
        );
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
        const response = await fetch(url, { credentials: "include" });
        if (!response?.ok) return [];
        const body = await response.text();
        const cues = body.trim().startsWith("{")
            ? this.parseYouTubeJsonCaptionCues(body)
            : this.parseYouTubeXmlCaptionCues(body);
        return this.addYouTubeCaptionCueGroups(this.compactYouTubeCaptionCues(cues));
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
                this._captionPrefetchCues = [];
            }
            const track = this.pickYouTubeCaptionTrack(this.getYouTubeCaptionTracks(), options);
            const trackKey = track
                ? `${track.baseUrl}|${track.languageCode || ""}|${track.vssId || ""}`
                : "";
            if (
                !track ||
                (trackKey === this._captionPrefetchTrackKey && this._captionPrefetchCues.length)
            ) {
                return false;
            }
            const cues = await this.fetchYouTubeCaptionCues(track);
            if (!cues.length) return false;
            this._captionPrefetchTrackKey = trackKey;
            this._captionPrefetchCues = cues;
            return true;
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
            await this.loadYouTubeCaptionPrefetchCues(options);
            this.warmRealtimeCaptionPrefetchCache(options);
        } catch {
            // Prefetch is opportunistic; visible-caption translation remains authoritative.
        } finally {
            if (reschedule) this.scheduleYouTubeCaptionPrefetch(1000);
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
        this.prefetchRealtimeCaptionSources(entries, options);
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
        Promise.resolve(this.channel.request("translate_text_quiet", request))
            .then((result) => {
                const translated = String(
                    result?.mainMeaning || result?.translatedText || ""
                ).trim();
                if (!translated || result?.translationFailed) return;
                if (!isBatch) {
                    this.cacheRealtimeCaptionTranslation(entries[0].cacheKey, translated);
                    return;
                }
                const parsed = this.parseRealtimeCaptionBatchTranslation(
                    translated,
                    entries.length
                );
                entries.forEach((entry, index) => {
                    if (parsed[index])
                        this.cacheRealtimeCaptionTranslation(entry.cacheKey, parsed[index]);
                });
            })
            .catch(() => {})
            .finally(() => {
                entries.forEach((entry) => this._captionPrefetchInFlight.delete(entry.cacheKey));
            });
        return true;
    }

    findPrefetchedRealtimeCaptionTranslation(sourceText, options) {
        const direct = this._captionTranslationCache.get(
            this.getRealtimeCaptionCacheKey(sourceText, options)
        );
        if (direct) return { text: direct };
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

    showRealtimeCaptionTranslatedText(translated, sourceText) {
        if (!translated) return;
        this.showRealtimeCaptionOverlay(translated, sourceText);
    }

    shouldBatchRealtimeCaptionTranslation(options) {
        return (
            options?.translatorId === "LocalTranslate" &&
            (options.engine === "openai" || options.engine === "googleAiStudio")
        );
    }

    queueRealtimeCaptionBatchTranslation(sourceText, options) {
        const cacheKey = this.getRealtimeCaptionCacheKey(sourceText, options);
        const cached = this._captionTranslationCache.get(cacheKey);
        if (cached) return Promise.resolve(cached);
        return new Promise((resolve) => {
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
            this._captionLastRequestId += 1;
            this.hideRealtimeCaptionOverlayNow();
            return;
        }
        const sourceText = this.getCurrentYouTubeCaptionText();
        if (!sourceText) {
            this._captionLastSource = "";
            this._captionPendingSource = "";
            this._captionLastRequestId += 1;
            this.scheduleRealtimeCaptionOverlayHide();
            return;
        }
        if (sourceText === this._captionLastSource) {
            const overlayVisible = this._captionOverlay && !this._captionOverlay.hidden;
            if (overlayVisible && this._captionRenderedSource === sourceText) return;
            if (this._captionInFlight && this._captionInFlightSource === sourceText) return;
        }
        this.clearRealtimeCaptionHideTimer();
        this._captionLastSource = sourceText;
        if (this._captionInFlight) {
            this._captionPendingSource = sourceText;
            return;
        }
        await this.translateRealtimeCaptionSource(sourceText);
    }

    async translateRealtimeCaptionSource(sourceText) {
        if (!this._captionModeEnabled || !sourceText) return;
        const requestId = ++this._captionLastRequestId;
        let directRequestStarted = false;
        try {
            const options = await this.getRealtimeCaptionTranslateOptions();
            const contextRequest = this.getRealtimeCaptionContextRequestForOptions(
                sourceText,
                options
            );
            const requestSourceText = contextRequest.sourceText;
            const cacheKey =
                contextRequest.cacheKey ||
                this.getRealtimeCaptionCacheKey(requestSourceText, options);
            const cached = this.findPrefetchedRealtimeCaptionTranslation(sourceText, options);
            if (cached?.text) {
                if (!this.isRealtimeCaptionRequestStillCurrent(sourceText)) return;
                this.showRealtimeCaptionTranslatedText(cached.text, sourceText);
                return;
            }
            if (this.shouldBatchRealtimeCaptionTranslation(options)) {
                const translated = await this.queueRealtimeCaptionBatchTranslation(
                    requestSourceText,
                    options
                );
                if (
                    requestId !== this._captionLastRequestId ||
                    !this._captionModeEnabled ||
                    sourceText !== this._captionLastSource
                ) {
                    return;
                }
                if (!translated) return;
                this.cacheRealtimeCaptionTranslation(cacheKey, translated);
                this.showRealtimeCaptionTranslatedText(translated, sourceText);
                return;
            }
            this._captionInFlight = true;
            this._captionInFlightSource = sourceText;
            directRequestStarted = true;
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
            if (
                requestId !== this._captionLastRequestId ||
                !this._captionModeEnabled ||
                sourceText !== this._captionLastSource
            ) {
                return;
            }
            const translated = String(result?.mainMeaning || result?.translatedText || "").trim();
            if (!translated || result?.translationFailed) return;
            this.cacheRealtimeCaptionTranslation(cacheKey, translated);
            this.showRealtimeCaptionTranslatedText(translated, sourceText);
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
                const pendingSource = this._captionPendingSource;
                this._captionPendingSource = "";
                if (
                    this._captionModeEnabled &&
                    pendingSource &&
                    pendingSource !== sourceText &&
                    pendingSource === this._captionLastSource
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
        });
    }

    getDomPageTranslationGroupOptions() {
        return { maxChars: 12000 };
    }

    getReadableBlockReplacementOptions() {
        return { maxChars: 12000 };
    }

    getDomPageBatchOptions() {
        if (this._domPageTranslateOptions.engine === "openai") {
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
        if (engine === "openai") return 16;
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

    isSuspiciousDomPageTranslation(sourceText, translatedText) {
        const source = String(sourceText || "").trim();
        const translated = String(translatedText || "").trim();
        if (!translated) return true;

        const sourceHasSubtitleCue = /\d{1,4}\s*\r?\n?\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/i.test(
            source
        );
        const translatedHasSubtitleCue =
            /\d{1,4}\s*\r?\n?\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/i.test(translated);
        if (!sourceHasSubtitleCue && translatedHasSubtitleCue) return true;

        if (
            /\[\[\d+:[a-z][a-z0-9-]*]]|<<<EDGE_TRANSLATE_SEGMENT_|Source language:|Target language:|Translate naturally|Output only the translation/i.test(
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
        if (foreignTokens.length >= 4 && foreignTokens.length > sourceTokens.size + 2) {
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
        return String(text || "")
            .replace(/\[\[EDGE_TRANSLATE_LINK_\d+]]/g, "")
            .replace(/\[\[\/EDGE_TRANSLATE_LINK_\d+]]/g, "");
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
                "font-family: Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                "pointer-events: none",
            ].join(";");
            const root = host.attachShadow({ mode: "open" });
            root.innerHTML = `
                <style>
                    :host {
                        color-scheme: light;
                        --et-primary: #1a73e8;
                        --et-primary-container: #e8f0fe;
                        --et-on-primary-container: #174ea6;
                        --et-surface: #fff;
                        --et-surface-container: #f8fafd;
                        --et-outline: #dadce0;
                        --et-outline-variant: #e8eaed;
                        --et-text: #202124;
                        --et-muted: #5f6368;
                        --et-success: #188038;
                        --et-error: #d93025;
                    }
                    .bar {
                        position: relative;
                        height: ${this._domPageBannerHeight}px;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 16px;
                        box-sizing: border-box;
                        padding: 8px 16px 9px;
                        color: var(--et-text);
                        background: var(--et-surface);
                        border-bottom: 1px solid var(--et-outline-variant);
                        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.14), 0 2px 6px rgba(60, 64, 67, 0.08);
                        font-size: 13px;
                        line-height: 1.2;
                        pointer-events: auto;
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
                        width: 10px;
                        height: 10px;
                        border-radius: 999px;
                        flex: 0 0 auto;
                        background: var(--et-primary);
                        box-shadow: 0 0 0 5px rgba(26, 115, 232, 0.10);
                    }
                    .text {
                        display: flex;
                        flex-direction: column;
                        min-width: 0;
                        gap: 3px;
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
                        font-size: 14px;
                        font-weight: 500;
                    }
                    .provider {
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        max-width: 180px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        border-radius: 999px;
                        padding: 3px 8px;
                        color: var(--et-on-primary-container);
                        background: var(--et-primary-container);
                        font-size: 12px;
                        font-weight: 600;
                    }
                    .provider span {
                        min-width: 0;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }
                    .model {
                        display: inline-flex;
                        align-items: center;
                        max-width: 220px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        color: var(--et-muted);
                        font-size: 12px;
                        font-weight: 500;
                    }
                    .provider-logo {
                        width: 16px;
                        height: 16px;
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
                        max-width: min(62vw, 720px);
                        font-size: 12px;
                        font-weight: 400;
                    }
                    .actions {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        flex: 0 0 auto;
                    }
                    .progress-meta {
                        min-width: 48px;
                        box-sizing: border-box;
                        padding: 0 2px;
                        border-radius: 999px;
                        color: var(--et-muted);
                        font-size: 12px;
                        text-align: right;
                        font-variant-numeric: tabular-nums;
                    }
                    .token-meta {
                        display: none;
                        max-width: 260px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        box-sizing: border-box;
                        padding: 5px 9px;
                        border-radius: 999px;
                        background: var(--et-surface-container);
                        color: var(--et-muted);
                        border: 1px solid var(--et-outline-variant);
                        font-size: 12px;
                        font-weight: 500;
                        font-variant-numeric: tabular-nums;
                    }
                    button {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        border: 0;
                        border-radius: 999px;
                        background: transparent;
                        color: var(--et-on-primary-container);
                        cursor: pointer;
                        font: inherit;
                        height: 36px;
                        min-width: 36px;
                        padding: 0 10px;
                        font-weight: 500;
                        transition: background-color 120ms cubic-bezier(0.2, 0, 0, 1), box-shadow 120ms cubic-bezier(0.2, 0, 0, 1);
                    }
                    button svg {
                        width: 18px;
                        height: 18px;
                        flex: 0 0 auto;
                        fill: currentColor;
                    }
                    button:hover { background: rgba(26, 115, 232, 0.08); }
                    button:active { background: rgba(26, 115, 232, 0.14); }
                    .hide {
                        padding: 0 12px;
                        background: var(--et-primary-container);
                    }
                    .close {
                        color: var(--et-muted);
                        padding: 0;
                    }
                    .progress {
                        position: absolute;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        height: 2px;
                        overflow: hidden;
                        background: transparent;
                    }
                    .progress-fill {
                        width: 0%;
                        height: 100%;
                        background: var(--et-primary);
                        transition: width 180ms ease;
                    }
                    .bar[data-state="starting"] .progress-fill {
                        width: 32%;
                        animation: indeterminate 1.2s ease-in-out infinite;
                    }
                    .bar[data-state="error"] .status-dot {
                        background: var(--et-error);
                        box-shadow: 0 0 0 4px rgba(217, 48, 37, 0.10);
                    }
                    .bar[data-state="error"] .progress-fill {
                        width: 100%;
                        background: var(--et-error);
                    }
                    .bar[data-state="complete"] .status-dot {
                        background: var(--et-success);
                        box-shadow: 0 0 0 4px rgba(24, 128, 56, 0.10);
                    }
                    .bar[data-state="complete"] .progress-fill {
                        background: var(--et-success);
                    }
                    .restore {
                        position: fixed;
                        top: 10px;
                        right: 12px;
                        display: none;
                        align-items: center;
                        gap: 8px;
                        height: 36px;
                        padding: 0 14px 0 12px;
                        border: 1px solid var(--et-outline);
                        border-radius: 999px;
                        background: var(--et-surface);
                        color: var(--et-on-primary-container);
                        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.18), 0 3px 8px rgba(60, 64, 67, 0.12);
                        font: inherit;
                        font-size: 13px;
                        font-weight: 500;
                        pointer-events: auto;
                    }
                    :host([data-visible="false"]) .restore {
                        display: inline-flex;
                    }
                    .restore:hover {
                        background: var(--et-surface-container);
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
                    @keyframes indeterminate {
                        0% { transform: translateX(-110%); }
                        55% { transform: translateX(95%); }
                        100% { transform: translateX(220%); }
                    }
                    @media (max-width: 640px) {
                        .bar { gap: 8px; padding-left: 12px; padding-right: 8px; }
                        .provider { max-width: 120px; }
                        .model { max-width: 130px; }
                        .status { max-width: 42vw; }
                        .token-meta { max-width: 120px; }
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
                    }
                </style>
                <div class="bar" role="status" aria-live="polite" data-role="bar">
                    <div class="main">
                        <span class="status-dot" aria-hidden="true"></span>
                        <div class="text">
                            <div class="summary">
                                <span class="title" data-role="title">Page translation</span>
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
                                <path d="M2.1 3.51 3.51 2.1 21.9 20.49l-1.41 1.41-3.08-3.08A11.46 11.46 0 0 1 12 20C7 20 2.73 16.89 1 12.5a11.82 11.82 0 0 1 4.2-5.34L2.1 3.51Zm5.66 6.25A4.68 4.68 0 0 0 7.5 12a4.5 4.5 0 0 0 4.5 4.5c.78 0 1.51-.2 2.15-.55l-1.69-1.69a2.48 2.48 0 0 1-2.72-2.72L7.76 9.76ZM12 5c5 0 9.27 3.11 11 7.5a11.7 11.7 0 0 1-3.18 4.35l-2.84-2.84c.33-.61.52-1.29.52-2.01A4.5 4.5 0 0 0 12 7.5c-.72 0-1.4.19-2.01.52L7.82 5.85A11.57 11.57 0 0 1 12 5Zm0 4.5A2.5 2.5 0 0 1 14.5 12c0 .16-.02.32-.05.47L11.53 9.55c.15-.03.31-.05.47-.05Z" />
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
                    this.retryDomPageEntryTranslation(entry, attempt, { reason: "line-count" });
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }
                if (
                    translatedParts.some((part, index) =>
                        this.isSuspiciousDomPageTranslation(group.texts[index], part)
                    )
                ) {
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
