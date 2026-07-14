/**
 * Block IR for the vNext AI page translation engine (spec §1.1 + §1.4).
 *
 * The wire unit is one semantic leaf block; inline structure inside it is carried as numbered
 * placeholders — paired `<gN>…</gN>` around inline elements that contain the block's registered
 * Text nodes, void `<vN/>` for opaque embeds and skipped widgets. Numbering is block-local,
 * depth-first, starting at 1, one sequence across both kinds. Source text that happens to match
 * the placeholder grammar is ZWJ-armored at serialize time and restored at apply, so page text
 * can never forge or collide with the placeholder channel.
 *
 * This module is pure DOM-in/DOM-out: no registry, session or channel dependency, so the Gate B
 * property suite can drive it on synthetic trees. A block target carries the block element (or
 * enough Text nodes to resolve their common ancestor) plus the ordered, collector-registered
 * Text nodes of the block — `textNodes` entries are `{ node }` or registry-shaped
 * `{ nodeRef, path, source }`.
 */

// The parser recognizes ONLY this exact grammar (spec §1.1). Any wider matching would widen the
// forgeable surface; any narrower would strand tags the model echoed back.
const PLACEHOLDER_GRAMMAR = /<\/?g\d+>|<v\d+\/>/;

const PLACEHOLDER_SPLITTER = new RegExp(`(${PLACEHOLDER_GRAMMAR.source})`, "g");
const PLACEHOLDER_TOKEN = /^(?:<\/?g\d+>|<v\d+\/>)$/;
const MAX_PLACEHOLDER_DEPTH = 4;
const ZWJ = "\u200d";

// Armoring doubles any existing ZWJ run after "<" so armor/unarmor is a true bijection even for
// page text that already looks pre-armored ("<U+200D g1>" survives a round trip unchanged).
const ARMOR_PATTERN = /<(\u200d*)(\/?g\d+>|v\d+\/>)/g;
const UNARMOR_PATTERN = /<\u200d(\u200d*)(\/?g\d+>|v\d+\/>)/g;

// Interactive-wrapper pinned list (spec §1.4): these are never flatten-erased and their Text is
// never blanked to empty by any apply path. Everything else inline is styling.
const INTERACTIVE_WRAPPER_TAGS = new Set([
    "a",
    "button",
    "label",
    "summary",
    "option",
    "textarea",
    "select",
]);
const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "tab",
    "menuitem",
    "checkbox",
    "radio",
    "switch",
]);

// Opaque embeds serialized as void placeholders (spec §1.1: <img>, <code> treated opaque, <wbr>,
// MathML, skipped widgets). Their subtrees never contribute wire text.
const OPAQUE_VOID_TAGS = new Set([
    "img",
    "br",
    "wbr",
    "hr",
    "code",
    "kbd",
    "samp",
    "svg",
    "math",
    "iframe",
    "video",
    "audio",
    "canvas",
    "picture",
    "object",
    "embed",
    "input",
    "select",
    "textarea",
    "meter",
    "progress",
]);

// Nested leaf blocks are separate wire units (leaf-block model ported from
// dom_page_translate_context.js): when one appears inside a block without registered text it is
// skipped entirely, never inlined and never turned into a placeholder.
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
const LEAF_BLOCK_SELECTOR = Array.from(LEAF_BLOCK_TAGS).join(",");

const SILENT_SUBTREE_TAGS = new Set(["script", "style", "template", "noscript"]);

function isInteractiveWrapper(element) {
    if (!element || element.nodeType !== 1) return false;
    const tag = String(element.tagName || "").toLowerCase();
    if (INTERACTIVE_WRAPPER_TAGS.has(tag)) return true;
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    const tabindex = element.getAttribute?.("tabindex");
    if (tabindex !== null && tabindex !== undefined && Number.parseInt(tabindex, 10) >= 0) {
        return true;
    }
    const editable = element.getAttribute?.("contenteditable");
    if (editable !== null && editable !== undefined && String(editable).toLowerCase() !== "false") {
        return true;
    }
    return false;
}

