/**
 * Shared provider-pressure limits for the vNext AI page translator.
 *
 * Content sessions own fast success/failure feedback, while the MV3 background owns the
 * aggregate provider/API-key gate across tabs. Both sides must use the same cap; keeping the
 * provider rows here prevents a scheduler tuning change from silently exceeding the background
 * safety boundary (or leaving paid capacity unused).
 */

const AI_PAGE_PROVIDER_AIMD = Object.freeze({
    googleAiStudio: Object.freeze({ start: 4, floor: 1, cap: 12, additivePerClean: 1 }),
    // OpenAI raised from the original unmeasured cap of 8. START == CAP (immediate full
    // concurrency, "speed mode"): a slow AIMD ramp from 8 (+1 per 4 clean needs ~96 completions
    // to reach cap) held a ~190-packet ja page at conc ~8-15 for most of its life -> 36.6s;
    // dispatching the full width immediately drops it well under target. Measured live on
    // gpt-5.6-luna reasoning:none against 京阪本線 (2004 strings, 0 failed): conc32 -> 29-30.5s
    // (borderline), conc40 -> 22.0s ×2 with 0×429. XDA (519 strings) -> 6-8.5s. Basis:
    // .artifacts/vnext-gates/latency-gpt-5.6-luna-none.md. Still multiplicatively backs off (×0.5)
    // + per-key cooldown on any real 429/5xx, so a lower-tier key self-corrects downward.
    openai: Object.freeze({ start: 40, floor: 1, cap: 40, additivePerClean: 4 }),
    openaiCompatible: Object.freeze({ start: 2, floor: 1, cap: 4, additivePerClean: 4 }),
});

const AI_PAGE_SHARED_CONCURRENCY_CAPS = Object.freeze({
    googleAiStudio: AI_PAGE_PROVIDER_AIMD.googleAiStudio.cap,
    openai: AI_PAGE_PROVIDER_AIMD.openai.cap,
    openaiCompatible: AI_PAGE_PROVIDER_AIMD.openaiCompatible.cap,
});

// Straggler tail-latency hedging (spec §2.3 tail control). Full-page wall-clock == slowest
// packet; the final waves usually have most concurrency slots idle, so one packet that draws a
// slow provider response drags the whole page out. When an in-flight packet has been running
// longer than `thresholdMs`, a slot is free AND no fresh work is queued, the scheduler fires a
// SECOND concurrent provider request for that same packet and takes whichever returns first
// (aborting the loser's local controller). Measured basis: 福島県 (2154 strings, 147 packets,
// gpt-5.6-luna reasoning:none) runs BIMODAL — ~14s fast vs ~55s slow — with identical request
// count/tokens/0-failed either way; the ~40s gap is one packet's slow OpenAI response while
// ~38/40 slots sit idle. thresholdMs 12000 sits well above the per-packet p90 (~8s) so ordinary
// packets are never hedged, yet catches the ~40s straggler mode early enough to collapse it.
// maxPerPacket 1 bounds cost/growth: at most one extra generation per packet (~1-2 packets/page).
const AI_PAGE_HEDGE = Object.freeze({
    enabled: true,
    thresholdMs: 12000,
    maxPerPacket: 1,
    checkIntervalMs: 1000,
});

export { AI_PAGE_HEDGE, AI_PAGE_PROVIDER_AIMD, AI_PAGE_SHARED_CONCURRENCY_CAPS };
