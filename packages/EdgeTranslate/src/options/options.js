import Channel from "common/scripts/channel.js";
import { i18nHTML } from "common/scripts/common.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import {
    getModelCatalog,
    GOOGLE_AI_STUDIO_FALLBACK_MODELS,
    OPENAI_FALLBACK_MODELS,
} from "common/scripts/model_catalog.js";

/**
 * Communication channel.
 */
const channel = new Channel();
const DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL = "gemini-2.5-flash-lite";
// Seed lists live in model_catalog.js and double as the offline fallback; the
// options dropdowns are refreshed with the provider's live model list at runtime.
const GOOGLE_AI_STUDIO_TRANSLATION_MODELS = new Set(GOOGLE_AI_STUDIO_FALLBACK_MODELS);
const DEFAULT_OPENAI_TRANSLATION_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_COMPATIBLE_TRANSLATION_MODEL = "gpt-oss-20b";
const OPENAI_TRANSLATION_MODELS = new Set(OPENAI_FALLBACK_MODELS);

// Wiring for the four provider-model dropdowns that should auto-refresh from the
// live model catalog. Google's Local + Precise selects share one API key, as do
// OpenAI's, so a single fetch per provider repopulates both of its selects.
const MODEL_SELECTS = [
    {
        id: "local-translator-model",
        provider: "googleAiStudio",
        keyPath: ["LocalTranslatorConfig", "apiKey"],
        valuePath: ["LocalTranslatorConfig", "model"],
    },
    {
        id: "local-translator-openai-model",
        provider: "openai",
        keyPath: ["LocalTranslatorConfig", "openaiApiKey"],
        valuePath: ["LocalTranslatorConfig", "openaiModel"],
    },
    {
        id: "precise-translator-model",
        provider: "googleAiStudio",
        keyPath: ["LocalTranslatorConfig", "apiKey"],
        valuePath: ["PreciseTranslatorConfig", "model"],
    },
    {
        id: "precise-translator-openai-model",
        provider: "openai",
        keyPath: ["LocalTranslatorConfig", "openaiApiKey"],
        valuePath: ["PreciseTranslatorConfig", "openaiModel"],
    },
];
// API-key inputs whose edits should re-trigger a live model fetch.
const MODEL_KEY_FIELD_PROVIDERS = {
    "local-translator-api-key": "googleAiStudio",
    "local-translator-openai-api-key": "openai",
};
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
            // Model values are validated by presence only: any non-empty stored
            // model is preserved (it may be a freshly-released one the seed list
            // hasn't caught up to yet, chosen from the live catalog). Only a blank
            // value falls back to the default.
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig model" &&
                !String(settingItemValue || "").trim()
            ) {
                settingItemValue = DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "LocalTranslatorConfig openaiModel" &&
                !String(settingItemValue || "").trim()
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
                !String(settingItemValue || "").trim()
            ) {
                settingItemValue =
                    DEFAULT_SETTINGS.PreciseTranslatorConfig?.model ||
                    DEFAULT_GOOGLE_AI_STUDIO_TRANSLATION_MODEL;
                saveOption(result, settingItemPath, settingItemValue);
            }
            if (
                settingItemPath.join(" ") === "PreciseTranslatorConfig openaiModel" &&
                !String(settingItemValue || "").trim()
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
                    localConfig.mode === "openaiCompatible" ||
                    localConfig.mode === "chromeBuiltin";
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
                    localConfig.mode === "openaiCompatible" ||
                    localConfig.mode === "chromeBuiltin";
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
                        // Editing a provider API key invalidates the previous
                        // key's model list — refetch this provider's catalog.
                        const provider = MODEL_KEY_FIELD_PROVIDERS[target.id];
                        if (provider) {
                            refreshModelSelectsForProvider(result, provider, { force: true });
                        }
                    };
                    break;
                default:
                    break;
            }
        }
        syncLocalTranslatorFields(result.LocalTranslatorConfig?.mode || "chromeBuiltin");
        syncPreciseTranslatorFields(result.PreciseTranslatorConfig?.mode || "openai");
        syncAiPageTranslatorVisibility(result);

        // Add a "refresh" control next to each provider-model select and load
        // the live model catalog (cache-first) so newly-released models appear
        // without a manual extension update.
        setUpModelRefreshControls(result);
        refreshModelSelectsForProvider(result, "googleAiStudio");
        refreshModelSelectsForProvider(result, "openai");

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

