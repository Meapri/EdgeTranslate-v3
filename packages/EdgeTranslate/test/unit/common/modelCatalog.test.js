import { getModelCatalog } from "../../../src/common/scripts/model_catalog.js";

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

describe("live AI model catalog capabilities", () => {
    let store;

    beforeEach(() => {
        store = {};
        chrome.storage.local.get.mockImplementation((key, callback) => {
            callback({ [key]: store[key] });
        });
        chrome.storage.local.set.mockImplementation((items, callback) => {
            Object.assign(store, items);
            callback?.();
        });
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    it("keeps only Gemini models whose provider metadata supports generateContent", async () => {
        global.fetch.mockResolvedValue(
            response({
                models: [
                    {
                        name: "models/gemini-new-flash",
                        supportedGenerationMethods: ["generateContent", "countTokens"],
                        inputTokenLimit: 1000000,
                        outputTokenLimit: 8192,
                    },
                    {
                        name: "models/text-embedding-only",
                        supportedGenerationMethods: ["embedContent"],
                    },
                ],
            })
        );

        const result = await getModelCatalog("googleAiStudio", "secret", { force: true });

        expect(result.models).toContain("gemini-new-flash");
        expect(result.models).not.toContain("text-embedding-only");
        expect(result.capabilities["gemini-new-flash"]).toMatchObject({
            pageTranslationStatus: "supported",
            source: "provider-metadata",
            inputTokenLimit: 1000000,
            outputTokenLimit: 8192,
        });
        expect(global.fetch.mock.calls[0][1].headers).toEqual({
            "x-goog-api-key": "secret",
        });
    });

    it("marks OpenAI list results unknown instead of inventing model capabilities", async () => {
        global.fetch.mockResolvedValue(
            response({ data: [{ id: "brand-new-model" }, { id: "text-embedding-model" }] })
        );

        const result = await getModelCatalog("openai", "secret", { force: true });

        expect(result.models).toContain("brand-new-model");
        expect(result.capabilities["brand-new-model"]).toMatchObject({
            pageTranslationStatus: "unknown",
            source: "provider-list",
        });
        expect(result.capabilities["brand-new-model"].evidence).toMatch(/does not advertise/);
    });

    it("labels seed-only models unverified when no API key is available", async () => {
        const result = await getModelCatalog("openai", "");

        expect(result.source).toBe("fallback");
        expect(result.capabilities[result.models[0]]).toMatchObject({
            pageTranslationStatus: "unverified",
            source: "fallback-seed",
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
