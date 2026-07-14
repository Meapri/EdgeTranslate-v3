/**
 * The single source-key normalization for the vNext page translation engine (spec §9).
 *
 * Dedupe, the session cache, the persistent cache and the in-flight join MUST all key strings
 * through this exact function. Divergent local normalizations between those layers are the bug
 * class this module exists to kill — never fork or inline this logic elsewhere.
 */

// U+001F unit separator: cannot appear in collapsed page text, so the role suffix can never collide
// with source content.
const ROLE_SEPARATOR = "\u001f";

function normalizeSourceKey(source, role) {
    const text = String(source ?? "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim();
    const normalizedRole = String(role || "p").trim() || "p";
    return `${text}${ROLE_SEPARATOR}${normalizedRole}`;
}

export { normalizeSourceKey };
