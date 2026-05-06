const PDF_NATIVE_BYPASS_PARAM = "edge_translate_pdf_native";

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

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => bindClosePdfReaderButton());
    } else {
        bindClosePdfReaderButton();
    }
}

export {
    PDF_NATIVE_BYPASS_PARAM,
    getOriginalPdfUrl,
    buildNativePdfUrl,
    closePdfReader,
    bindClosePdfReaderButton,
};
