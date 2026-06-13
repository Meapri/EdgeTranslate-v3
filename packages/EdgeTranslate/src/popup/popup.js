import { LANGUAGES } from "@edge_translate/translators";
import Channel from "common/scripts/channel.js";
import { i18nHTML } from "common/scripts/common.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import createLanguageMenu from "common/scripts/language_menu.js";

/**
 * Communication channel.
 */
const channel = new Channel();

// 交换按钮 / 互译模式开关
const exchangeButton = document.getElementById("exchange");
const mutualTranslate = document.getElementById("mutual-translate");

// Pretty custom language menus (replace the old native <select> elements).
let sourceMenu = null;
let targetMenu = null;
// Source language can be auto-detected; the target language is always a concrete language.
let sourceItems = [];
let targetItems = [];
const labelByCode = new Map();

function buildLanguageItems() {
    targetItems = Object.keys(LANGUAGES).map((code) => ({
        value: code,
        label: chrome.i18n.getMessage(LANGUAGES[code]) || code,
    }));
    sourceItems = [
        { value: "auto", label: chrome.i18n.getMessage("AutoDetect") || "Auto" },
        ...targetItems,
    ];
    labelByCode.clear();
    for (const item of sourceItems) labelByCode.set(item.value, item.label);
}

function getSourceValue() {
    return sourceMenu ? sourceMenu.getValue() : "auto";
}

function getTargetValue() {
    return targetMenu ? targetMenu.getValue() : "en";
}

function labelOf(code) {
    return labelByCode.get(code) || code;
}

/**
 * 初始化设置列表
 */
window.onload = function () {
    i18nHTML();
    // 페이지 번역 UI 전면 제거
    const pageTranslateRow = document.getElementById("page-translate");
    if (pageTranslateRow && pageTranslateRow.parentNode) {
        pageTranslateRow.parentNode.removeChild(pageTranslateRow);
    }

    let arrowUp = document.getElementById("arrow-up");
    let arrowDown = document.getElementById("arrow-down");
    arrowDown.setAttribute("title", chrome.i18n.getMessage("Unfold"));
    arrowUp.setAttribute("title", chrome.i18n.getMessage("Fold"));

    // 添加交换按钮对点击事件的监听
    exchangeButton.onclick = exchangeLanguage;

    // 添加互译模式开关的事件监听
    mutualTranslate.onchange = () => {
        getOrSetDefaultSettings("OtherSettings", DEFAULT_SETTINGS).then((result) => {
            let OtherSettings = result.OtherSettings;
            OtherSettings["MutualTranslate"] = mutualTranslate.checked;
            saveOption("OtherSettings", OtherSettings);
        });
        showSourceTarget();
    };

    buildLanguageItems();

    // 获得用户之前选择的语言翻译选项和互译设置
    getOrSetDefaultSettings(["languageSetting", "OtherSettings"], DEFAULT_SETTINGS).then(
        (result) => {
            let OtherSettings = result.OtherSettings;
            let languageSetting = result.languageSetting || {};
            const sl = languageSetting.sl || "auto";
            const tl = languageSetting.tl || "en";

            // 根据源语言设定更新
            if (sl === "auto") {
                mutualTranslate.disabled = true;
                mutualTranslate.parentElement.title = chrome.i18n.getMessage(
                    "MutualTranslationWarning"
                );
                if (OtherSettings["MutualTranslate"]) {
                    mutualTranslate.checked = false;
                    mutualTranslate.onchange();
                }
            } else {
                mutualTranslate.checked = OtherSettings["MutualTranslate"];
                mutualTranslate.parentElement.title = "";
            }

            const searchPlaceholder = chrome.i18n.getMessage("SearchLanguage") || "Search language";
            const emptyText = chrome.i18n.getMessage("NoLanguageMatch") || "No matches";

            sourceMenu = createLanguageMenu({
                languages: sourceItems,
                value: sl,
                ariaLabel: chrome.i18n.getMessage("SourceLanguage") || "Source language",
                searchPlaceholder,
                emptyText,
                onChange: onSourceChange,
            });
            targetMenu = createLanguageMenu({
                languages: targetItems,
                value: tl,
                ariaLabel: chrome.i18n.getMessage("TargetLanguage") || "Target language",
                searchPlaceholder,
                emptyText,
                onChange: onTargetChange,
            });
            document.getElementById("sl-mount").appendChild(sourceMenu.element);
            document.getElementById("tl-mount").appendChild(targetMenu.element);

            judgeValue();
            showSourceTarget();
        }
    );
    // 统一添加事件监听
    addEventListener();
};

/**
 * 监听展开语言设置的快捷键
 */
