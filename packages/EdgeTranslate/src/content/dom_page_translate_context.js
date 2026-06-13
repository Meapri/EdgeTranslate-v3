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
        if (inferDomPageTextRole(block) === "text" && entries.length > 1) {
            entries.forEach((entry) => groups.push(createContextGroup(block, [entry])));
            continue;
        }
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

// ---------------------------------------------------------------------------
// HTML-native page translation (LLM-optimized path)
// ---------------------------------------------------------------------------
// For AI engines we send the leaf block's innerHTML as the payload and ask the
// model to return translated innerHTML preserving every tag and attribute. The
// apply path validates the response before swapping innerHTML so a malformed
// or empty translation can never erase the original block.
// ---------------------------------------------------------------------------

const HTML_BLOCK_LEAF_TAGS = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "DD",
    "DT",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "CAPTION",
    "TH",
    "TD",
    "LABEL",
    "BUTTON",
    "SUMMARY",
]);

const HTML_BLOCK_EXCLUDE_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "MATH",
    "CODE",
    "PRE",
    "KBD",
    "SAMP",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
]);

const HTML_SECTION_CONTAINER_TAGS = new Set([
    "ARTICLE",
    "ASIDE",
    "BODY",
    "DIV",
    "FOOTER",
    "HEADER",
    "MAIN",
    "NAV",
    "SECTION",
    "TABLE",
    "TBODY",
    "TFOOT",
    "THEAD",
    "UL",
    "OL",
]);

const HTML_DANGEROUS_TAG_SELECTOR =
    "script,style,iframe,object,embed,link[rel=stylesheet],meta,base";
const HTML_DANGEROUS_ATTR_PREFIX = /^on/i;

const HTML_PRESERVED_ATTRS_BY_TAG = {
    A: ["href", "target", "rel", "download", "hreflang", "type"],
    IMG: ["src", "srcset", "alt", "width", "height", "loading", "decoding", "sizes"],
    AREA: ["href", "alt", "target", "rel", "coords", "shape"],
    SOURCE: ["src", "srcset", "type", "media", "sizes"],
    VIDEO: ["src", "poster", "controls", "autoplay", "muted", "loop"],
    AUDIO: ["src", "controls", "autoplay", "muted", "loop"],
    INPUT: ["type", "name", "value", "placeholder"],
};

function isExcludedHtmlSubtree(element) {
    if (!element) return true;
    if (HTML_BLOCK_EXCLUDE_TAGS.has(element.tagName)) return true;
    if (element.closest) {
        const exclusionSelectors =
            "script,style,noscript,template,svg,math,code,pre,kbd,samp,textarea,input,select,option";
        if (
            element.closest(exclusionSelectors) !== element &&
            element.closest(exclusionSelectors)
        ) {
            return true;
        }
    }
    return false;
}

function elementHasNestedTranslatableBlock(element) {
    if (!element || !element.querySelector) return false;
    for (const tag of HTML_BLOCK_LEAF_TAGS) {
        if (element.querySelector(tag)) return true;
    }
    return false;
}

/**
 * Validation + sanitization for a translated HTML payload. Builds a detached
 * container with the model's output, removes anything dangerous, then walks the
 * original element to restore critical structural attributes (href, src, alt,
 * srcset, id, class, data-*, style) on matching tags. The returned container
 * holds the safe-to-apply innerHTML; null means the payload is unusable.
 */
function buildSafeTranslatedHtml(originalElement, translatedHtml) {
    if (!originalElement || !translatedHtml) return null;
    const trimmed = stripLeadingNonHtmlEcho(String(translatedHtml).trim());
    if (!trimmed) return null;

    const container = originalElement.ownerDocument.createElement(originalElement.tagName);
    try {
        container.innerHTML = trimmed;
    } catch {
        return null;
    }
    if (!sanitizeTranslatedHtmlContainer(container)) return null;
    // Reject when the model reshaped the markup — applying it would break the
    // layout (e.g. flex/inline widgets collapsing to stacked full-width boxes).
    // Leaving the element untranslated is far better than mangling the page.
    if (!restoreHtmlCriticalAttributes(originalElement, container)) return null;
    return container;
}

/**
 * Some models (especially smaller ones) prepend a sentence like
 * "Here is the translated HTML:" or echo the instruction header before the
 * actual HTML payload. Detect that prefix and drop it so the parsed DOM
 * doesn't include the echoed text as a real text node in the translated block.
 */
// Leaf-level block tags used for per-paragraph original-text registration. A
// section's children may be a single wrapper (e.g. <div class="newsArea">) that
// itself contains many block-level descendants — registering the original text
// only on the wrapper makes the hover tooltip display the entire article as one
// blob. We descend into these tags to capture/restore per-paragraph instead.
const LEAF_BLOCK_TAGS = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "CAPTION",
    "TH",
    "TD",
    "LABEL",
    "BUTTON",
    "SUMMARY",
    "DD",
    "DT",
    "PRE",
]);

const LEAF_BLOCK_TAG_SELECTOR = Array.from(LEAF_BLOCK_TAGS)
    .map((tag) => tag.toLowerCase())
    .join(",");

/**
 * The text a leaf-block contributes ON ITS OWN — everything except the subtrees of
 * nested LEAF_BLOCK descendants, which are separate leaves with their own segment.
 * A list item like `<li>1990年（平成2年）<ul><li>…</li></ul></li>` owns "1990年（平成2年）";
 * the sub-list is translated as its own leaf. Used to decide whether such a parent
 * carries translatable text that would otherwise be dropped, and to capture the right
 * hover original for it.
 */
function leafBlockOwnText(element) {
    if (!element || !element.childNodes) return "";
    let out = "";
    const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            out += node.nodeValue || "";
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = String(node.tagName || "").toUpperCase();
        if (LEAF_BLOCK_TAGS.has(tag)) return; // nested leaf-block = its own unit
        if (HTML_BLOCK_EXCLUDE_TAGS.has(tag)) return;
        for (const child of node.childNodes) visit(child);
    };
    for (const child of element.childNodes) visit(child);
    return out;
}

function elementHasOwnLeafText(element) {
    return normalizeBlockText(leafBlockOwnText(element)).length >= 2;
}

/**
 * Returns the leaf-level block-text elements inside `element` in document order.
 * A "leaf" is normally a block element with no nested LEAF_BLOCK_TAGS — the
 * granularity we want for per-paragraph hover/original-text mapping.
 *
 * A block that has BOTH its own direct text AND nested leaf-blocks (e.g. a list
 * item with a lead line plus a sub-list — pervasive in Wikipedia history/station
 * lists) is ALSO returned: keeping only the innermost descendants would silently
 * drop the parent's own line. Such a parent is serialized/applied over its OWN
 * content only (nested leaf-blocks are skipped there), so its line and the sub-list
 * each translate exactly once.
 *
 * If `element` itself is a leaf block with no block-level descendants, returns
 * [element] so callers can treat it uniformly.
 */
function findLeafBlocksInElement(element) {
    if (!element || !element.querySelectorAll) return [];
    const descendants = element.querySelectorAll(LEAF_BLOCK_TAG_SELECTOR);
    if (descendants.length === 0) {
        // No block descendants — treat the element itself as the leaf.
        const text = String(element.textContent || "").trim();
        return text ? [element] : [];
    }
    const leaves = [];
    // `element` itself may be a leaf-block that wraps nested leaf-blocks; in document
    // order its own line comes first, so consider it before its descendants.
    if (LEAF_BLOCK_TAGS.has(element.tagName) && elementHasOwnLeafText(element)) {
        leaves.push(element);
    }
    for (const node of descendants) {
        if (!LEAF_BLOCK_TAGS.has(node.tagName)) continue;
        if (!String(node.textContent || "").trim()) continue;
        if (node.querySelector(LEAF_BLOCK_TAG_SELECTOR)) {
            // Non-innermost block: keep it only for its OWN direct line (its nested
            // leaf-blocks are returned separately). Pure wrappers with no own text
            // are skipped so we never emit an empty segment.
            if (elementHasOwnLeafText(node)) leaves.push(node);
            continue;
        }
        leaves.push(node);
    }
    return leaves;
}

