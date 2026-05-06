import { shouldPreloadPdfAsBlob } from "../../web/edge-viewer-file.js";

describe("edge PDF viewer file loading", () => {
    it("preloads local file PDFs as blob before PDF.js validates viewer/file origins", () => {
        expect(
            shouldPreloadPdfAsBlob({
                rawUrl: "file:///Users/me/file.pdf",
                viewerOrigin: "chrome-extension://extension-id",
            })
        ).toBe(true);
    });

    it("preloads http PDFs from other origins as blob", () => {
        expect(
            shouldPreloadPdfAsBlob({
                rawUrl: "https://example.com/file.pdf",
                viewerOrigin: "chrome-extension://extension-id",
            })
        ).toBe(true);
    });

    it("does not preload blob URLs again", () => {
        expect(
            shouldPreloadPdfAsBlob({
                rawUrl: "blob:chrome-extension://extension-id/abc",
                viewerOrigin: "chrome-extension://extension-id",
            })
        ).toBe(false);
    });
});
