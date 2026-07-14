/**
 * Four-tier priority queue for the vNext AI page translation engine (spec §3).
 *
 * Tiers: T0 viewport ±1 screen (with a first-paint sub-lane ahead of it), T1 geometric prefetch
 * horizon, T2 document-order drain, T3 late-discovered content. `pull()` always serves the
 * lowest-numbered tier with work, FIFO within a tier.
 *
 * Reveal boost: an IntersectionObserver (rootMargin 250%) promotes NOT-yet-dispatched packets
 * whose targets intersect to the tier-0 lane. Packets are pre-serialized IR, so promotion moves
 * object references only — O(moved packets), zero re-serialization. In-flight (already pulled)
 * packets are never touched by promotion.
 *
 * Geometric horizon bookkeeping (spec §3): the prefetch horizon starts at 2 screens below /
 * 1 screen above the viewport and doubles after each completed horizon up to 8 screens —
 * exposed as `nextHorizonRange(viewportRect, completedHorizons)`.
 */

const TIER_COUNT = 4;
const HORIZON_START_SCREENS = 2;
const HORIZON_MAX_SCREENS = 8;
const HORIZON_ABOVE_SCREENS = 1;
const REVEAL_ROOT_MARGIN = "250%";

/**
 * Geometric prefetch-horizon helper. Returns the cumulative horizon band for the NEXT horizon
 * pass given how many horizons have already completed: `belowScreens` starts at 2 and doubles
 * per completed horizon, capped at 8; the band always keeps 1 screen above the viewport.
 * `newFrom`/`newTo` bound the not-yet-covered slice (below the viewport) so a caller can walk
 * only fresh ground; `exhausted` is true once the previous pass already reached the cap.
 */
function nextHorizonRange(viewportRect, completedHorizons) {
    const completed = Math.max(0, Math.floor(Number(completedHorizons) || 0));
    const top = Number(viewportRect?.top) || 0;
    const rawBottom = Number(viewportRect?.bottom);
    const rawHeight = Number(viewportRect?.height);
    const height = Number.isFinite(rawHeight)
        ? Math.max(0, rawHeight)
        : Math.max(0, (Number.isFinite(rawBottom) ? rawBottom : top) - top);
    const bottom = Number.isFinite(rawBottom) ? rawBottom : top + height;
    const belowScreens = Math.min(HORIZON_START_SCREENS * 2 ** completed, HORIZON_MAX_SCREENS);
    const previousBelowScreens =
        completed === 0
            ? 0
            : Math.min(HORIZON_START_SCREENS * 2 ** (completed - 1), HORIZON_MAX_SCREENS);
    return {
        aboveScreens: HORIZON_ABOVE_SCREENS,
        belowScreens,
        top: top - HORIZON_ABOVE_SCREENS * height,
        bottom: bottom + belowScreens * height,
        newFrom:
            completed === 0
                ? top - HORIZON_ABOVE_SCREENS * height
                : bottom + previousBelowScreens * height,
        newTo: bottom + belowScreens * height,
        exhausted: previousBelowScreens >= HORIZON_MAX_SCREENS,
    };
}

function targetIdsOfPacket(packet) {
    if (Array.isArray(packet?.targetIds)) return packet.targetIds.filter(Boolean);
    if (Array.isArray(packet?.items)) {
        return packet.items.map((item) => item?.targetId ?? item?.id).filter(Boolean);
    }
    return [];
}

function elementOfTarget(target) {
    if (!target || typeof target !== "object") return null;
    if (target.element && typeof target.element === "object") return target.element;
    if (target.node && typeof target.node === "object") return target.node;
    return typeof target.nodeType === "number" ? target : null;
}

function defaultRevealObserverFactory(onRevealed) {
    if (typeof IntersectionObserver !== "function") return null;
    const observer = new IntersectionObserver(
        (entries) => {
            onRevealed(
                entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target)
            );
        },
        { rootMargin: REVEAL_ROOT_MARGIN }
    );
    return {
        observe: (element) => observer.observe(element),
        unobserve: (element) => observer.unobserve(element),
        disconnect: () => observer.disconnect(),
    };
}

function makeLane() {
    return { records: [], head: 0 };
}

/**
 * Creates the queue. `revealObserverFactory(onRevealed)` is injectable for tests and must
 * return `{ observe(element), unobserve?(element), disconnect() }` (or null when reveal
 * observation is unavailable); `onRevealed` receives an array of revealed elements.
 */
