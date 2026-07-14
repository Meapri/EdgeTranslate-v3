import {
    AI_PAGE_SCHEMA_VERSION,
    SERVICE_CANCEL,
    SERVICE_CAPABILITIES,
    SERVICE_COUNT_TOKENS,
    SERVICE_TRANSLATE,
    createTransportClient,
    resolveLimiterKey,
} from "../../../src/content/ai_page_translation/runtime/transport_client.js";

function makeChannel(handler) {
    const calls = [];
    return {
        calls,
        request: jest.fn(async (service, payload) => {
            calls.push({ service, payload });
            return handler(service, payload);
        }),
    };
}

function makeClient(channel, overrides = {}) {
    return createTransportClient({
        channel,
        sessionId: "s1",
        providerProfileId: "profile-1",
        provider: "openai",
        sourceLanguage: "ja",
        targetLanguage: "ko",
        ...overrides,
    });
}

describe("vNext transport client (page-v3-1 envelope)", () => {
    it("resolves the AIMD limiter key from capabilities with the documented fallbacks", () => {
        expect(resolveLimiterKey({ limiterKey: "given" }, {})).toBe("given");
        expect(
            resolveLimiterKey({ provider: "openai", apiKeyHash: "k1" }, { providerProfileId: "p" })
        ).toBe("openai|k1");
        expect(resolveLimiterKey({ provider: "openai", profileRevision: "r7" }, {})).toBe(
            "openai|r7"
        );
        expect(resolveLimiterKey({}, { providerProfileId: "profile-1" })).toBe("profile-1");
    });

    it("requests capabilities under the new service name and attaches the limiter key", async () => {
        const channel = makeChannel((service) =>
            service === SERVICE_CAPABILITIES
                ? { provider: "openai", apiKeyHash: "k9", profileRevision: "r2" }
                : null
        );
        const client = makeClient(channel);
        const capabilities = await client.getCapabilities();
        expect(channel.calls[0]).toEqual({
            service: SERVICE_CAPABILITIES,
            payload: { providerProfileId: "profile-1" },
        });
        expect(capabilities.limiterKey).toBe("openai|k9");
    });

    it("builds the translate envelope with schema page-v3-1 and a stable idempotency identity", async () => {
        const channel = makeChannel((service) =>
            service === SERVICE_CAPABILITIES
                ? { profileRevision: "r2" }
                : { ok: true, units: [], usageReceipts: [] }
        );
        const client = makeClient(channel);
        await client.getCapabilities();
        const params = {
            packetId: "pkt1",
            items: [
                { id: "b1", text: "こんにちは", role: "h" },
                { id: "b2", text: "世界" },
            ],
            maxOutputTokens: 512,
            ctx: { title: "T", domain: "d", gloss: [] },
            attempt: 0,
        };
        await client.translatePacket(params);
        await client.translatePacket({ ...params, attempt: 1 });
        const [first, second] = channel.calls.slice(1).map((call) => call.payload);
        expect(channel.calls[1].service).toBe(SERVICE_TRANSLATE);
        expect(first).toMatchObject({
            schemaVersion: AI_PAGE_SCHEMA_VERSION,
            sessionId: "s1",
            packetId: "pkt1",
            providerProfileId: "profile-1",
            profileRevision: "r2",
            sourceLanguage: "ja",
            targetLanguage: "ko",
            maxOutputTokens: 512,
            requestId: "pkt1:a0",
        });
        expect(first.units).toEqual([
            { id: "b1", text: "こんにちは", role: "h" },
            { id: "b2", text: "世界", role: "p" },
        ]);
        // Attempt replays preserve packetId + payloadHash (the idempotency identity) and
        // only advance the requestId ordinal.
        expect(second.requestId).toBe("pkt1:a1");
        expect(second.payloadHash).toBe(first.payloadHash);
        const changed = await client.translatePacket({
            ...params,
            items: [{ id: "b1", text: "違うテキスト" }],
        });
        expect(changed.payloadHash).not.toBe(first.payloadHash);
    });

    it("routes a hedge attempt under a distinct wire packetId while preserving payloadHash", async () => {
        const channel = makeChannel((service) =>
            service === SERVICE_CAPABILITIES
                ? { profileRevision: "r2" }
                : { ok: true, units: [], usageReceipts: [] }
        );
        const client = makeClient(channel);
        await client.getCapabilities();
        const params = {
            packetId: "pkt7",
            items: [{ id: "b1", text: "こんにちは", role: "h" }],
            maxOutputTokens: 512,
            ctx: { title: "T", domain: "d", gloss: [] },
            attempt: 0,
        };
        const original = await client.translatePacket(params);
        const hedged = await client.translatePacket({ ...params, hedge: true });

        const [originalEnvelope, hedgeEnvelope] = channel.calls
            .slice(1)
            .map((call) => call.payload);
        // The background keys idempotency on (tab, session, packetId); the hedge MUST carry a
        // distinct packetId so it is not joined to the in-flight original.
        expect(originalEnvelope.packetId).toBe("pkt7");
        expect(hedgeEnvelope.packetId).toBe("pkt7#h1");
        expect(hedgeEnvelope.requestId).toBe("pkt7#h1:a0");
        // Same payload content -> identical idempotency hash; only the routing key differs.
        expect(hedgeEnvelope.payloadHash).toBe(originalEnvelope.payloadHash);
        expect(hedgeEnvelope.units).toEqual(originalEnvelope.units);
        expect(original.packetId).toBe("pkt7");
        expect(hedged.packetId).toBe("pkt7#h1");
    });

    it("normalizes malformed replies instead of throwing", async () => {
        const channel = makeChannel(() => null);
        const client = makeClient(channel);
        const reply = await client.translatePacket({
            packetId: "pkt1",
            items: [{ id: "b1", text: "x" }],
            maxOutputTokens: 128,
        });
        expect(reply).toMatchObject({
            ok: false,
            units: [],
            usageReceipts: [],
            failure: null,
            costAttribution: "owner",
        });
    });

    it("counts tokens through count_page_translation_tokens", async () => {
        const channel = makeChannel((service) =>
            service === SERVICE_COUNT_TOKENS ? { tokens: 321, source: "provider" } : null
        );
        const client = makeClient(channel);
        const counted = await client.countTokens({
            packetId: "pkt1:preflight",
            items: [{ id: "b1", text: "x" }],
            maxOutputTokens: 128,
        });
        expect(channel.calls[0].service).toBe(SERVICE_COUNT_TOKENS);
        expect(counted).toEqual({ tokens: 321, source: "provider" });
    });

    it("cancels with session scope and swallows channel failures", async () => {
        const channel = makeChannel((service) => {
            if (service === SERVICE_CANCEL) throw new Error("gone");
            return null;
        });
        const client = makeClient(channel);
        const result = await client.cancel({ packetIds: ["pkt1"], reason: "profile-changed" });
        expect(channel.calls[0]).toEqual({
            service: SERVICE_CANCEL,
            payload: { sessionId: "s1", packetIds: ["pkt1"], reason: "profile-changed" },
        });
        expect(result).toEqual({ aborted: 0 });
    });
});
