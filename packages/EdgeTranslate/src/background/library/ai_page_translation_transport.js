/**
 * Background transport for the vNext AI page translation engine (schema "page-v3-1",
 * spec §8). Ported from ai_page_translation_v2_transport.js — the (tab, session, packet)
 * + payloadHash idempotency map, the completed-reply replay with usage stripped and
 * costAttribution "reused", the per-packet AbortControllers and the 24h capability cache
 * all carry over verbatim — then adapted to the vNext envelope:
 *
 * - Capabilities are served WITHOUT a provider round-trip whenever a cached or fallback
 *   value exists (Stage-C risk 1: discovery must never sit on the first-paint path). The
 *   cold path returns fallback-derived capabilities immediately and warms the 24h cache
 *   in the background. The reply carries provider + apiKeyHash (fnv1a32 of the key —
 *   never the key itself) + profileRevision + maxOutputTokens so the content-side AIMD
 *   limiterKey and output ceilings never degrade.
 * - translate() drives the pt3 wire: adapters receive the TranslationBatchRequest shape
 *   from @edge_translate/translators page_translation_v2 (ctx passed through session-
 *   frozen and byte-identical; buildPageTranslationRequest is consumed inside the
 *   adapters' executeOnce).
 * - Failures come back with the errors.ts kinds VERBATIM: the content-side retry table
 *   keys on `failure.kind` and falls back on `retryDirective`, so the background never
 *   renames or wraps a provider failure (sole exception: the local watchdog rewrites the
 *   ambiguous abort-at-timeout "cancelled" into "timeout", as in v2).
 */

import {
    GeminiGenerateContentAdapter,
    OpenAIChatCompatibleAdapter,
    OpenAIResponsesAdapter,
} from "@edge_translate/translators";
import { AI_PAGE_SHARED_CONCURRENCY_CAPS } from "common/scripts/ai_page_translation_limits.js";
import {
    AI_PAGE_EVENT_PROGRESS,
    fnv1a32,
    validatePagePacketRequest,
} from "common/scripts/ai_page_translation_protocol.js";

const COMPLETED_TTL_MS = 60 * 1000;
const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

// AIMD provider identity (spec §2.3): the content scheduler's per-provider parameter
// table keys on these names.
const PROTOCOL_PROVIDERS = Object.freeze({
    "openai-responses": "openai",
    "openai-chat": "openaiCompatible",
    "gemini-generate-content": "googleAiStudio",
});

// One background service worker serves every tab. Keep the aggregate number of generations for
// one provider/API-key below the same proven cap used by the content-side AIMD scheduler; without
// this gate, two clean sessions could each ramp to the cap and turn a speed optimization into a
// cross-tab 429 burst. FIFO admission is intentionally simple and provider timeouts start only
// after admission, so time spent waiting behind another tab is not misclassified as a timeout.
const SHARED_PROVIDER_CONCURRENCY_CAPS = AI_PAGE_SHARED_CONCURRENCY_CAPS;

class SharedProviderConcurrencyGate {
    constructor() {
        this.states = new Map();
    }

    stateFor(key, limit) {
        let state = this.states.get(key);
        if (!state) {
            state = { active: 0, limit, queue: [] };
            this.states.set(key, state);
        } else {
            // A limiter key includes provider identity, so this should normally be identical.
            // Keeping the smaller observed cap is the conservative behavior if configuration
            // changes while an MV3 worker remains alive.
            state.limit = Math.min(state.limit, limit);
        }
        return state;
    }

    cleanup(key, state) {
        if (state.active === 0 && state.queue.length === 0) this.states.delete(key);
    }

    releaseFor(key, state) {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            state.active = Math.max(0, state.active - 1);
            this.drain(key, state);
        };
    }

    grant(key, state, waiter) {
        if (waiter.signal?.aborted) {
            waiter.resolve(null);
            return false;
        }
        waiter.queued = false;
        if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        state.active += 1;
        waiter.resolve(this.releaseFor(key, state));
        return true;
    }

    drain(key, state) {
        while (state.active < state.limit && state.queue.length) {
            const waiter = state.queue.shift();
            this.grant(key, state, waiter);
        }
        this.cleanup(key, state);
    }

    acquire(key, rawLimit, signal) {
        const limiterKey = String(key || "default");
        const limit = Math.max(1, Math.floor(Number(rawLimit) || 1));
        if (signal?.aborted) return Promise.resolve(null);
        const state = this.stateFor(limiterKey, limit);
        if (state.active < state.limit) {
            state.active += 1;
            return Promise.resolve(this.releaseFor(limiterKey, state));
        }
        return new Promise((resolve) => {
            const waiter = { resolve, signal, onAbort: null, queued: true };
            waiter.onAbort = () => {
                if (!waiter.queued) return;
                waiter.queued = false;
                const index = state.queue.indexOf(waiter);
                if (index >= 0) state.queue.splice(index, 1);
                resolve(null);
                this.cleanup(limiterKey, state);
            };
            if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
            state.queue.push(waiter);
        });
    }
}

