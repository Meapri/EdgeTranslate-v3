import {
    UsageLedger,
    createUsageLedger,
    receiptTotal,
} from "../../../src/content/ai_page_translation/runtime/usage_ledger.js";

function usageReceipt(id, input, output, overrides = {}) {
    return {
        billingEventId: id,
        inputTokens: { value: input, source: "provider-reported" },
        outputTokens: { value: output, source: "provider-reported" },
        totalTokens: { value: input + output, source: "provider-reported" },
        reasoningRelation: "included-in-output",
        ...overrides,
    };
}

describe("AI page translation vNext usage ledger", () => {
    it("deduplicates provider billing receipts by billingEventId", () => {
        const ledger = createUsageLedger();
        const receipt = usageReceipt("bill-1", 20, 5, {
            cachedInputTokens: { value: 10, source: "provider-reported" },
        });

        ledger.settle("p1", [receipt]);
        ledger.settle("p2", [receipt]);

        expect(ledger.snapshot()).toMatchObject({
            confirmedSpent: 25,
            estimatedSpent: 0,
            spentTokens: 25,
            requestCount: 1,
            incompleteUsageEvents: 0,
        });
    });

    it("does not charge a replayed completed response arriving with usage stripped", () => {
        const ledger = new UsageLedger();
        ledger.settle("p1", [usageReceipt("bill-1", 10, 5)], { estimatedTokens: 20 });

        // Transport replay of an already-billed reply: no receipts, no new cost.
        const result = ledger.settle("p1", []);

        expect(result.charged).toBe(0);
        expect(ledger.snapshot()).toMatchObject({
            confirmedSpent: 15,
            estimatedSpent: 0,
            spentTokens: 15,
            incompleteUsageEvents: 0,
            requestCount: 1,
        });
    });

    it("treats reasoning as additional only when the provider contract says so", () => {
        expect(
            receiptTotal({
                inputTokens: { value: 10, source: "provider-reported" },
                outputTokens: { value: 5, source: "provider-reported" },
                reasoningTokens: { value: 3, source: "provider-reported" },
                reasoningRelation: "additional-to-output",
            }).tokens
        ).toBe(18);
    });

    it("flags usage the provider failed to report instead of booking zero", () => {
        const ledger = new UsageLedger();
        const result = ledger.settle("p1", [
            {
                billingEventId: "bill-1",
                inputTokens: { value: 10, source: "provider-reported" },
                // Output usage missing entirely: total is null, not zero.
            },
        ]);

        expect(result.charged).toBe(0);
        expect(ledger.snapshot()).toMatchObject({
            spentTokens: 0,
            incompleteUsageEvents: 1,
            requestCount: 1,
        });
    });

    it("books the packet estimate conservatively when delivery may have executed", () => {
        const ledger = new UsageLedger();
        const result = ledger.settle("p1", [], {
            chargeEstimateOnMissing: true,
            estimatedTokens: 30,
        });

        expect(result.charged).toBe(30);
        expect(ledger.snapshot()).toMatchObject({
            confirmedSpent: 0,
            estimatedSpent: 30,
            incompleteUsageEvents: 1,
            requestCount: 1,
        });
    });

    it("counts an executed request and estimates cost when its receipt is present but unusable", () => {
        const ledger = new UsageLedger();
        ledger.settle("p1", [{ billingEventId: "bill-missing", inputTokens: { value: 10 } }], {
            chargeEstimateOnMissing: true,
            estimatedTokens: 42,
            requestCount: 1,
        });

        expect(ledger.snapshot()).toMatchObject({
            confirmedSpent: 0,
            estimatedSpent: 42,
            spentTokens: 42,
            incompleteUsageEvents: 1,
            requestCount: 1,
        });
    });

    it("charges missing recovery usage without expanding the page calibration estimate", () => {
        const ledger = new UsageLedger();
        ledger.setPlannedEstimate(100);
        ledger.settle("recovery-1", [], {
            chargeEstimateOnMissing: true,
            estimatedTokens: 42,
            calibrationEstimatedTokens: 0,
            requestCount: 1,
        });

        expect(ledger.snapshot()).toMatchObject({
            estimatedSpent: 42,
            calibrationEstimateTokens: 0,
            calibrationSpentTokens: 0,
            requestCount: 1,
        });
    });

    it("attributes spend to the receipt's cost owner", () => {
        const ledger = new UsageLedger();
        ledger.settle("p1", [usageReceipt("bill-1", 10, 5)]);
        ledger.settle("p2", [
            usageReceipt("bill-2", 20, 5, { costAttribution: "ambiguous-retry" }),
        ]);

        expect(ledger.snapshot().spentByAttribution).toEqual({
            primary: 15,
            "ambiguous-retry": 25,
        });
    });

    it("splits settled and estimated tokens for the banner and counts incomplete strings", () => {
        const ledger = new UsageLedger();
        ledger.settle("p1", [usageReceipt("bill-1", 20, 5)]);
        ledger.settle("p2", [
            usageReceipt("bill-2", 30, 10, {
                totalTokens: { value: 40, source: "client-estimated" },
            }),
        ]);
        ledger.recordIncompleteStrings(3);

        expect(ledger.bannerSnapshot()).toEqual({
            settledTokens: 25,
            estimatedTokens: 40,
            totalTokens: 65,
            requestCount: 2,
            incompleteStrings: 3,
            incompleteUsageEvents: 0,
            runawayLatched: false,
        });
    });

    it("reconciles incomplete strings when a later SPA revision succeeds", () => {
        const ledger = new UsageLedger();
        ledger.recordIncompleteStrings(3);
        expect(ledger.resolveIncompleteStrings(1)).toBe(2);
        expect(ledger.resolveIncompleteStrings(99)).toBe(0);
        expect(ledger.bannerSnapshot().incompleteStrings).toBe(0);
    });

    it("never latches on an honest page with accurate estimates", () => {
        const ledger = new UsageLedger();
        ledger.setPlannedEstimate(1000);
        for (let index = 1; index <= 10; index += 1) {
            ledger.settle(`p${index}`, [usageReceipt(`bill-${index}`, 60, 40)], {
                estimatedTokens: 100,
            });
            expect(ledger.runawayLatched).toBe(false);
        }
        expect(ledger.snapshot()).toMatchObject({
            spentTokens: 1000,
            projectedWholePageTokens: 1000,
            runawayLatched: false,
        });
    });

    it("never latches when the estimator is uniformly wrong, because receipts calibrate it", () => {
        const ledger = new UsageLedger();
        ledger.setPlannedEstimate(1000);
        // Every packet costs 2x its estimate: the projection scales with the receipts.
        for (let index = 1; index <= 10; index += 1) {
            ledger.settle(`p${index}`, [usageReceipt(`bill-${index}`, 120, 80)], {
                estimatedTokens: 100,
            });
            expect(ledger.runawayLatched).toBe(false);
        }
        expect(ledger.snapshot().projectedWholePageTokens).toBe(2000);
    });

    it("latches loudly only past 2.5x the receipt-calibrated whole-page estimate", () => {
        const onRunaway = jest.fn();
        const ledger = createUsageLedger({ onRunaway });
        ledger.setPlannedEstimate(1000);
        // Calibration: three planned packets, accurate receipts -> projection 1000.
        for (let index = 1; index <= 3; index += 1) {
            ledger.settle(`p${index}`, [usageReceipt(`cal-${index}`, 60, 40)], {
                estimatedTokens: 100,
            });
        }
        expect(ledger.snapshot().projectedWholePageTokens).toBe(1000);

        // Runaway spend: retries billing fresh receipts without planned-estimate progress.
        for (let index = 1; index <= 11; index += 1) {
            ledger.settle("p1", [usageReceipt(`retry-${index}`, 150, 50)]);
        }
        // Exactly 2.5x (300 + 11*200 = 2500): still not latched.
        expect(ledger.snapshot().spentTokens).toBe(2500);
        expect(ledger.runawayLatched).toBe(false);
        expect(onRunaway).not.toHaveBeenCalled();

        ledger.settle("p1", [usageReceipt("retry-12", 1, 0)]);
        expect(ledger.runawayLatched).toBe(true);
        expect(onRunaway).toHaveBeenCalledTimes(1);

        // Latched state is sticky and the signal fires once.
        ledger.settle("p1", [usageReceipt("retry-13", 1, 0)]);
        expect(onRunaway).toHaveBeenCalledTimes(1);
    });

    it("requires three settled receipts before the latch can arm", () => {
        const ledger = new UsageLedger();
        ledger.setPlannedEstimate(1000);
        ledger.settle("p1", [usageReceipt("cal-1", 60, 40)], { estimatedTokens: 100 });
        // Projection is 1000; this second receipt blows way past 2.5x but only two
        // settled receipts exist, so the latch must stay unarmed.
        ledger.settle("p1", [usageReceipt("retry-1", 2500, 100)]);
        expect(ledger.snapshot().settledReceiptCount).toBe(2);
        expect(ledger.runawayLatched).toBe(false);

        ledger.settle("p1", [usageReceipt("retry-2", 10, 0)]);
        expect(ledger.runawayLatched).toBe(true);
    });

    it("projects null, not zero, before any calibration data exists", () => {
        const ledger = new UsageLedger();
        expect(ledger.projectedWholePageTokens()).toBeNull();
        ledger.setPlannedEstimate(1000);
        expect(ledger.projectedWholePageTokens()).toBeNull();
    });
});
