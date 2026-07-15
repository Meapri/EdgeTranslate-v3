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
import { AI_PAGE_EVENT_PROGRESS } from "common/scripts/ai_page_translation_protocol.js";

const AI_PAGE_SCHEMA_VERSION = "page-v3-1";

const SERVICE_CAPABILITIES = "get_page_translation_capabilities";
const SERVICE_COUNT_TOKENS = "count_page_translation_tokens";
const SERVICE_TRANSLATE = "translate_page_packet";
const SERVICE_CANCEL = "cancel_page_translation";

// Suffix appended to derive a hedge attempt's WIRE packetId from the logical packetId (spec
// §2.3 tail control). The background transport keys its in-flight/completed idempotency map on
// (tab, session, packetId); a hedge MUST carry a distinct packetId or it would join the
// in-flight straggler and issue no new provider request. maxPerPacket is 1, so `#h1` suffices.
const HEDGE_PACKET_ID_SUFFIX = "#h1";

function hedgePacketId(packetId) {
    return `${packetId}${HEDGE_PACKET_ID_SUFFIX}`;
}

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

    const buildEnvelope = ({ packetId, items, maxOutputTokens, ctx, hint, attempt = 0, hedge }) => {
        if (typeof packetId !== "string" || !packetId.trim()) {
            throw new TypeError("packet envelope requires a packetId");
        }
        // A hedge attempt re-sends the SAME payload under a DISTINCT wire packetId so the
        // background issues a genuinely new provider generation instead of joining the
        // in-flight straggler (spec §2.3). payloadHash is derived below WITHOUT the packetId,
        // so it stays byte-identical to the original — the idempotency CONTENT is unchanged, only
        // the routing key differs. The original packetId's own replay/idempotency is untouched.
        const wirePacketId = hedge === true ? hedgePacketId(packetId) : packetId;
        const units = (Array.isArray(items) ? items : []).map((item) => ({
            id: item.id,
            text: item.text,
            role: item.role || "p",
        }));
        const output = Math.max(1, Math.floor(Number(maxOutputTokens) || 0) || 1024);
        // payloadHash covers everything the provider request depends on but NOT the attempt
        // ordinal or the wire packetId, so a replay (or a hedge) of the same packet keeps the
        // same idempotency identity.
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
            requestId: `${wirePacketId}:a${Math.max(0, Math.floor(Number(attempt) || 0))}`,
            sessionId,
            packetId: wirePacketId,
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
            const onProgress = typeof params?.onProgress === "function" ? params.onProgress : null;
            const envelope = buildEnvelope(params);
            let progressHandler = null;
            if (onProgress && typeof channel.on === "function") {
                progressHandler = (detail = {}) => {
                    if (
                        detail.schemaVersion !== AI_PAGE_SCHEMA_VERSION ||
                        detail.sessionId !== sessionId ||
                        detail.packetId !== envelope.packetId ||
                        detail.requestId !== envelope.requestId
                    ) {
                        return;
                    }
                    const units = Array.isArray(detail.units) ? detail.units : [];
                    if (!units.length) return;
                    try {
                        onProgress(units);
                    } catch {
                        /* presentation progress is best-effort */
                    }
                };
                channel.on(AI_PAGE_EVENT_PROGRESS, progressHandler);
            }
            try {
                const reply = await channel.request(SERVICE_TRANSLATE, envelope);
                return normalizeReply(reply, envelope);
            } finally {
                if (progressHandler && typeof channel.off === "function") {
                    channel.off(AI_PAGE_EVENT_PROGRESS, progressHandler);
                }
            }
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
    AI_PAGE_EVENT_PROGRESS,
    HEDGE_PACKET_ID_SUFFIX,
    SERVICE_CANCEL,
    SERVICE_CAPABILITIES,
    SERVICE_COUNT_TOKENS,
    SERVICE_TRANSLATE,
    createTransportClient,
    hedgePacketId,
    resolveLimiterKey,
};