// Output ceilings used until discovery lands. Cloud packets reserve 25% generation headroom in
// the planner, so a 2,048 cold fallback forced a large real-world encyclopedia fixture into ~50
// requests even though both official adapters completed much larger structured replies cleanly. 4,096 is the
// conservative cloud floor already used by the proven stable path; provider metadata/profile
// overrides can raise it, while output-limit responses still enter the bounded split ladder.
const FALLBACK_MAX_OUTPUT_TOKENS = Object.freeze({
    "openai-responses": 4096,
    "openai-chat": 1024,
    "gemini-generate-content": 4096,
});

// The stable runtime already exercises larger first-attempt budgets for these official model
// families. Give the vNext cold path the same conservative 8K planning evidence instead of
// waiting for asynchronous discovery (OpenAI's model-list endpoint does not expose token limits
// at all). Unknown/legacy model IDs stay on the 4K floor above.
function fallbackMaxOutputTokens(profile) {
    const model = String(profile?.modelId || "").replace(/^models\//, "");
    if (
        profile?.protocol === "openai-responses" &&
        /^(?:gpt-5|gpt-4\.1|gpt-4o|o[1-9])/i.test(model)
    ) {
        return 8192;
    }
    if (
        profile?.protocol === "gemini-generate-content" &&
        /^gemini-(?:2(?:\.|-|$)|3(?:\.|-|$))/i.test(model)
    ) {
        return 8192;
    }
    return FALLBACK_MAX_OUTPUT_TOKENS[profile?.protocol] ?? 2048;
}

// Trust boundary for packet-scoped recovery hints. Only these fixed pt3 directives may reach
// an adapter; arbitrary content-message values and the background-only capability hint are
// dropped before provider payload assembly.
const PROVIDER_DIRECTIVE_HINTS = new Set([
    "reinforced-schema",
    "reinforced-inventory",
    "reinforced-order",
    "reinforced-atomic",
    "reinforced-semantic",
]);
const CAPABILITY_DROP_REASONING_HINT = "capability-drop-reasoning";

// These scheduler rows intentionally re-execute the SAME packet after cooldown/backoff. Their
// replies must not enter the completed-idempotency cache, or every retry only replays the first
// failure. Every other terminal/recovery reply is replay-safe: if the content channel loses it,
// replaying the cached result avoids a second billed generation and lets content resume the
// appropriate bounded recovery with a new child packet ID.
const SAME_PACKET_REEXECUTION_FAILURE_KINDS = new Set([
    "rate-limit",
    "transient",
    "timeout",
    "provider-status",
]);

function isCompletedReplyReplaySafe(reply) {
    if (reply?.ok === true) return true;
    const kind = String(reply?.failure?.kind || "");
    return (
        Boolean(kind) && kind !== "cancelled" && !SAME_PACKET_REEXECUTION_FAILURE_KINDS.has(kind)
    );
}

function providerDirectiveHint(hint) {
    return typeof hint === "string" && PROVIDER_DIRECTIVE_HINTS.has(hint) ? hint : null;
}

function profileForPacketHint(profile, hint) {
    if (hint !== CAPABILITY_DROP_REASONING_HINT || profile.protocol !== "openai-responses") {
        return profile;
    }
    // Request-scoped clone only: never mutate the cached/resolved provider profile. Removing
    // reasoningValue as well as pinning `none` guarantees OpenAIResponsesAdapter omits the
    // generation field even for a gpt-5/o-series model with a configured effort floor.
    const ephemeral = { ...profile, reasoningControl: "none" };
    delete ephemeral.reasoningValue;
    return ephemeral;
}

function tabIdFromSender(sender) {
    return sender?.tab?.id ?? -1;
}

function packetKey(tabId, sessionId, packetId) {
    return `${tabId}:${sessionId}:${packetId}`;
}

function withoutUsage(reply, costAttribution = "reused") {
    return {
        ...reply,
        usageReceipts: [],
        actualAttemptCount: 0,
        costAttribution,
    };
}

function cancelledAttemptResult(requestId, reason = "cancelled-before-provider-admission") {
    const now = Date.now();
    return {
        ok: false,
        failure: {
            kind: "cancelled",
            message: String(reason || "cancelled"),
            retryDirective: "never",
            requestMayHaveExecuted: false,
        },
        partialItems: [],
        usageReceipts: [],
        attempt: {
            attemptId: `${requestId || "page-translation"}:cancelled`,
            startedAt: now,
            finishedAt: now,
        },
        actualAttemptCount: 0,
        costAttribution: "not-executed",
    };
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function observedNumber(field) {
    return positiveNumber(field?.value);
}

function discoveredOutputCeiling(profile, discovered) {
    const floor = fallbackMaxOutputTokens(profile);
    const field = discovered?.maxOutputTokens;
    const value = observedNumber(field);
    if (!value) return floor;
    // Provider metadata is an actual ceiling and may legitimately be below the planner floor.
    // Fallback-policy and runtime-observation values are lower-bound evidence, so they may raise
    // but must never shrink the family floor after asynchronous discovery warms the cache.
    return field?.source === "provider-metadata" ? value : Math.max(floor, value);
}

function hasAuthoritativeDiscovery(discovered) {
    return [
        discovered?.maxInputTokens,
        discovered?.maxOutputTokens,
        discovered?.maxCombinedTokens,
    ].some((field) => {
        const source = String(field?.source || "");
        return source === "provider-metadata" || source === "runtime-observation";
    });
}

class AiPageTranslationTransport {
    constructor({ resolveProfile, adapters, concurrencyCaps, concurrencyGate, emitProgress } = {}) {
        if (typeof resolveProfile !== "function") {
            throw new TypeError("AiPageTranslationTransport requires resolveProfile");
        }
        this.resolveProfile = resolveProfile;
        this.adapters =
            adapters ||
            new Map([
                ["openai-responses", new OpenAIResponsesAdapter()],
                ["openai-chat", new OpenAIChatCompatibleAdapter()],
                ["gemini-generate-content", new GeminiGenerateContentAdapter()],
            ]);
        this.inflight = new Map();
        this.controllers = new Map();
        this.completed = new Map();
        this.capabilities = new Map();
        this.capabilityRefreshes = new Map();
        this.concurrencyCaps = {
            ...SHARED_PROVIDER_CONCURRENCY_CAPS,
            ...(concurrencyCaps || {}),
        };
        this.concurrencyGate = concurrencyGate || new SharedProviderConcurrencyGate();
        this.emitProgress = typeof emitProgress === "function" ? emitProgress : null;
    }

    async resolve(params) {
        const profile = await this.resolveProfile(params.providerProfileId);
        if (!profile) {
            throw new Error(
                `Unknown page translation provider profile: ${params.providerProfileId}`
            );
        }
        if (params.profileRevision && params.profileRevision !== profile.revision) {
            throw new Error("Provider profile changed before packet dispatch");
        }
        const adapter = this.adapters.get(profile.protocol);
        if (!adapter)
            throw new Error(`No page translation adapter for protocol: ${profile.protocol}`);
        return { profile, adapter };
    }

    cleanupCompleted() {
        const now = Date.now();
        for (const [key, entry] of this.completed) {
            if (now - entry.completedAt > COMPLETED_TTL_MS) this.completed.delete(key);
        }
        while (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value);
    }

    capabilityKey(profile) {
        return `${profile.protocol}|${profile.id}|${profile.revision}|${profile.modelId}`;
    }

    formatCapabilities(profile, discovered) {
        const provider = PROTOCOL_PROVIDERS[profile.protocol] || profile.protocol;
        // Hash of the key, never the key: the content side builds its AIMD limiter
        // identity (provider, apiKeyHash) from this and must never see the secret.
        const apiKeyHash = fnv1a32(profile.apiKey || "");
        const maxOutputTokens =
            positiveNumber(profile.maxOutputTokens) ?? discoveredOutputCeiling(profile, discovered);
        return {
            provider,
            protocol: profile.protocol,
            modelId: profile.modelId,
            profileRevision: profile.revision,
            apiKeyHash,
            limiterKey: `${provider}|${apiKeyHash}`,
            maxOutputTokens,
            maxInputTokens:
                positiveNumber(profile.maxInputTokens) ??
                observedNumber(discovered?.maxInputTokens),
            maxCombinedTokens:
                positiveNumber(profile.maxCombinedTokens) ??
                observedNumber(discovered?.maxCombinedTokens),
            revision: discovered?.revision || "fallback",
            source: hasAuthoritativeDiscovery(discovered) ? "discovered" : "fallback",
        };
    }

    refreshCapabilities(key, profile, adapter) {
        const existing = this.capabilityRefreshes.get(key);
        if (existing) return existing;
        const refresh = (async () => {
            const controller = new AbortController();
            const value = await adapter.discover(profile, controller.signal);
            this.capabilities.set(key, { value, observedAt: Date.now() });
            return value;
        })();
        this.capabilityRefreshes.set(key, refresh);
        refresh
            .catch(() => null)
            .finally(() => {
                if (this.capabilityRefreshes.get(key) === refresh) {
                    this.capabilityRefreshes.delete(key);
                }
            });
        return refresh;
    }

    /**
     * Never performs a provider round-trip on the caller's path (Stage-C risk 1): a warm
     * 24h cache entry is enriched and returned; a cold (or stale) entry answers from the
     * fallback/stale value immediately while discovery warms the cache in the background.
     */
    async getCapabilities(params) {
        const { profile, adapter } = await this.resolve(params);
        const key = this.capabilityKey(profile);
        const cached = this.capabilities.get(key);
        if (cached && Date.now() - cached.observedAt <= CAPABILITY_TTL_MS) {
            return this.formatCapabilities(profile, cached.value);
        }
        this.refreshCapabilities(key, profile, adapter);
        return this.formatCapabilities(profile, cached ? cached.value : null);
    }

    async countInput(params) {
        const validation = validatePagePacketRequest(params);
        if (!validation.ok) throw new TypeError(validation.errors.join("; "));
        const { profile, adapter } = await this.resolve(params);
        if (typeof adapter.countInput !== "function") {
            return { tokens: null, source: "none" };
        }
        const controller = new AbortController();
        return adapter.countInput(
            profileForPacketHint(profile, params.hint),
            this.toAdapterRequest(params),
            controller.signal
        );
    }

    toAdapterRequest(params, onProgress) {
        const hint = providerDirectiveHint(params.hint);
        return {
            requestId: params.requestId,
            sessionId: params.sessionId,
            wireProtocol: "pt3",
            sourceLanguage: params.sourceLanguage,
            targetLanguage: params.targetLanguage,
            maxOutputTokens: params.maxOutputTokens,
            ...(params.ctx ? { ctx: params.ctx } : {}),
            ...(hint ? { hint } : {}),
            items: params.units.map((unit) => ({
                id: unit.id,
                text: unit.text,
                ...(unit.role ? { role: unit.role } : {}),
            })),
            ...(typeof onProgress === "function" ? { onProgress } : {}),
        };
    }

    formatUnit(item) {
        return {
            id: item.id,
            status: item.keepSource === true ? "unchanged" : "translated",
            translatedText: item.translatedText,
            ...(item.keepSource === true ? { keepSource: true } : {}),
        };
    }

    formatReply(params, profile, capabilities, result) {
        const common = {
            schemaVersion: params.schemaVersion,
            requestId: params.requestId,
            packetId: params.packetId,
            resolvedProvider: {
                provider: capabilities.provider,
                protocol: profile.protocol,
                modelId: profile.modelId,
                capabilityRevision: capabilities.revision,
            },
            usageReceipts: result.usageReceipts,
            attempt: result.attempt,
            actualAttemptCount:
                Number.isFinite(result.actualAttemptCount) && result.actualAttemptCount >= 0
                    ? Math.floor(result.actualAttemptCount)
                    : 1,
            costAttribution: String(result.costAttribution || "owner"),
        };
        if (result.ok) {
            return {
                ...common,
                ok: true,
                units: result.items.map((item) => this.formatUnit(item)),
            };
        }
        // errors.ts kinds pass through verbatim — the content retry table keys on them.
        return {
            ...common,
            ok: false,
            units: result.partialItems.map((item) => this.formatUnit(item)),
            failure: result.failure,
        };
    }

    async translate(params, sender = {}) {
        const validation = validatePagePacketRequest(params);
        if (!validation.ok) throw new TypeError(validation.errors.join("; "));
        this.cleanupCompleted();
        const tabId = tabIdFromSender(sender);
        const key = packetKey(tabId, params.sessionId, params.packetId);
        const completed = this.completed.get(key);
        if (completed) {
            if (completed.payloadHash !== params.payloadHash) {
                throw new Error("Packet ID was reused with a different payload");
            }
            return withoutUsage(completed.reply);
        }
        const existing = this.inflight.get(key);
        if (existing) {
            if (existing.payloadHash !== params.payloadHash) {
                throw new Error("Packet ID was reused with a different in-flight payload");
            }
            return withoutUsage(await existing.promise);
        }

        const controller = new AbortController();
        this.controllers.set(key, controller);
        const promise = (async () => {
            const { profile, adapter } = await this.resolve(params);
            const capabilities = await this.getCapabilities(params);
            const providerCap =
                this.concurrencyCaps[capabilities.provider] ??
                SHARED_PROVIDER_CONCURRENCY_CAPS.openaiCompatible;
            const release = await this.concurrencyGate.acquire(
                capabilities.limiterKey,
                providerCap,
                controller.signal
            );
            if (!release) {
                return this.formatReply(
                    params,
                    profile,
                    capabilities,
                    cancelledAttemptResult(params.requestId, controller.signal.reason)
                );
            }
            // Cancellation and FIFO admission can settle in the same turn. A waiter may already
            // have been granted a permit when its abort is observed, so re-check after acquire
            // and before the synchronous adapter call. This keeps a cancelled queued request at
            // zero provider attempts while still returning the permit exactly once.
            if (controller.signal.aborted) {
                release();
                return this.formatReply(
                    params,
                    profile,
                    capabilities,
                    cancelledAttemptResult(params.requestId, controller.signal.reason)
                );
            }
            let timedOut = false;
            const timeout = setTimeout(() => {
                timedOut = true;
                controller.abort("provider-timeout");
            }, Math.max(1000, Number(profile.timeoutMs) || 120000));
            try {
                const attemptProfile = profileForPacketHint(profile, params.hint);
                const emittedIds = new Set();
                const onProgress =
                    tabId !== -1 && this.emitProgress
                        ? (items) => {
                              const units = [];
                              for (const item of Array.isArray(items) ? items : []) {
                                  if (!item?.id || emittedIds.has(item.id)) continue;
                                  emittedIds.add(item.id);
                                  units.push(this.formatUnit(item));
                              }
                              if (!units.length || controller.signal.aborted) return;
                              try {
                                  this.emitProgress(tabId, AI_PAGE_EVENT_PROGRESS, {
                                      schemaVersion: params.schemaVersion,
                                      sessionId: params.sessionId,
                                      packetId: params.packetId,
                                      requestId: params.requestId,
                                      units,
                                  });
                              } catch {
                                  /* presentation progress is best-effort */
                              }
                          }
                        : undefined;
                let result = await adapter.executeOnce(
                    attemptProfile,
                    this.toAdapterRequest(params, onProgress),
                    controller.signal
                );
                if (timedOut && !result.ok && result.failure.kind === "cancelled") {
                    result = {
                        ...result,
                        failure: {
                            ...result.failure,
                            kind: "timeout",
                            message: "Provider request timed out",
                            retryDirective: "same-units",
                            requestMayHaveExecuted: true,
                        },
                    };
                }
                return this.formatReply(params, profile, capabilities, result);
            } finally {
                clearTimeout(timeout);
                release();
            }
        })();
        this.inflight.set(key, { payloadHash: params.payloadHash, promise });
        try {
            const reply = await promise;
            // cancel()/cancelAll() deliberately clear replayable replies. An adapter that ignores
            // AbortSignal may still settle successfully afterwards; never let that late result
            // resurrect the cancelled packet in the completed idempotency cache. The owner reply
            // retains its real usage because the provider request may have executed.
            if (!controller.signal.aborted && isCompletedReplyReplaySafe(reply)) {
                this.completed.set(key, {
                    payloadHash: params.payloadHash,
                    reply,
                    completedAt: Date.now(),
                });
            }
            return reply;
        } finally {
            this.inflight.delete(key);
            this.controllers.delete(key);
        }
    }

    cancel({ sessionId, packetIds, reason = "cancelled" }, sender = {}) {
        const tabId = tabIdFromSender(sender);
        const ids = Array.isArray(packetIds) ? new Set(packetIds) : null;
        let aborted = 0;
        for (const [key, controller] of this.controllers) {
            const prefix = `${tabId}:${sessionId}:`;
            if (!key.startsWith(prefix)) continue;
            const packetId = key.slice(prefix.length);
            if (ids && !ids.has(packetId)) continue;
            controller.abort(reason);
            aborted += 1;
        }
        for (const key of Array.from(this.completed.keys())) {
            const prefix = `${tabId}:${sessionId}:`;
            if (!key.startsWith(prefix)) continue;
            const packetId = key.slice(prefix.length);
            if (!ids || ids.has(packetId)) this.completed.delete(key);
        }
        return { aborted };
    }

    invalidateCapabilities() {
        this.capabilities.clear();
    }

    cancelAll(reason = "profile-changed") {
        let aborted = 0;
        for (const controller of this.controllers.values()) {
            controller.abort(reason);
            aborted += 1;
        }
        this.completed.clear();
        return { aborted };
    }
}

export {
    SHARED_PROVIDER_CONCURRENCY_CAPS,
    AiPageTranslationTransport,
    SharedProviderConcurrencyGate,
    packetKey,
};
