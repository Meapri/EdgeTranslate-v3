import Channel from "common/scripts/channel.js";
import { i18nHTML } from "common/scripts/common.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";

/**
 * Communication channel.
 */
const channel = new Channel();
const DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL = "gemini-2.5-flash-lite";
const GOOGLE_AI_STUDIO_TRANSLATION_MODELS = new Set([
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    "gemma-4-31b-it",
    "gemma-4-26b-a4b-it",
]);
const GOOGLE_AI_STUDIO_REASONING_LEVELS = new Set([
    "auto",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
]);
const OPENAI_REASONING_EFFORTS = new Set([
    "auto",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
]);
const DEFAULT_OPENAI_TRANSLATION_MODEL = "gpt-5.4-mini";
const OPENAI_TRANSLATION_MODELS = new Set([
    "gpt-5.5",
    "gpt-5.5-2026-04-23",
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-mini",
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.4-nano",
    "gpt-5.4-nano-2026-03-17",
    "gpt-5.3-chat-latest",
    "gpt-5.2",
    "gpt-5.2-2025-12-11",
    "gpt-5.2-chat-latest",
    "gpt-5.1",
    "gpt-5.1-2025-11-13",
    "gpt-5.1-chat-latest",
    "gpt-5",
    "gpt-5-2025-08-07",
    "gpt-5-mini",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano",
    "gpt-5-nano-2025-08-07",
    "gpt-5-chat-latest",
    "gpt-4.1",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini",
    "gpt-4.1-mini-2025-04-14",
    "gpt-4.1-nano",
    "gpt-4.1-nano-2025-04-14",
    "gpt-4o",
    "gpt-4o-2024-11-20",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-05-13",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
    "gpt-4-turbo",
    "gpt-4-turbo-2024-04-09",
    "gpt-4",
    "gpt-4-0613",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-16k",
    "o1",
    "o1-2024-12-17",
    "o3",
    "o3-2025-04-16",
    "o3-mini",
    "o3-mini-2025-01-31",
    "o4-mini",
    "o4-mini-2025-04-16",
]);
const LOCAL_TRANSLATOR_TIMEOUT_MS_OPTIONS = new Set([
    "30000",
    "60000",
    "120000",
    "180000",
    "300000",
]);
const DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL = "auto";
const DEFAULT_OPENAI_REASONING_EFFORT = "auto";
const DEFAULT_LOCAL_TRANSLATOR_TIMEOUT_MS = "120000";

const GOOGLE_REASONING_OPTION_LABELS = {
    auto: "Auto",
    none: "None (thinkingBudget 0)",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
};

const OPENAI_REASONING_OPTION_LABELS = {
    auto: "Auto",
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
};

function stripPronunciationDisplaySelections(config = {}) {
    const selections = { ...(config.selections || {}) };
    delete selections.tPronunciation;
    delete selections.sPronunciation;
    return {
        ...config,
        selections,
    };
}

/**
 * 初始化设置列表
 */
