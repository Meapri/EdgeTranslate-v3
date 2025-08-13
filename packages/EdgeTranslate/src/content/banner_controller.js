import Channel from "common/scripts/channel.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";

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
        this._scheduleBatch = null;
        this._pendingNodes = new Set();

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

        // Kick off DOM fallback on explicit request
        this.channel.on("start_dom_page_translate", () => {
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
            if (p.hasAttribute("data-et-translated")) return false;
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
                    m.addedNodes && m.addedNodes.forEach((n) => {
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
     * Translate a batch of text nodes, marking parents to avoid duplicates.
     */
    translateBatchNodes(nodes) {
        const parents = new Set();
        for (const n of nodes) {
            const p = n.parentElement;
            if (p && !this._translatedSet.has(p)) parents.add(p);
        }
        if (!parents.size) return;
        parents.forEach((p) => p.setAttribute("data-et-translated", "1"));
    }
}

// Create the object.
window.EdgeTranslateBannerController = new BannerController();
