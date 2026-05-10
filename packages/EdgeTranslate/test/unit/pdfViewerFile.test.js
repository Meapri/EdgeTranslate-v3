import {
    decodePdfViewerUrlParam,
    isPdfFileDragData,
    setPdfViewerSearchParam,
    shouldBlockPdfDropHijack,
    shouldPreloadPdfAsBlob,
} from "../../web/edge-viewer-file.js";

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

    it("stores blob viewer file params without double encoding them", () => {
        const params = new URLSearchParams();
        const blobUrl = "blob:chrome-extension://extension-id/072b058b-bff6-47c8-9613-f8b5a5632fec";

        setPdfViewerSearchParam(params, "file", blobUrl);

        expect(params.toString()).toContain("file=blob%3Achrome-extension");
        expect(new URLSearchParams(params.toString()).get("file")).toBe(blobUrl);
    });

    it("repairs previously double-encoded blob viewer file params", () => {
        const encodedOnce = encodeURIComponent(
            "blob:chrome-extension://extension-id/072b058b-bff6-47c8-9613-f8b5a5632fec"
        );
        const encodedTwice = encodeURIComponent(encodedOnce);

        expect(decodePdfViewerUrlParam(encodedOnce)).toBe(
            "blob:chrome-extension://extension-id/072b058b-bff6-47c8-9613-f8b5a5632fec"
        );
        expect(decodePdfViewerUrlParam(encodedTwice)).toBe(
            "blob:chrome-extension://extension-id/072b058b-bff6-47c8-9613-f8b5a5632fec"
        );
    });

    it("allows external PDF file drops so PDF.js can open dragged documents", () => {
        const dataTransfer = {
            types: ["Files"],
            items: [{ kind: "file", type: "application/pdf" }],
        };
        const target = { closest: jest.fn(() => null) };

        expect(isPdfFileDragData(dataTransfer)).toBe(true);
        expect(shouldBlockPdfDropHijack({ dataTransfer, target })).toBe(false);
    });

    it("detects PDFs by file name when the MIME type is missing", () => {
        const dataTransfer = {
            types: ["Files"],
            files: [{ name: "scan.PDF", type: "" }],
        };

        expect(isPdfFileDragData(dataTransfer)).toBe(true);
    });

    it("does not block non-PDF file drops", () => {
        const dataTransfer = {
            types: ["Files"],
            items: [{ kind: "file", type: "image/png" }],
            files: [{ name: "diagram.png", type: "image/png" }],
        };
        const target = { closest: jest.fn(() => null) };

        expect(isPdfFileDragData(dataTransfer)).toBe(false);
        expect(shouldBlockPdfDropHijack({ dataTransfer, target })).toBe(false);
    });

    it("does not intercept PDF.js internal drags that do not carry external files", () => {
        const dataTransfer = {
            types: ["text/plain"],
            items: [{ kind: "string", type: "text/plain" }],
        };
        const target = { closest: jest.fn(() => null) };

        expect(shouldBlockPdfDropHijack({ dataTransfer, target })).toBe(false);
    });
});