window.onload = () => {
    i18nHTML();
    populatePreciseTranslatorModelSelects();

    // 设置不同语言的隐私政策链接（요소가 있으면 설정）
    const PrivacyPolicyLink = document.getElementById("PrivacyPolicyLink");
    if (PrivacyPolicyLink) {
        PrivacyPolicyLink.setAttribute("href", chrome.i18n.getMessage("PrivacyPolicyLink"));
    }

    /**
     * Set up hybrid translate config.
     */
    getOrSetDefaultSettings(["languageSetting", "HybridTranslatorConfig"], DEFAULT_SETTINGS).then(
        async (result) => {
            let config = stripPronunciationDisplaySelections(result.HybridTranslatorConfig);
            let languageSetting = result.languageSetting;
            let availableTranslators = await channel.request("get_available_translators", {
                from: languageSetting.sl,
                to: languageSetting.tl,
            });
            setUpTranslateConfig(
                config,
                // Remove the hybrid translator at the beginning of the availableTranslators array.
                availableTranslators.slice(1)
            );
        }
    );

    /**
     * Update translator config options on translator config update.
     */
    channel.on("hybrid_translator_config_updated", (detail) =>
        setUpTranslateConfig(
            stripPronunciationDisplaySelections(detail.config),
            detail.availableTranslators
        )
    );

    /**
     * initiate and update settings
     * attribute "setting-type": indicate the setting type of one option
     * attribute "setting-path": indicate the nested setting path. used to locate the path of one setting item in chrome storage
     */
    getOrSetDefaultSettings(undefined, DEFAULT_SETTINGS).then((result) => {
        let inputElements = document.querySelectorAll("input[setting-path], select[setting-path]");
        for (let element of [...inputElements]) {
            let settingItemPath = element.getAttribute("setting-path").split(/\s/g);
            let settingItemValue = getSetting(result, settingItemPath);
            if (settingItemValue === undefined) {
                settingItemValue = getSetting(DEFAULT_SETTINGS, settingItemPath);
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig mode" &&
                (settingItemValue === "geminiNano" || settingItemValue === "endpoint")
            ) {
                settingItemValue = "chromeBuiltin";
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig model" &&
                !GOOGLE_AI_STUDIO_TRANSLATION_MODELS.has(settingItemValue)
            ) {
                settingItemValue = DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig reasoningLevel" &&
                !GOOGLE_AI_STUDIO_REASONING_LEVELS.has(settingItemValue)
            ) {
                settingItemValue = DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig openaiReasoningEffort" &&
                !OPENAI_REASONING_EFFORTS.has(settingItemValue)
            ) {
                settingItemValue = DEFAULT_OPENAI_REASONING_EFFORT;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig openaiModel" &&
                !OPENAI_TRANSLATION_MODELS.has(settingItemValue)
            ) {
                settingItemValue = DEFAULT_OPENAI_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "PreciseTranslatorConfig model" &&
                !GOOGLE_AI_STUDIO_TRANSLATION_MODELS.has(settingItemValue)
            ) {
                settingItemValue =
                    DEFAULT_SETTINGS.PreciseTranslatorConfig?.model ||
                    DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "PreciseTranslatorConfig reasoningLevel" &&
                !GOOGLE_AI_STUDIO_REASONING_LEVELS.has(settingItemValue)
            ) {
                settingItemValue =
                    DEFAULT_SETTINGS.PreciseTranslatorConfig?.reasoningLevel ||
                    DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "PreciseTranslatorConfig openaiModel" &&
                !OPENAI_TRANSLATION_MODELS.has(settingItemValue)
            ) {
                settingItemValue =
                    DEFAULT_SETTINGS.PreciseTranslatorConfig?.openaiModel ||
                    DEFAULT_OPENAI_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "PreciseTranslatorConfig openaiReasoningEffort" &&
                !OPENAI_REASONING_EFFORTS.has(settingItemValue)
            ) {
                settingItemValue =
                    DEFAULT_SETTINGS.PreciseTranslatorConfig?.openaiReasoningEffort ||
                    DEFAULT_OPENAI_REASONING_EFFORT;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig timeoutMs" &&
                !LOCAL_TRANSLATOR_TIMEOUT_MS_OPTIONS.has(String(settingItemValue))
            ) {
                settingItemValue = DEFAULT_LOCAL_TRANSLATOR_TIMEOUT_MS;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "DefaultPageTranslator" &&
                (settingItemValue === "GeminiNanoPageTranslate" ||
                    settingItemValue === "LocalPageTranslate" ||
                    settingItemValue === "ChromeBuiltinPageTranslate" ||
                    settingItemValue === "DomPageTranslate")
            ) {
                const localConfig = result.LocalTranslatorConfig || {};
                const isAiMode =
                    localConfig.mode === "googleAiStudio" || localConfig.mode === "openai";
                settingItemValue =
                    localConfig.enabled && isAiMode ? "AIPageTranslate" : "GooglePageTranslate";
                saveOption(result, settingItemPath, settingItemValue);
            }
            // If AIPageTranslate was selected but AI is no longer available, reset
            if (
                settingItemPath.join(" ") === "DefaultPageTranslator" &&
                settingItemValue === "AIPageTranslate"
            ) {
                const localConfig = result.LocalTranslatorConfig || {};
                const isAiMode =
                    localConfig.mode === "googleAiStudio" || localConfig.mode === "openai";
                if (!localConfig.enabled || !isAiMode) {
                    settingItemValue = "GooglePageTranslate";
                    saveOption(result, settingItemPath, settingItemValue);
                }
            }

            switch (element.getAttribute("setting-type")) {
                case "checkbox":
                    if (!Array.isArray(settingItemValue)) settingItemValue = [];
                    element.checked = settingItemValue.indexOf(element.value) !== -1;
                    // update setting value
                    element.onchange = (event) => {
                        const target = event.target;
                        const settingItemPath = target.getAttribute("setting-path").split(/\s/g);
                        let settingItemValue = getSetting(result, settingItemPath);
                        if (!Array.isArray(settingItemValue)) settingItemValue = [];

                        // if user checked this option, add value to setting array
                        if (target.checked) settingItemValue.push(target.value);
                        // if user unchecked this option, delete value from setting array
                        else settingItemValue.splice(settingItemValue.indexOf(target.value), 1);
                        saveOption(result, settingItemPath, settingItemValue);
                    };
                    break;
                case "radio":
                    element.checked = settingItemValue === element.value;
                    // update setting value
                    element.onchange = (event) => {
                        const target = event.target;
                        const settingItemPath = target.getAttribute("setting-path").split(/\s/g);
                        if (target.checked) {
                            saveOption(result, settingItemPath, target.value);
                        }
                    };
                    break;
                case "switch":
                    element.checked = settingItemValue;
                    // update setting value
                    element.onchange = (event) => {
                        const settingItemPath = event.target
                            .getAttribute("setting-path")
                            .split(/\s/g);
                        saveOption(result, settingItemPath, event.target.checked);
                    };
                    break;
                case "select":
                    element.value = settingItemValue;
                    // update setting value
                    element.onchange = (event) => {
                        const target = event.target;
                        const settingItemPath = target.getAttribute("setting-path").split(/\s/g);
                        saveOption(
                            result,
                            settingItemPath,
                            target.options[target.selectedIndex].value
                        );
                        if (target.id === "local-translator-mode") {
                            syncLocalTranslatorFields(target.value);
                            syncAiPageTranslatorVisibility(result);
                        }
                        if (target.id === "precise-translator-mode") {
                            syncPreciseTranslatorFields(target.value);
                        }
                        if (target.id === "local-translator-model") {
                            syncGoogleReasoningLevelOptions(result);
                        }
                        if (target.id === "local-translator-openai-model") {
                            syncOpenAiReasoningEffortOptions(result);
                        }
                        if (target.id === "precise-translator-model") {
                            syncPreciseGoogleReasoningLevelOptions(result);
                        }
                        if (target.id === "precise-translator-openai-model") {
                            syncPreciseOpenAiReasoningEffortOptions(result);
                        }
                    };
                    break;
                case "text":
                    element.value = settingItemValue || "";
                    element.onchange = (event) => {
                        const target = event.target;
                        const settingItemPath = target.getAttribute("setting-path").split(/\s/g);
                        saveOption(result, settingItemPath, target.value.trim());
                    };
                    break;
                default:
                    break;
            }
        }
        syncLocalTranslatorFields(result.LocalTranslatorConfig?.mode || "chromeBuiltin");
        syncPreciseTranslatorFields(result.PreciseTranslatorConfig?.mode || "openai");
        syncGoogleReasoningLevelOptions(result);
        syncOpenAiReasoningEffortOptions(result);
        syncPreciseGoogleReasoningLevelOptions(result);
        syncPreciseOpenAiReasoningEffortOptions(result);
        syncAiPageTranslatorVisibility(result);

        // Update AI page translator visibility when local-translator-enabled changes
        const enabledCheckbox = document.getElementById("local-translator-enabled");
        if (enabledCheckbox) {
            const originalOnChange = enabledCheckbox.onchange;
            enabledCheckbox.onchange = (event) => {
                if (originalOnChange) originalOnChange(event);
                // Defer to let the setting value propagate
                setTimeout(() => syncAiPageTranslatorVisibility(result), 0);
            };
        }
    });
};

