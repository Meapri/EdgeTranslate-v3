import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";

export { sendHitRequest };

// specification of this module is in: https://developers.google.com/analytics/devguides/collection/protocol/v1/parameters
// Deprecated GA (UA) 제거 준비: 보관 값. 실제 전송은 설정에서 Opt-in 시에만 수행
const ANALYTICS_ACCOUNT = "UA-153659474-1";
const GA_URL = "https://www.google-analytics.com/collect";

/**
 * send hit data to google analytics API
 * "hit type" includes: "pageview", "event"
 * "event type" includes: "click", "open", "installation"
 * @param {string} page page name of the current document
 * @param {string} type type of hit.
 * @param {Object} extraHitData extra hit(request) data
 */
function sendHitRequest(page, type, extraHitData) {
    let documentLocation =
        typeof document !== "undefined" && document.location
            ? document.location.origin + document.location.pathname + document.location.search
            : "chrome-extension://service-worker";
    // Respect user opt-in and only send minimal data
    withGoogleAnalytics(() => {
        getUUID((UUID) => {
            // establish basic hit data(payload)
            let hitData = {
                v: 1, // analytics protocol version
                tid: ANALYTICS_ACCOUNT, // analytics protocol version
                cid: UUID, // unique user ID
                ul: navigator.language, // user's language setting
                an: chrome.runtime.getManifest().name, // the name of this extension
                av: chrome.runtime.getManifest().version, // the version number of this extension
                t: type, // hit(request) type
                dl: documentLocation, // document location
                dp: `/${page}`, // document page
                dt: page, // document title
            };
            // merge hitData and extraHitData
            Object.assign(hitData, extraHitData);

            // Service Worker 호환성을 위해 fetch API 사용
            if (typeof XMLHttpRequest === "undefined" || typeof window === "undefined") {
                // Service Worker 환경에서는 fetch 사용
                fetch(GA_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: generateURLRequest(hitData),
                }).catch((error) => {
                    console.warn(
                        "[EdgeTranslate] Analytics 요청 실패 (Service Worker 환경):",
                        error
                    );
                });
            } else {
                // 일반 환경에서도 fetch 사용으로 단일 경로화
                fetch(GA_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: generateURLRequest(hitData),
                }).catch((error) => {
                    console.warn("[EdgeTranslate] Analytics 요청 실패:", error);
                });
            }
        });
    });
}

/**
 * generate url according to the request object
 * @param {Object} requestData object contains request data
 * @returns {string} generated url
 */
function generateURLRequest(requestData) {
    let url = "";
    if (requestData) {
        for (let key in requestData) {
            url += `${key}=${requestData[key]}&`;
        }
    }
    return url;
}

/**
 *
 * @param {function} callback the callback function executed when the result of settings is ready and value of UseGoogleAnalytics is true
 */
function withGoogleAnalytics(callback) {
    getOrSetDefaultSettings("OtherSettings", DEFAULT_SETTINGS).then((result) => {
        if (result.OtherSettings.UseGoogleAnalytics) callback();
    });
}

/**
 * get UUID(unique user ID). If user is new, a new UUID will be generated or return the UUID stored in chrome storage
 * @param {function(UUID)} callback the callback function to be executed when the result is returned. If user is new, set a new UUID. UUID is a function parameter as result
 */
function getUUID(callback) {
    getOrSetDefaultSettings("UUID", () => {
        return {
            UUID: generateUUID(),
        };
    }).then((result) => {
        callback(result.UUID);
    });
}

function generateUUID() {
    let d = new Date().getTime();
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        d += performance.now(); //use high-precision timer if available
    }
    let uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        let r = (d + Math.random() * 16) % 16 | 0;
        d = Math.floor(d / 16);
        return (c == "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
    return uuid;
}
