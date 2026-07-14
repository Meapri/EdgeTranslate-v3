import fs from "fs";
import path from "path";

const injectionSource = fs.readFileSync(
    path.resolve(__dirname, "../../../static/google/injection.js"),
    "utf8"
);

const uid = "1E07F158C6FA4460B352973E9693B329";
const translateElementId = `TE_${uid}`;
const callbackId = `TECB_${uid}`;
const controlId = `ETCTRL_${uid}`;

describe("Google page translation injection ownership", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        document.head.innerHTML = "";
        document.documentElement.setAttribute("data-edge-translate-page-translator", "google");
        delete window[translateElementId];
        delete window[callbackId];
        delete window[controlId];
        delete window.google;
        delete window.USER_LANG;
        delete window.EDGE_TRANSLATE_URL;
    });

    afterEach(() => {
        jest.useRealTimers();
        document.documentElement.removeAttribute("data-edge-translate-page-translator");
        delete window[translateElementId];
        delete window[callbackId];
        delete window[controlId];
        delete window.google;
    });

    it("restores Google and suppresses a queued banner/observer start after AI takes ownership", () => {
        const injection = document.createElement("script");
        injection.id = "google-translate-injection";
        injection.setAttribute("user-lang", "ko");
        injection.setAttribute("edge-translate-url", "chrome-extension://edge-translate/");
        document.head.appendChild(injection);

        const restore = jest.fn();
        const showBanner = jest.fn();
        const TranslateElement = jest.fn(() => ({ showBanner }));
        window.google = {
            translate: {
                TranslateElement,
                TranslateService: {
                    getInstance: () => ({ restore }),
                },
            },
        };

        window.eval(injectionSource);
        expect(TranslateElement).toHaveBeenCalledTimes(1);
        expect(showBanner).not.toHaveBeenCalledWith(true);

        document.documentElement.setAttribute("data-edge-translate-page-translator", "dom");
        window.dispatchEvent(
            new MessageEvent("message", {
                data: JSON.stringify({
                    type: "edge_translate_page_translate_control",
                    action: "stop",
                }),
                source: window,
            })
        );
        jest.runOnlyPendingTimers();

        expect(restore).toHaveBeenCalledTimes(1);
        expect(showBanner).toHaveBeenCalledWith(false);
        expect(showBanner).not.toHaveBeenCalledWith(true);
    });
});
