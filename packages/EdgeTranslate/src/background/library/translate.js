import { HybridTranslator } from "@edge_translate/translators";
// common.log는 현재 파일에서 직접 사용하지 않습니다.
import { promiseTabs, delayPromise } from "common/scripts/promise.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import { getChromeTranslatorSupportedLanguages } from "common/scripts/chrome_builtin_translate.js";
import TtlCache from "./ttlCache.js";
import { executeGoogleScript } from "./pageTranslate.js";

class TranslatorManager {
    /**
     * @param {import("../../common/scripts/channel.js").default} channel Communication channel.
     */
    constructor(channel) {
        /**
         * @type {import("../../common/scripts/channel.js").default} Communication channel.
         */
        this.channel = channel;

        /**
         * @type {Promise<Void>} Initialize configurations.
         */
        this.config_loader = getOrSetDefaultSettings(
            [
                "HybridTranslatorConfig",
                "DefaultTranslator",
                "languageSetting",
                "OtherSettings",
                "LocalTranslatorConfig",
            ],
            DEFAULT_SETTINGS
        ).then((configs) => {
            // Init hybrid translator.
            this.HYBRID_TRANSLATOR = new HybridTranslator(
                configs.HybridTranslatorConfig,
                channel,
                configs.LocalTranslatorConfig
            );
            this.localTranslatorProxy = this.createLocalTranslatorProxy(
                this.HYBRID_TRANSLATOR.REAL_TRANSLATORS.LocalTranslate,
                configs.LocalTranslatorConfig
            );
            this.HYBRID_TRANSLATOR.REAL_TRANSLATORS.LocalTranslate = this.localTranslatorProxy;

            // Supported translators.
            this.TRANSLATORS = {
                HybridTranslate: this.HYBRID_TRANSLATOR,
                ...this.HYBRID_TRANSLATOR.REAL_TRANSLATORS,
            };

            // Mutual translating mode flag.
            this.IN_MUTUAL_MODE = configs.OtherSettings.MutualTranslate || false;

            // Translation language settings.
            this.LANGUAGE_SETTING = configs.languageSetting;

            // The default translator to use.
            this.DEFAULT_TRANSLATOR = configs.DefaultTranslator;
        });

        /**
         * Default TTS speed.
         */
        this.TTS_SPEED = "fast";

        // In-memory caches and options to avoid redundant network requests
        this.cacheOptions = {
            maxEntries: 300,
            detectTtlMs: 10 * 60 * 1000, // 10 minutes
            translateTtlMs: 30 * 60 * 1000, // 30 minutes
            maxKeyTextLength: 500,
        };
        this.detectCache = new TtlCache({ maxEntries: this.cacheOptions.maxEntries });
        this.translationCache = new TtlCache({ maxEntries: this.cacheOptions.maxEntries });
        this.inflightDetect = new Map(); // key -> Promise
        this.inflightTranslate = new Map(); // key -> Promise
        this.currentChromeBuiltinTabId = null;

        /**
         * Start to provide services and listen to event.
         */
        this.provideServices();
        this.listenToEvents();
    }

    /**
     * Clear caches when configuration or language settings change
     */
    createLocalTranslatorProxy(endpointTranslator, initialConfig = {}) {
        let config = initialConfig || {};
        const manager = this;
        return {
            useConfig(nextConfig = {}) {
                config = nextConfig || {};
                endpointTranslator.useConfig(nextConfig);
            },
            getMode() {
                if (config.mode === "chromeBuiltin" || config.mode === "geminiNano")
                    return "geminiNano";
                if (config.mode === "googleAiStudio") return "googleAiStudio";
                return "endpoint";
            },
            supportedLanguages() {
                if (!config.enabled) return new Set();
                if (this.getMode() === "geminiNano") return getChromeTranslatorSupportedLanguages();
                return endpointTranslator.supportedLanguages();
            },
            detect(text) {
                if (this.getMode() === "geminiNano") return Promise.resolve("auto");
                return endpointTranslator.detect(text);
            },
            async translate(text, from, to) {
                if (this.getMode() !== "geminiNano") {
                    return endpointTranslator.translate(text, from, to);
                }
                const tabId = await manager.getChromeBuiltinTargetTabId();
                const result = await manager.channel.requestToTab(
                    tabId,
                    "chrome_builtin_translate",
                    {
                        text,
                        sl: from,
                        tl: to,
                        engine: "geminiNano",
                    }
                );
                return {
                    originalText: text,
                    mainMeaning: result?.mainMeaning || result?.translatedText || "",
                    translatedText: result?.translatedText || result?.mainMeaning || "",
                    sourceLanguage: result?.sourceLanguage || from,
                    targetLanguage: result?.targetLanguage || to,
                };
            },
            pronounce(...args) {
                return endpointTranslator.pronounce(...args);
            },
            stopPronounce(...args) {
                return endpointTranslator.stopPronounce(...args);
            },
        };
    }

