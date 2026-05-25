import {
    bindPdfPageTranslateButton,
    buildNativePdfUrl,
    getOriginalPdfUrl,
    PDF_PAGE_TRANSLATE_EVENT,
    requestPdfPageTranslation,
} from "../../web/edge-viewer-controls.js";

describe("edge PDF viewer controls", () => {
    it("reads the original PDF from source before file query param", () => {
        const location = {
            href: "chrome-extension://id/web/viewer.html?file=https%3A%2F%2Fexample.com%2Fproxied.pdf&source=https%3A%2F%2Fexample.com%2Foriginal.pdf",
        };

        expect(getOriginalPdfUrl(location)).toBe("https://example.com/original.pdf");
    });

    it("adds a native-viewer bypass marker without changing the PDF path", () => {
        expect(buildNativePdfUrl("https://example.com/file.pdf")).toBe(
            "https://example.com/file.pdf#edge_translate_pdf_native=1"
        );
        expect(buildNativePdfUrl("file:///Users/me/file.pdf")).toBe(
            "file:///Users/me/file.pdf#edge_translate_pdf_native=1"
        );
    });

    it("dispatches a PDF page translation event from the toolbar button", () => {
        document.body.innerHTML = `
            <button id="edgeTranslatePdfPageTranslateButton" type="button"></button>
        `;

        const seen = [];
        window.addEventListener(PDF_PAGE_TRANSLATE_EVENT, (event) => {
            seen.push(event.detail.source);
        });

        expect(bindPdfPageTranslateButton(document, window)).toBe(true);
        document.getElementById("edgeTranslatePdfPageTranslateButton").click();

        expect(seen).toEqual(["pdf-viewer-toolbar"]);
    });

    it("reports whether a PDF page translation request was dispatched", () => {
        const seen = [];
        window.addEventListener(PDF_PAGE_TRANSLATE_EVENT, () => seen.push("seen"));

        expect(requestPdfPageTranslation({ windowRef: window })).toBe(true);
        expect(seen).toEqual(["seen"]);
    });
});