function populatePreciseTranslatorModelSelects() {
    const googleSelect = document.getElementById("precise-translator-model");
    const openAiSelect = document.getElementById("precise-translator-openai-model");
    if (googleSelect) {
        replaceSelectOptions(googleSelect, Array.from(GOOGLE_AI_STUDIO_TRANSLATION_MODELS), {});
    }
    if (openAiSelect) {
        replaceSelectOptions(openAiSelect, Array.from(OPENAI_TRANSLATION_MODELS), {});
    }
}

function syncLocalTranslatorFields(mode) {
    ["googleAiStudio", "openai"].forEach((localMode) => {
        const fields = document.querySelectorAll(`[data-local-mode='${localMode}']`);
        const row = document.getElementById(
            localMode === "googleAiStudio"
                ? "local-translator-google-settings"
                : "local-translator-openai-settings"
        );
        const hidden = mode !== localMode;
        if (row) row.hidden = hidden;
        fields.forEach((element) => {
            element.hidden = hidden;
        });
    });
}

function syncPreciseTranslatorFields(mode) {
    ["googleAiStudio", "openai"].forEach((localMode) => {
        const fields = document.querySelectorAll(`[data-precise-mode='${localMode}']`);
        const row = document.getElementById(
            localMode === "googleAiStudio"
                ? "precise-translator-google-settings"
                : "precise-translator-openai-settings"
        );
        const hidden = mode !== localMode;
        if (row) row.hidden = hidden;
        fields.forEach((element) => {
            element.hidden = hidden;
        });
    });
}

