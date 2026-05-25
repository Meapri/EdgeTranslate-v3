const PDF_NATIVE_BYPASS_PARAM = "edge_translate_pdf_native";
const PDF_PAGE_TRANSLATE_EVENT = "edge_translate_pdf_page_translate";

function getOriginalPdfUrl(locationLike = window.location) {
    try {
        const url = new URL(locationLike.href);
        return url.searchParams.get("source") || url.searchParams.get("file") || "";
    } catch (_) {
        return "";
    }
}

function appendBypassMarkerToHash(hash) {
    const rawHash = String(hash || "").replace(/^#/, "");
    if (rawHash.includes(`${PDF_NATIVE_BYPASS_PARAM}=1`)) {
        return rawHash ? `#${rawHash}` : `#${PDF_NATIVE_BYPASS_PARAM}=1`;
    }
    return rawHash
        ? `#${rawHash}&${PDF_NATIVE_BYPASS_PARAM}=1`
        : `#${PDF_NATIVE_BYPASS_PARAM}=1`;
}

function buildNativePdfUrl(sourceUrl) {
    try {
        const url = new URL(sourceUrl);
        url.hash = appendBypassMarkerToHash(url.hash);
        return url.toString();
    } catch (_) {
        if (!sourceUrl) return `#${PDF_NATIVE_BYPASS_PARAM}=1`;
        const separator = String(sourceUrl).includes("#") ? "&" : "#";
        return `${sourceUrl}${separator}${PDF_NATIVE_BYPASS_PARAM}=1`;
    }
}

function closePdfReader({ locationRef = window.location, historyRef = window.history, windowRef = window } = {}) {
    const originalPdfUrl = getOriginalPdfUrl(locationRef);
    if (originalPdfUrl) {
        locationRef.href = buildNativePdfUrl(originalPdfUrl);
        return "open-original";
    }

    if (historyRef && historyRef.length > 1 && typeof historyRef.back === "function") {
        historyRef.back();
        return "history-back";
    }

    if (windowRef && typeof windowRef.close === "function") {
        windowRef.close();
        return "window-close";
    }

    return "noop";
}

function bindClosePdfReaderButton(documentRef = document) {
    const button = documentRef.getElementById("edgeTranslateClosePdfReaderButton");
    if (!button) return false;
    button.addEventListener("click", () => closePdfReader());
    return true;
}

function createPdfPageTranslateEvent(windowRef = window) {
    if (typeof windowRef.CustomEvent === "function") {
        return new windowRef.CustomEvent(PDF_PAGE_TRANSLATE_EVENT, {
            bubbles: true,
            detail: { source: "pdf-viewer-toolbar" },
        });
    }

    const documentRef = windowRef.document;
    const event = documentRef.createEvent("CustomEvent");
    event.initCustomEvent(PDF_PAGE_TRANSLATE_EVENT, true, false, {
        source: "pdf-viewer-toolbar",
    });
    return event;
}

function requestPdfPageTranslation({ windowRef = window } = {}) {
    if (!windowRef || typeof windowRef.dispatchEvent !== "function") return false;
    windowRef.dispatchEvent(createPdfPageTranslateEvent(windowRef));
    return true;
}

function bindPdfPageTranslateButton(documentRef = document, windowRef = window) {
    const button = documentRef.getElementById("edgeTranslatePdfPageTranslateButton");
    if (!button) return false;
    button.addEventListener("click", () => requestPdfPageTranslation({ windowRef }));
    return true;
}

function bindPdfViewerControls(documentRef = document, windowRef = window) {
    const closeBound = bindClosePdfReaderButton(documentRef);
    const translateBound = bindPdfPageTranslateButton(documentRef, windowRef);
    return closeBound || translateBound;
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => bindPdfViewerControls());
    } else {
        bindPdfViewerControls();
    }
}

export {
    PDF_NATIVE_BYPASS_PARAM,
    PDF_PAGE_TRANSLATE_EVENT,
    getOriginalPdfUrl,
    buildNativePdfUrl,
    closePdfReader,
    bindClosePdfReaderButton,
    requestPdfPageTranslation,
    bindPdfPageTranslateButton,
    bindPdfViewerControls,
};
