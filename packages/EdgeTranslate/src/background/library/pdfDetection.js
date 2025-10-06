const DEFAULT_PDF_DETECTION_CONFIG = {
    cacheTtlMs: 5000,
    redirectDelayMs: 10,
    viewerPath: "web/viewer.html",
    viewerQuery: {
        file: "file",
        source: "source",
    },
    downloadDispositionTokens: ["attachment"],
    pdfMimeTypes: ["application/pdf", "application/x-pdf", "text/pdf"],
    fallbackMimeSniffers: [{ mime: "application/octet-stream", hint: "pdf" }],
    urlHintPatterns: [
        /\.pdf(?:$|[?#])/i,
        /\/pdf\/[^/]+/i,
        /[?&][^=]*\.pdf/i,
        /\/download[^/]*pdf/i,
        /\/view[^/]*pdf/i,
    ],
    domainUrlRules: [
        { domain: /arxiv/i, urlPatterns: [/\/pdf\//i] },
        { domain: /researchgate/i, urlPatterns: [/\.pdf/i, /\/pdf/i] },
        { domain: /ieee/i, urlPatterns: [/\/pdf/i] },
        { domain: /acm/i, urlPatterns: [/\/pdf/i] },
        { domain: /springer/i, urlPatterns: [/\.pdf/i, /\/pdf/i] },
        { domain: /sciencedirect/i, urlPatterns: [/\/pdf/i] },
        { domain: /jstor/i, urlPatterns: [/\.pdf/i] },
    ],
    navigationSchemes: ["http:", "https:", "file:", "ftp:"],
    enableNetworkProbe: true,
    networkProbeTimeoutMs: 4000,
    networkProbeCacheTtlMs: 10 * 60 * 1000,
};

function extendConfig(overrides = {}) {
    return {
        ...DEFAULT_PDF_DETECTION_CONFIG,
        ...overrides,
        viewerQuery: {
            ...DEFAULT_PDF_DETECTION_CONFIG.viewerQuery,
            ...(overrides.viewerQuery || {}),
        },
        pdfMimeTypes: overrides.pdfMimeTypes || DEFAULT_PDF_DETECTION_CONFIG.pdfMimeTypes,
        fallbackMimeSniffers:
            overrides.fallbackMimeSniffers || DEFAULT_PDF_DETECTION_CONFIG.fallbackMimeSniffers,
        urlHintPatterns: overrides.urlHintPatterns || DEFAULT_PDF_DETECTION_CONFIG.urlHintPatterns,
        domainUrlRules: overrides.domainUrlRules || DEFAULT_PDF_DETECTION_CONFIG.domainUrlRules,
        downloadDispositionTokens:
            overrides.downloadDispositionTokens ||
            DEFAULT_PDF_DETECTION_CONFIG.downloadDispositionTokens,
        navigationSchemes:
            overrides.navigationSchemes || DEFAULT_PDF_DETECTION_CONFIG.navigationSchemes,
        enableNetworkProbe:
            overrides.enableNetworkProbe ?? DEFAULT_PDF_DETECTION_CONFIG.enableNetworkProbe,
        networkProbeTimeoutMs:
            overrides.networkProbeTimeoutMs ?? DEFAULT_PDF_DETECTION_CONFIG.networkProbeTimeoutMs,
        networkProbeCacheTtlMs:
            overrides.networkProbeCacheTtlMs ?? DEFAULT_PDF_DETECTION_CONFIG.networkProbeCacheTtlMs,
    };
}

function safeGetHeader(headers, target) {
    if (!Array.isArray(headers) || !target) return "";
    const lowerTarget = target.toLowerCase();
    for (const header of headers) {
        if (!header || !header.name) continue;
        if (header.name.toLowerCase() === lowerTarget) {
            return (header.value || "").toString();
        }
    }
    return "";
}

function isDownloadRequest(headers, tokens) {
    const contentDisposition = safeGetHeader(headers, "content-disposition").toLowerCase();
    if (!contentDisposition) return false;
    return tokens.some((token) => contentDisposition.includes(token.toLowerCase()));
}

function isPdfContentType(contentType, config) {
    const lower = contentType.toLowerCase();
    if (!lower) return false;
    if (config.pdfMimeTypes.some((mime) => lower.includes(mime.toLowerCase()))) {
        return true;
    }

    return config.fallbackMimeSniffers.some(
        (sniffer) =>
            lower.includes(sniffer.mime.toLowerCase()) &&
            (sniffer.hint ? lower.includes(sniffer.hint.toLowerCase()) : true)
    );
}

function matchesUrlHints(url, config) {
    if (!url || typeof url !== "string") return false;
    return config.urlHintPatterns.some((pattern) => {
        try {
            return pattern.test(url);
        } catch (_) {
            return false;
        }
    });
}

function getDomain(url) {
    try {
        return new URL(url).hostname || "";
    } catch (_) {
        const match = url.match(/\/\/([^/]+)/);
        return match ? match[1] : "";
    }
}

function matchesDomainRule(url, config) {
    const domain = getDomain(url).toLowerCase();
    if (!domain) return false;
    return config.domainUrlRules.some((rule) => {
        try {
            if (!rule?.domain?.test(domain)) return false;
            return rule.urlPatterns?.some((pattern) => pattern.test(url));
        } catch (_) {
            return false;
        }
    });
}

function isPotentialPdfUrl(url, config) {
    return matchesUrlHints(url, config) || matchesDomainRule(url, config);
}

function buildViewerUrl(url, config) {
    const fileParam = config.viewerQuery.file;
    const sourceParam = config.viewerQuery.source;
    const viewerUrl = chrome.runtime.getURL(config.viewerPath);
    const params = new URLSearchParams();
    params.set(fileParam, url);
    if (sourceParam) params.set(sourceParam, url);
    return `${viewerUrl}?${params.toString()}`;
}

function createCache(ttlMs) {
    const store = new Map();

    return {
        set(key, value) {
            if (!key) return;
            const expireAt = ttlMs ? Date.now() + ttlMs : 0;
            store.set(key, { value, expireAt });
        },
        get(key) {
            const entry = store.get(key);
            if (!entry) return undefined;
            if (entry.expireAt && entry.expireAt <= Date.now()) {
                store.delete(key);
                return undefined;
            }
            return entry.value;
        },
        clear() {
            store.clear();
        },
    };
}

function analyzeHeaders(headers, config) {
    const contentType = headers.get("content-type") || "";
    const disposition = headers.get("content-disposition") || "";
    const typeMatches = isPdfContentType(contentType, config);
    const filenameMatches = /\.pdf(?:["')]|$)/i.test(disposition);
    const downloadRequest = config.downloadDispositionTokens.some((token) =>
        disposition.toLowerCase().includes(token.toLowerCase())
    );
    return {
        contentType,
        contentDisposition: disposition,
        isPdf: typeMatches || filenameMatches,
        isDownload: downloadRequest,
    };
}

function shouldNetworkProbe(url) {
    try {
        const { protocol } = new URL(url);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

async function performProbeRequest(url, method, config, logWarn, headers = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.networkProbeTimeoutMs);
    try {
        const response = await fetch(url, {
            method,
            headers,
            signal: controller.signal,
            redirect: "follow",
            credentials: "include",
        });
        clearTimeout(timeout);

        const analysis = analyzeHeaders(response.headers, config);

        if (method === "GET") {
            try {
                await response.body?.cancel();
            } catch {}
        }

        return {
            ...analysis,
            status: response.status,
            ok: response.ok,
            finalUrl: response.url || url,
        };
    } catch (error) {
        clearTimeout(timeout);
        if (error?.name !== "AbortError") {
            logWarn?.(`PDF probe ${method} failed for ${url}`, error);
        }
        return null;
    }
}

async function probePdfUrl(url, { config, logWarn }) {
    if (!config.enableNetworkProbe || !shouldNetworkProbe(url)) {
        return { isPdf: true, isDownload: false, contentType: "", finalUrl: url };
    }

    const headResult = await performProbeRequest(url, "HEAD", config, logWarn);
    if (headResult) {
        if (headResult.isDownload) {
            return { ...headResult, isPdf: false };
        }
        if (headResult.isPdf) {
            return headResult;
        }
        if (headResult.ok && headResult.status < 400) {
            return { ...headResult, isPdf: false };
        }
    }

    const getResult = await performProbeRequest(url, "GET", config, logWarn, {
        Range: "bytes=0-0",
    });
    if (getResult) {
        if (getResult.isDownload) {
            return { ...getResult, isPdf: false };
        }
        if (getResult.isPdf) {
            return getResult;
        }
        return { ...getResult, isPdf: false };
    }

    return { isPdf: false, isDownload: false, contentType: "", finalUrl: url };
}

async function confirmPdfByNetwork(url, context) {
    const cached = context.probeCache.get(url);
    if (cached) return cached;

    const inflight = context.inflightProbes.get(url);
    if (inflight) return inflight;

    const probePromise = (async () => {
        const result = (await probePdfUrl(url, {
            config: context.config,
            logWarn: context.logWarn,
        })) || { isPdf: false, isDownload: false, contentType: "", finalUrl: url };
        context.probeCache.set(url, result);
        context.inflightProbes.delete(url);
        return result;
    })();

    context.inflightProbes.set(url, probePromise);
    return probePromise;
}

async function redirectToViewer(tabId, url, config, { logInfo, logWarn }) {
    if (typeof tabId !== "number" || tabId < 0) return;
    try {
        const viewerUrl = buildViewerUrl(url, config);
        await chrome.tabs.update(tabId, { url: viewerUrl });
        logInfo?.(`PDF redirected: ${url}`);
    } catch (error) {
        logWarn?.("PDF redirect failed", error);
    }
}

function setupWebRequestListener({ cache, probeCache, config, logInfo, logWarn }) {
    if (
        !chrome?.webRequest?.onHeadersReceived ||
        typeof chrome.webRequest.onHeadersReceived.addListener !== "function"
    ) {
        return { dispose: () => {}, ok: false };
    }

    const listener = (details) => {
        try {
            if (details.frameId !== 0 || typeof details.url !== "string") return;

            const headers = details.responseHeaders || [];
            const contentType = safeGetHeader(headers, "content-type");
            const isPdf = isPdfContentType(contentType, config);
            const isDownload = isDownloadRequest(headers, config.downloadDispositionTokens);

            const entry = { isPdf, isDownload, contentType };
            cache.set(details.url, entry);
            probeCache?.set(details.url, entry);

            if (isPdf && !isDownload) {
                setTimeout(() => {
                    void redirectToViewer(details.tabId, details.url, config, { logInfo, logWarn });
                }, config.redirectDelayMs);
            } else if (isDownload) {
                logInfo?.(`PDF download detected and left untouched: ${details.url}`);
            }
        } catch (error) {
            logWarn?.("webRequest PDF detection failed", error);
        }
    };

    try {
        chrome.webRequest.onHeadersReceived.addListener(
            listener,
            {
                urls: ["<all_urls>"],
                types: ["main_frame"],
            },
            ["responseHeaders"]
        );
        return {
            ok: true,
            dispose: () => {
                try {
                    chrome.webRequest.onHeadersReceived.removeListener(listener);
                } catch (_) {
                    // ignore teardown failures
                }
            },
        };
    } catch (error) {
        logWarn?.("webRequest unavailable, falling back to URL-based detection", error);
        return { ok: false, dispose: () => {} };
    }
}

function setupNavigationListener({ cache, config, logInfo, logWarn, probeCache, inflightProbes }) {
    if (
        !chrome?.webNavigation?.onCommitted ||
        typeof chrome.webNavigation.onCommitted.addListener !== "function"
    ) {
        return { dispose: () => {}, ok: false };
    }

    const listener = async (details) => {
        try {
            if (details.frameId !== 0 || typeof details.url !== "string") return;
            const { url, tabId } = details;

            try {
                const protocol = new URL(url).protocol;
                if (protocol && !config.navigationSchemes.includes(protocol)) return;
            } catch (_) {
                // Ignore invalid URL parsing errors
            }

            let shouldRedirect = true;
            const cached = cache.get(url);
            let pdfConfirmed = cached?.isPdf === true;
            if (cached) {
                if (cached.isPdf === false || cached.isDownload) {
                    shouldRedirect = false;
                }
            } else if (config.enableNetworkProbe && shouldNetworkProbe(url)) {
                const probeResult = await confirmPdfByNetwork(url, {
                    probeCache,
                    inflightProbes,
                    config,
                    logWarn,
                });
                if (probeResult) {
                    cache.set(url, {
                        isPdf: !!probeResult.isPdf,
                        isDownload: !!probeResult.isDownload,
                        contentType: probeResult.contentType || "",
                    });
                    pdfConfirmed = probeResult.isPdf === true;
                    if (!probeResult.isPdf || probeResult.isDownload) {
                        shouldRedirect = false;
                        if (probeResult.isDownload) {
                            logInfo?.(`PDF download detected via probe and skipped: ${url}`);
                        }
                    }
                } else {
                    shouldRedirect = false;
                }
            }

            if (!shouldRedirect) return;

            if (!pdfConfirmed && !isPotentialPdfUrl(url, config)) return;

            await redirectToViewer(tabId, url, config, { logInfo, logWarn });
        } catch (error) {
            logWarn?.("webNavigation PDF detection failed", error);
        }
    };

    try {
        chrome.webNavigation.onCommitted.addListener(listener);
        return {
            ok: true,
            dispose: () => {
                try {
                    chrome.webNavigation.onCommitted.removeListener(listener);
                } catch (_) {
                    // ignore teardown failures
                }
            },
        };
    } catch (error) {
        logWarn?.("webNavigation unavailable for PDF detection", error);
        return { ok: false, dispose: () => {} };
    }
}

export function setupPdfDetection({ config: overrides, logInfo, logWarn } = {}) {
    const config = extendConfig(overrides);
    const cache = createCache(config.cacheTtlMs);
    const probeCache = createCache(config.networkProbeCacheTtlMs);
    const inflightProbes = new Map();

    const webRequest = setupWebRequestListener({
        cache,
        probeCache,
        config,
        logInfo,
        logWarn,
    });
    const navigation = setupNavigationListener({
        cache,
        config,
        logInfo,
        logWarn,
        probeCache,
        inflightProbes,
    });

    return {
        dispose() {
            webRequest.dispose();
            navigation.dispose();
            cache.clear();
            probeCache.clear();
            inflightProbes.clear();
        },
        config,
    };
}
