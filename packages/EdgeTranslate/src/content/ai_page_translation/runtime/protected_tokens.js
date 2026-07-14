/**
 * Protected-token local masking for the vNext AI page translation engine
 * (docs/AI_PAGE_TRANSLATION_LUNA_SPEED_RESEARCH.md "P0: make protected tokens local data").
 *
 * The validator hard-fails any item whose byte-exact protected tokens — URLs, emails, code
 * spans, model identifiers like "N100"/"DDR4"/"2.5GbE", version/path forms — were altered or
 * omitted by the model. On XDA this manufactured a whole retry-amplification class: five items
 * failed identifier validation, spent five paid semantic retries, and still kept source.
 *
 * The fix makes those exact tokens LOCAL DATA. Before a packet item's serialized source `s` is
 * sent, every protected span is replaced with a compact typed placeholder `<kN/>` and its exact
 * value is stashed in a per-item map. The model never sees the token — it translates the words
 * around an opaque placeholder it is told to copy verbatim — and after the reply the values are
 * restored locally, byte-for-byte. The validator's byte-exact tier then has nothing to fail on;
 * the semantic-retry class disappears and those strings translate correctly (zero-failed).
 *
 * `<kN/>` is a DISTINCT namespace from the block IR's `<gN>`/`<vN/>` placeholders: block IR only
 * parses its own grammar (dom/block_ir.js PLACEHOLDER_GRAMMAR = `/<\/?g\d+>|<v\d+\/>/`), so kN
 * passes through it untouched, and masking splits on that same grammar so it never disturbs a gN
 * or vN tag (and vice versa). The set of masked spans is EXACTLY the validator's byte-exact
 * hard-fail class: both share findProtectedSpans / PROTECTED_TOKEN_MATCHERS from validator.js, so
 * "masked set == validated set" is an invariant, not a coincidence. Plain integers are NOT
 * masked — the validator normalizes those and they are safe to localize.
 */

import { PLACEHOLDER_GRAMMAR } from "../dom/block_ir.js";
import { findProtectedSpans } from "./validator.js";

// Void placeholders in the protected-token namespace. Numbering is 0-based in occurrence order;
// each occurrence gets its own index (identical repeated tokens get distinct indices), so the
// reply must echo every `<kN/>` exactly once — the same exactly-once contract as the block IR.
const K_GRAMMAR = /<k\d+\/>/;
const K_TOKEN_GLOBAL = /<k(\d+)\/>/g;

// Keep block IR placeholder tags as delimiters so masking runs only on the text BETWEEN them —
// a `<g1>` must never be seen as an "identifier" and masked into `<<k0/>>`.
const BLOCK_PLACEHOLDER_SPLITTER = new RegExp(`(${PLACEHOLDER_GRAMMAR.source})`, "g");
const BLOCK_PLACEHOLDER_EXACT = new RegExp(`^(?:${PLACEHOLDER_GRAMMAR.source})$`);

/**
 * Replaces every protected span in `text` with `<kN/>`, returning `{ masked, map }` where `map`
 * is the ordered array of original strings (`map[N]` is the value for `<kN/>`). Block IR
 * placeholder tags are left byte-identical. Masking runs on the serialized source AFTER block IR
 * serialization, so `<gN>`/`<vN/>` are already present and are preserved.
 */
function maskProtectedTokens(text) {
    const input = String(text ?? "");
    const map = [];
    if (!input) return { masked: input, map };
    let masked = "";
    for (const part of input.split(BLOCK_PLACEHOLDER_SPLITTER)) {
        if (!part) continue;
        if (BLOCK_PLACEHOLDER_EXACT.test(part)) {
            masked += part; // <gN>/</gN>/<vN/> — a distinct namespace, never masked
            continue;
        }
        const spans = findProtectedSpans(part);
        if (!spans.length) {
            masked += part;
            continue;
        }
        let cursor = 0;
        for (const span of spans) {
            masked += part.slice(cursor, span.start);
            masked += `<k${map.length}/>`;
            map.push(span.token);
            cursor = span.end;
        }
        masked += part.slice(cursor);
    }
    return { masked, map };
}

/**
 * Local restoration — the inverse of maskProtectedTokens, run BEFORE validation and block apply.
 * Every `<kN/>` is replaced with `map[N]`. This is LOCAL ONLY and NEVER triggers an LLM repair
 * call. `ok` is false, with the offending indices listed, when the reply dropped a placeholder
 * (`missing`), duplicated one beyond its single source occurrence (`duplicated`), or invented an
 * out-of-range `<kN/>` (`extra`). A merely reordered-but-complete set restores fine (`ok:true`) —
 * the values are all present, so DOM order is what the block IR / validator decide. Never throws.
 */
function restoreProtectedTokens(text, map) {
    const input = String(text ?? "");
    const list = Array.isArray(map) ? map : [];
    const seen = new Array(list.length).fill(0);
    const extra = [];
    const restored = input.replace(K_TOKEN_GLOBAL, (_whole, digits) => {
        const index = Number(digits);
        if (index >= 0 && index < list.length) {
            seen[index] += 1;
            return list[index];
        }
        extra.push(index);
        return ""; // invented out-of-range placeholder: drop it, never keep raw <kN/> in the DOM
    });
    const missing = [];
    const duplicated = [];
    for (let index = 0; index < list.length; index += 1) {
        if (seen[index] === 0) missing.push(index);
        else if (seen[index] > 1) duplicated.push(index);
    }
    const ok = missing.length === 0 && duplicated.length === 0 && extra.length === 0;
    return { restored, ok, missing, duplicated, extra };
}

export { K_GRAMMAR, maskProtectedTokens, restoreProtectedTokens };
