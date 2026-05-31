import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";

function mockStorageGet(value) {
    chrome.storage.sync.get = jest.fn((settings, callback) => {
        callback({ ...value });
    });
}

function mockStorageSet() {
    chrome.storage.sync.set = jest.fn((value, callback) => {
        if (typeof callback === "function") {
            callback();
        }
    });
}

describe("settings storage defaults", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockStorageSet();
    });

    it("preserves stored falsy primitive values", async () => {
        const defaults = {
            EnableFeature: true,
            RetryCount: 3,
            Label: "default",
        };
        mockStorageGet({
            EnableFeature: false,
            RetryCount: 0,
            Label: "",
        });

        const result = await getOrSetDefaultSettings(
            ["EnableFeature", "RetryCount", "Label"],
            defaults
        );

        expect(result).toEqual({
            EnableFeature: false,
            RetryCount: 0,
            Label: "",
        });
        expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it("does not share object and array defaults with returned settings", async () => {
        const defaults = {
            ObjectSetting: {
                enabled: true,
                nested: { count: 1 },
            },
            OrderedItems: ["first", "second"],
        };
        mockStorageGet({});

        const result = await getOrSetDefaultSettings(["ObjectSetting", "OrderedItems"], defaults);
        result.ObjectSetting.nested.count = 99;
        result.OrderedItems.push("third");

        expect(defaults.ObjectSetting.nested.count).toBe(1);
        expect(defaults.OrderedItems).toEqual(["first", "second"]);
    });

    it("fills missing nested defaults for existing object settings", async () => {
        const defaults = {
            OtherSettings: {
                SelectTranslate: true,
                RealtimeCaptionTranslate: false,
            },
        };
        mockStorageGet({
            OtherSettings: {
                SelectTranslate: false,
            },
        });

        const result = await getOrSetDefaultSettings("OtherSettings", defaults);

        expect(result.OtherSettings).toEqual({
            SelectTranslate: false,
            RealtimeCaptionTranslate: false,
        });
        expect(chrome.storage.sync.set).toHaveBeenCalledWith(result, expect.any(Function));
    });

    it("repairs invalid stored shapes for object and array settings", async () => {
        const defaults = {
            ObjectSetting: {
                enabled: true,
            },
            OrderedItems: ["first", "second"],
        };
        mockStorageGet({
            ObjectSetting: "corrupt",
            OrderedItems: "corrupt",
        });

        const result = await getOrSetDefaultSettings(["ObjectSetting", "OrderedItems"], defaults);

        expect(result).toEqual(defaults);
        expect(result).not.toBe(defaults);
        expect(result.ObjectSetting).not.toBe(defaults.ObjectSetting);
        expect(result.OrderedItems).not.toBe(defaults.OrderedItems);
        expect(chrome.storage.sync.set).toHaveBeenCalledWith(result, expect.any(Function));
    });

    it("keeps first-run option defaults intentional and low-friction", () => {
        expect(DEFAULT_SETTINGS.OtherSettings).toMatchObject({
            SelectTranslate: true,
            TranslateAfterSelect: false,
            TranslateAfterDblClick: true,
            RealtimeCaptionTranslate: false,
            CancelTextSelection: true,
            EnableBuiltinPdfViewer: true,
        });
        expect(DEFAULT_SETTINGS.TranslateResultFilter).toMatchObject({
            mainMeaning: true,
            originalText: false,
            tPronunciationIcon: true,
            sPronunciationIcon: false,
            detailedMeanings: true,
            definitions: true,
            examples: false,
        });
        expect(DEFAULT_SETTINGS.LocalTranslatorConfig.enabled).toBe(false);
        expect(DEFAULT_SETTINGS.PreciseTranslatorConfig.enabled).toBe(false);
        expect(DEFAULT_SETTINGS.RealtimeCaptionConfig.translatorMode).toBe("google");
        expect(DEFAULT_SETTINGS.HidePageTranslatorBanner).toBe(false);
    });
});
