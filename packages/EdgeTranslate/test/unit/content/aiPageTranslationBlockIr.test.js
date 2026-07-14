import {
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
} from "../../../src/content/ai_page_translation/dom/block_ir.js";
import { applyBlock } from "../../../src/content/ai_page_translation/dom/committer.js";
import { normalizeSourceKey } from "../../../src/content/ai_page_translation/runtime/normalize.js";

const GRAMMAR_GLOBAL = () => new RegExp(PLACEHOLDER_GRAMMAR.source, "g");
const TOKEN_EXACT = /^(?:<\/?g\d+>|<v\d+\/>)$/;

/** Deterministic PRNG — the Gate B suite must replay identically on every CI run. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a += 0x6d2b79f5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WORDS = ["역", "노선", "京阪", "電車", "release", "notes", "moves", "object", "text", "말"];
// Grammar collisions that MUST be ZWJ-armored, including a pre-armored lookalike.
const COLLIDERS = ["<g1>", "</g2>", "<v3/>", "<\u200dg4>"];
const STYLING_TAGS = ["span", "b", "i", "em", "strong", "small", "u", "mark", "sub", "sup"];

function randomText(rand) {
    const parts = [];
    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
        if (rand() < 0.06) parts.push(COLLIDERS[Math.floor(rand() * COLLIDERS.length)]);
        else parts.push(WORDS[Math.floor(rand() * WORDS.length)]);
    }
    const lead = rand() < 0.3 ? " " : "";
    const trail = rand() < 0.3 ? " " : "";
    return `${lead}${parts.join(" ")}${trail}`;
}

function makeWrapper(rand) {
    if (rand() < 0.25) {
        // Interactive per the §1.4 pinned list: tag, role, tabindex.
        const kind = rand();
        if (kind < 0.4) {
            const anchor = document.createElement("a");
            anchor.setAttribute("href", "#probe");
            return anchor;
        }
        const span = document.createElement("span");
        if (kind < 0.7) span.setAttribute("role", "link");
        else span.setAttribute("tabindex", "0");
        return span;
    }
    return document.createElement(STYLING_TAGS[Math.floor(rand() * STYLING_TAGS.length)]);
}

/** Random block trees: nesting up to maxDepth, 1-12 inline spans, interactive+styling mixed. */
function buildBlock(rand, { maxDepth }) {
    const root = document.createElement("p");
    const state = { remaining: 1 + Math.floor(rand() * 12) };
    const fill = (element, depth) => {
        const children = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < children; i++) {
            const roll = rand();
            if (roll < 0.45 || state.remaining <= 0 || depth >= maxDepth) {
                element.appendChild(document.createTextNode(randomText(rand)));
            } else if (roll < 0.55) {
                const voidTag = ["img", "wbr", "code"][Math.floor(rand() * 3)];
                const embed = document.createElement(voidTag);
                if (voidTag === "code") embed.textContent = "opaque_token";
                element.appendChild(embed);
            } else {
                state.remaining -= 1;
                const wrapper = makeWrapper(rand);
                element.appendChild(wrapper);
                fill(wrapper, depth + 1);
                if (!wrapper.textContent.trim()) {
                    wrapper.appendChild(document.createTextNode(`w${Math.floor(rand() * 100)}`));
                }
            }
        }
    };
    fill(root, 0);
    if (!root.textContent.trim()) root.appendChild(document.createTextNode("fallback text"));
    return root;
}

/** Registered = linguistic Text nodes outside opaque subtrees, like the production collector. */
function collectRegisteredTextNodes(root) {
    const out = [];
    const walk = (node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3) {
                if (child.data.trim()) out.push(child);
            } else if (child.nodeType === 1 && child.tagName.toLowerCase() !== "code") {
                walk(child);
            }
        }
    };
    walk(root);
    return out;
}

function makeBlockTarget(root, id) {
    root.normalize();
    return {
        id,
        kind: "block",
        sessionId: "gate-b",
        revision: 0,
        element: root,
        textNodes: collectRegisteredTextNodes(root).map((node) => ({
            nodeRef: { deref: () => node },
            node,
            path: null,
            source: node.data,
            appliedTranslation: null,
        })),
    };
}

