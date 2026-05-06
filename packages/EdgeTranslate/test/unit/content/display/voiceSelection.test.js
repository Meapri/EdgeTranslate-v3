import { normalizeBCP47, scoreVoiceFor } from "../../../../src/content/display/voiceSelection.js";

describe("voiceSelection", () => {
    it("normalizes common language codes to browser TTS locales", () => {
        expect(normalizeBCP47("ko")).toBe("ko-KR");
        expect(normalizeBCP47("en-GB")).toBe("en-US");
        expect(normalizeBCP47("ja")).toBe("ja-JP");
        expect(normalizeBCP47("zh-cn")).toBe("zh-CN");
        expect(normalizeBCP47("zh-tw")).toBe("zh-TW");
    });

    it("prefers matching, local, default Korean voices", () => {
        const matchingVoice = {
            lang: "ko-KR",
            name: "Microsoft Korean Yuna Natural",
            voiceURI: "local-ko",
            localService: true,
            default: true,
        };
        const unrelatedVoice = {
            lang: "en-US",
            name: "English",
            voiceURI: "local-en",
            localService: true,
            default: true,
        };

        expect(scoreVoiceFor("ko-KR", matchingVoice)).toBeGreaterThan(
            scoreVoiceFor("ko-KR", unrelatedVoice)
        );
    });
});