/** ZWJ pre-armoring (spec §1.1): U+200D after "<" for any source run matching the grammar. */
function armorSourceText(text) {
    return String(text ?? "").replace(ARMOR_PATTERN, `<${ZWJ}$1$2`);
}

/** Inverse of armorSourceText, applied to translated text just before it is written to DOM. */
function unarmorText(text) {
    return String(text ?? "").replace(UNARMOR_PATTERN, "<$1$2");
}

/** Removes every placeholder tag; used by the flatten-accept rung of the §1.4 ladder. */
function stripPlaceholderTags(text) {
    return String(text ?? "").replace(new RegExp(PLACEHOLDER_GRAMMAR.source, "g"), "");
}

function resolveEntryNode(entry) {
    if (!entry) return null;
    if (entry.nodeType === 3) return entry;
    if (entry.node && entry.node.nodeType === 3) return entry.node;
    const node = entry.nodeRef?.deref?.() || null;
    return node && node.nodeType === 3 ? node : null;
}

function entrySourceText(entry, node) {
    if (entry && typeof entry.source === "string") return entry.source;
    return node && typeof node.data === "string" ? node.data : "";
}

function resolveBlockElement(blockTarget, nodes) {
    const direct = blockTarget?.element || blockTarget?.elementRef?.deref?.() || null;
    if (direct && direct.nodeType === 1) return direct;
    // Registry block targets carry no element ref — fall back to the deepest element that
    // contains every registered Text node.
    if (!nodes.length) return null;
    for (let candidate = nodes[0].parentElement; candidate; candidate = candidate.parentElement) {
        if (nodes.every((node) => candidate.contains(node))) return candidate;
    }
    return null;
}

function emptyAnalysis() {
    return {
        element: null,
        rootInteractive: false,
        source: "",
        tags: [],
        applyMap: [],
        atomicRequired: false,
        flattened: 0,
        hasInteractive: false,
        depthExceeded: false,
    };
}

/**
 * Single depth-first walk shared by serializeBlock / classifyPlaceholders / apply-time path
 * recovery. Deterministic over an unchanged subtree, so numbering recomputed at apply time
 * matches serialize-time numbering exactly.
 */
