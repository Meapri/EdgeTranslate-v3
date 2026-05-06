const fs = require("fs");
const path = require("path");

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../", relativePath), "utf8"));
}

describe("Chrome Web Store manifest permissions", () => {
    it("does not request unused Chrome permissions in source manifests", () => {
        const baseManifest = readJson("src/manifest.json");
        const chromePatch = readJson("src/manifest_chrome.json");
        const permissions = new Set([
            ...(baseManifest.permissions || []),
            ...(chromePatch.permissions || []),
        ]);

        expect(permissions.has("cookies")).toBe(false);
        expect(permissions.has("notifications")).toBe(false);
        expect(permissions.has("declarativeNetRequest")).toBe(false);
        expect(baseManifest.declarative_net_request).toBeUndefined();
        expect(chromePatch.declarative_net_request).toBeUndefined();
    });
});
