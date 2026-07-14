import {
    MAX_LADDER_DEPTH,
    RETRY_TABLE,
    SCHEDULER_RETRY_KINDS,
    TERMINAL_FAILURE_KINDS,
    createRecoveryController,
} from "../../../src/content/ai_page_translation/runtime/recovery.js";

function wireItems(count) {
    return Array.from({ length: count }, (_, index) => ({
        id: `b${index + 1}`,
        text: `source ${index + 1}`,
        entry: { id: `b${index + 1}`, recovery: {} },
    }));
}

/** Drives the wire ladder to termination, counting requests the way the scheduler would. */
function driveWireLadder(controller, kind, items) {
    let calls = 1; // the original packet request
    let frontier = [{ meta: null, items }];
    const keepSource = [];
    let guard = 64;
    while (frontier.length) {
        if (--guard < 0) throw new Error("ladder did not terminate");
        const next = [];
        for (const node of frontier) {
            const plan = controller.planWireFailure(node.meta, kind, node.items);
            keepSource.push(...plan.keepSource);
            for (const descriptor of plan.packets) {
                calls += 1;
                next.push({ meta: descriptor, items: descriptor.items });
            }
        }
        frontier = next;
    }
    return { calls, keepSource };
}

describe("vNext recovery policy (spec §7 as data)", () => {
    it("pins the retry table to the gate-config resilience bounds", () => {
        expect(RETRY_TABLE.transient.maxRetries).toBe(3);
        expect(RETRY_TABLE["rate-limit"].maxRetries).toBe(3);
        expect(RETRY_TABLE.timeout.maxRetries).toBe(3);
        expect(RETRY_TABLE["delivery-unknown"].maxRetries).toBe(1);
        expect(RETRY_TABLE["delivery-unknown"].idempotentReplay).toBe(true);
        expect(RETRY_TABLE["output-limit"].maxSplits).toBe(2);
        expect(RETRY_TABLE["schema-invalid"].maxRequestsPerLineage).toBe(3);
        expect(RETRY_TABLE["placeholder-invalid"].repairRetries).toBe(1);
        expect(RETRY_TABLE["placeholder-invalid"].degradesPerBlock).toBe(1);
        expect(RETRY_TABLE["semantic-invalid"].retries).toBe(1);
        for (const kind of ["auth", "quota", "model-not-found", "missing-key"]) {
            expect(RETRY_TABLE[kind].owner).toBe("circuit");
            expect(RETRY_TABLE[kind].kind).toBe("terminal");
            expect(RETRY_TABLE[kind].circuit).toBe(true);
            expect(TERMINAL_FAILURE_KINDS.has(kind)).toBe(true);
        }
        for (const kind of SCHEDULER_RETRY_KINDS) {
            expect(RETRY_TABLE[kind].owner).toBe("scheduler");
        }
        // Dual vocabulary: the same rows drive the C1 scheduler's decision engine directly,
        // so the session can pass this table as-is (kind + bounds in scheduler terms).
        expect(RETRY_TABLE.transient.kind).toBe("backoff-retry");
        expect(RETRY_TABLE["rate-limit"].limiterCooldown).toBe(true);
        expect(RETRY_TABLE["delivery-unknown"].kind).toBe("replay-once");
        expect(RETRY_TABLE["delivery-unknown"].maxReplays).toBe(1);
        expect(RETRY_TABLE["schema-invalid"].kind).toBe("ladder");
        expect(RETRY_TABLE["schema-invalid"].maxRounds).toBe(2);
        expect(RETRY_TABLE["unsupported-capability"]).toMatchObject({
            owner: "recovery",
            kind: "ladder",
            maxRounds: 1,
        });
        expect(TERMINAL_FAILURE_KINDS.has("unsupported-capability")).toBe(true);
        expect(RETRY_TABLE.cancelled.circuit).toBe(false);
    });

    it("costs exactly 3 requests for a persistently schema-invalid single block (stable pin)", () => {
        const controller = createRecoveryController();
        const { calls, keepSource } = driveWireLadder(controller, "schema-invalid", wireItems(1));
        // original + reinforced same retry + per-block atomic, then terminal keep-source.
        expect(calls).toBe(3);
        expect(keepSource).toHaveLength(1);
    });

    it("resolves 8 malformed blocks in at most 16 calls (google depth-halving pin)", () => {
        const controller = createRecoveryController();
        const { calls, keepSource } = driveWireLadder(controller, "schema-invalid", wireItems(8));
        // 1 original + 1 reinforced + 2 bisection halves + 8 per-block atomics = 12.
        expect(calls).toBe(12);
        expect(calls).toBeLessThanOrEqual(16);
        expect(keepSource).toHaveLength(8);
    });

    it("splits output-limit packets ceil(n/2) at most twice, then per-block atomic once, then incomplete", () => {
        const controller = createRecoveryController();
        const items = wireItems(8);
        const first = controller.planWireFailure(null, "output-limit", items);
        expect(first.packets.map((p) => p.items.length)).toEqual([4, 4]);
        expect(first.packets.every((p) => p.splits === 1)).toBe(true);
        const second = controller.planWireFailure(
            first.packets[0],
            "output-limit",
            first.packets[0].items
        );
        expect(second.packets.map((p) => p.items.length)).toEqual([2, 2]);
        expect(second.packets.every((p) => p.splits === 2)).toBe(true);
        const third = controller.planWireFailure(
            second.packets[0],
            "output-limit",
            second.packets[0].items
        );
        expect(third.packets.every((p) => p.mode === "atomic" && p.items.length === 1)).toBe(true);
        expect(third.packets).toHaveLength(2);
        const terminal = controller.planWireFailure(
            third.packets[0],
            "output-limit",
            third.packets[0].items
        );
        expect(terminal.packets).toHaveLength(0);
        expect(terminal.keepSource).toHaveLength(1);
    });

    it("split-to-isolates content filters and never retries the singleton", () => {
        const controller = createRecoveryController();
        const items = wireItems(4);
        const first = controller.planWireFailure(null, "content-filter", items);
        expect(first.packets.map((p) => p.items.length)).toEqual([2, 2]);
        const singleton = controller.planWireFailure(first.packets[0], "content-filter", [
            first.packets[0].items[0],
        ]);
        expect(singleton.packets).toHaveLength(0);
        expect(singleton.keepSource).toHaveLength(1);
    });

    it("keeps recovery packets strictly shrinking and terminates within the depth ceiling", () => {
        const controller = createRecoveryController();
        for (const kind of ["schema-invalid", "output-limit", "content-filter"]) {
            let frontier = [{ meta: null, items: wireItems(9) }];
            let depth = 0;
            while (frontier.length) {
                depth += 1;
                expect(depth).toBeLessThanOrEqual(MAX_LADDER_DEPTH + 1);
                const next = [];
                for (const node of frontier) {
                    const plan = controller.planWireFailure(node.meta, kind, node.items);
                    const produced = plan.packets.reduce((sum, p) => sum + p.items.length, 0);
                    expect(produced + plan.keepSource.length).toBeLessThanOrEqual(
                        node.items.length
                    );
                    for (const descriptor of plan.packets) {
                        expect(descriptor.items.length).toBeLessThanOrEqual(node.items.length);
                        next.push({ meta: descriptor, items: descriptor.items });
                    }
                }
                frontier = next;
            }
        }
    });

    it("never decomposes chunk fragments or atomic parts further", () => {
        const controller = createRecoveryController();
        const chunkItem = { id: "b1#c2", text: "tail", chunk: { parentId: "b1" }, entry: {} };
        const plan = controller.planWireFailure(
            { stage: "reinforced", depth: 1 },
            "schema-invalid",
            [chunkItem]
        );
        expect(plan.packets).toHaveLength(0);
        expect(plan.keepSource).toEqual([chunkItem]);
    });

    it("walks the §1.4 placeholder ladder: retry, then flatten for styling-only blocks", () => {
        const events = [];
        const controller = createRecoveryController({ onTelemetry: (name) => events.push(name) });
        const entry = { id: "b1", text: "src", hasInteractive: false, recovery: {} };
        const first = controller.planItemFailures({
            placeholder: [{ entry, translated: "<g1>bad" }],
        });
        expect(first.retry).toEqual([entry]);
        const second = controller.planItemFailures({
            placeholder: [{ entry, translated: "<g1>still bad" }],
        });
        expect(second.flatten).toEqual([{ entry, translated: "<g1>still bad" }]);
        expect(events).toEqual(["placeholder_retry", "placeholder_flattened"]);
        expect(controller.telemetry()).toMatchObject({
            placeholder_retry: 1,
            placeholder_flattened: 1,
        });
    });

    it("atomic-degrades interactive blocks once and then keeps source — never flattens a link", () => {
        const controller = createRecoveryController();
        const entry = { id: "b1", text: "src", hasInteractive: true, recovery: {} };
        const first = controller.planItemFailures({ placeholder: [{ entry, translated: "x" }] });
        expect(first.retry).toEqual([entry]);
        const second = controller.planItemFailures({ placeholder: [{ entry, translated: "x" }] });
        expect(second.atomic).toEqual([entry]);
        expect(second.flatten).toHaveLength(0);
        const third = controller.planItemFailures({ placeholder: [{ entry, translated: "x" }] });
        expect(third.keepSource).toEqual([entry]);
        expect(controller.telemetry()).toMatchObject({
            placeholder_retry: 1,
            placeholder_atomic_degrade: 1,
            keep_source_terminal: 1,
        });
    });

    it("constrains an interactive order violation before atomic fallback and records a bounded reason", () => {
        const controller = createRecoveryController();
        const entry = {
            id: "b1",
            text: "src",
            hasInteractive: true,
            recovery: { orderUnrepresentable: true },
        };

        const first = controller.planItemFailures({
            placeholder: [{ entry, translated: "moved wrapper" }],
        });
        expect(first.orderRetry).toEqual([entry]);
        expect(first.retry).toHaveLength(0);

        const second = controller.planItemFailures({
            placeholder: [{ entry, translated: "still moved" }],
        });
        expect(second.atomic).toEqual([entry]);
        expect(second.flatten).toHaveLength(0);

        const terminal = controller.planItemFailures({
            placeholder: [{ entry, translated: "still invalid" }],
        });
        expect(terminal.keepSource).toEqual([entry]);
        expect(entry.recovery.terminalReason).toBe("inline-order");
        expect(controller.telemetry()).toMatchObject({
            placeholder_retry: 1,
            inline_order_constrained_retry: 1,
            placeholder_atomic_degrade: 1,
            keep_source_terminal: 1,
        });
    });

    it("retries semantic hard-fails items-only exactly once, then keeps source", () => {
        const controller = createRecoveryController();
        const entry = { id: "b1", recovery: {} };
        const first = controller.planItemFailures({ semantic: [entry] });
        expect(first.semanticRetry).toEqual([entry]);
        const second = controller.planItemFailures({ semantic: [entry] });
        expect(second.semanticRetry).toHaveLength(0);
        expect(second.keepSource).toEqual([entry]);
    });
});
