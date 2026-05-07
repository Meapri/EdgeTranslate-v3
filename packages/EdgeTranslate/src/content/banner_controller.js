import Channel from "common/scripts/channel.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import {
    toChromeTranslatorLanguage,
    translateWithChromeOnDevice,
} from "common/scripts/chrome_builtin_translate.js";
import {
    buildContextTranslationGroups,
    createReadableBlockReplacement,
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
                engine: detail.engine === "dom" ? "dom" : "chromeBuiltin",
                sl: detail.sl || "auto",
                tl: detail.tl || "en",
            };
            this._domOnDeviceUnavailable = false;
            this._domResolvedSourceLanguage = this.resolveDomPageSourceLanguage(
                this._domPageTranslateOptions.sl
            );
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
                engine: "chromeBuiltin",
            });
        } catch (bridgeError) {
            try {
                return await translateWithChromeOnDevice(text, from, to);
            } catch (contentError) {
                throw bridgeError || contentError;
            }
        }
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
                document.body.style.cssText = document.body.style.cssText.replace(
                    new RegExp(`${property}:.*;`, "g"),
                    `${property}: ${target}px !important;`
                );
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
                    this.canceller();
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

        if (this._domPageTranslateOptions.engine !== "chromeBuiltin") return;
        if (this._domOnDeviceUnavailable) return;

        const groups = buildContextTranslationGroups(eligibleNodes);
        groups.forEach((group) => this.enqueueChromeBuiltinGroupTranslation(group));
    }

    enqueueChromeBuiltinGroupTranslation(group) {
        const run = async () => {
            this._domActiveTranslations += 1;
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const readableBlockReplacement = createReadableBlockReplacement(group);
                const sourceText = readableBlockReplacement
                    ? readableBlockReplacement.sourceText
                    : group.sourceText;
                const cacheMode = readableBlockReplacement ? "readable-block" : "context";
                const cacheKey = `${this._domPageTranslateOptions.engine}|${cacheMode}|${sl}|${tl}|${sourceText}`;
                let translated = this._domTranslationCache.get(cacheKey);
                if (!translated) {
                    const result = await this.translateWithOnDeviceEngine(sourceText, sl, tl);
                    translated = result.mainMeaning || result.translatedText;
                    if (translated) this._domTranslationCache.set(cacheKey, translated);
                }

                if (readableBlockReplacement) {
                    const block = readableBlockReplacement.block;
                    if (translated && block && block.isConnected) {
                        this._translatedBlocks.add(block);
                        block.textContent = translated;
                    }
                    return;
                }

                const translatedParts = splitTranslatedContext(translated, group.nodes.length);
                if (!translatedParts) {
                    group.nodes.forEach((node, index) => {
                        this.enqueueChromeBuiltinNodeTranslation({
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
            } catch (error) {
                group.nodes.forEach((node) => this._translatedSet.delete(node));
                if (this.isOnDeviceUnavailableError(error)) {
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

    enqueueChromeBuiltinNodeTranslation(item) {
        const run = async () => {
            this._domActiveTranslations += 1;
            try {
                const { tl } = this._domPageTranslateOptions;
                const sl = this._domResolvedSourceLanguage || this._domPageTranslateOptions.sl;
                const cacheKey = `${this._domPageTranslateOptions.engine}|${sl}|${tl}|${item.text}`;
                let translated = this._domTranslationCache.get(cacheKey);
                if (!translated) {
                    const result = await this.translateWithOnDeviceEngine(item.text, sl, tl);
                    translated = result.mainMeaning || result.translatedText;
                    if (translated) this._domTranslationCache.set(cacheKey, translated);
                }
                if (translated && item.node.parentElement === item.parent) {
                    item.node.nodeValue = translated;
                }
            } catch (error) {
                this._translatedSet.delete(item.node);
                if (this.isOnDeviceUnavailableError(error)) {
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
