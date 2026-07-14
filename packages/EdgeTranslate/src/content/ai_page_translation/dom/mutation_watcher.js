/**
 * Mutation watching for the vNext AI page translation engine (spec §3).
 *
 * ONE MutationObserver on the narrowed translation roots (childList + characterData + subtree),
 * coalescing bursts in a 75ms window (pinned in tools/vnext-gates/config.json), plus a
 * root-guardian observer on documentElement that recovers from whole-body replacement (SPA
 * re-mounts). Own writes are recognized by delegating to the registry's applied-value guard —
 * a characterData record on a tracked node is routed BACK through registerText /
 * registerBlockTarget, whose refresh path compares the live value against the captured
 * appliedTranslation. There are NO wall-clock suppression windows: a site mutation that lands
 * one microsecond after an apply is still detected, and a rescan of our own committed value is
 * never re-enqueued. True mutations bump the target revision via the registry and surface
 * through onChangedTarget; unknown content surfaces through onNewContent.
 *
 * pause(fn) runs fn with the observer disconnected and reconnects afterwards — the committer's
 * batch applies run inside it so bulk commits never generate observer traffic at all; the
 * applied-value guard remains the backstop for everything else.
 */

import { TRANSLATABLE_ATTRIBUTE_NAMES, translatableAttributeNames } from "./collector.js";

const OBSERVER_CONFIG = Object.freeze({
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTE_NAMES,
});

function isElementNode(node) {
    return Boolean(node && node.nodeType === 1);
}

function nodeContains(container, node) {
    if (!container || !node || typeof container.contains !== "function") return false;
    try {
        return container.contains(node);
    } catch {
        return false;
    }
}

class MutationWatcher {
    constructor({ registry, coalesceMs = 75, onNewContent, onChangedTarget } = {}) {
        if (!registry || typeof registry.registerBlockTarget !== "function") {
            throw new TypeError("MutationWatcher requires a TargetRegistry");
        }
        this.registry = registry;
        this.coalesceMs = Number.isFinite(coalesceMs) ? coalesceMs : 75;
        this.onNewContent = typeof onNewContent === "function" ? onNewContent : () => undefined;
        this.onChangedTarget =
            typeof onChangedTarget === "function" ? onChangedTarget : () => undefined;
        this.observer = null;
        this.rootGuardian = null;
        this.started = false;
        this.roots = new Set();
        // root -> { wasBody, elementId } used by the guardian to find a replacement.
        this.rootRecovery = new Map();
        this.trackedByNode = new WeakMap();
        this.trackedAttributesByElement = new WeakMap();
        this.pendingContentRoots = new Set();
        this.pendingTrackedNodes = new Set();
        this.pendingTrackedAttributes = new Map();
        this.flushTimer = null;
    }

    /**
     * Indexes a registered target's DOM nodes so characterData records on them take the
     * registry-guard path instead of being treated as unknown content. Attribute targets are
     * indexed by (Element, attributeName), so an attribute-only SPA update revises the same
     * target instead of silently leaving its first collected value in place.
     */
    track(target) {
        if (!target) return;
        if (target.kind === "block") {
            for (const entry of target.textNodes || []) {
                const node = entry?.nodeRef?.deref?.() || null;
                if (node) this.trackedByNode.set(node, target.id);
            }
            return;
        }
        if (target.kind === "text") {
            const node = target.nodeRef?.deref?.() || null;
            if (node) this.trackedByNode.set(node, target.id);
            return;
        }
        if (target.kind === "attribute") {
            const element = target.nodeRef?.deref?.() || null;
            const name = String(target.attributeName || "").toLowerCase();
            if (!element || !name) return;
            let byName = this.trackedAttributesByElement.get(element);
            if (!byName) {
                byName = new Map();
                this.trackedAttributesByElement.set(element, byName);
            }
            byName.set(name, target.id);
        }
    }

    start(roots) {
        if (this.started || typeof MutationObserver !== "function") return;
        this.started = true;
        this.observer = new MutationObserver((records) => this._onRecords(records));
        for (const root of (Array.isArray(roots) ? roots : [roots]).filter(Boolean)) {
            this._addRoot(root, { guard: true });
            this._observeOpenShadowRoots(root);
        }
        this._startRootGuardian();
    }

    stop() {
        this.observer?.disconnect();
        this.observer = null;
        this.rootGuardian?.disconnect();
        this.rootGuardian = null;
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.pendingContentRoots.clear();
        this.pendingTrackedNodes.clear();
        this.pendingTrackedAttributes.clear();
        this.roots.clear();
        this.rootRecovery.clear();
        this.started = false;
    }

    /**
     * Runs `fn` with the observer disconnected, then reconnects every root — used by the
     * committer's batch applies. Records already queued before the pause are preserved and
     * routed normally; records for mutations made inside `fn` are never generated.
     */
    pause(fn) {
        if (!this.observer) return fn();
        const pending = this.observer.takeRecords();
        if (pending.length) this._onRecords(pending);
        this.observer.disconnect();
        try {
            return fn();
        } finally {
            for (const root of this.roots) this.observer.observe(root, OBSERVER_CONFIG);
        }
    }

    _addRoot(root, { guard = false } = {}) {
        if (!root || this.roots.has(root)) return;
        this.roots.add(root);
        if (guard) {
            this.rootRecovery.set(root, {
                wasBody: typeof document !== "undefined" && root === document.body,
                elementId: (isElementNode(root) && root.id) || null,
            });
        }
        this.observer?.observe(root, OBSERVER_CONFIG);
    }

