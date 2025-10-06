import { TranslatorManager, translatePage, executeGoogleScript } from "./library/translate.js";
import {
    addUrlBlacklist,
    addDomainBlacklist,
    removeUrlBlacklist,
    removeDomainBlacklist,
    updateBLackListMenu,
} from "./library/blacklist.js";
import { initializeBackgroundErrorHandling } from "./library/errorHandling.js";
import { setupPdfDetection } from "./library/pdfDetection.js";
import { setupServiceWorkerMocks } from "./library/serviceWorkerMocks.js";
// Analytics removed
import { logWarn, logInfo } from "common/scripts/logger.js";
import { promiseTabs } from "common/scripts/promise.js";
import Channel from "common/scripts/channel.js";
// map language abbreviation from browser languages to translation languages
import { BROWSER_LANGUAGES_MAP } from "common/scripts/languages.js";
import { DEFAULT_SETTINGS, setDefaultSettings } from "common/scripts/settings.js";

initializeBackgroundErrorHandling({ logWarn });
setupServiceWorkerMocks();
setupPdfDetection({ logInfo, logWarn });

/**
 * Chrome Runtime 오류 처리
 */
try {
    chrome.runtime.onStartup?.addListener?.(() => {
        logInfo("Extension startup");
    });
} catch {}

// Note: onSuspend is not supported in Safari; intentionally not registering.

/**
 * Setup context menus - moved inside onInstalled to work with service worker
 */
let contextMenusInitialized = false;

function setupContextMenus() {
    if (contextMenusInitialized) return;
    // Clear existing menus first to avoid duplicate id errors on SW restart/reload
    const createAll = () => {
        const isSafari = BROWSER_ENV === "safari";
        chrome.contextMenus.create({
            id: "translate",
            title: `${chrome.i18n.getMessage("Translate")} '%s'`,
            contexts: ["selection"],
        });

        // Add an entry to options page for Firefox as it doesn't have one.
        if (BROWSER_ENV === "firefox") {
            chrome.contextMenus.create({
                id: "settings",
                title: chrome.i18n.getMessage("Settings"),
                contexts: ["action"],
            });
        }

        chrome.contextMenus.create({
            id: "shortcut",
            title: chrome.i18n.getMessage("ShortcutSetting"),
            contexts: ["action"],
        });

        if (!isSafari && BROWSER_ENV !== "firefox") {
            chrome.contextMenus.create({
                id: "translate_page",
                title: chrome.i18n.getMessage("TranslatePage"),
                contexts: ["page"],
            });
        }

        if (!isSafari && BROWSER_ENV !== "firefox") {
            chrome.contextMenus.create({
                id: "translate_page_google",
                title: chrome.i18n.getMessage("TranslatePageGoogle"),
                contexts: ["action"],
            });
        }

        chrome.contextMenus.create({
            id: "add_url_blacklist",
            title: chrome.i18n.getMessage("AddUrlBlacklist"),
            contexts: ["action"],
            enabled: false,
            visible: false,
        });

        chrome.contextMenus.create({
            id: "add_domain_blacklist",
            title: chrome.i18n.getMessage("AddDomainBlacklist"),
            contexts: ["action"],
            enabled: false,
            visible: false,
        });

        chrome.contextMenus.create({
            id: "remove_url_blacklist",
            title: chrome.i18n.getMessage("RemoveUrlBlacklist"),
            contexts: ["action"],
            enabled: false,
            visible: false,
        });

        chrome.contextMenus.create({
            id: "remove_domain_blacklist",
            title: chrome.i18n.getMessage("RemoveDomainBlacklist"),
            contexts: ["action"],
            enabled: false,
            visible: false,
        });

        contextMenusInitialized = true;
    };

    try {
        chrome.contextMenus.removeAll(() => {
            // ensure lastError is consumed if present, then create
            void chrome.runtime.lastError;
            createAll();
        });
    } catch {
        createAll();
    }
}

/**
 * 初始化插件配置。
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    // Setup context menus on installation/startup
    setupContextMenus();
    // 只有在生产环境下，才会展示说明页面
    if (process.env.NODE_ENV === "production") {
        if (details.reason === "install") {
            // 首次安装，引导用户查看wiki
            chrome.tabs.create({
                // 为wiki页面创建一个新的标签页
                url: chrome.i18n.getMessage("WikiLink"),
            });

            // 告知用户数据收集相关信息（在 Safari 下可能不支持 notifications 权限）
            if (chrome.notifications && typeof chrome.notifications.create === "function") {
                chrome.notifications.create("data_collection_notification", {
                    type: "basic",
                    iconUrl: chrome.runtime.getURL("icon/icon128.png"),
                    title: chrome.i18n.getMessage("AppName"),
                    message: chrome.i18n.getMessage("DataCollectionNotice"),
                });
            }

            // Analytics removed
        } else if (details.reason === "update") {
            await new Promise((resolve) => {
                chrome.storage.sync.get((result) => {
                    let buffer = result; // use var buffer as a pointer
                    setDefaultSettings(buffer, DEFAULT_SETTINGS); // assign default value to buffer
                    chrome.storage.sync.set(buffer, resolve);
                });
            });

            // Fix language setting compatibility between Edge Translate 2.x and 1.x.x.
            chrome.storage.sync.get("languageSetting", (result) => {
                if (!result.languageSetting) return;

                if (result.languageSetting.sl === "zh-cn") {
                    result.languageSetting.sl = "zh-CN";
                } else if (result.languageSetting.sl === "zh-tw") {
                    result.languageSetting.sl = "zh-TW";
                }

                if (result.languageSetting.tl === "zh-cn") {
                    result.languageSetting.tl = "zh-CN";
                } else if (result.languageSetting.tl === "zh-tw") {
                    result.languageSetting.tl = "zh-TW";
                }
                chrome.storage.sync.set(result);
            });

            // 从旧版本更新，引导用户查看更新日志（在 Safari 下可能不支持 notifications 权限）
            if (chrome.notifications && typeof chrome.notifications.create === "function") {
                chrome.notifications.create("update_notification", {
                    type: "basic",
                    iconUrl: chrome.runtime.getURL("icon/icon128.png"),
                    title: chrome.i18n.getMessage("AppName"),
                    message: chrome.i18n.getMessage("ExtensionUpdated"),
                });
            }
        }

        // Do not open any page on uninstall
    }
});

/**
 * Setup context menus on service worker startup
 */
