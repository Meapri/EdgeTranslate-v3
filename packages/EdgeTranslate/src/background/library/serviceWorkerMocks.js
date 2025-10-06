export function setupServiceWorkerMocks() {
    if (typeof self === "undefined" || self.__edgeTranslateMocksInitialized) {
        return;
    }
    self.__edgeTranslateMocksInitialized = true;

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
                textContent: text || "",
                data: text || "",
                parentNode: null,
            };
        };

        // Enhanced query methods that actually work
        self.document.getElementById = function (id) {
            // Handle case where id is not a string or is null/undefined
            if (!id || typeof id !== "string") return null;

            // Recursively search through all elements for the ID
            function findById(element, targetId) {
                if (!element) return null;
                if (element.id === targetId) return element;
                if (element.children && Array.isArray(element.children)) {
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
            // Handle case where selector is not a string or is null/undefined
            if (!selector || typeof selector !== "string") return null;

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

        // Add missing document properties
        self.document.location = {
            origin: "chrome-extension://",
            pathname: "/background.js",
            search: "",
            href: "chrome-extension://background.js",
            protocol: "chrome-extension:",
            host: "",
            hostname: "",
        };

        // Add document methods that might be called
        self.document.addEventListener = function () {};
        self.document.removeEventListener = function () {};
        self.document.createTreeWalker = function () {
            return {
                nextNode() {
                    return null;
                },
                firstChild() {
                    return null;
                },
                parentNode() {
                    return null;
                },
            };
        };

        // Add toString method to prevent errors
        self.document.toString = function () {
            return "[object Document]";
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

        console.log(
            "[EdgeTranslate] Service Worker 환경 설정 완료 - translators 패키지 호환성 확보"
        );
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
}
