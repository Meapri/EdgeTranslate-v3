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

/**
 * Control the visibility of page translator banners.
 */
class BannerController {
    constructor() {
        // Communication channel.
        this.channel = new Channel();

        // Allowed translator: google.
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
        this._domPageTranslateOptions = { engine: "dom", sl: "auto", tl: "en" };
        this._domResolvedSourceLanguage = null;
        this._domTranslationCache = new Map();
        this._domActiveTranslations = 0;
        this._domMaxConcurrentTranslations = 2;
        this._domOnDeviceUnavailable = false;
        this._domPageBanner = null;
        this._domPageBannerVisible = true;
        this._domTotalTranslationEntries = 0;
        this._domCompletedTranslationEntries = 0;
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
            return this.translateWithOnDeviceEngine(text, from, to);
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
            this._domOnDeviceUnavailable = false;
            this._domCompletedTranslationEntries = 0;
            this._domTotalTranslationEntries = 0;
            this._domMaxConcurrentTranslations =
                this._domPageTranslateOptions.engine === "localEndpoint" ? 1 : 2;
            this._domResolvedSourceLanguage = this.resolveDomPageSourceLanguage(
                this._domPageTranslateOptions.sl
            );
            this.showDomPageBanner();
            this.startDomFallback();
            // initial scan to cover existing content
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const nodes = [];
            let t;
            while ((t = walker.nextNode())) nodes.push(t);
            this.translateBatchNodes(nodes);
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
        if (
            engine === "dom" ||
            engine === "localEndpoint" ||
            engine === "googleAiStudio" ||
            engine === "geminiNano" ||
            engine === "chromeBuiltin"
        ) {
            return engine === "chromeBuiltin" ? "geminiNano" : engine;
        }
        return "geminiNano";
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
            }, 30000);

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

    async translateWithOnDeviceEngine(text, from, to) {
        try {
            await this.ensureOnDeviceBridge();
            return await this.requestOnDeviceBridge({
                text,
                sl: from,
                tl: to,
                engine: this._domPageTranslateOptions.engine || "geminiNano",
            });
        } catch (bridgeError) {
            try {
                return await translateWithChromeOnDevice(text, from, to);
            } catch (contentError) {
                throw bridgeError || contentError;
            }
        }
    }

    async translateWithDomPageEngine(text, from, to) {
        if (
            this._domPageTranslateOptions.engine === "localEndpoint" ||
            this._domPageTranslateOptions.engine === "googleAiStudio"
        ) {
            return await this.channel.request("translate_text_quiet", {
                text,
                sl: from,
                tl: to,
                translatorId: "LocalTranslate",
            });
        }
        return await this.translateWithOnDeviceEngine(text, from, to);
    }

    getDomPageTranslationGroupOptions() {
        if (this._domPageTranslateOptions.engine === "localEndpoint") return { maxChars: 1400 };
        if (this._domPageTranslateOptions.engine === "googleAiStudio") return { maxChars: 6000 };
        return undefined;
    }

    getReadableBlockReplacementOptions() {
        if (this._domPageTranslateOptions.engine === "localEndpoint") {
            return { maxChars: 1400 };
        }
        if (this._domPageTranslateOptions.engine === "googleAiStudio") {
            return { maxChars: 6000 };
        }
        return undefined;
    }

    getDomPageBatchOptions() {
        if (this._domPageTranslateOptions.engine !== "googleAiStudio") return null;
        return { maxChars: 24000, maxItems: 24 };
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
        const cacheMode = readableBlockReplacement ? "readable-block" : "context";
        const cacheKey = `${this._domPageTranslateOptions.engine}|${cacheMode}|${sl}|${tl}|${sourceText}`;
        return { group, readableBlockReplacement, sourceText, cacheKey };
    }

    applyDomPageTranslatedEntry(entry, translated) {
        if (!translated) return false;
        const { group, readableBlockReplacement } = entry;

        if (readableBlockReplacement) {
            const block = readableBlockReplacement.block;
            if (block && block.isConnected) {
                this._translatedBlocks.add(block);
                block.textContent = translated;
                return true;
            }
            return false;
        }

        const translatedParts = splitTranslatedContext(translated, group.nodes.length);
        if (!translatedParts) return false;

        group.nodes.forEach((node, index) => {
            if (translatedParts[index] && node.parentElement) {
                node.nodeValue = translatedParts[index];
            }
        });
        return true;
    }

    buildDomPageTranslationBatches(entries) {
        const batchOptions = this.getDomPageBatchOptions();
        if (!batchOptions) return [];
        const batches = [];
        let current = [];
        let currentLength = 0;

        for (const entry of entries) {
            const projectedLength =
                currentLength + entry.sourceText.length + (current.length ? 1 : 0);
            if (
                current.length &&
                (current.length >= batchOptions.maxItems || projectedLength > batchOptions.maxChars)
            ) {
                batches.push(current);
                current = [];
                currentLength = 0;
            }
            current.push(entry);
            currentLength += entry.sourceText.length + (current.length > 1 ? 1 : 0);
        }
        if (current.length) batches.push(current);
        return batches;
    }

    getDomPageTranslatorLabel() {
        switch (this._domPageTranslateOptions.engine) {
            case "googleAiStudio":
                return "Google AI Studio";
            case "localEndpoint":
                return "Local";
            case "geminiNano":
                return "Gemini Nano";
            case "chromeBuiltin":
                return "Chrome Built-in";
            default:
                return "DOM";
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

    updateDomPageBannerStatus() {
        const host =
            this._domPageBanner || document.getElementById("edge-translate-dom-page-banner");
        if (!host || !host.shadowRoot) return;
        const status = host.shadowRoot.querySelector("[data-role='status']");
        if (!status) return;
        const label = this.getDomPageTranslatorLabel();
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
        const host = document.getElementById("edge-translate-dom-page-banner");
        if (host) host.remove();
        this._domPageBanner = null;
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
        const isMeaningful = (node) => {
            if (!node || node.nodeType !== Node.TEXT_NODE) return false;
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
        };
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
                                if (isMeaningful(n)) enqueue(n);
                            } else if (n.nodeType === Node.ELEMENT_NODE) {
                                const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
                                let t;
                                while ((t = walker.nextNode())) {
                                    if (isMeaningful(t)) enqueue(t);
                                }
                            }
                        });
                } else if (m.type === "characterData") {
                    const tn = m.target;
                    if (isMeaningful(tn)) enqueue(tn);
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

        if (this._domPageTranslateOptions.engine === "dom") return;
        if (this._domPageTranslateOptions.engine === "geminiNano" && this._domOnDeviceUnavailable)
            return;

        const groupOptions = this.getDomPageTranslationGroupOptions();
        const groups = buildContextTranslationGroups(eligibleNodes, groupOptions);
        this._domTotalTranslationEntries += groups.length;
        this.updateDomPageBannerStatus();
        if (this._domPageTranslateOptions.engine === "googleAiStudio") {
            const entries = groups.map((group) => this.createDomPageTranslationEntry(group));
            const uncachedEntries = [];
            entries.forEach((entry) => {
                const cached = this._domTranslationCache.get(entry.cacheKey);
                if (cached && this.applyDomPageTranslatedEntry(entry, cached)) {
                    this.markDomPageTranslationEntriesCompleted();
                    return;
                }
                uncachedEntries.push(entry);
            });
            this.buildDomPageTranslationBatches(uncachedEntries).forEach((batch) =>
                this.enqueueDomPageBatchTranslation(batch)
            );
            return;
        }
        groups.forEach((group) => this.enqueueDomPageGroupTranslation(group));
    }

    enqueueDomPageBatchTranslation(entries) {
        const run = async () => {
            this._domActiveTranslations += 1;
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const sourceTexts = entries.map((entry) => entry.sourceText);
                const batchedSourceText = buildSegmentedTranslationText(sourceTexts);
                const result = await this.translateWithDomPageEngine(batchedSourceText, sl, tl);
                const translated = result.mainMeaning || result.translatedText;
                const translatedParts = splitSegmentedTranslationText(translated, entries.length);

                if (!translatedParts) {
                    entries.forEach((entry) => this.enqueueDomPageGroupTranslation(entry.group));
                    return;
                }

                entries.forEach((entry, index) => {
                    const part = translatedParts[index];
                    if (part) this._domTranslationCache.set(entry.cacheKey, part);
                    if (this.applyDomPageTranslatedEntry(entry, part)) {
                        this.markDomPageTranslationEntriesCompleted();
                    } else {
                        this.enqueueDomPageGroupTranslation(entry.group);
                    }
                });
            } catch (error) {
                entries.forEach((entry) => {
                    entry.group.nodes.forEach((node) => this._translatedSet.delete(node));
                });
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
                const readableBlockReplacement = createReadableBlockReplacement(
                    group,
                    this.getReadableBlockReplacementOptions()
                );
                const sourceText = readableBlockReplacement
                    ? readableBlockReplacement.sourceText
                    : group.sourceText;
                const cacheMode = readableBlockReplacement ? "readable-block" : "context";
                const cacheKey = `${this._domPageTranslateOptions.engine}|${cacheMode}|${sl}|${tl}|${sourceText}`;
                let translated = this._domTranslationCache.get(cacheKey);
                if (!translated) {
                    const result = await this.translateWithDomPageEngine(sourceText, sl, tl);
                    translated = result.mainMeaning || result.translatedText;
                    if (translated) this._domTranslationCache.set(cacheKey, translated);
                }

                if (readableBlockReplacement) {
                    const block = readableBlockReplacement.block;
                    if (translated && block && block.isConnected) {
                        this._translatedBlocks.add(block);
                        block.textContent = translated;
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
                    return;
                }

                group.nodes.forEach((node, index) => {
                    if (translatedParts[index] && node.parentElement) {
                        node.nodeValue = translatedParts[index];
                    }
                });
                this.markDomPageTranslationEntriesCompleted();
            } catch (error) {
                group.nodes.forEach((node) => this._translatedSet.delete(node));
                if (
                    this._domPageTranslateOptions.engine === "geminiNano" &&
                    this.isOnDeviceUnavailableError(error)
                ) {
                    this._domOnDeviceUnavailable = true;
                    if (this._domTranslationQueue) this._domTranslationQueue.length = 0;
                }
            } finally {
                this._domActiveTranslations -= 1;
                this.flushDomTranslationQueue();
            }
        };

        if (!this._domTranslationQueue) this._domTranslationQueue = [];
        this._domTranslationQueue.push(run);
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
                    translated = result.mainMeaning || result.translatedText;
                    if (translated) this._domTranslationCache.set(cacheKey, translated);
                }
                if (translated && item.node.parentElement === item.parent) {
                    item.node.nodeValue = translated;
                }
            } catch (error) {
                this._translatedSet.delete(item.node);
                if (
                    this._domPageTranslateOptions.engine === "geminiNano" &&
                    this.isOnDeviceUnavailableError(error)
                ) {
                    this._domOnDeviceUnavailable = true;
                    if (this._domTranslationQueue) this._domTranslationQueue.length = 0;
                }
            } finally {
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
            this._domActiveTranslations < this._domMaxConcurrentTranslations &&
            this._domTranslationQueue.length
        ) {
            const next = this._domTranslationQueue.shift();
            next();
        }
    }

    isOnDeviceUnavailableError(error) {
        const message = error && error.message ? error.message : String(error || "");
        return /network|not available|unavailable|did not become ready|Failed to inject|timed out/i.test(
            message
        );
    }
}

// Create the object.
window.EdgeTranslateBannerController = new BannerController();

export { BannerController };
