import Channel from "common/scripts/channel.js";

let runtimeMessageListeners;

function latestRuntimeMessageListener() {
    return runtimeMessageListeners[runtimeMessageListeners.length - 1];
}

describe("Channel runtime message hardening", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        runtimeMessageListeners = [];
        chrome.runtime.onMessage.addListener = jest.fn((listener) => {
            runtimeMessageListeners.push(listener);
        });
    });

    it("ignores malformed runtime messages instead of throwing", () => {
        new Channel();
        const listener = latestRuntimeMessageListener();
        const callback = jest.fn();

        expect(() => listener("not-json", {}, callback)).not.toThrow();
        expect(() => listener(null, {}, callback)).not.toThrow();
        expect(() => listener(42, {}, callback)).not.toThrow();
        expect(callback).not.toHaveBeenCalled();
    });

    it("accepts already-parsed channel event messages", () => {
        const channel = new Channel();
        const listener = latestRuntimeMessageListener();
        const handler = jest.fn();
        const sender = { tab: { id: 7 } };
        channel.on("stable_event", handler);

        listener({ type: "event", event: "stable_event", detail: { ok: true } }, sender, jest.fn());

        expect(handler).toHaveBeenCalledWith({ ok: true }, sender);
    });

    it("returns service errors for synchronous service exceptions", async () => {
        const channel = new Channel();
        const listener = latestRuntimeMessageListener();
        const callback = jest.fn();
        channel.provide("explode", () => {
            throw new Error("boom");
        });

        const keepAlive = listener(
            JSON.stringify({ type: "service", service: "explode", params: { value: 1 } }),
            {},
            callback
        );
        await Promise.resolve();
        await Promise.resolve();

        expect(keepAlive).toBe(true);
        expect(callback).toHaveBeenCalledWith({
            __edgeTranslateError: true,
            message: "boom",
        });
    });
});
