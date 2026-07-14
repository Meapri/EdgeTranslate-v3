/**
 * Usage ledger for the vNext AI page translation engine (spec §4.1 receipts + §7 latch).
 *
 * Port of ai_page_translation_v2/runtime/budget_ledger.js — THE owner of UsageReceipt
 * settlement. Kept from the port: billingEventId dedupe (one-owner cost attribution — every
 * provider receipt is charged exactly once, in exactly one settle), provenance tags, and
 * null-not-zero accounting: usage a provider failed to report is flagged as an incomplete
 * usage event, never silently booked as zero cost.
 *
 * Removed from the port: the reserve-before-send gate. vNext has no budget pause and no
 * Continue button (product policy, spec §3); the only bounded cost guard is the 2.5×
 * receipt-calibrated runaway latch below.
 *
 * Added: banner counters (settled/estimated token split, billed request count, per-string
 * incomplete count) and the runaway latch (spec §7.2): after >=3 settled receipts, project
 * whole-page spend = settledSoFar × (totalPlannedEstOut / settledEstOut); the latch fires —
 * an abort-loudly signal, never a silent pause — only when settled spend exceeds
 * runawayLatchRatio × that calibrated whole-page estimate. Because the projection scales
 * with the receipts themselves, a uniformly wrong estimator can never trip it; only spend
 * that accrues WITHOUT planned-estimate progress (retry loops, amplification) can.
 */

const DEFAULT_RUNAWAY_LATCH_RATIO = 2.5;
const DEFAULT_MIN_SETTLED_RECEIPTS = 3;

function usageFieldValue(field) {
    if (Number.isFinite(field)) return Number(field);
    return field && Number.isFinite(field.value) ? Number(field.value) : null;
}

function receiptTotal(receipt) {
    const total = usageFieldValue(receipt?.totalTokens);
    if (total !== null) {
        return {
            tokens: total,
            estimated: receipt.totalTokens?.source === "client-estimated",
            incomplete: false,
        };
    }
    const input = usageFieldValue(receipt?.inputTokens);
    const output = usageFieldValue(receipt?.outputTokens);
    if (input === null || output === null) return null;
    let tokens = input + output;
    const reasoning = usageFieldValue(receipt?.reasoningTokens);
    if (receipt.reasoningRelation === "additional-to-output") {
        if (reasoning === null) return null;
        tokens += reasoning;
    } else if (receipt.reasoningRelation === "unknown" && reasoning !== null) {
        tokens += reasoning;
    }
    const sources = [
        receipt.inputTokens?.source,
        receipt.outputTokens?.source,
        receipt.reasoningTokens?.source,
    ];
    return {
        tokens,
        estimated: sources.includes("client-estimated"),
        incomplete: receipt.reasoningRelation === "unknown",
    };
}

class UsageLedger {
    constructor({ runawayLatchRatio, minSettledReceipts, onRunaway } = {}) {
        this.runawayLatchRatio =
            Number.isFinite(runawayLatchRatio) && runawayLatchRatio > 0
                ? Number(runawayLatchRatio)
                : DEFAULT_RUNAWAY_LATCH_RATIO;
        this.minSettledReceipts =
            Number.isFinite(minSettledReceipts) && minSettledReceipts >= 0
                ? Math.floor(minSettledReceipts)
                : DEFAULT_MIN_SETTLED_RECEIPTS;
        this.onRunaway = typeof onRunaway === "function" ? onRunaway : null;
        this.confirmedSpent = 0;
        this.estimatedSpent = 0;
        this.incompleteUsageEvents = 0;
        this.incompleteStrings = 0;
        this.requestCount = 0;
        this.receiptIds = new Set();
        this.spentByAttribution = new Map();
        // Runaway-latch calibration state (spec §7.2).
        this.plannedEstimateTokens = 0;
        this.calibrationEstimateTokens = 0;
        this.calibrationSpentTokens = 0;
        this.calibratedPacketIds = new Set();
        this.settledReceiptCount = 0;
        this.runawayLatched = false;
    }

