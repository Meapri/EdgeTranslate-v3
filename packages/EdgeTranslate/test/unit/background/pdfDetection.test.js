import {
    extendConfig,
    hasPdfViewerBypass,
    shouldHandlePdfNavigationUrl,
} from "../../../src/background/library/pdfDetection.js";

describe("pdfDetection redirect guards", () => {
    it("keeps auto-hijacking local file PDFs so the extension PDF viewer can translate them", () => {
        const config = extendConfig();

        expect(shouldHandlePdfNavigationUrl("file:///Users/me/sample.pdf", config)).toBe(true);
    });

    it("skips URLs explicitly marked to bypass the EdgeTranslate PDF viewer", () => {
        const config = extendConfig();
        const url = "https://example.com/file.pdf#edge_translate_pdf_native=1";

        expect(hasPdfViewerBypass(url, config)).toBe(true);
        expect(shouldHandlePdfNavigationUrl(url, config)).toBe(false);
    });

    it("still handles regular web PDFs", () => {
        const config = extendConfig();

        expect(shouldHandlePdfNavigationUrl("https://example.com/file.pdf", config)).toBe(true);
    });
});
