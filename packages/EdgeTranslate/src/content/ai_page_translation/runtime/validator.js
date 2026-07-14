/**
 * Semantic output validator for the vNext AI page translation engine — the spec §6
 * strictness table, implemented tier by tier. Port of
 * ai_page_translation_v2/runtime/validator.js widened from binary ok/reason to the
 * three-tier policy:
 *
 * - hard-fail: placeholder inventory (routes to the §1.4 ladder), URLs / emails / code
 *   spans / identifiers byte-exact after trim + percent-decode, expansion >6× / collapse
 *   <12%, long-prose zero-target-script, prose source-echo where "=" was available and
 *   unused, and unverifiable "=" claims. (JSON/schema/id problems never reach this module —
 *   wire.ts parsing owns them upstream.)
 * - normalize-before-compare: numbers (grouping separators stripped, decimal comma/point
 *   unified, full/half-width digits unified — `1,000→1000` and `3.5→3,5` are legal, the
 *   measured Gemini false-positive class), the numeric part of unit expressions, and chunk
 *   reassembly seams.
 * - warn+accept with NAMED telemetry counters: warn_accept_unit_word, warn_accept_script,
 *   warn_accept_echo, warn_accept_length_ratio. Every softening emits its counter so
 *   strictness is ratcheted from ledger data, never from frozen guesses.
 *
 * Verdict shape: `{ verdict: "accept"|"acceptWithWarnings"|"fail", failures: [{class,
 * detail}], warnings: [names], telemetry }`. This module never throws on model output.
 */

import { placeholderInventoryMatches } from "@edge_translate/translators";

import { PLACEHOLDER_GRAMMAR, parseTranslatedBlock } from "../dom/block_ir.js";

const WARN_ACCEPT_UNIT_WORD = "warn_accept_unit_word";
const WARN_ACCEPT_SCRIPT = "warn_accept_script";
const WARN_ACCEPT_ECHO = "warn_accept_echo";
const WARN_ACCEPT_LENGTH_RATIO = "warn_accept_length_ratio";
const WARN_ACCEPT_NUMBER = "warn_accept_number";

// Hard length bounds (spec §6): the >6× / <12% pair caught real hallucinations. The
// max(120, …) / >=120 guards keep tiny strings (dates, labels) out of ratio math.
const EXPANSION_HARD_RATIO = 6;
const EXPANSION_MIN_RESULT_CHARS = 120;
const COLLAPSE_HARD_RATIO = 0.12;
const COLLAPSE_MIN_SOURCE_CHARS = 120;
// Warn-tier outlier pins (within the hard bounds).
const RATIO_WARN_EXPANSION = 3;
const RATIO_WARN_EXPANSION_MIN_CHARS = 60;
const RATIO_WARN_COLLAPSE = 0.25;
const RATIO_WARN_COLLAPSE_MIN_CHARS = 60;
// Script/echo carve-outs (spec §6): short items and Latin/digit/code-heavy blocks (brands,
// code, model numbers) legitimately survive translation unchanged.
const SHORT_ITEM_CHARS = 40;
const LATIN_HEAVY_RATIO = 0.6;
const ECHO_HARD_MIN_CHARS = 12;

function normalizedText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Chunk-boundary normalization (spec §6): oversized-block reassembly compares seam text
 * through this exact helper so token splits across chunk seams never produce phantom
 * mismatches.
 */
function normalizeChunkSeam(value) {
    return normalizedText(value);
}

function targetScriptPattern(language) {
    const code = String(language || "").toLowerCase();
    if (code.startsWith("ko")) return /[\uac00-\ud7af]/;
    if (code.startsWith("ja")) return /[\u3040-\u30ff]/;
    if (code.startsWith("zh")) return /[\u3400-\u9fff]/;
    if (code.startsWith("ru")) return /[\u0400-\u04ff]/;
    if (code.startsWith("ar")) return /[\u0600-\u06ff]/;
    if (code.startsWith("he")) return /[\u0590-\u05ff]/;
    if (code.startsWith("th")) return /[\u0e00-\u0e7f]/;
    return null;
}

function hasStrongSourceScript(text, targetLanguage) {
    const value = String(text || "");
    const code = String(targetLanguage || "").toLowerCase();
    if (code.startsWith("ko")) return /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(value);
    if (code.startsWith("ja")) return /[A-Za-z\uac00-\ud7af]/.test(value);
    if (code.startsWith("zh")) return /[A-Za-z\u3040-\u30ff\uac00-\ud7af]/.test(value);
    return /[\p{L}]/u.test(value);
}

