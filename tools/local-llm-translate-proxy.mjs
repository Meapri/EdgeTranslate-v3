#!/usr/bin/env node
/**
 * Local LLM translation proxy for EdgeTranslate LocalTranslate endpoint mode.
 *
 * Exposes:
 *   POST /translate
 *   GET  /health
 *
 * It adapts EdgeTranslate's simple translation endpoint contract to an
 * OpenAI-compatible /v1/chat/completions backend such as llama-server.
 * No secrets or private endpoints are hardcoded; configure with env vars.
 */

import http from "node:http";
import crypto from "node:crypto";

const PORT = parseInt(process.env.PORT || process.env.EDGE_TRANSLATE_PROXY_PORT || "8091", 10);
const HOST = process.env.HOST || process.env.EDGE_TRANSLATE_PROXY_HOST || "127.0.0.1";
const OPENAI_BASE_URL = stripTrailingSlash(
    process.env.OPENAI_BASE_URL || process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8090"
);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.LLAMA_SERVER_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || process.env.LLAMA_MODEL || "local-translate";
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "120000", 10);
const MAX_INPUT_CHARS = parseInt(process.env.MAX_INPUT_CHARS || "12000", 10);
const CHUNK_CHARS = parseInt(process.env.CHUNK_CHARS || "1400", 10);
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.MAX_CONCURRENCY || "1", 10));
const TEMPERATURE = Number(process.env.TEMPERATURE || "0.1");
const TOP_P = Number(process.env.TOP_P || "0.9");
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "600000", 10);
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || "500", 10);
const ENABLE_CHUNKING = (process.env.ENABLE_CHUNKING || "true") !== "false";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const cache = new Map();
const queue = [];
let active = 0;

const LANGUAGE_ALIASES = new Map(
    Object.entries({
        auto: "the source language",
        en: "English",
        english: "English",
        ko: "Korean",
        korean: "Korean",
        ja: "Japanese",
        japanese: "Japanese",
        zh: "Chinese",
        chinese: "Chinese",
        "zh-cn": "Simplified Chinese",
        "zh-tw": "Traditional Chinese",
        fr: "French",
        de: "German",
        es: "Spanish",
        ru: "Russian",
        vi: "Vietnamese",
        th: "Thai",
        id: "Indonesian",
    })
);

function stripTrailingSlash(value) {
    return String(value || "").replace(/\/+$/, "");
}

function normalizeLanguage(value, fallback = "the target language") {
    const raw = String(value || "").trim();
    if (!raw) return fallback;
    const key = raw.toLowerCase().replace(/_/g, "-");
    return LANGUAGE_ALIASES.get(key) || raw;
}

function jsonResponse(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Access-Control-Allow-Origin": ALLOW_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key",
    });
    res.end(payload);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            data += chunk;
            if (data.length > MAX_INPUT_CHARS + 4096) {
                reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
                req.destroy();
            }
        });
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (error) {
                reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400, cause: error }));
            }
        });
        req.on("error", reject);
    });
}

function cacheKey(payload) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
}

function getCached(key) {
    const found = cache.get(key);
    if (!found) return null;
    if (Date.now() > found.expiresAt) {
        cache.delete(key);
        return null;
    }
    // refresh LRU order
    cache.delete(key);
    cache.set(key, found);
    return found.value;
}

function setCached(key, value) {
    if (CACHE_TTL_MS <= 0 || CACHE_MAX_ENTRIES <= 0) return;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    while (cache.size > CACHE_MAX_ENTRIES) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
}

function enqueue(task) {
    return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drainQueue();
    });
}

function drainQueue() {
    while (active < MAX_CONCURRENCY && queue.length > 0) {
        const item = queue.shift();
        active += 1;
        Promise.resolve()
            .then(item.task)
            .then(item.resolve, item.reject)
            .finally(() => {
                active -= 1;
                drainQueue();
            });
    }
}

function splitForTranslation(text) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!ENABLE_CHUNKING || normalized.length <= CHUNK_CHARS) return [normalized];

    const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let current = "";

    const pushCurrent = () => {
        if (current.trim()) chunks.push(current.trim());
        current = "";
    };

    for (const paragraph of paragraphs.length ? paragraphs : [normalized]) {
        const parts = paragraph.length > CHUNK_CHARS
            ? paragraph.split(/(?<=[.!?。！？])\s+/).filter(Boolean)
            : [paragraph];
        for (const part of parts) {
            if (!current) {
                current = part;
            } else if (current.length + part.length + 2 <= CHUNK_CHARS) {
                current += "\n\n" + part;
            } else {
                pushCurrent();
                current = part;
            }

            while (current.length > CHUNK_CHARS) {
                chunks.push(current.slice(0, CHUNK_CHARS).trim());
                current = current.slice(CHUNK_CHARS).trim();
            }
        }
    }
    pushCurrent();
    return chunks.length ? chunks : [normalized];
}

