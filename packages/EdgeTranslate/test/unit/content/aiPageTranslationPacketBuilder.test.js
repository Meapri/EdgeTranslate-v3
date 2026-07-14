import { serializeBlock } from "../../../src/content/ai_page_translation/dom/block_ir.js";
import { TargetRegistry } from "../../../src/content/ai_page_translation/dom/target_registry.js";
import { createEstimator } from "../../../src/content/ai_page_translation/ir/estimator.js";
import {
    CONTEXT_WINDOW_HEADROOM_FACTOR,
    DELIVERY_CEILING_ITEMS,
    TIER_CAPS,
    buildPackets,
    maxOutputTokensForPacket,
    reassembleChunks,
    splitTextByEstimatedTokens,
} from "../../../src/content/ai_page_translation/ir/packet_builder.js";

function observed(value) {
    return { value, source: "provider-metadata", observedAt: Date.now() };
}

function geminiEstimator() {
    return createEstimator({ sl: "ja", tl: "ko", provider: "googleAiStudio" });
}

function makeItems(count, text) {
    return Array.from({ length: count }, (_, index) => ({
        id: `b${index + 1}`,
        text: typeof text === "function" ? text(index) : text,
        role: "p",
        order: index,
    }));
}

function packetItemIds(result) {
    return result.packets.flatMap((packet) => packet.items.map((item) => item.id));
}

function sumItemEstOut(packet) {
    return packet.items.reduce((sum, item) => sum + item.estOutTokens, 0);
}

function placeholderTagsBalanced(text) {
    const stack = [];
    for (const tag of String(text || "").match(/<\/?g\d+>|<v\d+\/>/g) || []) {
        if (/^<v/.test(tag)) continue;
        const open = /^<g(\d+)>$/.exec(tag);
        if (open) stack.push(open[1]);
        else if (stack.pop() !== /^<\/g(\d+)>$/.exec(tag)?.[1]) return false;
    }
    return stack.length === 0;
}