function createPriorityQueue({ revealObserverFactory } = {}) {
    // Lane pull order: first-paint sub-lane, reveal-promoted lane, then tiers 0..3. Records are
    // tombstoned by lane mismatch on promotion, so a move costs O(1) per moved packet and stale
    // entries are skipped (and released) lazily during pull().
    const firstPaintLane = makeLane();
    const promotedLane = makeLane();
    const tierLanes = [makeLane(), makeLane(), makeLane(), makeLane()];
    const records = new Map(); // packet -> record
    const targetIndex = new Map(); // targetId -> Set(record)
    const elementIndex = new Map(); // element -> Set(packet)
    let observer;
    let observerCreated = false;
    let stopped = false;

    function laneForPush(packet, tier) {
        if (tier === 0 && packet?.firstPaint === true) return firstPaintLane;
        return tierLanes[tier];
    }

    function deindexRecord(record) {
        for (const targetId of record.targetIds) {
            const set = targetIndex.get(targetId);
            if (!set) continue;
            set.delete(record);
            if (!set.size) targetIndex.delete(targetId);
        }
    }

    function push(packet, tier) {
        if (stopped || !packet || typeof packet !== "object") return;
        const tierIndex = Math.floor(Number(tier));
        if (!Number.isInteger(tierIndex) || tierIndex < 0 || tierIndex >= TIER_COUNT) {
            throw new TypeError(`Packet tier must be an integer 0..3, got ${tier}`);
        }
        const previous = records.get(packet);
        if (previous && previous.state === "queued") {
            // Re-pushing a still-queued packet replaces its position; the old lane entry is
            // tombstoned and skipped on pull.
            previous.state = "removed";
            deindexRecord(previous);
        }
        const lane = laneForPush(packet, tierIndex);
        const record = {
            packet,
            tier: tierIndex,
            lane,
            state: "queued",
            targetIds: targetIdsOfPacket(packet),
        };
        records.set(packet, record);
        lane.records.push(record);
        for (const targetId of record.targetIds) {
            let set = targetIndex.get(targetId);
            if (!set) {
                set = new Set();
                targetIndex.set(targetId, set);
            }
            set.add(record);
        }
    }

    function trimLaneHead(lane) {
        while (lane.head < lane.records.length) {
            const record = lane.records[lane.head];
            if (record.lane === lane && record.state === "queued") break;
            lane.head += 1;
        }
        if (lane.head > 0 && lane.head >= lane.records.length) {
            lane.records.length = 0;
            lane.head = 0;
        }
    }

    function pullFromLane(lane, comparePackets, acceptPacket) {
        trimLaneHead(lane);
        if (!lane.records.length) return null;

        let selectedIndex = -1;
        for (let index = lane.head; index < lane.records.length; index += 1) {
            const candidate = lane.records[index];
            if (candidate.lane !== lane || candidate.state !== "queued") continue;
            if (typeof acceptPacket === "function" && !acceptPacket(candidate.packet)) continue;
            if (selectedIndex < 0) {
                selectedIndex = index;
                if (typeof comparePackets !== "function") break;
                continue;
            }
            const selected = lane.records[selectedIndex];
            if (comparePackets(candidate.packet, selected.packet) < 0) {
                selectedIndex = index;
            }
        }
        if (selectedIndex < 0) return null;

        const record = lane.records[selectedIndex];
        record.state = "dispatched";
        deindexRecord(record);
        trimLaneHead(lane);
        return record.packet;
    }

    function pull(options = {}) {
        if (stopped) return null;
        const comparePackets =
            typeof options === "function"
                ? options
                : typeof options?.compare === "function"
                ? options.compare
                : null;
        const acceptPacket = typeof options?.accept === "function" ? options.accept : null;
        const order = [firstPaintLane, promotedLane, ...tierLanes];
        for (const lane of order) {
            const packet = pullFromLane(lane, comparePackets, acceptPacket);
            if (packet) return packet;
        }
        return null;
    }

    function promoteRecord(record) {
        if (
            record.state !== "queued" ||
            record.lane === promotedLane ||
            record.lane === firstPaintLane
        ) {
            return false;
        }
        // Tombstone in the old lane (skipped lazily), reference move into the tier-0 promoted
        // lane. The packet object is untouched — pre-serialized IR is promoted as-is.
        record.lane = promotedLane;
        promotedLane.records.push(record);
        return true;
    }

    function promoteByTargets(targetIds) {
        if (stopped) return 0;
        let moved = 0;
        for (const targetId of Array.isArray(targetIds) ? targetIds : []) {
            const set = targetIndex.get(targetId);
            if (!set) continue;
            for (const record of Array.from(set)) {
                if (promoteRecord(record)) moved += 1;
            }
        }
        return moved;
    }

    function handleRevealedElements(elements) {
        for (const element of Array.isArray(elements) ? elements : []) {
            const packets = elementIndex.get(element);
            if (!packets) continue;
            for (const packet of packets) {
                const record = records.get(packet);
                if (record) promoteRecord(record);
            }
            elementIndex.delete(element);
            if (observer && typeof observer.unobserve === "function") observer.unobserve(element);
        }
    }

    function ensureObserver() {
        if (observerCreated) return observer;
        observerCreated = true;
        const factory =
            typeof revealObserverFactory === "function"
                ? revealObserverFactory
                : defaultRevealObserverFactory;
        observer = factory(handleRevealedElements) || null;
        return observer;
    }

    function observeForReveal(target, packetRef) {
        if (stopped || !packetRef || typeof packetRef !== "object") return;
        const element = elementOfTarget(target);
        if (!element) return;
        const revealObserver = ensureObserver();
        if (!revealObserver) return;
        let packets = elementIndex.get(element);
        if (!packets) {
            packets = new Set();
            elementIndex.set(element, packets);
            revealObserver.observe(element);
        }
        packets.add(packetRef);
    }

    function sizeByTier() {
        const counts = [0, 0, 0, 0];
        for (const record of records.values()) {
            if (record.state !== "queued") continue;
            const effectiveTier =
                record.lane === promotedLane || record.lane === firstPaintLane ? 0 : record.tier;
            counts[effectiveTier] += 1;
        }
        return counts;
    }

    function stop() {
        stopped = true;
        if (observer && typeof observer.disconnect === "function") observer.disconnect();
        observer = null;
        records.clear();
        targetIndex.clear();
        elementIndex.clear();
        for (const lane of [firstPaintLane, promotedLane, ...tierLanes]) {
            lane.records.length = 0;
            lane.head = 0;
        }
    }

    return { push, pull, promoteByTargets, observeForReveal, sizeByTier, stop };
}

export {
    HORIZON_ABOVE_SCREENS,
    HORIZON_MAX_SCREENS,
    HORIZON_START_SCREENS,
    REVEAL_ROOT_MARGIN,
    createPriorityQueue,
    nextHorizonRange,
};
