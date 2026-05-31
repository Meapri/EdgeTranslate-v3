import { BROWSER_LANGUAGES_MAP } from "common/scripts/languages.js";

/**
 * default settings for this extension
 */
const DEFAULT_SETTINGS = {
    blacklist: {
        urls: {},
        domains: { "chrome.google.com": true, extensions: true },
    },
    // Resize: determine whether the web page will resize when showing translation result
    // RTL: determine whether the text in translation block should display from right to left
    // FoldLongContent: determine whether to fold long translation content
    // SelectTranslatePosition: the position of select translate button.
    LayoutSettings: {
        Resize: false,
        RTL: false,
        FoldLongContent: true,
        SelectTranslatePosition: "TopRight",
    },
    // Default settings of source language and target language
    languageSetting: { sl: "auto", tl: BROWSER_LANGUAGES_MAP[chrome.i18n.getUILanguage()] },
    OtherSettings: {
        MutualTranslate: false,
        SelectTranslate: true,
        TranslateAfterDblClick: true,
        TranslateAfterSelect: false,
        RealtimeCaptionTranslate: false,
        CancelTextSelection: true,
        UseGoogleAnalytics: false,
        // When true (default), PDF links open in the bundled pdf.js viewer; when false,
        // the browser's native PDF handler is used.
        EnableBuiltinPdfViewer: true,
    },
    DefaultTranslator: "GoogleTranslate",
    DefaultPageTranslator: "GooglePageTranslate",
    LocalTranslatorConfig: {
        enabled: false,
        mode: "chromeBuiltin",
        apiKey: "",
        model: "gemini-2.5-flash-lite",
        openaiApiKey: "",
        openaiModel: "gpt-5.4-mini",
        openaiCompatibleBaseUrl: "",
        openaiCompatibleApiKey: "",
        openaiCompatibleModel: "gpt-oss-20b",
        timeoutMs: 120000,
    },
    PreciseTranslatorConfig: {
        enabled: false,
        mode: "openai",
        model: "gemini-3-pro-preview",
        openaiModel: "gpt-5.5",
        openaiCompatibleModel: "gpt-oss-20b",
        timeoutMs: 120000,
    },
    RealtimeCaptionConfig: {
        translatorMode: "google",
        draggableOverlay: true,
    },
    HybridTranslatorConfig: {
        // The translators used in current hybrid translate.
        translators: ["BingTranslate", "GoogleTranslate"],

        // The translators for each item.
        selections: {
            // ATTENTION: The following two items MUST HAVE THE SAME TRANSLATOR!
            originalText: "GoogleTranslate",
            mainMeaning: "GoogleTranslate",

            // For the following three items, any translator combination is OK.
            detailedMeanings: "BingTranslate",
            definitions: "GoogleTranslate",
            examples: "GoogleTranslate",
        },
    },
    // Defines which contents in the translating result should be displayed.
    TranslateResultFilter: {
        mainMeaning: true,
        originalText: false,
        tPronunciationIcon: true,
        sPronunciationIcon: false,
        detailedMeanings: true,
        definitions: true,
        examples: false,
    },
    // Defines the order of displaying contents.
    ContentDisplayOrder: [
        "mainMeaning",
        "originalText",
        "detailedMeanings",
        "definitions",
        "examples",
    ],
    HidePageTranslatorBanner: false,
};

function isPlainSettingsObject(value) {
    return Boolean(value) && typeof value === "object" && !(value instanceof Array);
}

function isSettingsArray(value) {
    return value instanceof Array;
}

function cloneDefaultValue(value) {
    if (isSettingsArray(value)) {
        return value.map((item) => cloneDefaultValue(item));
    }

    if (isPlainSettingsObject(value)) {
        const cloned = {};
        for (let key in value) {
            cloned[key] = cloneDefaultValue(value[key]);
        }
        return cloned;
    }

    return value;
}

function resolveDefaultSettings(settings, defaults) {
    return typeof defaults === "function" ? defaults(settings) : defaults;
}

function normalizeRequestedSettings(settings, defaults) {
    if (typeof settings === "string") {
        return [settings];
    }

    if (settings === undefined) {
        return Object.keys(resolveDefaultSettings([], defaults));
    }

    return settings;
}

function hasStoredSetting(result, setting, defaults) {
    if (!Object.prototype.hasOwnProperty.call(result, setting) || result[setting] === undefined) {
        return false;
    }

    const defaultValue = defaults[setting];
    if (isPlainSettingsObject(defaultValue)) {
        return isPlainSettingsObject(result[setting]);
    }
    if (isSettingsArray(defaultValue)) {
        return isSettingsArray(result[setting]);
    }

    return true;
}

/**
 * assign default value to settings which are undefined in recursive way
 * @param {*} result setting result stored in chrome.storage
 * @param {*} settings default settings
 */
function setDefaultSettings(result, settings) {
    for (let i in settings) {
        // settings[i] contains key-value settings
        if (isPlainSettingsObject(settings[i]) && Object.keys(settings[i]).length > 0) {
            if (isPlainSettingsObject(result[i])) {
                setDefaultSettings(result[i], settings[i]);
            } else {
                // settings[i] contains several setting items but these have not been set before
                result[i] = cloneDefaultValue(settings[i]);
            }
        } else if (isSettingsArray(settings[i])) {
            if (!isSettingsArray(result[i])) {
                result[i] = cloneDefaultValue(settings[i]);
            }
        } else if (result[i] === undefined) {
            // settings[i] is a single setting item and it has not been set before
            result[i] = cloneDefaultValue(settings[i]);
        }
    }
}

/**
 * Get settings from storage. If some of the settings have not been initialized,
 * initialize them with the given default values.
 *
 * @param {String | Array<String>} settings setting name to get
 * @param {Object | Function} defaults default values or function to generate default values
 * @returns {Promise<Any>} settings
 */
function getOrSetDefaultSettings(settings, defaults) {
    return new Promise((resolve) => {
        const requestedSettings = normalizeRequestedSettings(settings, defaults);
        const defaultSettings = resolveDefaultSettings(requestedSettings, defaults);

        chrome.storage.sync.get(requestedSettings, (result) => {
            let updated = false;

            for (let setting of requestedSettings) {
                if (!hasStoredSetting(result, setting, defaultSettings)) {
                    result[setting] = cloneDefaultValue(defaultSettings[setting]);
                    updated = true;
                } else if (isPlainSettingsObject(defaultSettings[setting])) {
                    const before = JSON.stringify(result[setting]);
                    setDefaultSettings(result[setting], defaultSettings[setting]);
                    updated = updated || before !== JSON.stringify(result[setting]);
                }
            }

            if (updated) {
                chrome.storage.sync.set(result, () => resolve(result));
            } else {
                resolve(result);
            }
        });
    });
}

export { DEFAULT_SETTINGS, setDefaultSettings, getOrSetDefaultSettings };
