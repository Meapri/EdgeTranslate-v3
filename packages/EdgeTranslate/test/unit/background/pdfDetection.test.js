import {
    extendConfig,
    hasPdfViewerBypass,
    shouldHandlePdfNavigationUrl,
    setupPdfDetection,
} from "../../../src/background/library/pdfDetection.js";

describe("pdfDetection redirect guards", () => {
    const originalChrome = global.chrome;
    const originalFetch = global.fetch;

    afterEach(() => {
        global.chrome = originalChrome;
        global.fetch = originalFetch;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("keeps auto-hijacking local file PDFs so the extension PDF viewer can translate them", () => {
        const config = extendConfig();

        expect(shouldHandlePdfNavigationUrl("file:///Users/me/sample.pdf", config)).toBe(true);
    });

    it("skips URLs explicitly marked to bypass the EdgeTranslate PDF viewer", () => {
        const config = extendConfig();
        const url = "https://example.com/file.pdf#edge_translate_pdf_native=1";

        expect(hasPdfViewerBypass(url, config)).toBe(true);
        expect(shouldHandlePdfNavigationUrl(url, config)).toBe(false);
    });

    it("still handles regular web PDFs", () => {
        const config = extendConfig();

        expect(shouldHandlePdfNavigationUrl("https://example.com/file.pdf", config)).toBe(true);
    });

    it("does not network-probe ordinary Chrome Web Store pages", async () => {
        let navigationListener;
        global.fetch = jest.fn();
        global.chrome = {
            runtime: {
                getURL: jest.fn((path) => `chrome-extension://edge/${path}`),
            },
            tabs: {
                update: jest.fn(),
            },
            webRequest: {
                onHeadersReceived: {
                    addListener: jest.fn(),
                    removeListener: jest.fn(),
                },
            },
            webNavigation: {
                onCommitted: {
                    addListener: jest.fn((listener) => {
                        navigationListener = listener;
                    }),
                    removeListener: jest.fn(),
                },
            },
        };

        const detection = setupPdfDetection();
        await navigationListener({
            frameId: 0,
            tabId: 7,
            url: "https://chrome.google.com/webstore/devconsole/7164a195-448a-41b2-9383-dccd1df79372",
        });

        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.chrome.tabs.update).not.toHaveBeenCalled();
        detection.dispose();
    });

    it("still redirects header-confirmed PDFs even when the URL has no PDF-looking path", async () => {
        jest.useFakeTimers();
        let webRequestListener;
        global.chrome = {
            runtime: {
                getURL: jest.fn((path) => `chrome-extension://edge/${path}`),
            },
            tabs: {
                update: jest.fn(),
            },
            webRequest: {
                onHeadersReceived: {
                    addListener: jest.fn((listener) => {
                        webRequestListener = listener;
                    }),
                    removeListener: jest.fn(),
                },
            },
            webNavigation: {
                onCommitted: {
                    addListener: jest.fn(),
                    removeListener: jest.fn(),
                },
            },
        };

        const detection = setupPdfDetection();
        webRequestListener({
            frameId: 0,
            tabId: 11,
            url: "https://example.com/document/viewer?id=123",
            responseHeaders: [{ name: "content-type", value: "application/pdf" }],
        });

        jest.advanceTimersByTime(20);
        await Promise.resolve();

        expect(global.chrome.tabs.update).toHaveBeenCalledWith(11, {
            url:
                "chrome-extension://edge/web/viewer.html?file=https%3A%2F%2Fexample.com%2Fdocument%2Fviewer%3Fid%3D123&source=https%3A%2F%2Fexample.com%2Fdocument%2Fviewer%3Fid%3D123",
        });
        detection.dispose();
    });
});
