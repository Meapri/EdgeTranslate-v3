/**
 * Content-side transport client for the vNext AI page translation engine (spec §8).
 *
 * Mirrors the ai_page_translation_v2 envelope semantics — the (tab, session, packet)
 * idempotency key lives background-side, the content side preserves it by keeping packetId
 * and payloadHash stable across attempts while only the requestId carries the attempt
 * ordinal — with the NEW service names and the "page-v3-1" schema id. A delivery-unknown
 * replay therefore re-sends a byte-identical envelope and the background transport can
 * replay the completed reply with usage stripped instead of re-executing.
 *
 * The channel is injectable so tests can drive the client without a background context.
 */

import { fnv1a32 } from "./translation_cache.js";

const AI_PAGE_SCHEMA_VERSION = "page-v3-1";

const SERVICE_CAPABILITIES = "get_page_translation_capabilities";
const SERVICE_COUNT_TOKENS = "count_page_translation_tokens";
const SERVICE_TRANSLATE = "translate_page_packet";
const SERVICE_CANCEL = "cancel_page_translation";

/**
 * AIMD limiter identity (spec §2.3): per (provider, apiKeyHash). The background reports the
 * key hash (never the key) through capabilities; the profile revision is the documented
 * fallback identity signal, and the bare profile id is the last resort.
 */
function resolveLimiterKey(capabilities, { provider, providerProfileId } = {}) {
    if (typeof capabilities?.limiterKey === "string" && capabilities.limiterKey.trim()) {
        return capabilities.limiterKey;
    }
    const providerPart = String(capabilities?.provider || provider || "");
    const keyPart = String(
        capabilities?.apiKeyHash || capabilities?.keyHash || capabilities?.profileRevision || ""
    );
    if (providerPart && keyPart) return `${providerPart}|${keyPart}`;
    return String(providerProfileId || providerPart || "unknown-profile");
}

function normalizeReply(reply, envelope) {
    const reportedAttempts = Number(reply?.actualAttemptCount);
    return {
        ok: reply?.ok === true,
        units: Array.isArray(reply?.units) ? reply.units : [],
        usageReceipts: Array.isArray(reply?.usageReceipts) ? reply.usageReceipts : [],
        failure: reply?.failure || null,
        costAttribution: String(reply?.costAttribution || "owner"),
        // `null` means an older/custom transport did not report this. The session can then
        // infer one provider execution for an ordinary dispatch and zero for an idempotent
        // replay. Production background replies report 1 for an owner and 0 for reuse.
        actualAttemptCount:
            Number.isFinite(reportedAttempts) && reportedAttempts >= 0
                ? Math.floor(reportedAttempts)
                : null,
        resolvedProvider: reply?.resolvedProvider || null,
        requestId: envelope.requestId,
        packetId: envelope.packetId,
        payloadHash: envelope.payloadHash,
    };
}

function createTransportClient({
    channel,
    sessionId,
    providerProfileId,
    provider,
    sourceLanguage,
    targetLanguage,
} = {}) {
    if (!channel || typeof channel.request !== "function") {
        throw new TypeError("createTransportClient requires a channel with request()");
    }
    if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new TypeError("createTransportClient requires a sessionId");
    }
    const state = { profileRevision: "", capabilities: null };

    const buildEnvelope = ({ packetId, items, maxOutputTokens, ctx, hint, attempt = 0 }) => {
        if (typeof packetId !== "string" || !packetId.trim()) {
            throw new TypeError("packet envelope requires a packetId");
        }
        const units = (Array.isArray(items) ? items : []).map((item) => ({
            id: item.id,
            text: item.text,
            role: item.role || "p",
        }));
        const output = Math.max(1, Math.floor(Number(maxOutputTokens) || 0) || 1024);
        // payloadHash covers everything the provider request depends on but NOT the attempt
        // ordinal, so a replay of the same packet keeps the same idempotency identity.
        const payloadHash = fnv1a32(
            JSON.stringify({
                profileRevision: state.profileRevision,
                sourceLanguage,
                targetLanguage,
                ctx: ctx || null,
                hint: hint || null,
                maxOutputTokens: output,
                units,
            })
        );
        return {
            schemaVersion: AI_PAGE_SCHEMA_VERSION,
            requestId: `${packetId}:a${Math.max(0, Math.floor(Number(attempt) || 0))}`,
            sessionId,
            packetId,
            payloadHash,
            providerProfileId,
            profileRevision: state.profileRevision,
            sourceLanguage,
            targetLanguage,
            maxOutputTokens: output,
            ...(ctx ? { ctx } : {}),
            ...(hint ? { hint } : {}),
            units,
        };
    };

    return {
        schemaVersion: AI_PAGE_SCHEMA_VERSION,

        async getCapabilities() {
            const capabilities = await channel.request(SERVICE_CAPABILITIES, {
                providerProfileId,
            });
            state.capabilities = capabilities || {};
            if (typeof state.capabilities.profileRevision === "string") {
                state.profileRevision = state.capabilities.profileRevision;
            }
            return {
                ...state.capabilities,
                limiterKey: resolveLimiterKey(state.capabilities, {
                    provider,
                    providerProfileId,
                }),
            };
        },

        /** Compatibility service retained for older callers; vNext runtime does not preflight. */
        async countTokens(params) {
            const envelope = buildEnvelope(params);
            const result = await channel.request(SERVICE_COUNT_TOKENS, envelope);
            return {
                tokens: Number.isFinite(Number(result?.tokens)) ? Number(result.tokens) : null,
                source: String(result?.source || "none"),
            };
        },

        async translatePacket(params) {
            const envelope = buildEnvelope(params);
            const reply = await channel.request(SERVICE_TRANSLATE, envelope);
            return normalizeReply(reply, envelope);
        },

        /** Session/packet-scoped abort mirroring the v2 cancel semantics. */
        async cancel({ packetIds = null, reason = "cancelled" } = {}) {
            try {
                return await channel.request(SERVICE_CANCEL, {
                    sessionId,
                    packetIds: Array.isArray(packetIds) ? packetIds : null,
                    reason,
                });
            } catch {
                // Cancellation is best-effort: an unreachable background must never turn
                // session teardown into a thrown error.
                return { aborted: 0 };
            }
        },
    };
}

export {
    AI_PAGE_SCHEMA_VERSION,
    SERVICE_CANCEL,
    SERVICE_CAPABILITIES,
    SERVICE_COUNT_TOKENS,
    SERVICE_TRANSLATE,
    createTransportClient,
    resolveLimiterKey,
};
