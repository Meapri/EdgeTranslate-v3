/**
 * The one token estimator for the vNext AI page translation engine (spec §4.1).
 *
 * All four legacy formulas are deleted; every packet sizing, budget and ceiling decision flows
 * through this module. The constants below are the single source in code — the pin record lives
 * in tools/vnext-gates/config.json (`estimator` section) and Gate A asserts they stay in sync.
 *
 * Runtime truth loop: the heuristic sizes every drain packet without an extra provider
 * `countTokens` request. Each UsageReceipt refines per-provider EMAs of actual/estimated input
 * and output via `recordReceipt`, and the planner re-sizes subsequent packets from calibrated
 * estimates. `applyPreflightCalibration` remains only as a compatibility/testing hook for older
 * callers; the active vNext session never invokes it. Safety margins collapse to the single
 * 0.9 output-ceiling factor once the output EMA has >= 3 samples.
 */

// Proven CJK class carried from the v2 estimator: hiragana/katakana, CJK ext A + unified
// ideographs, hangul syllables.
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;

const CJK_TOKENS_PER_CHAR = 0.8;
const OTHER_CHARS_PER_TOKEN = 3.6;
const PER_ITEM_INPUT_TOKENS = 7;
const FIXED_INPUT_TOKENS = 180;
const PER_ITEM_OUTPUT_TOKENS = 4;
const OUT_RATIO_SEED = 1.15;
const OUT_RATIO_PINNED = Object.freeze({
    "ja-ko": 1.9,
    "ja-en": 1.6,
    "zh-ko": 1.8,
    "zh-en": 1.5,
    "en-ja": 1.3,
    "en-de": 1.25,
});
// Source-language output-expansion floor. Japanese/Chinese SOURCE tokenizes densely (0.8
// tok/char), so ja->* / zh->* generate far more OUTPUT tokens per source token than the seed
// or the older en-target pins assumed. Under-predicting est-out oversizes packets and the
// tight max_output derived from est-out truncates them, so each truncation splits into a new
// request. This floor governs every pair with the given source, superseding any lower legacy
// pin (ja-en 1.6 -> 1.8, zh-en 1.5 -> 1.7) so packets are sized from realistic output.
const OUT_RATIO_SOURCE_FLOOR = Object.freeze({ ja: 1.8, zh: 1.7 });
const EMA_ALPHA = 0.3;
const OUTPUT_CEILING_SAFETY_FACTOR = 0.9;
const SAFETY_FACTOR_MIN_SAMPLES = 3;
const OPENAI_INCIDENTAL_REASONING_OUT_TOKENS = 60;

// Calibration ratios are clamped so one corrupt receipt can never blow planning up or starve it.
const CALIBRATION_RATIO_FLOOR = 0.25;
const CALIBRATION_RATIO_CEILING = 4;

/** THE formula (spec §4.1): estIn(text) = ceil(cjkChars*0.8 + otherChars/3.6). */
function estIn(text) {
    const value = String(text ?? "");
    if (!value) return 0;
    const cjkChars = (value.match(CJK_CHAR_PATTERN) || []).length;
    const otherChars = value.length - cjkChars;
    return Math.ceil(cjkChars * CJK_TOKENS_PER_CHAR + otherChars / OTHER_CHARS_PER_TOKEN);
}

function primaryLanguageSubtag(language) {
    return String(language || "")
        .trim()
        .toLowerCase()
        .split(/[-_]/)[0];
}

/**
 * Pinned-table lookup with the 1.15 seed fallback, then raised to the per-source floor; region
 * subtags never fork the table. The floor makes any ja source >= 1.8 and any zh source >= 1.7,
 * so an unpinned ja/zh target is still sized from realistic output expansion.
 */
function outRatioForPair(sourceLanguage, targetLanguage) {
    const source = primaryLanguageSubtag(sourceLanguage);
    const pair = `${source}-${primaryLanguageSubtag(targetLanguage)}`;
    const base = OUT_RATIO_PINNED[pair] ?? OUT_RATIO_SEED;
    return Math.max(base, OUT_RATIO_SOURCE_FLOOR[source] ?? 0);
}

function clampCalibrationRatio(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    return Math.min(CALIBRATION_RATIO_CEILING, Math.max(CALIBRATION_RATIO_FLOOR, ratio));
}

function itemText(item) {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
        if (typeof item.text === "string") return item.text;
        if (typeof item.source === "string") return item.source;
        if (typeof item.s === "string") return item.s;
    }
    return "";
}

function receiptNumber(...candidates) {
    for (const candidate of candidates) {
        // Production adapters normalize usage as `{ value, source }`; focused planner tests
        // historically used bare numbers. Accept both shapes so live receipts actually advance
        // the EMA instead of silently leaving every calibration sample at zero.
        const raw =
            candidate && typeof candidate === "object" && "value" in candidate
                ? candidate.value
                : candidate;
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) return value;
    }
    return null;
}

/**
 * Creates the per-session estimator. `provider` selects provider-specific incidentals (OpenAI
 * reasoning) and labels the EMA state; `sl`/`tl` select the pinned output ratio.
 *
 * Returned surface (spec-pinned): `estIn`, `planPacketBudget(items, ctxTokens)`,
 * `applyPreflightCalibration(actualIn, estimatedIn)`, `recordReceipt(receipt, estimates)`,
 * `state()` — plus the planner conveniences `estOutForText(text)` and `outputCeilingFactor()`
 * that expose the same single formula per item and the gated 0.9 ceiling factor.
 */