function analyzeBlock(blockTarget, onTelemetry) {
    const rawEntries = Array.isArray(blockTarget?.textNodes) ? blockTarget.textNodes : [];
    const nodeToIndex = new Map();
    for (let index = 0; index < rawEntries.length; index++) {
        const node = resolveEntryNode(rawEntries[index]);
        if (node && !nodeToIndex.has(node)) nodeToIndex.set(node, index);
    }
    const element = resolveBlockElement(blockTarget, Array.from(nodeToIndex.keys()));
    if (!element) return emptyAnalysis();

    const registered = new Map();
    const wrapperSet = new Set();
    for (const [node, index] of nodeToIndex) {
        if (!element.contains(node)) continue;
        registered.set(node, index);
        for (let cur = node.parentElement; cur && cur !== element; cur = cur.parentElement) {
            wrapperSet.add(cur);
        }
    }

    const analysis = emptyAnalysis();
    analysis.element = element;
    analysis.rootInteractive = isInteractiveWrapper(element);
    const sourceParts = [];
    const pathStack = [];
    let counter = 0;
    let openDepth = 0;
    let rawDepth = 0;
    let maxRawDepth = 0;
    // Placeholder parsing deliberately coalesces adjacent raw text into one segment. DOM Text
    // nodes do not necessarily coalesce the same way: comments, silent subtrees and splitText()
    // can leave two registered nodes at the same placeholder path. Without a wire boundary the
    // first parsed segment consumes only the first node; a later segment then routes backwards
    // to the stranded sibling and is falsely classified as an inline-order reversal.
    let textSegmentHasMappedNode = false;

    const emitVoid = (syntheticBoundary = false) => {
        counter += 1;
        analysis.tags.push({ name: `v${counter}`, kind: "void" });
        sourceParts.push(`<v${counter}/>`);
        textSegmentHasMappedNode = false;
        if (syntheticBoundary && typeof onTelemetry === "function") {
            onTelemetry("text_node_boundary_inserted");
        }
    };

    const visitText = (node) => {
        const index = registered.get(node);
        if (index !== undefined) {
            // A void boundary carries no translatable content; it only makes the existing DOM
            // node boundary explicit to the parser/model. It is emitted solely where two mapped
            // nodes would otherwise collapse into the same wire segment, so ordinary blocks pay
            // no extra placeholder/token cost.
            if (textSegmentHasMappedNode) emitVoid(true);
            analysis.applyMap.push({ nodeIndex: index, path: pathStack.slice() });
            sourceParts.push(armorSourceText(entrySourceText(rawEntries[index], node)));
            textSegmentHasMappedNode = true;
        } else {
            // Unregistered text (whitespace, non-linguistic runs) still flows through the wire
            // for natural reading, but it is never an apply target.
            sourceParts.push(armorSourceText(String(node.data || "")));
        }
    };

    const visitElement = (node) => {
        const tag = String(node.tagName || "").toLowerCase();
        if (wrapperSet.has(node)) {
            rawDepth += 1;
            if (rawDepth > maxRawDepth) maxRawDepth = rawDepth;
            const interactive = isInteractiveWrapper(node);
            if (interactive) analysis.hasInteractive = true;
            if (openDepth < MAX_PLACEHOLDER_DEPTH) {
                counter += 1;
                const name = `g${counter}`;
                analysis.tags.push({ name, kind: "paired", interactive });
                sourceParts.push(`<${name}>`);
                textSegmentHasMappedNode = false;
                pathStack.push(counter);
                openDepth += 1;
                visitChildren(node);
                openDepth -= 1;
                pathStack.pop();
                sourceParts.push(`</${name}>`);
                textSegmentHasMappedNode = false;
            } else {
                // Depth >4: flatten at serialize (spec §1.1) — unless flattening would erase an
                // interactive wrapper, in which case the whole block must go per-Text-node.
                analysis.flattened += 1;
                if (interactive) analysis.atomicRequired = true;
                if (typeof onTelemetry === "function") onTelemetry("placeholder_depth_flattened");
                visitChildren(node);
            }
            rawDepth -= 1;
            return;
        }
        if (SILENT_SUBTREE_TAGS.has(tag)) return;
        if (OPAQUE_VOID_TAGS.has(tag)) {
            emitVoid();
            return;
        }
        if (LEAF_BLOCK_TAGS.has(tag)) return;
        if (typeof node.querySelector === "function" && node.querySelector(LEAF_BLOCK_SELECTOR)) {
            return;
        }
        if (!String(node.textContent || "").trim() && !node.firstElementChild) return;
        // Non-empty content the collector skipped (widgets, non-linguistic spans): opaque void.
        emitVoid();
    };

    const visitChildren = (parent) => {
        for (const child of Array.from(parent.childNodes || [])) {
            if (child.nodeType === 3) visitText(child);
            else if (child.nodeType === 1) visitElement(child);
        }
    };

    visitChildren(element);
    analysis.source = sourceParts.join("");
    analysis.depthExceeded = maxRawDepth > MAX_PLACEHOLDER_DEPTH;
    return analysis;
}

/**
 * Serializes a block target into its wire form.
 *
 * Returns `{ source, placeholderInventory, applyMap }` plus `atomicRequired` (depth flattening
 * would have erased an interactive wrapper — caller must serialize per-Text-node instead, spec
 * §1.1) and a `telemetry` counter object. `options.onTelemetry(counterName)` is invoked once per
 * flattened wrapper. `placeholderInventory` is `{ tags: [{ name, kind, interactive }] }`;
 * `applyMap` is `[{ nodeIndex, path }]` in document order, where `nodeIndex` addresses
 * `blockTarget.textNodes` and `path` is the enclosing paired-placeholder chain.
 */
function serializeBlock(blockTarget, options = {}) {
    const analysis = analyzeBlock(blockTarget, options.onTelemetry);
    return {
        source: analysis.source,
        placeholderInventory: { tags: analysis.tags },
        applyMap: analysis.applyMap,
        atomicRequired: analysis.atomicRequired,
        telemetry: { placeholder_depth_flattened: analysis.flattened },
    };
}