function isSubstantiveSource(text) {
    const value = normalizedText(text);
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    const latinOnly =
        /[A-Za-z]/.test(value) && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(value);
    return latinOnly ? value.length >= 28 || wordCount >= 5 : value.length >= 8 || wordCount >= 3;
}

function isIdentifierLike(text) {
    const value = normalizedText(text);
    // CJK prose commonly has no spaces, so a Unicode-letter-only pattern misclassifies an
    // entire short sentence as an identifier and accepts a provider source echo. Runtime
    // protected identifiers use the same ASCII/model-number domain as the wire validator.
    return Boolean(value && !/\s/.test(value) && /^[A-Za-z0-9_.:/+#@-]+$/.test(value));
}

/** Share of non-whitespace characters that are printable ASCII (Latin/digits/code). */
function latinHeavyRatio(text) {
    const chars = String(text || "").replace(/\s+/g, "");
    if (!chars.length) return 0;
    const ascii = chars.match(/[\x21-\x7e]/g);
    return (ascii ? ascii.length : 0) / Array.from(chars).length;
}

/** "="-eligibility detector: the string is plausibly already in the target language. */
function isLikelyTargetLanguage(text, targetLanguage) {
    const pattern = targetScriptPattern(targetLanguage);
    return Boolean(pattern && pattern.test(text) && !hasStrongSourceScript(text, targetLanguage));
}

function stripPlaceholders(text) {
    return String(text ?? "").replace(new RegExp(PLACEHOLDER_GRAMMAR.source, "g"), " ");
}

function safePercentDecode(text) {
    try {
        return decodeURIComponent(String(text ?? ""));
    } catch {
        return String(text ?? "");
    }
}

const FULLWIDTH_DIGIT = /[\uff10-\uff19]/g;

function toHalfWidthDigits(text) {
    return String(text ?? "").replace(FULLWIDTH_DIGIT, (digit) =>
        String.fromCharCode(digit.charCodeAt(0) - 0xfee0)
    );
}

/**
 * Canonical numeric form (spec §6 normalize-before-compare): full-width digits unified to
 * half-width, grouping separators stripped, decimal comma/point unified to ".". A separator
 * chain is grouping iff the leading group has 1-3 digits and every following group exactly
 * 3 ("1,000"→"1000", "12.345.678"→"12345678"); otherwise the final separator is the decimal
 * mark ("3,5"→"3.5", "1,234.5"→"1234.5").
 */
function canonicalNumber(token) {
    const text = toHalfWidthDigits(String(token ?? "")).replace(/[.,]+$/, "");
    const parts = text.split(/[.,]/);
    if (parts.length === 1) return parts[0];
    const grouping =
        parts[0].length >= 1 &&
        parts[0].length <= 3 &&
        parts.slice(1).every((part) => part.length === 3);
    if (grouping) return parts.join("");
    return `${parts.slice(0, -1).join("")}.${parts[parts.length - 1]}`;
}

const NUMBER_TOKEN = /[0-9\uff10-\uff19][0-9\uff10-\uff19.,]*/g;

function extractNumbers(text) {
    const numbers = new Set();
    for (const match of String(text ?? "").matchAll(NUMBER_TOKEN)) {
        const canonical = canonicalNumber(match[0]);
        if (canonical) numbers.add(canonical);
    }
    return numbers;
}

// Byte-exact protected tokens (after trim + percent-decode). Identifiers = letter-led
// tokens containing at least one digit (KH01, RFC2616, sha-256), the v2 detector.
const URL_TOKEN = /https?:\/\/[^\s<>"'\uff09)\]]+/g;
const EMAIL_TOKEN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CODE_SPAN_TOKEN = /`[^`\n]+`/g;
const IDENTIFIER_TOKEN = /\b[A-Za-z][A-Za-z0-9_.-]*\d[A-Za-z0-9_.-]*\b/g;

// The SINGLE definition of the byte-exact hard-fail class, in application order (URL first so
// a URL whose tail looks identifier-shaped is taken whole; identifier last). This is the shared
// source of truth: runtime/protected_tokens.js masks EXACTLY this set as local `<kN/>`
// placeholders before send and restores it verbatim after the reply, so "masked set ==
// validated set" and the model can never corrupt a protected value. Trailing sentence
// punctuation is trimmed off URL matches so the punctuation stays translatable/positional.
const PROTECTED_TOKEN_MATCHERS = Object.freeze([
    Object.freeze({ tokenClass: "url", pattern: URL_TOKEN, trimTrailing: true }),
    Object.freeze({ tokenClass: "email", pattern: EMAIL_TOKEN, trimTrailing: false }),
    Object.freeze({ tokenClass: "code", pattern: CODE_SPAN_TOKEN, trimTrailing: false }),
    Object.freeze({ tokenClass: "identifier", pattern: IDENTIFIER_TOKEN, trimTrailing: false }),
]);

const PROTECTED_TRAILING_PUNCT = /[),.;:!?]+$/;

/**
 * Position-aware protected-span finder over a RAW string — the masking-side counterpart of
 * extractProtectedExacts, sharing PROTECTED_TOKEN_MATCHERS so both agree on the set. Returns
 * ordered, non-overlapping `{ start, end, token, tokenClass }` where `[start, end)` is the exact
 * byte span to mask (trailing punctuation excluded). Matches are sequenced exactly like
 * extractProtectedExacts: each matcher runs over the text with earlier full matches blanked, so
 * a later class can never re-claim characters an earlier class already took.
 */
function findProtectedSpans(text) {
    const source = String(text ?? "");
    let working = source;
    const spans = [];
    for (const { tokenClass, pattern, trimTrailing } of PROTECTED_TOKEN_MATCHERS) {
        const regex = new RegExp(pattern.source, "g");
        const blanks = [];
        let match;
        while ((match = regex.exec(working)) !== null) {
            if (match[0].length === 0) {
                regex.lastIndex += 1;
                continue;
            }
            const fullStart = match.index;
            const fullEnd = match.index + match[0].length;
            let token = match[0];
            let end = fullEnd;
            if (trimTrailing) {
                token = token.replace(PROTECTED_TRAILING_PUNCT, "");
                end = fullStart + token.length;
            }
            if (token) spans.push({ start: fullStart, end, token, tokenClass });
            blanks.push([fullStart, fullEnd]);
        }
        if (blanks.length) {
            const chars = working.split("");
            for (const [start, end] of blanks) {
                for (let index = start; index < end; index += 1) chars[index] = " ";
            }
            working = chars.join("");
        }
    }
    spans.sort((a, b) => a.start - b.start);
    return spans;
}

/**
 * Extracts byte-exact classes from the (placeholder-stripped) source and blanks them out,
 * so the number tier below only sees free-standing numbers — digits inside a URL or a model
 * number are already covered by their byte-exact token. Shares PROTECTED_TOKEN_MATCHERS with
 * the masking path (findProtectedSpans) so the validated set is exactly the masked set.
 */
function extractProtectedExacts(text) {
    let rest = String(text ?? "");
    const tokens = [];
    for (const { tokenClass, pattern, trimTrailing } of PROTECTED_TOKEN_MATCHERS) {
        rest = rest.replace(new RegExp(pattern.source, "g"), (match) => {
            const token = trimTrailing ? match.replace(PROTECTED_TRAILING_PUNCT, "") : match;
            if (token) tokens.push({ tokenClass, token });
            return " ";
        });
    }
    return { tokens, rest };
}

// Unit expressions: number + unit symbol. The numeric part is validated through the number
// tier; the unit word itself is free to translate (§6 — warn_accept_unit_word). Highly
// ambiguous single letters that collide with English words ("in", "s", "t") are omitted.
const UNIT_NUMBER_TOKEN =
    /([0-9\uff10-\uff19][0-9\uff10-\uff19.,]*)[ \u00a0\u3000]?(km²|m²|km\/h|GHz|MHz|kHz|Hz|km|cm|mm|nm|kg|mg|min|ms|mi|kV|kW|KB|MB|GB|TB|°C|°F|%|‰|m|g|V|W|h|ft|lb|oz|px|pt)(?![A-Za-z0-9²/])/g;

/**
 * Validates one translated item against the §6 strictness table.
 *
 * `item`: `{ source, translated, keepSource, placeholderInventory }` — `keepSource` is the
 * wire.ts flag for the "=" sentinel, `placeholderInventory` the block_ir serialize-time
 * inventory (`{ tags: [...] }`) when the item is a multi-Text-node block.
 * `options`: `{ targetLanguage, onTelemetry }`.
 */
function validateTranslatedItem(item = {}, options = {}) {
    const failures = [];
    const warnings = [];
    const telemetry = {
        [WARN_ACCEPT_UNIT_WORD]: 0,
        [WARN_ACCEPT_SCRIPT]: 0,
        [WARN_ACCEPT_ECHO]: 0,
        [WARN_ACCEPT_LENGTH_RATIO]: 0,
        [WARN_ACCEPT_NUMBER]: 0,
    };
    const warn = (name, detail) => {
        warnings.push(name);
        telemetry[name] += 1;
        if (typeof options.onTelemetry === "function") options.onTelemetry(name, detail);
    };
    const fail = (failureClass, detail) => {
        failures.push({ class: failureClass, detail: detail ?? null });
    };
    const result = () => ({
        verdict: failures.length ? "fail" : warnings.length ? "acceptWithWarnings" : "accept",
        failures,
        warnings,
        telemetry,
    });

    const source = String(item.source ?? "");
    const translated = String(item.translated ?? "");
    const targetLanguage = options.targetLanguage;
    const normalizedSource = normalizedText(stripPlaceholders(source));
    const normalizedResult = normalizedText(stripPlaceholders(translated));

    // "=" keep-source sentinel (spec §1.2): a "=" item always DISPLAYS the source text, so the
    // worst realistic outcome of accepting it is showing source — exactly what a terminal
    // keep-source failure would show anyway, but without a paid retry and without a failed
    // count. When we cannot positively confirm the string is already target-language (identity
    // drift, or substantive source-language prose), WARN+ACCEPT instead of hard-failing so dense
    // pages reach zero failed strings. Genuine emptiness is still caught below for non-"=" items.
    if (item.keepSource) {
        if (normalizedText(translated) !== normalizedText(source)) {
            // "=" but the reply text drifted from source. The sentinel keeps source regardless;
            // accept-with-warning rather than route to a retry that leaves it untranslated.
            warn(WARN_ACCEPT_ECHO, "keep-source-identity");
            return result();
        }
        const eligible =
            isLikelyTargetLanguage(normalizedSource, targetLanguage) ||
            latinHeavyRatio(normalizedSource) >= LATIN_HEAVY_RATIO ||
            normalizedSource.length <= ECHO_HARD_MIN_CHARS ||
            !isSubstantiveSource(normalizedSource) ||
            !hasStrongSourceScript(normalizedSource, targetLanguage);
        if (!eligible) {
            warn(WARN_ACCEPT_ECHO, "keep-source-unverified");
        }
        return result();
    }

    if (!normalizedResult) {
        fail("empty");
        return result();
    }

    // Placeholder fidelity (spec §1.3 layer 4): serialize-time inventory when the caller has
    // one, wire-level multiset+balance equality otherwise. A failure here routes the block
    // into the §1.4 ladder; the validator only reports it.
    const inventory = item.placeholderInventory || options.placeholderInventory || null;
    const grammar = new RegExp(PLACEHOLDER_GRAMMAR.source);
    if (inventory) {
        const parsed = parseTranslatedBlock(translated, inventory);
        if (!parsed.ok) fail("placeholder", parsed.failure);
    } else if (grammar.test(source) || grammar.test(translated)) {
        if (!placeholderInventoryMatches(source, translated)) {
            fail("placeholder", "tag inventory mismatch");
        }
    }

    // Length tiers: >6× / <12% hard-fail, outliers within bounds warn+accept.
    if (
        normalizedResult.length >
        Math.max(EXPANSION_MIN_RESULT_CHARS, normalizedSource.length * EXPANSION_HARD_RATIO)
    ) {
        fail("length-expansion", `${normalizedSource.length}->${normalizedResult.length}`);
    } else if (
        normalizedSource.length >= COLLAPSE_MIN_SOURCE_CHARS &&
        normalizedResult.length < normalizedSource.length * COLLAPSE_HARD_RATIO
    ) {
        fail("length-collapse", `${normalizedSource.length}->${normalizedResult.length}`);
    } else if (
        (normalizedResult.length > normalizedSource.length * RATIO_WARN_EXPANSION &&
            normalizedResult.length > RATIO_WARN_EXPANSION_MIN_CHARS) ||
        (normalizedSource.length >= RATIO_WARN_COLLAPSE_MIN_CHARS &&
            normalizedResult.length < normalizedSource.length * RATIO_WARN_COLLAPSE)
    ) {
        warn(WARN_ACCEPT_LENGTH_RATIO, `${normalizedSource.length}->${normalizedResult.length}`);
    }

    // Byte-exact tier: URLs, emails, code spans, identifiers — exact after trim +
    // percent-decode on both sides.
    const { tokens: exactTokens, rest: sourceRest } = extractProtectedExacts(normalizedSource);
    const decodedResult = safePercentDecode(normalizedResult);
    for (const { tokenClass, token } of exactTokens) {
        const wanted = safePercentDecode(token.trim());
        if (!normalizedResult.includes(token) && !decodedResult.includes(wanted)) {
            fail(tokenClass, token);
        }
    }

    // Number tier: normalize-before-compare, then WARN+ACCEPT any residual mismatch. Canonical
    // form already unifies full/half width, grouping separators and decimal comma/point, and CJK
    // era/counter markers (年/月/日/両…) are non-digit and never enter a NUMBER_TOKEN, so
    // `2023年→2023년` compares as `2023`==`2023`. A genuinely reformatted or dropped value
    // (rounding, ranges) is rare and a translated string with a reformatted number is strictly
    // better than untranslated source, so it accepts with a named warning rather than hard-fail
    // -> paid semantic retry -> kept source. Real corruption still surfaces in the ledger.
    const resultNumbers = extractNumbers(normalizedResult);
    for (const number of extractNumbers(sourceRest)) {
        if (!resultNumbers.has(number)) warn(WARN_ACCEPT_NUMBER, number);
    }

    // Unit tier: numeric part already validated above; a translated unit word is legal but
    // counted.
    const seenUnits = new Set();
    for (const match of sourceRest.matchAll(UNIT_NUMBER_TOKEN)) {
        const unit = match[2];
        if (seenUnits.has(unit)) continue;
        seenUnits.add(unit);
        if (!resultNumbers.has(canonicalNumber(match[1]))) continue;
        if (!normalizedResult.includes(unit)) warn(WARN_ACCEPT_UNIT_WORD, unit);
    }

    // Echo tier: the model returned the source unchanged. We cannot positively confirm it is
    // already target-language, but keeping it (often a proper noun, an already-target string, or
    // code) is strictly better than a paid semantic retry that ends in untranslated source.
    // WARN+ACCEPT every echo; the script tier below must not then re-hard-fail this same
    // accepted string as a wrong-language translation.
    let sourceEcho = false;
    if (normalizedSource && normalizedSource === normalizedResult && !isIdentifierLike(source)) {
        sourceEcho = true;
        warn(WARN_ACCEPT_ECHO);
    }

    // Target-script tier: hard-fail only genuine (non-echo) long source-language prose that came
    // back with zero target-script characters — a real wrong-language translation. A source echo
    // is already accounted for as warn_accept_echo above and is never double-penalized here.
    const scriptPattern = targetScriptPattern(targetLanguage);
    if (!sourceEcho && scriptPattern && !scriptPattern.test(normalizedResult)) {
        if (
            normalizedSource.length < SHORT_ITEM_CHARS ||
            latinHeavyRatio(normalizedSource) >= LATIN_HEAVY_RATIO
        ) {
            warn(WARN_ACCEPT_SCRIPT);
        } else if (
            hasStrongSourceScript(normalizedSource, targetLanguage) &&
            isSubstantiveSource(normalizedSource)
        ) {
            fail("script");
        } else {
            warn(WARN_ACCEPT_SCRIPT);
        }
    }

    return result();
}

export {
    PROTECTED_TOKEN_MATCHERS,
    WARN_ACCEPT_ECHO,
    WARN_ACCEPT_LENGTH_RATIO,
    WARN_ACCEPT_NUMBER,
    WARN_ACCEPT_SCRIPT,
    WARN_ACCEPT_UNIT_WORD,
    canonicalNumber,
    extractNumbers,
    extractProtectedExacts,
    findProtectedSpans,
    hasStrongSourceScript,
    isIdentifierLike,
    isLikelyTargetLanguage,
    isSubstantiveSource,
    latinHeavyRatio,
    normalizeChunkSeam,
    normalizedText,
    targetScriptPattern,
    validateTranslatedItem,
};
