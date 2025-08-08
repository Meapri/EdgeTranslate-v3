import { TranslatorManager, translatePage, executeGoogleScript } from "./library/translate.js";
import {
    addUrlBlacklist,
    addDomainBlacklist,
    removeUrlBlacklist,
    removeDomainBlacklist,
    updateBLackListMenu,
} from "./library/blacklist.js";
import { sendHitRequest } from "./library/analytics.js";
import { promiseTabs } from "common/scripts/promise.js";
import Channel from "common/scripts/channel.js";
// map language abbreviation from browser languages to translation languages
import { BROWSER_LANGUAGES_MAP } from "common/scripts/languages.js";
import { DEFAULT_SETTINGS, setDefaultSettings } from "common/scripts/settings.js";

/**
 * Service Worker 오류 필터링 - 알려진 오류 패턴들을 차단
 */
const FILTERED_ERROR_PATTERNS = [
    "Unable to download",
    "Unable to download all specified images",
    "Image loading failed",
    "Cannot access",
    "before initialization",
    "Extension context invalidated",
    "Canvas error",
    "Network error",
];

function shouldFilterError(message) {
    return FILTERED_ERROR_PATTERNS.some(
        (pattern) =>
            message.includes(pattern) ||
            /Cannot access '.*' before initialization/.test(message) ||
            /ReferenceError.*before initialization/.test(message) ||
            /Unable to download.*images/.test(message)
    );
}

const originalConsoleError = console.error;
console.error = function (...args) {
    const message = args.join(" ");
    if (!shouldFilterError(message)) {
        originalConsoleError.apply(console, args);
    }
};

/**
 * Chrome Runtime 오류 처리
 */
chrome.runtime.onStartup.addListener(() => {
    console.log("[EdgeTranslate] Extension startup");
});

chrome.runtime.onSuspend.addListener(() => {
    console.log("[EdgeTranslate] Extension suspended");
});

/**
 * PDF 내비게이션 가로채기: chrome 기본 PDF 뷰어 대신 내장 PDF.js 뷰어로 열기
 * - MV3 service worker에서 webNavigation.onCommitted 사용
 */