/**
 * Ladder-routing signal for a block (spec §1.4): whether any placeholder wraps an interactive
 * element, and whether raw inline nesting exceeds the depth-4 serialization limit.
 */
function classifyPlaceholders(blockTarget) {
    const analysis = analyzeBlock(blockTarget, null);
    return { hasInteractive: analysis.hasInteractive, depthExceeded: analysis.depthExceeded };
}

function expectedFromInventory(inventory) {
    const tags = Array.isArray(inventory) ? inventory : inventory?.tags || [];
    const paired = new Map();
    const voids = new Set();
    for (const tag of tags) {
        if (!tag || typeof tag.name !== "string") continue;
        if (tag.kind === "void") voids.add(tag.name);
        else paired.set(tag.name, Boolean(tag.interactive));
    }
    return { paired, voids };
}

function tokenizePlaceholders(text) {
    const tokens = [];
    for (const part of String(text).split(PLACEHOLDER_SPLITTER)) {
        if (!part) continue;
        if (!PLACEHOLDER_TOKEN.test(part)) {
            tokens.push({ type: "text", raw: part });
            continue;
        }
        const voidMatch = /^<v(\d+)\/>$/.exec(part);
        if (voidMatch) {
            tokens.push({
                type: "void",
                name: `v${voidMatch[1]}`,
                n: Number(voidMatch[1]),
                raw: part,
            });
            continue;
        }
        const pairMatch = /^<(\/?)g(\d+)>$/.exec(part);
        tokens.push({
            type: pairMatch[1] ? "close" : "open",
            name: `g${pairMatch[2]}`,
            n: Number(pairMatch[2]),
            raw: part,
        });
    }
    return tokens;
}

/**
 * Validates a translated block against its placeholder inventory (spec §1.3 layer 4): tag
 * multiset equality plus balanced nesting — reordering and re-nesting are ALLOWED, that is the
 * feature. On success returns ordered `segments` `[{ path, text }]` where `path` is the chain of
 * paired placeholders open at that point in the translated string. On failure returns a typed
 * `failure` for the §1.4 ladder; this function never throws.
 */
function parseTranslatedBlock(translated, inventory) {
    if (typeof translated !== "string" || !translated.trim()) {
        return { ok: false, failure: { code: "empty" } };
    }
    const { paired, voids } = expectedFromInventory(inventory);
    const tokens = tokenizePlaceholders(translated);
    const counts = new Map();
    const unknown = [];
    const duplicates = [];
    for (const token of tokens) {
        if (token.type === "text") continue;
        const known = token.type === "void" ? voids.has(token.name) : paired.has(token.name);
        if (!known) {
            unknown.push(token.raw);
            continue;
        }
        const key = `${token.type}:${token.name}`;
        const seen = (counts.get(key) || 0) + 1;
        counts.set(key, seen);
        if (seen === 2) duplicates.push(token.raw);
    }
    if (unknown.length) return { ok: false, failure: { code: "unknown-tag", tags: unknown } };
    if (duplicates.length) {
        return { ok: false, failure: { code: "duplicate-tag", tags: duplicates } };
    }
    const missingHard = [];
    const missingCloses = [];
    for (const name of paired.keys()) {
        if (!counts.get(`open:${name}`)) missingHard.push(`<${name}>`);
        if (!counts.get(`close:${name}`)) missingCloses.push(`</${name}>`);
    }
    for (const name of voids) {
        if (!counts.get(`void:${name}`)) missingHard.push(`<${name}/>`);
    }
    if (missingHard.length) {
        return { ok: false, failure: { code: "missing-tag", tags: missingHard } };
    }
    if (missingCloses.length) {
        return { ok: false, failure: { code: "missing-close", tags: missingCloses } };
    }

    const stack = [];
    const segments = [];
    for (const token of tokens) {
        if (token.type === "text") {
            segments.push({ path: stack.slice(), text: token.raw });
        } else if (token.type === "open") {
            stack.push(token.n);
        } else if (token.type === "close") {
            if (!stack.length || stack[stack.length - 1] !== token.n) {
                return { ok: false, failure: { code: "unbalanced", tags: [token.raw] } };
            }
            stack.pop();
        }
    }
    return { ok: true, segments };
}

