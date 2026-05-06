import {
    parseTranslateResult,
    parseLookupResult,
    parseExampleResult,
} from "../src/translators/bingParsers";

describe("bingParsers", () => {
    it("parses translate API result into main meaning and pronunciation", () => {
        const parsed = parseTranslateResult(
            [
                {
                    translations: [
                        {
                            text: "안녕하세요",
                            transliteration: { text: "annyeonghaseyo" },
                        },
                    ],
                },
            ],
            { originalText: "hello", mainMeaning: "" }
        );

        expect(parsed).toMatchObject({
            originalText: "hello",
            mainMeaning: "안녕하세요",
            tPronunciation: "annyeonghaseyo",
        });
    });

    it("parses lookup API result details", () => {
        const parsed = parseLookupResult(
            [
                {
                    displaySource: "run",
                    translations: [
                        {
                            displayTarget: "달리다",
                            transliteration: "dallida",
                            posTag: "verb",
                            backTranslations: [{ displayText: "sprint" }],
                            examples: [{ sourceExample: "I run", targetExample: "나는 달린다" }],
                        },
                    ],
                    examples: [
                        {
                            sourcePrefix: "I ",
                            sourceTerm: "run",
                            sourceSuffix: " daily",
                            targetPrefix: "나는 ",
                            targetTerm: "달린다",
                            targetSuffix: " 매일",
                        },
                    ],
                },
            ],
            { originalText: "", mainMeaning: "" }
        );

        expect(parsed.originalText).toBe("run");
        expect(parsed.mainMeaning).toBe("달리다");
        expect(parsed.detailedMeanings?.[0]).toMatchObject({
            pos: "verb",
            meaning: "달리다",
            synonyms: ["sprint"],
        });
        expect(parsed.examples?.[0]).toMatchObject({
            source: "I run daily",
            target: "나는 달린다 매일",
        });
    });

    it("parses example API result with highlighted terms", () => {
        const parsed = parseExampleResult(
            [
                {
                    examples: [
                        {
                            sourcePrefix: "say ",
                            sourceTerm: "hello",
                            sourceSuffix: " now",
                            targetPrefix: "지금 ",
                            targetTerm: "인사",
                            targetSuffix: "해",
                        },
                    ],
                },
            ],
            { originalText: "hello", mainMeaning: "안녕" }
        );

        expect(parsed.examples?.[0]).toEqual({
            source: "say <b>hello</b> now",
            target: "지금 <b>인사</b>해",
        });
    });
});
