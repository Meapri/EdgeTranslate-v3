// Find text the AI page-translation dispatch NEVER reaches on a real page.
// Replicates the actual collection path (collectHtmlPageSections + findLeafBlocksInElement) the
// dispatch uses, marks every covered leaf, then walks ALL meaningful text nodes in the content
// root and reports the ones not covered by any collected leaf — i.e. the structural blind spots
// that can never be translated regardless of API/lazy/cache behavior.
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
const { JSDOM } = require("jsdom");

const repoRoot = "/Users/naen/Git/EdgeTranslate-v3";
const domContextPath = path.join(
    repoRoot,
    "packages/EdgeTranslate/src/content/dom_page_translate_context.js"
);

async function loadContext(seedDoc, win) {
    const source = await fs.readFile(domContextPath, "utf8");
    const mod = { exports: {} };
    const sandbox = {
        module: mod,
        exports: mod.exports,
        require,
        console,
        document: seedDoc,
        window: win,
        Node: win.Node,
        NodeFilter: win.NodeFilter,
        DOMParser: win.DOMParser,
        Element: win.Element,
        DocumentFragment: win.DocumentFragment,
    };
    vm.createContext(sandbox);
    const { code } = transformSync(source, {
        filename: domContextPath,
        babelrc: false,
        configFile: false,
        presets: [[require.resolve("@babel/preset-env"), { targets: { node: "18" } }]],
    });
    new vm.Script(code, { filename: domContextPath }).runInContext(sandbox);
    return mod.exports;
}

function textLen(el) {
    return String((el && el.textContent) || "").replace(/\s+/g, " ").trim().length;
}

// Mirror getDomPagePrimaryContentRoot(): the single <main>/[role=main] holding the bulk of text.
function primaryContentRoot(doc) {
    const bodyLen = textLen(doc.body);
    const mains = Array.from(doc.querySelectorAll("main, [role='main']")).filter(
        (el) => textLen(el) >= 200
    );
    if (mains.length === 1 && textLen(mains[0]) / bodyLen >= 0.35) return mains[0];
    return doc.querySelector(".mw-parser-output") || doc.body;
}

const EXCLUDE_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "CODE", "PRE", "KBD", "SAMP",
    "TEXTAREA", "INPUT", "SELECT", "OPTION", "IMG", "PICTURE", "VIDEO", "AUDIO", "IFRAME",
    "CANVAS", "BUTTON",
]);

// "Meaningful" = ≥2 chars with at least one letter, not inside an excluded/hidden/code subtree.
function isMeaningfulTextNode(node, Node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
    if (text.length < 2 || !/\p{L}/u.test(text)) return false;
    let el = node.parentElement;
    while (el) {
        if (EXCLUDE_TAGS.has(el.tagName)) return false;
        const aria = el.getAttribute && el.getAttribute("aria-hidden");
        if (aria === "true" || (el.hasAttribute && el.hasAttribute("hidden"))) return false;
        if (el === document.documentElement) break;
        el = el.parentElement;
    }
    return true;
}

const html = await fs.readFile(process.argv[2] || "/tmp/keihan.html", "utf8");
const dom = new JSDOM(html);
const doc = dom.window.document;
globalThis.document = doc; // for isMeaningfulTextNode's documentElement check
const ctx = await loadContext(doc, dom.window);
const Node = dom.window.Node;

const root = primaryContentRoot(doc);
console.log(
    `root: <${root.tagName.toLowerCase()}${root.id ? " id=" + root.id : ""}>  bodyTextLen=${textLen(doc.body)}`
);

// --- Replicate the dispatch's structural collection (permissive eligibility) ---
const sections = ctx.collectHtmlPageSections([root], {
    minChars: 600,
    maxChars: 20000,
    recurseNestedContainers: true,
});
const covered = new Set();
let leafCount = 0;
for (const section of sections) {
    for (const child of section.children) {
        for (const leaf of ctx.findLeafBlocksInElement(child)) {
            leafCount += 1;
            // Mark the leaf and every descendant as covered.
            covered.add(leaf);
            const all = leaf.querySelectorAll ? leaf.querySelectorAll("*") : [];
            all.forEach((d) => covered.add(d));
        }
    }
}
console.log(`collected: ${sections.length} sections, ${leafCount} leaves`);

// --- Walk ALL meaningful text nodes; flag those not inside a covered leaf ---
const walker = doc.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT);
let node;
let totalMeaningful = 0;
let coveredCount = 0;
const gaps = new Map(); // signature -> { count, chars, samples: [] }
while ((node = walker.nextNode())) {
    if (!isMeaningfulTextNode(node, Node)) continue;
    totalMeaningful += 1;
    let el = node.parentElement;
    let isCovered = false;
    while (el && el !== root.parentElement) {
        if (covered.has(el)) { isCovered = true; break; }
        el = el.parentElement;
    }
    if (isCovered) { coveredCount += 1; continue; }

    // Build a signature describing WHERE the gap lives.
    const p = node.parentElement;
    const ancestors = [];
    let a = p;
    for (let i = 0; i < 5 && a && a !== root.parentElement; i += 1) {
        const cls = (typeof a.className === "string" ? a.className : "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
        ancestors.push(`${a.tagName.toLowerCase()}${cls ? "." + cls : ""}`);
        a = a.parentElement;
    }
    const sig = ancestors.join(" < ");
    if (!gaps.has(sig)) gaps.set(sig, { count: 0, chars: 0, samples: [] });
    const g = gaps.get(sig);
    g.count += 1;
    const t = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
    g.chars += t.length;
    if (g.samples.length < 2) g.samples.push(t.slice(0, 60));
}

const gapNodes = totalMeaningful - coveredCount;
console.log(
    `\nmeaningful text nodes: ${totalMeaningful} | covered: ${coveredCount} | UNCOVERED: ${gapNodes} (${((gapNodes / totalMeaningful) * 100).toFixed(1)}%)`
);

const sorted = Array.from(gaps.entries()).sort((a, b) => b[1].chars - a[1].chars);
console.log(`\n── Uncovered text groups (top 25 by total chars) ──────────────`);
for (const [sig, g] of sorted.slice(0, 25)) {
    console.log(`\n[${g.count} nodes, ${g.chars} chars]  ${sig}`);
    g.samples.forEach((s) => console.log(`    "${s}"`));
}
