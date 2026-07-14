import {
    HORIZON_MAX_SCREENS,
    HORIZON_START_SCREENS,
    createPriorityQueue,
    nextHorizonRange,
} from "../../../src/content/ai_page_translation/runtime/priority_queue.js";

function makePacket(id, targetIds = [], extra = {}) {
    return { id, targetIds, serialize: jest.fn(), ...extra };
}

function createFakeObserver() {
    const state = { onRevealed: null };
    const observer = {
        observe: jest.fn(),
        unobserve: jest.fn(),
        disconnect: jest.fn(),
    };
    const factory = jest.fn((onRevealed) => {
        state.onRevealed = onRevealed;
        return observer;
    });
    return { factory, observer, reveal: (elements) => state.onRevealed(elements) };
}

describe("vNext AI page translation priority queue (spec §3)", () => {
    describe("tier ordering", () => {
        it("pulls the lowest tier first and FIFO within a tier", () => {
            const queue = createPriorityQueue();
            const p2a = makePacket("p2a");
            const p0a = makePacket("p0a");
            const p1a = makePacket("p1a");
            const p0b = makePacket("p0b");
            const p3a = makePacket("p3a");
            const p2b = makePacket("p2b");
            queue.push(p2a, 2);
            queue.push(p0a, 0);
            queue.push(p1a, 1);
            queue.push(p0b, 0);
            queue.push(p3a, 3);
            queue.push(p2b, 2);

            expect(queue.pull()).toBe(p0a);
            expect(queue.pull()).toBe(p0b);
            expect(queue.pull()).toBe(p1a);
            expect(queue.pull()).toBe(p2a);
            expect(queue.pull()).toBe(p2b);
            expect(queue.pull()).toBe(p3a);
            expect(queue.pull()).toBeNull();
        });

        it("serves the first-paint sub-lane ahead of other tier-0 packets", () => {
            const queue = createPriorityQueue();
            const normal = makePacket("normal");
            const firstPaint = makePacket("fp", [], { firstPaint: true });
            queue.push(normal, 0);
            queue.push(firstPaint, 0);

            expect(queue.pull()).toBe(firstPaint);
            expect(queue.pull()).toBe(normal);
        });

        it("selects by a comparator only within the current lane without losing earlier records", () => {
            const queue = createPriorityQueue();
            const first = makePacket("first", [], { estOut: 900 });
            const shortest = makePacket("shortest", [], { estOut: 100 });
            const middle = makePacket("middle", [], { estOut: 500 });
            queue.push(first, 1);
            queue.push(shortest, 1);
            queue.push(middle, 1);
            const shortestFirst = (a, b) => a.estOut - b.estOut;

            expect(queue.pull({ compare: shortestFirst })).toBe(shortest);
            expect(queue.pull({ compare: shortestFirst })).toBe(middle);
            expect(queue.pull({ compare: shortestFirst })).toBe(first);
            expect(queue.pull({ compare: shortestFirst })).toBeNull();
        });

        it("never lets a comparator cross the tier boundary", () => {
            const queue = createPriorityQueue();
            const recovery = makePacket("recovery", [], { estOut: 900 });
            const drain = makePacket("drain", [], { estOut: 1 });
            queue.push(drain, 1);
            queue.push(recovery, 0);

            expect(queue.pull({ compare: (a, b) => a.estOut - b.estOut })).toBe(recovery);
            expect(queue.pull({ compare: (a, b) => a.estOut - b.estOut })).toBe(drain);
        });

        it("skips an ineligible packet without removing it or blocking another lane", () => {
            const queue = createPriorityQueue();
            const blocked = makePacket("blocked");
            const eligible = makePacket("eligible");
            queue.push(blocked, 0);
            queue.push(eligible, 2);

            expect(queue.pull({ accept: (packet) => packet !== blocked })).toBe(eligible);
            expect(queue.pull()).toBe(blocked);
            expect(queue.pull()).toBeNull();
        });

        it("rejects tiers outside 0..3", () => {
            const queue = createPriorityQueue();
            expect(() => queue.push(makePacket("x"), 4)).toThrow(TypeError);
            expect(() => queue.push(makePacket("x"), -1)).toThrow(TypeError);
        });
    });

    describe("reveal promotion", () => {
        it("promoteByTargets moves only not-yet-dispatched packets to the tier-0 lane", () => {
            const queue = createPriorityQueue();
            const a = makePacket("a", ["ta"]);
            const b = makePacket("b", ["tb"]);
            const c = makePacket("c", ["tc"]);
            const d = makePacket("d", ["td"]);
            queue.push(a, 2);
            queue.push(b, 2);
            queue.push(c, 2);

            // a is dispatched (in flight) — promotion must not touch it.
            expect(queue.pull()).toBe(a);
            expect(queue.promoteByTargets(["ta", "tb"])).toBe(1);
            queue.push(d, 1);

            expect(queue.pull()).toBe(b); // promoted to tier-0 lane
            expect(queue.pull()).toBe(d); // tier 1
            expect(queue.pull()).toBe(c); // tier 2
            expect(queue.pull()).toBeNull(); // a is NOT re-delivered
        });

        it("promotion preserves packet identity and never re-serializes the IR", () => {
            const queue = createPriorityQueue();
            const packet = makePacket("p", ["tp"]);
            queue.push(packet, 2);

            queue.promoteByTargets(["tp"]);
            const pulled = queue.pull();

            expect(pulled).toBe(packet); // same object reference — zero re-serialization
            expect(packet.serialize).not.toHaveBeenCalled();
        });

        it("promoting the same target twice is idempotent", () => {
            const queue = createPriorityQueue();
            const packet = makePacket("p", ["tp"]);
            queue.push(packet, 3);

            expect(queue.promoteByTargets(["tp"])).toBe(1);
            expect(queue.promoteByTargets(["tp"])).toBe(0);
            expect(queue.pull()).toBe(packet);
            expect(queue.pull()).toBeNull();
        });

        it("derives target ids from packet items when targetIds is absent", () => {
            const queue = createPriorityQueue();
            const packet = { id: "p", items: [{ id: "item-1" }, { targetId: "item-2" }] };
            queue.push(packet, 2);

            expect(queue.promoteByTargets(["item-2"])).toBe(1);
            expect(queue.sizeByTier()).toEqual([1, 0, 0, 0]);
        });

        it("observeForReveal promotes packets when the observer reveals their element", () => {
            const fake = createFakeObserver();
            const queue = createPriorityQueue({ revealObserverFactory: fake.factory });
            const element = document.createElement("div");
            const packet = makePacket("p", ["tp"]);
            queue.push(packet, 2);
            queue.observeForReveal({ element }, packet);

            expect(fake.factory).toHaveBeenCalledTimes(1);
            expect(fake.observer.observe).toHaveBeenCalledWith(element);
            expect(queue.sizeByTier()).toEqual([0, 0, 1, 0]);

            fake.reveal([element]);

            expect(queue.sizeByTier()).toEqual([1, 0, 0, 0]);
            expect(queue.pull()).toBe(packet);
            expect(fake.observer.unobserve).toHaveBeenCalledWith(element);
        });

        it("revealing an element whose packet is already dispatched never requeues it", () => {
            const fake = createFakeObserver();
            const queue = createPriorityQueue({ revealObserverFactory: fake.factory });
            const element = document.createElement("div");
            const packet = makePacket("p", ["tp"]);
            queue.push(packet, 2);
            queue.observeForReveal({ element }, packet);

            expect(queue.pull()).toBe(packet); // in flight
            fake.reveal([element]);

            expect(queue.sizeByTier()).toEqual([0, 0, 0, 0]);
            expect(queue.pull()).toBeNull();
        });
    });

    describe("bookkeeping", () => {
        it("sizeByTier reflects pushes, promotions and pulls", () => {
            const queue = createPriorityQueue();
            const firstPaint = makePacket("fp", [], { firstPaint: true });
            const n0 = makePacket("n0");
            const n1 = makePacket("n1");
            const n2 = makePacket("n2", ["t2"]);
            const n3 = makePacket("n3");
            queue.push(firstPaint, 0);
            queue.push(n0, 0);
            queue.push(n1, 1);
            queue.push(n2, 2);
            queue.push(n3, 3);

            expect(queue.sizeByTier()).toEqual([2, 1, 1, 1]);

            queue.promoteByTargets(["t2"]);
            expect(queue.sizeByTier()).toEqual([3, 1, 0, 1]);

            expect(queue.pull()).toBe(firstPaint);
            expect(queue.pull()).toBe(n2); // promoted lane ahead of plain tier 0
            expect(queue.sizeByTier()).toEqual([1, 1, 0, 1]);
        });

        it("stop() disconnects the reveal observer and empties the queue", () => {
            const fake = createFakeObserver();
            const queue = createPriorityQueue({ revealObserverFactory: fake.factory });
            const element = document.createElement("div");
            const packet = makePacket("p", ["tp"]);
            queue.push(packet, 1);
            queue.observeForReveal({ element }, packet);

            queue.stop();

            expect(fake.observer.disconnect).toHaveBeenCalledTimes(1);
            expect(queue.pull()).toBeNull();
            queue.push(makePacket("late"), 0);
            expect(queue.sizeByTier()).toEqual([0, 0, 0, 0]);
        });
    });

    describe("geometric prefetch horizon (spec §3)", () => {
        const viewport = { top: 0, bottom: 800, height: 800 };

        it("doubles 2 -> 4 -> 8 screens and caps at 8", () => {
            expect(HORIZON_START_SCREENS).toBe(2);
            expect(HORIZON_MAX_SCREENS).toBe(8);
            expect(nextHorizonRange(viewport, 0).belowScreens).toBe(2);
            expect(nextHorizonRange(viewport, 1).belowScreens).toBe(4);
            expect(nextHorizonRange(viewport, 2).belowScreens).toBe(8);
            expect(nextHorizonRange(viewport, 3).belowScreens).toBe(8);
            expect(nextHorizonRange(viewport, 7).belowScreens).toBe(8);
        });

        it("computes the cumulative band and the fresh slice from the viewport rect", () => {
            const first = nextHorizonRange(viewport, 0);
            expect(first).toMatchObject({ top: -800, bottom: 2400, newFrom: -800, newTo: 2400 });
            expect(first.exhausted).toBe(false);

            const second = nextHorizonRange(viewport, 1);
            expect(second).toMatchObject({ bottom: 4000, newFrom: 2400, newTo: 4000 });
            expect(second.exhausted).toBe(false);

            const third = nextHorizonRange(viewport, 2);
            expect(third).toMatchObject({ bottom: 7200, newFrom: 4000, newTo: 7200 });
            expect(third.exhausted).toBe(false);

            const capped = nextHorizonRange(viewport, 3);
            expect(capped).toMatchObject({ bottom: 7200, newFrom: 7200, newTo: 7200 });
            expect(capped.exhausted).toBe(true);
        });

        it("always keeps one screen above the viewport and derives height when absent", () => {
            for (let completed = 0; completed < 4; completed += 1) {
                const range = nextHorizonRange(viewport, completed);
                expect(range.aboveScreens).toBe(1);
                expect(range.top).toBe(-800);
            }
            const derived = nextHorizonRange({ top: 100, bottom: 900 }, 0);
            expect(derived.top).toBe(-700);
            expect(derived.bottom).toBe(900 + 2 * 800);
        });
    });
});
