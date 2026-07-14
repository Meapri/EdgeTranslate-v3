import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
    GeminiGenerateContentAdapter,
    OpenAIResponsesAdapter,
    effectiveUsageTotal,
    placeholderInventoryMatches,
} from "../../packages/translators/dist/translators.es.js";
import { measurePacket, packUnits } from "./protocols.mjs";

function sha256(value) {
    return createHash("sha256").update(String(value)).digest("hex");
}

function safeTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function adapterAndProfile(provider, model) {
    if (provider === "openai") {
        return {
            adapter: new OpenAIResponsesAdapter(),
            apiKeyName: "OPENAI_API_KEY",
            profile: {
                id: `bench-openai-${model}`,
                revision: `bench:${model}`,
                protocol: "openai-responses",
                modelId: model,
                apiKey: process.env.OPENAI_API_KEY || "",
                structuredOutput: "json-schema",
            },
        };
    }
    if (provider === "gemini") {
        return {
            adapter: new GeminiGenerateContentAdapter(),
            apiKeyName: "GEMINI_API_KEY",
            profile: {
                id: `bench-gemini-${model}`,
                revision: `bench:${model}`,
                protocol: "gemini-generate-content",
                modelId: model,
                apiKey: process.env.GEMINI_API_KEY || "",
                structuredOutput: "json-schema",
                reasoningControl: "thinking-config",
                reasoningValue: 0,
            },
        };
    }
    throw new Error(`Unknown provider: ${provider}; expected openai or gemini`);
}

function publicUsage(receipts) {
    return (receipts || []).map((receipt) => ({
        billingEventId: receipt.billingEventId,
        providerRequestId: receipt.providerRequestId,
        inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens,
        reasoningTokens: receipt.reasoningTokens,
        cachedInputTokens: receipt.cachedInputTokens,
        totalTokens: receipt.totalTokens,
        effectiveTotal: effectiveUsageTotal(receipt),
    }));
}

function receiptTotal(receipts) {
    return (receipts || []).reduce(
        (total, receipt) => total + Number(effectiveUsageTotal(receipt)?.value || 0),
        0
    );
}

// Structural validity for a single benchmark reply. Returns undefined when valid, or a short
// failure-reason string otherwise. Built on the surviving translators placeholder helper rather
// than the vNext runtime validator, which is DOM/extension-coupled and not importable from a
// plain node ESM script.
function validateBenchmarkItem(source, translatedText) {
    const translated = String(translatedText ?? "");
    if (!translated.trim()) return "empty";
    if (!placeholderInventoryMatches(source, translated)) return "placeholder-mismatch";
    return undefined;
}

function validateItems(packet, translated) {
    const sourceById = new Map(packet.map((item) => [item.id, item.text]));
    const records = (translated || []).map((item) => {
        const source = sourceById.get(item.id) || "";
        const reason = validateBenchmarkItem(source, item.translatedText);
        return {
            id: item.id,
            sourceHash: sha256(source),
            translationHash: sha256(item.translatedText),
            valid: reason === undefined,
            reason,
        };
    });
    const reasons = {};
    for (const item of records) {
        if (!item.valid) reasons[item.reason] = (reasons[item.reason] || 0) + 1;
    }
    return {
        mapped: records.length,
        valid: records.filter((item) => item.valid).length,
        invalid: records.filter((item) => !item.valid).length,
        reasons,
        items: records,
    };
}

