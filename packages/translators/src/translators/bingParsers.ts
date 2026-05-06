import { TranslationResult } from "../types";

function createBaseResult(extras?: TranslationResult): TranslationResult {
    return extras ?? { originalText: "", mainMeaning: "" };
}

function parseTranslateResult(result: any, extras?: TranslationResult): TranslationResult {
    const parsed: TranslationResult = createBaseResult(extras);

    try {
        const translations = result[0].translations;
        parsed.mainMeaning = translations[0].text;
        parsed.tPronunciation = translations[0].transliteration.text;
        // eslint-disable-next-line no-empty
    } catch (error) {}

    return parsed;
}

function parseLookupResult(result: any, extras?: TranslationResult): TranslationResult {
    const parsed: TranslationResult = createBaseResult(extras);

    try {
        parsed.originalText = result[0].displaySource;

        const translations = result[0].translations;
        parsed.mainMeaning = translations[0].displayTarget;
        parsed.tPronunciation = translations[0].transliteration;

        const detailedMeanings = [];
        const definitions = [];

        for (const i in translations) {
            const synonyms = [];
            for (const j in translations[i].backTranslations) {
                synonyms.push(translations[i].backTranslations[j].displayText);
            }

            detailedMeanings.push({
                pos: translations[i].posTag,
                meaning: translations[i].displayTarget,
                synonyms,
            });

            if (translations[i].examples && translations[i].examples.length > 0) {
                for (const example of translations[i].examples) {
                    definitions.push({
                        pos: translations[i].posTag,
                        meaning: translations[i].displayTarget,
                        example: example.sourceExample || example.targetExample,
                    });
                }
            }
        }

        parsed.detailedMeanings = detailedMeanings;

        if (definitions.length > 0) {
            parsed.definitions = definitions;
        }

        if (result[0].examples && result[0].examples.length > 0) {
            const examples = [];
            for (const example of result[0].examples) {
                examples.push({
                    source: example.sourcePrefix + example.sourceTerm + example.sourceSuffix,
                    target: example.targetPrefix + example.targetTerm + example.targetSuffix,
                });
            }
            parsed.examples = examples;
        }
        // eslint-disable-next-line no-empty
    } catch (error) {}

    return parsed;
}

function parseExampleResult(result: any, extras?: TranslationResult): TranslationResult {
    const parsed: TranslationResult = createBaseResult(extras);

    try {
        parsed.examples = result[0].examples.map(
            (example: {
                sourcePrefix: string;
                sourceTerm: string;
                sourceSuffix: string;
                targetPrefix: string;
                targetTerm: string;
                targetSuffix: string;
            }) => ({
                source: `${example.sourcePrefix}<b>${example.sourceTerm}</b>${example.sourceSuffix}`,
                target: `${example.targetPrefix}<b>${example.targetTerm}</b>${example.targetSuffix}`,
            })
        );
        // eslint-disable-next-line no-empty
    } catch (error) {}

    return parsed;
}

export { parseTranslateResult, parseLookupResult, parseExampleResult };
