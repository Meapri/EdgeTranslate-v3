import BingTranslator from "../src/translators/bing";
import HybridTranslator from "../src/translators/hybrid";

describe("translator construction side effects", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("does not start Bing warm-up just by constructing BingTranslator", () => {
        const warmUpSpy = jest
            .spyOn(BingTranslator.prototype, "warmUp")
            .mockResolvedValue(undefined);

        new BingTranslator();
        jest.runOnlyPendingTimers();

        expect(warmUpSpy).not.toHaveBeenCalled();
    });

    it("does not start Bing warm-up just by constructing HybridTranslator", () => {
        const warmUpSpy = jest
            .spyOn(BingTranslator.prototype, "warmUp")
            .mockResolvedValue(undefined);

        new HybridTranslator(
            {
                translators: ["GoogleTranslate"],
                selections: {
                    originalText: "GoogleTranslate",
                    mainMeaning: "GoogleTranslate",
                    tPronunciation: "GoogleTranslate",
                    sPronunciation: "GoogleTranslate",
                    detailedMeanings: "GoogleTranslate",
                    definitions: "GoogleTranslate",
                    examples: "GoogleTranslate",
                    sourceLanguage: "GoogleTranslate",
                    targetLanguage: "GoogleTranslate",
                },
            },
            {}
        );
        jest.runOnlyPendingTimers();

        expect(warmUpSpy).not.toHaveBeenCalled();
    });
});
