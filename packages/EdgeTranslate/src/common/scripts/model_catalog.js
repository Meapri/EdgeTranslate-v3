/**
 * Live model catalog for the AI translation providers.
 *
 * Instead of shipping a hand-maintained model list, this module asks each
 * provider which models the user's own API key can actually reach, so brand-new
 * models show up in the options dropdowns without a new extension release. The
 * hand-maintained lists below remain as a *fallback seed* for when there is no
 * key, the request fails, or the user is offline.
 *
 * Fetched results are cached in chrome.storage.local per provider, keyed by a
 * hash of the API key so switching keys transparently refetches. The cache has
 * a TTL; callers can force a refresh (the options-page refresh button does).
 */

// Newest-first seed lists. Used verbatim when a live fetch is unavailable, and
// as the preferred ordering for models that also come back from the live fetch
// (so the dropdown opens onto sensible, curated choices).
export const GOOGLE_AI_STUDIO_FALLBACK_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-pro-latest",
    "gemma-4-31b-it",
    "gemma-4-26b-a4b-it",
];

export const OPENAI_FALLBACK_MODELS = [
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.5-2026-04-23",
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-mini",
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.4-nano",
    "gpt-5.4-nano-2026-03-17",
    "gpt-5.3-chat-latest",
    "gpt-5.2",
    "gpt-5.2-2025-12-11",
    "gpt-5.2-chat-latest",
    "gpt-5.1",
    "gpt-5.1-2025-11-13",
    "gpt-5.1-chat-latest",
    "gpt-5",
    "gpt-5-2025-08-07",
    "gpt-5-mini",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano",
    "gpt-5-nano-2025-08-07",
    "gpt-5-chat-latest",
    "gpt-4.1",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini",
    "gpt-4.1-mini-2025-04-14",
    "gpt-4.1-nano",
    "gpt-4.1-nano-2025-04-14",
    "gpt-4o",
    "gpt-4o-2024-11-20",
    "gpt-4o-2024-08-06",
    "gpt-4o-2024-05-13",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
    "gpt-4-turbo",
    "gpt-4-turbo-2024-04-09",
    "gpt-4",
    "gpt-4-0613",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-16k",
    "o1",
    "o1-2024-12-17",
    "o3",
    "o3-2025-04-16",
    "o3-mini",
    "o3-mini-2025-01-31",
    "o4-mini",
    "o4-mini-2025-04-16",
];

const PROVIDERS = {
    googleAiStudio: {
        fallback: GOOGLE_AI_STUDIO_FALLBACK_MODELS,
        fetch: fetchGoogleAiStudioModels,
    },
    openai: {
        fallback: OPENAI_FALLBACK_MODELS,
        fetch: fetchOpenAiModels,
    },
};

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const GOOGLE_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const CACHE_STORAGE_KEY = "AiModelCatalogCache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 15000;

/**
 * Resolve the list of models for a provider.
 *
 * @param {"googleAiStudio"|"openai"} provider
 * @param {string} apiKey user's API key for that provider ("" if unset)
 * @param {{ force?: boolean }} [options] force: bypass the cache and refetch
 * @returns {Promise<{ models: string[], capabilities: Object, source: "network"|"cache"|"fallback", error?: string }>}
 */
export async function getModelCatalog(provider, apiKey, { force = false } = {}) {
    const config = PROVIDERS[provider];
    if (!config) {
        return {
            models: [],
            capabilities: {},
            source: "fallback",
            error: `Unknown provider: ${provider}`,
        };
    }

    const key = (apiKey || "").trim();
    // Without a key we can't ask the provider anything — hand back the seed list.
    if (!key) {
        return {
            models: [...config.fallback],
            capabilities: fallbackCapabilities(config.fallback),
            source: "fallback",
        };
    }

    const keyHash = hashKey(key);

    if (!force) {
        const cached = await readCache(provider, keyHash);
        if (cached) {
            return {
                models: mergeWithFallback(cached.models, config.fallback),
                capabilities: catalogCapabilities(cached, config.fallback),
                source: "cache",
            };
        }
    }

    try {
        const fetched = normalizeCatalogRecord(await config.fetch(key));
        const merged = mergeWithFallback(fetched.models, config.fallback);
        // Persist the raw fetched records (not the merged view) so a future seed-list
        // change still re-merges cleanly.
        await writeCache(provider, keyHash, fetched);
        return {
            models: merged,
            capabilities: catalogCapabilities(fetched, config.fallback),
            source: "network",
        };
    } catch (error) {
        return {
            models: [...config.fallback],
            capabilities: fallbackCapabilities(config.fallback),
            source: "fallback",
            error: error?.message || String(error),
        };
    }
}

/**
 * OpenAI: GET /v1/models with a Bearer key. Returns every model id the key can
 * see (the user opted into the full list); ordering/curation happens in the merge.
 */
