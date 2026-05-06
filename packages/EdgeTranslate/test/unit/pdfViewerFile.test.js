import { shouldPreloadPdfAsBlob } from "../../web/edge-viewer-file.js";

describe("edge PDF viewer file loading", () => {
    it("does not preload local file PDFs as blob so PDF.js can load them with file-url permission", () => {
        expect(
            shouldPreloadPdfAsBlob({
                rawUrl: "file:///Users/me/file.pdf",
                viewerOrigin: "chrome-extension://extension-id",
            })
        ).toBe(false);
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
