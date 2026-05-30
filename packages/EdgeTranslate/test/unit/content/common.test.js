import { isNativePdfDocument } from "../../../src/content/common.js";

describe("isNativePdfDocument", () => {
    afterEach(() => {
        // Remove the own-property shadow so the jsdom default contentType getter is restored.
        delete document.contentType;
    });

    it("is false for an ordinary HTML document", () => {
        expect(isNativePdfDocument()).toBe(false);
    });

    it("is true when the document is the browser's native PDF viewer (application/pdf)", () => {
        Object.defineProperty(document, "contentType", {
            value: "application/pdf",
            configurable: true,
        });
        expect(isNativePdfDocument()).toBe(true);
    });
});
