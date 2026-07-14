#!/usr/bin/env node

import { FIXTURES } from "./fixtures.mjs";
import { PROTOCOLS, benchmarkFixture } from "./protocols.mjs";

function readArg(name, fallback) {
    const prefix = `--${name}=`;
    const found = process.argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}

function readPositiveNumber(name, fallback) {
    const value = Number(readArg(name, fallback));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const mode = readArg("mode", "offline");
const fixtureArg = readArg("fixture", "all");
const protocolArg = readArg("protocol", "all");
const maxEstimatedInputTokens = readPositiveNumber("max-input-tokens", 1400);
const maxItems = readPositiveNumber("max-items", 64);
const maxOutputTokens = readPositiveNumber("max-output-tokens", 2048);
const hardRunBudget = readPositiveNumber("hard-run-budget", 24000);
const jsonOnly = process.argv.includes("--json");
const dryRun = process.argv.includes("--dry-run");
const confirmProviderCost = process.argv.includes("--confirm-provider-cost");
const provider = readArg("provider", "");
const model = readArg("model", "");
const artifactPath = readArg("artifact", "");

const fixtures =
    fixtureArg === "all" ? FIXTURES : FIXTURES.filter((fixture) => fixture.id === fixtureArg);
const protocolNames =
    protocolArg === "all"
        ? Object.keys(PROTOCOLS)
        : Object.keys(PROTOCOLS).filter((name) => name === protocolArg);

if (!fixtures.length) throw new Error(`Unknown fixture: ${fixtureArg}`);
if (!protocolNames.length) throw new Error(`Unknown protocol: ${protocolArg}`);

if (mode === "provider") {
    if (fixtures.length !== 1) {
        throw new Error("Provider mode requires one concrete --fixture");
    }
    if (protocolNames.length !== 1) {
        throw new Error("Provider mode requires one concrete --protocol");
    }
    const { runProviderBenchmark } = await import("./provider.mjs");
    const result = await runProviderBenchmark({
        provider,
        model,
        fixture: fixtures[0],
        protocol: protocolNames[0],
        maxEstimatedInputTokens,
        maxItems,
        maxOutputTokens,
        hardRunBudget,
        confirmProviderCost,
        dryRun,
        artifactPath,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}

if (mode !== "offline") {
    throw new Error(`Unknown benchmark mode ${mode}; use offline or provider`);
}

const cases = fixtures.flatMap((fixture) =>
    protocolNames.map((protocol) =>
        benchmarkFixture(fixture, protocol, { maxEstimatedInputTokens, maxItems })
    )
);

const result = {
    schemaVersion: "ai-page-bench-v2-offline-1",
    mode: "offline",
    generatedAt: new Date().toISOString(),
    usageSource: "client-estimated",
    warning:
        "Offline token values are heuristic estimates. Do not report them as provider usage or cost.",
    config: { mode, fixture: fixtureArg, protocol: protocolArg, maxEstimatedInputTokens, maxItems },
    cases,
};

if (!jsonOnly) {
    console.log("AI page translation V2 offline protocol benchmark");
    console.log(result.warning);
    for (const item of cases) {
        console.log(
            [
                item.fixtureId,
                item.protocol,
                `${item.unitCount} units`,
                `${item.packetCount} packets`,
                `~${item.estimatedTotalTokens} total tokens`,
                `~${item.protocolOverheadTokens} protocol overhead`,
            ].join(" | ")
        );
    }
} else {
    console.log(JSON.stringify(result, null, 2));
}