    async getChromeBuiltinTargetTabId() {
        if (typeof this.currentChromeBuiltinTabId === "number")
            return this.currentChromeBuiltinTabId;
        return this.getCurrentTabId();
    }

    /**
     * Clear caches when configuration or language settings change
     */
    clearCaches() {
        this.detectCache.clear();
        this.translationCache.clear();
    }

    /**
     * Normalize text for cache key usage: trim, collapse spaces, and length-limit
     */
    // Simple 32-bit FNV-1a hash for long keys
    fnv1aHash32(input) {
        try {
            let hash = 0x811c9dc5;
            for (let i = 0; i < input.length; i++) {
                hash ^= input.charCodeAt(i);
                hash =
                    (hash +
                        ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>>
                    0;
            }
            return hash.toString(16).padStart(8, "0");
        } catch {
            return "00000000";
        }
    }

    normalizeKeyText(text) {
        if (typeof text !== "string") return "";
        const collapsed = text.trim().replace(/\s+/g, " ");
        const maxLen = this.cacheOptions.maxKeyTextLength;
        if (collapsed.length <= maxLen) return collapsed;
        const prefix = collapsed.slice(0, Math.max(24, Math.floor(maxLen / 2)));
        const suffixHash = this.fnv1aHash32(collapsed);
        return `${prefix}__${suffixHash}`;
    }

    makeDetectKey(text) {
        return this.normalizeKeyText(text);
    }

    makeTranslateKey(text, sl, tl, translatorId) {
        const norm = this.normalizeKeyText(text);
        return `${translatorId}||${sl}||${tl}||${norm}`;
    }

    getDetectionFromCache(text) {
        const key = this.makeDetectKey(text);
        return this.detectCache.get(key);
    }

    rememberDetection(text, lang) {
        if (!text || !lang) return;
        const key = this.makeDetectKey(text);
        this.detectCache.set(key, lang, this.cacheOptions.detectTtlMs);
    }

    getTranslationFromCache(text, sl, tl, translatorId) {
        const key = this.makeTranslateKey(text, sl, tl, translatorId);
        return this.translationCache.get(key);
    }

    rememberTranslation(text, sl, tl, translatorId, result) {
        const key = this.makeTranslateKey(text, sl, tl, translatorId);
        this.translationCache.set(key, result, this.cacheOptions.translateTtlMs);
    }

    /**
     * Register service providers.
     *
     * This should be called for only once!
     */
    provideServices() {
        // Translate service.
        this.channel.provide("translate", (params, sender) =>
            this.translate(params.text, params.position, sender)
        );

        // Quiet single-text translate service for DOM page translation (no UI events)
        this.channel.provide("translate_text_quiet", async (params, sender) => {
            await this.config_loader;
            const text = params && params.text ? params.text : "";
            if (!text) return Promise.resolve({ originalText: "", translatedText: "" });
            let sl = (params && params.sl) || this.LANGUAGE_SETTING.sl || "auto";
            let tl = (params && params.tl) || this.LANGUAGE_SETTING.tl;
            const translatorId = (params && params.translatorId) || this.DEFAULT_TRANSLATOR;
            const previousChromeBuiltinTabId = this.currentChromeBuiltinTabId;
            this.currentChromeBuiltinTabId =
                sender && sender.tab ? sender.tab.id : previousChromeBuiltinTabId;
            try {
                // cache first
                let result = this.getTranslationFromCache(text, sl, tl, translatorId);
                if (!result) {
                    result = await this.TRANSLATORS[translatorId].translate(text, sl, tl);
                    if (result) this.rememberTranslation(text, sl, tl, translatorId, result);
                }
                return Promise.resolve(result || { originalText: text, translatedText: text });
            } catch (e) {
                return Promise.resolve({ originalText: text, translatedText: text });
            } finally {
                this.currentChromeBuiltinTabId = previousChromeBuiltinTabId;
            }
        });

        // Inject the on-device AI bridge into the page main world from the extension
        // service worker. This avoids page CSP/network failures caused by DOM <script src>
        // injection on stricter sites.
        this.channel.provide("inject_on_device_bridge", async (params, sender) =>
            this.injectOnDeviceBridge(sender)
        );

        // Pronounce service.
        this.channel.provide("pronounce", (params) => {
            let speed = params.speed;
            if (!speed) {
                speed = this.TTS_SPEED;
                this.TTS_SPEED = speed === "fast" ? "slow" : "fast";
            }

            return this.pronounce(params.pronouncing, params.text, params.language, speed);
        });

        // Get available translators service.
        this.channel.provide("get_available_translators", (params) =>
            Promise.resolve(this.getAvailableTranslators(params))
        );

        // Update default translator service.
        this.channel.provide("update_default_translator", (detail) =>
            this.updateDefaultTranslator(detail.translator)
        );
        // TTS 완료 이벤트 중계 서비스
        this.channel.provide("tts_finished", async (params) => {
            const currentTabId = await this.getCurrentTabId();
            if (currentTabId !== -1) {
                this.channel.emitToTabs(currentTabId, "pronouncing_finished", params);
            }
            return Promise.resolve();
        });
        // TTS 오류 이벤트 중계 서비스
        this.channel.provide("tts_error", async (params) => {
            const currentTabId = await this.getCurrentTabId();
            if (currentTabId !== -1) {
                this.channel.emitToTabs(currentTabId, "pronouncing_error", params);
            }
            return Promise.resolve();
        });
    }

    /**
     * Register event listeners.
     *
     * This should be called for only once!
     */
    listenToEvents() {
        // Google page translate button clicked event.
        this.channel.on("translate_page_google", () => {
            // Page translation is currently Chrome-only.
            if (!FEATURE_FLAGS.pageTranslate) return;
            executeGoogleScript(this.channel);
        });

        // Language setting updated event.
        this.channel.on("language_setting_update", this.onLanguageSettingUpdated.bind(this));

        // Result frame closed event.
        this.channel.on("frame_closed", this.stopPronounce.bind(this));

        // Stop pronounce request.
        this.channel.on("stopPronounce", this.stopPronounce.bind(this));

        /**
         * Update config cache on config changed.
         */
        chrome.storage.onChanged.addListener(
            (async (changes, area) => {
                if (area === "sync") {
                    // Ensure that configurations have been initialized.
                    await this.config_loader;

                    if (changes["HybridTranslatorConfig"]) {
                        this.HYBRID_TRANSLATOR.useConfig(
                            changes["HybridTranslatorConfig"].newValue
                        );
                        this.clearCaches();
                    }

                    if (changes["LocalTranslatorConfig"]) {
                        this.HYBRID_TRANSLATOR.useLocalConfig(
                            changes["LocalTranslatorConfig"].newValue
                        );
                        this.clearCaches();
                    }

                    if (changes["OtherSettings"]) {
                        this.IN_MUTUAL_MODE = changes["OtherSettings"].newValue.MutualTranslate;
                    }

                    if (changes["languageSetting"]) {
                        this.LANGUAGE_SETTING = changes["languageSetting"].newValue;
                        this.clearCaches();
                    }

                    if (changes["DefaultTranslator"]) {
                        this.DEFAULT_TRANSLATOR = changes["DefaultTranslator"].newValue;
                        this.clearCaches();
                        // also clear inflight to avoid dangling promises keyed by old translator
                        this.inflightDetect.clear();
                        this.inflightTranslate.clear();
                    }
                }
            }).bind(this)
        );
    }

    /**
     * get the id of the current tab
     * if the current tab can't display the result panel
     * open a notice page to display the result and explain why the page shows
     * @returns the tab id. If tabId===-1, the user is setting the file URLs access permission and nothing should be done.
     */
    async getCurrentTabId() {
        let tabId = -1;
        const tabs = await promiseTabs.query({ active: true, currentWindow: true });
        tabId = tabs[0].id;

        // to test whether the current tab can receive message(display results)
        await this.channel.requestToTab(tabId, "check_availability").catch(async () => {
            const shouldOpenNoticePage = await new Promise((resolve) => {
                // The page is a local file page
                if (/^file:\/\.*/.test(tabs[0].url)) {
                    // Note: chrome.extension.isAllowedFileSchemeAccess is not available in Manifest v3
                    // For now, we'll assume file scheme access is not available and show the notice page
                    if (confirm(chrome.i18n.getMessage("PermissionRemind"))) {
                        chrome.tabs.create({
                            url: `chrome://extensions/?id=${chrome.runtime.id}`,
                        });
                        resolve(false);
                    } else resolve(true);
                } else resolve(true);
            });
            if (!shouldOpenNoticePage) {
                tabId = -1;
                return;
            }
            /**
             * the current tab can't display the result panel
             * so we open a notice page to display the result and explain why this page shows
             */
            const noticePageUrl = chrome.runtime.getURL("content/notice/notice.html");
            // get the tab id of an existing notice page
            try {
                const tab = (await promiseTabs.query({ url: noticePageUrl }))[0];
                // jump to the existed page
                chrome.tabs.highlight({
                    tabs: tab.index,
                });
                tabId = tab.id;
            } catch (error) {
                // create a new notice page
                const tab = await promiseTabs.create({
                    url: noticePageUrl,
                    active: true,
                });
                // wait for browser to open a new page
                await delayPromise(200);
                tabId = tab.id;
            }
        });
        return tabId;
    }

    resolveTargetTabId(sender) {
        if (sender && sender.tab && typeof sender.tab.id === "number") {
            return Promise.resolve(sender.tab.id);
        }
        return this.getCurrentTabId();
    }

    async injectOnDeviceBridge(sender) {
        const tabId = sender && sender.tab && sender.tab.id;
        if (typeof tabId !== "number") {
            throw new Error("Cannot inject Chrome on-device bridge without a sender tab.");
        }
        if (
            typeof chrome === "undefined" ||
            !chrome.scripting ||
            typeof chrome.scripting.executeScript !== "function"
        ) {
            throw new Error("Chrome scripting API is unavailable for on-device bridge injection.");
        }

        const target = { tabId };
        if (typeof sender.frameId === "number") target.frameIds = [sender.frameId];

        await chrome.scripting.executeScript({
            target,
            files: ["chrome_builtin/on_device_bridge.js"],
            world: "MAIN",
            injectImmediately: true,
        });

        return { injected: true };
    }

    /**
     *
     * 检测给定文本的语言。
     *
     * @param {string} text 需要检测的文本
     *
     * @returns {Promise<String>} detected language Promise
     */
    async detect(text) {
        // Ensure that configurations have been initialized.
        await this.config_loader;
        if (!text) return "";
        const cached = this.getDetectionFromCache(text);
        if (cached) return cached;
        const key = this.makeDetectKey(text);
        if (this.inflightDetect.has(key)) return this.inflightDetect.get(key);
        const promise = this.TRANSLATORS[this.DEFAULT_TRANSLATOR]
            .detect(text)
            .then((detected) => {
                if (detected) this.rememberDetection(text, detected);
                return detected;
            })
            .finally(() => this.inflightDetect.delete(key));
        this.inflightDetect.set(key, promise);
        return promise;
    }

    /**
     *
     * This is a translation client function
     * 1. get language settings
     * 2. if source language is "auto", use normal translation mode
     * 3. else use mutual translation mode(auto translate from both sides)
     * 4. send request, get result
     *
     * @param {String} text original text to be translated
     * @param {Array<Number>} position position of the text
     *
     * @returns {Promise<void>} translate finished Promise
     */
    async translate(text, position, sender) {
        // Ensure that configurations have been initialized.
        await this.config_loader;

        // get current tab id
        const currentTabId = await this.resolveTargetTabId(sender);
        if (currentTabId === -1) return;

        /**
         * Get current time as timestamp.
         *
         * Timestamp is used for preventing disordered translating message to disturb user.
         *
         * Every translating request has a unique timestamp and every message from that translating
         * request will be assigned with the timestamp. About usage of the timestamp, please refer
         * to display.js.
         */
        let timestamp = new Date().getTime();

        // Inform current tab translating started.
        this.channel.emitToTabs(currentTabId, "start_translating", {
            text,
            position,
            timestamp,
        });

        let sl = this.LANGUAGE_SETTING.sl;
        let tl = this.LANGUAGE_SETTING.tl;

        try {
            if (sl !== "auto" && this.IN_MUTUAL_MODE) {
                // mutual translate mode, detect language first.
                // try cache first inside detect()
                sl = await this.detect(text);
                switch (sl) {
                    case this.LANGUAGE_SETTING.sl:
                        tl = this.LANGUAGE_SETTING.tl;
                        break;
                    case this.LANGUAGE_SETTING.tl:
                        tl = this.LANGUAGE_SETTING.sl;
                        break;
                    default:
                        sl = "auto";
                        tl = this.LANGUAGE_SETTING.tl;
                }
            }

            const translatorId = this.DEFAULT_TRANSLATOR;
            const key = this.makeTranslateKey(text, sl, tl, translatorId);
            const previousChromeBuiltinTabId = this.currentChromeBuiltinTabId;
            this.currentChromeBuiltinTabId = currentTabId;

            let result;
            try {
                // Try translation cache first
                result = this.getTranslationFromCache(text, sl, tl, translatorId);
                if (!result) {
                    if (this.inflightTranslate.has(key)) {
                        result = await this.inflightTranslate.get(key);
                    } else {
                        const promise = this.TRANSLATORS[translatorId]
                            .translate(text, sl, tl)
                            .then((res) => {
                                if (res) this.rememberTranslation(text, sl, tl, translatorId, res);
                                return res;
                            })
                            .finally(() => this.inflightTranslate.delete(key));
                        this.inflightTranslate.set(key, promise);
                        result = await promise;
                    }
                }
            } finally {
                this.currentChromeBuiltinTabId = previousChromeBuiltinTabId;
            }

            // Ensure language information is always set correctly for TTS
            let actualSourceLanguage = sl;

            // If source language was auto-detected, get the actual detected language
            if (sl === "auto") {
                // First try to use detected language from translation result
                if (result.sourceLanguage && result.sourceLanguage !== "auto") {
                    actualSourceLanguage = result.sourceLanguage;
                } else {
                    // Fallback: detect the language ourselves
                    try {
                        const detected = await this.detect(text);
                        if (detected && detected !== "auto") {
                            actualSourceLanguage = detected;
                        } else {
                            // Ultimate fallback: assume English for TTS compatibility
                            actualSourceLanguage = "en";
                        }
                    } catch (e) {
                        // If detection completely fails, assume English
                        actualSourceLanguage = "en";
                    }
                }
            }

            // Always ensure these fields are set for TTS functionality
            result.sourceLanguage = actualSourceLanguage;
            result.targetLanguage = tl;

            // Preserve original text for TTS (in case it was modified during segmentation)
            if (!result.originalText || result.originalText !== text) {
                result.originalText = text;
            }

            // Send translating result to current tab.
            this.channel.emitToTabs(currentTabId, "translating_finished", {
                timestamp,
                ...result,
            });
        } catch (error) {
            // Inform current tab translating failed.
            this.channel.emitToTabs(currentTabId, "translating_error", {
                error,
                timestamp,
            });
        }
    }

    /**
     * Text to speech proxy.
     *
     * @param {String} pronouncing which text are we pronouncing? enum{source, target}
     * @param {String} text The text.
     * @param {String} language The language of the text.
     * @param {String} speed The speed of the speech.
     *
     * @returns {Promise<void>} pronounce finished Promise
     */
    async pronounce(pronouncing, text, language, speed) {
        // Ensure that configurations have been initialized.
        await this.config_loader;

        // get current tab id
        const currentTabId = await this.getCurrentTabId();
        if (currentTabId === -1) return;

        let lang = language;
        let timestamp = new Date().getTime();

        // Inform current tab pronouncing started.
        this.channel.emitToTabs(currentTabId, "start_pronouncing", {
            pronouncing,
            text,
            language,
            timestamp,
        });

        try {
            if (language === "auto") {
                lang = await this.TRANSLATORS[this.DEFAULT_TRANSLATOR].detect(text);
            }

            // Service Worker에서는 TTS API를 사용할 수 없으므로
            // Content Script에 TTS 실행을 요청합니다
            this.channel.emitToTabs(currentTabId, "execute_tts", {
                pronouncing,
                text,
                language: lang,
                speed,
                timestamp,
                translator: this.DEFAULT_TRANSLATOR,
            });
        } catch (error) {
            // Inform current tab pronouncing failed.
            this.channel.emitToTabs(currentTabId, "pronouncing_error", {
                pronouncing,
                error,
                timestamp,
            });
        }
    }

    /**
     * Stop pronounce proxy.
     */
    async stopPronounce() {
        // Ensure that configurations have been initialized.
        await this.config_loader;

        // Content Script에서 TTS 중지하도록 요청
        const currentTabId = await this.getCurrentTabId();
        if (currentTabId !== -1) {
            this.channel.emitToTabs(currentTabId, "stop_tts", {
                timestamp: new Date().getTime(),
            });

            // TTS 중지 완료 이벤트 즉시 발송
            this.channel.emitToTabs(currentTabId, "pronouncing_finished", {
                timestamp: new Date().getTime(),
                pronouncing: "both", // source와 target 모두 중지
            });
        }

        this.TRANSLATORS[this.DEFAULT_TRANSLATOR].stopPronounce();
    }

    /**
     * Get translators that support given source language and target language.
     *
     * @param {Object} detail current language setting, detail.from is source language, detail.to is target language
     *
     * @returns {Array<String>} available translators Promise.
     */
    getAvailableTranslators(detail) {
        if (!this.HYBRID_TRANSLATOR) {
            console.log("HYBRID_TRANSLATOR not initialized yet");
            return ["HybridTranslate"];
        }
        return ["HybridTranslate"].concat(
            this.HYBRID_TRANSLATOR.getAvailableTranslatorsFor(detail.from, detail.to)
        );
    }

    /**
     * Language setting update event listener.
     *
     * @param {Object} detail updated language setting, detail.from is source language, detail.to is target language
     *
     * @returns {Promise<void>} finished Promise
     */
    async onLanguageSettingUpdated(detail) {
        let selectedTranslator = this.DEFAULT_TRANSLATOR;

        // Get translators supporting new language setting.
        let availableTranslators = this.getAvailableTranslators(detail);

        // Update hybrid translator config.
        const newConfig = this.HYBRID_TRANSLATOR.updateConfigFor(detail.from, detail.to);
        // Update config.
        chrome.storage.sync.set({ HybridTranslatorConfig: newConfig });

        // Clear caches as language pairing changed
        this.clearCaches();

        // If current default translator does not support new language setting, update it.
        if (!new Set(availableTranslators).has(selectedTranslator)) {
            selectedTranslator = availableTranslators[1];
            chrome.storage.sync.set({ DefaultTranslator: selectedTranslator });
        }

        // Inform options page to update options.
        this.channel.emit("hybrid_translator_config_updated", {
            config: newConfig,
            availableTranslators: availableTranslators.slice(1),
        });

        // Inform result frame to update options.
        promiseTabs.query({ active: true, currentWindow: true }).then((tabs) =>
            this.channel.emitToTabs(tabs[0].id, "update_translator_options", {
                selectedTranslator,
                availableTranslators,
            })
        );
    }

    /**
     * Update translator.
     *
     * @param {string} translator the new translator to use.
     *
     * @returns {Promise<void>} update finished promise.
     */
    updateDefaultTranslator(translator) {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ DefaultTranslator: translator }, () => {
                resolve();
            });
        });
    }
}

export { TranslatorManager };