function estimateMaxTokens(text, targetLanguage) {
    const chars = String(text || "").length;
    const expansion = /korean|japanese|chinese/i.test(targetLanguage) ? 1.8 : 1.5;
    return Math.min(2048, Math.max(128, Math.ceil((chars / 2.2) * expansion) + 64));
}

function buildMessages(text, sourceLanguage, targetLanguage) {
    const source = normalizeLanguage(sourceLanguage, "the source language");
    const target = normalizeLanguage(targetLanguage, "the target language");
    return [
        {
            role: "system",
            content:
                `You are a professional translation engine. Translate from ${source} to ${target}. ` +
                "Preserve paragraph breaks and meaning. Do not summarize. Do not explain. Output only the translation.",
        },
        {
            role: "user",
            content: String(text || ""),
        },
    ];
}

function extractOpenAIText(data) {
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    return (
        message.content ||
        message.reasoning_content ||
        choice?.text ||
        data?.translated_text ||
        data?.translatedText ||
        data?.translation ||
        ""
    ).trim();
}

async function callOpenAICompatible(text, sourceLanguage, targetLanguage) {
    const target = normalizeLanguage(targetLanguage, "the target language");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const headers = { "Content-Type": "application/json" };
        if (OPENAI_API_KEY) headers.Authorization = `Bearer ${OPENAI_API_KEY}`;
        const response = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: MODEL,
                messages: buildMessages(text, sourceLanguage, targetLanguage),
                temperature: TEMPERATURE,
                top_p: TOP_P,
                max_tokens: estimateMaxTokens(text, target),
                stream: false,
            }),
            signal: controller.signal,
        });
        const responseText = await response.text();
        let data = null;
        try {
            data = responseText ? JSON.parse(responseText) : null;
        } catch {
            // keep raw text in error below
        }
        if (!response.ok) {
            const message = data?.error?.message || responseText || `OpenAI-compatible backend returned ${response.status}`;
            throw Object.assign(new Error(message), { statusCode: 502 });
        }
        const translated = extractOpenAIText(data);
        if (!translated) throw Object.assign(new Error("Backend returned an empty translation"), { statusCode: 502 });
        return translated;
    } finally {
        clearTimeout(timeout);
    }
}

async function translate(payload) {
    const text = String(payload.text || payload.q || "").trim();
    if (!text) throw Object.assign(new Error("Missing text"), { statusCode: 400 });
    if (text.length > MAX_INPUT_CHARS) {
        throw Object.assign(new Error(`Text too long; max ${MAX_INPUT_CHARS} characters`), { statusCode: 413 });
    }

    const sourceLanguage = payload.source_language || payload.sourceLanguage || payload.from || payload.sl || "auto";
    const targetLanguage = payload.target_language || payload.targetLanguage || payload.to || payload.tl || "ko";
    const key = cacheKey({ text, sourceLanguage, targetLanguage, model: MODEL, base: OPENAI_BASE_URL });
    const cached = getCached(key);
    if (cached) return { ...cached, cached: true };

    const chunks = splitForTranslation(text);
    const startedAt = Date.now();
    const translatedChunks = [];
    for (const chunk of chunks) {
        translatedChunks.push(await callOpenAICompatible(chunk, sourceLanguage, targetLanguage));
    }
    const translatedText = translatedChunks.join("\n\n").trim();
    const result = {
        success: true,
        translated_text: translatedText,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        model: MODEL,
        chunks: chunks.length,
        elapsed_ms: Date.now() - startedAt,
    };
    setCached(key, result);
    return result;
}

const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
        return jsonResponse(res, 204, {});
    }
    if (req.method === "GET" && req.url === "/health") {
        return jsonResponse(res, 200, {
            ok: true,
            backend: OPENAI_BASE_URL,
            model: MODEL,
            queue: queue.length,
            active,
            chunk_chars: CHUNK_CHARS,
            max_concurrency: MAX_CONCURRENCY,
        });
    }
    if (req.method !== "POST" || req.url !== "/translate") {
        return jsonResponse(res, 404, { success: false, error: "Not found" });
    }

    try {
        const payload = await readJsonBody(req);
        const result = await enqueue(() => translate(payload));
        return jsonResponse(res, 200, result);
    } catch (error) {
        const statusCode = error.statusCode || (error.name === "AbortError" ? 504 : 500);
        return jsonResponse(res, statusCode, {
            success: false,
            error: error.name === "AbortError" ? "Translation backend timed out" : error.message || String(error),
        });
    }
});

server.listen(PORT, HOST, () => {
    console.log(
        `EdgeTranslate local LLM proxy listening on http://${HOST}:${PORT}/translate -> ${OPENAI_BASE_URL}/v1/chat/completions`
    );
});