/**
 * Companion to findLeafBlocksInElement that returns the normalized leaf text in
 * the same document order. Used to snapshot original text before the section
 * apply swaps children, so the after-apply registration can pair leaves
 * positionally.
 */
function captureLeafTextsFromElement(element) {
    const leaves = findLeafBlocksInElement(element);
    return leaves.map((leaf) =>
        String(leaf.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Split a leaf element's child nodes into logical line segments using <br>
 * elements as separators. Returns an array of segment descriptors:
 *   { startIndex, endIndex, text }
 * where startIndex/endIndex are indices into the original childNodes list and
 * text is the segment's normalized visible text. <br>s themselves and pure-
 * whitespace segments are omitted from the result.
 *
 * Pages that pack many visual paragraphs into a single <p> + <br> structure
 * (extremely common in legacy news markup) need this granularity for hover
 * tooltips to work per-line instead of dumping the entire blob.
 */
function splitLeafByLineBreaks(element) {
    if (!element || !element.childNodes) return [];
    const children = Array.from(element.childNodes);
    const segments = [];
    let segStart = 0;
    const flush = (endIndex) => {
        if (endIndex <= segStart) {
            segStart = endIndex + 1;
            return;
        }
        const slice = children.slice(segStart, endIndex);
        const text = slice
            .map((node) => String(node.textContent || ""))
            .join("")
            .replace(/\s+/g, " ")
            .trim();
        if (text) {
            segments.push({ startIndex: segStart, endIndex, text });
        }
        segStart = endIndex + 1;
    };
    for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        const isBr = child && child.nodeType === Node.ELEMENT_NODE && child.tagName === "BR";
        if (isBr) flush(i);
    }
    flush(children.length);
    return segments;
}

/**
 * In-place wrap each <br>-separated segment of `element`'s inline content in a
 * <span data-edge-translate-segment>. Returns the array of created span
 * elements in document order so callers can pair them with captured original
 * texts. Pure-whitespace segments and <br>s themselves are left untouched.
 *
 * Returns an empty array when the leaf has fewer than 2 segments — wrapping is
 * only useful for differentiating between segments.
 */
function wrapLeafLineSegmentsInSpans(element) {
    if (!element || !element.ownerDocument) return [];
    const segments = splitLeafByLineBreaks(element);
    if (segments.length < 2) return [];

    const ownerDocument = element.ownerDocument;
    const originalChildren = Array.from(element.childNodes);
    const fragment = ownerDocument.createDocumentFragment();
    const spans = [];
    let pos = 0;
    for (const seg of segments) {
        // Carry over any nodes between previous segment and this one (typically
        // empty since flush boundaries are <br>s; defensive in case of weird
        // whitespace-only segments).
        while (pos < seg.startIndex) {
            const node = originalChildren[pos];
            if (node) fragment.appendChild(node);
            pos += 1;
        }
        const span = ownerDocument.createElement("span");
        span.setAttribute("data-edge-translate-segment", "");
        for (let i = seg.startIndex; i < seg.endIndex; i += 1) {
            const node = originalChildren[i];
            if (node) span.appendChild(node);
        }
        fragment.appendChild(span);
        spans.push(span);
        pos = seg.endIndex;
    }
    while (pos < originalChildren.length) {
        const node = originalChildren[pos];
        if (node) fragment.appendChild(node);
        pos += 1;
    }
    // Replace element's children with the wrapped version. appendChild during
    // the loop above already detached nodes from element, so the firstChild
    // loop is effectively a noop — kept defensive.
    while (element.firstChild) element.removeChild(element.firstChild);
    element.appendChild(fragment);
    return spans;
}

// Sentence boundary detection across the writing systems we translate. A NUL marker is inserted at
// each boundary, then callers split on it. Two rules avoid the classic false splits:
//   - CJK enders (。．！？…‥ + optional closers) end a sentence immediately — CJK has no spaces.
//   - Latin enders (.!? + optional closers) end a sentence ONLY when followed by whitespace, so a
//     decimal ("3.14") or mid-word period never splits.
const SENTENCE_BOUNDARY_MARK = "\u0000";
function markSentenceBoundaries(text) {
    return String(text || "")
        .replace(/([。．！？…‥]+["”’」』）)\]]*)/g, `$1${SENTENCE_BOUNDARY_MARK}`)
        .replace(/([.!?]+["')\]]*)(\s)/g, `$1${SENTENCE_BOUNDARY_MARK}$2`);
}

/**
 * Split a string into sentences (Latin + CJK), used to give the hover-original tooltip
 * sentence-level granularity instead of dumping a whole paragraph. Returns [text] when there is
 * only one sentence.
 */
function splitTextIntoSentences(text) {
    const value = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!value) return [];
    const parts = markSentenceBoundaries(value)
        .split(SENTENCE_BOUNDARY_MARK)
        .map((part) => part.trim())
        .filter(Boolean);
    return parts.length ? parts : [value];
}

/**
 * In-place wrap each SENTENCE of a leaf's inline content in a
 * <span data-edge-translate-segment> so the hover tooltip can show just the sentence the cursor is
 * on. Text nodes are split at sentence boundaries (recreated — they carry no identity); inline
 * elements (e.g. <a>) are MOVED whole into the current sentence's span so their attributes and
 * event listeners survive. Returns the created spans in document order, or [] (leaving the DOM
 * untouched) when the leaf is a single sentence or has no splittable text.
 */
function wrapLeafSentencesInSpans(element) {
    if (!element || !element.ownerDocument || !element.childNodes) return [];
    // Parent leaves (own line + a nested sub-list) must not be sentence-wrapped: the
    // wrap moves whole child elements into spans, which would sweep the nested sub-list
    // (a separate leaf) into the parent's sentence span. Such leaves keep whole-line
    // hover only — their own line is short, so nothing is lost.
    if (element.querySelector && element.querySelector(LEAF_BLOCK_TAG_SELECTOR)) return [];
    // Descend to the element that actually CARRIES the text. Two common shapes put all
    // of a leaf's text inside one inline descendant: styled wrappers
    // (<p><span>whole paragraph</span></p>, ubiquitous on news sites) and the inline
    // apply fallback, which writes the whole translation into the first text node —
    // sometimes inside <a>/<b>. Splitting at the leaf level would see a single element
    // child, produce one group, and bail to paragraph-level hover; splitting INSIDE the
    // sole text carrier keeps its styling/attributes on every sentence span.
    let host = element;
    for (;;) {
        let carrier = null;
        let carriers = 0;
        for (const node of host.childNodes) {
            const text =
                node.nodeType === Node.TEXT_NODE
                    ? node.nodeValue
                    : node.nodeType === Node.ELEMENT_NODE
                    ? node.textContent
                    : "";
            if (String(text || "").trim()) {
                carrier = node;
                carriers += 1;
                if (carriers > 1) break;
            }
        }
        if (carriers !== 1 || !carrier || carrier.nodeType !== Node.ELEMENT_NODE) break;
        if (HTML_BLOCK_EXCLUDE_TAGS.has(carrier.tagName)) return []; // code-like: never split
        if (LEAF_BLOCK_TAGS.has(carrier.tagName)) return []; // nested block: not ours
        host = carrier;
    }
    const ownerDocument = element.ownerDocument;
    const originalChildren = Array.from(host.childNodes);
    const groups = [];
    let current = [];
    const flush = () => {
        if (current.length) {
            groups.push(current);
            current = [];
        }
    };
    for (const child of originalChildren) {
        if (child.nodeType === Node.TEXT_NODE) {
            const pieces = markSentenceBoundaries(child.nodeValue || "").split(
                SENTENCE_BOUNDARY_MARK
            );
            for (let i = 0; i < pieces.length; i += 1) {
                if (pieces[i]) current.push(ownerDocument.createTextNode(pieces[i]));
                // A boundary mark followed this piece (i.e. it is not the last piece of the node)
                // → close the current sentence span here.
                if (i < pieces.length - 1) flush();
            }
        } else {
            // Inline element / <br> / etc.: keep it whole inside the current sentence. We MOVE the
            // original node (no clone) so its attributes + event listeners survive.
            current.push(child);
        }
    }
    flush();
    if (groups.length < 2) return [];

    while (host.firstChild) host.removeChild(host.firstChild);
    const spans = [];
    for (const group of groups) {
        const span = ownerDocument.createElement("span");
        span.setAttribute("data-edge-translate-segment", "");
        for (const node of group) span.appendChild(node);
        host.appendChild(span);
        spans.push(span);
    }
    return spans;
}

/**
 * Map `translatedCount` translated-sentence spans onto `originalSentences` proportionally, so each
 * translated sentence shows the original sentence(s) it most likely came from even when the model
 * merged or split sentences (counts differ). When counts match this is a clean 1:1 pairing.
 */
function alignSentencesProportional(translatedCount, originalSentences) {
    const originals = Array.isArray(originalSentences) ? originalSentences : [];
    const total = originals.length;
    const count = Math.max(1, translatedCount | 0);
    if (!total) return new Array(count).fill("");
    const out = [];
    for (let i = 0; i < count; i += 1) {
        const start = Math.min(total - 1, Math.floor((i * total) / count));
        const end = Math.max(start + 1, Math.ceil(((i + 1) * total) / count));
        out.push(originals.slice(start, Math.min(total, end)).join(" "));
    }
    return out;
}

/**
 * Combined per-leaf capture: for each leaf inside `child`, return
 *   { leafIndex, segmentTexts: [text1, text2, ...] }
 * Single-line leaves carry a one-element segmentTexts array; <br>-heavy leaves
 * carry one entry per logical line. The output is what registerAiPageSection
 * OriginalTexts uses to pair (and span-wrap) translated leaves on apply.
 */
function captureLeafSegmentTexts(child) {
    const leaves = findLeafBlocksInElement(child);
    const out = [];
    for (const leaf of leaves) {
        // Parent leaves (own line + a nested sub-list) own only their direct line; the
        // sub-list is captured under its own leaf. Use own-text so the hover original
        // matches what was actually translated for this leaf, and skip <br> splitting
        // (its segments would pull in the nested sub-list's text).
        const hasNestedLeaf = leaf.querySelector && leaf.querySelector(LEAF_BLOCK_TAG_SELECTOR);
        const brSegments = hasNestedLeaf ? [] : splitLeafByLineBreaks(leaf);
        if (brSegments.length >= 2) {
            out.push({ segmentTexts: brSegments.map((seg) => seg.text) });
        } else {
            const text = normalizeBlockText(leafBlockOwnText(leaf));
            if (text) out.push({ segmentTexts: [text] });
            else out.push({ segmentTexts: [] });
        }
    }
    return out;
}

function stripLeadingNonHtmlEcho(text) {
    if (!text) return "";
    // Strip a leading Markdown code fence (```html ... ```), if present.
    let result = text
        .replace(/^\s*```(?:html|xml)?\s*\n?/i, "")
        .replace(/\n?```\s*$/, "")
        .trim();
    // If the response starts with prose that isn't HTML, advance to the first
    // angle bracket. We keep the original string when no tag is found (it may
    // be a plain-text translation).
    const firstAngle = result.indexOf("<");
    if (firstAngle > 0) {
        const prefix = result.slice(0, firstAngle).trim();
        // Only strip when the prefix looks like commentary (no quotes/code
        // markers and contains a colon or ends mid-sentence). Conservative —
        // we'd rather over-include than nuke a legitimate fragment.
        if (/^(?:[A-Za-z][^<>"]{0,200})$/.test(prefix) && /[.:!?]$/.test(prefix)) {
            result = result.slice(firstAngle);
        }
    }
    return result;
}

/**
 * Strip dangerous descendants + `on*` handlers + `javascript:` URLs from a
 * detached container holding translated HTML. Returns false when the container
 * has no visible text after sanitize (i.e. the payload was unusable).
 */
function sanitizeTranslatedHtmlContainer(container) {
    if (!container) return false;
    const translatedText = normalizeBlockText(container.textContent);
    if (!translatedText) return false;

    // DOMParser-style innerHTML assignment never executes <script>, but the
    // markup could still propagate dangerous DOM if we hand it back to the page.
    container.querySelectorAll(HTML_DANGEROUS_TAG_SELECTOR).forEach((el) => el.remove());

    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
        if (node !== container) sanitizeHtmlElementAttributes(node);
        node = walker.nextNode();
    }
    return Boolean(normalizeBlockText(container.textContent));
}

/**
 * Walk the content tree under each root and yield SECTIONS — contiguous runs of
 * sibling elements whose combined plain text fits within [minChars, maxChars].
 * Each section translates as a single LLM call so the model sees full context
 * (no per-block context loss, no marker batching fragility).
 *
 * Section descriptor: { parent, children, plainText, role }
 *   parent   – the common parent element that holds the section's children
 *   children – the contiguous run of element children to translate
 *   plainText – concatenated visible text (for cache keys + suspicious checks)
 *   role     – the best-guess role of the leading child (used for hints)
 */
function collectHtmlPageSections(roots, options = {}) {
    const minChars = options.minChars || 600;
    const maxChars = options.maxChars || 12000;
    const isEligibleElement =
        typeof options.isEligibleElement === "function" ? options.isEligibleElement : null;
    const recurseNestedContainers = options.recurseNestedContainers !== false;
    const sections = [];
    const sourceList = Array.isArray(roots) ? roots : [roots];
    const seenContainers = new WeakSet();
    for (const root of sourceList) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) continue;
        if (seenContainers.has(root)) continue;
        seenContainers.add(root);
        gatherSectionsFromContainer(root, sections, {
            minChars,
            maxChars,
            isEligibleElement,
            recurseNestedContainers,
        });
    }
    return sections;
}

function shouldRecurseIntoSectionChild(child, options) {
    if (!options.recurseNestedContainers) return false;
    if (!child || child.nodeType !== Node.ELEMENT_NODE) return false;
    if (HTML_BLOCK_LEAF_TAGS.has(child.tagName)) return false;
    if (!HTML_SECTION_CONTAINER_TAGS.has(child.tagName)) return false;
    return elementHasNestedTranslatableBlock(child);
}

function gatherSectionsFromContainer(container, out, options) {
    if (!container || !container.children || isExcludedHtmlSubtree(container)) return;

    let buffer = [];
    let bufferChars = 0;

    const flush = () => {
        if (!buffer.length) return;
        const plainText = buffer
            .map((el) => normalizeBlockText(el.textContent))
            .filter(Boolean)
            .join(" ");
        if (plainText) {
            out.push({
                parent: container,
                children: buffer.slice(),
                plainText,
                role: inferDomPageTextRole(buffer[0]),
            });
        }
        buffer = [];
        bufferChars = 0;
    };

    const children = Array.from(container.children);
    for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (!child || child.nodeType !== Node.ELEMENT_NODE) continue;
        if (isExcludedHtmlSubtree(child)) {
            flush();
            continue;
        }
        if (shouldRecurseIntoSectionChild(child, options)) {
            flush();
            gatherSectionsFromContainer(child, out, options);
            continue;
        }
        const childText = normalizeBlockText(child.textContent);
        if (!childText) continue;
        if (options.isEligibleElement && !options.isEligibleElement(child)) {
            flush();
            continue;
        }

        // Oversized single child: flush current buffer, recurse into the child
        // so it gets broken up into smaller sections.
        if (childText.length > options.maxChars) {
            flush();
            if (child.children && child.children.length) {
                gatherSectionsFromContainer(child, out, options);
            } else {
                buffer.push(child);
                bufferChars += childText.length;
                flush();
            }
            continue;
        }

        // Soft break at top-level semantic boundaries when the buffer already has
        // real content. Keeps headings at the start of their section so the model
        // sees the heading as the section's anchor.
        const isSemanticBreak =
            bufferChars >= options.minChars &&
            (child.tagName === "ARTICLE" ||
                child.tagName === "SECTION" ||
                child.tagName === "H1" ||
                child.tagName === "H2");
        if (isSemanticBreak) flush();

        if (bufferChars > 0 && bufferChars + childText.length > options.maxChars) {
            flush();
        }

        buffer.push(child);
        bufferChars += childText.length;
    }
    flush();
}

// ---------------------------------------------------------------------------
// Same-language detection — skip API calls when source text is already in the
// target writing system. Cheap script-based heuristic: count code-point ranges
// that uniquely identify a writing system, divide by total letter-like chars,
// and declare "already target" if the dominant script ratio is high enough.
// ---------------------------------------------------------------------------

const SCRIPT_RANGES = {
    hangul: /[가-힯ᄀ-ᇿ㄰-㆏]/g,
    kana: /[぀-ゟ゠-ヿ]/g,
    han: /[㐀-䶿一-鿿豈-﫿]/g,
    cyrillic: /[Ѐ-ӿ]/g,
    arabic: /[؀-ۿݐ-ݿࢠ-ࣿ]/g,
    devanagari: /[ऀ-ॿ]/g,
    thai: /[฀-๿]/g,
    hebrew: /[֐-׿]/g,
    greek: /[Ͱ-Ͽ]/g,
    latinLetters: /[A-Za-zÀ-ÖØ-öø-ÿĀ-žƀ-ɏ]/g,
};

function countScript(text, regex) {
    const matches = text.match(regex);
    return matches ? matches.length : 0;
}

function isAlreadyInTargetLanguage(text, targetLanguage) {
    const sample = String(text || "").slice(0, 600);
    if (sample.length < 8) return false;
    const target = String(targetLanguage || "")
        .toLowerCase()
        .split("-")[0];
    if (!target) return false;

    const hangul = countScript(sample, SCRIPT_RANGES.hangul);
    const kana = countScript(sample, SCRIPT_RANGES.kana);
    const han = countScript(sample, SCRIPT_RANGES.han);
    const cyrillic = countScript(sample, SCRIPT_RANGES.cyrillic);
    const arabic = countScript(sample, SCRIPT_RANGES.arabic);
    const devanagari = countScript(sample, SCRIPT_RANGES.devanagari);
    const thai = countScript(sample, SCRIPT_RANGES.thai);
    const hebrew = countScript(sample, SCRIPT_RANGES.hebrew);
    const greek = countScript(sample, SCRIPT_RANGES.greek);
    const latin = countScript(sample, SCRIPT_RANGES.latinLetters);
    const totalLetterLike = countScript(sample, /[\p{L}]/gu);
    if (totalLetterLike < 4) return false;
    const ratio = (n) => n / totalLetterLike;

    if (target === "ko") return ratio(hangul) >= 0.6;
    if (target === "ja") return ratio(kana) >= 0.15 || (kana >= 4 && ratio(han + kana) >= 0.6);
    if (target === "zh") return ratio(han) >= 0.55 && ratio(kana) < 0.05 && ratio(hangul) < 0.05;
    if (["ru", "uk", "bg", "be", "sr", "mk"].includes(target)) return ratio(cyrillic) >= 0.6;
    if (target === "ar") return ratio(arabic) >= 0.5;
    if (target === "hi") return ratio(devanagari) >= 0.5;
    if (target === "th") return ratio(thai) >= 0.5;
    if (target === "iw" || target === "he") return ratio(hebrew) >= 0.5;
    if (target === "el") return ratio(greek) >= 0.5;
    const latinTargets = new Set([
        "en",
        "es",
        "fr",
        "de",
        "it",
        "pt",
        "nl",
        "pl",
        "sv",
        "no",
        "da",
        "fi",
        "cs",
        "sk",
        "hr",
        "hu",
        "ro",
        "tr",
        "id",
        "vi",
        "et",
        "lt",
        "lv",
        "sl",
        "ms",
        "ca",
        "gl",
    ]);
    if (latinTargets.has(target)) {
        return ratio(latin) >= 0.7 && ratio(hangul + kana + han + cyrillic + arabic) < 0.1;
    }
    return false;
}

// Attributes the LLM doesn't need to see. Stripping these from outgoing HTML cuts prompt
// size sharply on real pages (especially Tailwind/framework-heavy markup) without losing
// semantic content. The originals are restored on apply via restoreHtmlCriticalAttributes,
// so the live DOM keeps every class/id/style/data-*/href/src/etc.
const PRESENTATION_ATTR_NAMES = new Set([
    "class",
    "id",
    "style",
    "tabindex",
    "role",
    "draggable",
    "contenteditable",
    "hidden",
    "spellcheck",
    "translate",
    "autocapitalize",
    "autocorrect",
    "autofocus",
    "inert",
    "is",
    "itemid",
    "itemprop",
    "itemref",
    "itemscope",
    "itemtype",
    "slot",
    "part",
    "exportparts",
    "popover",
    "nonce",
    "elementtiming",
]);
const PRESENTATION_ATTR_PREFIXES = ["data-", "aria-"];
const LLM_ATTR_ALLOWLIST_BY_TAG = {
    TD: new Set(["colspan", "rowspan", "headers", "scope"]),
    TH: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
    OL: new Set(["start", "type", "reversed"]),
    LI: new Set(["value"]),
};

function isPresentationAttr(name) {
    if (PRESENTATION_ATTR_NAMES.has(name)) return true;
    return PRESENTATION_ATTR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function shouldKeepAttrForLlmPayload(element, name) {
    const lowered = String(name || "").toLowerCase();
    const allowedForTag = LLM_ATTR_ALLOWLIST_BY_TAG[element?.tagName];
    if (allowedForTag && allowedForTag.has(lowered)) return true;
    return false;
}

/**
 * Strip restorable attributes from a clone of the element tree so the LLM only
 * sees structural tags + translatable content. The originals are preserved in
 * the live DOM and re-applied on the response side.
 */
function stripPresentationAttrs(rootElement) {
    if (!rootElement) return;
    const queue = [rootElement];
    while (queue.length) {
        const node = queue.shift();
        if (!node || !node.attributes) continue;
        for (const attr of Array.from(node.attributes)) {
            if (isPresentationAttr(attr.name) || !shouldKeepAttrForLlmPayload(node, attr.name)) {
                node.removeAttribute(attr.name);
            }
        }
        for (const child of node.children) queue.push(child);
    }
}

function nodeContainsPayloadText(node) {
    if (!node) return false;
    if (node.nodeType === Node.TEXT_NODE) return Boolean(normalizeBlockText(node.nodeValue));
    if (node.nodeType === Node.ELEMENT_NODE) return Boolean(normalizeBlockText(node.textContent));
    return false;
}

function hasPayloadTextSibling(node, direction) {
    if (!node) return false;
    let sibling = direction === "previous" ? node.previousSibling : node.nextSibling;
    while (sibling) {
        if (nodeContainsPayloadText(sibling)) return true;
        sibling = direction === "previous" ? sibling.previousSibling : sibling.nextSibling;
    }
    return false;
}

function compactPayloadTextNode(node) {
    const raw = String(node.nodeValue || "");
    if (!raw) return;
    const collapsed = raw.replace(/\s+/g, " ");
    const hasText = Boolean(collapsed.trim());
    const keepLeadingSpace = /^\s/.test(raw) && hasPayloadTextSibling(node, "previous");
    const keepTrailingSpace = /\s$/.test(raw) && hasPayloadTextSibling(node, "next");

    if (!hasText) {
        node.nodeValue = keepLeadingSpace && keepTrailingSpace ? " " : "";
        return;
    }

    let compacted = collapsed.trim();
    if (keepLeadingSpace) compacted = ` ${compacted}`;
    if (keepTrailingSpace) compacted = `${compacted} `;
    node.nodeValue = compacted;
}

function compactHtmlForLlmPayload(rootElement) {
    if (!rootElement) return;
    const filter =
        (typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4) |
        (typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_COMMENT : 128);
    const walker = rootElement.ownerDocument.createTreeWalker(rootElement, filter);
    const remove = [];
    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeType === Node.COMMENT_NODE) {
            remove.push(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
            compactPayloadTextNode(node);
            if (!node.nodeValue) remove.push(node);
        }
    }
    remove.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
}

/**
 * Build the outgoing HTML payload for a section: clone children, strip
 * presentation attrs, concatenate. The model gets a clean, low-token view of
 * the page while every styling attribute survives on the live DOM.
 */
function buildStrippedSectionHtml(children) {
    if (!children || !children.length) return "";
    const ownerDocument = children[0].ownerDocument || document;
    const wrapper = ownerDocument.createElement("div");
    for (const child of children) wrapper.appendChild(child.cloneNode(true));
    stripPresentationAttrs(wrapper);
    compactHtmlForLlmPayload(wrapper);
    return Array.from(wrapper.children)
        .map((c) => c.outerHTML)
        .join("\n");
}

function topLevelChildrenMatch(originalChildren, translatedChildren) {
    if (!originalChildren || !translatedChildren) return false;
    if (originalChildren.length !== translatedChildren.length) return false;
    for (let i = 0; i < originalChildren.length; i += 1) {
        const original = originalChildren[i];
        const translated = translatedChildren[i];
        if (!original || !translated || original.tagName !== translated.tagName) return false;
    }
    return true;
}

// Collect an element's meaningful (non-whitespace-only) text nodes in document order.
// This is the unit the model actually translates, and the only thing we ever mutate on
// apply — element structure, attributes and event listeners are never touched.
function collectMeaningfulTextNodes(element, options = {}) {
    // excludeNestedLeafBlocks: drop text inside nested LEAF_BLOCK descendants. Set only for
    // the ORIGINAL element on apply, where a parent leaf's nested blocks are separate leaves.
    // It must NOT be set for the translated container: the model often wraps its reply in a
    // block tag (`<p>…</p>`), and rejecting that text would drop the whole translation.
    const excludeNestedLeafBlocks = options.excludeNestedLeafBlocks === true;
    const out = [];
    if (!element) return out;
    if (element.nodeType === Node.TEXT_NODE) {
        if (normalizeBlockText(element.nodeValue)) out.push(element);
        return out;
    }
    const ownerDocument = element.ownerDocument;
    if (!ownerDocument || !ownerDocument.createTreeWalker) return out;
    const walker = ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!normalizeBlockText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
            // Skip text inside subtrees the segment payload does NOT map (code-like opaque
            // tags + embedded/non-text elements) so the node count here matches exactly what
            // serializeBlockSegment emitted — otherwise a single <code> span would desync the
            // positional mapping and drop the whole block.
            for (let p = node.parentElement; p && p !== element; p = p.parentElement) {
                const tag = String(p.tagName || "").toUpperCase();
                if (SEGMENT_UNMAPPED_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
                // Nested LEAF_BLOCK: when `element` is a parent leaf (own line + a sub-list),
                // its nested blocks are separate leaves, so their text is not collected here.
                // (No-op for ordinary leaves, which never contain nested leaf-blocks.)
                if (excludeNestedLeafBlocks && LEAF_BLOCK_TAGS.has(tag)) {
                    return NodeFilter.FILTER_REJECT;
                }
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
}

// Keep the original node's leading/trailing whitespace so inline runs ("foo <b>bar</b>")
// don't lose the spaces that separate them after we overwrite the text.
function preserveTextNodeBoundaryWhitespace(node, translated) {
    const raw = String((node && node.nodeValue) || "");
    const lead = /^\s/.test(raw) ? " " : "";
    const trail = /\s$/.test(raw) ? " " : "";
    return `${lead}${translated}${trail}`;
}

// Boundary whitespace for a translated text node that borders inline siblings (links,
// <b>, …). The MODEL'S reply is the authority on TARGET-language spacing, so honor the
// space the model put around the run — NOT the original (source-language) node's spacing.
// The old original-only rule was the "hyperlink eats the space" bug: a space-less source
// (Japanese) stripped the spaces a spaced target (Korean) needs —
// `京阪本線は<a>淀屋橋駅</a>` rendered `게이한 본선은요도야바시역` instead of
// `게이한 본선은 요도야바시역`. Following the model also keeps the inverse correct
// (en→ja drops the English spaces Japanese does not want around the link).
function applyTranslatedBoundaryWhitespace(translatedNode, collapsedValue) {
    const transRaw = String((translatedNode && translatedNode.nodeValue) || "");
    const lead = /^\s/.test(transRaw) ? " " : "";
    const trail = /\s$/.test(transRaw) ? " " : "";
    return `${lead}${collapsedValue}${trail}`;
}

/**
 * THE fundamental-safety primitive for page translation: copy the model's translated
 * text onto the ORIGINAL element's text nodes, in document order, without ever touching
 * its structure or attributes. Because we only write textNode.nodeValue, the layout
 * literally cannot break — every class, flex container, svg icon and event handler stays
 * exactly where the page put it, regardless of how the model reshaped its own HTML.
 *
 * Returns true when at least one node was written. Bails (writes nothing) when the
 * text-node counts diverge — that means the model split/merged/dropped text and a
 * positional mapping would scramble which sentence lands where, so we leave the element
 * untranslated instead. Worst case is "some text stays in the source language", never a
 * broken page.
 */
function applyTranslatedTextNodes(originalElement, translatedElement) {
    const originals = collectMeaningfulTextNodes(originalElement, {
        excludeNestedLeafBlocks: true,
    });
    if (!originals.length) return false;
    const translations = collectMeaningfulTextNodes(translatedElement);
    if (!translations.length) return false;

    if (originals.length === translations.length) {
        // Exact structural match: map text node 1:1 so inline emphasis + links keep their
        // translated text in place (the common, ideal case). Boundary whitespace follows the
        // MODEL'S reply (target-language spacing) so a link's surrounding spaces survive on a
        // space-less source (the ja→ko "hyperlink eats the space" bug).
        let wrote = false;
        for (let i = 0; i < originals.length; i += 1) {
            const value = normalizeBlockText(translations[i].nodeValue);
            if (!value) continue;
            originals[i].nodeValue = applyTranslatedBoundaryWhitespace(translations[i], value);
            wrote = true;
        }
        return wrote;
    }

    // Count mismatch: the model reordered the inline pieces — extremely common EN→KO/JA, where
    // word order moves an inline <a>/<strong> to a different spot so the text-node split no
    // longer lines up. The old behavior REJECTED the whole block, leaving it in the source
    // language (this was the "AI page translation leaves a paragraph with a link untranslated"
    // bug). Instead, write the full translated text onto the block's first DIRECT text run and
    // blank the other text nodes: the content is fully translated and block-level layout is
    // untouched — only inline emphasis/link boundaries inside THIS one block are flattened.
    const joined = translations
        .map((node) => normalizeBlockText(node.nodeValue))
        .filter(Boolean)
        .join(" ");
    if (!joined) return false;
    const primary = originals.find((node) => node.parentNode === originalElement) || originals[0];
    primary.nodeValue = preserveTextNodeBoundaryWhitespace(primary, joined);
    for (const node of originals) {
        if (node !== primary) node.nodeValue = "";
    }
    return true;
}

// ---------------------------------------------------------------------------
// Google-style segment translation (fast / low-token / stable)
// ---------------------------------------------------------------------------
// Instead of round-tripping structural HTML (which costs tokens on every tag and
// invites the model to reshape the layout), we send a flat numbered list of block
// texts — plain text plus attribute-free INLINE tags only — and apply each reply by
// writing text-node values back onto the original block. No structural tag is ever
// sent or generated, and the live DOM structure is never touched.
// ---------------------------------------------------------------------------

// Inline tags whose CONTENT is translated and mapped back. They carry sentence flow (so
// the model translates "click <a>here</a> now" as one sentence) and double as text-node
// boundaries for the positional apply.
const SEGMENT_INLINE_TAGS = new Set([
    "A",
    "ABBR",
    "B",
    "BDI",
    "BDO",
    "CITE",
    "DEL",
    "DFN",
    "EM",
    "FONT",
    "I",
    "INS",
    "MARK",
    "Q",
    "S",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TIME",
    "U",
    "WBR",
    "BR",
]);

// Inline tags kept verbatim in the payload (boundary + context for the model) but whose
// content is NEVER translated or mapped — code identifiers must survive untouched.
const SEGMENT_OPAQUE_TAGS = new Set(["CODE", "KBD", "SAMP", "VAR"]);

// Embedded / non-text elements: their content is dropped from the payload entirely. When
// one splits a text run we emit a <wbr> in its place so the surrounding text stays as two
// nodes and the positional mapping keeps aligning.
const SEGMENT_SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "MATH",
    "IMG",
    "PICTURE",
    "INPUT",
    "SELECT",
    "OPTION",
    "TEXTAREA",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "CANVAS",
    "VIDEO",
    "AUDIO",
    "PRE",
]);

// Subtrees the apply must NOT collect text from — exactly the payload's opaque + skipped
// tags — so original and translated text-node counts line up.
const SEGMENT_UNMAPPED_TAGS = new Set([...SEGMENT_OPAQUE_TAGS, ...SEGMENT_SKIP_TAGS]);

function escapeSegmentHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Serialize a block to the compact segment payload: meaningful text + attribute-free inline
// tags, code-like spans kept opaque, embedded elements reduced to a <wbr> boundary, and all
// structural / unknown elements flattened to their text. Returns "" when there's no
// translatable text.
function serializeBlockSegment(block) {
    if (!block) return "";
    const buf = [];
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const raw = String(node.nodeValue || "");
            if (!raw) return;
            const collapsed = raw.replace(/\s+/g, " ");
            if (collapsed) buf.push(escapeSegmentHtml(collapsed));
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        // SVG/MathML foreign-content elements report a lowercase tagName — uppercase so the
        // (uppercase) tag sets match them too.
        const tag = String(node.tagName || "").toUpperCase();
        if (tag === "BR") {
            buf.push("<br>");
            return;
        }
        if (SEGMENT_SKIP_TAGS.has(tag)) {
            // Only emit a boundary when this element actually sits between two text runs.
            if (hasPayloadTextSibling(node, "previous") && hasPayloadTextSibling(node, "next")) {
                buf.push("<wbr>");
            }
            return;
        }
        if (SEGMENT_OPAQUE_TAGS.has(tag)) {
            const lower = tag.toLowerCase();
            const inner = String(node.textContent || "")
                .replace(/\s+/g, " ")
                .trim();
            buf.push(`<${lower}>${escapeSegmentHtml(inner)}</${lower}>`);
            return;
        }
        if (SEGMENT_INLINE_TAGS.has(tag)) {
            const lower = tag.toLowerCase();
            buf.push(`<${lower}>`);
            for (const child of node.childNodes) walk(child);
            buf.push(`</${lower}>`);
            return;
        }
        if (LEAF_BLOCK_TAGS.has(tag)) {
            // A NESTED leaf-block (only reachable when `block` is a parent leaf with its own
            // line plus a sub-list): it is a separate leaf with its own segment, so emit a
            // boundary if it splits two text runs and never its content. Mirrors how
            // collectMeaningfulTextNodes excludes it on apply, keeping node counts aligned.
            if (hasPayloadTextSibling(node, "previous") && hasPayloadTextSibling(node, "next")) {
                buf.push("<wbr>");
            }
            return;
        }
        // Structural / unknown element: drop the tag, keep its translatable text.
        for (const child of node.childNodes) walk(child);
    };
    for (const child of block.childNodes) walk(child);
    return buf.join("").replace(/\s+/g, " ").trim();
}

// Forgiving parser for a [[n]] / [[n:role]] segmented reply. Returns Map<number,string>
// of whatever segments were found — a dropped or malformed marker just means that one
// block stays in the source language; it never poisons the rest of the batch.
function parsePageSegmentMap(translatedText) {
    const map = new Map();
    const text = String(translatedText || "");
    if (!text) return map;
    const markerRe = /\[\[(\d+)(?::[a-z0-9-]+)?]]/gi;
    const matches = [];
    let m;
    while ((m = markerRe.exec(text)) !== null) {
        matches.push({ n: Number(m[1]), at: m.index, len: m[0].length });
    }
    for (let i = 0; i < matches.length; i += 1) {
        const { n, at, len } = matches[i];
        if (!Number.isFinite(n) || n < 1) continue;
        const start = at + len;
        const end = i + 1 < matches.length ? matches[i + 1].at : text.length;
        const content = text.slice(start, end).trim();
        if (content && !map.has(n)) map.set(n, content);
    }
    return map;
}

// Apply one translated segment (plain text + inline tags) onto a block by writing its
// text-node values. Structure/attributes are never touched, so the layout can't break.
function applyPageSegmentToBlock(block, translatedSegment) {
    if (!block || !block.isConnected || !translatedSegment) return false;
    const ownerDocument = block.ownerDocument;
    if (!ownerDocument) return false;
    const container = ownerDocument.createElement("div");
    try {
        container.innerHTML = String(translatedSegment);
    } catch {
        return false;
    }
    if (!sanitizeTranslatedHtmlContainer(container)) {
        // sanitize emptied it (only dangerous nodes) — nothing usable.
        if (!normalizeBlockText(container.textContent)) return false;
    }
    return applyTranslatedTextNodes(block, container);
}

// Apply a [[n]] reply (single request or a flat batch) onto an ordered list of blocks.
// `baseIndex` lets a batch address blocks by a global running index. `appliedSet`, when
// provided, records which global indices are done so streaming never re-applies one.
// Returns the number of segments applied this call.
function applyPageSegments(blocks, segmentMap, baseIndex = 0, appliedSet = null) {
    if (!blocks || !blocks.length || !segmentMap || !segmentMap.size) return 0;
    let applied = 0;
    for (let i = 0; i < blocks.length; i += 1) {
        const globalIndex = baseIndex + i + 1;
        if (appliedSet && appliedSet.has(globalIndex)) continue;
        const segment = segmentMap.get(globalIndex);
        if (segment == null) continue;
        // '=' keep-source sentinel (verified upstream): the block is already in the
        // target language — count it RESOLVED with no DOM write. Without the applied
        // count, an all-sentinel entry would report applied=0 and be released and
        // re-dispatched forever.
        if (String(segment).trim() === "=") {
            if (appliedSet) appliedSet.add(globalIndex);
            applied += 1;
            continue;
        }
        if (applyPageSegmentToBlock(blocks[i], segment)) {
            if (appliedSet) appliedSet.add(globalIndex);
            applied += 1;
        }
    }
    return applied;
}

// ARIA roles (DPUB-ARIA) that unambiguously mark non-article apparatus.
const BOILERPLATE_ROLE_VALUES = new Set([
    "doc-bibliography",
    "doc-biblioentry",
    "doc-endnotes",
    "doc-endnote",
    "doc-noteref",
    "doc-toc",
]);

// Generic id/class signatures of non-article "boilerplate" regions that bloat token usage on long
// reference/encyclopedia pages: citation & footnote lists, navigation boxes, category links, the
// table of contents, and inline edit links. Matched against a normalized id+class signature so it
// generalizes across sites (MediaWiki/Wikipedia, doc frameworks, blogs) with no host hardcoding.
const BOILERPLATE_SIGNATURE_RE =
    /(^|-)(references?|citations?|footnotes?|endnotes?|bibliography|reflist|navbox|nav-box|navigation-box|navbar|navfoot|catlinks?|category-links|categories|toc|table-of-contents|editsection|edit-section|sister-projects?|see-also-nav)($|-)/;

// Framework-specific signatures that are unambiguously non-article apparatus and never appear on
// prose (e.g. <span class="mw-editsection">, <table class="navbox">). These may match on ANY tag,
// unlike the generic tokens above which are container-gated to avoid prose false positives.
const BOILERPLATE_STRONG_SIGNATURE_RE =
    /(^|-)(mw-editsection|mw-references|mw-cite-backlink|reflist|navbox|catlinks|category-links)($|-)/;

// Only CONTAINER elements may be flagged by a class/id signature — never a prose leaf. This keeps
// an article paragraph like <p id="citations-in-ancient-rome"> or <h2 class="references-heading">
// from being skipped: real boilerplate lives in a wrapping <ol>/<table>/<div>/<nav>, and its prose
// children are caught via the ancestor walk in isBoilerplateRegion.
const BOILERPLATE_CONTAINER_TAGS = new Set([
    "OL",
    "UL",
    "DL",
    "TABLE",
    "THEAD",
    "TBODY",
    "TFOOT",
    "NAV",
    "ASIDE",
    "SECTION",
    "DIV",
    "FOOTER",
    "SUP",
]);

function regionSignature(element) {
    const className =
        typeof element.className === "string"
            ? element.className
            : (element.getAttribute && element.getAttribute("class")) || "";
    return [element.id || "", className || ""]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .replace(/[_\s]+/g, "-");
}

function elementMatchesBoilerplateSignature(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const role = element.getAttribute && element.getAttribute("role");
    if (role && BOILERPLATE_ROLE_VALUES.has(String(role).toLowerCase())) return true;
    const signature = regionSignature(element);
    if (!signature) return false;
    // Framework-specific classes are safe to match on any element.
    if (BOILERPLATE_STRONG_SIGNATURE_RE.test(signature)) return true;
    // Generic tokens (references/citations/toc/…) only count on a CONTAINER — a prose leaf that
    // merely mentions a keyword in its id/class (e.g. <p id="citations-in-ancient-rome">) must NOT
    // be treated as boilerplate.
    if (!BOILERPLATE_CONTAINER_TAGS.has(element.tagName)) return false;
    return BOILERPLATE_SIGNATURE_RE.test(signature);
}

// A leaf whose visible text is mostly hyperlink anchors AND that sits inside a table or navigation
// region is almost always a navigation / related-links cell, not prose — common in navboxes and
// "see also" link tables. We require SEVERAL links (≥3) so a short prose cell that happens to wrap
// one or two long links is not mistaken for a navigation cell.
function isDenseLinkNavLeaf(element) {
    if (!element || !element.querySelectorAll || !element.closest) return false;
    if (!element.closest("table,[role='navigation'],nav")) return false;
    const total = normalizeBlockText(element.textContent).length;
    if (total < 12) return false;
    const anchors = element.querySelectorAll("a");
    if (anchors.length < 3) return false;
    let linkChars = 0;
    anchors.forEach((anchor) => {
        linkChars += normalizeBlockText(anchor.textContent).length;
    });
    return linkChars / total > 0.65;
}

// True when `element` is, or lives inside, a non-article boilerplate region. Used only when the
// user opts into skipping boilerplate; default page translation still covers these regions.
function isBoilerplateRegion(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    for (let el = element; el && el !== document.documentElement; el = el.parentElement) {
        if (elementMatchesBoilerplateSignature(el)) return true;
    }
    return isDenseLinkNavLeaf(element);
}

function serializeTranslationLeaf(element, options = {}) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    let text = serializeBlockSegment(element);
    // Own-text (not full textContent): for a parent leaf the segment `text` covers only
    // its direct line, so plainText must match — its nested sub-list is a separate leaf.
    const plainText = normalizeBlockText(leafBlockOwnText(element));
    if (!text || !plainText) return null;
    // Single-text-node leaf: inline tags in the payload exist ONLY to split the reply
    // into positionally-mapped text nodes — with one node there is nothing to split.
    // Strip them (the live DOM keeps its real elements; apply writes the node's value).
    // Link-only rows, TOC entries and nav labels are the page's most numerous leaves,
    // and the tag pair is paid TWICE (input + the model's echo) — measured ~22% of a
    // wiki payload is inline tags, of which these contribute a meaningful slice.
    if (/[<>]/.test(text)) {
        const mappedNodes = collectMeaningfulTextNodes(element, {
            excludeNestedLeafBlocks: true,
        });
        if (mappedNodes.length === 1) {
            const collapsed = String(mappedNodes[0].nodeValue || "")
                .replace(/\s+/g, " ")
                .trim();
            if (collapsed) text = escapeSegmentHtml(collapsed);
        }
    }
    return {
        id: Number.isFinite(options.id) ? options.id : undefined,
        element,
        role: inferDomPageTextRole(element),
        text,
        sourceText: text,
        plainText,
    };
}

function getIrSegmentMarker(id, role, options = {}) {
    if (options.compactMarkers !== false) return `[[${id}]]`;
    return getSegmentMarker(id - 1, role);
}

function buildTranslationIrBatch(leaves, options = {}) {
    const startId = Number.isFinite(options.startId) ? options.startId : 1;
    const segments = [];
    for (const item of leaves || []) {
        const element = item?.element || item?.block || item;
        const id = startId + segments.length;
        const segment =
            item && item.text && item.element
                ? { ...item, id }
                : serializeTranslationLeaf(element, { id });
        if (!segment || !segment.text) continue;
        segments.push(segment);
    }
    const text = segments
        .map((segment) =>
            [getIrSegmentMarker(segment.id, segment.role, options), String(segment.text).trim()]
                .filter(Boolean)
                .join("\n")
        )
        .join("\n");
    return { segments, text, sourceText: text };
}

/**
 * Apply a translated HTML payload to an existing section (a contiguous run of
 * children under one parent). Parses + sanitizes the payload, restores critical
 * the translated text onto each original child's text nodes. The original
 * elements are NEVER swapped or restyled — only their text-node values change —
 * so the page layout cannot break no matter how the model reshaped its HTML.
 * Returns false (mutating nothing) when nothing could be applied.
 *
 * If `skipCount` is set, the first N children were already written by the stream
 * path; this function only writes the remaining tail (writes are idempotent, so a
 * re-write of an already-translated child is harmless either way).
 */
function applyHtmlPageSection(entry, translatedHtml, skipCount = 0) {
    if (!entry || !translatedHtml) return false;
    const trimmed = stripLeadingNonHtmlEcho(String(translatedHtml).trim());
    if (!trimmed) return false;

    const parent = entry.parent;
    if (!parent || !parent.isConnected) return false;
    const childrenStillInDom = entry.children.every(
        (c) => c && c.parentElement === parent && c.isConnected
    );
    if (!childrenStillInDom) return false;

    const tempContainer = parent.ownerDocument.createElement(parent.tagName);
    try {
        tempContainer.innerHTML = trimmed;
    } catch {
        return false;
    }
    if (!sanitizeTranslatedHtmlContainer(tempContainer)) return false;
    const translatedElementChildren = Array.from(tempContainer.children);
    if (!topLevelChildrenMatch(entry.children, translatedElementChildren)) return false;

    // Write translated text onto the original children's text nodes. We use the model's
    // parsed children purely as a source of translated strings — their structure is
    // discarded, the live DOM keeps its original elements/attributes/listeners.
    let wroteAny = skipCount > 0;
    const start = Math.max(0, skipCount);
    const count = Math.min(entry.children.length, translatedElementChildren.length);
    for (let i = start; i < count; i += 1) {
        const original = entry.children[i];
        const translated = translatedElementChildren[i];
        if (!original || !original.isConnected || !translated) continue;
        if (original.tagName !== translated.tagName) continue;
        if (applyTranslatedTextNodes(original, translated)) wroteAny = true;
    }
    return wroteAny;
}

function sanitizeHtmlElementAttributes(element) {
    if (!element || !element.attributes) return;
    const toRemove = [];
    for (const attr of Array.from(element.attributes)) {
        if (HTML_DANGEROUS_ATTR_PREFIX.test(attr.name)) {
            toRemove.push(attr.name);
            continue;
        }
        const lowered = String(attr.value || "")
            .trim()
            .toLowerCase();
        if (
            (attr.name === "href" || attr.name === "src" || attr.name === "xlink:href") &&
            (lowered.startsWith("javascript:") || lowered.startsWith("data:text/html"))
        ) {
            toRemove.push(attr.name);
        }
    }
    toRemove.forEach((name) => element.removeAttribute(name));
}

/**
 * For each element in the translated subtree, copy critical attributes (href,
 * src, alt, srcset, id, class, style, data-*) from the corresponding original
 * element. Matching is done by tag-position-among-siblings, which is robust to
 * the model adding wrapper tags or reordering inline elements within a single
 * sentence (a common case for natural-sounding translations).
 */
// Pure text-formatting inline tags the model may freely add/drop without changing
// layout. Every OTHER element (div, ul, li, a, button, svg, img, table, …) carries
// or anchors layout, so its count must be preserved for positional attribute
// restoration to land classes/styles on the right nodes.
// The attribute restore below walks both trees with querySelectorAll("*") (document
// preorder) and maps the i-th occurrence of each tag in the translated tree onto the
// i-th occurrence in the original. That mapping is only correct when the FULL preorder
// sequence of tag names is identical — every element, including <span>/<svg> that carry
// layout-critical classes (e.g. GitHub octicons). Counting tags is not enough: a model
// that keeps the counts but reorders/re-nests/adds-and-drops a pair of tags shifts the
// positional mapping by one and lands classes on the wrong nodes, collapsing the layout
// (happens even on larger models that "tidy" markup). So we require an exact signature
// match and otherwise reject — leaving the element untranslated rather than mangled.
function structuralTagSignature(root) {
    const tags = [];
    for (const el of root.querySelectorAll("*")) tags.push(el.tagName);
    return tags;
}

function structuralSignatureMatch(original, translated) {
    const a = structuralTagSignature(original);
    const b = structuralTagSignature(translated);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Restore class/style/id/aria/data/href/etc. from the original element onto the
 * translated tree, matched positionally by tag. Returns false (restoring nothing)
 * when the model reshaped the structure — positional restoration would then land
 * attributes on the wrong nodes and wreck the layout, so callers must leave the
 * original element untranslated instead. Returns true when restoration succeeded.
 */
function restoreHtmlCriticalAttributes(originalElement, translatedElement) {
    if (!originalElement || !translatedElement) return false;
    if (!structuralSignatureMatch(originalElement, translatedElement)) return false;
    const originalByTag = new Map();
    for (const el of originalElement.querySelectorAll("*")) {
        const tag = el.tagName;
        if (!originalByTag.has(tag)) originalByTag.set(tag, []);
        originalByTag.get(tag).push(el);
    }

    const usedIndices = new Map();
    for (const el of translatedElement.querySelectorAll("*")) {
        const tag = el.tagName;
        const candidates = originalByTag.get(tag);
        if (!candidates || !candidates.length) continue;
        const used = usedIndices.get(tag) || 0;
        const source = candidates[Math.min(used, candidates.length - 1)];
        usedIndices.set(tag, used + 1);
        if (!source) continue;
        copyPreservedAttributes(source, el);
    }
    return true;
}

function copyPreservedAttributes(source, target) {
    if (!source || !target) return;
    const universal = ["id", "class", "style", "dir", "lang", "role", "tabindex"];
    universal.forEach((name) => {
        if (source.hasAttribute(name)) target.setAttribute(name, source.getAttribute(name));
    });
    for (const attr of Array.from(source.attributes)) {
        if (/^data-/i.test(attr.name) || /^aria-/i.test(attr.name)) {
            target.setAttribute(attr.name, attr.value);
        }
    }
    const tagSpecific = HTML_PRESERVED_ATTRS_BY_TAG[source.tagName];
    if (tagSpecific) {
        tagSpecific.forEach((name) => {
            if (source.hasAttribute(name)) {
                target.setAttribute(name, source.getAttribute(name));
            }
        });
    }
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

const SEGMENT_ROLE_CODES = {
    caption: "c",
    date: "d",
    label: "l",
    "list-item": "i",
    navigation: "n",
    paragraph: "p",
    "table-header": "h",
    text: "x",
    title: "t",
};

function getSegmentMarker(index, role, options = {}) {
    if (options.compactMarkers) return `[[${index + 1}]]`;
    const normalizedRole = sanitizeSegmentRole(role);
    const roleCode = SEGMENT_ROLE_CODES[normalizedRole] || normalizedRole.slice(0, 3) || "x";
    return `[[${index + 1}:${roleCode}]]`;
}

function buildSegmentedTranslationText(items, options = {}) {
    return (items || [])
        .map((item, index) => {
            const text =
                item && typeof item === "object"
                    ? item.text || item.sourceText || ""
                    : String(item || "");
            const role = item && typeof item === "object" ? item.role : "text";
            return [getSegmentMarker(index, role, options), String(text || "").trim()].join("\n");
        })
        .join("\n");
}

function splitSegmentedTranslationText(translatedText, expectedCount) {
    const translated = String(translatedText || "").trim();
    if (!translated || expectedCount <= 0) return null;

    const markerPattern =
        /\[\[(\d+)(?::[a-z][a-z0-9-]*)?]]|<<<EDGE_TRANSLATE_SEGMENT_(\d+)(?:\s+role=[a-z-]+)?>>>|<<S_(\d+)>>/g;
    const matches = Array.from(translated.matchAll(markerPattern));
    if (matches.length !== expectedCount) return null;

    const parts = new Array(expectedCount);
    for (let i = 0; i < matches.length; i += 1) {
        const markerIndex = Number(matches[i][1] || matches[i][2] || matches[i][3]) - 1;
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
    applyHtmlPageSection,
    applyPageSegments,
    applyPageSegmentToBlock,
    buildContextTranslationGroups,
    buildSafeTranslatedHtml,
    buildSegmentedTranslationText,
    buildStrippedSectionHtml,
    buildTranslationIrBatch,
    captureLeafSegmentTexts,
    captureLeafTextsFromElement,
    collectHtmlPageSections,
    findLeafBlocksInElement,
    leafBlockOwnText,
    inferDomPageTextRole,
    isAlreadyInTargetLanguage,
    isBoilerplateRegion,
    parsePageSegmentMap,
    alignSentencesProportional,
    serializeBlockSegment,
    serializeTranslationLeaf,
    splitLeafByLineBreaks,
    splitTextIntoSentences,
    splitSegmentedTranslationText,
    splitTranslatedContext,
    stripPresentationAttrs,
    wrapLeafLineSegmentsInSpans,
    wrapLeafSentencesInSpans,
};
