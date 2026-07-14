import http, { IncomingMessage, ServerResponse } from "node:http";
import {
    GeminiGenerateContentAdapter,
    OpenAIChatCompatibleAdapter,
    OpenAIResponsesAdapter,
    ProviderProfile,
    TranslationBatchRequest,
} from "../src/page_translation_v2";

type CapturedRequest = {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, any>;
};

const captured: CapturedRequest[] = [];
let server: http.Server;
let baseUrl = "";

function json(response: ServerResponse, payload: Record<string, unknown>, status = 200) {
    response.writeHead(status, {
        "content-type": "application/json",
        "x-request-id": `stub-${captured.length}`,
    });
    response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
}

async function handler(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    captured.push({
        method: request.method || "GET",
        url: request.url || "",
        headers: request.headers,
        body,
    });
    const url = request.url || "";
    if (url === "/openai/v1/responses/input_tokens") {
        json(response, { input_tokens: 73 });
        return;
    }
    if (url === "/openai/v1/responses") {
        json(response, {
            id: "response-http-1",
            status: "completed",
            output_text: JSON.stringify({
                x: [
                    { i: "0", t: "안녕하세요" },
                    { i: "1", t: "변경 사항 저장" },
                ],
            }),
            usage: {
                input_tokens: 73,
                output_tokens: 18,
                total_tokens: 91,
            },
        });
        return;
    }
    if (url === "/gemini/v1beta/models/gemini-http") {
        json(response, {
            name: "models/gemini-http",
            version: "http-v1",
            inputTokenLimit: 32768,
            outputTokenLimit: 4096,
            supportedGenerationMethods: ["generateContent", "countTokens"],
        });
        return;
    }
    if (url === "/gemini/v1beta/models/gemini-http:countTokens") {
        json(response, { totalTokens: 65 });
        return;
    }
    if (url === "/gemini/v1beta/models/gemini-http:generateContent") {
        json(response, {
            responseId: "gemini-http-1",
            candidates: [
                {
                    finishReason: "STOP",
                    content: {
                        parts: [
                            {
                                text: JSON.stringify({
                                    x: [
                                        { i: "0", t: "안녕하세요" },
                                        { i: "1", t: "변경 사항 저장" },
                                    ],
                                }),
                            },
                        ],
                    },
                },
            ],
            usageMetadata: {
                promptTokenCount: 65,
                candidatesTokenCount: 17,
                thoughtsTokenCount: 0,
                totalTokenCount: 82,
            },
        });
        return;
    }
    if (url === "/chat/v1/chat/completions") {
        json(response, {
            id: "chat-http-1",
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            x: [
                                { i: "0", t: "안녕하세요" },
                                { i: "1", t: "변경 사항 저장" },
                            ],
                        }),
                    },
                },
            ],
            usage: { prompt_tokens: 60, completion_tokens: 16, total_tokens: 76 },
        });
        return;
    }
    json(response, { error: { message: `Unexpected path ${url}` } }, 404);
}

function request(name: string): TranslationBatchRequest {
    return {
        requestId: `http-${name}`,
        sessionId: "http-session",
        sourceLanguage: "en",
        targetLanguage: "ko",
        ctx: { title: "HTTP fixture", domain: "example.test" },
        maxOutputTokens: 256,
        items: [
            { id: "a", text: "Hello" },
            { id: "b", text: "Save changes", role: "h" },
        ],
    };
}

function profile(overrides: Partial<ProviderProfile>): ProviderProfile {
    return {
        id: "http-profile",
        revision: "http-revision",
        protocol: "openai-responses",
        modelId: "http-model",
        apiKey: "http-secret",
        ...overrides,
    };
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        handler(request, response).catch((error) => json(response, { error: String(error) }, 500));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    );
});

beforeEach(() => captured.splice(0));

describe("page translation V2 real HTTP adapter boundary", () => {
    test("OpenAI Responses count and generation use the exact endpoints and one generation", async () => {
        const adapter = new OpenAIResponsesAdapter();
        const provider = profile({ baseUrl: `${baseUrl}/openai/v1` });
        const input = request("openai");

        const count = await adapter.countInput(provider, input, new AbortController().signal);
        const result = await adapter.executeOnce(provider, input, new AbortController().signal);

        expect(count).toEqual({ tokens: 73, source: "provider-counted" });
        expect(result.ok).toBe(true);
        expect(captured.map(({ url }) => url)).toEqual([
            "/openai/v1/responses/input_tokens",
            "/openai/v1/responses",
        ]);
        expect(captured.filter(({ url }) => url.endsWith("/responses"))).toHaveLength(1);
        expect(captured[0].body.max_output_tokens).toBeUndefined();
        expect(captured[1].body.max_output_tokens).toBe(256);
        expect(captured[1].headers.authorization).toBe("Bearer http-secret");
        expect(captured[1].body.text.format).toMatchObject({
            type: "json_schema",
            strict: true,
        });
        const payload = JSON.parse(captured[1].body.input);
        expect(Object.keys(payload)).toEqual(["v", "sl", "tl", "ctx", "x"]);
        expect(payload.v).toBe("pt3");
    });

    test("Gemini discovers limits, counts input and performs one schema-bound generation", async () => {
        const adapter = new GeminiGenerateContentAdapter();
        const provider = profile({
            protocol: "gemini-generate-content",
            modelId: "gemini-http",
            baseUrl: `${baseUrl}/gemini/v1beta`,
        });
        const input = request("gemini");

        const capabilities = await adapter.discover(provider, new AbortController().signal);
        const count = await adapter.countInput(provider, input, new AbortController().signal);
        const result = await adapter.executeOnce(provider, input, new AbortController().signal);

        expect(capabilities.maxInputTokens).toMatchObject({
            value: 32768,
            source: "provider-metadata",
        });
        expect(capabilities.maxOutputTokens.value).toBe(4096);
        expect(count.tokens).toBe(65);
        expect(result.ok).toBe(true);
        expect(captured.map(({ url }) => url)).toEqual([
            "/gemini/v1beta/models/gemini-http",
            "/gemini/v1beta/models/gemini-http:countTokens",
            "/gemini/v1beta/models/gemini-http:generateContent",
        ]);
        expect(captured[2].headers["x-goog-api-key"]).toBe("http-secret");
        expect(captured[2].body.generationConfig.responseJsonSchema).toMatchObject({
            type: "object",
        });
    });

    test("OpenAI-compatible sends the suppression trio and floored ceiling over HTTP", async () => {
        const adapter = new OpenAIChatCompatibleAdapter();
        const provider = profile({
            protocol: "openai-chat",
            baseUrl: `${baseUrl}/chat/v1`,
            apiKey: "",
            structuredOutput: "prompt-json",
            outputLimitField: "max_tokens",
        });

        const result = await adapter.executeOnce(
            provider,
            request("chat"),
            new AbortController().signal
        );

        expect(result.ok).toBe(true);
        expect(captured).toHaveLength(1);
        expect(captured[0].url).toBe("/chat/v1/chat/completions");
        expect(captured[0].body.max_tokens).toBe(1024);
        expect(captured[0].body.response_format).toBeUndefined();
        expect(captured[0].body.cache_prompt).toBe(true);
        expect(captured[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
        expect(captured[0].body.reasoning_effort).toBe("low");
    });
});
