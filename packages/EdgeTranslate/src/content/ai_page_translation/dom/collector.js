/**
 * One-pass, layout-free DOM collection for the vNext AI page translation engine.
 *
 * The collector walks every eligible target once in document order. It deliberately performs
 * no viewport/focus reads, first-paint subset, idle second pass, or scroll-paced admission.
 * `collectPage()` keeps the former `{ viewportTargets, fullDocPromise }` return names only as a
 * compatibility boundary: `viewportTargets` contains the complete initial target set and
 * `fullDocPromise` resolves an empty remainder.
 *
 * Blocks use the leaf-block model ported from dom_page_translate_context.js
 * (findLeafBlocksInElement / leafBlockOwnText): a block is the deepest element whose OWN text
 * content — everything except the subtrees of nested leaf-block descendants — forms one
 * semantic unit, including the li-with-nested-list case. Single-Text-node blocks stay plain
 * (zero placeholders); multi-node blocks are serialized through block_ir at collection time.
 * Blocks whose serialization reports atomicRequired
 * (depth-flattening would erase an interactive wrapper) are planned as per-Text-node atomic
 * items from the start (spec §1.1).
 *
 * Script coverage is INVERTED to exclusion (spec §9): text is translatable iff /\p{L}/u matches
 * AND it is not excluded by the identifier/URL/hash/pure-symbol filters. No script allowlist —
 * Thai, Lao, Myanmar, Khmer, Tibetan, Georgian, Armenian, Ethiopic, half-width katakana and
 * astral CJK are covered automatically forever.
 */

import { serializeBlock } from "./block_ir.js";

const SKIPPED_SUBTREE_TAGS = new Set(["script", "style", "noscript", "template", "svg", "math"]);

// code / kbd / samp / pre are opaque ONLY when their content is real ASCII code
// (see isTranslatableCodeContent). They are kept OUT of SKIPPED_SUBTREE_TAGS and handled with a
// content check so a tag that is being misused to STYLE non-Latin natural-language text — e.g.
// `<code>パスワード</code>` — is still collected and translated like any other inline run. This is
// a character-composition rule, not a hardcoded word / tag / language list.
const CODE_ISH_TAGS = new Set(["code", "kbd", "samp", "pre"]);

const TEXT_EXCLUDED_ANCESTOR_TAGS = new Set(["textarea", "select"]);

// Same list as block_ir's LEAF_BLOCK_TAGS — the leaf-block model must agree between the
// collector (unit boundaries) and the serializer (nested-leaf skipping).
const LEAF_BLOCK_TAGS = new Set([
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "figcaption",
    "caption",
    "th",
    "td",
    "label",
    "button",
    "summary",
    "dd",
    "dt",
    "pre",
]);

// `title` is deliberately ABSENT (spec §1.1: title stays excluded per stable's measurement —
// tooltip strings are the worst token-per-visible-value spend on the page).
const DIRECT_TRANSLATABLE_ATTRIBUTES = new Set(["alt", "placeholder"]);

const ARIA_TRANSLATABLE_ATTRIBUTES = new Set([
    "aria-label",
    "aria-description",
    "aria-placeholder",
    "aria-roledescription",
    "aria-valuetext",
    "aria-rowindextext",
    "aria-colindextext",
    "aria-braillelabel",
    "aria-brailleroledescription",
]);

// Kept as one observer-safe list so MutationWatcher can subscribe only to attributes that
// may become translation targets. Observing every attribute would turn class/style churn on
// framework-heavy pages into needless MutationObserver traffic.
const TRANSLATABLE_ATTRIBUTE_NAMES = Object.freeze([
    ...DIRECT_TRANSLATABLE_ATTRIBUTES,
    ...ARIA_TRANSLATABLE_ATTRIBUTES,
    "label",
    "abbr",
    "value",
]);

// IDREF attributes reference other elements; translating them breaks the reference.
const ARIA_REFERENCE_ATTRIBUTES = new Set([
    "aria-labelledby",
    "aria-describedby",
    "aria-controls",
    "aria-owns",
    "aria-activedescendant",
    "aria-details",
    "aria-errormessage",
    "aria-flowto",
]);

const DEFAULT_CONTEXT_SEED_BLOCKS = 512;
const DEFAULT_CONTEXT_SEED_CHARS = 40000;