async function fetchOpenAiModels(apiKey) {
    const response = await fetchWithTimeout(OPENAI_MODELS_ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
        throw new Error(`OpenAI /models returned ${response.status}`);
    }
    const body = await response.json();
    const models = dedupe(
        (body?.data || []).map((entry) => (entry?.id || "").trim()).filter(Boolean)
    );
    return {
        models,
        capabilities: Object.fromEntries(
            models.map((model) => [
                model,
                {
                    pageTranslationStatus: "unknown",
                    source: "provider-list",
                    evidence:
                        "OpenAI /v1/models does not advertise structured-output or token limits",
                },
            ])
        ),
    };
}

/**
 * Google AI Studio: GET /v1beta/models. The key is sent via the x-goog-api-key
 * header (never in the URL) and results are paginated via nextPageToken.
 */
async function fetchGoogleAiStudioModels(apiKey) {
    const ids = [];
    const capabilities = {};
    let pageToken = "";
    // Bound the loop defensively in case a provider bug never clears the token.
    for (let page = 0; page < 20; page++) {
        const url = new URL(GOOGLE_MODELS_ENDPOINT);
        url.searchParams.set("pageSize", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetchWithTimeout(url.toString(), {
            headers: { "x-goog-api-key": apiKey },
        });
        if (!response.ok) {
            throw new Error(`Google /models returned ${response.status}`);
        }
        const body = await response.json();
        for (const entry of body?.models || []) {
            const name = (entry?.name || "").replace(/^models\//, "").trim();
            const methods = Array.isArray(entry?.supportedGenerationMethods)
                ? entry.supportedGenerationMethods
                : [];
            // The provider catalog is authoritative here. Embedding/image-only models must
            // never appear as page-translation choices merely because they are listable.
            if (!name || !methods.includes("generateContent")) continue;
            ids.push(name);
            capabilities[name] = {
                pageTranslationStatus: "supported",
                source: "provider-metadata",
                generationMethod: "generateContent",
                inputTokenLimit: positiveNumberOrNull(entry?.inputTokenLimit),
                outputTokenLimit: positiveNumberOrNull(entry?.outputTokenLimit),
            };
        }
        pageToken = body?.nextPageToken || "";
        if (!pageToken) break;
    }
    return { models: dedupe(ids), capabilities };
}

/**
 * Order the live list so the dropdown opens onto curated, known-good models
 * (seed order, newest-first) and any newly-released models the seed list hasn't
 * caught up to appear right after — still selectable without an extension update.
 */
function mergeWithFallback(fetched, fallback) {
    const fetchedSet = new Set(fetched);
    const known = fallback.filter((model) => fetchedSet.has(model));
    const knownSet = new Set(known);
    const fresh = fetched
        .filter((model) => !knownSet.has(model))
        .sort((a, b) => b.localeCompare(a));
    return dedupe([...known, ...fresh]);
}

async function readCache(provider, keyHash) {
    const store = await storageGet(CACHE_STORAGE_KEY);
    const entry = store?.[CACHE_STORAGE_KEY]?.[provider];
    if (!entry || entry.keyHash !== keyHash || (!entry.catalog && !Array.isArray(entry.models))) {
        return null;
    }
    if (typeof entry.ts !== "number" || Date.now() - entry.ts > CACHE_TTL_MS) {
        return null;
    }
    return normalizeCatalogRecord(entry.catalog || entry.models);
}

async function writeCache(provider, keyHash, catalog) {
    const store = await storageGet(CACHE_STORAGE_KEY);
    const cache = { ...(store?.[CACHE_STORAGE_KEY] || {}) };
    cache[provider] = { keyHash, catalog, ts: Date.now() };
    await storageSet({ [CACHE_STORAGE_KEY]: cache });
}

/* ---- small helpers ---- */

function dedupe(list) {
    return Array.from(new Set(list));
}

function positiveNumberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeCatalogRecord(value) {
    if (Array.isArray(value)) return { models: dedupe(value), capabilities: {} };
    return {
        models: dedupe(Array.isArray(value?.models) ? value.models : []),
        capabilities:
            value?.capabilities && typeof value.capabilities === "object" ? value.capabilities : {},
    };
}

function fallbackCapabilities(models) {
    return Object.fromEntries(
        models.map((model) => [
            model,
            {
                pageTranslationStatus: "unverified",
                source: "fallback-seed",
            },
        ])
    );
}

function catalogCapabilities(catalog, fallback) {
    const result = fallbackCapabilities(fallback);
    for (const model of catalog.models || []) {
        result[model] = catalog.capabilities?.[model] || {
            pageTranslationStatus: "unknown",
            source: "provider-list",
        };
    }
    return result;
}

// Non-cryptographic FNV-1a; only used to detect "did the API key change".
function hashKey(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash =
            (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16);
}

async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function storageGet(key) {
    return new Promise((resolve) => {
        chrome.storage.local.get(key, (result) => resolve(result || {}));
    });
}

function storageSet(items) {
    return new Promise((resolve) => {
        chrome.storage.local.set(items, () => resolve());
    });
}
