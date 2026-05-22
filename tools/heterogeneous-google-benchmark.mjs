import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

global.DOMParser =
    global.DOMParser ||
    class {
        parseFromString() {
            return { documentElement: null };
        }
    };
global.Audio =
    global.Audio ||
    class {
        constructor() {
            this.paused = true;
            this.src = "";
        }
        play() {
            this.paused = false;
            return Promise.resolve();
        }
        pause() {
            this.paused = true;
        }
    };

const require = createRequire(import.meta.url);
const { GoogleTranslator } = require("../packages/translators/dist/translators.umd.js");

const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || "";
const model = process.env.GOOGLE_AI_STUDIO_MODEL || "gemini-2.5-flash-lite";

const fixtures = [
    {
        id: "ja-pokemon-heading-ko",
        source: "「会員アカウント」に対する不正ログインの発生のご報告とポケモンセンターオンラインを安全にご利用いただくためのお願い",
        from: "ja",
        to: "ko",
        required: [/회원\s*계정/, /무단|비정상|부정/, /로그인/, /포켓몬\s*센터|포켓몬센터/, /안전/, /안내|부탁|요청/],
        forbidden: [/[\u3040-\u30ff]/, /[\u3400-\u9fff]+[가-힣]+/, /^「.*」에 대한/],
        maxChars: 95,
    },
    {
        id: "ja-pokemon-segments-ko",
        source: [
            "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
            "「会員アカウント」に対する不正ログインの発生のご報告とポケモンセンターオンラインを安全にご利用いただくためのお願い",
            "<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>",
            "2025年07月03日（木）",
            "<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>",
            "平素よりポケモンセンターオンラインをご利用いただき、ありがとうございます。",
        ].join("\n"),
        from: "ja",
        to: "ko",
        required: [
            /<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>/,
            /회원\s*계정/,
            /로그인/,
            /포켓몬\s*센터|포켓몬센터/,
            /<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>[\s\S]*2025/,
            /<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>[\s\S]*감사/,
        ],
        forbidden: [/[\u3040-\u30ff]/, /[\u3400-\u9fff]+[가-힣]+/, /원문|번역문/],
        maxChars: 420,
    },
    {
        id: "en-wine-warp-ko",
        source: "The old method had issues with achieving the warp:",
        from: "en",
        to: "ko",
        required: [/이전|기존|예전/, /방식|방법/, /워프|워핑|커서/, /구현|달성|수행|처리/, /문제|어려움/],
        forbidden: [/휘어짐/, /warp/i],
        maxChars: 80,
    },
    {
        id: "en-url-ko",
        source: "Visit https://example.com/reset?token=ABC123 to reset your password.",
        from: "en",
        to: "ko",
        required: [/https:\/\/example\.com\/reset\?token=ABC123/, /비밀번호/, /재설정/],
        forbidden: [/password/i],
        maxChars: 120,
    },
    {
        id: "ko-security-ja",
        source: "비밀번호 재설정 후 다시 로그인해 주세요.",
        from: "ko",
        to: "ja",
        required: [/パスワード/, /再設定|リセット/, /ログイン/],
        forbidden: [/[가-힣]/],
        maxChars: 90,
    },
    {
        id: "zh-account-ko",
        source: "关于账户异常登录发生情况及安全使用服务的通知",
        from: "zh-CN",
        to: "ko",
        required: [/계정/, /이상|비정상|무단|부정/, /로그인/, /안전/, /서비스/, /안내|공지/],
        forbidden: [/[\u3400-\u9fff]/],
        maxChars: 90,
    },
];

function languageName(code) {
    const base = String(code || "").split("-")[0];
    return (
        {
            en: "English",
            ja: "Japanese",
            ko: "Korean",
            zh: "Chinese",
        }[base] || code
    );
}

function scoreTranslation(fixture, output) {
    const text = String(output || "").trim();
    const missing = fixture.required.filter((pattern) => !pattern.test(text)).length;
    const forbidden = fixture.forbidden.filter((pattern) => pattern.test(text)).length;
    const lengthPenalty = text.length > fixture.maxChars ? 1 : 0;
    const emptyPenalty = text ? 0 : 3;
    return {
        score: Math.max(0, 100 - missing * 18 - forbidden * 25 - lengthPenalty * 10 - emptyPenalty * 30),
        missing,
        forbidden,
        lengthPenalty,
        text,
    };
}

function stripCodeFence(text) {
    return String(text || "")
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/i, "")
        .trim();
}

function extractTranslation(payload) {
    const parts = payload?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((part) => part?.text || "").join("").trim() : "";
    const cleaned = stripCodeFence(text);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            return String(parsed.translation || "").trim();
        } catch {
            // Fall through to plain text output below.
        }
    }
    return cleaned;
}