/**
 * Whether translated segment order can be represented by the block's fixed DOM Text-node
 * order. Placeholder syntax permits reordering, but DOM nodes themselves do not move: when a
 * translated bare segment routes to node 1 before a wrapper segment routes to node 0, applying
 * both would silently reverse the intended sentence (for example `<strong>Central</strong>を…`).
 *
 * The routing mirrors applyBlockTranslation. A non-monotonic destination-node sequence is a
 * proof of non-representability and must enter the §1.4 flatten/interactive fallback ladder.
 */
function isTranslationOrderRepresentable(translated, inventory, applyMap) {
    const parsed = parseTranslatedBlock(translated, inventory);
    if (!parsed.ok) return { ok: false, reason: "invalid-placeholders" };
    const mappings = (Array.isArray(applyMap) ? applyMap : [])
        .filter((entry) => Number.isInteger(entry?.nodeIndex))
        .map((entry) => ({
            nodeIndex: entry.nodeIndex,
            path: Array.isArray(entry.path) ? entry.path : [],
        }));
    if (mappings.length < 2) return { ok: true };

    const byPathKey = new Map();
    const byInnermost = new Map();
    const byContains = new Map();
    for (const entry of mappings) {
        pushIndexed(byPathKey, entry.path.join("."), entry);
        if (entry.path.length) {
            pushIndexed(byInnermost, entry.path[entry.path.length - 1], entry);
            for (const n of entry.path) pushIndexed(byContains, n, entry);
        }
    }
    const bareList = byPathKey.get("") || null;
    const fallbackList = mappings.length ? [mappings[0]] : null;
    const usedByList = new Map();
    let previousNodeIndex = -1;
    const routedNodeIndexes = [];
    for (const segment of parsed.segments) {
        if (!String(segment?.text || "").trim()) continue;
        const path = Array.isArray(segment.path) ? segment.path : [];
        let list = byPathKey.get(path.join(".")) || null;
        for (let depth = path.length - 1; depth >= 0 && !list; depth -= 1) {
            list = byInnermost.get(path[depth]) || byContains.get(path[depth]) || null;
        }
        if (!list) list = bareList || fallbackList;
        if (!list?.length) continue;
        const used = usedByList.get(list) || 0;
        const destination = list[Math.min(used, list.length - 1)];
        usedByList.set(list, used + 1);
        routedNodeIndexes.push(destination.nodeIndex);
        if (destination.nodeIndex < previousNodeIndex) {
            return {
                ok: false,
                reason: "non-monotonic-node-order",
                routedNodeIndexes,
            };
        }
        previousNodeIndex = destination.nodeIndex;
    }
    return { ok: true, routedNodeIndexes };
}

// Rewrites a strictly consecutive run of close tags that is a permutation of the currently open
// tail into proper LIFO order. Anything looser (text between the closes, counts that do not
// line up) is ambiguous and stays broken for the next ladder rung.
function reorderTransposedCloses(tokens) {
    const result = tokens.slice();
    const stack = [];
    let index = 0;
    let guard = result.length * 2 + 4;
    while (index < result.length) {
        if (--guard < 0) return null;
        const token = result[index];
        if (token.type === "open") {
            stack.push(token.n);
            index += 1;
            continue;
        }
        if (token.type !== "close") {
            index += 1;
            continue;
        }
        if (stack.length && stack[stack.length - 1] === token.n) {
            stack.pop();
            index += 1;
            continue;
        }
        let end = index;
        while (end < result.length && result[end].type === "close") end += 1;
        const run = result.slice(index, end);
        const need = stack.slice(-run.length).reverse();
        if (need.length !== run.length) return null;
        const runSorted = run.map((t) => t.n).sort((a, b) => a - b);
        const needSorted = need.slice().sort((a, b) => a - b);
        if (runSorted.join(",") !== needSorted.join(",")) return null;
        const reordered = need.map((n) => run.find((t) => t.n === n));
        result.splice(index, run.length, ...reordered);
        // Re-process from the same index: the reordered run now matches the stack top.
    }
    return stack.length ? null : result;
}

