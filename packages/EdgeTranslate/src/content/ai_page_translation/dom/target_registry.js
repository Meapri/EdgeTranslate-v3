const TARGET_STATES = Object.freeze([
    "discovered",
    "cached",
    "queued",
    "in_flight",
    "retry_wait",
    "validated",
    "applied",
    "failed_terminal",
    "skipped_policy",
    "stale",
    "canceled",
]);

const TARGET_TRANSITIONS = Object.freeze({
    discovered: new Set([
        "cached",
        "queued",
        "failed_terminal",
        "skipped_policy",
        "stale",
        "canceled",
    ]),
    cached: new Set(["validated", "stale", "canceled"]),
    // A session-wide provider failure (bad key, exhausted quota, missing model)
    // can terminate work before a queued target is ever dispatched.
    queued: new Set(["in_flight", "failed_terminal", "stale", "canceled"]),
    in_flight: new Set(["validated", "retry_wait", "failed_terminal", "stale", "canceled"]),
    retry_wait: new Set(["queued", "failed_terminal", "stale", "canceled"]),
    validated: new Set(["applied", "stale", "canceled"]),
    applied: new Set(["stale"]),
    failed_terminal: new Set(["stale"]),
    skipped_policy: new Set(["stale"]),
    stale: new Set(),
    canceled: new Set(),
});

function makeNodeReference(node) {
    const WeakReference = typeof window !== "undefined" ? window.WeakRef : undefined;
    if (typeof WeakReference === "function") return new WeakReference(node);
    return { deref: () => node };
}

