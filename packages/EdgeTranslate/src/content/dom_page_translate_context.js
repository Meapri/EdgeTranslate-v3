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

function normalizeTextNodeValue(node) {
    return String((node && node.nodeValue) || "")
        .replace(/\s+/g, " ")
        .trim();
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

export { buildContextTranslationGroups, splitTranslatedContext };
