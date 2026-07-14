import {
    AI_PAGE_SCHEMA_VERSION,
    assertValidPagePacketRequest,
    isPlainJsonValue,
    validatePagePacketReply,
    validatePagePacketRequest,
} from "../../../src/common/scripts/ai_page_translation_protocol.js";

// Re-pinned from the deleted common/aiPageTranslationV2Protocol suite. The v2 wire module
// (ai_page_translation_v2_protocol.js) was removed; the pt3 protocol module
// (ai_page_translation_protocol.js) is the sole survivor and carries the same JSON-only /
// duplicate / cyclic / reply-ID-isolation guarantees. These are safety-critical: a reply may
// never apply a translation onto an ID the request did not send, and unbounded/cyclic context
// must never reach a provider.

function validRequest(overrides = {}) {
    return {
        schemaVersion: AI_PAGE_SCHEMA_VERSION,
        requestId: "req-1",
        sessionId: "session-1",
        packetId: "packet-1",
        payloadHash: "hash-1",
        providerProfileId: "openai-primary",
        profileRevision: "rev-1",
        sourceLanguage: "ja",
        targetLanguage: "ko",
        maxOutputTokens: 1024,
        units: [{ id: "u1", text: "京阪本線", role: "heading" }],
        ...overrides,
    };
}

describe("AI page translation pt3 wire protocol", () => {
    it("accepts a well-formed request that round-trips as JSON-only", () => {
        const request = validRequest({ ctx: { heading: "Railway", headers: ["Name", "Distance"] } });
        expect(validatePagePacketRequest(request)).toEqual({ ok: true, errors: [] });
        expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    });

    it("rejects duplicate units, empty text and DOM values in context", () => {
        const request = validRequest({
            ctx: document.body,
            units: [
                { id: "u1", text: "Valid" },
                { id: "u1", text: "" },
            ],
        });
        const result = validatePagePacketRequest(request);

        expect(result.ok).toBe(false);
        expect(result.errors.join(" ")).toMatch(/duplicated/);
        expect(result.errors.join(" ")).toMatch(/non-empty string/);
        expect(result.errors.join(" ")).toMatch(/bounded plain JSON/);
        expect(() => assertValidPagePacketRequest(request)).toThrow(/Invalid AI page packet/);
    });

    it("rejects cyclic and deeply nested context objects", () => {
        const cyclic = {};
        cyclic.self = cyclic;
        expect(isPlainJsonValue(cyclic)).toBe(false);
        expect(isPlainJsonValue({ a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } })).toBe(
            false
        );
    });

    it("keeps uniquely mapped ID results and isolates duplicate or missing IDs", () => {
        const result = validatePagePacketReply(
            {
                schemaVersion: AI_PAGE_SCHEMA_VERSION,
                requestId: "req-1",
                packetId: "packet-1",
                ok: false,
                units: [
                    { id: "u1", status: "translated", translatedText: "게이한 본선" },
                    { id: "u2", status: "translated", translatedText: "운행 형태" },
                    { id: "u2", status: "translated", translatedText: "중복 결과" },
                ],
            },
            { requestId: "req-1", packetId: "packet-1", expectedUnitIds: ["u1", "u2", "u3"] }
        );

        expect(result.ok).toBe(false);
        expect(result.validUnits.map((unit) => unit.id)).toEqual(["u1"]);
        expect(result.rejectedUnitIds).toEqual(["u2"]);
        expect(result.missingUnitIds).toEqual(["u2", "u3"]);
    });

    it("never applies unknown IDs even when their shape is otherwise valid", () => {
        const result = validatePagePacketReply(
            {
                schemaVersion: AI_PAGE_SCHEMA_VERSION,
                requestId: "req-1",
                packetId: "packet-1",
                ok: true,
                units: [
                    { id: "u1", status: "translated", translatedText: "정상" },
                    { id: "unknown", status: "translated", translatedText: "잘못된 대상" },
                ],
            },
            { requestId: "req-1", packetId: "packet-1", expectedUnitIds: ["u1"] }
        );

        expect(result.ok).toBe(false);
        expect(result.validUnits.map((unit) => unit.id)).toEqual(["u1"]);
        expect(result.rejectedUnitIds).toEqual(["unknown"]);
        expect(result.errors.join(" ")).toMatch(/unknown unit id/);
    });
});