function isGeminiThinkingModel(model = "") {
    return /^gemini-(?:2\.5|3(?:\.|-)|flash-latest|flash-lite-latest|pro-latest)/i.test(model);
}

function isGemini3ProModel(model = "") {
    return /^gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:$|-)/i.test(model);
}

function isGemini3FlashModel(model = "") {
    return /^gemini-(?:3(?:\.\d+)?-flash|3(?:\.\d+)?-flash-lite|flash-latest|flash-lite-latest)(?:$|-)/i.test(
        model
    );
}

function isGemini25Model(model = "") {
    return /^gemini-2\.5/i.test(model);
}

function isGemini25ProModel(model = "") {
    return /^gemini-2\.5-pro(?:$|-)/i.test(model);
}

function isOpenAiReasoningModel(model = "") {
    return /^(?:gpt-5|o[1-9])/i.test(model) && !/chat-latest/i.test(model);
}

function isOpenAiGpt51Model(model = "") {
    return /^gpt-5\.1(?:$|-)/i.test(model);
}

function isOpenAiGpt52OrNewerModel(model = "") {
    return /^gpt-5\.(?:[2-9]|\d{2,})(?:$|-)/i.test(model);
}

function isOpenAiGpt5ProModel(model = "") {
    return /^gpt-5(?:\.\d+)?-pro(?:$|-)/i.test(model);
}

function isOpenAiCodexMaxModel(model = "") {
    return /^gpt-5\.1-codex-max(?:$|-)/i.test(model);
}

function replaceSelectOptions(select, values, labels) {
    const fragment = document.createDocumentFragment();
    values.forEach((value) => {
        fragment.appendChild(new Option(labels[value] || value, value));
    });
    select.replaceChildren(fragment);
}

function getGoogleReasoningValuesForModel(model = "") {
    if (isGemini3ProModel(model)) return ["auto", "low", "high"];
    if (isGemini3FlashModel(model)) return ["auto", "minimal", "low", "medium", "high"];
    if (isGemini25ProModel(model)) return ["auto", "minimal", "low", "medium", "high"];
    if (isGemini25Model(model)) return ["auto", "none", "minimal", "low", "medium", "high"];
    if (isGeminiThinkingModel(model)) return ["auto", "low", "high"];
    return ["auto"];
}

function getGoogleReasoningDefaultForModel(model = "") {
    if (isGemini3ProModel(model)) return "low";
    if (isGemini3FlashModel(model)) return "minimal";
    if (isGemini25Model(model)) return isGemini25ProModel(model) ? "low" : "none";
    return "auto";
}

function getGoogleReasoningLabelsForModel(model = "") {
    if (isGemini3Model(model)) {
        return {
            ...GOOGLE_REASONING_OPTION_LABELS,
            low: "Low (thinkingLevel)",
            minimal: "Minimal (thinkingLevel)",
            medium: "Medium (thinkingLevel)",
            high: "High (thinkingLevel)",
        };
    }
    if (isGemini25Model(model)) {
        return {
            ...GOOGLE_REASONING_OPTION_LABELS,
            minimal: "Minimal (thinkingBudget 1024)",
            low: "Low (thinkingBudget 1024)",
            medium: "Medium (thinkingBudget 8192)",
            high: "High (thinkingBudget 24576)",
        };
    }
    return GOOGLE_REASONING_OPTION_LABELS;
}

function isGemini3Model(model = "") {
    return /^gemini-(?:3(?:\.|-)|flash-latest|flash-lite-latest|pro-latest)/i.test(model);
}