chrome.commands.onCommand.addListener((command) => {
    switch (command) {
        case "change_language_setting":
            settingSwitch();
            break;
        case "exchange_source_target_lang":
            exchangeLanguage();
            break;
        case "change_mutual_translate":
            mutualTranslate.click();
            break;
        default:
            break;
    }
});

function onSourceChange(value) {
    judgeValue();
    updateLanguageSetting(value, getTargetValue());
    showSourceTarget();
}

function onTargetChange(value) {
    updateLanguageSetting(getSourceValue(), value);
    showSourceTarget();
}

/**
 * 保存翻译语言设定
 *
 * @param {string} sl 源语言
 * @param {string} tl 目标语言
 */
function updateLanguageSetting(sl, tl) {
    // Update translator config.
    channel.emit("language_setting_update", {
        from: sl,
        to: tl,
    });

    saveOption("languageSetting", { sl, tl });
    if (sl === "auto") {
        mutualTranslate.checked = false;
        mutualTranslate.disabled = true;
        mutualTranslate.parentElement.title = chrome.i18n.getMessage("MutualTranslationWarning");
        mutualTranslate.onchange();
    } else if (mutualTranslate.disabled) {
        mutualTranslate.disabled = false;
        mutualTranslate.parentElement.title = "";
    }
}

/**
 * 保存一条设置项
 *
 * @param {*} key 设置项名
 * @param {*} value 设置项
 */
function saveOption(key, value) {
    let item = {};
    item[key] = value;
    chrome.storage.sync.set(item);
}

/**
 * 需要对页面中的元素添加事件监听时，请在此函数中添加
 */
function addEventListener() {
    document.getElementById("translateSubmit").addEventListener("click", translateSubmit);
    document.addEventListener("keypress", translatePreSubmit); // 对用户按下回车按键后的事件进行监听
    document.getElementById("setting-switch").addEventListener("click", settingSwitch);
}

/**
 * 负责在option页面中输入内容后进行翻译
 */
function translateSubmit() {
    let content = document.getElementById("translate_input").value;
    if (content.replace(/\s*/, "") !== "") {
        document.getElementById("hint_message").style.display = "none";

        // send message to background to translate content
        channel.request("translate", { text: content }).then(() => {
            setTimeout(() => {
                window.close();
            }, 0);
        });
    } else {
        document.getElementById("hint_message").style.display = "inline";
    }
}

/**
 * 如果源语言是自动判断语言类型(值是auto),则交换按钮显示灰色，避免用户点击。
 */
function judgeValue() {
    if (getSourceValue() === "auto") exchangeButton.style.color = "gray";
    else exchangeButton.style.color = "#4a8cf7";
}

/**
 * 交换源语言和目标语言
 */
function exchangeLanguage() {
    const sl = getSourceValue();
    if (sl === "auto" || !sourceMenu || !targetMenu) return;
    const tl = getTargetValue();
    // setValue does not fire onChange, so persist once explicitly below.
    sourceMenu.setValue(tl);
    targetMenu.setValue(sl);
    judgeValue();
    updateLanguageSetting(tl, sl);
    showSourceTarget();
}

/**
 * 负责在option中隐藏或显示设置选项
 */
function settingSwitch() {
    let setting = document.getElementById("setting");
    let arrowUp = document.getElementById("arrow-up");
    let arrowDown = document.getElementById("arrow-down");
    // Toggle via class — popup.css uses .is-open + @starting-style so the
    // height / opacity / margin all tween via the iPadOS decelerate curve.
    const isOpen = setting.classList.toggle("is-open");
    if (isOpen) {
        arrowDown.style.display = "none";
        arrowUp.style.display = "inline";
        // Focus the target-language menu trigger after the settings block opens.
        const tlTrigger = targetMenu && targetMenu.element.querySelector(".et-lang-trigger");
        if (tlTrigger) tlTrigger.focus();
        judgeValue();
    } else {
        arrowDown.style.display = "inline";
        arrowUp.style.display = "none";
        document.getElementById("translate_input").focus();
    }
}

/**
 * 判断如果按下的是按钮是enter键，就调用翻译的函数
 */
function translatePreSubmit(event) {
    let int_keycode = event.charCode || event.keyCode;
    if (int_keycode == "13") {
        translateSubmit();
    }
}

/**
 * show source language and target language hint in placeholder of input element
 */
function showSourceTarget() {
    let inputElement = document.getElementById("translate_input");
    const sourceLanguageString = labelOf(getSourceValue());
    const targetLanguageString = labelOf(getTargetValue());
    if (getSourceValue() === "auto" || !mutualTranslate.checked) {
        inputElement.placeholder = `${sourceLanguageString} ==> ${targetLanguageString}`;
    } else {
        inputElement.placeholder = `${sourceLanguageString} <=> ${targetLanguageString}`;
    }
}
