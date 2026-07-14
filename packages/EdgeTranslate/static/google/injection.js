// Copyright 2010 Google Inc. All Rights Reserved.

(function () {
    let uid = "1E07F158C6FA4460B352973E9693B329";
    let teId = `TE_${uid}`;
    let cbId = `TECB_${uid}`;
    let controlId = `ETCTRL_${uid}`;
    let pageTranslatorModeAttribute = "data-edge-translate-page-translator";
    let controlMessageType = "edge_translate_page_translate_control";

    let injection_ele = document.getElementById("google-translate-injection");
    if (!injection_ele) return;
    this.USER_LANG = injection_ele.getAttribute("user-lang");
    injection_ele.removeAttribute("user-lang");
    this.EDGE_TRANSLATE_URL = injection_ele.getAttribute("edge-translate-url");
    injection_ele.removeAttribute("edge-translate-url");

    function googleModeIsActive() {
        return document.documentElement?.getAttribute(pageTranslatorModeAttribute) === "google";
    }

    function restoreAndHide() {
        try {
            if (window.google?.translate?.TranslateService) {
                window.google.translate.TranslateService.getInstance().restore();
            }
        } catch {
            /* noop */
        }
        try {
            window[teId]?.showBanner(false);
        } catch {
            /* noop */
        }
    }

    let control = window[controlId];
    if (!control) {
        control = { stopRequested: false };
        window[controlId] = control;
        window.addEventListener("message", function (event) {
            if (event.source !== window || typeof event.data !== "string") return;
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            if (data.type !== controlMessageType || data.action !== "stop") return;
            control.stopRequested = true;
            restoreAndHide();
            window.postMessage(
                JSON.stringify({ type: controlMessageType, action: "stopped" }),
                "*"
            );
        });
    }
    control.stopRequested = !googleModeIsActive();
    if (control.stopRequested) {
        restoreAndHide();
        return;
    }

    function show() {
        window.setTimeout(function () {
            if (control.stopRequested || !googleModeIsActive()) return;
            window[teId].showBanner(true);
        }, 10);
    }

    function newElem() {
        // eslint-disable-next-line no-undef
        let elem = new google.translate.TranslateElement({
            autoDisplay: false,
            floatPosition: 0,
            multilanguagePage: true,
            pageLanguage: "auto",
        });
        return elem;
    }

    if (window[teId]) {
        show();
    }
    // eslint-disable-next-line no-undef
    else if (!window.google || !google.translate || !google.translate.TranslateElement) {
        if (!window[cbId]) {
            window[cbId] = function () {
                if (control.stopRequested || !googleModeIsActive()) {
                    restoreAndHide();
                    return;
                }
                window[teId] = newElem();
                show();
            };
        }

        let s = document.createElement("script");
        s.src = `${this.EDGE_TRANSLATE_URL}google/elms/elm_${this.USER_LANG}.js`;
        document.getElementsByTagName("head")[0].appendChild(s);
    } else {
        window[teId] = newElem();
        show();
    }
})();
