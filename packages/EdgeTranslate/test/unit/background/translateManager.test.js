import { TranslatorManager } from "../../../src/background/library/translate.js";

describe("TranslatorManager fast tab resolution", () => {
    test("uses sender.tab.id without querying the active tab", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getCurrentTabId = jest.fn(async () => 99);

        await expect(manager.resolveTargetTabId({ tab: { id: 42 } })).resolves.toBe(42);
        expect(manager.getCurrentTabId).not.toHaveBeenCalled();
    });

    test("falls back to active tab lookup when sender tab is unavailable", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getCurrentTabId = jest.fn(async () => 99);

        await expect(manager.resolveTargetTabId({})).resolves.toBe(99);
        expect(manager.getCurrentTabId).toHaveBeenCalledTimes(1);
    });
});

describe("TranslatorManager on-device bridge injection", () => {
    const originalChrome = global.chrome;

    afterEach(() => {
        global.chrome = originalChrome;
        jest.restoreAllMocks();
    });

    test("injects the bridge into the sender frame main world", async () => {
        const executeScript = jest.fn().mockResolvedValue([{ result: undefined }]);
        global.chrome = { scripting: { executeScript } };
        const manager = Object.create(TranslatorManager.prototype);

        await expect(
            manager.injectOnDeviceBridge({ tab: { id: 42 }, frameId: 7 })
        ).resolves.toEqual({ injected: true });

        expect(executeScript).toHaveBeenCalledWith({
            target: { tabId: 42, frameIds: [7] },
            files: ["chrome_builtin/on_device_bridge.js"],
            world: "MAIN",
            injectImmediately: true,
        });
    });

    test("rejects bridge injection without a sender tab", async () => {
        global.chrome = { scripting: { executeScript: jest.fn() } };
        const manager = Object.create(TranslatorManager.prototype);

        await expect(manager.injectOnDeviceBridge({})).rejects.toThrow(
            "Cannot inject Chrome on-device bridge without a sender tab."
        );
    });
});