    _observeOpenShadowRoots(root) {
        if (isElementNode(root) && root.shadowRoot?.mode === "open") {
            this._addRoot(root.shadowRoot);
        }
        for (const element of root?.querySelectorAll?.("*") || []) {
            if (element.shadowRoot?.mode === "open") this._addRoot(element.shadowRoot);
        }
    }

    _startRootGuardian() {
        if (
            this.rootGuardian ||
            typeof MutationObserver !== "function" ||
            typeof document === "undefined" ||
            !document.documentElement
        ) {
            return;
        }
        this.rootGuardian = new MutationObserver(() => this._recoverReplacedRoots());
        this.rootGuardian.observe(document.documentElement, { childList: true, subtree: true });
    }

    _recoverReplacedRoots() {
        for (const [root, info] of Array.from(this.rootRecovery)) {
            if (root.isConnected) continue;
            const replacement = info.wasBody
                ? document.body
                : info.elementId
                ? document.getElementById(info.elementId)
                : null;
            if (!replacement || replacement === root || this.roots.has(replacement)) continue;
            this.roots.delete(root);
            this.rootRecovery.delete(root);
            this._addRoot(replacement, { guard: true });
            this._observeOpenShadowRoots(replacement);
            this._enqueueContentRoot(replacement);
        }
        this._scheduleFlush();
    }

    _onRecords(records) {
        for (const record of records || []) {
            if (record.type === "characterData") {
                const node = record.target;
                if (this.trackedByNode.has(node)) this.pendingTrackedNodes.add(node);
                else if (node.parentElement) this._enqueueContentRoot(node.parentElement);
                continue;
            }
            if (record.type === "attributes") {
                const element = record.target;
                const name = String(record.attributeName || "").toLowerCase();
                const trackedId = this.trackedAttributesByElement.get(element)?.get(name);
                if (trackedId) {
                    this.pendingTrackedAttributes.set(trackedId, { element, name });
                } else if (translatableAttributeNames(element).includes(name)) {
                    // Newly added translatable attribute: normal subtree collection creates
                    // and indexes its registry target.
                    this._enqueueContentRoot(element);
                }
                continue;
            }
            if (record.type !== "childList") continue;
            for (const added of record.addedNodes || []) {
                this._enqueueContentRoot(added);
                if (isElementNode(added)) this._observeOpenShadowRoots(added);
            }
        }
        this._scheduleFlush();
    }

    // Containment pruning (v2 convention): keep only the outermost pending roots so one SPA
    // subtree swap surfaces as one onNewContent root instead of hundreds.
    _enqueueContentRoot(node) {
        if (!node) return;
        for (const existing of Array.from(this.pendingContentRoots)) {
            if (existing === node || nodeContains(existing, node)) return;
            if (nodeContains(node, existing)) this.pendingContentRoots.delete(existing);
        }
        this.pendingContentRoots.add(node);
    }

    _scheduleFlush() {
        if (this.flushTimer !== null) return;
        if (
            !this.pendingContentRoots.size &&
            !this.pendingTrackedNodes.size &&
            !this.pendingTrackedAttributes.size
        ) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this._flush();
        }, this.coalesceMs);
    }

    _flush() {
        const trackedNodes = Array.from(this.pendingTrackedNodes);
        this.pendingTrackedNodes.clear();
        const changedIds = new Set();
        for (const node of trackedNodes) {
            if (!node.isConnected) continue;
            const id = this.trackedByNode.get(node);
            const target = id ? this.registry.get(id) : null;
            if (!target || changedIds.has(target.id)) continue;
            if (this._refreshThroughRegistry(target, node)) {
                changedIds.add(target.id);
                this.onChangedTarget(this.registry.get(target.id) || target);
            }
        }
        const trackedAttributes = Array.from(this.pendingTrackedAttributes.entries());
        this.pendingTrackedAttributes.clear();
        for (const [id, { element, name }] of trackedAttributes) {
            if (!element?.isConnected || changedIds.has(id)) continue;
            const target = this.registry.get(id);
            if (!target || target.kind !== "attribute") continue;
            const revisionBefore = target.revision;
            if (element.hasAttribute(name)) {
                this.registry.registerAttribute(element, name, {});
            } else {
                // Attribute removal is still a real revision. The session will retire the
                // now-empty target instead of allowing an in-flight CAS miss to look complete.
                this.registry.revise(id, "", {});
            }
            const changed = this.registry.get(id) || target;
            if (changed.revision !== revisionBefore) {
                changedIds.add(id);
                this.onChangedTarget(changed);
            }
        }
        const contentRoots = Array.from(this.pendingContentRoots);
        this.pendingContentRoots.clear();
        if (contentRoots.length) this.onNewContent(contentRoots);
    }

    /**
     * Routes a mutated tracked node back through the registry so the applied-value guard
     * decides: own committed value → no-op; true site mutation → revision bump. Returns true
     * when the registry revised the target.
     */
    _refreshThroughRegistry(target, node) {
        const revisionBefore = target.revision;
        if (target.kind === "block") {
            const entries = [];
            for (const captured of target.textNodes || []) {
                const liveNode = captured?.nodeRef?.deref?.() || null;
                if (!liveNode || !liveNode.isConnected) {
                    // Structural loss inside the block: hand the region to re-collection
                    // instead of guessing a shape for the registry.
                    if (node.parentElement) this._enqueueContentRoot(node.parentElement);
                    return false;
                }
                entries.push({ node: liveNode, path: captured.path ?? null });
            }
            const refreshed = this.registry.registerBlockTarget(entries, {});
            return refreshed.id !== target.id || refreshed.revision !== revisionBefore;
        }
        if (target.kind === "text") {
            const refreshed = this.registry.registerText(node, {});
            return refreshed.id !== target.id || refreshed.revision !== revisionBefore;
        }
        return false;
    }
}

export { MutationWatcher };
