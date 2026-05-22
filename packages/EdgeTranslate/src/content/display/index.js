/** @jsx h */
import { h, render } from "preact";
import Panel from "./Panel.jsx";
import { wrapConsoleForFiltering, shouldFilterError } from "common/scripts/logger.js";

wrapConsoleForFiltering();

// 전역 오류 핸들러 추가
window.addEventListener("error", (event) => {
    if (event.error && event.error.message && shouldFilterError(event.error.message)) {
        event.preventDefault();
        return false;
    }
});

window.addEventListener("unhandledrejection", (event) => {
    if (event.reason) {
        const message =
            typeof event.reason === "string" ? event.reason : event.reason.message || "";
        if (shouldFilterError(message)) {
            event.preventDefault();
            return false;
        }
    }
});

(async function initialize() {
    try {
        render(<Panel />, document.documentElement);
        // Prepare this polyfill for the useMeasure hook of "react-use".
        if (!window.ResizeObserver) {
            window.ResizeObserver = (await import("resize-observer-polyfill")).default;
        }
    } catch (error) {
        console.error("[EdgeTranslate] 초기화 오류:", error);
    }
})();