function getOpenAiReasoningValuesForModel(model = "") {
    if (!isOpenAiReasoningModel(model)) return ["auto"];
    if (isOpenAiGpt5ProModel(model)) return ["auto", "high"];
    if (isOpenAiCodexMaxModel(model)) return ["auto", "none", "medium", "high", "xhigh"];
    if (isOpenAiGpt52OrNewerModel(model)) return ["auto", "none", "low", "medium", "high", "xhigh"];
    if (isOpenAiGpt51Model(model)) return ["auto", "none", "low", "medium", "high"];
    if (/^gpt-5/i.test(model)) return ["auto", "minimal", "low", "medium", "high"];
    return ["auto", "low", "medium", "high", "xhigh"];
}

function getOpenAiReasoningDefaultForModel(model = "") {
    if (!isOpenAiReasoningModel(model)) return "auto";
    if (isOpenAiGpt5ProModel(model)) return "high";
    if (isOpenAiGpt51Model(model) || isOpenAiGpt52OrNewerModel(model)) return "none";
    return "low";
}

function syncGoogleReasoningLevelOptions(localSettings) {
    const model =
        document.getElementById("local-translator-model")?.value ||
        localSettings.LocalTranslatorConfig?.model ||
        DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL;
    const select = document.getElementById("local-translator-reasoning-level");
    if (!select) return;

    const values = getGoogleReasoningValuesForModel(model);
    const currentValue =
        select.value ||
        localSettings.LocalTranslatorConfig?.reasoningLevel ||
        DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL;
    replaceSelectOptions(select, values, getGoogleReasoningLabelsForModel(model));
    const nextValue = values.includes(currentValue)
        ? currentValue
        : getGoogleReasoningDefaultForModel(model);
    select.value = nextValue;
    if (nextValue !== localSettings.LocalTranslatorConfig?.reasoningLevel) {
        select.value = nextValue;
        saveOption(localSettings, ["LocalTranslatorConfig", "reasoningLevel"], nextValue);
    }
}

function syncOpenAiReasoningEffortOptions(localSettings) {
    const model =
        document.getElementById("local-translator-openai-model")?.value ||
        localSettings.LocalTranslatorConfig?.openaiModel ||
        "";
    const select = document.getElementById("local-translator-openai-reasoning-effort");
    if (!select) return;

    const values = getOpenAiReasoningValuesForModel(model);
    const currentValue =
        select.value ||
        localSettings.LocalTranslatorConfig?.openaiReasoningEffort ||
        DEFAULT_OPENAI_REASONING_EFFORT;
    replaceSelectOptions(select, values, OPENAI_REASONING_OPTION_LABELS);
    const nextValue = values.includes(currentValue)
        ? currentValue
        : getOpenAiReasoningDefaultForModel(model);
    select.value = nextValue;
    if (nextValue !== localSettings.LocalTranslatorConfig?.openaiReasoningEffort) {
        saveOption(localSettings, ["LocalTranslatorConfig", "openaiReasoningEffort"], nextValue);
    }
}

function syncPreciseGoogleReasoningLevelOptions(localSettings) {
    const preciseConfig = localSettings.PreciseTranslatorConfig || {};
    const model =
        document.getElementById("precise-translator-model")?.value ||
        preciseConfig.model ||
        DEFAULT_SETTINGS.PreciseTranslatorConfig?.model ||
        DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL;
    const select = document.getElementById("precise-translator-reasoning-level");
    if (!select) return;

    const values = getGoogleReasoningValuesForModel(model);
    const currentValue =
        select.value ||
        preciseConfig.reasoningLevel ||
        DEFAULT_SETTINGS.PreciseTranslatorConfig?.reasoningLevel ||
        DEFAULT_GOOGLE_AI_STUDIO_REASONING_LEVEL;
    replaceSelectOptions(select, values, getGoogleReasoningLabelsForModel(model));
    const nextValue = values.includes(currentValue)
        ? currentValue
        : getGoogleReasoningDefaultForModel(model);
    select.value = nextValue;
    if (nextValue !== preciseConfig.reasoningLevel) {
        saveOption(localSettings, ["PreciseTranslatorConfig", "reasoningLevel"], nextValue);
    }
}