// Production committer: per-Text-node CAS with whitespace-normalized compare (dom/committer.js).
const blockCommitter = (blockTarget, perNode) => applyBlock(blockTarget, perNode);

function normalizeWs(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function mountWithSentinels(root) {
    document.body.innerHTML = "";
    const before = document.createElement("aside");
    before.textContent = "outside-before";
    const after = document.createElement("aside");
    after.textContent = "outside-after";
    document.body.append(before, root, after);
    return { before, after };
}

function interactiveSnapshot(root) {
    return Array.from(root.querySelectorAll("a, [role], [tabindex], [contenteditable]"))
        .filter((element) => isInteractiveWrapper(element))
        .map((element) => ({ element, text: element.textContent }));
}

/** Adversarial reply mangling ops over the serialized wire string. */
function mangle(rand, source) {
    const parts = source.split(new RegExp(`(${PLACEHOLDER_GRAMMAR.source})`, "g")).filter(Boolean);
    const tagIndexes = parts
        .map((part, index) => (TOKEN_EXACT.test(part) ? index : -1))
        .filter((index) => index >= 0);
    const op = Math.floor(rand() * 6);
    if (op === 0 && tagIndexes.length) {
        // drop one tag
        parts.splice(tagIndexes[Math.floor(rand() * tagIndexes.length)], 1);
        return parts.join("");
    }
    if (op === 1 && tagIndexes.length >= 2) {
        // swap two tags
        const a = tagIndexes[Math.floor(rand() * tagIndexes.length)];
        let b = tagIndexes[Math.floor(rand() * tagIndexes.length)];
        if (a === b) b = tagIndexes[(tagIndexes.indexOf(a) + 1) % tagIndexes.length];
        [parts[a], parts[b]] = [parts[b], parts[a]];
        return parts.join("");
    }
    if (op === 2 && tagIndexes.length) {
        // duplicate a tag at a random position
        const raw = parts[tagIndexes[Math.floor(rand() * tagIndexes.length)]];
        parts.splice(Math.floor(rand() * (parts.length + 1)), 0, raw);
        return parts.join("");
    }
    if (op === 3) {
        // invent an unknown tag
        const invented = ["<g99>", "</g99>", "<v99/>"][Math.floor(rand() * 3)];
        parts.splice(Math.floor(rand() * (parts.length + 1)), 0, invented);
        return parts.join("");
    }
    if (op === 4 && tagIndexes.length >= 2) {
        // reorder: shuffle all tags among their positions
        const raws = tagIndexes.map((index) => parts[index]);
        for (let i = raws.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [raws[i], raws[j]] = [raws[j], raws[i]];
        }
        tagIndexes.forEach((partIndex, i) => {
            parts[partIndex] = raws[i];
        });
        return parts.join("");
    }
    // truncate
    return source.slice(0, 1 + Math.floor(rand() * Math.max(1, source.length - 1)));
}

/**
 * The §1.4 degradation ladder as the runtime will drive it. Rung 2 (one reinforced retry) is a
 * scheduler concern; locally a still-broken reply must land on flatten or atomic-degrade.
 */
function runLadder(blockTarget, serialized, reply) {
    const parsed = parseTranslatedBlock(reply, serialized.placeholderInventory);
    if (parsed.ok) {
        applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        return "clean";
    }
    const repair = repairPlaceholders(reply, serialized.placeholderInventory);
    if (repair.ok) {
        const reparsed = parseTranslatedBlock(repair.repaired, serialized.placeholderInventory);
        expect(reparsed.ok).toBe(true);
        applyBlockTranslation(blockTarget, reparsed.segments, blockCommitter);
        return "repair";
    }
    const classified = classifyPlaceholders(blockTarget);
    if (classified.hasInteractive) return "atomic-degrade";
    // Flatten-accept (styling only): strip tags, full text to the dominant Text node, "" to the
    // rest; an empty strip result is terminal keep-source.
    const flat = unarmorText(stripPlaceholderTags(reply)).trim();
    if (flat) {
        let dominantAssigned = false;
        const perNode = blockTarget.textNodes.map((entry) => {
            if (!dominantAssigned && entry.source.trim()) {
                dominantAssigned = true;
                return flat;
            }
            return "";
        });
        applyBlock(blockTarget, perNode);
    }
    return "flatten";
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("Gate B: generative placeholder round-trip", () => {
    it("serialize → identity-translate → apply preserves DOM text", () => {
        // Gate B pins the generative round-trip to nesting ≤4 (spec §5): within the depth
        // limit the round-trip must be EXACT. Depth >4 (flatten / atomic-degrade regimes) is
        // covered by the deterministic serialization tests below.
        const rand = mulberry32(0xed9e5eed);
        let placeholderBlocks = 0;
        for (let iteration = 0; iteration < 120; iteration++) {
            const root = buildBlock(rand, { maxDepth: 4 });
            const { before, after } = mountWithSentinels(root);
            const blockTarget = makeBlockTarget(root, `b${iteration}`);
            if (!blockTarget.textNodes.length) continue;
            const textBefore = root.textContent;
            const elementCountBefore = root.querySelectorAll("*").length;

            const serialized = serializeBlock(blockTarget);
            // Wire hygiene: after removing real placeholder tokens, nothing in the payload may
            // still match the grammar — page-authored collisions must all be armored.
            expect(stripPlaceholderTags(serialized.source)).not.toMatch(PLACEHOLDER_GRAMMAR);
            const tokenCount = (serialized.source.match(GRAMMAR_GLOBAL()) || []).length;
            const { tags } = serialized.placeholderInventory;
            const expectedTokens =
                tags.filter((tag) => tag.kind === "paired").length * 2 +
                tags.filter((tag) => tag.kind === "void").length;
            expect(tokenCount).toBe(expectedTokens);
            // Nesting ≤4 never flattens and never forces atomic serialization.
            expect(serialized.atomicRequired).toBe(false);
            expect(serialized.telemetry.placeholder_depth_flattened).toBe(0);
            expect(
                isTranslationOrderRepresentable(
                    serialized.source,
                    serialized.placeholderInventory,
                    serialized.applyMap
                )
            ).toMatchObject({ ok: true });

            if (tags.some((tag) => tag.kind === "paired")) placeholderBlocks += 1;
            const parsed = parseTranslatedBlock(serialized.source, serialized.placeholderInventory);
            expect(parsed.ok).toBe(true);
            const outcome = applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
            expect(outcome.casFailures).toBe(0);
            expect(outcome.applied).toBe(blockTarget.textNodes.length);
            expect(root.textContent).toBe(textBefore);
            // Structure untouched: only Text.data may change, never nodes or markup shape.
            expect(root.querySelectorAll("*").length).toBe(elementCountBefore);
            expect(before.textContent).toBe("outside-before");
            expect(after.textContent).toBe("outside-after");
        }
        // The generator must actually exercise multi-node placeholder blocks.
        expect(placeholderBlocks).toBeGreaterThan(60);
    });
});

describe("Gate B: adversarial reply mangling", () => {
    it("always terminates in repair | flatten | atomic-degrade, never corrupts the page", () => {
        const rand = mulberry32(0xbadc0de5);
        const outcomes = new Set();
        for (let iteration = 0; iteration < 160; iteration++) {
            const root = buildBlock(rand, { maxDepth: 4 });
            const { before, after } = mountWithSentinels(root);
            const blockTarget = makeBlockTarget(root, `m${iteration}`);
            if (!blockTarget.textNodes.length) continue;
            const serialized = serializeBlock(blockTarget);
            if (serialized.atomicRequired) continue;
            const interactive = interactiveSnapshot(root);
            const mangled = mangle(rand, serialized.source);

            let outcome;
            expect(() => {
                outcome = runLadder(blockTarget, serialized, mangled);
            }).not.toThrow();
            expect(["clean", "repair", "flatten", "atomic-degrade"]).toContain(outcome);
            outcomes.add(outcome);

            // Never blanks Text under an interactive element.
            for (const { element, text } of interactive) {
                const blanked = Boolean(text.trim()) && !element.textContent.trim();
                expect(blanked).toBe(false);
            }
            // Never writes outside the block.
            expect(before.textContent).toBe("outside-before");
            expect(after.textContent).toBe("outside-after");
        }
        expect(outcomes.has("clean") || outcomes.has("repair")).toBe(true);
        expect(outcomes.has("flatten") || outcomes.has("atomic-degrade")).toBe(true);
    });
});

describe("block serialization", () => {
    it("numbers placeholders depth-first from 1 in one sequence across kinds", () => {
        document.body.innerHTML = String.raw`<p id="k">A <b>B <i>C</i></b> <img src="x.png"> D</p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "s1");
        const serialized = serializeBlock(blockTarget);
        expect(serialized.source).toBe("A <g1>B <g2>C</g2></g1> <v3/> D");
        expect(serialized.placeholderInventory.tags).toEqual([
            { name: "g1", kind: "paired", interactive: false },
            { name: "g2", kind: "paired", interactive: false },
            { name: "v3", kind: "void" },
        ]);
        expect(serialized.applyMap.map((entry) => entry.path)).toEqual([[], [1], [1, 2], []]);
        expect(serialized.atomicRequired).toBe(false);
    });

    it("serializes a single-Text-node block as plain text with zero placeholders", () => {
        document.body.innerHTML = String.raw`<p id="k">그저 한 문단.</p>`;
        const blockTarget = makeBlockTarget(document.getElementById("k"), "s2");
        const serialized = serializeBlock(blockTarget);
        expect(serialized.source).toBe("그저 한 문단.");
        expect(serialized.placeholderInventory.tags).toEqual([]);
    });

    it("preserves comment-split Text-node boundaries with one synthetic void placeholder", () => {
        document.body.innerHTML = String.raw`<p id="k">앞<!-- framework marker -->중간<a href="#x">링크</a>뒤</p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "s2-boundary");
        const onTelemetry = jest.fn();
        const serialized = serializeBlock(blockTarget, { onTelemetry });

        // Comments are not provider content, but the two surrounding Text nodes remain distinct
        // DOM commit targets. The boundary prevents the parser from coalescing both into one
        // segment and later routing backwards after the link placeholder.
        expect(serialized.source).toBe("앞<v1/>중간<g2>링크</g2>뒤");
        expect(serialized.placeholderInventory.tags).toEqual([
            { name: "v1", kind: "void" },
            { name: "g2", kind: "paired", interactive: true },
        ]);
        expect(onTelemetry).toHaveBeenCalledTimes(1);
        expect(onTelemetry).toHaveBeenCalledWith("text_node_boundary_inserted");
        expect(
            isTranslationOrderRepresentable(
                serialized.source,
                serialized.placeholderInventory,
                serialized.applyMap
            )
        ).toMatchObject({ ok: true, routedNodeIndexes: [0, 1, 2, 3] });

        const before = blockTarget.textNodes.map((entry) => entry.source);
        const parsed = parseTranslatedBlock(serialized.source, serialized.placeholderInventory);
        expect(parsed.ok).toBe(true);
        expect(applyBlockTranslation(blockTarget, parsed.segments, blockCommitter)).toEqual({
            applied: 4,
            casFailures: 0,
        });
        expect(blockTarget.textNodes.map((entry) => entry.node.data)).toEqual(before);
    });

    it("skips nested leaf blocks — they are separate wire units", () => {
        document.body.innerHTML = String.raw`<li id="k">1990年 <b>春</b><ul><li>nested item</li></ul></li>`;
        const root = document.getElementById("k");
        const own = [root.firstChild, root.querySelector("b").firstChild];
        const blockTarget = {
            id: "s3",
            kind: "block",
            revision: 0,
            element: root,
            textNodes: own.map((node) => ({
                node,
                nodeRef: { deref: () => node },
                source: node.data,
            })),
        };
        const serialized = serializeBlock(blockTarget);
        expect(serialized.source).toBe("1990年 <g1>春</g1>");
        const parsed = parseTranslatedBlock(serialized.source, serialized.placeholderInventory);
        applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        expect(root.querySelector("ul").textContent).toBe("nested item");
    });

    it("flattens styling beyond depth 4 with telemetry, and stays applyable", () => {
        document.body.innerHTML = String.raw`<p id="k"><span><b><i><em><strong><u>deep text</u></strong></em></i></b></span></p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "s4");
        const onTelemetry = jest.fn();
        const serialized = serializeBlock(blockTarget, { onTelemetry });
        expect(serialized.telemetry.placeholder_depth_flattened).toBe(2);
        expect(onTelemetry).toHaveBeenCalledTimes(2);
        expect(onTelemetry).toHaveBeenCalledWith("placeholder_depth_flattened");
        expect(serialized.source).toBe("<g1><g2><g3><g4>deep text</g4></g3></g2></g1>");
        expect(serialized.atomicRequired).toBe(false);
        const parsed = parseTranslatedBlock(serialized.source, serialized.placeholderInventory);
        applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        expect(root.textContent).toBe("deep text");
    });

    it("requires atomic serialization when flattening would erase an interactive wrapper", () => {
        document.body.innerHTML = String.raw`<p id="k"><span><b><i><em><a href="#x">link text</a></em></i></b></span> tail</p>`;
        const blockTarget = makeBlockTarget(document.getElementById("k"), "s5");
        expect(serializeBlock(blockTarget).atomicRequired).toBe(true);
        expect(classifyPlaceholders(blockTarget)).toEqual({
            hasInteractive: true,
            depthExceeded: true,
        });
    });

    it("classifies interactive wrappers within depth as non-atomic", () => {
        document.body.innerHTML = String.raw`<p id="k">Visit <a href="#x">docs</a> now</p>`;
        const blockTarget = makeBlockTarget(document.getElementById("k"), "s6");
        expect(classifyPlaceholders(blockTarget)).toEqual({
            hasInteractive: true,
            depthExceeded: false,
        });
        expect(serializeBlock(blockTarget).atomicRequired).toBe(false);
    });
});

describe("ZWJ armoring", () => {
    it("is a bijection, including for pre-armored lookalikes", () => {
        const samples = [
            "plain text",
            "fake <g1>tag</g1> and <v2/> here",
            "already armored <\u200dg1> stays",
            "double <\u200d\u200dv7/> run",
            "<g12><v3/></g12>",
        ];
        for (const sample of samples) {
            const armored = armorSourceText(sample);
            expect(armored).not.toMatch(PLACEHOLDER_GRAMMAR);
            expect(unarmorText(armored)).toBe(sample);
        }
        expect(armorSourceText("no collisions")).toBe("no collisions");
    });

    it("page text can never forge the placeholder channel", () => {
        const root = document.createElement("p");
        root.appendChild(document.createTextNode("fake <g1>tag</g1> with <v2/> inside "));
        const bold = document.createElement("b");
        bold.textContent = "real";
        root.appendChild(bold);
        document.body.appendChild(root);
        const blockTarget = makeBlockTarget(root, "z1");
        const textBefore = root.textContent;

        const serialized = serializeBlock(blockTarget);
        // Only the real <b> wrapper may appear as grammar on the wire.
        expect(serialized.source.match(GRAMMAR_GLOBAL())).toEqual(["<g1>", "</g1>"]);
        const parsed = parseTranslatedBlock(serialized.source, serialized.placeholderInventory);
        expect(parsed.ok).toBe(true);
        applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        expect(root.textContent).toBe(textBefore);
    });
});

describe("parse validation", () => {
    let inventory;
    beforeEach(() => {
        document.body.innerHTML = String.raw`<p id="k">x <b>y</b> z <i>w</i></p>`;
        inventory = serializeBlock(
            makeBlockTarget(document.getElementById("k"), "p1")
        ).placeholderInventory;
    });

    it.each([
        ["empty reply", "", "empty"],
        ["whitespace reply", "   ", "empty"],
        ["unknown tag", "<g1>y</g1> x <g2>w</g2> <g99>", "unknown-tag"],
        ["duplicate tag", "<g1>y</g1><g1>y</g1> x <g2>w</g2>", "duplicate-tag"],
        ["missing pair entirely", "x <g2>w</g2> z", "missing-tag"],
        ["missing close", "<g1>y</g1> x <g2>w", "missing-close"],
        ["crossed nesting", "<g1>y<g2>z</g1>w</g2>", "unbalanced"],
    ])("%s → %s", (_name, reply, code) => {
        const result = parseTranslatedBlock(reply, inventory);
        expect(result.ok).toBe(false);
        expect(result.failure.code).toBe(code);
    });

    it("accepts reordering and re-nesting — that is the feature", () => {
        const result = parseTranslatedBlock("<g2><g1>xy</g1></g2> tail", inventory);
        expect(result.ok).toBe(true);
        expect(result.segments).toEqual([
            { path: [2, 1], text: "xy" },
            { path: [], text: " tail" },
        ]);
    });
});

describe("placeholder repair ladder rung 1", () => {
    let inventory;
    beforeEach(() => {
        document.body.innerHTML = String.raw`<p id="k">x <b>y</b> z <i>w</i></p>`;
        inventory = serializeBlock(
            makeBlockTarget(document.getElementById("k"), "r1")
        ).placeholderInventory;
    });

    it("closes a single missing close tag at the end", () => {
        const repair = repairPlaceholders("<g1>y2</g1> x2 <g2>w2", inventory);
        expect(repair.ok).toBe(true);
        expect(repair.repaired).toBe("<g1>y2</g1> x2 <g2>w2</g2>");
        expect(parseTranslatedBlock(repair.repaired, inventory).ok).toBe(true);
    });

    it("reorders unambiguously transposed closes", () => {
        const repair = repairPlaceholders("<g1>a <g2>b</g1></g2> tail", inventory);
        expect(repair.ok).toBe(true);
        expect(repair.repaired).toBe("<g1>a <g2>b</g2></g1> tail");
    });

    it("is idempotent on an already-valid reply", () => {
        const valid = "<g2>w</g2> then <g1>y</g1>";
        expect(repairPlaceholders(valid, inventory)).toEqual({ ok: true, repaired: valid });
    });

    it.each([
        ["two missing closes", "<g1>a <g2>b"],
        ["dropped pair", "only <g2>w</g2> here"],
        ["invented tag", "<g1>y</g1> <g2>w</g2> <v9/>"],
        ["duplicated tag", "<g1>y</g1><g1>y</g1><g2>w</g2>"],
        ["text between transposed closes", "<g1>a <g2>b</g1> mid </g2>"],
        ["close before open", "</g1>a<g1> <g2>b</g2>"],
        ["not a string", null],
    ])("declines ambiguous damage: %s", (_name, reply) => {
        expect(repairPlaceholders(reply, inventory).ok).toBe(false);
    });
});

describe("apply semantics", () => {
    it("rejects moved text whose translated order cannot be represented by fixed DOM nodes", () => {
        document.body.innerHTML = String.raw`<p id="k"><a href="#o">対象</a>を動かす</p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "a1");
        const serialized = serializeBlock(blockTarget);
        expect(serialized.source).toBe("<g1>対象</g1>を動かす");
        expect(
            isTranslationOrderRepresentable(
                "<g1>the object</g1> moves",
                serialized.placeholderInventory,
                serialized.applyMap
            )
        ).toMatchObject({ ok: true, routedNodeIndexes: [0, 1] });
        expect(
            isTranslationOrderRepresentable(
                "moves <g1>the object</g1>",
                serialized.placeholderInventory,
                serialized.applyMap
            )
        ).toMatchObject({
            ok: false,
            reason: "non-monotonic-node-order",
            routedNodeIndexes: [1, 0],
        });
        // The session's representability gate must prevent applyBlockTranslation from ever
        // receiving this valid-placeholder-but-wrong-topology reply.
        expect(root.textContent).toBe("対象を動かす");
    });

    it("routes re-nested placeholders by innermost wrapper and blanks emptied styling", () => {
        document.body.innerHTML = String.raw`<p id="k"><b>Alpha</b> mid <i>Beta</i></p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "a2");
        const serialized = serializeBlock(blockTarget);
        const parsed = parseTranslatedBlock(
            "<g2><g1>X</g1></g2> Y",
            serialized.placeholderInventory
        );
        expect(parsed.ok).toBe(true);
        applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        expect(root.querySelector("b").textContent).toBe("X");
        expect(root.querySelector("i").textContent).toBe("");
        expect(normalizeWs(root.textContent)).toBe("X Y");
    });

    it("never blanks an interactive label the reply left empty", () => {
        document.body.innerHTML = String.raw`<p id="k">Visit <a href="#d">docs</a> now</p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "a3");
        const serialized = serializeBlock(blockTarget);
        const parsed = parseTranslatedBlock("<g1></g1> 지금 방문", serialized.placeholderInventory);
        expect(parsed.ok).toBe(true);
        applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        expect(root.querySelector("a").textContent).toBe("docs");
    });

    it("keeps source when an interactive block root would be blanked", () => {
        document.body.innerHTML = String.raw`<a id="k" href="#x">label text</a>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "a4");
        const outcome = applyBlockTranslation(
            blockTarget,
            [{ path: [], text: "   " }],
            blockCommitter
        );
        expect(outcome).toEqual({ applied: 1, casFailures: 0 });
        expect(root.textContent).toBe("label text");
    });

    it("reports CAS failures for nodes mutated between serialize and apply", () => {
        document.body.innerHTML = String.raw`<p id="k">stable <b>volatile</b></p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "a5");
        const serialized = serializeBlock(blockTarget);
        const parsed = parseTranslatedBlock(serialized.source, serialized.placeholderInventory);
        root.querySelector("b").firstChild.data = "site-changed";
        const outcome = applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        expect(outcome.applied).toBe(0);
        expect(outcome.casFailures).toBe(1);
        expect(root.firstChild.data).toBe("stable ");
        expect(root.querySelector("b").textContent).toBe("site-changed");
    });

    it("prefers a caller-attached serialize-time applyMap over recomputation", () => {
        document.body.innerHTML = String.raw`<p id="k">one <b>two</b></p>`;
        const root = document.getElementById("k");
        const blockTarget = makeBlockTarget(root, "a6");
        const serialized = serializeBlock(blockTarget);
        blockTarget.applyMap = serialized.applyMap;
        blockTarget.placeholderInventory = serialized.placeholderInventory;
        const parsed = parseTranslatedBlock("하나 <g1>둘</g1>", serialized.placeholderInventory);
        const outcome = applyBlockTranslation(blockTarget, parsed.segments, blockCommitter);
        expect(outcome).toEqual({ applied: 2, casFailures: 0 });
        expect(root.textContent).toBe("하나 둘");
    });
});

