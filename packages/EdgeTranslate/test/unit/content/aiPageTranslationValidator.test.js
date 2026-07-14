import {
    canonicalNumber,
    normalizeChunkSeam,
    validateTranslatedItem,
} from "../../../src/content/ai_page_translation/runtime/validator.js";

function validate(source, translated, options = {}, item = {}) {
    return validateTranslatedItem({ source, translated, ...item }, options);
}

describe("AI page translation vNext validator — strictness tiers (spec §6)", () => {
    it("accepts a natural translation while preserving identifiers, numbers and URLs", () => {
        const verdict = validate(
            "Train KH01 runs 49.3 km; see https://example.com/line.",
            "KH01 열차는 49.3 km를 운행해. https://example.com/line.에서 확인해.",
            { targetLanguage: "ko" }
        );
        expect(verdict).toMatchObject({ verdict: "accept", failures: [], warnings: [] });
    });

    it("legalizes the measured Gemini false-positive class: 1,000 -> 1000", () => {
        const verdict = validate(
            "路線の全長は1,000 kmです。",
            "노선의 전체 길이는 1000 km입니다.",
            { targetLanguage: "ko" }
        );
        expect(verdict.verdict).toBe("accept");
        expect(verdict.failures).toEqual([]);
    });

    it("legalizes decimal comma/point unification: 3.5 -> 3,5", () => {
        const verdict = validate(
            "The value increased by 3.5 percent this year overall.",
            "Der Wert stieg dieses Jahr insgesamt um 3,5 Prozent.",
            { targetLanguage: "de" }
        );
        expect(verdict.verdict).toBe("accept");
        expect(verdict.failures).toEqual([]);
    });

    it("legalizes full-width to half-width digit unification", () => {
        const verdict = validate("全長は１２３４kmです。", "전체 길이는 1234 km입니다.", {
            targetLanguage: "ko",
        });
        expect(verdict).toMatchObject({ verdict: "accept", failures: [], warnings: [] });
    });

    it("warn+accepts a changed number instead of hard-failing (zero failed strings)", () => {
        const onTelemetry = jest.fn();
        const verdict = validate("The route is 12.5 km long.", "이 노선의 길이는 12.6km입니다.", {
            targetLanguage: "ko",
            onTelemetry,
        });
        // A reformatted/dropped number is warned and accepted: a translated string with a
        // changed number is strictly better than untranslated source, and there is no paid retry.
        expect(verdict.verdict).toBe("acceptWithWarnings");
        expect(verdict.warnings).toContain("warn_accept_number");
        expect(verdict.telemetry.warn_accept_number).toBe(1);
        expect(verdict.failures).toEqual([]);
        expect(onTelemetry).toHaveBeenCalledWith("warn_accept_number", "12.5");
    });

    it("accepts a Japanese year-marker reformat cleanly (2023年 -> 2023년)", () => {
        // The era marker 年 is non-digit and never enters a NUMBER_TOKEN, so the preserved 2023
        // compares equal on both sides — no false-positive number failure, no warning.
        const verdict = validate(
            "2023年に全線が開業しました。",
            "2023년에 전 노선이 개통했습니다.",
            {
                targetLanguage: "ko",
            }
        );
        expect(verdict.verdict).toBe("accept");
        expect(verdict.failures).toEqual([]);
    });

    it("hard-fails URLs byte-exactly but honors percent-decode equivalence", () => {
        const altered = validate(
            "See https://example.com/a%20b for details on the plan.",
            "자세한 내용은 https://example.com/a-b 를 참조하세요.",
            { targetLanguage: "ko" }
        );
        expect(altered.verdict).toBe("fail");
        expect(altered.failures).toContainEqual({
            class: "url",
            detail: "https://example.com/a%20b",
        });

        const decoded = validate(
            "See https://example.com/a%20b for details on the plan.",
            "자세한 내용은 https://example.com/a b 를 참조하세요.",
            { targetLanguage: "ko" }
        );
        expect(decoded.verdict).toBe("accept");
    });

    it("hard-fails missing identifiers", () => {
        const verdict = validate("Service KH01 travels 49.3 km.", "이 열차는 운행해.", {
            targetLanguage: "ko",
        });
        expect(verdict.verdict).toBe("fail");
        expect(verdict.failures).toContainEqual({ class: "identifier", detail: "KH01" });
    });

    it("hard-fails expansion beyond 6x", () => {
        const verdict = validate("A short heading about trains.", "가".repeat(200), {
            targetLanguage: "ko",
        });
        expect(verdict.verdict).toBe("fail");
        expect(verdict.failures).toContainEqual(
            expect.objectContaining({ class: "length-expansion" })
        );
    });

    it("hard-fails collapse below 12 percent", () => {
        const source =
            "京阪本線は大阪府大阪市中央区の淀屋橋駅から京都府京都市東山区の三条駅までを結ぶ" +
            "京阪電気鉄道の鉄道路線であり沿線には多くの歴史的な観光地や住宅地や商業地が広がっている。" +
            "通勤通学輸送と観光輸送の両方を担う重要な幹線であり京阪電気鉄道の経営の中核を成す路線である。";
        const verdict = validate(source, "게이한 본선.", { targetLanguage: "ko" });
        expect(verdict.verdict).toBe("fail");
        expect(verdict.failures).toContainEqual(
            expect.objectContaining({ class: "length-collapse" })
        );
    });

    it("warn_accept_length_ratio fires for outliers inside the hard bounds", () => {
        const verdict = validate(
            "京阪電車の運行情報はこちらから確認できます",
            "게이한 전철의 상세한 운행 정보와 지연 안내, 우회 경로 추천, 역별 시간표 정보는 아래 링크에서 언제든지 확인하실 수 있습니다",
            { targetLanguage: "ko" }
        );
        expect(verdict.verdict).toBe("acceptWithWarnings");
        expect(verdict.warnings).toEqual(["warn_accept_length_ratio"]);
        expect(verdict.telemetry.warn_accept_length_ratio).toBe(1);
    });

    it("warn_accept_unit_word fires when the unit word is translated", () => {
        const onTelemetry = jest.fn();
        const verdict = validate("The route is 12 km long.", "노선의 길이는 12 킬로미터입니다.", {
            targetLanguage: "ko",
            onTelemetry,
        });
        expect(verdict.verdict).toBe("acceptWithWarnings");
        expect(verdict.warnings).toEqual(["warn_accept_unit_word"]);
        expect(verdict.telemetry.warn_accept_unit_word).toBe(1);
        expect(onTelemetry).toHaveBeenCalledWith("warn_accept_unit_word", "km");
    });

    it("warn_accept_script fires for short items, hard-fails only long source prose", () => {
        const short = validate("設定", "Settings", { targetLanguage: "ko" });
        expect(short.verdict).toBe("acceptWithWarnings");
        expect(short.warnings).toContain("warn_accept_script");
        expect(short.telemetry.warn_accept_script).toBe(1);

        const longProse = validate(
            "京阪本線は大阪府と京都府を結ぶ京阪電気鉄道の重要な鉄道路線であり多くの利用者が毎日利用している。",
            "The Keihan Main Line is an important railway line connecting Osaka and Kyoto.",
            { targetLanguage: "ko" }
        );
        expect(longProse.verdict).toBe("fail");
        expect(longProse.failures).toContainEqual(expect.objectContaining({ class: "script" }));
    });

    it("warn+accepts every source echo, including CJK prose, and never double-fails as script", () => {
        const brand = "GitHub Actions CI/CD Pipeline";
        const latinEcho = validate(brand, brand, { targetLanguage: "ko" });
        expect(latinEcho.verdict).toBe("acceptWithWarnings");
        expect(latinEcho.warnings).toContain("warn_accept_echo");
        expect(latinEcho.telemetry.warn_accept_echo).toBe(1);

        // Source-language prose echoed unchanged: cannot be positively confirmed as
        // already-target, but keeping it beats a paid retry that leaves it untranslated. It is
        // warned+accepted exactly once and NOT also hard-failed by the target-script tier.
        const prose = "京阪本線は大阪と京都を結ぶ鉄道路線です。";
        const proseEcho = validate(prose, prose, { targetLanguage: "ko" });
        expect(proseEcho.verdict).toBe("acceptWithWarnings");
        expect(proseEcho.warnings).toEqual(["warn_accept_echo"]);
        expect(proseEcho.failures).toEqual([]);

        const unspacedCjkProse = "回復パケットの上限を検証するための日本語の原文です";
        const unspacedEcho = validate(unspacedCjkProse, unspacedCjkProse, {
            targetLanguage: "ko",
        });
        expect(unspacedEcho.verdict).toBe("acceptWithWarnings");
        expect(unspacedEcho.warnings).toEqual(["warn_accept_echo"]);
        expect(unspacedEcho.failures).toEqual([]);
    });

    it("still hard-fails a genuine wrong-language (non-echo) translation via the script tier", () => {
        // Not a source echo — the model translated ja prose into en, zero target (ko) script.
        // The script tier still catches this real mistranslation.
        const longProse = validate(
            "京阪本線は大阪府と京都府を結ぶ京阪電気鉄道の重要な鉄道路線であり多くの利用者が毎日利用している。",
            "The Keihan Main Line is an important railway line connecting Osaka and Kyoto.",
            { targetLanguage: "ko" }
        );
        expect(longProse.verdict).toBe("fail");
        expect(longProse.failures).toContainEqual(expect.objectContaining({ class: "script" }));
    });

    it("accepts confirmed '=' keep-source and warn+accepts the unconfirmable ones", () => {
        const alreadyKorean = validate(
            "이미 한국어로 작성된 문장입니다.",
            "이미 한국어로 작성된 문장입니다.",
            { targetLanguage: "ko" },
            { keepSource: true }
        );
        expect(alreadyKorean).toMatchObject({ verdict: "accept", failures: [], warnings: [] });

        // "=" on source-language prose cannot be positively confirmed as already-target, but a
        // "=" item displays source regardless, so warn+accept rather than a paid retry.
        const japaneseProse = validate(
            "京阪本線は大阪と京都を結ぶ鉄道路線です。",
            "京阪本線は大阪と京都を結ぶ鉄道路線です。",
            { targetLanguage: "ko" },
            { keepSource: true }
        );
        expect(japaneseProse.verdict).toBe("acceptWithWarnings");
        expect(japaneseProse.warnings).toContain("warn_accept_echo");
        expect(japaneseProse.failures).toEqual([]);

        // "=" but the reply drifted from source: the sentinel keeps source either way, so accept
        // with a warning instead of hard-failing.
        const mismatched = validate(
            "이미 한국어 문장입니다.",
            "전혀 다른 텍스트",
            { targetLanguage: "ko" },
            { keepSource: true }
        );
        expect(mismatched.verdict).toBe("acceptWithWarnings");
        expect(mismatched.warnings).toContain("warn_accept_echo");
        expect(mismatched.failures).toEqual([]);
    });

    it("hard-fails placeholder inventory breaks against the block_ir inventory", () => {
        const inventory = {
            tags: [
                { name: "g1", kind: "paired", interactive: true },
                { name: "v1", kind: "void" },
            ],
        };
        const broken = validateTranslatedItem(
            {
                source: "淀屋橋駅から<g1>三条駅</g1><v1/>までを結ぶ。",
                translated: "요도야바시역에서 산조역까지를 잇는다.",
                placeholderInventory: inventory,
            },
            { targetLanguage: "ko" }
        );
        expect(broken.verdict).toBe("fail");
        expect(broken.failures).toContainEqual(expect.objectContaining({ class: "placeholder" }));

        const reordered = validateTranslatedItem(
            {
                source: "淀屋橋駅から<g1>三条駅</g1><v1/>までを結ぶ。",
                translated: "<v1/><g1>산조역</g1>까지 요도야바시역에서 잇는다.",
                placeholderInventory: inventory,
            },
            { targetLanguage: "ko" }
        );
        expect(reordered.verdict).toBe("accept");
    });

    it("checks wire-level tag multiset equality when no inventory is attached", () => {
        const dropped = validate(
            "<g1>大阪</g1>と<g2>京都</g2>を結ぶ。",
            "<g1>오사카</g1>와 교토를 잇는다.",
            { targetLanguage: "ko" }
        );
        expect(dropped.verdict).toBe("fail");
        expect(dropped.failures).toContainEqual(expect.objectContaining({ class: "placeholder" }));

        const moved = validate(
            "<g1>大阪</g1>と<g2>京都</g2>を結ぶ。",
            "<g2>교토</g2>와 <g1>오사카</g1>를 잇는다.",
            { targetLanguage: "ko" }
        );
        expect(moved.verdict).toBe("accept");
    });

    it("hard-fails empty output", () => {
        const verdict = validate("大阪と京都を結ぶ。", "   ", { targetLanguage: "ko" });
        expect(verdict.verdict).toBe("fail");
        expect(verdict.failures).toContainEqual(expect.objectContaining({ class: "empty" }));
    });

    it("normalizes chunk seams and grouping/decimal variants through the shared helpers", () => {
        expect(normalizeChunkSeam("  분할된   텍스트 ")).toBe("분할된 텍스트");
        expect(canonicalNumber("1,000")).toBe("1000");
        expect(canonicalNumber("1.000")).toBe("1000");
        expect(canonicalNumber("3,5")).toBe("3.5");
        expect(canonicalNumber("3.5")).toBe("3.5");
        expect(canonicalNumber("1,234.5")).toBe("1234.5");
        expect(canonicalNumber("１２３４")).toBe("1234");
    });
});
