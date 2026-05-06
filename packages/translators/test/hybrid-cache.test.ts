import HybridTranslator from "../src/translators/hybrid";
import { TranslationResult } from "../src/types";

const googleOnlyConfig = {
    translators: ["GoogleTranslate" as const],
    selections: {
        originalText: "GoogleTranslate" as const,
        mainMeaning: "GoogleTranslate" as const,
        tPronunciation: "GoogleTranslate" as const,
        sPronunciation: "GoogleTranslate" as const,
        detailedMeanings: "GoogleTranslate" as const,
        definitions: "GoogleTranslate" as const,
        examples: "GoogleTranslate" as const,
        sourceLanguage: "GoogleTranslate" as const,
        targetLanguage: "GoogleTranslate" as const,
    },
};

function createTranslator() {
    return new HybridTranslator(googleOnlyConfig, {});
}

describe("HybridTranslator cache bookkeeping", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("counts only real translation executions as requests and repeated calls as cache hits", async () => {
        const translator = createTranslator();
        const result: TranslationResult = {
            originalText: "hello",
            mainMeaning: "안녕",
            sourceLanguage: "en",
            targetLanguage: "ko",
        };
        const translateSpy = jest
            .spyOn(translator.REAL_TRANSLATORS.GoogleTranslate, "translate")
            .mockResolvedValue(result);

        await translator.translate("hello", "en", "ko");
        await translator.translate("hello", "en", "ko");

        expect(translateSpy).toHaveBeenCalledTimes(1);
        expect(translator.getPerformanceStats()).toMatchObject({
            requests: 1,
            cacheHits: 1,
            errors: 0,
            cacheSize: 1,
        });
    });
});