async function appendAttempt(filename, record) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.appendFile(filename, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function runProviderBenchmark(options) {
    const {
        provider,
        model,
        fixture,
        protocol,
        maxEstimatedInputTokens,
        maxItems,
        maxOutputTokens,
        hardRunBudget,
        confirmProviderCost,
        dryRun,
        artifactPath,
    } = options;
    if (!["openai", "gemini"].includes(provider)) {
        throw new Error("--provider=openai or --provider=gemini is required in provider mode");
    }
    if (!model) throw new Error("--model=<provider-model-id> is required in provider mode");
    if (!fixture) throw new Error("Provider mode requires one concrete --fixture, not all");
    if (!protocol || protocol === "all") {
        throw new Error("Provider mode requires one concrete --protocol");
    }

    const packets = packUnits(fixture.units, protocol, {
        maxEstimatedInputTokens,
        maxItems,
    });
    const packetPlans = packets.map((packet, index) => {
        const measured = measurePacket(packet, protocol);
        return {
            index,
            itemCount: packet.length,
            estimatedInputTokens: measured.estimatedInputTokens,
            reservedOutputTokens: maxOutputTokens,
            conservativeReservation: measured.estimatedInputTokens + maxOutputTokens,
        };
    });
    const conservativeRunReservation = packetPlans.reduce(
        (total, packet) => total + packet.conservativeReservation,
        0
    );
    const preflight = {
        schemaVersion: "ai-page-bench-v2-provider-preflight-1",
        provider,
        model,
        fixtureId: fixture.id,
        languagePair: `${fixture.sourceLanguage}->${fixture.targetLanguage}`,
        protocol,
        packetCount: packets.length,
        unitCount: fixture.units.length,
        maxOutputTokensPerPacket: maxOutputTokens,
        hardRunBudget,
        conservativeRunReservation,
        packetPlans,
        warning:
            "Provider mode can incur API usage. It performs token-count probes when supported and exactly one generation attempt per planned packet; it never retries.",
    };
    if (dryRun) return { preflight, executed: false, reason: "dry-run" };
    if (!confirmProviderCost) {
        throw new Error(
            `${JSON.stringify(preflight)}\nRefusing provider calls without --confirm-provider-cost`
        );
    }
    if (conservativeRunReservation > hardRunBudget) {
        throw new Error(
            `Conservative reservation ${conservativeRunReservation} exceeds --hard-run-budget=${hardRunBudget}`
        );
    }

    const { adapter, profile, apiKeyName } = adapterAndProfile(provider, model);
    if (!profile.apiKey) throw new Error(`${apiKeyName} is required for provider mode`);
    const attemptsFile =
        artifactPath ||
        path.resolve(
            ".artifacts/ai-page-v2",
            `${safeTimestamp()}-${provider}-${fixture.id}-${protocol}.ndjson`
        );
    const capabilities = await adapter.discover(profile, new AbortController().signal);
    const attempts = [];
    let chargedTokens = 0;
    for (const [index, packet] of packets.entries()) {
        const request = {
            requestId: `bench-${fixture.id}-${protocol}-${index + 1}`,
            sessionId: `bench-${fixture.id}-${protocol}`,
            sourceLanguage: fixture.sourceLanguage,
            targetLanguage: fixture.targetLanguage,
            outputProtocol: protocol,
            maxOutputTokens,
            items: packet.map(({ id, text, role, context }) => ({ id, text, role, context })),
        };
        const fallbackInput = packetPlans[index].estimatedInputTokens;
        let countedInput = { tokens: fallbackInput, source: "client-estimated" };
        if (adapter.countInput) {
            countedInput = await adapter.countInput(profile, request, new AbortController().signal);
        }
        const reservation = countedInput.tokens + maxOutputTokens;
        if (chargedTokens + reservation > hardRunBudget) {
            throw new Error(
                `Packet ${
                    index + 1
                } cannot reserve ${reservation} tokens inside the remaining hard budget`
            );
        }
        await appendAttempt(attemptsFile, {
            schemaVersion: "ai-page-bench-v2-attempt-start-1",
            generatedAt: new Date().toISOString(),
            provider,
            model,
            fixtureId: fixture.id,
            protocol,
            packetIndex: index,
            requestId: request.requestId,
            itemIds: packet.map((item) => item.id),
            itemSourceHashes: packet.map((item) => sha256(item.text)),
            countedInput,
            reservedOutputTokens: maxOutputTokens,
        });
        const result = await adapter.executeOnce(profile, request, new AbortController().signal);
        const translations = result.ok ? result.items : result.partialItems;
        const validation = validateItems(packet, translations);
        const reported = receiptTotal(result.usageReceipts);
        const charged = reported > 0 ? reported : reservation;
        chargedTokens += charged;
        const record = {
            schemaVersion: "ai-page-bench-v2-attempt-1",
            generatedAt: new Date().toISOString(),
            provider,
            model,
            fixtureId: fixture.id,
            protocol,
            packetIndex: index,
            requestId: request.requestId,
            itemIds: packet.map((item) => item.id),
            itemSourceHashes: packet.map((item) => sha256(item.text)),
            countedInput,
            reservedOutputTokens: maxOutputTokens,
            ok: result.ok,
            failure: result.ok ? undefined : result.failure,
            attempt: result.attempt,
            usage: publicUsage(result.usageReceipts),
            chargedTokens: charged,
            validation,
        };
        await appendAttempt(attemptsFile, record);
        attempts.push(record);
    }
    return {
        schemaVersion: "ai-page-bench-v2-provider-summary-1",
        preflight,
        executed: true,
        generatedAt: new Date().toISOString(),
        attemptsFile,
        capabilities: {
            revision: capabilities.revision,
            protocol: capabilities.protocol,
            modelId: capabilities.modelId,
            structuredOutput: capabilities.structuredOutput,
            maxInputTokens: capabilities.maxInputTokens,
            maxOutputTokens: capabilities.maxOutputTokens,
            tokenCounting: capabilities.tokenCounting,
        },
        generationAttempts: attempts.length,
        chargedTokens,
        mappedItems: attempts.reduce((total, item) => total + item.validation.mapped, 0),
        validItems: attempts.reduce((total, item) => total + item.validation.valid, 0),
        invalidItems: attempts.reduce((total, item) => total + item.validation.invalid, 0),
        failures: attempts.filter((item) => !item.ok).map((item) => item.failure?.kind),
    };
}

export { runProviderBenchmark };