    get spentTokens() {
        return this.confirmedSpent + this.estimatedSpent;
    }

    /**
     * Whole-page planned estimate (estimator output tokens for every planned packet). The
     * planner re-calls this as collection/planning discovers more of the page; the latch
     * projection always uses the latest total.
     */
    setPlannedEstimate(totalEstimatedTokens) {
        const total = Number(totalEstimatedTokens);
        if (Number.isFinite(total) && total >= 0) this.plannedEstimateTokens = total;
        return this.plannedEstimateTokens;
    }

    /**
     * Settles a packet's usage receipts. `options.estimatedTokens` is the packet's planned
     * estimate — passed on the packet's FIRST settle it becomes a calibration sample pairing
     * heuristic estimate with actual receipts. Retries, transport replays and recovery
     * packets settle without a fresh estimate, so they raise settled spend without raising
     * the projection; that widening gap is exactly what the runaway latch measures.
     *
     * `options.chargeEstimateOnMissing` books the estimate as conservative estimated spend
     * when delivery may have executed but no usage came back (replaces the deleted
     * reservation charge). `options.calibrationEstimatedTokens` can be zero for recovery
     * requests so conservative missing-usage accounting does not expand the calibrated page
     * projection. The default is NOT to charge: a transport replay of a completed response
     * arrives with usage stripped, and charging it would double count.
     */
    settle(packetId, receipts = [], options = {}) {
        let charged = 0;
        let calibrationCharge = 0;
        let sawNewReceipt = false;
        let completeReceiptCount = 0;
        let newReceiptCount = 0;
        let missingUsageRecorded = false;
        const attribution = String(options.costAttribution || "primary");
        for (const receipt of receipts || []) {
            if (!receipt?.billingEventId || this.receiptIds.has(receipt.billingEventId)) {
                continue;
            }
            this.receiptIds.add(receipt.billingEventId);
            sawNewReceipt = true;
            newReceiptCount += 1;
            this.requestCount += 1;
            const total = receiptTotal(receipt);
            if (!total) {
                // Null-not-zero: a billed request whose usage cannot be computed is an
                // incomplete usage event, never a free request.
                this.incompleteUsageEvents += 1;
                missingUsageRecorded = true;
                continue;
            }
            completeReceiptCount += 1;
            charged += total.tokens;
            calibrationCharge += total.tokens;
            if (total.estimated) {
                this.estimatedSpent += total.tokens;
            } else {
                this.confirmedSpent += total.tokens;
                this.settledReceiptCount += 1;
            }
            if (total.incomplete) this.incompleteUsageEvents += 1;
            const owner = String(receipt.costAttribution || attribution);
            this.spentByAttribution.set(
                owner,
                (this.spentByAttribution.get(owner) || 0) + total.tokens
            );
        }
        const requestedCount = Number(options.requestCount);
        let reportedRequests = Number.isFinite(requestedCount)
            ? Math.max(0, Math.floor(requestedCount))
            : options.chargeEstimateOnMissing === true
            ? 1
            : 0;
        const suppliedReceiptCount = Array.isArray(receipts) ? receipts.length : 0;
        if (suppliedReceiptCount > 0 && newReceiptCount === 0) {
            // Every supplied receipt was already settled. billingEventId is the billing
            // identity of record, so this is a replay of an existing request, not a fresh
            // missing-usage request that should receive another estimate/count.
            reportedRequests = 0;
        }
        // Receipts already count their own requests. actualAttemptCount fills only the gap,
        // which keeps a normal missing-usage response visible without double-counting a
        // response that did include one or more receipts.
        this.requestCount += Math.max(0, reportedRequests - newReceiptCount);
        const estimatedTokens = Math.max(0, Math.ceil(Number(options.estimatedTokens) || 0));
        const calibrationEstimatedTokens = Math.max(
            0,
            Math.ceil(
                Number(
                    options.calibrationEstimatedTokens === undefined
                        ? estimatedTokens
                        : options.calibrationEstimatedTokens
                ) || 0
            )
        );
        const missingUsageForExecutedRequest =
            reportedRequests > completeReceiptCount && completeReceiptCount === 0;
        if (
            options.chargeEstimateOnMissing === true &&
            estimatedTokens &&
            ((!sawNewReceipt && reportedRequests > 0) || missingUsageForExecutedRequest)
        ) {
            this.estimatedSpent += estimatedTokens;
            charged += estimatedTokens;
            if (!missingUsageRecorded) this.incompleteUsageEvents += 1;
            this.spentByAttribution.set(
                attribution,
                (this.spentByAttribution.get(attribution) || 0) + estimatedTokens
            );
        }
        if (calibrationEstimatedTokens && packetId && !this.calibratedPacketIds.has(packetId)) {
            this.calibratedPacketIds.add(packetId);
            this.calibrationEstimateTokens += calibrationEstimatedTokens;
            this.calibrationSpentTokens += calibrationCharge;
        }
        this.checkRunawayLatch();
        return { charged, snapshot: this.snapshot() };
    }

