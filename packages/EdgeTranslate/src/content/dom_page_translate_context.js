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

function inferDomPageTextRole(element) {
    if (!element || !element.closest) return "text";

    const roleSource = [
        element.tagName,
        element.getAttribute && element.getAttribute("role"),
        element.getAttribute && element.getAttribute("aria-label"),
        element.id,
        element.className,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    if (
        element.closest("time,[datetime]") ||
        /\b(date|time|published|updated|timestamp)\b/.test(roleSource)
    ) {
        return "date";
    }
    if (element.closest("h1,h2,h3,h4,h5,h6,[role='heading']")) return "title";
    if (element.closest("button,[role='button'],label,option")) return "label";
    if (element.closest("nav,[role='navigation']")) return "navigation";
    if (element.closest("li")) return "list-item";
    if (element.closest("th")) return "table-header";
    if (element.closest("caption,figcaption")) return "caption";
    if (element.closest("p,blockquote,dd,dt")) return "paragraph";
    return "text";
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
        role: inferDomPageTextRole(block),
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
        role: inferDomPageTextRole(block),
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

function sanitizeSegmentRole(role) {
    const normalized = String(role || "")
        .toLowerCase()
        .replace(/[^a-z-]/g, "");
    return normalized || "text";
}

function getSegmentMarker(index, role) {
    return `<<<EDGE_TRANSLATE_SEGMENT_${index + 1} role=${sanitizeSegmentRole(role)}>>>`;
}

function buildSegmentedTranslationText(items) {
    return (items || [])
        .map((item, index) => {
            const text =
                item && typeof item === "object"
                    ? item.text || item.sourceText || ""
                    : String(item || "");
            const role = item && typeof item === "object" ? item.role : "text";
            return [getSegmentMarker(index, role), String(text || "").trim()].join("\n");
        })
        .join("\n");
}

function splitSegmentedTranslationText(translatedText, expectedCount) {
    const translated = String(translatedText || "").trim();
    if (!translated || expectedCount <= 0) return null;

    const markerPattern = /<<<EDGE_TRANSLATE_SEGMENT_(\d+)(?:\s+role=[a-z-]+)?>>>/g;
    const matches = Array.from(translated.matchAll(markerPattern));
    if (matches.length !== expectedCount) return null;

    const parts = new Array(expectedCount);
    for (let i = 0; i < matches.length; i += 1) {
        const markerIndex = Number(matches[i][1]) - 1;
        if (markerIndex < 0 || markerIndex >= expectedCount || parts[markerIndex] !== undefined) {
            return null;
        }
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : translated.length;
        const value = translated.slice(start, end).trim();
        if (!value) return null;
        parts[markerIndex] = value;
    }

    if (parts.some((part) => part === undefined)) return null;
    return parts;
}

export {
    buildContextTranslationGroups,
    buildSegmentedTranslationText,
    createReadableBlockReplacement,
    inferDomPageTextRole,
    splitSegmentedTranslationText,
    splitTranslatedContext,
};
