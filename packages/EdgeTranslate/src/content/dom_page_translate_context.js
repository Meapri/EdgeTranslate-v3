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

function elementHasMeaningfulText(element, minLength = 2) {
    if (!element) return false;
    const text = normalizeBlockText(element.textContent);
    return text.length >= minLength;
}

function elementHasNestedTranslatableBlock(element) {
    if (!element || !element.querySelector) return false;
    for (const tag of HTML_BLOCK_LEAF_TAGS) {
        if (element.querySelector(tag)) return true;
    }
    return false;
}

/**
 * Walk the DOM under `roots` and collect leaf-level translatable blocks. Each
 * returned descriptor is an HTML entry: the block element, its role marker,
 * the trimmed plain text (for cache keys + suspicious-translation detection),
 * and the innerHTML that will be sent to the model.
 */
function collectHtmlPageBlocks(roots, options = {}) {
    const seen = new WeakSet();
    const skipExisting = options.skipExisting instanceof WeakSet ? options.skipExisting : null;
    const blocks = [];
    const sources = Array.isArray(roots) ? roots : [roots];
    const selector = Array.from(HTML_BLOCK_LEAF_TAGS).join(",").toLowerCase();

    for (const root of sources) {
        if (!root || !root.querySelectorAll) continue;
        if (root.tagName && HTML_BLOCK_LEAF_TAGS.has(root.tagName) && !seen.has(root)) {
            considerHtmlBlock(root, blocks, seen, skipExisting);
        }
        root.querySelectorAll(selector).forEach((el) => {
            if (!seen.has(el)) considerHtmlBlock(el, blocks, seen, skipExisting);
        });
    }
    return blocks;
}

