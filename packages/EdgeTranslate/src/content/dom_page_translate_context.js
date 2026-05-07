const BLOCK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "CAPTION",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
]);

const READABLE_REPLACE_BLOCK_TAGS = new Set([
    "BLOCKQUOTE",
    "CAPTION",
    "DD",
    "DT",
    "FIGCAPTION",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "P",
]);

const UNSAFE_WHOLE_BLOCK_REPLACE_SELECTOR = [
    "a",
    "button",
    "canvas",
    "code",
    "embed",
    "iframe",
    "img",
    "input",
    "kbd",
    "math",
    "object",
    "option",
    "picture",
    "pre",
    "samp",
    "script",
    "select",
    "style",
    "svg",
    "textarea",
    "video",
    "audio",
].join(",");

function normalizeTextNodeValue(node) {
    return String((node && node.nodeValue) || "")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeBlockText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function getMeaningfulTextNodes(element) {
    if (!element) return [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
        if (normalizeTextNodeValue(node)) nodes.push(node);
    }
    return nodes;
}

function getContextBlockElement(node) {
    let element = node && node.parentElement;
    while (element && element !== document.body && element !== document.documentElement) {
        if (BLOCK_TAGS.has(element.tagName)) return element;
        element = element.parentElement;
    }
    return node && node.parentElement;
}

function buildContextTranslationGroups(nodes, options = {}) {
    const maxChars = options.maxChars || 3500;
    const buckets = new Map();

    for (const node of nodes || []) {
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const text = normalizeTextNodeValue(node);
        if (!text) continue;
        const block = getContextBlockElement(node) || node.parentElement;
        if (!block) continue;
        if (!buckets.has(block)) buckets.set(block, []);
        buckets.get(block).push({ node, text });
    }

    const groups = [];
    for (const [block, entries] of buckets.entries()) {
        let current = [];
        let currentLength = 0;
        for (const entry of entries) {
            const projectedLength = currentLength + entry.text.length + (current.length ? 1 : 0);
            if (current.length && projectedLength > maxChars) {
                groups.push(createContextGroup(block, current));
                current = [];
                currentLength = 0;
            }
            current.push(entry);
            currentLength += entry.text.length + (current.length > 1 ? 1 : 0);
        }
        if (current.length) groups.push(createContextGroup(block, current));
    }

    return groups;
}

function createContextGroup(block, entries) {
    return {
        block,
        nodes: entries.map((entry) => entry.node),
        texts: entries.map((entry) => entry.text),
        sourceText: entries.map((entry) => entry.text).join("\n"),
    };
}

function createReadableBlockReplacement(group, options = {}) {
    const minNodes = options.minNodes || 2;
    const maxChars = options.maxChars || 3500;
    const block = group && group.block;
    if (!block || !READABLE_REPLACE_BLOCK_TAGS.has(block.tagName)) return null;
    if (!group.nodes || group.nodes.length < minNodes) return null;
    if (block.querySelector && block.querySelector(UNSAFE_WHOLE_BLOCK_REPLACE_SELECTOR)) {
        return null;
    }

    const meaningfulNodes = getMeaningfulTextNodes(block);
    const groupNodes = new Set(group.nodes);
    if (!meaningfulNodes.length || meaningfulNodes.some((node) => !groupNodes.has(node))) {
        return null;
    }

    const sourceText = normalizeBlockText(block.textContent);
    if (!sourceText || sourceText.length > maxChars) return null;

    return {
        block,
        nodes: group.nodes,
        sourceText,
    };
}

function splitTranslatedContext(translatedText, expectedCount) {
    const translated = String(translatedText || "").trim();
    if (!translated) return [];
    if (expectedCount <= 1) return [translated];

    const lines = translated
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === expectedCount) return lines;

    const sentences = translated
        .match(/[^.!?。！？]+[.!?。！？]?/g)
        ?.map((part) => part.trim())
        .filter(Boolean);
    if (sentences && sentences.length === expectedCount) return sentences;

    return null;
}

export { buildContextTranslationGroups, createReadableBlockReplacement, splitTranslatedContext };
