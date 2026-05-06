import {
    buildNativePdfUrl,
    getOriginalPdfUrl,
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
});