function normalizeSource(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

// Whitespace-normalized CAS compare (spec §3): hydration frameworks re-render Text nodes with
// identical content but churned boundary/internal whitespace, which fails an exact compare and
// used to strand the commit. The compare succeeds on normalized equality; the apply side then
// re-attaches the LIVE value's boundary whitespace exactly so page spacing is never altered.
// Rescued commits are counted under the cas_normalized_rescue telemetry counter.
function compareCapturedValue(liveValue, capturedValue) {
    if (liveValue === capturedValue) return { match: true, rescued: false };
    if (normalizeSource(liveValue) === normalizeSource(capturedValue)) {
        return { match: true, rescued: true };
    }
    return { match: false, rescued: false };
}

// Exact-preserving apply (spec §3): the translated text is written with the LIVE value's
// leading/trailing whitespace re-attached byte-for-byte.
function reattachBoundaryWhitespace(liveValue, translatedText) {
    const live = String(liveValue ?? "");
    const translated = String(translatedText ?? "").trim();
    if (!live.trim()) return translated || live;
    const leading = live.match(/^\s*/)[0];
    const trailing = live.match(/\s*$/)[0];
    return `${leading}${translated}${trailing}`;
}

// Block segments may introduce semantically required whitespace at inline placeholder
// boundaries even when the source language had none. Preserve that model-produced boundary
// verbatim, adding only live source boundaries that it omitted.
function reattachInlineBoundaryWhitespace(liveValue, translatedText) {
    const live = String(liveValue ?? "");
    let translated = String(translatedText ?? "");
    if (!live.trim()) return translated || live;
    const leading = live.match(/^\s*/)[0];
    const trailing = live.match(/\s*$/)[0];
    if (leading && !/^\s/.test(translated)) translated = leading + translated;
    if (trailing && !/\s$/.test(translated)) translated += trailing;
    return translated;
}

function isTextNode(node) {
    return Boolean(node && node.nodeType === 3 && typeof node.data === "string");
}

function isElementNode(node) {
    return Boolean(node && node.nodeType === 1 && typeof node.getAttribute === "function");
}

class TargetRegistry {
    constructor(sessionId) {
        if (typeof sessionId !== "string" || !sessionId.trim()) {
            throw new TypeError("TargetRegistry requires a non-empty sessionId");
        }
        this.sessionId = sessionId;
        this._sequence = 0;
        this._targets = new Map();
        this._textTargets = new WeakMap();
        this._attributeTargets = new WeakMap();
        this._blockTargets = new WeakMap();
        // Registry events are O(1) dirty-queue appends (spec §3). Consumers pull batches with
        // drainDirtyTargets(); snapshot() stays available for on-demand totals but must never
        // run per event — the per-event full snapshot is the banned O(n²) pattern.
        this._dirtyQueue = [];
        this._dirtyIds = new Set();
        this.telemetry = { cas_normalized_rescue: 0 };
    }

    registerText(node, metadata = {}) {
        if (!isTextNode(node)) throw new TypeError("registerText requires a Text node");
        const existingId = this._textTargets.get(node);
        if (existingId) return this._refreshExisting(existingId, node.data, metadata);
        const target = this._createTarget("text", node, node.data, metadata);
        this._textTargets.set(node, target.id);
        return target;
    }

    registerAttribute(element, attributeName, metadata = {}) {
        if (!isElementNode(element)) {
            throw new TypeError("registerAttribute requires an Element");
        }
        if (typeof attributeName !== "string" || !attributeName.trim()) {
            throw new TypeError("registerAttribute requires a non-empty attributeName");
        }
        const name = attributeName.trim();
        const source = element.getAttribute(name);
        if (source === null) throw new TypeError(`attribute ${name} is not present`);

        let byName = this._attributeTargets.get(element);
        if (!byName) {
            byName = new Map();
            this._attributeTargets.set(element, byName);
        }
        const existingId = byName.get(name);
        if (existingId) return this._refreshExisting(existingId, source, metadata);
        const target = this._createTarget("attribute", element, source, {
            ...metadata,
            attributeName: name,
        });
        byName.set(name, target.id);
        return target;
    }

    /**
     * Register one semantic leaf block (spec §1.1): the wire unit is the block, the commit
     * unit stays the individual Text node. `entries` is the ordered list of the block's Text
     * nodes, either bare nodes or `{ node, path }` where `path` is the block-local inline
     * placeholder path assigned by block_ir serialization.
     */
    registerBlockTarget(entries, metadata = {}) {
        const list = (Array.isArray(entries) ? entries : []).map((entry) =>
            isTextNode(entry)
                ? { node: entry, path: null }
                : { node: entry?.node, path: entry?.path ?? null }
        );
        if (!list.length || list.some(({ node }) => !isTextNode(node))) {
            throw new TypeError("registerBlockTarget requires an ordered list of Text nodes");
        }
        const existingId = this._blockTargets.get(list[0].node);
        if (existingId) return this._refreshExistingBlock(existingId, list, metadata);
        const target = this._createBlockTarget(list, metadata);
        for (const { node } of list) this._blockTargets.set(node, target.id);
        return target;
    }

    _createTarget(kind, node, source, metadata) {
        const id = metadata.id || `t${++this._sequence}`;
        if (this._targets.has(id)) throw new Error(`Duplicate translation target id: ${id}`);
        const target = {
            id,
            sessionId: this.sessionId,
            revision: 0,
            kind,
            nodeRef: makeNodeReference(node),
            ...(kind === "attribute" ? { attributeName: metadata.attributeName } : {}),
            source: String(source),
            normalizedSource: normalizeSource(source),
            role: metadata.role || "text",
            context: metadata.context || null,
            priority: metadata.priority || "deferred",
            state: "discovered",
            failureReason: null,
            appliedTranslation: null,
        };
        this._targets.set(id, target);
        this.appendDirty(target);
        return target;
    }

    _captureBlockNodes(list) {
        return list.map(({ node, path }) => ({
            nodeRef: makeNodeReference(node),
            path: path ?? null,
            source: String(node.data),
            appliedTranslation: null,
        }));
    }

    _createBlockTarget(list, metadata) {
        const id = metadata.id || `t${++this._sequence}`;
        if (this._targets.has(id)) throw new Error(`Duplicate translation target id: ${id}`);
        const textNodes = this._captureBlockNodes(list);
        const source =
            metadata.source !== undefined
                ? String(metadata.source)
                : textNodes.map((entry) => entry.source).join("");
        const target = {
            id,
            sessionId: this.sessionId,
            revision: 0,
            kind: "block",
            textNodes,
            source,
            normalizedSource: normalizeSource(source),
            role: metadata.role || "text",
            context: metadata.context || null,
            priority: metadata.priority || "deferred",
            state: "discovered",
            failureReason: null,
            appliedTranslation: null,
            appliedSegments: null,
        };
        this._targets.set(id, target);
        this.appendDirty(target);
        return target;
    }

    _refreshExisting(id, source, metadata) {
        const target = this.getOrThrow(id);
        const current = String(source);
        // A collector rescan sees the live translated DOM after a successful commit. That is
        // still the same target revision, not a site-authored source mutation. Treating the
        // applied translation as a new source creates a translate-observe-translate loop.
        const isOwnAppliedValue =
            target.state === "applied" &&
            target.appliedTranslation !== null &&
            current === target.appliedTranslation;
        if (current !== target.source && !isOwnAppliedValue) {
            return this.revise(id, current, metadata);
        }
        if (metadata.role) target.role = metadata.role;
        if (metadata.context !== undefined) target.context = metadata.context;
        if (metadata.priority) target.priority = metadata.priority;
        return target;
    }

    _refreshExistingBlock(id, list, metadata) {
        const target = this.getOrThrow(id);
        const sameShape =
            target.kind === "block" &&
            list.length === target.textNodes.length &&
            list.every(
                ({ node }, index) => (target.textNodes[index].nodeRef.deref() || null) === node
            );
        const capturedNodes = new Set(
            target.textNodes.map((entry) => entry.nodeRef.deref() || null).filter(Boolean)
        );
        const listIsAppliedSubset = list.every(({ node }) => capturedNodes.has(node));
        const allCapturedNodesStillApplied = target.textNodes.every((captured) => {
            const node = captured.nodeRef.deref() || null;
            return (
                node &&
                node.isConnected !== false &&
                captured.appliedTranslation !== null &&
                String(node.data) === captured.appliedTranslation
            );
        });
        const isOwnAppliedShape =
            target.state === "applied" && listIsAppliedSubset && allCapturedNodesStillApplied;
        // Same applied-value reasoning as _refreshExisting: a rescan that sees this block's own
        // committed translations is not a site mutation and must not bump the revision.
        //
        // A caller-provided serialized source that differs from the stored one is a revision
        // even when every node's data is unchanged: the collector re-serializes through
        // block_ir, so a differing source means the inline placeholder structure changed (or a
        // watcher-driven revise left the plain concatenation behind) and the stored source and
        // per-node paths are stale. Bare rescans never pass metadata.source and stay no-ops.
        // Phase-2 collection serializes the LIVE DOM and therefore supplies a translated
        // `metadata.source` after first paint. The per-node applied-value proof takes
        // precedence over that derived serialization; otherwise our own first-paint commit
        // becomes revision 1 and is sent to the provider a second time.
        const changed =
            !isOwnAppliedShape &&
            (!sameShape ||
                (metadata.source !== undefined && String(metadata.source) !== target.source) ||
                list.some(({ node }, index) => {
                    const captured = target.textNodes[index];
                    const current = String(node.data);
                    const isOwnAppliedValue =
                        target.state === "applied" &&
                        captured.appliedTranslation !== null &&
                        current === captured.appliedTranslation;
                    return current !== captured.source && !isOwnAppliedValue;
                }));
        if (changed) return this._reviseBlock(target, list, metadata);
        if (metadata.role) target.role = metadata.role;
        if (metadata.context !== undefined) target.context = metadata.context;
        if (metadata.priority) target.priority = metadata.priority;
        return target;
    }

    _reviseBlock(target, list, metadata) {
        target.revision += 1;
        target.textNodes = this._captureBlockNodes(list);
        for (const { node } of list) this._blockTargets.set(node, target.id);
        target.source =
            metadata.source !== undefined
                ? String(metadata.source)
                : target.textNodes.map((entry) => entry.source).join("");
        target.normalizedSource = normalizeSource(target.source);
        target.role = metadata.role || target.role;
        if (metadata.context !== undefined) target.context = metadata.context;
        target.priority = metadata.priority || target.priority;
        target.state = "discovered";
        target.failureReason = null;
        target.appliedTranslation = null;
        target.appliedSegments = null;
        this.appendDirty(target);
        return target;
    }

    revise(id, source, metadata = {}) {
        const target = this.getOrThrow(id);
        target.revision += 1;
        target.source = String(source);
        target.normalizedSource = normalizeSource(source);
        target.role = metadata.role || target.role;
        if (metadata.context !== undefined) target.context = metadata.context;
        target.priority = metadata.priority || target.priority;
        target.state = "discovered";
        target.failureReason = null;
        target.appliedTranslation = null;
        this.appendDirty(target);
        return target;
    }

    transition(id, nextState, metadata = {}) {
        const target = this.getOrThrow(id);
        if (!TARGET_STATES.includes(nextState)) {
            throw new TypeError(`Unknown translation target state: ${nextState}`);
        }
        if (target.state === nextState) return target;
        if (!TARGET_TRANSITIONS[target.state].has(nextState)) {
            throw new Error(`Invalid target state transition: ${target.state} -> ${nextState}`);
        }
        if (
            metadata.expectedRevision !== undefined &&
            metadata.expectedRevision !== target.revision
        ) {
            throw new Error(`Target ${id} revision changed before transition`);
        }
        target.state = nextState;
        target.failureReason = metadata.reason || null;
        if (metadata.appliedTranslation !== undefined) {
            target.appliedTranslation = metadata.appliedTranslation;
        }
        this.appendDirty(target);
        return target;
    }

    appendDirty(target) {
        if (!target || typeof target.id !== "string") return;
        if (this._dirtyIds.has(target.id)) return;
        this._dirtyIds.add(target.id);
        this._dirtyQueue.push(target.id);
    }

    drainDirtyTargets() {
        if (!this._dirtyQueue.length) return [];
        const drained = [];
        for (const id of this._dirtyQueue) {
            const target = this._targets.get(id);
            if (target) drained.push(target);
        }
        this._dirtyQueue = [];
        this._dirtyIds.clear();
        return drained;
    }

    recordCasNormalizedRescue(count = 1) {
        const rescues = Number(count);
        if (Number.isFinite(rescues) && rescues > 0) {
            this.telemetry.cas_normalized_rescue += rescues;
        }
        return this.telemetry.cas_normalized_rescue;
    }

    resolveNode(id) {
        const target = this.getOrThrow(id);
        if (target.kind === "block") {
            return target.textNodes[0]?.nodeRef.deref() || null;
        }
        return target.nodeRef.deref() || null;
    }

    get(id) {
        return this._targets.get(id) || null;
    }

    getOrThrow(id) {
        const target = this.get(id);
        if (!target) throw new Error(`Unknown translation target: ${id}`);
        return target;
    }

    list(states = null) {
        const filter = states ? new Set(Array.isArray(states) ? states : [states]) : null;
        return Array.from(this._targets.values()).filter(
            (target) => !filter || filter.has(target.state)
        );
    }

    snapshot() {
        const byState = Object.fromEntries(TARGET_STATES.map((state) => [state, 0]));
        const failedByReason = {};
        for (const target of this._targets.values()) {
            byState[target.state] += 1;
            if (target.state === "failed_terminal") {
                const reason = target.failureReason || "unknown";
                failedByReason[reason] = (failedByReason[reason] || 0) + 1;
            }
        }
        return {
            sessionId: this.sessionId,
            discovered: this._targets.size,
            byState,
            failedByReason,
        };
    }
}

export {
    TARGET_STATES,
    TARGET_TRANSITIONS,
    TargetRegistry,
    compareCapturedValue,
    normalizeSource,
    reattachBoundaryWhitespace,
    reattachInlineBoundaryWhitespace,
};