/**
 * Insert a small "refresh model list" button after each provider-model select.
 * Clicking it force-refetches that provider's live catalog.
 */
function setUpModelRefreshControls(result) {
    const label = chrome.i18n.getMessage("RefreshModelList") || "Refresh model list";
    for (const entry of MODEL_SELECTS) {
        const select = document.getElementById(entry.id);
        if (!select || select.dataset.refreshWired) continue;
        select.dataset.refreshWired = "1";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "model-refresh-button";
        button.id = `${entry.id}-refresh`;
        button.textContent = "↻"; // ↻
        button.title = label;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", () => {
            refreshModelSelectsForProvider(result, entry.provider, { force: true });
        });
        select.insertAdjacentElement("afterend", button);
    }
}

/**
 * Fetch the live model catalog for one provider (cache-first unless forced) and
 * repopulate every select bound to it, preserving each select's stored value.
 */
async function refreshModelSelectsForProvider(result, provider, { force = false } = {}) {
    const entries = MODEL_SELECTS.filter((entry) => entry.provider === provider);
    if (!entries.length) return;

    const apiKey = getSetting(result, entries[0].keyPath);
    const buttons = entries
        .map((entry) => document.getElementById(`${entry.id}-refresh`))
        .filter(Boolean);
    buttons.forEach((button) => setRefreshButtonBusy(button, true));

    let catalog;
    try {
        catalog = await getModelCatalog(provider, apiKey, { force });
    } catch (error) {
        catalog = { models: [], source: "fallback", error: error?.message || String(error) };
    }

    for (const entry of entries) {
        const select = document.getElementById(entry.id);
        if (!select) continue;
        // The stored setting is authoritative for the current value: the select
        // may not yet contain it if it's a live-only model.
        const currentValue = String(getSetting(result, entry.valuePath) || "").trim();
        applyModelsToSelect(select, catalog.models, currentValue, catalog.capabilities);
    }

    buttons.forEach((button) => setRefreshButtonBusy(button, false, catalog));
}

function setRefreshButtonBusy(button, busy, catalog) {
    button.disabled = busy;
    button.classList.toggle("is-busy", busy);
    if (busy) {
        button.dataset.baseTitle = button.title;
        return;
    }
    const base = button.dataset.baseTitle || button.title;
    if (catalog?.error) {
        button.title = `${base} — ${catalog.error}`;
    } else {
        button.title = base;
    }
}

/**
 * Replace a select's options with `models`, guaranteeing the currently-selected
 * value stays available (prepended if the live list doesn't include it) so a
 * user's saved choice is never silently dropped.
 */
function applyModelsToSelect(select, models, currentValue, capabilities = {}) {
    const values = Array.isArray(models) ? [...models] : [];
    const current = (currentValue || select.value || "").trim();
    if (current && !values.includes(current)) values.unshift(current);
    if (!values.length) return; // nothing to show; leave existing options intact
    replaceSelectOptions(select, values, {});
    for (const option of select.options) {
        const capability = capabilities?.[option.value] || {
            pageTranslationStatus: "unknown",
            source: "selected-value",
        };
        option.dataset.pageTranslationStatus = capability.pageTranslationStatus;
        option.title = `AI page translation: ${capability.pageTranslationStatus} (${capability.source})`;
    }
    if (current) select.value = current;
    const updateSelectedCapability = () => {
        select.dataset.pageTranslationStatus =
            select.selectedOptions[0]?.dataset.pageTranslationStatus || "unknown";
    };
    updateSelectedCapability();
    if (!select.dataset.capabilityWired) {
        select.dataset.capabilityWired = "1";
        select.addEventListener("change", updateSelectedCapability);
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
    // The single shared request-timeout applies to every network AI mode but is
    // meaningless for the on-device Chrome built-in translator.
    const timeoutRow = document.getElementById("local-translator-timeout-settings");
    if (timeoutRow) timeoutRow.hidden = mode === "chromeBuiltin";
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
        localConfig.mode === "openaiCompatible" ||
        localConfig.mode === "chromeBuiltin";
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