function createEstimator({ sl, tl, provider } = {}) {
    const outRatio = outRatioForPair(sl, tl);
    const state = {
        provider: String(provider || "unknown"),
        sl: primaryLanguageSubtag(sl),
        tl: primaryLanguageSubtag(tl),
        outRatio,
        // Optional compatibility calibration. The active vNext session leaves this at 1 and
        // learns from settled usage receipts instead of spending a preflight request.
        inputCorrection: 1,
        // Per-provider EMAs (alpha 0.3) of actual/estimated, updated from usage receipts. They
        // measure residual error against already-calibrated estimates, so they chain
        // multiplicatively with inputCorrection.
        emaIn: { ratio: 1, samples: 0 },
        emaOut: { ratio: 1, samples: 0 },
    };

    const inputCalibration = () =>
        state.inputCorrection * (state.emaIn.samples > 0 ? state.emaIn.ratio : 1);
    const outputCalibration = () => (state.emaOut.samples > 0 ? state.emaOut.ratio : 1);

    /** Calibrated per-item output estimate: estIn(text)*outRatio + 4, scaled by the output EMA. */
    const estOutForText = (text) =>
        Math.ceil((estIn(text) * outRatio + PER_ITEM_OUTPUT_TOKENS) * outputCalibration());

    /**
     * Packet-level budget (spec §4.1):
     *   input  = (Σ estIn + 7/item + 180 fixed + ctxTokens) × input calibration
     *   output = (Σ estIn×outRatio + 4/item [+60 OpenAI incidental]) × output calibration
     */
    const planPacketBudget = (items, ctxTokens = 0) => {
        const texts = (Array.isArray(items) ? items : []).map(itemText);
        const sourceTokens = texts.reduce((sum, text) => sum + estIn(text), 0);
        const ctx = Number.isFinite(ctxTokens) && ctxTokens > 0 ? ctxTokens : 0;
        const rawIn =
            sourceTokens + texts.length * PER_ITEM_INPUT_TOKENS + FIXED_INPUT_TOKENS + ctx;
        const incidental = state.provider === "openai" ? OPENAI_INCIDENTAL_REASONING_OUT_TOKENS : 0;
        const rawOut = sourceTokens * outRatio + texts.length * PER_ITEM_OUTPUT_TOKENS + incidental;
        return {
            itemCount: texts.length,
            estInTokens: Math.ceil(rawIn * inputCalibration()),
            estOutTokens: Math.ceil(rawOut * outputCalibration()),
            outputCeilingFactor:
                state.emaOut.samples >= SAFETY_FACTOR_MIN_SAMPLES
                    ? OUTPUT_CEILING_SAFETY_FACTOR
                    : 1,
        };
    };

    /** Compatibility hook for older callers/tests; not used by the active vNext session. */
    const applyPreflightCalibration = (actualIn, estimatedIn) => {
        const actual = receiptNumber(actualIn);
        const estimated = receiptNumber(estimatedIn);
        if (actual === null || !estimated) return state.inputCorrection;
        const factor = clampCalibrationRatio(actual / estimated);
        if (factor !== null) state.inputCorrection = factor;
        return state.inputCorrection;
    };

    const updateEma = (ema, actual, estimated) => {
        if (actual === null || !estimated) return;
        const ratio = clampCalibrationRatio(actual / estimated);
        if (ratio === null) return;
        ema.ratio = ema.samples === 0 ? ratio : EMA_ALPHA * ratio + (1 - EMA_ALPHA) * ema.ratio;
        ema.samples += 1;
    };

    /**
     * Settled UsageReceipt feedback: `receipt` carries actual token counts,
     * `estimates` the planned (already-calibrated) counts recorded at dispatch.
     */
    const recordReceipt = (receipt, estimates) => {
        updateEma(
            state.emaIn,
            receiptNumber(receipt?.inputTokens, receipt?.promptTokens),
            receiptNumber(estimates?.estInTokens, estimates?.inputTokens)
        );
        updateEma(
            state.emaOut,
            receiptNumber(receipt?.outputTokens, receipt?.completionTokens),
            receiptNumber(estimates?.estOutTokens, estimates?.outputTokens)
        );
        return {
            emaIn: { ...state.emaIn },
            emaOut: { ...state.emaOut },
        };
    };

    /** Single 0.9 output-ceiling safety factor, active only after >= 3 output EMA samples. */
    const outputCeilingFactor = () =>
        state.emaOut.samples >= SAFETY_FACTOR_MIN_SAMPLES ? OUTPUT_CEILING_SAFETY_FACTOR : 1;

    return {
        estIn,
        estOutForText,
        planPacketBudget,
        applyPreflightCalibration,
        recordReceipt,
        outputCeilingFactor,
        state: () => ({
            provider: state.provider,
            sl: state.sl,
            tl: state.tl,
            outRatio: state.outRatio,
            inputCorrection: state.inputCorrection,
            inputCalibration: inputCalibration(),
            outputCalibration: outputCalibration(),
            emaIn: { ...state.emaIn },
            emaOut: { ...state.emaOut },
            outputCeilingFactor: outputCeilingFactor(),
        }),
    };
}

export {
    CJK_TOKENS_PER_CHAR,
    EMA_ALPHA,
    FIXED_INPUT_TOKENS,
    OPENAI_INCIDENTAL_REASONING_OUT_TOKENS,
    OTHER_CHARS_PER_TOKEN,
    OUTPUT_CEILING_SAFETY_FACTOR,
    OUT_RATIO_PINNED,
    OUT_RATIO_SEED,
    OUT_RATIO_SOURCE_FLOOR,
    PER_ITEM_INPUT_TOKENS,
    PER_ITEM_OUTPUT_TOKENS,
    SAFETY_FACTOR_MIN_SAMPLES,
    createEstimator,
    estIn,
    outRatioForPair,
};
