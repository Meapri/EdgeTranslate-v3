import { Buffer } from "node:buffer";

function estimateTokens(text) {
    const value = String(text || "");
    const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
    return Math.ceil(cjk * 0.8 + Math.max(0, value.length - cjk) / 3.6);
}

const fixedArraySchema = {
    type: "object",
    additionalProperties: false,
    required: ["t"],
    properties: { t: { type: "array", items: { type: "string" } } },
};

const idObjectSchema = {
    type: "object",
    additionalProperties: false,
    required: ["x"],
    properties: {
        x: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["i", "t"],
                properties: { i: { type: "string" }, t: { type: "string" } },
            },
        },
    },
};

const PROTOCOLS = Object.freeze({
    "array-fixed": {
        request: (units) => JSON.stringify({ s: units.map(({ text }) => text) }),
        output: (units) => JSON.stringify({ t: units.map(({ text }) => text) }),
        schema: () => JSON.stringify(fixedArraySchema),
    },
    "array-exact": {
        request: (units) => JSON.stringify({ s: units.map(({ text }) => text) }),
        output: (units) => JSON.stringify({ t: units.map(({ text }) => text) }),
        schema: (units) =>
            JSON.stringify({
                ...fixedArraySchema,
                properties: {
                    t: {
                        type: "array",
                        minItems: units.length,
                        maxItems: units.length,
                        items: { type: "string" },
                    },
                },
            }),
    },
    "id-object": {
        request: (units) =>
            JSON.stringify({
                x: units.map(({ text }, index) => ({ i: index.toString(36), s: text })),
            }),
        output: (units) =>
            JSON.stringify({
                x: units.map(({ text }, index) => ({ i: index.toString(36), t: text })),
            }),
        schema: () => JSON.stringify(idObjectSchema),
    },
});

function measurePacket(units, protocolName) {
    const protocol = PROTOCOLS[protocolName];
    if (!protocol) throw new Error(`Unknown protocol: ${protocolName}`);
    const request = protocol.request(units);
    const output = protocol.output(units);
    const schema = protocol.schema(units);
    const source = units.map(({ text }) => text).join("");
    const sourceTokens = estimateTokens(source);
    const requestTokens = estimateTokens(request);
    const outputTokens = estimateTokens(output);
    const schemaTokens = estimateTokens(schema);
    return {
        unitCount: units.length,
        sourceChars: source.length,
        sourceTokens,
        requestChars: request.length,
        requestBytes: Buffer.byteLength(request),
        requestTokens,
        outputChars: output.length,
        outputBytes: Buffer.byteLength(output),
        outputTokens,
        schemaChars: schema.length,
        schemaTokens,
        estimatedInputTokens: requestTokens + schemaTokens,
        estimatedTotalTokens: requestTokens + schemaTokens + outputTokens,
        protocolOverheadTokens: requestTokens + schemaTokens + outputTokens - sourceTokens * 2,
    };
}

function packUnits(units, protocolName, options = {}) {
    const maxEstimatedInputTokens = Number(options.maxEstimatedInputTokens) || 1400;
    const maxItems = Number(options.maxItems) || 64;
    const packets = [];
    let current = [];
    for (const unit of units) {
        const candidate = current.concat(unit);
        const measured = measurePacket(candidate, protocolName);
        if (
            current.length &&
            (candidate.length > maxItems || measured.estimatedInputTokens > maxEstimatedInputTokens)
        ) {
            packets.push(current);
            current = [unit];
        } else {
            current = candidate;
        }
    }
    if (current.length) packets.push(current);
    return packets;
}

function benchmarkFixture(fixture, protocolName, options = {}) {
    const packets = packUnits(fixture.units, protocolName, options);
    const measurements = packets.map((packet) => measurePacket(packet, protocolName));
    const sum = (field) => measurements.reduce((total, item) => total + item[field], 0);
    return {
        fixtureId: fixture.id,
        family: fixture.family,
        languagePair: `${fixture.sourceLanguage}->${fixture.targetLanguage}`,
        protocol: protocolName,
        unitCount: fixture.units.length,
        packetCount: packets.length,
        estimated: true,
        sourceTokens: estimateTokens(fixture.units.map(({ text }) => text).join("")),
        estimatedInputTokens: sum("estimatedInputTokens"),
        estimatedOutputTokens: sum("outputTokens"),
        estimatedTotalTokens: sum("estimatedTotalTokens"),
        protocolOverheadTokens: sum("protocolOverheadTokens"),
        maxPacketEstimatedInputTokens: Math.max(
            ...measurements.map((item) => item.estimatedInputTokens)
        ),
        packets: measurements,
    };
}

export { PROTOCOLS, benchmarkFixture, estimateTokens, measurePacket, packUnits };