chrome.runtime.onStartup.addListener(() => {
    setupContextMenus();
});

/**
 * Create communication channel.
 */
const channel = new Channel();

/**
 * Create translator manager and register event listeners and service providers.
 */
const TRANSLATOR_MANAGER = new TranslatorManager(channel);

/**
 * 监听用户点击通知事件
 */
if (chrome.notifications && typeof chrome.notifications.onClicked?.addListener === "function") {
    chrome.notifications.onClicked.addListener((notificationId) => {
        switch (notificationId) {
            case "update_notification":
                chrome.tabs.create({
                    // 为releases页面创建一个新的标签页
                    url: "https://github.com/EdgeTranslate/EdgeTranslate/releases",
                });
                break;
            case "data_collection_notification":
                chrome.tabs.create({
                    // 为设置页面单独创建一个标签页
                    url: chrome.runtime.getURL("options/options.html#google-analytics"),
                });
                break;
            default:
                break;
        }
    });
}

/**
 * 添加点击菜单后的处理事件
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
    switch (info.menuItemId) {
        case "translate":
            channel
                .requestToTab(tab.id, "get_selection")
                .then(({ text, position }) => {
                    if (text) {
                        return TRANSLATOR_MANAGER.translate(text, position);
                    }
                    return Promise.reject();
                })
                .catch((error) => {
                    // If content scripts can not access the tab the selection, use info.selectionText instead.
                    if (info.selectionText.trim()) {
                        return TRANSLATOR_MANAGER.translate(info.selectionText, null);
                    }
                    return Promise.resolve(error);
                });
            break;
        case "translate_page":
            translatePage(channel);
            break;
        case "translate_page_google":
            executeGoogleScript(channel);
            break;
        case "settings":
            chrome.runtime.openOptionsPage();
            break;
        case "shortcut":
            chrome.tabs.create({
                url: "chrome://extensions/shortcuts",
            });
            break;
        case "add_url_blacklist":
            addUrlBlacklist();
            break;
        case "remove_url_blacklist":
            removeUrlBlacklist();
            break;
        case "add_domain_blacklist":
            addDomainBlacklist();
            break;
        case "remove_domain_blacklist":
            removeDomainBlacklist();
            break;
        default:
            break;
    }
});

/**
 * 添加tab切换事件监听，用于更新黑名单信息
 */
chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab.url && tab.url.length > 0) {
            updateBLackListMenu(tab.url);
        }
    });
});

/**
 * 添加tab刷新事件监听，用于更新黑名单信息
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && tab.url && tab.url.length > 0) {
        updateBLackListMenu(tab.url);
    }
});

/**
 * Redirect tab when redirect event happens.
 */
channel.on("redirect", (detail, sender) => chrome.tabs.update(sender.tab.id, { url: detail.url }));

/**
 * Open options page when open_options_page button clicked.
 */
channel.on("open_options_page", () => chrome.runtime.openOptionsPage());

/**
 * Forward page translate event back to pages.
 */
channel.on("page_translate_event", (detail, sender) => {
    try {
        // 배너 생성으로 페이지가 내려간 경우 DOM 폴백 예약 취소 신호만 보냄
        if (
            detail &&
            detail.event === "page_moved" &&
            typeof detail.distance === "number" &&
            detail.distance > 0
        ) {
            channel.emitToTabs(sender.tab.id, "page_translate_control", {
                action: "cancel_dom_fallback",
            });
        }
    } catch {}
    channel.emitToTabs(sender.tab.id, "page_translate_event", detail);
});

/**
 * Provide UI language detecting service.
 */
channel.provide("get_lang", () => {
    return Promise.resolve({
        lang: BROWSER_LANGUAGES_MAP[chrome.i18n.getUILanguage()],
    });
});

/**
 *  将快捷键消息转发给content_scripts
 */
chrome.commands.onCommand.addListener((command) => {
    switch (command) {
        case "translate_page":
            translatePage(channel);
            break;
        default:
            promiseTabs
                .query({ active: true, currentWindow: true })
                .then((tabs) => channel.emitToTabs(tabs[0].id, "command", { command }))
                .catch(() => {});
            break;
    }
});

/**
 * Note: webRequest API has been removed in Manifest V3.
 * Header modifications for CSP and CORS are now handled differently:
 * 1. CSP modifications may need to be handled through content scripts injection
 * 2. CORS issues should be addressed through proper server-side configurations
 * 3. Some functionality may need to be reimplemented using declarativeNetRequest
 *
 * For now, these header modifications are commented out as they require
 * a different approach in Manifest V3. The translation functionality
 * may work without these modifications, or alternative solutions need to be implemented.
 */

// Analytics removed

/**
 * dynamic importing hot reload function only in development env
 */
if (BUILD_ENV === "development" && BROWSER_ENV === "chrome") {
    import("./library/hot_reload.js").then((module) => {
        module.hotReload();
    });
}
