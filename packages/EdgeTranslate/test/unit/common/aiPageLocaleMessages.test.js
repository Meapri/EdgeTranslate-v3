import fs from "fs";
import path from "path";

const LOCALES = ["en", "ko", "ja", "zh_CN", "zh_TW", "ru"];
const REQUIRED_KEYS = [
    "AIPageTranslationTitle",
    "AIPageTranslationPreparing",
    "AIPageTranslationComplete",
    "AIPageTranslationFailed",
    "AIPageTranslationFailedWithMessage",
    "AIPageTranslationIncomplete",
    "AIPageTranslationProgress",
    "AIPageError",
    "AIPagePartial",
    "AIPageViewMode",
    "AIPageTranslationView",
    "AIPageOriginalView",
    "AIPageShowOriginal",
    "AIPageShowTranslation",
    "AIPageHideBar",
    "AIPageHide",
    "AIPageClose",
    "AIPageShowBar",
    "AIPageShow",
    "MoreActions",
];

describe("AI page translation locale messages", () => {
    it.each(LOCALES)("defines the complete banner vocabulary for %s", (locale) => {
        const filename = path.resolve(
            __dirname,
            `../../../static/_locales/${locale}/messages.json`
        );
        const messages = JSON.parse(fs.readFileSync(filename, "utf8"));
        for (const key of REQUIRED_KEYS) {
            expect(messages[key]?.message).toEqual(expect.any(String));
            expect(messages[key].message.trim()).not.toBe("");
        }
    });
});
