import Channel from "common/scripts/channel.js";
import { i18nHTML } from "common/scripts/common.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";

/**
 * Communication channel.
 */
const channel = new Channel();

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
