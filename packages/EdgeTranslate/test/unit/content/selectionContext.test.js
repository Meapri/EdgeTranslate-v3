import {
    extractSelectionContext,
    buildSurroundingWindow,
    MAX_SURROUNDING_CHARS,
} from "../../../src/content/select/selectionContext.js";

function selectTextIn(node, start = 0, end = null) {
    const range = document.createRange();
    const textNode = node.firstChild;
    range.setStart(textNode, start);
    range.setEnd(textNode, end == null ? textNode.nodeValue.length : end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
}

describe("selection context capture (LLM-only)", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        document.title = "Test Page Title";
        window.getSelection().removeAllRanges();
    });

    it("captures the enclosing block window, page title, and domain", () => {
        document.body.innerHTML = `<p id="p">The fishermen spent the afternoon by the river bank with their rods and nets.</p>`;
        const p = document.getElementById("p");
        // Select "bank" (offset of the word inside the text node).
        const text = p.firstChild.nodeValue;
        const at = text.indexOf("bank");
        const selection = selectTextIn(p, at, at + 4);

        const context = extractSelectionContext(selection);
        expect(context).not.toBeNull();
        expect(context.surrounding).toContain("river bank with their rods");
        expect(context.title).toBe("Test Page Title");
        expect(typeof context.domain).toBe("string");
    });

    it("windows a very long paragraph around the selection without leaking neighbors", () => {
        // Redteam case: ~700 words; selection in the middle; surrounding must be a bounded
        // window from THIS block only, snapped to word boundaries.
        const words = [];
        for (let i = 0; i < 700; i += 1) words.push(`word${i}`);
        words[350] = "NEEDLE";
        document.body.innerHTML = `<div><p id="prev">Previous paragraph text.</p><p id="p">${words.join(
            " "
        )}</p><p id="next">Next paragraph text.</p></div>`;
        const p = document.getElementById("p");
        const text = p.firstChild.nodeValue;
        const at = text.indexOf("NEEDLE");
        const selection = selectTextIn(p, at, at + "NEEDLE".length);

        const context = extractSelectionContext(selection);
        expect(context.surrounding).toContain("NEEDLE");
        expect(context.surrounding.length).toBeLessThanOrEqual(MAX_SURROUNDING_CHARS + 1);
        // Window comes only from the enclosing <p>, never the sibling paragraphs.
        expect(context.surrounding).not.toContain("Previous paragraph");
        expect(context.surrounding).not.toContain("Next paragraph");
        // Word-boundary snapping: no mid-word fragments at the sliced edges.
        const first = context.surrounding.split(" ")[0];
        const last = context.surrounding.split(" ").pop();
        expect(text).toContain(` ${first} `);
        expect(text).toContain(` ${last}`);
    });

    it("bails out in the PDF viewer, in form fields, and for very long selections", () => {
        document.body.innerHTML = `<p id="p">Short prose paragraph for selection.</p>`;
        const p = document.getElementById("p");
        const selection = selectTextIn(p);
        expect(extractSelectionContext(selection, { isPdfViewer: true })).toBeNull();

        document.body.innerHTML = `<div contenteditable="true"><p id="e">Editable text content here.</p></div>`;
        const e = document.getElementById("e");
        expect(extractSelectionContext(selectTextIn(e))).toBeNull();

        const long = "long ".repeat(150).trim();
        document.body.innerHTML = `<p id="l">${long}</p>`;
        expect(extractSelectionContext(selectTextIn(document.getElementById("l")))).toBeNull();
    });

    it("omits surrounding when the block adds nothing beyond the selection itself", () => {
        document.body.innerHTML = `<p id="p">Tiny.</p>`;
        const selection = selectTextIn(document.getElementById("p"));
        const context = extractSelectionContext(selection);
        // Title/domain may still be present, but no surrounding echo of the selection.
        if (context) expect(context.surrounding).toBe("");
    });

    it("buildSurroundingWindow returns short blocks whole and windows long ones", () => {
        expect(buildSurroundingWindow("short text", "short")).toBe("short text");
        const long = `${"alpha ".repeat(40)}TARGET ${"omega ".repeat(40)}`.trim();
        const window_ = buildSurroundingWindow(long, "TARGET");
        expect(window_).toContain("TARGET");
        expect(window_.length).toBeLessThanOrEqual(MAX_SURROUNDING_CHARS + 1);
    });
});
