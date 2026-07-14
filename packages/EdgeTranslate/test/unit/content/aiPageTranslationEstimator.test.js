import {
    EMA_ALPHA,
    OUTPUT_CEILING_SAFETY_FACTOR,
    OUT_RATIO_PINNED,
    OUT_RATIO_SEED,
    OUT_RATIO_SOURCE_FLOOR,
    createEstimator,
    estIn,
    outRatioForPair,
} from "../../../src/content/ai_page_translation/ir/estimator.js";

describe("vNext AI page translation estimator (spec §4.1)", () => {
    describe("estIn — THE one formula", () => {
        it("computes ceil(cjk*0.8 + other/3.6) exactly for Latin, CJK and mixed strings", () => {
            expect(estIn("hello")).toBe(2); // ceil(5/3.6)
            expect(estIn("hello world")).toBe(4); // ceil(11/3.6)
            expect(estIn("駅路線案内")).toBe(4); // ceil(5*0.8)
            expect(estIn("駅路線案内 123")).toBe(6); // ceil(5*0.8 + 4/3.6)
            expect(estIn("")).toBe(0);
            expect(estIn(null)).toBe(0);
        });

        it("weights hiragana, katakana, ideographs and hangul as CJK", () => {
            expect(estIn("こんにちは")).toBe(4); // ceil(5*0.8)
            expect(estIn("カタカナ")).toBe(4); // ceil(4*0.8) = 3.2 -> 4
            expect(estIn("안녕하세요")).toBe(4); // ceil(5*0.8)
            expect(estIn("京阪電気鉄道")).toBe(5); // ceil(6*0.8)
        });
    });

    describe("outRatio table", () => {
        it("returns the pinned ko entries and the 1.15 seed for un-floored sources", () => {
            expect(outRatioForPair("ja", "ko")).toBe(1.9);
            expect(outRatioForPair("zh", "ko")).toBe(1.8);
            expect(outRatioForPair("en", "ja")).toBe(1.3);
            expect(outRatioForPair("en", "de")).toBe(1.25);
            expect(outRatioForPair("en", "ko")).toBe(OUT_RATIO_SEED);
            expect(OUT_RATIO_PINNED).toEqual({
                "ja-ko": 1.9,
                "ja-en": 1.6,
                "zh-ko": 1.8,
                "zh-en": 1.5,
                "en-ja": 1.3,
                "en-de": 1.25,
            });
        });

        it("floors every ja source to >=1.8 and every zh source to >=1.7", () => {
            expect(OUT_RATIO_SOURCE_FLOOR).toEqual({ ja: 1.8, zh: 1.7 });
            // Floor supersedes the lower legacy en-target pins.
            expect(outRatioForPair("ja", "en")).toBe(1.8);
            expect(outRatioForPair("zh", "en")).toBe(1.7);
            // Floor also governs unpinned ja/zh targets.
            expect(outRatioForPair("ja", "de")).toBe(1.8);
            expect(outRatioForPair("zh", "fr")).toBe(1.7);
            // Pinned ko pairs already clear the floor.
            expect(outRatioForPair("ja", "ko")).toBe(1.9);
        });

        it("ignores region subtags and casing when resolving the pair", () => {
            expect(outRatioForPair("zh-CN", "en-US")).toBe(1.7);
            expect(outRatioForPair("JA", "EN")).toBe(1.8);
            expect(outRatioForPair("en_GB", "de_DE")).toBe(1.25);
        });
    });

    describe("planPacketBudget", () => {
        it("prices packet input as Σ estIn + 7/item + 180 fixed + ctx tokens", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            const budget = estimator.planPacketBudget(["hello", "駅路線案内"], 20);
            // (2 + 4) + 2*7 + 180 + 20
            expect(budget.estInTokens).toBe(220);
            expect(budget.itemCount).toBe(2);
        });

        it("prices packet output as Σ estIn*outRatio + 4/item using the resolved pair ratio", () => {
            const koPair = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            // ja-ko pin 1.9: ceil((2+4)*1.9 + 8) = ceil(19.4)
            expect(koPair.planPacketBudget(["hello", "駅路線案内"]).estOutTokens).toBe(20);
            const flooredPair = createEstimator({ sl: "ja", tl: "en", provider: "googleAiStudio" });
            // ja-en floored to 1.8: ceil((2+4)*1.8 + 8) = ceil(18.8)
            expect(flooredPair.planPacketBudget(["hello", "駅路線案内"]).estOutTokens).toBe(19);
        });

        it("adds the +60 incidental reasoning budget for openai only", () => {
            const openai = createEstimator({ sl: "ja", tl: "en", provider: "openai" });
            // ja-en floored to 1.8: ceil((2+4)*1.8 + 8 + 60) = ceil(78.8)
            expect(openai.planPacketBudget(["hello", "駅路線案内"]).estOutTokens).toBe(79);
            const compat = createEstimator({ sl: "ja", tl: "en", provider: "openaiCompatible" });
            expect(compat.planPacketBudget(["hello", "駅路線案内"]).estOutTokens).toBe(19);
        });

        it("accepts item objects carrying text/source/s fields", () => {
            const estimator = createEstimator({ sl: "en", tl: "ko", provider: "googleAiStudio" });
            const fromStrings = estimator.planPacketBudget(["hello", "world"]);
            const fromObjects = estimator.planPacketBudget([
                { text: "hello" },
                { source: "world" },
            ]);
            expect(fromObjects).toEqual(fromStrings);
        });
    });

    describe("preflight calibration (drain-lane countTokens)", () => {
        it("scales input estimates by actual/estimated and leaves output untouched", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            const before = estimator.planPacketBudget(["hello", "駅路線案内"], 20);
            expect(before.estInTokens).toBe(220);

            const factor = estimator.applyPreflightCalibration(330, 220);
            expect(factor).toBe(1.5);
            const after = estimator.planPacketBudget(["hello", "駅路線案内"], 20);
            expect(after.estInTokens).toBe(330); // ceil(220 * 1.5)
            expect(after.estOutTokens).toBe(before.estOutTokens);
        });

        it("clamps corrupt ratios and ignores unusable preflight numbers", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            expect(estimator.applyPreflightCalibration(1, 1000)).toBe(0.25);
            expect(estimator.applyPreflightCalibration(100000, 10)).toBe(4);
            const current = estimator.state().inputCorrection;
            expect(estimator.applyPreflightCalibration(Number.NaN, 220)).toBe(current);
            expect(estimator.applyPreflightCalibration(220, 0)).toBe(current);
        });
    });

    describe("receipt EMA (alpha 0.3)", () => {
        it("seeds on the first receipt and re-sizes subsequent packet estimates", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            const base = estimator.planPacketBudget(["駅路線案内"]);
            // ja-ko outRatio 1.9: estOut = ceil(4*1.9 + 4) = ceil(11.6)
            expect(base).toMatchObject({ estInTokens: 191, estOutTokens: 12 });

            estimator.recordReceipt({ inputTokens: 382, outputTokens: 24 }, base);
            expect(estimator.state().emaIn).toEqual({ ratio: 2, samples: 1 });
            expect(estimator.state().emaOut).toEqual({ ratio: 2, samples: 1 });

            const resized = estimator.planPacketBudget(["駅路線案内"]);
            expect(resized.estInTokens).toBe(382); // ceil(191 * 2)
            expect(resized.estOutTokens).toBe(24); // ceil((4*1.9 + 4) * 2)
        });

        it("calibrates from the normalized provider receipt field shape", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            const estimates = { estInTokens: 100, estOutTokens: 10 };
            const receipt = {
                inputTokens: { value: 200, source: "provider-reported" },
                outputTokens: { value: 20, source: "provider-reported" },
            };

            estimator.recordReceipt(receipt, estimates);
            estimator.recordReceipt(receipt, estimates);
            estimator.recordReceipt(receipt, estimates);

            expect(estimator.state().emaIn).toEqual({ ratio: 2, samples: 3 });
            expect(estimator.state().emaOut).toEqual({ ratio: 2, samples: 3 });
            expect(estimator.outputCeilingFactor()).toBe(0.9);
        });

        it("converges with EMA_ALPHA weighting on later receipts", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            estimator.recordReceipt(
                { inputTokens: 200, outputTokens: 20 },
                { estInTokens: 100, estOutTokens: 10 }
            );
            estimator.recordReceipt(
                { inputTokens: 100, outputTokens: 10 },
                { estInTokens: 100, estOutTokens: 10 }
            );
            const second = EMA_ALPHA * 1 + (1 - EMA_ALPHA) * 2;
            expect(estimator.state().emaOut.ratio).toBe(second);
            estimator.recordReceipt(
                { inputTokens: 100, outputTokens: 10 },
                { estInTokens: 100, estOutTokens: 10 }
            );
            expect(estimator.state().emaOut.ratio).toBe(EMA_ALPHA * 1 + (1 - EMA_ALPHA) * second);
            expect(estimator.state().emaOut.samples).toBe(3);
        });

        it("clamps receipt ratios and skips unusable receipts", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            estimator.recordReceipt(
                { inputTokens: 100000, outputTokens: 1 },
                { estInTokens: 10, estOutTokens: 1000 }
            );
            expect(estimator.state().emaIn.ratio).toBe(4);
            expect(estimator.state().emaOut.ratio).toBe(0.25);
            estimator.recordReceipt({}, { estInTokens: 10, estOutTokens: 10 });
            expect(estimator.state().emaIn.samples).toBe(1);
            expect(estimator.state().emaOut.samples).toBe(1);
        });
    });

    describe("0.9 output-ceiling safety factor gating", () => {
        it("stays at 1 until the output EMA has 3 samples, then drops to 0.9", () => {
            const estimator = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            const receipt = { outputTokens: 10 };
            const estimates = { estOutTokens: 10 };
            expect(estimator.outputCeilingFactor()).toBe(1);
            estimator.recordReceipt(receipt, estimates);
            expect(estimator.outputCeilingFactor()).toBe(1);
            estimator.recordReceipt(receipt, estimates);
            expect(estimator.outputCeilingFactor()).toBe(1);
            expect(estimator.planPacketBudget(["hello"]).outputCeilingFactor).toBe(1);
            estimator.recordReceipt(receipt, estimates);
            expect(estimator.outputCeilingFactor()).toBe(OUTPUT_CEILING_SAFETY_FACTOR);
            expect(estimator.planPacketBudget(["hello"]).outputCeilingFactor).toBe(
                OUTPUT_CEILING_SAFETY_FACTOR
            );
            // Input-side samples alone never activate the factor.
            const inputOnly = createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
            for (let i = 0; i < 4; i += 1) {
                inputOnly.recordReceipt({ inputTokens: 10 }, { estInTokens: 10 });
            }
            expect(inputOnly.outputCeilingFactor()).toBe(1);
        });
    });

    describe("state()", () => {
        it("exposes pair, provider, calibration chain and EMA state", () => {
            const estimator = createEstimator({ sl: "ja-JP", tl: "en-US", provider: "openai" });
            estimator.applyPreflightCalibration(150, 100);
            estimator.recordReceipt(
                { inputTokens: 200, outputTokens: 20 },
                { estInTokens: 100, estOutTokens: 10 }
            );
            const state = estimator.state();
            expect(state).toMatchObject({
                provider: "openai",
                sl: "ja",
                tl: "en",
                outRatio: 1.8,
                inputCorrection: 1.5,
                outputCeilingFactor: 1,
            });
            expect(state.inputCalibration).toBe(1.5 * 2);
            expect(state.outputCalibration).toBe(2);
        });
    });
});