/**
 * Zero-token local repair — rung 1 of the §1.4 degradation ladder. Handles exactly the two
 * unambiguous defects the spec pins: a single missing close tag (closed at end) and transposed
 * consecutive closes (reordered). Everything else returns `{ ok: false }` so the ladder can move
 * to retry / flatten / atomic-degrade. Never throws, never loops.
 */
function repairPlaceholders(translated, inventory) {
    if (typeof translated !== "string") return { ok: false };
    const direct = parseTranslatedBlock(translated, inventory);
    if (direct.ok) return { ok: true, repaired: translated };
    const code = direct.failure?.code;
    if (code !== "missing-close" && code !== "unbalanced") return { ok: false };

    let tokens = tokenizePlaceholders(translated);
    if (code === "missing-close") {
        const present = new Set(
            tokens.filter((token) => token.type === "close").map((token) => token.name)
        );
        const { paired } = expectedFromInventory(inventory);
        const missing = Array.from(paired.keys()).filter((name) => !present.has(name));
        if (missing.length !== 1) return { ok: false };
        const name = missing[0];
        tokens = tokens.concat({
            type: "close",
            name,
            n: Number(name.slice(1)),
            raw: `</${name}>`,
        });
    }
    tokens = reorderTransposedCloses(tokens);
    if (!tokens) return { ok: false };
    const repaired = tokens.map((token) => token.raw).join("");
    return parseTranslatedBlock(repaired, inventory).ok ? { ok: true, repaired } : { ok: false };
}

// Exact-preserving apply helper: re-attach the captured source's boundary whitespace when the
// translation dropped it. Add-only — never rewrites whitespace the model produced.
function preserveBoundaryWhitespace(sourceText, translatedText) {
    const source = String(sourceText ?? "");
    let text = String(translatedText ?? "");
    if (!text) return text;
    const lead = /^\s+/.exec(source);
    const trail = /\s+$/.exec(source);
    if (lead && !/^\s/.test(text)) text = lead[0] + text;
    if (trail && !/\s$/.test(text)) text += trail[0];
    return text;
}

