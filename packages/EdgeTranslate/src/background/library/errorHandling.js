import {
    wrapConsoleForFiltering,
    shouldFilterError,
    addErrorFilterPatterns,
    addErrorFilterRegexes,
} from "common/scripts/logger.js";

const DEFAULT_ERROR_PATTERNS = [
    "Unable to download",
    "Unable to download all specified images",
    "Image loading failed",
    "Cannot access",
    "before initialization",
    "Extension context invalidated",
    "Canvas error",
    "Network error",
];

const DEFAULT_ERROR_REGEXES = [
    /Cannot access '.*' before initialization/i,
    /ReferenceError.*before initialization/i,
    /Unable to download.*images/i,
];

function extractMessage(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object" && typeof value.message === "string") {
        return value.message;
    }
    try {
        return String(value);
    } catch (_) {
        return "[Unserializable Error Object]";
    }
}

function registerWindowHandlers(logWarn) {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
        return () => {};
    }

    const handleError = (event) => {
        try {
            const message = extractMessage(event?.error);
            if (shouldFilterError(message)) {
                try {
                    event.preventDefault?.();
                } catch (_) {
                    // ignore preventDefault failures
                }
                return false;
            }
        } catch (_) {
            // ignore handler failures
        }
        return undefined;
    };

    const handleUnhandledRejection = (event) => {
        try {
            const message = extractMessage(event?.reason);
            if (shouldFilterError(message)) {
                logWarn?.("Filtered Promise rejection", message);
                try {
                    event.preventDefault?.();
                } catch (_) {
                    // ignore preventDefault failures
                }
                return false;
            }
        } catch (_) {
            // ignore handler failures
        }
        return undefined;
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
        try {
            window.removeEventListener("error", handleError);
            window.removeEventListener("unhandledrejection", handleUnhandledRejection);
        } catch (_) {
            // ignore teardown failures
        }
    };
}

function registerWorkerHandlers(logWarn) {
    if (typeof self === "undefined" || typeof self.addEventListener !== "function") {
        return () => {};
    }

    const handleError = (event) => {
        try {
            const message = extractMessage(event?.error);
            if (shouldFilterError(message)) {
                logWarn?.("Service Worker error filtered", message);
                try {
                    event.preventDefault?.();
                } catch (_) {
                    // ignore preventDefault failures
                }
                return false;
            }
        } catch (_) {
            // ignore handler failures
        }
        return undefined;
    };

    const handleUnhandledRejection = (event) => {
        try {
            const message = extractMessage(event?.reason);
            if (shouldFilterError(message)) {
                logWarn?.("Service Worker rejection filtered", message);
                try {
                    event.preventDefault?.();
                } catch (_) {
                    // ignore preventDefault failures
                }
                return false;
            }
        } catch (_) {
            // ignore handler failures
        }
        return undefined;
    };

    self.addEventListener("error", handleError);
    self.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
        try {
            self.removeEventListener("error", handleError);
            self.removeEventListener("unhandledrejection", handleUnhandledRejection);
        } catch (_) {
            // ignore teardown failures
        }
    };
}

export function initializeBackgroundErrorHandling({ logWarn } = {}) {
    addErrorFilterPatterns(DEFAULT_ERROR_PATTERNS);
    addErrorFilterRegexes(DEFAULT_ERROR_REGEXES);
    wrapConsoleForFiltering();

    const disposeWindow = registerWindowHandlers(logWarn);
    const disposeWorker = registerWorkerHandlers(logWarn);

    return {
        shouldFilterError,
        dispose() {
            disposeWindow();
            disposeWorker();
        },
    };
}