function syncPreciseOpenAiReasoningEffortOptions(localSettings) {
    const preciseConfig = localSettings.PreciseTranslatorConfig || {};
    const model =
        document.getElementById("precise-translator-openai-model")?.value ||
        preciseConfig.openaiModel ||
        DEFAULT_SETTINGS.PreciseTranslatorConfig?.openaiModel ||
        "";
    const select = document.getElementById("precise-translator-openai-reasoning-effort");
    if (!select) return;

    const values = getOpenAiReasoningValuesForModel(model);
    const currentValue =
        select.value ||
        preciseConfig.openaiReasoningEffort ||
        DEFAULT_SETTINGS.PreciseTranslatorConfig?.openaiReasoningEffort ||
        DEFAULT_OPENAI_REASONING_EFFORT;
    replaceSelectOptions(select, values, OPENAI_REASONING_OPTION_LABELS);
    const nextValue = values.includes(currentValue)
        ? currentValue
        : getOpenAiReasoningDefaultForModel(model);
    select.value = nextValue;
    if (nextValue !== preciseConfig.openaiReasoningEffort) {
        saveOption(localSettings, ["PreciseTranslatorConfig", "openaiReasoningEffort"], nextValue);
    }
}

function syncAiPageTranslatorVisibility(localSettings) {
    const localConfig = localSettings.LocalTranslatorConfig || {};
    const isAiMode = localConfig.mode === "googleAiStudio" || localConfig.mode === "openai";
    const showAi = Boolean(localConfig.enabled && isAiMode);
    const aiRow = document.getElementById("ai-page-translator-row");
    if (aiRow) aiRow.hidden = !showAi;

    // If AI page translator was selected but is no longer available, fall back
    if (!showAi) {
        const aiRadio = document.getElementById("ai-page-translator");
        if (aiRadio && aiRadio.checked) {
            const googleRadio = document.getElementById("google-page-translator");
            if (googleRadio) {
                googleRadio.checked = true;
                saveOption(localSettings, ["DefaultPageTranslator"], "GooglePageTranslate");
            }
        }
    }
}

/**
 * Set up hybrid translate config.
 *
 * @param {Object} config translator config
 * @param {Array<String>} availableTranslators available translators for current language setting
 *
 * @returns {void} nothing
 */
function setUpTranslateConfig(config, availableTranslators) {
    config = stripPronunciationDisplaySelections(config);
    let translatorConfigEles = document.getElementsByClassName("translator-config");

    for (let ele of translatorConfigEles) {
        // Remove existed options.
        for (let i = ele.options.length; i > 0; i--) {
            ele.options.remove(i - 1);
        }

        // data-affected indicates items affected by this element in config.selections, they always have the same value.
        let affected = ele.getAttribute("data-affected").split(/\s/g);
        let selected = config.selections[affected[0]];
        for (let translator of availableTranslators) {
            if (translator === selected) {
                ele.options.add(
                    new Option(chrome.i18n.getMessage(translator), translator, true, true)
                );
            } else {
                ele.options.add(new Option(chrome.i18n.getMessage(translator), translator));
            }
        }

        ele.onchange = () => {
            let value = ele.options[ele.selectedIndex].value;
            // Update every affected item.
            for (let item of affected) {
                config.selections[item] = value;
            }

            // Get the new selected translator set.
            let translators = new Set();
            config.translators = [];
            for (let item in config.selections) {
                let translator = config.selections[item];
                if (!translators.has(translator)) {
                    config.translators.push(translator);
                    translators.add(translator);
                }
            }

            chrome.storage.sync.set({
                HybridTranslatorConfig: config,
                DefaultTranslator: "HybridTranslate",
            });
        };
    }
}

/**
 *
 * get setting value according to path of setting item
 *
 * @param {Object} localSettings setting object stored in local
 * @param {Array} settingItemPath path of the setting item
 * @returns {*} setting value
 */
function getSetting(localSettings, settingItemPath) {
    let result = localSettings;
    settingItemPath.forEach((key) => {
        result = result[key];
    });
    return result;
}

/**
 * 保存一条设置项
 *
 * @param {Object} localSettings  本地存储的设置项
 * @param {Array} settingItemPath 设置项的层级路径
 * @param {*} value 设置项的值
 */
function saveOption(localSettings, settingItemPath, value) {
    // update local settings
    let pointer = localSettings; // point to children of local setting or itself

    // point to the leaf item recursively
    for (let i = 0; i < settingItemPath.length - 1; i++) {
        pointer = pointer[settingItemPath[i]];
    }
    // update the setting leaf value
    pointer[settingItemPath[settingItemPath.length - 1]] = value;

    let result = {};
    result[settingItemPath[0]] = localSettings[settingItemPath[0]];
    chrome.storage.sync.set(result);
}