    /** Banner "Translation incomplete: N strings" counter (spec §4.1 / §7). */
    recordIncompleteStrings(count = 1) {
        const strings = Number(count);
        if (Number.isFinite(strings) && strings > 0) {
            this.incompleteStrings += Math.floor(strings);
        }
        return this.incompleteStrings;
    }

    /** Reconciles a previously terminal string that a later SPA revision makes translatable. */
    resolveIncompleteStrings(count = 1) {
        const strings = Number(count);
        if (Number.isFinite(strings) && strings > 0) {
            this.incompleteStrings = Math.max(0, this.incompleteStrings - Math.floor(strings));
        }
        return this.incompleteStrings;
    }

    /**
     * Receipt-calibrated whole-page projection: settledSoFar × (planned / settledEst) over
     * the calibration samples. Null — not zero — until at least one calibration sample and a
     * planned total exist.
     */
    projectedWholePageTokens() {
        if (!(this.calibrationEstimateTokens > 0) || !(this.plannedEstimateTokens > 0)) {
            return null;
        }
        return (
            this.calibrationSpentTokens *
            (this.plannedEstimateTokens / this.calibrationEstimateTokens)
        );
    }

    checkRunawayLatch() {
        if (this.runawayLatched) return true;
        if (this.settledReceiptCount < this.minSettledReceipts) return false;
        const projected = this.projectedWholePageTokens();
        if (projected === null || projected <= 0) return false;
        if (this.spentTokens <= this.runawayLatchRatio * projected) return false;
        this.runawayLatched = true;
        if (this.onRunaway) {
            try {
                this.onRunaway(this.snapshot());
            } catch {
                // The latch state is the signal of record; a throwing observer must not
                // corrupt settlement.
            }
        }
        return true;
    }

    /** Compact counters for the translation banner. */
    bannerSnapshot() {
        return {
            settledTokens: this.confirmedSpent,
            estimatedTokens: this.estimatedSpent,
            totalTokens: this.spentTokens,
            requestCount: this.requestCount,
            incompleteStrings: this.incompleteStrings,
            incompleteUsageEvents: this.incompleteUsageEvents,
            runawayLatched: this.runawayLatched,
        };
    }

    snapshot() {
        return {
            confirmedSpent: this.confirmedSpent,
            estimatedSpent: this.estimatedSpent,
            spentTokens: this.spentTokens,
            incompleteUsageEvents: this.incompleteUsageEvents,
            incompleteStrings: this.incompleteStrings,
            requestCount: this.requestCount,
            spentByAttribution: Object.fromEntries(this.spentByAttribution),
            plannedEstimateTokens: this.plannedEstimateTokens,
            calibrationEstimateTokens: this.calibrationEstimateTokens,
            calibrationSpentTokens: this.calibrationSpentTokens,
            settledReceiptCount: this.settledReceiptCount,
            projectedWholePageTokens: this.projectedWholePageTokens(),
            runawayLatched: this.runawayLatched,
        };
    }
}

function createUsageLedger(options = {}) {
    return new UsageLedger(options);
}

export { UsageLedger, createUsageLedger, receiptTotal, usageFieldValue };
