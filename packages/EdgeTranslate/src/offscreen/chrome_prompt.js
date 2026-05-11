import {
    translateWithChromeOnDevice,
    warmupChromeOnDevice,
} from "common/scripts/chrome_builtin_translate.js";

function parseMessage(message) {
    if (typeof message === "string") {
        try {
            return JSON.parse(message);
        } catch {
            return null;
        }
    }
    return message || null;
}

function serializeError(error) {
    return {
        name: error?.name || "Error",
        message: error?.message || String(error || "Chrome Gemini Nano request failed."),
        stack: error?.stack,
    };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const parsed = parseMessage(message);
    if (!parsed) return undefined;

    if (parsed.type === "chrome_prompt_warmup") {
        warmupChromeOnDevice(parsed.from, parsed.to).then(
            (result) => sendResponse({ ok: true, result }),
            (error) => sendResponse({ ok: false, error: serializeError(error) })
        );
        return true;
    }

    if (parsed.type !== "chrome_prompt_translate") return undefined;

    translateWithChromeOnDevice(parsed.text, parsed.from, parsed.to, {
        onUpdate(result) {
            if (!parsed.streamId) return;
            chrome.runtime.sendMessage(
                JSON.stringify({
                    type: "event",
                    event: "chrome_prompt_stream",
                    detail: {
                        streamId: parsed.streamId,
                        result,
                    },
                })
            );
        },
    }).then(
        (result) => sendResponse({ ok: true, result }),
        (error) => sendResponse({ ok: false, error: serializeError(error) })
    );
    return true;
});