function pushIndexed(map, key, value) {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

/**
 * Normal apply semantics (spec §1.4): routes parsed segments onto the block's registered Text
 * nodes and commits them through `committer`, which receives `(blockTarget, perNodeSegments)` —
 * one translated string per `blockTarget.textNodes` entry, in order — and returns
 * `{ applied, casFailures }` (dom/committer.js `applyBlock` is the production implementation;
 * per-Text-node CAS stays the committer's job).
 *
 * Routing: a segment goes to the source nodes registered at its exact placeholder path; under
 * re-nesting, to the nodes sharing its innermost placeholder; text outside placeholders goes to
 * the block's bare Text nodes in document order. Within one route the k-th segment pairs with
 * the k-th node, surplus text concatenates onto the last node and surplus nodes get "" — the
 * "first gets text, rest ''" rule generalized so an identity translation round-trips exactly.
 * Text under an interactive placeholder is never blanked: if a reply left an interactive wrapper
 * empty, its nodes keep their source text. Never throws, never writes outside the block.
 */
function applyBlockTranslation(blockTarget, segments, committer) {
    const rawEntries = Array.isArray(blockTarget?.textNodes) ? blockTarget.textNodes : [];
    if (!rawEntries.length) return { applied: 0, casFailures: 0 };

    let applyMap;
    let inventoryTags;
    let rootInteractive;
    if (Array.isArray(blockTarget.applyMap) && blockTarget.placeholderInventory) {
        // Serialize-time map attached by the caller: immune to DOM churn between wire and apply.
        applyMap = blockTarget.applyMap;
        inventoryTags = blockTarget.placeholderInventory.tags || [];
        const nodes = rawEntries.map(resolveEntryNode).filter(Boolean);
        const element = resolveBlockElement(blockTarget, nodes);
        rootInteractive = element ? isInteractiveWrapper(element) : false;
    } else {
        const analysis = analyzeBlock(blockTarget, null);
        applyMap = analysis.applyMap;
        inventoryTags = analysis.tags;
        rootInteractive = analysis.rootInteractive;
    }

    const mapped = [];
    const mappedByIndex = new Map();
    for (const { nodeIndex, path } of applyMap) {
        const raw = rawEntries[nodeIndex];
        if (!raw || mappedByIndex.has(nodeIndex)) continue;
        const node = resolveEntryNode(raw);
        const entry = {
            nodeIndex,
            path: Array.isArray(path) ? path : [],
            source: entrySourceText(raw, node),
        };
        mapped.push(entry);
        mappedByIndex.set(nodeIndex, entry);
    }

    const byPathKey = new Map();
    const byInnermost = new Map();
    const byContains = new Map();
    for (const entry of mapped) {
        pushIndexed(byPathKey, entry.path.join("."), entry);
        if (entry.path.length) {
            pushIndexed(byInnermost, entry.path[entry.path.length - 1], entry);
            for (const n of entry.path) pushIndexed(byContains, n, entry);
        }
    }
    const bareList = byPathKey.get("") || null;
    const fallbackList = mapped.length ? [mapped[0]] : null;

    // Bucket segments by the node list they resolve to; translated order is preserved.
    const buckets = new Map();
    for (const segment of Array.isArray(segments) ? segments : []) {
        if (!segment || typeof segment.text !== "string" || !segment.text.trim()) continue;
        const path = Array.isArray(segment.path) ? segment.path : [];
        let list = byPathKey.get(path.join(".")) || null;
        for (let depth = path.length - 1; depth >= 0 && !list; depth--) {
            list = byInnermost.get(path[depth]) || byContains.get(path[depth]) || null;
        }
        if (!list) list = bareList || fallbackList;
        if (!list) continue;
        pushIndexed(buckets, list, segment.text);
    }

    const assigned = new Map();
    for (const [list, texts] of buckets) {
        const available = list.filter((entry) => !assigned.has(entry));
        if (!available.length) continue;
        for (let i = 0; i < texts.length; i++) {
            if (i < available.length) {
                assigned.set(available[i], texts[i]);
            } else {
                const last = available[available.length - 1];
                assigned.set(last, assigned.get(last) + texts[i]);
            }
        }
    }

    // Interactive guard (spec §1.4): never blank a link/button label. If nothing routed into an
    // interactive placeholder that had source text, its nodes keep their source.
    const keepSource = new Set();
    for (const tag of inventoryTags) {
        if (!tag || tag.kind !== "paired" || !tag.interactive) continue;
        const group = byContains.get(Number(String(tag.name).slice(1)));
        if (!group || !group.length) continue;
        const hadText = group.some((entry) => entry.source.trim());
        const hasText = group.some((entry) => String(assigned.get(entry) || "").trim());
        if (hadText && !hasText) for (const entry of group) keepSource.add(entry);
    }
    if (rootInteractive && mapped.length) {
        const hadText = mapped.some((entry) => entry.source.trim());
        const hasText = mapped.some((entry) => String(assigned.get(entry) || "").trim());
        if (hadText && !hasText) for (const entry of mapped) keepSource.add(entry);
    }

    const perNode = rawEntries.map((raw, index) => {
        const entry = mappedByIndex.get(index);
        const sourceText = entrySourceText(raw, resolveEntryNode(raw));
        if (!entry || keepSource.has(entry)) return sourceText;
        const text = assigned.get(entry);
        if (text === undefined) return "";
        const clean = unarmorText(text);
        return clean ? preserveBoundaryWhitespace(entry.source, clean) : "";
    });

    if (typeof committer !== "function") return { applied: 0, casFailures: rawEntries.length };
    let result;
    try {
        result = committer(blockTarget, perNode);
    } catch {
        return { applied: 0, casFailures: rawEntries.length };
    }
    return {
        applied: Number(result?.applied) || 0,
        casFailures: Number(result?.casFailures) || 0,
    };
}

export {
    MAX_PLACEHOLDER_DEPTH,
    PLACEHOLDER_GRAMMAR,
    applyBlockTranslation,
    armorSourceText,
    classifyPlaceholders,
    isInteractiveWrapper,
    isTranslationOrderRepresentable,
    parseTranslatedBlock,
    repairPlaceholders,
    serializeBlock,
    stripPlaceholderTags,
    unarmorText,
};