describe("vNext AI page translation packet builder (spec §2.4)", () => {
    describe("tier caps on synthetic corpora", () => {
        it("respects drain caps (≤16 blocks, ≤2,400 src chars, est out ≤900, floor 500)", () => {
            // Under the ja-ko outRatio (1.9) each 470-char block is ~253 est-out, so the 900
            // est-out budget binds before the 2,400 char cap: three blocks (759 est-out, 1,410
            // chars) fit, a fourth (1,012 est-out) would not.
            const items = makeItems(
                100,
                (index) => `${"x".repeat(465)}${String(index).padStart(5, "0")}`
            );
            const result = buildPackets({
                items,
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });

            expect(result.chunked).toEqual([]);
            expect(result.packets).toHaveLength(34);
            for (const packet of result.packets) {
                expect(packet.itemCount).toBeLessThanOrEqual(TIER_CAPS.drain.maxBlocks);
                expect(packet.srcChars).toBeLessThanOrEqual(TIER_CAPS.drain.maxSrcChars);
                expect(sumItemEstOut(packet)).toBeLessThanOrEqual(TIER_CAPS.drain.maxEstOutTokens);
            }
            // Floor: every estOut-bound packet reaches 500 except the single final remainder.
            const underFloor = result.packets.filter(
                (packet) => sumItemEstOut(packet) < TIER_CAPS.drain.minEstOutTokens
            );
            expect(underFloor.length).toBeLessThanOrEqual(1);
            // Zero dropped strings.
            expect(packetItemIds(result).sort()).toEqual(items.map((item) => item.id).sort());
        });

        it("respects first-paint caps (≤12 blocks, ≤1,500 src chars, est out ≤600)", () => {
            const items = makeItems(30, "こんにちは世界"); // estOut 11/item
            const result = buildPackets({
                items,
                tier: "firstPaint",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });

            expect(result.packets.map((packet) => packet.items.map((item) => item.id))).toEqual([
                items.slice(0, 12).map((item) => item.id),
                items.slice(12, 24).map((item) => item.id),
                items.slice(24).map((item) => item.id),
            ]);
            for (const packet of result.packets) {
                expect(packet.itemCount).toBeLessThanOrEqual(TIER_CAPS.firstPaint.maxBlocks);
                expect(packet.srcChars).toBeLessThanOrEqual(TIER_CAPS.firstPaint.maxSrcChars);
                expect(sumItemEstOut(packet)).toBeLessThanOrEqual(
                    TIER_CAPS.firstPaint.maxEstOutTokens
                );
            }
        });

        it("respects viewport/horizon caps (≤24 blocks, est out ≤1,200)", () => {
            const items = makeItems(40, "こんにちは世界");
            for (const tier of ["viewport", "horizon", "viewportHorizon"]) {
                const result = buildPackets({
                    items,
                    tier,
                    provider: "googleAiStudio",
                    estimator: geminiEstimator(),
                    capabilities: { maxOutputTokens: observed(8000) },
                });
                expect(result.packets.map((packet) => packet.itemCount)).toEqual([24, 16]);
                expect(result.packets[0].tier).toBe("viewportHorizon");
                for (const packet of result.packets) {
                    expect(sumItemEstOut(packet)).toBeLessThanOrEqual(
                        TIER_CAPS.viewportHorizon.maxEstOutTokens
                    );
                }
            }
        });
    });

    describe("hard delivery ceilings", () => {
        it("keeps openaiCompatible packets within the 32-item ceiling (drain's 16-block cap binds first)", () => {
            const items = makeItems(200, "駅");
            const result = buildPackets({
                items,
                tier: "drain",
                provider: "openaiCompatible",
                estimator: createEstimator({ sl: "ja", tl: "ko", provider: "openaiCompatible" }),
                capabilities: { maxOutputTokens: observed(8000) },
            });
            // Drain now caps at 16 blocks, below the 32 openaiCompatible delivery ceiling.
            expect(result.packets).toHaveLength(13); // ceil(200/16)
            for (const packet of result.packets) {
                expect(packet.itemCount).toBeLessThanOrEqual(
                    DELIVERY_CEILING_ITEMS.openaiCompatible
                );
            }
            expect(packetItemIds(result).sort()).toEqual(items.map((item) => item.id).sort());
        });

        it("lets googleAiStudio packets reach the 16-block drain cap (ceiling 128 never binds)", () => {
            const items = makeItems(200, "駅");
            const result = buildPackets({
                items,
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });
            expect(result.packets).toHaveLength(13); // ceil(200/16)
            expect(Math.max(...result.packets.map((packet) => packet.itemCount))).toBe(
                TIER_CAPS.drain.maxBlocks
            );
        });

        it("treats an unknown provider conservatively (drain's 16-block cap binds below the 32 ceiling)", () => {
            const items = makeItems(64, "駅");
            const result = buildPackets({
                items,
                tier: "drain",
                provider: "somethingNew",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });
            expect(Math.max(...result.packets.map((packet) => packet.itemCount))).toBe(
                TIER_CAPS.drain.maxBlocks
            );
        });
    });

    describe("openaiCompatible output ceiling floor", () => {
        it("keeps 25% headroom inside the 1,024 compatible output floor", () => {
            // estIn 778 -> estOut 899: it fits the raw 1,024 floor but is chunked because the
            // provider request needs 1.25x headroom for a non-truncating reply.
            const items = [{ id: "b1", text: "x".repeat(2800), role: "p", order: 0 }];
            const result = buildPackets({
                items,
                tier: "drain",
                provider: "openaiCompatible",
                estimator: createEstimator({ sl: "en", tl: "ko", provider: "openaiCompatible" }),
                capabilities: { maxOutputTokens: observed(512) },
            });
            expect(result.chunked).toHaveLength(1);
            expect(result.packets.length).toBeGreaterThanOrEqual(1);
            for (const packet of result.packets) {
                expect(sumItemEstOut(packet)).toBeLessThanOrEqual(Math.floor(1024 / 1.25));
            }
        });

        it("chunks against the raised compat ceiling when a block exceeds it", () => {
            // estIn ~1,300 -> estOut ~1,500: fits drain's 1,800 but not the 1,024 compat ceiling.
            const items = [{ id: "b1", text: "y".repeat(4680), role: "p", order: 0 }];
            const result = buildPackets({
                items,
                tier: "drain",
                provider: "openaiCompatible",
                estimator: createEstimator({ sl: "en", tl: "ko", provider: "openaiCompatible" }),
                capabilities: { maxOutputTokens: observed(800) },
            });
            expect(result.chunked).toHaveLength(1);
            expect(result.chunked[0].chunkCount).toBeGreaterThan(1);
            for (const packet of result.packets) {
                expect(sumItemEstOut(packet)).toBeLessThanOrEqual(1024);
            }
        });
    });

    describe("LPT packing with document-position tiebreak", () => {
        it("keeps equal-weight items in stable reading order across packets", () => {
            const items = makeItems(60, "こんにちは世界");
            const result = buildPackets({
                items,
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });
            // 60 equal-weight blocks fill sequential 16-block drain packets in reading order.
            expect(result.packets.map((packet) => packet.items.map((item) => item.id))).toEqual([
                items.slice(0, 16).map((item) => item.id),
                items.slice(16, 32).map((item) => item.id),
                items.slice(32, 48).map((item) => item.id),
                items.slice(48).map((item) => item.id),
            ]);
        });

        it("is deterministic and orders items by document position inside every packet", () => {
            const texts = [120, 470, 30, 470, 900, 55, 240, 470, 120, 30, 640, 240];
            const items = texts.map((length, index) => ({
                id: `b${index + 1}`,
                text: "z".repeat(length),
                role: "p",
                order: index,
            }));
            const run = () =>
                buildPackets({
                    items,
                    tier: "drain",
                    provider: "googleAiStudio",
                    estimator: geminiEstimator(),
                    capabilities: { maxOutputTokens: observed(8000) },
                });
            const first = run();
            expect(run()).toEqual(first);
            for (const packet of first.packets) {
                const orders = packet.items.map((item) => item.order);
                expect(orders).toEqual(orders.slice().sort((a, b) => a - b));
            }
            expect(packetItemIds(first).sort()).toEqual(items.map((item) => item.id).sort());
        });

        it("assigns packet-local base36 aliases in item order", () => {
            const items = makeItems(13, "こんにちは世界");
            const result = buildPackets({
                items,
                tier: "firstPaint",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });
            expect(result.packets[0].aliases).toEqual([
                "0",
                "1",
                "2",
                "3",
                "4",
                "5",
                "6",
                "7",
                "8",
                "9",
                "a",
                "b",
            ]);
        });
    });

    describe("oversized-block chunking + all-or-nothing reassembly", () => {
        const sentence = "この案内文は翻訳が必要です。駅と路線の歴史を説明します。";

        it("pre-splits an oversized block into virtual chunk ids and packs them within caps", () => {
            const text = sentence.repeat(240); // exceeds both the 4K output and 8K char caps
            const result = buildPackets({
                items: [{ id: "b1", text, role: "p", order: 0 }],
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });

            expect(result.chunked).toHaveLength(1);
            const [entry] = result.chunked;
            expect(entry.id).toBe("b1");
            expect(entry.chunkCount).toBeGreaterThan(1);
            expect(entry.chunkIds).toEqual(entry.chunks.map((chunk, index) => `b1#c${index + 1}`));
            for (const packet of result.packets) {
                expect(sumItemEstOut(packet)).toBeLessThanOrEqual(TIER_CAPS.drain.maxEstOutTokens);
            }
            const chunkItems = result.packets.flatMap((packet) => packet.items);
            expect(chunkItems).toHaveLength(entry.chunkCount);
            expect(chunkItems.every((item) => item.chunk?.parentId === "b1")).toBe(true);
        });

        it("round-trips an identity translation back to the exact source text", () => {
            const text = sentence.repeat(240);
            const result = buildPackets({
                items: [{ id: "b1", text, role: "p", order: 0 }],
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });
            const chunkItems = result.packets
                .flatMap((packet) => packet.items)
                .sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);
            const reassembled = reassembleChunks(
                chunkItems.map((item) => ({ ...item, translatedText: item.text }))
            );
            expect(reassembled).toEqual([{ id: "b1", ok: true, text }]);
        });

        it("fails the whole block when any chunk is missing or failed (all-or-nothing)", () => {
            const text = sentence.repeat(240);
            const result = buildPackets({
                items: [{ id: "b1", text, role: "p", order: 0 }],
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });
            const chunkItems = result.packets.flatMap((packet) => packet.items);

            const missingOne = reassembleChunks(
                chunkItems.slice(1).map((item) => ({ ...item, translatedText: item.text }))
            );
            expect(missingOne).toEqual([{ id: "b1", ok: false, reason: "incomplete" }]);

            const oneFailed = reassembleChunks(
                chunkItems.map((item, index) => ({
                    ...item,
                    translatedText: index === 0 ? "" : item.text,
                }))
            );
            expect(oneFailed).toEqual([{ id: "b1", ok: false, reason: "failed" }]);
        });

        it("derives chunk grouping from flattened metadata and #cN ids", () => {
            expect(
                reassembleChunks([
                    { id: "b9#c1", chunkIndex: 0, chunkCount: 2, joinAfter: " ", text: "Hello" },
                    { id: "b9#c2", chunkIndex: 1, chunkCount: 2, joinAfter: "", text: "world" },
                ])
            ).toEqual([{ id: "b9", ok: true, text: "Hello world" }]);
        });

        it("prefers depth-zero boundaries so every repeated-wrapper chunk is balanced", () => {
            const text = Array.from(
                { length: 400 },
                (_, index) => `<g${index + 1}>駅路線案内所在地</g${index + 1}>`
            ).join("");
            const chunks = splitTextByEstimatedTokens(text, 300);
            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                const openers = (chunk.text.match(/</g) || []).length;
                const wholeTags = (chunk.text.match(/<\/?g\d+>|<v\d+\/>/g) || []).length;
                expect(openers).toBe(wholeTags);
                expect(placeholderTagsBalanced(chunk.text)).toBe(true);
            }
            const rebuilt = chunks.map((chunk) => chunk.text + chunk.joinAfter).join("");
            expect(rebuilt).toBe(text);
        });

        it("uses a safe wrapper boundary even when it is before the 55% prose window", () => {
            const first = "<g1>x</g1>";
            const second = `<g2>${"y".repeat(350)}</g2>`;
            const chunks = splitTextByEstimatedTokens(first + second, 100);

            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toEqual({ text: first, joinAfter: "" });
            expect(chunks[1]).toEqual({ text: second, joinAfter: "" });
            expect(chunks.every((chunk) => placeholderTagsBalanced(chunk.text))).toBe(true);
        });

        it("keeps nested pairs, voids and emoji surrogate pairs intact at structural cuts", () => {
            const text = Array.from({ length: 120 }, (_, index) => {
                const base = index * 3 + 1;
                return `<g${base}>駅🚀<g${base + 1}>路線</g${base + 1}>案内</g${base}><v${
                    base + 2
                }/>`;
            }).join("");
            const chunks = splitTextByEstimatedTokens(text, 120);

            expect(chunks.length).toBeGreaterThan(1);
            expect(chunks.every((chunk) => placeholderTagsBalanced(chunk.text))).toBe(true);
            expect(chunks.map((chunk) => chunk.text + chunk.joinAfter).join("")).toBe(text);
            for (let index = 0; index < chunks.length - 1; index += 1) {
                const left = chunks[index].text;
                const right = chunks[index + 1].text;
                expect(/[\uD800-\uDBFF]$/.test(left)).toBe(false);
                expect(/^[\uDC00-\uDFFF]/.test(right)).toBe(false);
            }
        });

        it("preserves the exact multi-whitespace run owned by an internal seam", () => {
            const seam = "  \n\t";
            const text = `${"a".repeat(360)}${seam}${"b".repeat(360)}`;
            const chunks = splitTextByEstimatedTokens(text, 100);

            expect(chunks.length).toBeGreaterThan(1);
            expect(chunks[0].joinAfter).toBe(seam);
            expect(chunks.map((chunk) => chunk.text + chunk.joinAfter).join("")).toBe(text);
            expect(
                reassembleChunks(
                    chunks.map((chunk, index) => ({
                        id: `seam#c${index + 1}`,
                        chunkIndex: index,
                        chunkCount: chunks.length,
                        joinAfter: chunk.joinAfter,
                        translatedText: chunk.text,
                    }))
                )
            ).toEqual([{ id: "seam", ok: true, text }]);
        });

        it("returns short text as a single chunk and reassembles whitespace splits", () => {
            expect(splitTextByEstimatedTokens("short text", 128)).toEqual([
                { text: "short text", joinAfter: "" },
            ]);
            const words = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
            const chunks = splitTextByEstimatedTokens(words, 200);
            expect(chunks.length).toBeGreaterThan(1);
            expect(chunks.map((chunk) => chunk.text + chunk.joinAfter).join("")).toBe(words);
        });
    });

    describe("provider input and combined context ceilings", () => {
        const contextCapabilities = (wrap) => ({
            maxInputTokens: wrap ? observed(700) : 700,
            maxOutputTokens: wrap ? observed(800) : 800,
            maxCombinedTokens: wrap ? observed(1050) : 1050,
        });

        it.each([false, true])(
            "packs every first-dispatch packet below safe context ceilings (observed=%s)",
            (wrap) => {
                const capabilities = contextCapabilities(wrap);
                const result = buildPackets({
                    items: makeItems(30, (index) => `${"路線案内".repeat(25)}${index}`),
                    tier: "drain",
                    provider: "googleAiStudio",
                    estimator: geminiEstimator(),
                    capabilities,
                    ctxTokens: 75,
                });
                expect(result.packets.length).toBeGreaterThan(1);
                for (const packet of result.packets) {
                    const maxOutputTokens = maxOutputTokensForPacket({
                        estIn: packet.estIn,
                        estOut: packet.estOut,
                        provider: "googleAiStudio",
                        capabilities,
                    });
                    expect(packet.estIn).toBeLessThanOrEqual(
                        Math.floor(700 * CONTEXT_WINDOW_HEADROOM_FACTOR)
                    );
                    expect(packet.estIn + maxOutputTokens).toBeLessThanOrEqual(
                        Math.floor(1050 * CONTEXT_WINDOW_HEADROOM_FACTOR)
                    );
                }
            }
        );

        it("bounded-chunks one oversized item until prompt, ctx and output reserve all fit", () => {
            const capabilities = {
                maxInputTokens: observed(500),
                maxOutputTokens: observed(800),
                maxCombinedTokens: observed(850),
            };
            const result = buildPackets({
                items: [{ id: "huge", text: "長い路線案内です。".repeat(240), order: 0 }],
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities,
                ctxTokens: 100,
            });
            expect(result.chunked).toHaveLength(1);
            expect(result.chunked[0].chunkCount).toBeGreaterThan(1);
            for (const packet of result.packets) {
                const maxOutputTokens = maxOutputTokensForPacket({
                    estIn: packet.estIn,
                    estOut: packet.estOut,
                    provider: "googleAiStudio",
                    capabilities,
                });
                expect(packet.estIn).toBeLessThanOrEqual(450);
                expect(packet.estIn + maxOutputTokens).toBeLessThanOrEqual(765);
            }
        });

        it("rejects a profile whose fixed prompt overhead cannot fit before provider dispatch", () => {
            expect(() =>
                buildPackets({
                    items: [{ id: "b1", text: "駅" }],
                    tier: "drain",
                    provider: "googleAiStudio",
                    estimator: geminiEstimator(),
                    capabilities: {
                        maxInputTokens: observed(200),
                        maxOutputTokens: observed(800),
                        maxCombinedTokens: observed(1000),
                    },
                })
            ).toThrow(/cannot fit provider context/i);
        });

        it("caps final maxOutputTokens by the safe combined remainder for both field shapes", () => {
            for (const wrap of [false, true]) {
                // The generous send ceiling (max(3x est-out, 2048 floor)) is capped DOWN to the
                // safe combined remainder: floor(1050*0.9) - 500 = 445.
                expect(
                    maxOutputTokensForPacket({
                        estIn: 500,
                        estOut: 200,
                        provider: "googleAiStudio",
                        capabilities: contextCapabilities(wrap),
                    })
                ).toBe(445);
            }
            expect(() =>
                maxOutputTokensForPacket({
                    estIn: 700,
                    estOut: 200,
                    provider: "googleAiStudio",
                    capabilities: {
                        maxInputTokens: 700,
                        maxOutputTokens: 800,
                        maxCombinedTokens: 1050,
                    },
                })
            ).toThrow(/input ceiling/i);
        });

        it("decouples the sent max_output from est-out: 3x headroom / 2048 floor, capped by ceiling", () => {
            // Generous ceiling, no combined limit: a small est-out still gets the 2048 floor, and
            // a larger est-out gets 3x — never the tight sizing reserve — so decode cannot truncate.
            expect(
                maxOutputTokensForPacket({
                    estIn: 400,
                    estOut: 100,
                    provider: "openai",
                    capabilities: { maxOutputTokens: observed(8192) },
                })
            ).toBe(2048);
            expect(
                maxOutputTokensForPacket({
                    estIn: 1200,
                    estOut: 900,
                    provider: "openai",
                    capabilities: { maxOutputTokens: observed(8192) },
                })
            ).toBe(2700); // ceil(900 * 3)
            // The floor never raises the feasibility bar: a small-context compatible profile
            // simply sends its own 1,024 ceiling instead of throwing on the 2048 floor.
            expect(
                maxOutputTokensForPacket({
                    estIn: 200,
                    estOut: 200,
                    provider: "openaiCompatible",
                    capabilities: { maxOutputTokens: observed(512) },
                })
            ).toBe(1024);
        });
    });

    describe("input validation", () => {
        it("rejects duplicate or missing ids, unknown tiers and missing estimators", () => {
            const estimator = geminiEstimator();
            expect(() =>
                buildPackets({
                    items: [
                        { id: "b1", text: "a" },
                        { id: "b1", text: "b" },
                    ],
                    tier: "drain",
                    provider: "googleAiStudio",
                    estimator,
                })
            ).toThrow(/duplicate/i);
            expect(() =>
                buildPackets({
                    items: [{ id: "b1", text: "a" }],
                    tier: "warp",
                    provider: "googleAiStudio",
                    estimator,
                })
            ).toThrow(/tier/i);
            expect(() => buildPackets({ items: [{ id: "b1", text: "a" }], tier: "drain" })).toThrow(
                /estimator/i
            );
            expect(
                buildPackets({
                    items: [],
                    tier: "drain",
                    provider: "googleAiStudio",
                    estimator,
                })
            ).toEqual({ packets: [], chunked: [] });
        });
    });

    describe("re-pinned packet-count contract (5,282-string wiki fixture)", () => {
        it("plans the 5,282-string fixture into the pinned drain packet count with zero dropped strings", () => {
            // Same corpus generator as aiPageTranslationStableSession.test.js: one <main> of
            // 5,282 inline <span> strings. Under the vNext leaf-block model that is ONE semantic
            // leaf block, serialized with inline placeholders, oversized, and pre-split into
            // virtual chunks. With the small-packet drain caps (16 blocks / 900 est-out tokens)
            // and the ja-ko outRatio (1.9) sizing chunks from realistic output, this pathological
            // single leaf now spreads across 96 drain packets, still with zero dropped strings —
            // the exact count is pinned so a caps regression is caught.
            const targetCount = 5282;
            document.body.innerHTML = `<main>${Array.from(
                { length: targetCount },
                (_, index) => `<span>駅路線案内 ${index + 1}</span>`
            ).join("")}</main>`;
            const main = document.querySelector("main");
            const nodes = Array.from(main.querySelectorAll("span"), (span) => span.firstChild);

            const serialized = serializeBlock({
                element: main,
                textNodes: nodes.map((node) => ({ node })),
            });
            expect(serialized.atomicRequired).toBe(false);
            expect(serialized.applyMap).toHaveLength(targetCount);

            const pathByIndex = new Map(
                serialized.applyMap.map(({ nodeIndex, path }) => [nodeIndex, path])
            );
            const registry = new TargetRegistry("packet-pin");
            const target = registry.registerBlockTarget(
                nodes.map((node, index) => ({ node, path: pathByIndex.get(index) ?? null })),
                { role: "p", source: serialized.source }
            );
            expect(target.kind).toBe("block");
            expect(target.role).toBe("p");

            const result = buildPackets({
                items: [{ id: target.id, text: target.source, role: target.role, order: 0 }],
                tier: "drain",
                provider: "googleAiStudio",
                estimator: geminiEstimator(),
                capabilities: { maxOutputTokens: observed(8000) },
            });

            // Caps pin: this deliberately pathological 5,282-string leaf splits into exactly 96
            // small drain packets under the measured small-packet regime, without dropping any
            // source string.
            expect(result.packets.length).toBe(96);
            expect(result.chunked).toHaveLength(1);
            expect(result.chunked[0].chunkCount).toBeGreaterThan(1);

            for (const packet of result.packets) {
                expect(packet.itemCount).toBeLessThanOrEqual(TIER_CAPS.drain.maxBlocks);
                expect(packet.srcChars).toBeLessThanOrEqual(TIER_CAPS.drain.maxSrcChars);
                expect(sumItemEstOut(packet)).toBeLessThanOrEqual(TIER_CAPS.drain.maxEstOutTokens);
            }

            // Zero dropped strings: an identity round trip reproduces the serialized block
            // byte-for-byte, and every one of the 5,282 source strings is present exactly once.
            const chunkItems = result.packets.flatMap((packet) => packet.items);
            expect(chunkItems).toHaveLength(result.chunked[0].chunkCount);
            const reassembled = reassembleChunks(
                chunkItems.map((item) => ({ ...item, translatedText: item.text }))
            );
            expect(reassembled).toEqual([{ id: target.id, ok: true, text: serialized.source }]);
            expect((reassembled[0].text.match(/駅路線案内/g) || []).length).toBe(targetCount);
        });
    });
});
