import { logWarn } from "common/scripts/logger.js";
import { promiseTabs } from "common/scripts/promise.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";

/**
 * 使用用户选定的网页翻译引擎翻译当前网页。
 *
 * @param {import("../../common/scripts/channel.js").default} channel Communication channel.
 */
function translatePage(channel) {
    getOrSetDefaultSettings(
        ["DefaultPageTranslator", "languageSetting", "LocalTranslatorConfig"],
        DEFAULT_SETTINGS
    ).then((result) => {
        const translator =
            result.DefaultPageTranslator === "GeminiNanoPageTranslate"
                ? "ChromeBuiltinPageTranslate"
                : result.DefaultPageTranslator;
        const targetLang = (result.languageSetting && result.languageSetting.tl) || "en";
        const sourceLang = (result.languageSetting && result.languageSetting.sl) || "auto";

        // Page translation is currently Chrome-only.
        if (!FEATURE_FLAGS.pageTranslate) return;

        switch (translator) {
            case "GooglePageTranslate":
                executeGoogleScript(channel);
                break;
            case "ChromeBuiltinPageTranslate":
                executeDomPageTranslate(channel, {
                    engine: "chromeBuiltin",
                    sl: sourceLang,
                    tl: targetLang,
                });
                break;
            case "LocalPageTranslate": {
                const localMode = result.LocalTranslatorConfig && result.LocalTranslatorConfig.mode;
                executeDomPageTranslate(channel, {
                    engine: localMode === "googleAiStudio" ? "googleAiStudio" : "localEndpoint",
                    sl: sourceLang,
                    tl: targetLang,
                });
                break;
            }
            case "DomPageTranslate":
                executeDomPageTranslate(channel, {
                    engine: "dom",
                    sl: sourceLang,
                    tl: targetLang,
                });
                break;
            default:
                executeGoogleScript(channel);
                break;
        }
    });
}

/**
 * Execute DOM-based page translation in the active tab.
 *
 * @param {import("../../common/scripts/channel.js").default} channel Communication channel.
 * @param {{ engine?: string, sl?: string, tl?: string }} detail Page translation options.
 */
function executeDomPageTranslate(channel, detail = {}) {
    promiseTabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs && tabs[0]) {
            channel.emitToTabs(tabs[0].id, "start_dom_page_translate", detail);
        }
    });
}

/**
 * 执行谷歌网页翻译相关脚本。
 *
 * @param {import("../../common/scripts/channel.js").default} channel Communication channel.
 */
function executeGoogleScript(channel) {
    promiseTabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (!tabs[0]) return;

        const tabId = tabs[0].id;
        const canExecuteScript =
            typeof chrome !== "undefined" && chrome.scripting && chrome.scripting.executeScript;

        if (!canExecuteScript) {
            channel.emitToTabs(tabId, "inject_page_translate", {});
            return;
        }

        chrome.scripting
            .executeScript({
                target: { tabId, allFrames: false },
                files: ["google/init.js"],
                injectImmediately: true,
            })
            .then(() => {
                channel.emitToTabs(tabId, "start_page_translate", {
                    translator: "google",
                });
                setTimeout(() => {
                    try {
                        channel.emitToTabs(tabId, "start_dom_page_translate", {});
                    } catch {}
                }, 800);
            })
            .catch((error) => {
                logWarn(`Chrome scripting error: ${error}`);
                channel.emitToTabs(tabId, "inject_page_translate", {});
            });
    });
}

export { translatePage, executeGoogleScript, executeDomPageTranslate };
