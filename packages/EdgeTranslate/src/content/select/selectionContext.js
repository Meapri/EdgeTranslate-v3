/**
 * Selection-context capture for AI (LLM) translation.
 *
 * LLMs — unlike classic MT engines — can use surrounding text to disambiguate word senses,
 * resolve pronouns, and match tone. This module extracts a tightly budgeted context window
 * around the user's selection: a slice of the enclosing semantic block plus the page title
 * and hostname. The result rides along with the translate request and is consumed ONLY by
 * the AI translator (Google/Bing translation behavior is untouched).
 *
 * Budgets are deliberately tiny (the whole context is ~100 tokens) and capture bails out
 * entirely wherever the surrounding DOM is not meaningful prose:
 *   - the built-in PDF viewer (text layer is layout-fragmented),
 *   - <input>/<textarea>/contenteditable hosts (form context is not prose),
 *   - selections ≥ MAX_SELECTION_CHARS (long passages carry their own context).
 */

const MAX_SELECTION_CHARS = 500;
const MAX_SURROUNDING_CHARS = 300;
const MAX_TITLE_CHARS = 80;

// Mirrors the semantic-block resolution used for selection segmentation (select.js):
// nearest semantic prose/label ancestor first, then the closest block-like container.
const SEMANTIC_BLOCK_SELECTOR =
    "h1,h2,h3,h4,h5,h6,[role='heading'],p,blockquote,dd,dt,li,th,td,caption,figcaption";

const BLOCK_FALLBACK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DIV",
    "FIGURE",
    "FOOTER",
    "HEADER",
    "MAIN",
    "P",
    "SECTION",
    "TABLE",
    "TD",
    "TH",
    "LI",
    "UL",
    "OL",
]);

function normalizeContextText(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}

function rangeAnchorElement(range) {
    const node = range && range.startContainer;
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

// The first block-like ancestor, halting at body/documentElement. We do NOT keep walking
// upward past the first block hit — pulling neighboring paragraphs in would both waste
// tokens and risk the model translating unrelated text (redteam: context bleed).
function findEnclosingBlock(element) {
    if (!element || !element.closest) return null;
    const semantic = element.closest(SEMANTIC_BLOCK_SELECTOR);
    if (semantic) return semantic;
    let current = element;
    while (current && current !== document.body && current !== document.documentElement) {
        if (BLOCK_FALLBACK_TAGS.has(current.tagName)) return current;
        current = current.parentElement;
    }
    return null;
}

// Snap slice edges onto whitespace so the context never starts or ends mid-word — a cut
// word fragment invites the model to "complete" it (redteam: context-bleed risk). Only the
// edges that were actually produced by a mid-text slice are snapped.
function snapWindowEdges(window, { snapStart = false, snapEnd = false } = {}) {
    let value = String(window || "");
    if (snapStart) value = value.replace(/^\S*\s+/, "");
    if (snapEnd) value = value.replace(/\s+\S*$/, "");
    return value.trim();
}

/**
 * A window of the block's text centered on the selection. When the selection is found in
 * the normalized block text, take roughly equal slack on both sides; otherwise fall back
 * to the block's leading slice. Sliced edges are snapped to whitespace boundaries.
 */
function buildSurroundingWindow(blockText, selectionText) {
    if (!blockText) return "";
    if (blockText.length <= MAX_SURROUNDING_CHARS) return blockText;

    const at = selectionText ? blockText.indexOf(selectionText) : -1;
    if (at < 0) {
        return snapWindowEdges(blockText.slice(0, MAX_SURROUNDING_CHARS), { snapEnd: true });
    }
    const slack = Math.max(0, MAX_SURROUNDING_CHARS - selectionText.length);
    const before = Math.ceil(slack / 2);
    const start = Math.max(0, at - before);
    const end = Math.min(blockText.length, at + selectionText.length + (slack - (at - start)));
    return snapWindowEdges(blockText.slice(start, end), {
        snapStart: start > 0,
        snapEnd: end < blockText.length,
    });
}

function isFormOrEditableContext(element) {
    if (!element || !element.closest) return false;
    return Boolean(
        element.closest(
            "input,textarea,select,[contenteditable],[contenteditable=''],[contenteditable='true']"
        )
    );
}

/**
 * Extract { surrounding, title, domain } for the current selection, or null when context
 * capture is unsafe / valueless. Pure DOM reads — no layout, no network.
 */
function extractSelectionContext(selection, { isPdfViewer = false } = {}) {
    try {
        if (isPdfViewer) return null;
        if (!selection || !selection.rangeCount) return null;
        const selectionText = normalizeContextText(selection.toString());
        if (!selectionText || selectionText.length >= MAX_SELECTION_CHARS) return null;

        const anchor = rangeAnchorElement(selection.getRangeAt(0));
        if (!anchor || isFormOrEditableContext(anchor)) return null;

        const title = normalizeContextText(document.title).slice(0, MAX_TITLE_CHARS);
        let domain = "";
        try {
            domain = String(location.hostname || "");
        } catch {
            domain = "";
        }

        let surrounding = "";
        const block = findEnclosingBlock(anchor);
        if (block) {
            const blockText = normalizeContextText(block.textContent);
            // Context is only context when it carries MORE than the selection itself.
            if (blockText && blockText.length > selectionText.length + 12) {
                surrounding = buildSurroundingWindow(blockText, selectionText);
                if (surrounding === selectionText) surrounding = "";
            }
        }

        if (!surrounding && !title && !domain) return null;
        return { surrounding, title, domain };
    } catch {
        // Context capture is a best-effort enhancement — never break selection translation.
        return null;
    }
}

export {
    extractSelectionContext,
    buildSurroundingWindow,
    findEnclosingBlock,
    MAX_SELECTION_CHARS,
    MAX_SURROUNDING_CHARS,
};