function considerHtmlBlock(element, out, seen, skipExisting) {
    if (!element || !element.isConnected || seen.has(element)) return;
    seen.add(element);
    if (isExcludedHtmlSubtree(element)) return;
    if (skipExisting && skipExisting.has(element)) return;
    if (elementHasNestedTranslatableBlock(element)) return;
    if (!elementHasMeaningfulText(element)) return;

    const role = inferDomPageTextRole(element);
    const plainText = normalizeBlockText(element.textContent);
    out.push({
        element,
        role,
        plainText,
        innerHtml: element.innerHTML,
    });
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
 * Returns the leaf-level block-text elements inside `element` in document order.
 * A "leaf" is a block element that contains no nested LEAF_BLOCK_TAGS — exactly
 * the granularity we want for per-paragraph hover/original-text mapping.
 *
 * If `element` itself is a leaf block (no block-level descendants), returns
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
    for (const node of descendants) {
        if (!LEAF_BLOCK_TAGS.has(node.tagName)) continue;
        // Skip nodes that themselves contain a leaf-block descendant — only the
        // innermost leaf earns a tooltip mapping.
        if (node.querySelector(LEAF_BLOCK_TAG_SELECTOR)) continue;
        if (!String(node.textContent || "").trim()) continue;
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
        const brSegments = splitLeafByLineBreaks(leaf);
        if (brSegments.length >= 2) {
            out.push({ segmentTexts: brSegments.map((seg) => seg.text) });
        } else {
            const text = String(leaf.textContent || "")
                .replace(/\s+/g, " ")
                .trim();
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

/**
 * Merge consecutive sections that share the same parent and whose combined
 * plainText fits under `mergeUntilChars`. Pages with lots of label-sized
 * sections (nav, settings, small cards) end up as one combined LLM request
 * instead of 10-20 round-trips.
 */
function coalesceTinySections(sections, options = {}) {
    if (!sections || sections.length < 2) return sections || [];
    const mergeUntilChars = options.mergeUntilChars || 1800;
    const tinyThreshold = options.tinyThreshold || 400;
    const out = [];
    let buffer = null;
    let bufferChars = 0;
    const flush = () => {
        if (!buffer) return;
        out.push(buffer);
        buffer = null;
        bufferChars = 0;
    };
    for (const section of sections) {
        if (!section) continue;
        const sectionChars = String(section.plainText || "").length;
        const canMerge =
            buffer &&
            buffer.parent === section.parent &&
            bufferChars + sectionChars <= mergeUntilChars;
        if (canMerge) {
            buffer = {
                parent: buffer.parent,
                children: [...buffer.children, ...section.children],
                plainText: [buffer.plainText, section.plainText].filter(Boolean).join(" "),
                role: buffer.role || section.role,
            };
            bufferChars += sectionChars;
            continue;
        }
        if (sectionChars <= tinyThreshold) {
            flush();
            buffer = { ...section, children: section.children.slice() };
            bufferChars = sectionChars;
        } else {
            flush();
            out.push(section);
        }
    }
    flush();
    return out;
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
function collectMeaningfulTextNodes(element) {
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
                if (SEGMENT_UNMAPPED_TAGS.has(String(p.tagName || "").toUpperCase())) {
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
    const originals = collectMeaningfulTextNodes(originalElement);
    if (!originals.length) return false;
    const translations = collectMeaningfulTextNodes(translatedElement);
    if (!translations.length) return false;

    if (originals.length === translations.length) {
        // Exact structural match: map text node 1:1 so inline emphasis + links keep their
        // translated text in place (the common, ideal case).
        let wrote = false;
        for (let i = 0; i < originals.length; i += 1) {
            const value = normalizeBlockText(translations[i].nodeValue);
            if (!value) continue;
            originals[i].nodeValue = preserveTextNodeBoundaryWhitespace(originals[i], value);
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
        if (applyPageSegmentToBlock(blocks[i], segment)) {
            if (appliedSet) appliedSet.add(globalIndex);
            applied += 1;
        }
    }
    return applied;
}

function isHiddenTranslationLeaf(element) {
    if (!element || !element.closest) return false;
    return Boolean(element.closest("[hidden],[aria-hidden='true']"));
}

function isChromeTranslationLeaf(element) {
    if (!element || !element.closest) return false;
    if (element.closest("script,style,noscript,template,svg,math,code,pre,kbd,samp")) {
        return true;
    }
    if (element.closest("input,textarea,select,option,button,[role='button']")) return true;
    if (element.closest("footer,[role='banner'],[role='contentinfo'],[role='search']")) {
        return true;
    }
    const nav = element.closest("nav,[role='navigation']");
    if (nav && !nav.closest("main,article,[role='main'],[role='article']")) return true;
    return false;
}

function isWidgetTranslationLeaf(element) {
    let current = element;
    while (current && current !== document.documentElement) {
        const className =
            typeof current.className === "string"
                ? current.className
                : current.getAttribute && current.getAttribute("class");
        const signature = [
            current.id || "",
            className || "",
            current.getAttribute && current.getAttribute("role"),
            current.getAttribute && current.getAttribute("aria-label"),
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .replace(/[_\s]+/g, "-");
        if (
            /(^|-)newsletter($|-)/.test(signature) ||
            /(^|-)login($|-)/.test(signature) ||
            /(^|-)follow($|-)/.test(signature) ||
            /(^|-)(popup|modal)($|-)/.test(signature) ||
            /(^|-)(sponsor|sponsored|promo|promotion)($|-)/.test(signature)
        ) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
}

function isAdChromeTranslationText(text) {
    const value = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!value) return false;
    if (/^(?:ad|ads|advertisement|sponsored)$/i.test(value)) return true;
    if (/\bremove\s+ads?\b/i.test(value)) return true;
    if (/\b(?:googletag|adsbygoogle|doubleclick|googleadservices|adservice)\b/i.test(value)) {
        return true;
    }
    return false;
}

function isLowValueTranslationText(text) {
    const value = String(text || "").trim();
    if (!value) return true;
    if (isAdChromeTranslationText(value)) return true;
    if (!/\p{L}/u.test(value)) return true;
    if (!/\s/.test(value)) {
        if (/^(?:https?:\/\/|www\.|mailto:)/i.test(value)) return true;
        if (/^[\w.-]+\.[a-z0-9]{1,8}$/i.test(value) && /[._-]/.test(value)) return true;
        if (/^[0-9a-f]{7,40}$/i.test(value)) return true;
        if (/^@?[\w-]+(?:\/[\w.-]+)+$/.test(value)) return true;
        if (/^v?\d+(?:\.\d+){1,}(?:[-+][\w.]+)?$/i.test(value)) return true;
    }
    return false;
}

function isTranslationLeafEligible(element, options = {}) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || !element.isConnected) return false;
    if (isExcludedHtmlSubtree(element)) return false;
    if (isHiddenTranslationLeaf(element)) return false;
    if (isChromeTranslationLeaf(element)) return false;
    if (isWidgetTranslationLeaf(element)) return false;
    if (elementHasNestedTranslatableBlock(element)) return false;
    const plainText = normalizeBlockText(element.textContent);
    if (plainText.length < (options.minTextLength || 2)) return false;
    if (isLowValueTranslationText(plainText)) return false;
    if (options.targetLanguage && isAlreadyInTargetLanguage(plainText, options.targetLanguage)) {
        return false;
    }
    if (options.skipExisting instanceof WeakSet && options.skipExisting.has(element)) return false;
    if (typeof options.isEligibleElement === "function" && !options.isEligibleElement(element)) {
        return false;
    }
    return true;
}

function serializeTranslationLeaf(element, options = {}) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const text = serializeBlockSegment(element);
    const plainText = normalizeBlockText(element.textContent);
    if (!text || !plainText) return null;
    return {
        id: Number.isFinite(options.id) ? options.id : undefined,
        element,
        role: inferDomPageTextRole(element),
        text,
        sourceText: text,
        plainText,
    };
}

function collectTranslationLeaves(roots, options = {}) {
    const leaves = [];
    const seen = new WeakSet();
    const sources = Array.isArray(roots) ? roots : [roots];
    const selector = Array.from(HTML_BLOCK_LEAF_TAGS).join(",").toLowerCase();
    const consider = (element) => {
        if (!element || seen.has(element)) return;
        seen.add(element);
        if (!isTranslationLeafEligible(element, options)) return;
        const serialized = serializeTranslationLeaf(element);
        if (serialized) leaves.push(serialized);
    };

    for (const root of sources) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) continue;
        if (HTML_BLOCK_LEAF_TAGS.has(root.tagName)) consider(root);
        if (!root.querySelectorAll) continue;
        root.querySelectorAll(selector).forEach(consider);
    }
    return leaves;
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

function normalizeExpectedIrIds(expectedIds) {
    if (Array.isArray(expectedIds)) {
        return expectedIds
            .map((item) => (typeof item === "object" ? item.id : item))
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0);
    }
    const count = Number(expectedIds || 0);
    if (!Number.isFinite(count) || count <= 0) return [];
    return Array.from({ length: count }, (_, index) => index + 1);
}

function parseTranslationIrReply(translatedText, expectedIds = [], options = {}) {
    const expected = normalizeExpectedIrIds(expectedIds);
    const expectedSet = new Set(expected);
    const allowUnknown = options.allowUnknown === true || expected.length === 0;
    const text = String(translatedText || "");
    const markerRe = /\[\[(\d+)(?::[a-z][a-z0-9-]*)?]]/gi;
    const matches = [];
    let match;
    while ((match = markerRe.exec(text)) !== null) {
        matches.push({ id: Number(match[1]), at: match.index, length: match[0].length });
    }

    const segments = new Map();
    const duplicateIds = [];
    const unknownIds = [];
    for (let i = 0; i < matches.length; i += 1) {
        const { id, at, length } = matches[i];
        if (!Number.isFinite(id) || id < 1) continue;
        const start = at + length;
        const end = i + 1 < matches.length ? matches[i + 1].at : text.length;
        const content = text.slice(start, end).trim();
        if (!content) continue;
        if (!allowUnknown && !expectedSet.has(id)) {
            if (!unknownIds.includes(id)) unknownIds.push(id);
            continue;
        }
        if (segments.has(id)) {
            if (!duplicateIds.includes(id)) duplicateIds.push(id);
            continue;
        }
        segments.set(id, content);
    }

    const missingIds = expected.filter((id) => !segments.has(id));
    return {
        segments,
        missingIds,
        duplicateIds,
        unknownIds,
        complete: missingIds.length === 0,
    };
}

function applyTranslationIrSegment(segment, translatedText, options = {}) {
    const element = segment?.element || segment?.block || segment?.leaf || null;
    if (!element || !translatedText) return false;
    return applyPageSegmentToBlock(element, translatedText, options);
}

function findRemainingSourceLeaves(roots, options = {}) {
    return collectTranslationLeaves(roots, {
        ...options,
        targetLanguage: options.targetLanguage || options.tl || "",
    });
}

/**
 * Streaming partial-section apply. Each time the SSE buffer grows, scan for the
 * latest closing tag matching one of the section's expected top-level child tags
 * and treat everything up to that point as "completed children". For each newly
 * completed child we write the translated text onto the original child's text
 * nodes (structure untouched) so the reader sees translations popcorn into place.
 *
 * Returns the new applied-count so the caller can persist it across stream
 * chunks. The function never re-applies an index it has already touched.
 */
function applyStreamedSectionChildren(entry, accumulatedHtml, alreadyAppliedCount = 0) {
    if (!entry || !entry.section || !accumulatedHtml) return alreadyAppliedCount;
    const { parent, children } = entry.section;
    if (!parent || !parent.isConnected) return alreadyAppliedCount;
    if (alreadyAppliedCount >= children.length) return alreadyAppliedCount;

    const expectedTags = Array.from(new Set(children.map((c) => c && c.tagName).filter(Boolean)));
    if (!expectedTags.length) return alreadyAppliedCount;

    // Find the furthest closing tag that matches a known top-level child tag —
    // everything up to that point is structurally safe to parse.
    let lastSafeEnd = -1;
    for (const tag of expectedTags) {
        const re = new RegExp(`</${tag}\\s*>`, "gi");
        let match;
        while ((match = re.exec(accumulatedHtml)) !== null) {
            const end = match.index + match[0].length;
            if (end > lastSafeEnd) lastSafeEnd = end;
        }
    }
    if (lastSafeEnd <= 0) return alreadyAppliedCount;

    const safeSlice = accumulatedHtml.slice(0, lastSafeEnd);
    const ownerDocument = parent.ownerDocument;
    const tempContainer = ownerDocument.createElement(parent.tagName);
    try {
        tempContainer.innerHTML = safeSlice;
    } catch {
        return alreadyAppliedCount;
    }

    const translatedChildren = Array.from(tempContainer.children);
    if (translatedChildren.length <= alreadyAppliedCount) return alreadyAppliedCount;

    if (!sanitizeTranslatedHtmlContainer(tempContainer)) return alreadyAppliedCount;

    const refreshedChildren = Array.from(tempContainer.children);
    const targetCount = Math.min(refreshedChildren.length, children.length);

    let applied = alreadyAppliedCount;
    for (let i = alreadyAppliedCount; i < targetCount; i += 1) {
        const original = children[i];
        if (!original || !original.parentElement) continue;
        const translated = refreshedChildren[i];
        if (!translated) continue;
        if (original.tagName !== translated.tagName) return applied;

        // Write the translated text onto the ORIGINAL child's text nodes. We never
        // swap the element in, so its structure/attributes/listeners are untouched and
        // the layout can't break. If the text-node counts diverge (model reshaped its
        // markup), stop here and leave this + later children untranslated for now —
        // the final full-section apply will retry the tail once the whole response is in.
        if (!applyTranslatedTextNodes(original, translated)) return applied;
        applied = i + 1;
    }
    return applied;
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
    applyStreamedSectionChildren,
    buildContextTranslationGroups,
    buildSafeTranslatedHtml,
    buildSegmentedTranslationText,
    buildStrippedSectionHtml,
    buildTranslationIrBatch,
    captureLeafSegmentTexts,
    captureLeafTextsFromElement,
    coalesceTinySections,
    collectHtmlPageBlocks,
    collectHtmlPageSections,
    collectTranslationLeaves,
    findRemainingSourceLeaves,
    findLeafBlocksInElement,
    inferDomPageTextRole,
    isAlreadyInTargetLanguage,
    applyTranslationIrSegment,
    parsePageSegmentMap,
    parseTranslationIrReply,
    serializeBlockSegment,
    serializeTranslationLeaf,
    splitLeafByLineBreaks,
    splitSegmentedTranslationText,
    splitTranslatedContext,
    stripPresentationAttrs,
    wrapLeafLineSegmentsInSpans,
};
