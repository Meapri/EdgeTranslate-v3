import { UsageField, UsageReceipt, UsageSource } from "./types";

function field(value: unknown, source: UsageSource = "provider-reported"): UsageField | undefined {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? { value: number, source } : undefined;
}

type ReceiptContext = {
    requestId: string;
    attemptId: string;
    providerRequestId?: string;
    coverage?: UsageReceipt["coverage"];
};

function receiptId(context: ReceiptContext) {
    return context.providerRequestId
        ? `${context.providerRequestId}:${context.attemptId}`
        : `${context.requestId}:${context.attemptId}`;
}

export function normalizeOpenAIResponsesUsage(
    usage: Record<string, any> | undefined,
    context: ReceiptContext
): UsageReceipt | undefined {
    if (!usage) return undefined;
    return {
        billingEventId: receiptId(context),
        requestId: context.requestId,
        attemptId: context.attemptId,
        providerRequestId: context.providerRequestId,
        coverage: context.coverage || "complete",
        inputTokens: field(usage.input_tokens),
        outputTokens: field(usage.output_tokens),
        reasoningTokens: field(usage.output_tokens_details?.reasoning_tokens),
        cachedInputTokens: field(usage.input_tokens_details?.cached_tokens),
        cacheWriteTokens: field(usage.input_tokens_details?.cache_write_tokens),
        totalTokens: field(usage.total_tokens),
        reasoningRelation: "subset-of-output",
    };
}

export function normalizeOpenAIChatUsage(
    usage: Record<string, any> | undefined,
    context: ReceiptContext
): UsageReceipt | undefined {
    if (!usage) return undefined;
    return {
        billingEventId: receiptId(context),
        requestId: context.requestId,
        attemptId: context.attemptId,
        providerRequestId: context.providerRequestId,
        coverage: context.coverage || "complete",
        inputTokens: field(usage.prompt_tokens),
        outputTokens: field(usage.completion_tokens),
        reasoningTokens: field(usage.completion_tokens_details?.reasoning_tokens),
        cachedInputTokens: field(usage.prompt_tokens_details?.cached_tokens),
        totalTokens: field(usage.total_tokens),
        reasoningRelation: "subset-of-output",
    };
}

export function normalizeGeminiUsage(
    usage: Record<string, any> | undefined,
    context: ReceiptContext
): UsageReceipt | undefined {
    if (!usage) return undefined;
    return {
        billingEventId: receiptId(context),
        requestId: context.requestId,
        attemptId: context.attemptId,
        providerRequestId: context.providerRequestId,
        coverage: context.coverage || "complete",
        inputTokens: field(usage.promptTokenCount),
        outputTokens: field(usage.candidatesTokenCount),
        reasoningTokens: field(usage.thoughtsTokenCount),
        cachedInputTokens: field(usage.cachedContentTokenCount),
        totalTokens: field(usage.totalTokenCount),
        reasoningRelation: "additional-to-output",
    };
}

export function effectiveUsageTotal(receipt: UsageReceipt): UsageField | undefined {
    if (receipt.totalTokens) return receipt.totalTokens;
    if (!receipt.inputTokens || !receipt.outputTokens) return undefined;
    let value = receipt.inputTokens.value + receipt.outputTokens.value;
    let source: UsageSource =
        receipt.inputTokens.source === "client-estimated" ||
        receipt.outputTokens.source === "client-estimated"
            ? "client-estimated"
            : receipt.inputTokens.source === "provider-counted" ||
              receipt.outputTokens.source === "provider-counted"
            ? "provider-counted"
            : "provider-reported";
    if (receipt.reasoningRelation === "additional-to-output") {
        if (!receipt.reasoningTokens) return undefined;
        value += receipt.reasoningTokens.value;
        if (receipt.reasoningTokens.source === "client-estimated") source = "client-estimated";
    } else if (receipt.reasoningRelation === "unknown") {
        return undefined;
    }
    return { value, source };
}

export function dedupeUsageReceipts(receipts: UsageReceipt[]) {
    const seen = new Set<string>();
    return receipts.filter((receipt) => {
        if (seen.has(receipt.billingEventId)) return false;
        seen.add(receipt.billingEventId);
        return true;
    });
}
