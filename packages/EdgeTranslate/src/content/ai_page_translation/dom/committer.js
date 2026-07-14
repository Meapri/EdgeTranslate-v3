import { compareCapturedValue, reattachInlineBoundaryWhitespace } from "./target_registry.js";

function resolveTargetNode(target) {
    if (!target || !target.nodeRef || typeof target.nodeRef.deref !== "function") return null;
    return target.nodeRef.deref() || null;
}

function readTargetValue(target, node = resolveTargetNode(target)) {
    if (!node) return null;
    if (target.kind === "text") return typeof node.data === "string" ? node.data : null;
    if (target.kind === "attribute" && target.attributeName) {
        return typeof node.getAttribute === "function"
            ? node.getAttribute(target.attributeName)
            : null;
    }
    return null;
}

function isConnected(node) {
    return Boolean(node && node.isConnected !== false);
}

function commitTargetTranslation(target, translatedText, expected = {}) {
    if (!target || typeof target !== "object") return { status: "invalid", reason: "target" };
    if (typeof translatedText !== "string" || (!expected.allowEmpty && !translatedText.trim())) {
        return { status: "invalid", reason: "translation" };
    }
    if (expected.sessionId && target.sessionId !== expected.sessionId) {
        return { status: "stale", reason: "session" };
    }
    if (expected.revision !== undefined && target.revision !== expected.revision) {
        return { status: "stale", reason: "revision" };
    }

    const node = resolveTargetNode(target);
    if (!isConnected(node)) return { status: "stale", reason: "detached" };
    if (readTargetValue(target, node) !== target.source) {
        return { status: "stale", reason: "source-changed" };
    }

    if (target.kind === "text") node.data = translatedText;
    else if (target.kind === "attribute" && target.attributeName) {
        node.setAttribute(target.attributeName, translatedText);
    } else {
        return { status: "invalid", reason: "kind" };
    }
    target.appliedTranslation = translatedText;
    target.appliedRevision = target.revision;
    return { status: "applied", targetId: target.id, revision: target.revision };
}

function restoreTargetSource(target, expected = {}) {
    if (!target || typeof target !== "object") return { status: "invalid", reason: "target" };
    if (expected.sessionId && target.sessionId !== expected.sessionId) {
        return { status: "stale", reason: "session" };
    }
    const node = resolveTargetNode(target);
    if (!isConnected(node)) return { status: "stale", reason: "detached" };

    const current = readTargetValue(target, node);
    if (current === target.source) return { status: "unchanged", targetId: target.id };
    if (target.appliedTranslation === null || current !== target.appliedTranslation) {
        return { status: "preserved", reason: "site-changed", targetId: target.id };
    }

    if (target.kind === "text") node.data = target.source;
    else if (target.kind === "attribute" && target.attributeName) {
        node.setAttribute(target.attributeName, target.source);
    } else {
        return { status: "invalid", reason: "kind" };
    }
    target.appliedTranslation = null;
    return { status: "restored", targetId: target.id };
}

/**
 * Fan-out apply for "block" registry targets (spec §1.1): the block is the wire unit, but the
 * commit unit stays the individual Text node. Every per-node write runs the same CAS guards as
 * commitTargetTranslation — session, revision, connectivity, source compare — using the
 * whitespace-normalized compare with exact-preserving apply of spec §3. `segments` is the
 * per-Text-node translated text in `blockTarget.textNodes` order ("" blanks a node whose text
 * moved into a sibling; boundary whitespace of the LIVE value is always preserved).
 */
function applyBlock(blockTarget, segments, expected = {}) {
    const rejection = (status, reason) => ({
        status,
        reason,
        applied: 0,
        casFailures: 0,
        normalizedRescues: 0,
    });
    if (!blockTarget || blockTarget.kind !== "block" || !Array.isArray(blockTarget.textNodes)) {
        return rejection("invalid", "target");
    }
    if (!Array.isArray(segments) || segments.length !== blockTarget.textNodes.length) {
        return rejection("invalid", "segments");
    }
    if (expected.sessionId && blockTarget.sessionId !== expected.sessionId) {
        return rejection("stale", "session");
    }
    if (expected.revision !== undefined && blockTarget.revision !== expected.revision) {
        return rejection("stale", "revision");
    }

    const writes = [];
    let casFailures = 0;
    let normalizedRescues = 0;
    blockTarget.textNodes.forEach((entry, index) => {
        const translated = segments[index];
        const node =
            entry.nodeRef && typeof entry.nodeRef.deref === "function"
                ? entry.nodeRef.deref() || null
                : null;
        if (typeof translated !== "string" || !isConnected(node) || typeof node.data !== "string") {
            casFailures += 1;
            return;
        }
        const comparison = compareCapturedValue(node.data, entry.source);
        if (!comparison.match) {
            casFailures += 1;
            return;
        }
        if (comparison.rescued) normalizedRescues += 1;
        writes.push({
            entry,
            node,
            translated: reattachInlineBoundaryWhitespace(node.data, translated),
        });
    });

    // Two-phase all-or-nothing CAS: a stale sibling must not leave an earlier Text node painted
    // with a reply that the session will subsequently reject/recollect. JavaScript execution is
    // synchronous between this preflight and the writes, so no site callback can interleave.
    if (casFailures > 0) {
        return {
            status: "stale",
            applied: 0,
            casFailures,
            normalizedRescues,
            targetId: blockTarget.id,
            revision: blockTarget.revision,
        };
    }

    for (const { entry, node, translated } of writes) {
        node.data = translated;
        entry.appliedTranslation = translated;
    }
    blockTarget.appliedSegments = segments.slice();
    blockTarget.appliedRevision = blockTarget.revision;
    return {
        status: "applied",
        applied: writes.length,
        casFailures: 0,
        normalizedRescues,
        targetId: blockTarget.id,
        revision: blockTarget.revision,
    };
}

export {
    applyBlock,
    commitTargetTranslation,
    readTargetValue,
    resolveTargetNode,
    restoreTargetSource,
};