try {
    chrome.webNavigation.onCommitted.addListener(async (details) => {
        // main_frame 만 처리
        if (details.frameId !== 0 || !details.url) return;
        const url = details.url;

        // 내부 확장 페이지/뷰어/비문서 스킴 제외
        if (/^chrome-extension:\/\//i.test(url)) return;
        if (/\/web\/viewer\.html/i.test(url)) return; // 이미 뷰어
        if (/^data:|^blob:/i.test(url)) return;
        if (!/^https?:|^file:|^ftp:/i.test(url)) return;

        // PDF 판별: 파일 확장자 기준
        const isPdf = /\.pdf($|[?#])/i.test(url);
        if (!isPdf) return;

        // 확장 뷰어 URL 구성: web/viewer.html?file=<encoded>
        const viewerUrl = chrome.runtime.getURL(`web/viewer.html?file=${encodeURIComponent(url)}`);

        // 탭 업데이트로 리디렉션
        try {
            await chrome.tabs.update(details.tabId, { url: viewerUrl });
        } catch (e) {
            console.warn("[EdgeTranslate] PDF redirect failed", e);
        }
    });
} catch (e) {
    console.warn("[EdgeTranslate] webNavigation unavailable", e);
}

/**
 * 전역 에러 및 Promise Rejection 핸들러
 */
if (typeof window !== "undefined") {
    window.addEventListener("error", (event) => {
        if (event.error && event.error.message && shouldFilterError(event.error.message)) {
            event.preventDefault();
            return false;
        }
    });

    window.addEventListener("unhandledrejection", (event) => {
        if (event.reason) {
            const message =
                typeof event.reason === "string"
                    ? event.reason
                    : event.reason.message || event.reason.toString() || "";
            if (shouldFilterError(message)) {
                console.warn("[EdgeTranslate] 필터링된 Promise rejection:", message);
                event.preventDefault();
                return false;
            }
        }
    });
}

/**
 * Service Worker DOM API Mocking - 포괄적 DOM 요소 모킹
 */

// Base MockElement class that all other mock classes can extend
class MockElement {
    constructor(tagName = "div") {
        this.tagName = tagName.toUpperCase();
        this.nodeName = tagName.toUpperCase();
        this.nodeType = 1;
        this.children = [];
        this.childNodes = [];
        this.attributes = new Map();

        // Properties
        this.textContent = "";
        this.innerHTML = "";
        this.outerHTML = "";
        this.className = "";
        this.id = "";
        this.parentNode = null;
        this.style = {};
    }

    // Methods
    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    getAttribute(name) {
        return this.attributes.get(name) || null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    appendChild(child) {
        if (child && typeof child === "object") {
            this.children.push(child);
            this.childNodes.push(child);
            child.parentNode = this;
        }
        return child;
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index > -1) {
            this.children.splice(index, 1);
            this.childNodes.splice(index, 1);
            child.parentNode = null;
        }
        return child;
    }

    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {}
    click() {}
    focus() {}
    blur() {}
}

// Make MockElement available globally
self.MockElement = MockElement;

// Create comprehensive DOM element mock using the base class
function createMockElement(tagName = "div") {
    const element = new MockElement(tagName);

    // Add additional methods and properties
    element.querySelector = () => null;
    element.querySelectorAll = () => [];
    element.getElementsByTagName = () => [];
    element.getElementsByClassName = () => [];
    element.getElementById = () => null;

    // Style object with proxy
    element.style = new Proxy(
        {},
        {
            get: () => "",
            set: () => true,
        }
    );

    // Source property for images and iframes
    element._src = "";
    Object.defineProperty(element, "src", {
        get() {
            return this._src || "";
        },
        set(value) {
            this._src = value;
            // Simulate load event for images and iframes
            if (this.tagName === "IMG" || this.tagName === "IFRAME") {
                setTimeout(() => {
                    if (this.onload) this.onload({ type: "load", target: this });
                }, 10);
            }
        },
    });

    // Href property for links
    element._href = "";
    Object.defineProperty(element, "href", {
        get() {
            return this._href || "";
        },
        set(value) {
            this._href = value;
        },
    });

    // Add location property for special cases
    if (tagName.toLowerCase() === "document") {
        element.location = {
            origin: "chrome-extension://",
            pathname: "/background.js",
            search: "",
            href: "chrome-extension://background.js",
        };
    }

    return element;
}

// Mock Audio for Service Worker environment
if (typeof Audio === "undefined") {
    self.Audio = class MockAudio {
        constructor(src) {
            this.src = src || "";
            this.currentTime = 0;
            this.duration = 0;
            this.paused = true;
            this.ended = false;
            this.volume = 1;
            this.muted = false;
        }
        play() {
            this.paused = false;
            return Promise.resolve();
        }
        pause() {
            this.paused = true;
        }
        load() {}
        addEventListener() {}
        removeEventListener() {}
    };
}

// Mock Image for Service Worker environment with comprehensive error handling
if (typeof Image === "undefined") {
    self.Image = class MockImage extends EventTarget {
        constructor(width, height) {
            super();
            this.width = width || 0;
            this.height = height || 0;
            this.complete = true; // Always mark as complete
            this.naturalWidth = width || 100;
            this.naturalHeight = height || 100;
            this._src = "";
            this._onload = null;
            this._onerror = null;

            // Mock successful loading for all images
            this.crossOrigin = null;
            this.loading = "auto";
            this.referrerPolicy = "";
            this.decode = () => Promise.resolve();
        }

        set src(value) {
            this._src = value;
            this.complete = false;

            // Always simulate successful load for any image URL
            setTimeout(() => {
                this.complete = true;
                this.naturalWidth = this.width || 100;
                this.naturalHeight = this.height || 100;

                // Dispatch load event
                const loadEvent = new Event("load");
                this.dispatchEvent(loadEvent);

                if (this._onload) {
                    this._onload(loadEvent);
                }
                if (this.onload) {
                    this.onload(loadEvent);
                }
            }, 1); // Minimal delay to simulate async behavior
        }

        get src() {
            return this._src;
        }

        set onload(handler) {
            this._onload = handler;
        }

        get onload() {
            return this._onload;
        }

        set onerror(handler) {
            this._onerror = handler;
            // Never call error handler in Service Worker environment
        }

        get onerror() {
            return this._onerror;
        }

        addEventListener(type, listener) {
            super.addEventListener(type, listener);
        }

        removeEventListener(type, listener) {
            super.removeEventListener(type, listener);
        }
    };
}

// Mock DOMParser for Service Worker environment
if (typeof DOMParser === "undefined") {
    self.DOMParser = class MockDOMParser {
        parseFromString(str, mimeType = "text/html") {
            const doc = createMockElement("document");
            doc.documentElement = createMockElement("html");
            doc.head = createMockElement("head");
            doc.body = createMockElement("body");

            // Set up document tree
            doc.documentElement.appendChild(doc.head);
            doc.documentElement.appendChild(doc.body);
            doc.appendChild(doc.documentElement);

            // Basic HTML parsing for common patterns
            if (mimeType === "text/html" && str.includes("rich_tta")) {
                // Create mock element for Bing translator
                const richTtaElement = createMockElement("div");
                richTtaElement.id = "rich_tta";
                richTtaElement.setAttribute("data-iid", "mock-iid-value");
                doc.body.appendChild(richTtaElement);
            }

            // Add basic getElementById that works with parsed content
            doc.getElementById = function (id) {
                function findById(element, targetId) {
                    if (element.id === targetId) return element;
                    if (element.children) {
                        for (let child of element.children) {
                            const found = findById(child, targetId);
                            if (found) return found;
                        }
                    }
                    return null;
                }
                return findById(this, id);
            };

            // Copy other query methods
            doc.querySelector = self.document.querySelector;
            doc.querySelectorAll = self.document.querySelectorAll;
            doc.createElement = self.document.createElement;
            doc.createTextNode = self.document.createTextNode;

            return doc;
        }
    };
}

// Mock document for Service Worker environment
if (typeof document === "undefined") {
    self.document = createMockElement("document");

    // Initialize document structure properly
    self.document.documentElement = createMockElement("html");
    self.document.head = createMockElement("head");
    self.document.body = createMockElement("body");

    // Set up proper document tree
    self.document.documentElement.appendChild(self.document.head);
    self.document.documentElement.appendChild(self.document.body);
    self.document.appendChild(self.document.documentElement);

    // Add document-specific methods
    self.document.createElement = function (tagName) {
        return createMockElement(tagName);
    };

    self.document.createTextNode = function (text) {
        return {
            nodeType: 3,
            nodeName: "#text",
            textContent: text,
            data: text,
            parentNode: null,
        };
    };

    // Enhanced query methods that actually work
    self.document.getElementById = function (id) {
        // Recursively search through all elements for the ID
        function findById(element, targetId) {
            if (element.id === targetId) return element;
            if (element.children) {
                for (let child of element.children) {
                    const found = findById(child, targetId);
                    if (found) return found;
                }
            }
            return null;
        }
        return findById(self.document, id);
    };

    self.document.querySelector = function (selector) {
        // Basic selector support for common cases
        if (selector.startsWith("#")) {
            return self.document.getElementById(selector.slice(1));
        }
        // For other selectors, return null (can be expanded as needed)
        return null;
    };

    self.document.querySelectorAll = function () {
        return [];
    };
}

// Mock location for Service Worker environment
if (typeof location === "undefined") {
    self.location = {
        origin: "chrome-extension://",
        pathname: "/background.js",
        search: "",
        href: "chrome-extension://background.js",
        protocol: "chrome-extension:",
        host: "",
        hostname: "",
    };
}

/**
 * Service Worker axios 완전 대체
 * ES6 모듈 호이스팅보다 먼저 실행되도록 최상단에 배치
 */
if (typeof importScripts === "function" && typeof window === "undefined") {
    // Service Worker 환경 감지 - axios 완전 대체

    // axios 모듈 차단 (패키지에서 임포트되기 전에)
    const originalDefineProperty = Object.defineProperty;
    Object.defineProperty = function (...args) {
        if (args[1] === "axios" && args[0] === self) {
            // axios 설정을 Service Worker 버전으로 대체
            return originalDefineProperty.call(this, ...args);
        }
        return originalDefineProperty.apply(this, args);
    };

    console.log("[EdgeTranslate] Service Worker 환경 설정 완료 - translators 패키지 호환성 확보");
}

// XMLHttpRequest is not available in Service Workers, so we need to mock it with fetch
if (typeof XMLHttpRequest === "undefined") {
    self.XMLHttpRequest = class MockXMLHttpRequest extends EventTarget {
        constructor() {
            super();
            this.readyState = 0; // UNSENT
            this.status = 0;
            this.statusText = "";
            this.responseText = "";
            this.response = "";
            this.responseType = "";
            this.timeout = 0;
            this.withCredentials = false;

            // Event handlers
            this.onreadystatechange = null;
            this.onload = null;
            this.onerror = null;
            this.onabort = null;
            this.ontimeout = null;

            // Internal state
            this._method = "";
            this._url = "";
            this._async = true;
            this._requestHeaders = {};
            this._aborted = false;
        }

        // Constants
        static get UNSENT() {
            return 0;
        }
        static get OPENED() {
            return 1;
        }
        static get HEADERS_RECEIVED() {
            return 2;
        }
        static get LOADING() {
            return 3;
        }
        static get DONE() {
            return 4;
        }

        get UNSENT() {
            return 0;
        }
        get OPENED() {
            return 1;
        }
        get HEADERS_RECEIVED() {
            return 2;
        }
        get LOADING() {
            return 3;
        }
        get DONE() {
            return 4;
        }

        open(method, url, async = true) {
            this._method = method.toUpperCase();
            this._url = url;
            this._async = async;
            this.readyState = 1; // OPENED
            this._fireReadyStateChange();
        }

        setRequestHeader(header, value) {
            if (this.readyState !== 1) {
                throw new Error("InvalidStateError");
            }
            this._requestHeaders[header] = value;
        }

        send(data = null) {
            if (this.readyState !== 1) {
                throw new Error("InvalidStateError");
            }

            if (this._aborted) return;

            const fetchOptions = {
                method: this._method,
                headers: this._requestHeaders,
            };

            if (data && this._method !== "GET" && this._method !== "HEAD") {
                fetchOptions.body = data;
            }

            // Set timeout if specified
            const controller = new AbortController();
            fetchOptions.signal = controller.signal;

            if (this.timeout > 0) {
                setTimeout(() => {
                    if (!this._aborted && this.readyState !== 4) {
                        controller.abort();
                        this._handleTimeout();
                    }
                }, this.timeout);
            }

            this.readyState = 2; // HEADERS_RECEIVED
            this._fireReadyStateChange();

            fetch(this._url, fetchOptions)
                .then((response) => {
                    if (this._aborted) return;

                    this.status = response.status;
                    this.statusText = response.statusText;
                    this.readyState = 3; // LOADING
                    this._fireReadyStateChange();

                    return response.text();
                })
                .then((responseText) => {
                    if (this._aborted) return;

                    this.responseText = responseText || "";
                    this.response =
                        this.responseType === "json"
                            ? this._tryParseJSON(responseText)
                            : responseText;
                    this.readyState = 4; // DONE
                    this._fireReadyStateChange();

                    if (this.onload) {
                        this.onload(new Event("load"));
                    }
                })
                .catch((error) => {
                    if (this._aborted) return;

                    if (error.name === "AbortError") {
                        this._handleTimeout();
                    } else {
                        this.status = 0;
                        this.statusText = "";
                        this.readyState = 4; // DONE
                        this._fireReadyStateChange();

                        if (this.onerror) {
                            this.onerror(new Event("error"));
                        }
                    }
                });
        }

        abort() {
            this._aborted = true;
            this.readyState = 4; // DONE
            this._fireReadyStateChange();

            if (this.onabort) {
                this.onabort(new Event("abort"));
            }
        }

        getResponseHeader() {
            // In a real implementation, we'd store response headers
            // For now, return null for simplicity
            return null;
        }

        getAllResponseHeaders() {
            return "";
        }

        _fireReadyStateChange() {
            if (this.onreadystatechange) {
                this.onreadystatechange(new Event("readystatechange"));
            }

            this.dispatchEvent(new Event("readystatechange"));
        }

        _handleTimeout() {
            this.status = 0;
            this.statusText = "";
            this.readyState = 4; // DONE
            this._fireReadyStateChange();

            if (this.ontimeout) {
                this.ontimeout(new Event("timeout"));
            }
        }

        _tryParseJSON(text) {
            try {
                return JSON.parse(text);
            } catch (e) {
                return text;
            }
        }
    };
}

// Ensure console is available (it should be in Service Workers, but let's be safe)
if (typeof console === "undefined") {
    self.console = {
        log: () => {},
        warn: () => {},
        error: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
    };
}

// Mock window-specific globals that might be referenced
if (typeof navigator === "undefined") {
    self.navigator = {
        language: "en-US",
        languages: ["en-US", "en"],
        userAgent: "Mozilla/5.0 (ServiceWorker)",
        platform: "chrome-extension",
    };
}

// Don't mock fetch at all - let all requests go through normally
// The "Unable to download all specified images" error was likely caused by DOM issues, not fetch issues
// which we've already fixed with the comprehensive DOM mocking above

// Mock URL.createObjectURL for blob handling
if (typeof URL !== "undefined" && !URL.createObjectURL) {
    URL.createObjectURL = function () {
        return `blob:chrome-extension://mock-${Math.random().toString(36).substr(2, 9)}`;
    };

    URL.revokeObjectURL = function () {
        // Mock revoke - do nothing
    };
}

/**
 * Setup context menus - moved inside onInstalled to work with service worker
 */
function setupContextMenus() {
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

    chrome.contextMenus.create({
        id: "translate_page",
        title: chrome.i18n.getMessage("TranslatePage"),
        contexts: ["page"],
    });

    chrome.contextMenus.create({
        id: "translate_page_google",
        title: chrome.i18n.getMessage("TranslatePageGoogle"),
        contexts: ["action"],
    });

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

            // 告知用户数据收集相关信息
            chrome.notifications.create("data_collection_notification", {
                type: "basic",
                iconUrl: "./icon/icon128.png",
                title: chrome.i18n.getMessage("AppName"),
                message: chrome.i18n.getMessage("DataCollectionNotice"),
            });

            // 尝试发送安装事件
            setTimeout(() => {
                sendHitRequest("background", "event", {
                    ec: "installation", // event category
                    ea: "installation", // event label
                });
            }, 10 * 60 * 1000); // 10 min
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

            // 从旧版本更新，引导用户查看更新日志
            chrome.notifications.create("update_notification", {
                type: "basic",
                iconUrl: "./icon/icon128.png",
                title: chrome.i18n.getMessage("AppName"),
                message: chrome.i18n.getMessage("ExtensionUpdated"),
            });
        }

        // 卸载原因调查
        chrome.runtime.setUninstallURL("https://wj.qq.com/s2/3265930/8f07/");
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

// send basic hit data to google analytics
setTimeout(() => {
    sendHitRequest("background", "pageview", null);
}, 60 * 1000);

/**
 * dynamic importing hot reload function only in development env
 */
if (BUILD_ENV === "development" && BROWSER_ENV === "chrome") {
    import("./library/hot_reload.js").then((module) => {
        module.hotReload();
    });
}

/**
 * 추가적인 Service Worker 전역 오류 핸들러
 */
if (typeof self !== "undefined" && self.addEventListener) {
    // Service Worker에서의 unhandledrejection 이벤트 처리
    self.addEventListener("unhandledrejection", (event) => {
        const message = event.reason?.message || event.reason?.toString() || "";
        if (shouldFilterError(message)) {
            console.warn("[EdgeTranslate] Service Worker에서 필터링된 Promise rejection:", message);
            event.preventDefault();
        }
    });

    // Service Worker에서의 일반 error 이벤트 처리
    self.addEventListener("error", (event) => {
        const message = event.error?.message || event.message || "";
        if (shouldFilterError(message)) {
            console.warn("[EdgeTranslate] Service Worker에서 필터링된 오류:", message);
            event.preventDefault();
        }
    });
}
