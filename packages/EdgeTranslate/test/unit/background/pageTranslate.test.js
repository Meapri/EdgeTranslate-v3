import { translatePage, executeGoogleScript } from "../../../src/background/library/pageTranslate.js";

describe("pageTranslate module", () => {
    it("exports page translation entry points", () => {
        expect(typeof translatePage).toBe("function");
        expect(typeof executeGoogleScript).toBe("function");
    });
});
