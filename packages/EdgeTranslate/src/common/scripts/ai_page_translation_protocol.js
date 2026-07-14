/**
 * JSON-only wire contract shared by the content and background contexts for the vNext
 * AI page translation engine (schema "page-v3-1", spec §8). DOM nodes, WeakRefs and
 * AbortSignals must never cross this boundary.
 *
 * This module is the single source for the channel service names and the schema id.
 * The background transport imports it directly; the content-side
 * ai_page_translation/runtime/transport_client.js currently pins byte-identical local
 * constants and can adopt these exports later without any behavior change.
 */

const AI_PAGE_SCHEMA_VERSION = "page-v3-1";

const AI_PAGE_SERVICE_CAPABILITIES = "get_page_translation_capabilities";
const AI_PAGE_SERVICE_COUNT_TOKENS = "count_page_translation_tokens";
const AI_PAGE_SERVICE_TRANSLATE = "translate_page_packet";
const AI_PAGE_SERVICE_CANCEL = "cancel_page_translation";

const AI_PAGE_UNIT_STATUSES = Object.freeze(["translated", "unchanged", "failed"]);

/**
 * FNV-1a 32-bit in base36 — the same implementation the content-side cache and transport
 * client use. Exposed here so the background can derive apiKeyHash (the hash crosses the
 * boundary, NEVER the key) from one shared definition.
 */
