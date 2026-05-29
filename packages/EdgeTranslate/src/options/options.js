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
const DEFAULT_OPENAI_TRANSLATION_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_COMPATIBLE_TRANSLATION_MODEL = "gpt-oss-20b";
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
const DEFAULT_LOCAL_TRANSLATOR_TIMEOUT_MS = "120000";

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

    const header = document.querySelector("header");
    if (header) {
        window.addEventListener("scroll", () => {
            header.classList.toggle("scrolled", window.scrollY > 0);
        });
    }

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
                settingItemPath.join(" ") === "LocalTranslatorConfig openaiModel" &&
                !OPENAI_TRANSLATION_MODELS.has(settingItemValue)
            ) {
                settingItemValue = DEFAULT_OPENAI_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig openaiCompatibleModel" &&
                !String(settingItemValue || "").trim()
            ) {
                settingItemValue = DEFAULT_OPENAI_COMPATIBLE_TRANSLATION_MODEL;
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
                settingItemPath.join(" ") === "PreciseTranslatorConfig openaiModel" &&
                !OPENAI_TRANSLATION_MODELS.has(settingItemValue)
            ) {
                settingItemValue =
                    DEFAULT_SETTINGS.PreciseTranslatorConfig?.openaiModel ||
                    DEFAULT_OPENAI_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "PreciseTranslatorConfig openaiCompatibleModel" &&
                !String(settingItemValue || "").trim()
            ) {
                settingItemValue =
                    DEFAULT_SETTINGS.PreciseTranslatorConfig?.openaiCompatibleModel ||
                    DEFAULT_OPENAI_COMPATIBLE_TRANSLATION_MODEL;
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
                settingItemPath.join(" ") === "RealtimeCaptionConfig translatorMode" &&
                !["ai", "google"].includes(settingItemValue)
            ) {
                settingItemValue = DEFAULT_SETTINGS.RealtimeCaptionConfig.translatorMode;
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
                    localConfig.mode === "googleAiStudio" ||
                    localConfig.mode === "openai" ||
                    localConfig.mode === "openaiCompatible";
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
                    localConfig.mode === "googleAiStudio" ||
                    localConfig.mode === "openai" ||
                    localConfig.mode === "openaiCompatible";
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
        // Tab switching logic
        const navTabs = document.querySelectorAll(".nav-tab");
        const tabPanes = document.querySelectorAll(".tab-pane");

        const updateIndicator = () => {
            const indicator = document.querySelector(".nav-indicator");
            const activeTab = document.querySelector(".nav-tab.active");
            if (indicator && activeTab) {
                indicator.style.transform = `translateY(${activeTab.offsetTop}px)`;
                indicator.style.height = `${activeTab.offsetHeight}px`;
                indicator.style.opacity = "1";
            }
        };

        const activateTab = (targetTab, { updateHash = true } = {}) => {
            const activePane = document.getElementById(`tab-${targetTab}`);
            const activeTab = document.querySelector(`.nav-tab[data-tab='${targetTab}']`);
            if (!activePane || !activeTab) return false;

            const updateDOM = () => {
                navTabs.forEach((t) => t.classList.remove("active"));
                tabPanes.forEach((p) => p.classList.remove("active"));
                activeTab.classList.add("active");
                activePane.classList.add("active");
                updateIndicator();
            };

            if (document.startViewTransition) {
                document.startViewTransition(updateDOM);
            } else {
                updateDOM();
            }

            if (updateHash && window.location.hash !== `#${targetTab}`) {
                window.history.replaceState(null, "", `#${targetTab}`);
            }
            return true;
        };

        navTabs.forEach((tab) => {
            tab.addEventListener("click", () => {
                const targetTab = tab.getAttribute("data-tab");
                activateTab(targetTab);
            });
        });
        const initialTab = window.location.hash.replace(/^#/, "") || "general";
        activateTab(initialTab, { updateHash: false });

        window.addEventListener("resize", updateIndicator);
        setTimeout(updateIndicator, 100);
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
    ["googleAiStudio", "openai", "openaiCompatible"].forEach((localMode) => {
        const fields = document.querySelectorAll(`[data-local-mode='${localMode}']`);
        const rowId =
            localMode === "googleAiStudio"
                ? "local-translator-google-settings"
                : localMode === "openai"
                ? "local-translator-openai-settings"
                : "local-translator-openai-compatible-settings";
        const row = document.getElementById(rowId);
        const hidden = mode !== localMode;
        if (row) row.hidden = hidden;
        fields.forEach((element) => {
            element.hidden = hidden;
        });
    });
}

function syncPreciseTranslatorFields(mode) {
    ["googleAiStudio", "openai", "openaiCompatible"].forEach((localMode) => {
        const fields = document.querySelectorAll(`[data-precise-mode='${localMode}']`);
        const rowId =
            localMode === "googleAiStudio"
                ? "precise-translator-google-settings"
                : localMode === "openai"
                ? "precise-translator-openai-settings"
                : "precise-translator-openai-compatible-settings";
        const row = document.getElementById(rowId);
        const hidden = mode !== localMode;
        if (row) row.hidden = hidden;
        fields.forEach((element) => {
            element.hidden = hidden;
        });
    });
}

function replaceSelectOptions(select, values, labels) {
    const fragment = document.createDocumentFragment();
    values.forEach((value) => {
        fragment.appendChild(new Option(labels[value] || value, value));
    });
    select.replaceChildren(fragment);
}

function syncAiPageTranslatorVisibility(localSettings) {
    const localConfig = localSettings.LocalTranslatorConfig || {};
    const isAiMode =
        localConfig.mode === "googleAiStudio" ||
        localConfig.mode === "openai" ||
        localConfig.mode === "openaiCompatible";
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