// ---------------------------------------------------------------------------
// Translatable-text test — inverted to exclusion (spec §9)
// ---------------------------------------------------------------------------

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|www\.)\S*$/i;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH_LIKE = /^#?[0-9a-f]{12,}$/i;
const SNAKE_IDENTIFIER = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/;
const SCOPED_IDENTIFIER = /^[A-Za-z0-9$_]+(?:::[A-Za-z0-9$_]+)+$/;
const FILE_NAME_LIKE =
    /^[\w./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|css|html?|json|xml|ya?ml|toml|md|png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|py|rb|go|rs|java|c|h|cpp)$/i;

/**
 * Single-token machine identifiers that contain letters but carry no linguistic content:
 * URLs, emails, UUIDs, hex hashes, snake_case / C++-scoped identifiers, file names. Anything
 * with whitespace is prose and never excluded here.
 */
function isNonLinguisticToken(text) {
    if (/\s/.test(text)) return false;
    if (URL_LIKE.test(text) || EMAIL_LIKE.test(text) || UUID_LIKE.test(text)) return true;
    if (HEX_HASH_LIKE.test(text) && /\d/.test(text)) return true;
    if (SNAKE_IDENTIFIER.test(text) || SCOPED_IDENTIFIER.test(text)) return true;
    if (FILE_NAME_LIKE.test(text)) return true;
    return false;
}

/** Translatable iff any Unicode letter is present AND the exclusion filters do not fire. */
function hasTranslatableText(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (!/\p{L}/u.test(text)) return false;
    return !isNonLinguisticToken(text);
}

// One general Unicode signal used to tell code-styled PROSE apart from real code inside
// <code>/<kbd>/<samp>/<pre>. hasTranslatableText alone is insufficient here: multi-token ASCII
// code such as `function foo() { return 1; }` or `git commit -m` contains whitespace, so the
// identifier filters treat it as prose and would wrongly translate it. Source code, shell
// commands and keyboard keys are written in ASCII; when one of these elements instead contains a
// letter from a non-Latin script (CJK, kana, hangul, Cyrillic, Greek, …) the site is misusing the
// tag to style natural-language text, which should be translated. The extra requirement is
// therefore purely "does the content contain at least one non-ASCII character" — a
// character-composition rule with no word list or language special-casing. `[\u0080-\uFFFF]` is
// the positive form of "outside the ASCII range" (it also covers astral scripts through their
// surrogate code units) and, unlike a printable-ASCII range, never fires on the tabs/newlines of a
// multi-line ASCII code block.
const NON_ASCII_CHAR = /[\u0080-\uFFFF]/;

function isTranslatableCodeContent(value) {
    return hasTranslatableText(value) && NON_ASCII_CHAR.test(String(value || ""));
}

// ---------------------------------------------------------------------------
// Eligibility / exclusion rules (ported from the v2 collector)
// ---------------------------------------------------------------------------

function isExtensionOwned(element) {
    for (let current = element; current; current = current.parentElement) {
        if (current.hasAttribute?.("data-edge-translate-owned")) return true;
        if (String(current.id || "").startsWith("edge-translate-")) return true;
    }
    return false;
}

function hasTranslateNo(element) {
    for (let current = element; current; current = current.parentElement) {
        if (String(current.getAttribute?.("translate") || "").toLowerCase() === "no") return true;
    }
    return false;
}

function isInsideEditable(element) {
    for (let current = element; current; current = current.parentElement) {
        const raw = current.getAttribute?.("contenteditable");
        if (raw !== null && raw !== undefined && String(raw).toLowerCase() !== "false") {
            return true;
        }
    }
    return false;
}

