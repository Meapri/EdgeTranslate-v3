import { TranslatorManager } from "../../../src/background/library/translate.js";

describe("TranslatorManager fast tab resolution", () => {
    test("uses sender.tab.id without querying the active tab", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getCurrentTabId = jest.fn(async () => 99);

        await expect(
            manager.resolveTargetTabId({ tab: { id: 42 } })
        ).resolves.toBe(42);
        expect(manager.getCurrentTabId).not.toHaveBeenCalled();
    });

    test("falls back to active tab lookup when sender tab is unavailable", async () => {
        const manager = Object.create(TranslatorManager.prototype);
        manager.getCurrentTabId = jest.fn(async () => 99);

        await expect(manager.resolveTargetTabId({})).resolves.toBe(99);
        expect(manager.getCurrentTabId).toHaveBeenCalledTimes(1);
    });
});