function fnv1a32(value, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function isPlainJsonValue(value, depth = 0, seen = new Set()) {
    if (value === null) return true;
    if (["string", "number", "boolean"].includes(typeof value)) {
        return typeof value !== "number" || Number.isFinite(value);
    }
    if (depth >= 6 || typeof value !== "object" || seen.has(value)) return false;

    seen.add(value);
    let valid = true;
    if (Array.isArray(value)) {
        valid = value.every((item) => isPlainJsonValue(item, depth + 1, seen));
    } else {
        const prototype = Object.getPrototypeOf(value);
        valid =
            (prototype === Object.prototype || prototype === null) &&
            Object.entries(value).every(
                ([key, item]) => isNonEmptyString(key) && isPlainJsonValue(item, depth + 1, seen)
            );
    }
    seen.delete(value);
    return valid;
}

function validatePagePacketRequest(request) {
    const errors = [];
    if (!request || typeof request !== "object" || Array.isArray(request)) {
        return { ok: false, errors: ["request must be an object"] };
    }

    if (request.schemaVersion !== AI_PAGE_SCHEMA_VERSION) {
        errors.push(`schemaVersion must be ${AI_PAGE_SCHEMA_VERSION}`);
    }
    for (const field of [
        "requestId",
        "sessionId",
        "packetId",
        "payloadHash",
        "providerProfileId",
        "sourceLanguage",
        "targetLanguage",
    ]) {
        if (!isNonEmptyString(request[field])) errors.push(`${field} must be a non-empty string`);
    }
    // The transport client sends "" until the first capabilities round-trip has reported a
    // revision, so the field must exist as a string but may be empty.
    if (typeof request.profileRevision !== "string") {
        errors.push("profileRevision must be a string");
    }
    if (!isPositiveInteger(request.maxOutputTokens)) {
        errors.push("maxOutputTokens must be a positive integer");
    }
    if (request.ctx !== undefined) {
        if (
            !request.ctx ||
            typeof request.ctx !== "object" ||
            Array.isArray(request.ctx) ||
            !isPlainJsonValue(request.ctx)
        ) {
            errors.push("ctx must be a bounded plain JSON object when present");
        }
    }
    if (request.hint !== undefined && !isPlainJsonValue(request.hint)) {
        errors.push("hint must be a bounded plain JSON value when present");
    }
    if (!Array.isArray(request.units) || request.units.length === 0) {
        errors.push("units must be a non-empty array");
    } else {
        const ids = new Set();
        request.units.forEach((unit, index) => {
            const prefix = `units[${index}]`;
            if (!unit || typeof unit !== "object" || Array.isArray(unit)) {
                errors.push(`${prefix} must be an object`);
                return;
            }
            if (!isNonEmptyString(unit.id)) errors.push(`${prefix}.id must be a non-empty string`);
            else if (ids.has(unit.id)) errors.push(`${prefix}.id is duplicated`);
            else ids.add(unit.id);
            if (!isNonEmptyString(unit.text)) {
                errors.push(`${prefix}.text must be a non-empty string`);
            }
            if (unit.role !== undefined && !isNonEmptyString(unit.role)) {
                errors.push(`${prefix}.role must be a non-empty string when present`);
            }
        });
    }
    return { ok: errors.length === 0, errors };
}

function assertValidPagePacketRequest(request) {
    const validation = validatePagePacketRequest(request);
    if (!validation.ok) {
        throw new TypeError(`Invalid AI page packet: ${validation.errors.join("; ")}`);
    }
    return request;
}

function validatePagePacketReply(reply, expected = {}) {
    const errors = [];
    const validUnits = [];
    const rejectedUnitIds = new Set();
    const expectedIds = new Set(expected.expectedUnitIds || []);
    const seenIds = new Set();

    if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
        return {
            ok: false,
            errors: ["reply must be an object"],
            validUnits,
            rejectedUnitIds: [],
            missingUnitIds: Array.from(expectedIds),
        };
    }
    if (reply.schemaVersion !== AI_PAGE_SCHEMA_VERSION) {
        errors.push(`schemaVersion must be ${AI_PAGE_SCHEMA_VERSION}`);
    }
    if (expected.requestId && reply.requestId !== expected.requestId) {
        errors.push("requestId does not match the request");
    }
    if (expected.packetId && reply.packetId !== expected.packetId) {
        errors.push("packetId does not match the request");
    }
    if (typeof reply.ok !== "boolean") errors.push("ok must be a boolean");
    if (!Array.isArray(reply.units)) {
        errors.push("units must be an array");
    } else {
        const byId = new Map();
        reply.units.forEach((unit, index) => {
            const prefix = `units[${index}]`;
            if (!unit || typeof unit !== "object" || Array.isArray(unit)) {
                errors.push(`${prefix} must be an object`);
                return;
            }
            if (!isNonEmptyString(unit.id)) {
                errors.push(`${prefix}.id must be a non-empty string`);
                return;
            }
            if (seenIds.has(unit.id)) {
                errors.push(`${prefix}.id is duplicated`);
                rejectedUnitIds.add(unit.id);
            }
            seenIds.add(unit.id);
            if (!byId.has(unit.id)) byId.set(unit.id, []);
            byId.get(unit.id).push(unit);
        });

        for (const [id, matches] of byId) {
            if (matches.length !== 1 || rejectedUnitIds.has(id)) continue;
            const unit = matches[0];
            if (expectedIds.size && !expectedIds.has(id)) {
                errors.push(`unknown unit id: ${id}`);
                rejectedUnitIds.add(id);
                continue;
            }
            if (!AI_PAGE_UNIT_STATUSES.includes(unit.status)) {
                errors.push(`unit ${id} has an invalid status`);
                rejectedUnitIds.add(id);
                continue;
            }
            if (unit.keepSource !== undefined && typeof unit.keepSource !== "boolean") {
                errors.push(`unit ${id} keepSource must be a boolean when present`);
                rejectedUnitIds.add(id);
                continue;
            }
            if (unit.status === "translated" && !isNonEmptyString(unit.translatedText)) {
                errors.push(`translated unit ${id} requires translatedText`);
                rejectedUnitIds.add(id);
                continue;
            }
            if (unit.status === "failed" && !isNonEmptyString(unit.reason)) {
                errors.push(`failed unit ${id} requires a reason`);
                rejectedUnitIds.add(id);
                continue;
            }
            validUnits.push(unit);
        }
    }

    const validIds = new Set(validUnits.map((unit) => unit.id));
    const missingUnitIds = Array.from(expectedIds).filter((id) => !validIds.has(id));
    return {
        ok: errors.length === 0 && missingUnitIds.length === 0,
        errors,
        validUnits,
        rejectedUnitIds: Array.from(rejectedUnitIds),
        missingUnitIds,
    };
}

export {
    AI_PAGE_SCHEMA_VERSION,
    AI_PAGE_SERVICE_CANCEL,
    AI_PAGE_SERVICE_CAPABILITIES,
    AI_PAGE_SERVICE_COUNT_TOKENS,
    AI_PAGE_SERVICE_TRANSLATE,
    AI_PAGE_UNIT_STATUSES,
    assertValidPagePacketRequest,
    fnv1a32,
    isPlainJsonValue,
    validatePagePacketReply,
    validatePagePacketRequest,
};
