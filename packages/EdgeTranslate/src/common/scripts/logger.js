export {
    logInfo,
    logWarn,
    logError,
    shouldFilterError,
    wrapConsoleForFiltering,
    setLogLevel,
    getLogLevel,
    addErrorFilterPatterns,
    addErrorFilterRegexes,
};

// Known noisy error patterns to suppress in logs
const FILTERED_ERROR_PATTERNS = new Set([
    "Unable to download",
    "Unable to download all specified images",
    "Image loading failed",
    "Cannot access",
    "before initialization",
    "Extension context invalidated",
    "Canvas error",
    "Network error",
]);

const FILTERED_ERROR_REGEXES = [
    /Cannot access '.*' before initialization/i,
    /ReferenceError.*before initialization/i,
    /Unable to download.*images/i,
];

function joinMessage(args) {
    try {
        return args
            .map((v) => {
                if (typeof v === "string") return v;
                if (v && v.message) return v.message;
                try {
                    return JSON.stringify(v);
                } catch (stringifyError) {
                    // Handle circular references and other stringify errors
                    try {
                        return Object.prototype.toString.call(v);
                    } catch (fallbackError) {
                        return "[Unknown Object]";
                    }
                }
            })
            .join(" ")
            .trim();
    } catch (_) {
        // Fallback to safe string conversion
        return args
            .map((arg) => {
                try {
                    return String(arg);
                } catch (error) {
                    return "[Unserializable Object]";
                }
            })
            .join(" ")
            .trim();
    }
}

function shouldFilterError(message) {
    if (!message) return false;
    let text = "";
    try {
        text = typeof message === "string" ? message : message?.message || String(message);
    } catch (_) {
        text = "";
    }

    try {
        return (
            Array.from(FILTERED_ERROR_PATTERNS).some(
                (pattern) => text && typeof text === "string" && text.includes(pattern)
            ) ||
            FILTERED_ERROR_REGEXES.some((regex) => {
                try {
                    return regex.test(text);
                } catch (_) {
                    return false;
                }
            })
        );
    } catch (_) {
        return false;
    }
}

function addErrorFilterPatterns(patterns) {
    if (!patterns) return;
    const list = Array.isArray(patterns) ? patterns : [patterns];
    for (const pattern of list) {
        if (typeof pattern === "string" && pattern.trim()) {
            FILTERED_ERROR_PATTERNS.add(pattern);
        }
    }
}

function addErrorFilterRegexes(regexes) {
    if (!regexes) return;
    const list = Array.isArray(regexes) ? regexes : [regexes];
    for (const regex of list) {
        if (regex instanceof RegExp) {
            FILTERED_ERROR_REGEXES.push(regex);
        }
    }
}

// Log level: 'debug' | 'info' | 'warn' | 'error' | 'silent'
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 90 };
let currentLevel =
    typeof BUILD_ENV !== "undefined" && BUILD_ENV === "development" ? "debug" : "warn";

function setLogLevel(level) {
    if (LEVEL_ORDER[level] != null) currentLevel = level;
}

function getLogLevel() {
    return currentLevel;
}

function shouldEmit(level) {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function logInfo(...args) {
    if (!shouldEmit("info")) return;
    // eslint-disable-next-line no-console
    console.log("[EdgeTranslate]", ...args);
}

function logWarn(...args) {
    if (!shouldEmit("warn")) return;
    // eslint-disable-next-line no-console
    console.warn("[EdgeTranslate]", ...args);
}

function logError(...args) {
    if (!shouldEmit("error")) return;
    const message = joinMessage(args);
    if (shouldFilterError(message)) return;
    // eslint-disable-next-line no-console
    console.error("[EdgeTranslate]", ...args);
}

// Optional: globally wrap console.error to suppress noisy errors
function wrapConsoleForFiltering() {
    const originalConsoleError = console.error;
    // eslint-disable-next-line no-console
    console.error = function (...args) {
        const message = joinMessage(args);
        if (!shouldFilterError(message)) {
            originalConsoleError.apply(console, args);
        }
    };
}
