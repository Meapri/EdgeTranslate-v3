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

    it("does not reuse cached main translations after the main hybrid provider changes", async () => {
        const translator = createTranslator();
        jest.spyOn(translator.REAL_TRANSLATORS.GoogleTranslate, "translate").mockResolvedValue({
            originalText: "notice",
            mainMeaning: "구글 결과",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        jest.spyOn(translator.REAL_TRANSLATORS.LocalTranslate, "translate").mockResolvedValue({
            originalText: "notice",
            mainMeaning: "AI 결과",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });

        await expect(translator.translate("notice", "en", "ko")).resolves.toMatchObject({
            mainMeaning: "구글 결과",
        });

        translator.useConfig({
            translators: ["LocalTranslate"],
            selections: {
                ...googleOnlyConfig.selections,
                originalText: "LocalTranslate",
                mainMeaning: "LocalTranslate",
            },
        });

        await expect(translator.translate("notice", "en", "ko")).resolves.toMatchObject({
            mainMeaning: "AI 결과",
        });
    });

    it("keeps the main hybrid text identical to the selected AI provider without Google fallback", async () => {
        const translator = new HybridTranslator(
            {
                translators: ["GoogleTranslate", "LocalTranslate"],
                selections: {
                    ...googleOnlyConfig.selections,
                    originalText: "LocalTranslate",
                    mainMeaning: "LocalTranslate",
                    detailedMeanings: "GoogleTranslate",
                },
            },
            {}
        );
        jest.spyOn(translator.REAL_TRANSLATORS.GoogleTranslate, "translate").mockResolvedValue({
            originalText: "notice",
            mainMeaning: "구글 결과",
            detailedMeanings: [{ pos: "noun", meaning: "세부 의미" }],
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        jest.spyOn(translator.REAL_TRANSLATORS.LocalTranslate, "translate").mockResolvedValue({
            originalText: "notice",
            mainMeaning: "AI 결과",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });

        const result = await translator.translate("notice", "en", "ko");

        expect(result.mainMeaning).toBe("AI 결과");
        expect(result.detailedMeanings).toEqual([{ pos: "noun", meaning: "세부 의미" }]);
    });

    it("prefers AI-provided dictionary sections when AI is the main hybrid provider", async () => {
        const translator = new HybridTranslator(
            {
                translators: ["GoogleTranslate", "LocalTranslate"],
                selections: {
                    ...googleOnlyConfig.selections,
                    originalText: "LocalTranslate",
                    mainMeaning: "LocalTranslate",
                    detailedMeanings: "GoogleTranslate",
                    definitions: "GoogleTranslate",
                    examples: "GoogleTranslate",
                },
            },
            {}
        );
        jest.spyOn(translator.REAL_TRANSLATORS.GoogleTranslate, "translate").mockResolvedValue({
            originalText: "run",
            mainMeaning: "구글 결과",
            detailedMeanings: [{ pos: "verb", meaning: "구글 상세" }],
            definitions: [{ pos: "verb", meaning: "구글 정의" }],
            examples: [{ source: "Google source.", target: "구글 예문." }],
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        jest.spyOn(translator.REAL_TRANSLATORS.LocalTranslate, "translate").mockResolvedValue({
            originalText: "run",
            mainMeaning: "달리다",
            detailedMeanings: [{ pos: "verb", meaning: "AI 상세" }],
            definitions: [{ pos: "verb", meaning: "AI 정의" }],
            examples: [{ source: "I run.", target: "나는 달린다." }],
            sourceLanguage: "en",
            targetLanguage: "ko",
        });

        const result = await translator.translate("run", "en", "ko");

        expect(result).toMatchObject({
            mainMeaning: "달리다",
            detailedMeanings: [{ pos: "verb", meaning: "AI 상세" }],
            definitions: [{ pos: "verb", meaning: "AI 정의" }],
            examples: [{ source: "I run.", target: "나는 달린다." }],
        });
    });

    it("does not replace an empty selected AI main result with another provider", async () => {
        const translator = new HybridTranslator(
            {
                translators: ["GoogleTranslate", "LocalTranslate"],
                selections: {
                    ...googleOnlyConfig.selections,
                    originalText: "LocalTranslate",
                    mainMeaning: "LocalTranslate",
                },
            },
            {}
        );
        jest.spyOn(translator.REAL_TRANSLATORS.GoogleTranslate, "translate").mockResolvedValue({
            originalText: "notice",
            mainMeaning: "구글 결과",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });
        jest.spyOn(translator.REAL_TRANSLATORS.LocalTranslate, "translate").mockResolvedValue({
            originalText: "notice",
            mainMeaning: "",
            sourceLanguage: "en",
            targetLanguage: "ko",
        });

        await expect(translator.translate("notice", "en", "ko")).resolves.toMatchObject({
            mainMeaning: "",
        });
    });
});