describe("hostile inputs never throw", () => {
    it("tolerates garbage block targets and replies", () => {
        expect(serializeBlock(null).source).toBe("");
        expect(serializeBlock({}).applyMap).toEqual([]);
        expect(classifyPlaceholders(undefined)).toEqual({
            hasInteractive: false,
            depthExceeded: false,
        });
        expect(parseTranslatedBlock(undefined, { tags: [] }).ok).toBe(false);
        expect(parseTranslatedBlock("text", null).ok).toBe(true);
        expect(repairPlaceholders(42, { tags: [] }).ok).toBe(false);
        expect(applyBlockTranslation(null, [], blockCommitter)).toEqual({
            applied: 0,
            casFailures: 0,
        });
        const blockTarget = { textNodes: [{ node: null, source: "x" }] };
        expect(applyBlockTranslation(blockTarget, [], "not a function")).toEqual({
            applied: 0,
            casFailures: 1,
        });
        const throwing = () => {
            throw new Error("committer exploded");
        };
        document.body.innerHTML = String.raw`<p id="k">boom</p>`;
        const real = makeBlockTarget(document.getElementById("k"), "h1");
        expect(applyBlockTranslation(real, [{ path: [], text: "t" }], throwing)).toEqual({
            applied: 0,
            casFailures: 1,
        });
    });
});

describe("normalizeSourceKey", () => {
    it("applies NFC + whitespace collapse + trim + role suffix", () => {
        expect(normalizeSourceKey("  Hello\n\t world ", "p")).toBe("Hello world\u001fp");
        // NFC: decomposed e + combining acute must key identically to precomposed e-acute.
        expect(normalizeSourceKey("cafe\u0301", "p")).toBe(normalizeSourceKey("caf\u00e9", "p"));
    });

    it("defaults the role to p and keeps roles distinct", () => {
        expect(normalizeSourceKey("x")).toBe("x\u001fp");
        expect(normalizeSourceKey("x", "h")).not.toBe(normalizeSourceKey("x", "p"));
    });
});
