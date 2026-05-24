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

        // DOM fallback observer state
        this._mo = null;
        this._translatedSet = new WeakSet();
        this._translatedBlocks = new WeakSet();
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
        this._domPageRootElements = [];
        this._domDeferredNodes = new Set();
        this._domDeferredNodeObserver = null;
        this._domDeferredElementNodes = new Map();
        this._domDeferredTimer = null;
        this._domIdleHandle = null;
        this._onDeviceBridgePromise = null;
        this._onDeviceBridgeRequestId = 0;
        this._onDeviceBridgePending = new Map();

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
            this._domPageTranslateOptions = {
                engine: this.normalizeDomPageTranslateEngine(detail.engine),
                sl: detail.sl || "auto",
                tl: detail.tl || "en",
            };
            this.currentTranslator = "dom";
            this._domTranslationQueue = [];
            this._domActiveTranslations = 0;
            this._domCompletedTranslationEntries = 0;
            this._domTotalTranslationEntries = 0;
            this._domBatchFailureCount = 0;
            this._domFlushBurstDone = false;
            const concurrencyByEngine = {
                googleAiStudio: 8,
                openai: 8,
            };
            this._domMaxConcurrentTranslations =
                concurrencyByEngine[this._domPageTranslateOptions.engine] || 2;
            this._domResolvedSourceLanguage = this.resolveDomPageSourceLanguage(
                this._domPageTranslateOptions.sl
            );
            this._domPageRootElements = this.getDomPageTranslationRoots();
            this.showDomPageBanner();
            this.startDomFallback();
            this.startDomScrollPrioritizer();
            console.log(`[ET] AI page engine=${this._domPageTranslateOptions.engine}`);
            this.startFullPageBatchTranslation();
        });

        // Background may request canceling DOM fallback scheduling when banner is visible
        this.channel.on("page_translate_control", (detail) => {
            if (detail && detail.action === "cancel_dom_fallback") {
                // nothing needed here yet (fallback scheduling is background-side), keep hook for future use
            }
        });

        window.addEventListener("message", this.handleOnDeviceBridgeResponse.bind(this));
    }

    normalizeDomPageTranslateEngine(engine) {
        if (engine === "openai") return "openai";
        return "googleAiStudio";
    }

    getDomPageTranslationRoots() {
        return [document.body].filter(Boolean);
    }

    startFullPageBatchTranslation() {
        const nodes = this.collectDomPageTextNodes(this._domPageRootElements);
        const { immediate, deferred } = this.partitionDomPageTextNodes(nodes);
        if (immediate.length) this.translateBatchNodesPriority(immediate);
        if (deferred.length) this.translateBatchNodes(deferred);
    }

    isNodeInDomPageTranslationRoot(node) {
        if (!this._domPageRootElements || !this._domPageRootElements.length) return true;
        return this._domPageRootElements.some((root) => root && root.contains(node));
    }

    isMeaningfulDomPageTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        if (!this.isNodeInDomPageTranslationRoot(node)) return false;
        const text = String(node.nodeValue || "").trim();
        if (text.length < 2) return false;
        const p = node.parentElement;
        if (!p) return false;
        const tn = p.tagName;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION)$/i.test(tn)) return false;
        let ancestor = p;
        while (ancestor && ancestor !== document.documentElement) {
            if (this._translatedBlocks.has(ancestor)) return false;
            ancestor = ancestor.parentElement;
        }
        if (this._translatedSet.has(node)) return false;
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

    /**
     * Check if node is in the EXACT current viewport (no margin).
     * Used for highest-priority translation of what user sees right now.
     */
    isDomPageTextNodeInExactViewport(node) {
        const element = node && node.parentElement;
        if (!element || typeof element.getBoundingClientRect !== "function") return false;
        const rect = element.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const vh = window.innerHeight || 800;
        return rect.bottom >= 0 && rect.top <= vh;
    }

    isDomPageTextNodeNearViewport(node) {
        const element = node && node.parentElement;
        if (!element || typeof element.getBoundingClientRect !== "function") return true;
        const rect = element.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const margin = Math.max(600, Math.floor((window.innerHeight || 800) * 0.75));
        return rect.bottom >= -margin && rect.top <= (window.innerHeight || 800) + margin;
    }

    /**
     * Partition nodes into immediate (near viewport) and deferred.
     * Sort immediate nodes by vertical position (top-to-bottom) so
     * content at the top of the viewport is translated first.
     */
    partitionDomPageTextNodes(nodes) {
        const immediate = [];
        const deferred = [];
        for (const node of nodes || []) {
            if (this.isDomPageTextNodeNearViewport(node)) immediate.push(node);
            else deferred.push(node);
        }
        // Sort by vertical position: top of page first
        immediate.sort((a, b) => {
            const aRect = a.parentElement && a.parentElement.getBoundingClientRect();
            const bRect = b.parentElement && b.parentElement.getBoundingClientRect();
            return (aRect ? aRect.top : 0) - (bRect ? bRect.top : 0);
        });
        return { immediate, deferred };
    }

    /**
     * Scroll-aware prioritizer: when user scrolls, find untranslated nodes
     * in the current viewport and push them to the FRONT of the queue.
     */
    startDomScrollPrioritizer() {
        if (this._domScrollHandler) return;
        let scrollTimer = null;
        this._domScrollHandler = () => {
            if (scrollTimer) return;
            scrollTimer = setTimeout(() => {
                scrollTimer = null;
                this.prioritizeViewportTranslation();
            }, 150);
        };
        window.addEventListener("scroll", this._domScrollHandler, { passive: true });
    }

    /**
     * Find untranslated nodes in the exact viewport and translate them immediately
     * by pushing to the FRONT of the queue.
     */
    prioritizeViewportTranslation() {
        if (!this._domPageRootElements || this.currentTranslator !== "dom") return;
        if (this._domCircuitBreakerActive) return;
        const viewportNodes = [];
        for (const root of this._domPageRootElements) {
            if (!root) continue;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (
                    !this._translatedSet.has(node) &&
                    this.isMeaningfulDomPageTextNode(node) &&
                    this.isDomPageTextNodeInExactViewport(node)
                ) {
                    viewportNodes.push(node);
                }
            }
        }
        if (!viewportNodes.length) return;
        // Sort top-to-bottom
        viewportNodes.sort((a, b) => {
            const aRect = a.parentElement && a.parentElement.getBoundingClientRect();
            const bRect = b.parentElement && b.parentElement.getBoundingClientRect();
            return (aRect ? aRect.top : 0) - (bRect ? bRect.top : 0);
        });
        this.translateBatchNodesPriority(viewportNodes);
    }

    scheduleDeferredDomPageTranslation(nodes) {
        if (!nodes || !nodes.length) return;
        nodes.forEach((node) => this._domDeferredNodes.add(node));
        this.observeDeferredDomPageNodes(nodes);
        this.scheduleIdleDeferredDomPageTranslation();
    }

    observeDeferredDomPageNodes(nodes) {
        if (typeof IntersectionObserver !== "function") return;
        if (!this._domDeferredNodeObserver) {
            this._domDeferredNodeObserver = new IntersectionObserver(
                (entries) => {
                    const visibleNodes = [];
                    entries.forEach((entry) => {
                        if (!entry.isIntersecting) return;
                        const elementNodes = this._domDeferredElementNodes.get(entry.target);
                        this._domDeferredElementNodes.delete(entry.target);
                        this._domDeferredNodeObserver.unobserve(entry.target);
                        if (elementNodes) {
                            elementNodes.forEach((node) => {
                                if (this._domDeferredNodes.delete(node)) visibleNodes.push(node);
                            });
                        }
                    });
                    if (visibleNodes.length) this.translateBatchNodes(visibleNodes);
                },
                { rootMargin: "900px 0px 900px 0px" }
            );
        }

        nodes.forEach((node) => {
            const element = node && node.parentElement;
            if (!element) return;
            if (!this._domDeferredElementNodes.has(element)) {
                this._domDeferredElementNodes.set(element, new Set());
                this._domDeferredNodeObserver.observe(element);
            }
            this._domDeferredElementNodes.get(element).add(node);
        });
    }

    scheduleIdleDeferredDomPageTranslation() {
        if (this._domIdleHandle || this._domDeferredTimer) return;
        const flush = (limit = 100) => {
            this._domIdleHandle = null;
            this._domDeferredTimer = null;
            const nodes = Array.from(this._domDeferredNodes).slice(0, limit);
            nodes.forEach((node) => this._domDeferredNodes.delete(node));
            if (nodes.length) this.translateBatchNodes(nodes);
            if (this._domDeferredNodes.size) {
                this._domDeferredTimer = setTimeout(() => {
                    this._domDeferredTimer = null;
                    this.scheduleIdleDeferredDomPageTranslation();
                }, 200);
            }
        };
        if (typeof requestIdleCallback === "function") {
            this._domIdleHandle = requestIdleCallback(() => flush(120), { timeout: 800 });
        } else {
            this._domDeferredTimer = setTimeout(() => flush(100), 400);
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
        return { maxChars: 9000 };
    }

    getReadableBlockReplacementOptions() {
        return { maxChars: 9000 };
    }

    getDomPageBatchOptions() {
        if (this._domBatchFailureCount >= 2) return { maxChars: 5000, maxItems: 6 };
        if (this._domBatchFailureCount >= 1) return { maxChars: 7000, maxItems: 8 };
        return { maxChars: 9000, maxItems: 14 };
    }

    recordDomPageBatchFailure() {
        this._domBatchFailureCount += 1;
        if (this._domBatchFailureCount >= 5) {
            this.triggerDomPageCircuitBreaker();
        }
    }

    recordDomPageBatchSuccess() {
        if (this._domBatchFailureCount > 0) this._domBatchFailureCount -= 1;
    }

    /**
     * Circuit breaker: pause translation for 30s when too many consecutive failures.
     * Prevents burning API tokens on persistent errors (e.g., invalid key, rate limit).
     */
    triggerDomPageCircuitBreaker() {
        if (this._domCircuitBreakerActive) return;
        this._domCircuitBreakerActive = true;
        // Drain queue to stop further requests
        if (this._domTranslationQueue) this._domTranslationQueue.length = 0;
        this.updateDomPageBannerStatus("error");
        setTimeout(() => {
            this._domCircuitBreakerActive = false;
            this._domBatchFailureCount = 0;
            this.updateDomPageBannerStatus();
            this.flushDomTranslationQueue();
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

    createDomPageTranslationEntry(group) {
        const { tl } = this._domPageTranslateOptions;
        const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
        const readableBlockReplacement = createReadableBlockReplacement(
            group,
            this.getReadableBlockReplacementOptions()
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
            cacheMode,
            role,
            sl,
            tl,
            fnv1a32(sourceText),
        ].join("|");
        return { group, readableBlockReplacement, role, sourceText, cacheKey };
    }

    applyDomPageTranslatedEntry(entry, translated) {
        if (!translated) return false;
        const { group, readableBlockReplacement } = entry;

        if (readableBlockReplacement) {
            const block = readableBlockReplacement.block;
            if (block && block.isConnected) {
                this._translatedBlocks.add(block);
                this.applyWithFadeIn(block, translated, "block");
                return true;
            }
            return false;
        }

        const translatedParts = splitTranslatedContext(translated, group.nodes.length);
        if (!translatedParts) return false;

        group.nodes.forEach((node, index) => {
            if (translatedParts[index] && node.parentElement) {
                this.applyWithFadeIn(node, translatedParts[index], "text");
            }
        });
        return true;
    }

    enqueueDomPageEntryNodeTranslations(entry, priority = false) {
        const group = entry && entry.group;
        if (!group || !group.nodes || !group.nodes.length) return;
        this._domTotalTranslationEntries += group.nodes.length;
        this.updateDomPageBannerStatus();
        group.nodes.forEach((node, index) => {
            this.enqueueDomPageNodeTranslation(
                {
                    node,
                    parent: node.parentElement,
                    text: group.texts[index] || String(node.nodeValue || "").trim(),
                },
                priority
            );
        });
    }

    /**
     * Apply translated text with a subtle fade-in for smooth UX.
     */
    applyWithFadeIn(node, translated, type) {
        const el = type === "block" ? node : node.parentElement;
        if (!el || !el.style) {
            if (type === "block") node.textContent = translated;
            else node.nodeValue = translated;
            return;
        }
        // Inject transition CSS once
        if (!this._domFadeStyleInjected) {
            this._domFadeStyleInjected = true;
            const style = document.createElement("style");
            style.textContent = ".et-fade-in{transition:opacity .1s ease-in;}";
            document.head.appendChild(style);
        }
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

    buildDomPageTranslationBatches(entries) {
        const batchOptions = this.getDomPageBatchOptions();
        if (!batchOptions) return [];
        if (!entries.length) return [];

        const { maxItems, maxChars } = batchOptions;

        // Calculate number of batches needed
        const batchCountByItems = Math.ceil(entries.length / maxItems);
        const totalChars = entries.reduce((sum, e) => sum + e.sourceText.length, 0);
        const batchCountByChars = Math.ceil(totalChars / maxChars);
        const numBatches = Math.max(batchCountByItems, batchCountByChars, 1);

        // Sort entries by length (longest first) for balanced distribution
        const sorted = entries
            .map((entry, idx) => ({ entry, len: entry.sourceText.length, idx }))
            .sort((a, b) => b.len - a.len);

        // Initialize batches with char tracking
        const batches = Array.from({ length: numBatches }, () => ({
            items: [],
            chars: 0,
        }));

        // Greedy load-balance: assign each entry to the lightest batch
        for (const { entry, len } of sorted) {
            // Find batch with smallest total chars that still has room
            let best = -1;
            let bestChars = Infinity;
            for (let i = 0; i < batches.length; i++) {
                if (
                    batches[i].items.length < maxItems &&
                    batches[i].chars + len <= maxChars &&
                    batches[i].chars < bestChars
                ) {
                    best = i;
                    bestChars = batches[i].chars;
                }
            }
            if (best === -1) {
                // No room — create overflow batch
                batches.push({ items: [entry], chars: len });
            } else {
                batches[best].items.push(entry);
                batches[best].chars += len;
            }
        }

        // Return non-empty batches (items only, drop tracking)
        return batches.filter((b) => b.items.length > 0).map((b) => b.items);
    }

    getDomPageTranslatorLabel() {
        switch (this._domPageTranslateOptions.engine) {
            case "googleAiStudio":
                return "Google AI Studio";
            case "openai":
                return "OpenAI";
            default:
                return "Google AI Studio";
        }
    }

    showDomPageBanner() {
        this.ensureDomPageBanner();
        this.updateDomPageBannerStatus();
        getOrSetDefaultSettings("HidePageTranslatorBanner", DEFAULT_SETTINGS).then((result) => {
            this.setDomPageBannerVisible(!result.HidePageTranslatorBanner);
        });
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
                "height: 40px",
                "z-index: 2147483647",
                "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            ].join(";");
            const root = host.attachShadow({ mode: "open" });
            root.innerHTML = `
                <style>
                    .bar {
                        height: 40px;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 12px;
                        box-sizing: border-box;
                        padding: 0 14px;
                        color: #202124;
                        background: #fff;
                        border-bottom: 1px solid rgba(60, 64, 67, 0.2);
                        box-shadow: 0 1px 3px rgba(60, 64, 67, 0.24);
                        font-size: 13px;
                    }
                    .title { font-weight: 600; }
                    .status { color: #5f6368; margin-left: 8px; }
                    .actions { display: flex; align-items: center; gap: 6px; }
                    button {
                        border: 1px solid #dadce0;
                        border-radius: 4px;
                        background: #fff;
                        color: #1a73e8;
                        cursor: pointer;
                        font: inherit;
                        height: 28px;
                        padding: 0 10px;
                    }
                    button:hover { background: #f1f3f4; }
                    .close { color: #5f6368; min-width: 28px; padding: 0 8px; }
                </style>
                <div class="bar" role="status" aria-live="polite">
                    <div>
                        <span class="title">Edge Translate</span>
                        <span class="status" data-role="status"></span>
                    </div>
                    <div class="actions">
                        <button type="button" data-action="hide">Hide</button>
                        <button type="button" class="close" data-action="close" aria-label="Close">×</button>
                    </div>
                </div>
            `;
            root.querySelector("[data-action='hide']").addEventListener("click", () => {
                this.setDomPageBannerVisible(false);
                getOrSetDefaultSettings("HidePageTranslatorBanner", DEFAULT_SETTINGS).then(
                    (result) => {
                        result.HidePageTranslatorBanner = true;
                        chrome.storage.sync.set(result);
                    }
                );
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
        host.style.display = visible ? "block" : "none";
        this.movePage("top", visible ? 40 : 0, true);
    }

    updateDomPageBannerStatus(state, message) {
        const host =
            this._domPageBanner || document.getElementById("edge-translate-dom-page-banner");
        if (!host || !host.shadowRoot) return;
        const status = host.shadowRoot.querySelector("[data-role='status']");
        if (!status) return;
        const label = this.getDomPageTranslatorLabel();
        if (state === "error") {
            status.textContent = `${label} page translation failed${
                message ? `: ${String(message).slice(0, 120)}` : ""
            }`;
            return;
        }
        const total = this._domTotalTranslationEntries;
        if (!total) {
            status.textContent = `${label} page translation is starting…`;
            return;
        }
        const completed = Math.min(this._domCompletedTranslationEntries, total);
        status.textContent = `${label} page translation ${completed}/${total}`;
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
        if (this._mo) {
            this._mo.disconnect();
            this._mo = null;
        }
        if (this._domDeferredNodeObserver) {
            this._domDeferredNodeObserver.disconnect();
            this._domDeferredNodeObserver = null;
        }
        this._domDeferredNodes.clear();
        this._domDeferredElementNodes.clear();
        if (this._domDeferredTimer) {
            clearTimeout(this._domDeferredTimer);
            this._domDeferredTimer = null;
        }
        if (this._domIdleHandle && typeof cancelIdleCallback === "function") {
            cancelIdleCallback(this._domIdleHandle);
        }
        this._domIdleHandle = null;
        if (this._domScrollHandler) {
            window.removeEventListener("scroll", this._domScrollHandler);
            this._domScrollHandler = null;
        }
        const host = document.getElementById("edge-translate-dom-page-banner");
        if (host) host.remove();
        this._domPageBanner = null;
        this._domTranslationCache.clear();
        this._domTotalTranslationEntries = 0;
        this._domCompletedTranslationEntries = 0;
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
                case "dom": {
                    this.setDomPageBannerVisible(!result.HidePageTranslatorBanner);
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
                    m.addedNodes &&
                        m.addedNodes.forEach((n) => {
                            if (n.nodeType === Node.TEXT_NODE) {
                                if (this.isMeaningfulDomPageTextNode(n)) enqueue(n);
                            } else if (n.nodeType === Node.ELEMENT_NODE) {
                                const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
                                let t;
                                while ((t = walker.nextNode())) {
                                    if (this.isMeaningfulDomPageTextNode(t)) enqueue(t);
                                }
                            }
                        });
                } else if (m.type === "characterData") {
                    const tn = m.target;
                    if (this.isMeaningfulDomPageTextNode(tn)) enqueue(tn);
                }
            }
        });
        this._mo.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
        });
    }

    /**
     * Translate a batch of text nodes with block-level context first.
     * Nodes are sorted by DOM document order to ensure top-to-bottom translation.
     */
    translateBatchNodes(nodes) {
        const eligibleNodes = [];
        for (const n of nodes) {
            const p = n.parentElement;
            if (!p || this._translatedSet.has(n)) continue;
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
            this._translatedSet.add(n);
        }
        if (!eligibleNodes.length) return;

        // Skip expensive DOM sort for large sets (>50 nodes)
        if (eligibleNodes.length <= 50) {
            eligibleNodes.sort((a, b) => {
                const pos = a.compareDocumentPosition(b);
                if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                return 0;
            });
        }

        const groupOptions = this.getDomPageTranslationGroupOptions();
        const groups = buildContextTranslationGroups(eligibleNodes, groupOptions);
        if (this.getDomPageBatchOptions()) {
            const entries = groups.map((group) => this.createDomPageTranslationEntry(group));
            const uncachedEntries = [];
            entries.forEach((entry) => {
                const cached = this._domTranslationCache.get(entry.cacheKey);
                if (cached && this.applyDomPageTranslatedEntry(entry, cached)) {
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
        groups.forEach((group) => this.enqueueDomPageGroupTranslation(group));
    }

    /**
     * Same as translateBatchNodes but inserts into the FRONT of the queue
     * for viewport-priority translation triggered by scroll.
     */
    translateBatchNodesPriority(nodes) {
        const eligibleNodes = [];
        for (const n of nodes) {
            const p = n.parentElement;
            if (!p || this._translatedSet.has(n)) continue;
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
            this._translatedSet.add(n);
        }
        if (!eligibleNodes.length) return;

        const groupOptions = this.getDomPageTranslationGroupOptions();
        const groups = buildContextTranslationGroups(eligibleNodes, groupOptions);
        if (this.getDomPageBatchOptions()) {
            const entries = groups.map((group) => this.createDomPageTranslationEntry(group));
            const uncachedEntries = [];
            entries.forEach((entry) => {
                const cached = this._domTranslationCache.get(entry.cacheKey);
                if (cached && this.applyDomPageTranslatedEntry(entry, cached)) {
                    return;
                }
                uncachedEntries.push(entry);
            });
            const batches = this.buildDomPageTranslationBatches(uncachedEntries);
            this._domTotalTranslationEntries += batches.length;
            this.updateDomPageBannerStatus();
            // Insert at FRONT of queue for priority processing
            batches
                .reverse()
                .forEach((batch) => this.enqueueDomPageBatchTranslationPriority(batch));
            return;
        }
        this._domTotalTranslationEntries += groups.length;
        this.updateDomPageBannerStatus();
        groups.forEach((group) => this.enqueueDomPageGroupTranslation(group));
    }

    enqueueDomPageBatchTranslation(entries) {
        const run = async () => {
            if (this._domCircuitBreakerActive) return;
            this._domActiveTranslations += 1;
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const batchedSourceText = buildSegmentedTranslationText(entries);
                const result = await this.translateWithDomPageEngine(batchedSourceText, sl, tl);
                if (result && result.translationFailed) {
                    throw new Error(result.errorMsg || "Page translation request failed.");
                }
                const translated = result.mainMeaning || result.translatedText;
                const translatedParts = splitSegmentedTranslationText(translated, entries.length);

                if (!translatedParts) {
                    this.recordDomPageBatchFailure();
                    // Retry with halved batches before falling back to individual
                    if (entries.length > 1) {
                        const mid = Math.ceil(entries.length / 2);
                        this.enqueueDomPageBatchTranslation(entries.slice(0, mid));
                        this.enqueueDomPageBatchTranslation(entries.slice(mid));
                    } else {
                        entries.forEach((entry) => this.enqueueDomPageEntryNodeTranslations(entry));
                    }
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }

                entries.forEach((entry, index) => {
                    const part = translatedParts[index];
                    if (part) {
                        if (this._domTranslationCache.size >= this._domTranslationCacheMax) {
                            const oldest = this._domTranslationCache.keys().next().value;
                            if (oldest !== undefined) this._domTranslationCache.delete(oldest);
                        }
                        this._domTranslationCache.set(entry.cacheKey, part);
                    }
                    if (!this.applyDomPageTranslatedEntry(entry, part)) {
                        this.enqueueDomPageEntryNodeTranslations(entry);
                    }
                });
                this.recordDomPageBatchSuccess();
                this.markDomPageTranslationEntriesCompleted();
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this.recordDomPageBatchFailure();
                if (entries.length > 1 && this._domBatchFailureCount < 5) {
                    const mid = Math.ceil(entries.length / 2);
                    this.enqueueDomPageBatchTranslation(entries.slice(0, mid));
                    this.enqueueDomPageBatchTranslation(entries.slice(mid));
                } else {
                    entries.forEach((entry) => this.enqueueDomPageEntryNodeTranslations(entry));
                }
                this.markDomPageTranslationEntriesCompleted();
            } finally {
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    enqueueDomPageGroupTranslation(group) {
        const run = async () => {
            this._domActiveTranslations += 1;
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const entry = this.createDomPageTranslationEntry(group);
                const { readableBlockReplacement } = entry;
                let translated = this._domTranslationCache.get(entry.cacheKey);
                if (!translated) {
                    const requestText = this.buildDomPageRoleSegmentText(entry);
                    const result = await this.translateWithDomPageEngine(requestText, sl, tl);
                    if (result && result.translationFailed) {
                        throw new Error(result.errorMsg || "Page translation request failed.");
                    }
                    translated = this.unwrapDomPageRoleSegmentText(
                        result.mainMeaning || result.translatedText,
                        1
                    );
                    if (translated) {
                        if (this._domTranslationCache.size >= this._domTranslationCacheMax) {
                            const oldest = this._domTranslationCache.keys().next().value;
                            if (oldest !== undefined) this._domTranslationCache.delete(oldest);
                        }
                        this._domTranslationCache.set(entry.cacheKey, translated);
                    }
                }

                if (readableBlockReplacement) {
                    const block = readableBlockReplacement.block;
                    if (translated && block && block.isConnected) {
                        this._translatedBlocks.add(block);
                        this.applyWithFadeIn(block, translated, "block");
                        this.markDomPageTranslationEntriesCompleted();
                    }
                    return;
                }

                const translatedParts = splitTranslatedContext(translated, group.nodes.length);
                if (!translatedParts) {
                    group.nodes.forEach((node, index) => {
                        this.enqueueDomPageNodeTranslation({
                            node,
                            parent: node.parentElement,
                            text: group.texts[index],
                        });
                    });
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }

                group.nodes.forEach((node, index) => {
                    if (translatedParts[index] && node.parentElement) {
                        this.applyWithFadeIn(node, translatedParts[index], "text");
                    }
                });
                this.markDomPageTranslationEntriesCompleted();
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                if (group.nodes && group.nodes.length > 1) {
                    this.enqueueDomPageEntryNodeTranslations(
                        this.createDomPageTranslationEntry(group)
                    );
                } else {
                    group.nodes.forEach((node) => this._translatedSet.delete(node));
                }
                this.markDomPageTranslationEntriesCompleted();
            } finally {
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    enqueueDomPageNodeTranslation(item, priority = false) {
        const run = async () => {
            this._domActiveTranslations += 1;
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const cacheKey = `${this._domPageTranslateOptions.engine}|${sl}|${tl}|${item.text}`;
                let translated = this._domTranslationCache.get(cacheKey);
                if (!translated) {
                    const result = await this.translateWithDomPageEngine(item.text, sl, tl);
                    if (result && result.translationFailed) {
                        throw new Error(result.errorMsg || "Page translation request failed.");
                    }
                    translated = result.mainMeaning || result.translatedText;
                    if (translated) {
                        if (this._domTranslationCache.size >= this._domTranslationCacheMax) {
                            const oldest = this._domTranslationCache.keys().next().value;
                            if (oldest !== undefined) this._domTranslationCache.delete(oldest);
                        }
                        this._domTranslationCache.set(cacheKey, translated);
                    }
                }
                if (translated && item.node.parentElement === item.parent) {
                    item.node.nodeValue = translated;
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
        if (priority) this._domTranslationQueue.unshift(run);
        else this._domTranslationQueue.push(run);
        this.flushDomTranslationQueue();
    }

    /**
     * Same as enqueueDomPageBatchTranslation but inserts at FRONT of queue.
     * Used by scroll prioritizer to ensure viewport content is translated first.
     */
    enqueueDomPageBatchTranslationPriority(entries) {
        const run = async () => {
            if (this._domCircuitBreakerActive) return;
            this._domActiveTranslations += 1;
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const batchedSourceText = buildSegmentedTranslationText(entries);
                const result = await this.translateWithDomPageEngine(batchedSourceText, sl, tl);
                if (result && result.translationFailed) {
                    throw new Error(result.errorMsg || "Page translation request failed.");
                }
                const translated = result.mainMeaning || result.translatedText;
                const translatedParts = splitSegmentedTranslationText(translated, entries.length);

                if (!translatedParts) {
                    this.recordDomPageBatchFailure();
                    if (entries.length > 1) {
                        const mid = Math.ceil(entries.length / 2);
                        this.enqueueDomPageBatchTranslationPriority(entries.slice(0, mid));
                        this.enqueueDomPageBatchTranslationPriority(entries.slice(mid));
                    } else {
                        entries.forEach((entry) =>
                            this.enqueueDomPageEntryNodeTranslations(entry, true)
                        );
                    }
                } else {
                    this._domBatchFailureCount = 0;
                    entries.forEach((entry, i) => {
                        const part = translatedParts[i];
                        if (part) {
                            this._domTranslationCache.set(entry.cacheKey, part);
                            if (!this.applyDomPageTranslatedEntry(entry, part)) {
                                this.enqueueDomPageEntryNodeTranslations(entry, true);
                            }
                        }
                    });
                }

                this.markDomPageTranslationEntriesCompleted(1);
            } catch (error) {
                this.updateDomPageBannerStatus(
                    "error",
                    error && error.message ? error.message : String(error || "")
                );
                this.markDomPageTranslationEntriesCompleted(1);
                if (entries.length > 1 && this._domBatchFailureCount < 5) {
                    const mid = Math.ceil(entries.length / 2);
                    this.enqueueDomPageBatchTranslationPriority(entries.slice(0, mid));
                    this.enqueueDomPageBatchTranslationPriority(entries.slice(mid));
                } else {
                    entries.forEach((entry) =>
                        this.enqueueDomPageEntryNodeTranslations(entry, true)
                    );
                }
            } finally {
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        this._domTranslationQueue.unshift(run);
        this.flushDomTranslationQueue();
    }

    flushDomTranslationQueue() {
        if (!this._domTranslationQueue) return;
        if (this._domFlushStaggerTimer) return;

        // Burst mode: first flush fires all slots at once for max speed
        if (!this._domFlushBurstDone) {
            this._domFlushBurstDone = true;
            while (
                this._domTranslationQueue.length &&
                this._domActiveTranslations < this._domMaxConcurrentTranslations
            ) {
                const next = this._domTranslationQueue.shift();
                next();
            }
            return;
        }

        // Subsequent flushes: stagger to spread responses
        const startNext = () => {
            if (
                !this._domTranslationQueue ||
                this._domActiveTranslations >= this._domMaxConcurrentTranslations ||
                !this._domTranslationQueue.length
            ) {
                this._domFlushStaggerTimer = null;
                return;
            }
            const next = this._domTranslationQueue.shift();
            next();
            if (
                this._domTranslationQueue.length &&
                this._domActiveTranslations < this._domMaxConcurrentTranslations
            ) {
                this._domFlushStaggerTimer = setTimeout(() => {
                    this._domFlushStaggerTimer = null;
                    this.flushDomTranslationQueue();
                }, 30);
            } else {
                this._domFlushStaggerTimer = null;
            }
        };
        startNext();
    }
}

// Create the object.
window.EdgeTranslateBannerController = new BannerController();

export { BannerController };