function isExplicitlyHidden(element) {
    for (let current = element; current; current = current.parentElement) {
        if (current.hidden || current.hasAttribute?.("inert")) return true;
        if (String(current.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") {
            return true;
        }
        if (current.tagName?.toLowerCase() === "input" && current.type === "hidden") return true;
    }
    return false;
}

// a[download] link text is a filename presented for saving; translating it breaks the
// user-visible correspondence with the downloaded artifact.
function isInsideDownloadAnchor(element) {
    for (let current = element; current; current = current.parentElement) {
        if (
            current.tagName?.toLowerCase() === "a" &&
            typeof current.hasAttribute === "function" &&
            current.hasAttribute("download")
        ) {
            return true;
        }
    }
    return false;
}

function getSkipReason(element, options = {}) {
    if (!element || element.nodeType !== 1) return null;
    const tag = element.tagName.toLowerCase();
    if (SKIPPED_SUBTREE_TAGS.has(tag)) return "excluded-tag";
    // Opaque code tags are skipped ONLY when their content is real ASCII code. A code/kbd/samp/pre
    // holding non-Latin natural-language script falls through (returns null below) so the walk
    // registers its text nodes like any inline text.
    if (CODE_ISH_TAGS.has(tag) && !isTranslatableCodeContent(element.textContent)) return "code";
    if (tag === "input" && String(element.getAttribute("type") || "").toLowerCase() === "hidden") {
        return "hidden-form-control";
    }
    if (hasTranslateNo(element)) return "translate-no";
    if (isInsideEditable(element)) return "editable";
    if (isExtensionOwned(element)) return "extension-owned";
    if (isInsideDownloadAnchor(element)) return "download-link";
    if (options.includeHidden !== true && isExplicitlyHidden(element)) return "hidden";
    if (typeof options.isElementEligible === "function" && !options.isElementEligible(element)) {
        return "policy";
    }
    return null;
}

// Subtree-local exclusion used while gathering a unit's own text nodes. The walk has already
// vetted the unit root's ancestors, so only per-node facts are checked here.
function isLocallyExcluded(element) {
    const tag = String(element.tagName || "").toLowerCase();
    if (SKIPPED_SUBTREE_TAGS.has(tag) || TEXT_EXCLUDED_ANCESTOR_TAGS.has(tag)) return true;
    // A text node inside `<code>パスワード</code>` is gathered; one inside `<code>console.log()</code>`
    // is excluded — same character-composition rule as getSkipReason.
    if (CODE_ISH_TAGS.has(tag) && !isTranslatableCodeContent(element.textContent)) return true;
    if (String(element.getAttribute?.("translate") || "").toLowerCase() === "no") return true;
    const editable = element.getAttribute?.("contenteditable");
    if (editable !== null && editable !== undefined && String(editable).toLowerCase() !== "false") {
        return true;
    }
    if (element.hidden || element.hasAttribute?.("inert")) return true;
    if (String(element.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") return true;
    if (element.hasAttribute?.("data-edge-translate-owned")) return true;
    if (String(element.id || "").startsWith("edge-translate-")) return true;
    if (tag === "a" && element.hasAttribute?.("download")) return true;
    return false;
}

function translatableAttributeNames(element) {
    const names = new Set();
    for (const name of DIRECT_TRANSLATABLE_ATTRIBUTES) {
        if (element.hasAttribute(name)) names.add(name);
    }
    for (const name of ARIA_TRANSLATABLE_ATTRIBUTES) {
        if (element.hasAttribute(name)) names.add(name);
    }
    const tag = element.tagName.toLowerCase();
    if (["option", "optgroup", "track"].includes(tag) && element.hasAttribute("label")) {
        names.add("label");
    }
    if (tag === "th" && element.hasAttribute("abbr")) names.add("abbr");
    if (tag === "input") {
        const type = String(element.getAttribute("type") || "text").toLowerCase();
        if (["button", "submit", "reset"].includes(type) && element.hasAttribute("value")) {
            names.add("value");
        }
    }
    return Array.from(names);
}

// ---------------------------------------------------------------------------
// Explicit pt3 roles (spec §1.2). EVERY registered target carries one — persistent-cache keys
// depend on the role, so the registry default "text" must never leak through.
// ---------------------------------------------------------------------------

function inferBlockRole(element) {
    const tag = String(element?.tagName || "").toLowerCase();
    const ariaRole = String(element?.getAttribute?.("role") || "").toLowerCase();
    if (/^h[1-6]$/.test(tag) || ariaRole === "heading") return "h";
    if (tag === "li" || ariaRole === "listitem") return "li";
    if (
        tag === "td" ||
        tag === "th" ||
        ["cell", "gridcell", "columnheader", "rowheader"].includes(ariaRole)
    ) {
        return "cell";
    }
    return "p";
}

function inferAttributeRole(attributeName) {
    if (attributeName === "alt") return "alt";
    if (attributeName === "placeholder" || attributeName === "aria-placeholder") return "ph";
    if (attributeName.startsWith("aria-")) return "aria";
    // value, label, abbr: user-visible control values.
    return "val";
}

function buildTargetContext(element, attributeName = "") {
    return {
        tag: String(element?.tagName || "").toLowerCase(),
        ...(attributeName ? { attribute: attributeName } : {}),
    };
}

// ---------------------------------------------------------------------------
// Leaf-block unit gathering (ported semantics: leafBlockOwnText / findLeafBlocksInElement)
// ---------------------------------------------------------------------------

/**
 * The Text nodes a unit root contributes ON ITS OWN — everything except the subtrees of nested
 * leaf-block descendants (separate wire units) and locally excluded subtrees. A list item like
 * `<li>1990年（平成2年）<ul><li>…</li></ul></li>` owns "1990年（平成2年）"; the sub-list is its
 * own unit.
 */
function gatherOwnTextNodes(element) {
    const out = [];
    const visit = (node) => {
        if (node.nodeType === 3) {
            out.push(node);
            return;
        }
        if (node.nodeType !== 1) return;
        const tag = String(node.tagName || "").toLowerCase();
        if (LEAF_BLOCK_TAGS.has(tag)) return; // nested leaf-block = its own unit
        if (isLocallyExcluded(node)) return;
        for (const child of node.childNodes || []) visit(child);
    };
    if (TEXT_EXCLUDED_ANCESTOR_TAGS.has(String(element.tagName || "").toLowerCase())) return out;
    for (const child of element.childNodes || []) visit(child);
    return out;
}

function incrementReason(stats, reason) {
    stats.skippedByReason[reason] = (stats.skippedByReason[reason] || 0) + 1;
}

function createStats() {
    return {
        visitedNodes: 0,
        collectedBlocks: 0,
        collectedAtomic: 0,
        collectedAttributes: 0,
        rectPasses: 0,
        skippedByReason: {},
        telemetry: {},
    };
}

/**
 * Depth-first walk shared by initial and mutation re-collection. Each step processes one stack
 * frame. Emission order is document order: a unit root's own line precedes its nested leaf
 * blocks; attributes of an element are emitted after its descendants (v2 convention, so
 * repeated ARIA strings alias the richer visible-text unit).
 */
function createDomWalker({ root, options, stats, claimed, emit }) {
    const stack = [{ kind: "node", node: root }];
    let order = 0;
    const walker = { done: false };

    const pushChildren = (node) => {
        const children = node.childNodes || [];
        for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({ kind: "node", node: children[index] });
        }
    };

    const emitUnit = (element) => {
        const available = gatherOwnTextNodes(element).filter((textNode) => !claimed.has(textNode));
        // Eligibility is block-level, but routing is Text-node exact. Once any own node is
        // linguistic, capture every non-whitespace sibling (including punctuation, numbers and
        // identifier-only nodes). Leaving punctuation unregistered while still serializing it
        // made identity placeholder order look non-monotonic — e.g.
        // `<a>East</a>（<a>Line</a>）` routed the final `）` back to the first link — which sent
        // otherwise valid replies through the inventory retry and terminal keep-source path.
        if (!available.some((textNode) => hasTranslatableText(textNode.data))) return;
        const nodes = available.filter((textNode) => String(textNode.data || "").trim());
        for (const textNode of nodes) claimed.add(textNode);
        if (nodes.length) emit({ kind: "unit", element, nodes, order: (order += 1) });
    };

    const emitAttributes = (element) => {
        for (const attributeName of translatableAttributeNames(element)) {
            if (ARIA_REFERENCE_ATTRIBUTES.has(attributeName)) continue;
            if (!hasTranslatableText(element.getAttribute(attributeName))) continue;
            emit({ kind: "attribute", element, attributeName, order: (order += 1) });
        }
    };

    walker.step = () => {
        const frame = stack.pop();
        if (!frame) {
            walker.done = true;
            return;
        }
        const { node } = frame;
        if (frame.kind === "attrs") {
            emitAttributes(node);
            return;
        }
        stats.visitedNodes += 1;
        if (node.nodeType === 9 || node.nodeType === 11) {
            pushChildren(node);
            return;
        }
        if (node.nodeType !== 1) return;
        const reason = getSkipReason(node, options);
        if (reason) {
            incrementReason(stats, reason);
            return;
        }
        emitUnit(node);
        stack.push({ kind: "attrs", node });
        if (node.shadowRoot && node.shadowRoot.mode === "open") {
            stack.push({ kind: "node", node: node.shadowRoot });
        }
        pushChildren(node);
    };

    return walker;
}

/**
 * Reuses candidates from the single initial walk as a bounded glossary seed. This adds no
 * second DOM traversal; hard caps keep harvesting predictable on very large documents.
 */
function buildContextSeed(candidates, options = {}) {
    const maxBlocks = Number.isFinite(options.contextSeedMaxBlocks)
        ? Math.max(0, Math.floor(options.contextSeedMaxBlocks))
        : DEFAULT_CONTEXT_SEED_BLOCKS;
    const maxChars = Number.isFinite(options.contextSeedMaxChars)
        ? Math.max(0, Math.floor(options.contextSeedMaxChars))
        : DEFAULT_CONTEXT_SEED_CHARS;
    const blocks = [];
    let chars = 0;
    for (const candidate of candidates || []) {
        if (blocks.length >= maxBlocks || chars >= maxChars) break;
        const raw =
            candidate.kind === "attribute"
                ? candidate.element?.getAttribute?.(candidate.attributeName)
                : (candidate.nodes || []).map((node) => String(node?.data || "")).join(" ");
        const text = String(raw || "")
            .replace(/\s+/g, " ")
            .trim();
        if (!text) continue;
        const remaining = maxChars - chars;
        if (remaining <= 0) break;
        const bounded = text.slice(0, remaining);
        blocks.push(bounded);
        chars += bounded.length;
    }
    return blocks;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function resolvePriority(options, element) {
    return typeof options.getPriority === "function"
        ? options.getPriority(element)
        : options.priority || "deferred";
}

/**
 * Registers one walker candidate through the Stage-A registry and appends the collection entry
 * `{ kind, target, element, ir, order }` to `out`. Single-Text-node blocks stay plain (zero
 * placeholders); multi-node blocks get pre-serialized IR; atomicRequired blocks are planned as
 * per-Text-node atomic items from the start. Every target carries an explicit pt3 role.
 *
 * `seen` maps target id -> last emitted revision: a target already emitted at its CURRENT
 * revision is suppressed (phase 2 re-walks phase-1 ground), but a registration that REVISED
 * the target (a mutation landing between phase-1 registration and the phase-2 idle slice)
 * re-emits it — otherwise the revision bump happens as a silent registry side effect and the
 * session's entry strands pending forever.
 */
function alreadyEmitted(seen, target) {
    if (seen.get(target.id) === target.revision) return true;
    seen.set(target.id, target.revision);
    return false;
}

function registerCandidate(candidate, registry, options, stats, seen, out) {
    if (candidate.kind === "attribute") {
        const target = registry.registerAttribute(candidate.element, candidate.attributeName, {
            role: inferAttributeRole(candidate.attributeName),
            context: buildTargetContext(candidate.element, candidate.attributeName),
            priority: resolvePriority(options, candidate.element),
        });
        if (alreadyEmitted(seen, target)) return;
        stats.collectedAttributes += 1;
        out.push({
            kind: "attribute",
            target,
            element: candidate.element,
            ir: null,
            order: candidate.order,
        });
        return;
    }

    const { element, nodes } = candidate;
    const metadata = {
        role: inferBlockRole(element),
        context: buildTargetContext(element),
        priority: resolvePriority(options, element),
    };

    if (nodes.length === 1) {
        const target = registry.registerBlockTarget([{ node: nodes[0], path: null }], metadata);
        if (alreadyEmitted(seen, target)) return;
        stats.collectedBlocks += 1;
        out.push({ kind: "block", target, element, ir: null, order: candidate.order });
        return;
    }

    const ir = serializeBlock(
        { element, textNodes: nodes.map((node) => ({ node })) },
        {
            onTelemetry: (counter) => {
                stats.telemetry[counter] = (stats.telemetry[counter] || 0) + 1;
            },
        }
    );

    if (ir.atomicRequired) {
        // Depth flattening would erase an interactive wrapper (spec §1.1): the block is planned
        // as per-Text-node atomic items from the start, never as a placeholder block. Routing-
        // only punctuation nodes belong in normal block applyMaps, but do not become standalone
        // provider items when placeholder serialization itself is unavailable.
        for (const node of nodes.filter((textNode) => hasTranslatableText(textNode.data))) {
            const target = registry.registerText(node, metadata);
            if (alreadyEmitted(seen, target)) continue;
            stats.collectedAtomic += 1;
            out.push({ kind: "atomic", target, element, ir: null, order: candidate.order });
        }
        return;
    }

    const pathByIndex = new Map(ir.applyMap.map((entry) => [entry.nodeIndex, entry.path]));
    const entries = nodes.map((node, index) => ({ node, path: pathByIndex.get(index) ?? null }));
    const target = registry.registerBlockTarget(entries, { ...metadata, source: ir.source });
    if (alreadyEmitted(seen, target)) return;
    stats.collectedBlocks += 1;
    out.push({ kind: "block", target, element, ir, order: candidate.order });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One-pass whole-document collection. The legacy-shaped return value is retained so callers do
 * not need a second integration contract: `viewportTargets` now means all initial targets and
 * `fullDocPromise` resolves an empty remainder. There are no layout reads, viewport/focus
 * priorities or second walk. This avoids translating phase-one writes during a phase-two scan
 * and lets the session pack the complete page into efficient drain packets exactly once.
 */
function collectPage(root, registry, options = {}) {
    if (!registry || typeof registry.registerBlockTarget !== "function") {
        throw new TypeError("collectPage requires a TargetRegistry");
    }
    if (!root) throw new TypeError("collectPage requires a collection root");
    const stats = createStats();
    const seen = new Map(); // target id -> last emitted revision
    const candidates = [];
    const walker = createDomWalker({
        root,
        options,
        stats,
        claimed: new WeakSet(),
        emit: (candidate) => candidates.push(candidate),
    });
    while (!walker.done) walker.step();
    const contextSeedBlocks = buildContextSeed(candidates, options);
    const initialTargets = [];
    for (const candidate of candidates) {
        registerCandidate(candidate, registry, options, stats, seen, initialTargets);
    }
    return {
        viewportTargets: initialTargets,
        fullDocPromise: Promise.resolve({ targets: [], stats }),
        contextSeedBlocks,
        stats,
    };
}

/**
 * Widens a mutated node to its enclosing leaf block so re-collection refreshes the EXISTING
 * registry block (revision bump via the registry) instead of minting an overlapping one for an
 * inline fragment. Falls back to the nearest body-level container when no leaf-block tag
 * encloses the node.
 */
function expandCollectionRoot(node) {
    if (!node) return null;
    if (node.nodeType === 9 || node.nodeType === 11) return node;
    const element = node.nodeType === 3 ? node.parentElement : node.nodeType === 1 ? node : null;
    if (!element) return null;
    let current = element;
    while (current && current.parentElement) {
        if (LEAF_BLOCK_TAGS.has(String(current.tagName || "").toLowerCase())) return current;
        const parentTag = String(current.parentElement.tagName || "").toLowerCase();
        if (parentTag === "body" || parentTag === "html") return current;
        current = current.parentElement;
    }
    return current || element;
}

/**
 * Synchronous single-pass collection over mutation-delivered roots (spec §3: new/changed nodes
 * → collect → …). Shares all eligibility, unit and registration logic with collectPage; the
 * registry's refresh path decides whether an encountered unit is new, unchanged, its own
 * applied value, or a true revision.
 */
function collectSubtreeTargets(roots, registry, options = {}) {
    if (!registry || typeof registry.registerBlockTarget !== "function") {
        throw new TypeError("collectSubtreeTargets requires a TargetRegistry");
    }
    const stats = createStats();
    const seen = new Map(); // target id -> last emitted revision
    const targets = [];
    const claimed = new WeakSet();
    for (const raw of (Array.isArray(roots) ? roots : [roots]).filter(Boolean)) {
        const root = expandCollectionRoot(raw);
        if (!root) continue;
        const walker = createDomWalker({
            root,
            options,
            stats,
            claimed,
            emit: (candidate) =>
                registerCandidate(candidate, registry, options, stats, seen, targets),
        });
        while (!walker.done) walker.step();
    }
    return { targets, stats };
}

export {
    ARIA_REFERENCE_ATTRIBUTES,
    ARIA_TRANSLATABLE_ATTRIBUTES,
    CODE_ISH_TAGS,
    DIRECT_TRANSLATABLE_ATTRIBUTES,
    LEAF_BLOCK_TAGS,
    SKIPPED_SUBTREE_TAGS,
    TRANSLATABLE_ATTRIBUTE_NAMES,
    buildContextSeed,
    collectPage,
    collectSubtreeTargets,
    expandCollectionRoot,
    getSkipReason,
    hasTranslatableText,
    inferAttributeRole,
    inferBlockRole,
    isNonLinguisticToken,
    isTranslatableCodeContent,
    translatableAttributeNames,
};