function buildPostEditPrompt({ source, draft, from, to }) {
    return [
        `Post-edit this machine translation from ${languageName(from)} to ${languageName(to)}.`,
        "Return strict JSON only with this shape: {\"translation\":\"...\"}.",
        "Use the draft as the baseline, but fix unnatural terms, copied source text, omissions, duplicated source/translation pairs, and formatting damage.",
        "Preserve URLs, numbers, product names, code identifiers, and <<<EDGE_TRANSLATE_SEGMENT_N role=...>>> markers exactly.",
        "Do not quote, label, summarize, explain, or include the source text.",
        "",
        "SOURCE:",
        source,
        "",
        "DRAFT_TRANSLATION:",
        draft,
    ].join("\n");
}

async function postEditWithAi({ source, draft, from, to }) {
    if (!apiKey) return null;
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
        )}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: buildPostEditPrompt({ source, draft, from, to }) }] }],
                generationConfig: {
                    candidateCount: 1,
                    temperature: 0,
                    topK: 1,
                    thinkingConfig: { thinkingBudget: 0 },
                },
            }),
        }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error?.message || `Google AI Studio request failed with ${response.status}`);
    }
    return extractTranslation(payload);
}

function summarize(rows, label) {
    const relevant = rows.filter((row) => row.label === label && row.status === "ok");
    const count = relevant.length || 1;
    return {
        label,
        measured: relevant.length,
        avgScore: relevant.reduce((sum, row) => sum + row.score, 0) / count,
        avgLatencyMs: relevant.reduce((sum, row) => sum + row.latencyMs, 0) / count,
    };
}

const google = new GoogleTranslator();
const rows = [];

for (const fixture of fixtures) {
    const googleStart = performance.now();
    let googleText = "";
    try {
        const googleResult = await google.translate(fixture.source, fixture.from, fixture.to);
        googleText = googleResult.mainMeaning || "";
        rows.push({
            label: "Google",
            id: fixture.id,
            status: "ok",
            latencyMs: performance.now() - googleStart,
            ...scoreTranslation(fixture, googleText),
        });
    } catch (error) {
        rows.push({
            label: "Google",
            id: fixture.id,
            status: "error",
            latencyMs: performance.now() - googleStart,
            score: 0,
            text: error?.message || String(error),
        });
    }

    const heteroStart = performance.now();
    if (!apiKey) {
        rows.push({
            label: "Google + AI",
            id: fixture.id,
            status: "skipped",
            latencyMs: 0,
            score: 0,
            text: "SKIPPED: set GOOGLE_AI_STUDIO_API_KEY or GEMINI_API_KEY for AI post-edit benchmark.",
        });
        continue;
    }

    try {
        const heteroText = await postEditWithAi({
            source: fixture.source,
            draft: googleText,
            from: fixture.from,
            to: fixture.to,
        });
        rows.push({
            label: "Google + AI",
            id: fixture.id,
            status: "ok",
            latencyMs: performance.now() - heteroStart,
            ...scoreTranslation(fixture, heteroText),
        });
    } catch (error) {
        rows.push({
            label: "Google + AI",
            id: fixture.id,
            status: "error",
            latencyMs: performance.now() - heteroStart,
            score: 0,
            text: error?.message || String(error),
        });
    }
}

for (const row of rows) {
    console.log(
        [
            row.label,
            row.id,
            `status=${row.status}`,
            `score=${row.score}`,
            `latency=${row.latencyMs.toFixed(1)}ms`,
            `text=${JSON.stringify(row.text)}`,
        ].join(" | ")
    );
}

const googleSummary = summarize(rows, "Google");
const heteroSummary = summarize(rows, "Google + AI");
console.log("");
console.log(
    `average ${googleSummary.label}: score=${googleSummary.avgScore.toFixed(1)} latency=${googleSummary.avgLatencyMs.toFixed(
        1
    )}ms measured=${googleSummary.measured}`
);
console.log(
    `average ${heteroSummary.label}: score=${heteroSummary.avgScore.toFixed(
        1
    )} latency=${heteroSummary.avgLatencyMs.toFixed(1)}ms measured=${heteroSummary.measured}`
);
if (heteroSummary.measured) {
    console.log(
        `delta Google + AI vs Google: score=${(heteroSummary.avgScore - googleSummary.avgScore).toFixed(
            1
        )} latency=${(heteroSummary.avgLatencyMs - googleSummary.avgLatencyMs).toFixed(1)}ms`
    );
} else {
    console.log("delta Google + AI vs Google: skipped because no AI Studio/Gemini API key is available.");
}
