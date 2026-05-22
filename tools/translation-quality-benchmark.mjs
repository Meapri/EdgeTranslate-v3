import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const {
    BingTranslator,
    LocalTranslator,
    HybridTranslator,
} = require("../packages/translators/dist/translators.umd.js");

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
global.document =
    global.document ||
    {
        body: {
            appendChild() {},
            removeChild() {},
        },
        createElement() {
            return {
                contentWindow: {
                    postMessage() {},
                },
                src: "",
            };
        },
    };
global.window =
    global.window ||
    {
        addEventListener() {},
        removeEventListener() {},
    };

const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || "";
const model = process.env.GOOGLE_AI_STUDIO_MODEL || "gemini-2.5-flash-lite";
const live = process.argv.includes("--live") || process.env.TRANSLATION_BENCH_LIVE === "1";
const includeBingBaseline =
    live && !process.argv.includes("--no-bing-baseline") && process.env.TRANSLATION_BENCH_BING !== "0";

const fixtures = [
    {
        id: "ja-notice-heading-ko",
        source: "「会員アカウント」に対する不正ログインの発生のご報告とポケモンセンターオンラインを安全にご利用いただくためのお願い",
        from: "ja",
        to: "ko",
        expectedGood: "회원 계정 무단 로그인 발생 보고 및 포켓몬센터 온라인 안전 이용 안내",
        required: [
            /회원\s*계정/,
            /무단|비정상/,
            /로그인/,
            /포켓몬\s*센터|포켓몬센터|포켓몬 센터/,
            /안전/,
            /안내|요청|부탁|바랍니다/,
        ],
        forbidden: [
            /부정 로그인/,
            /안내\s*말씀/,
            /[\u3040-\u30ff]/,
            /[\u3400-\u9fff]+[가-힣]+/,
            /입니다[.!?。．]?$/,
            /합니다[.!?。．]?$/,
            /드립니다[.!?。．]?$/,
        ],
        maxChars: 80,
    },
    {
        id: "ja-role-page-snippet-ko",
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
        expectedGood: [
            "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
            "회원 계정 무단 로그인 발생 보고 및 포켓몬센터 온라인 안전 이용 안내",
            "<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>",
            "2025년 07월 03일(목)",
            "<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>",
            "평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
        ].join("\n"),
        required: [
            /<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>/,
            /회원\s*계정/,
            /무단|비정상/,
            /로그인/,
            /포켓몬\s*센터|포켓몬센터|포켓몬 센터/,
            /안전/,
            /안내|요청|부탁|바랍니다/,
            /<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>[\s\S]*2025/,
            /<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>[\s\S]*감사/,
        ],
        forbidden: [
            /부정 로그인/,
            /안내\s*말씀/,
            /목소리/,
            /본론으로/,
            /실시했었습니다/,
            /[\u3040-\u30ff]/,
            /[\u3400-\u9fff]+[가-힣]+/,
        ],
        maxChars: 420,
    },
    {
        id: "ja-notice-visible-selection-ko",
        source: [
            "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
            "「会員アカウント」に対する不正ログインの発生のご報告とポケモンセンターオンラインを安全にご利用いただくためのお願い",
            "<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>",
            "2025年07月03日（木）",
            "<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>",
            "平素よりポケモンセンターオンラインをご利用いただき、ありがとうございます。",
            "<<<EDGE_TRANSLATE_SEGMENT_4 role=paragraph>>>",
            "この度、弊社サービス以外から何らかの手段で不正に入手したログインID（メールアドレス）とパスワードの情報を用いて、ポケモンセンターオンラインに不正ログインを行ったと思われる事象が発生していることを確認いたしましたため、被害の拡大防止のため緊急メンテナンスを実施させていただいておりました。",
            "<<<EDGE_TRANSLATE_SEGMENT_5 role=paragraph>>>",
            "そこで会員の皆様のアカウントの安全を考慮いたしまして、すべての会員アカウントに対し、パスワードをリセットさせていただきました。",
            "<<<EDGE_TRANSLATE_SEGMENT_6 role=paragraph>>>",
            "また、不正ログイン後、第三者から会員情報書き換えがあったことが疑われるアカウントについては停止させていただきました。予めご了承ください。",
            "<<<EDGE_TRANSLATE_SEGMENT_7 role=paragraph>>>",
            "この件で多大なるご迷惑とご心配をおかけしておりますことを、深くお詫び申し上げます。",
            "<<<EDGE_TRANSLATE_SEGMENT_8 role=title>>>",
            "【お客様ヘのお願い】",
        ].join("\n"),
        from: "ja",
        to: "ko",
        expectedGood: [
            "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>",
            "회원 계정 무단 로그인 발생 보고 및 포켓몬센터 온라인 안전 이용 안내",
            "<<<EDGE_TRANSLATE_SEGMENT_2 role=date>>>",
            "2025년 07월 03일(목)",
            "<<<EDGE_TRANSLATE_SEGMENT_3 role=paragraph>>>",
            "평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
            "<<<EDGE_TRANSLATE_SEGMENT_4 role=paragraph>>>",
            "최근 당사 서비스 외부에서 부정하게 입수된 로그인 ID와 비밀번호를 사용해 포켓몬센터 온라인에 무단 로그인한 것으로 의심되는 일이 확인되어 피해 확산 방지를 위한 긴급 점검을 실시했습니다.",
            "<<<EDGE_TRANSLATE_SEGMENT_5 role=paragraph>>>",
            "회원 여러분의 계정 안전을 고려하여 모든 회원 계정의 비밀번호를 재설정했습니다.",
            "<<<EDGE_TRANSLATE_SEGMENT_6 role=paragraph>>>",
            "또한 무단 로그인 후 제3자가 회원 정보를 변경한 것으로 의심되는 계정은 정지했습니다. 양해 부탁드립니다.",
            "<<<EDGE_TRANSLATE_SEGMENT_7 role=paragraph>>>",
            "이번 일로 큰 불편과 걱정을 드려 깊이 사과드립니다.",
            "<<<EDGE_TRANSLATE_SEGMENT_8 role=title>>>",
            "【고객님께 드리는 안내】",
        ].join("\n"),
        required: [
            /<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>/,
            /<<<EDGE_TRANSLATE_SEGMENT_4 role=paragraph>>>/,
            /회원\s*계정/,
            /무단|비정상/,
            /로그인/,
            /포켓몬\s*센터|포켓몬센터|포켓몬 센터/,
            /비밀번호/,
            /재설정/,
            /고객/,
        ],
        forbidden: [
            /안내\s*말씀/,
            /있었으로/,
            /[\u3040-\u30ff]/,
            /[\u3400-\u9fff]+[가-힣]+/,
            /(불편과 걱정|불편과 우려)[\s\S]{0,60}\1/,
        ],
        maxChars: 1200,
    },
    {
        id: "en-settings-label-ja",
        source: "Account security settings",
        from: "en",
        to: "ja",
        expectedGood: "アカウントのセキュリティ設定",
        required: [/アカウント/, /設定/],
        forbidden: [/です[。．]?$/, /ます[。．]?$/],
        maxChars: 40,
    },
    {
        id: "ko-notice-heading-en",
        source: "회원 계정 보안 안내",
        from: "ko",
        to: "en",
        expectedGood: "Member Account Security Notice",
        required: [/account/i, /security/i, /notice|guide|guidance|information/i],
        forbidden: [/^This is/i, /\.$/],
        maxChars: 60,
    },
    {
        id: "zh-service-heading-ko",
        source: "关于账户异常登录发生情况及安全使用服务的通知",
        from: "zh-CN",
        to: "ko",
        expectedGood: "계정 이상 로그인 발생 및 안전한 서비스 이용 안내",
        required: [/계정/, /이상|비정상|무단/, /로그인/, /안전/, /서비스/, /안내|공지/],
        forbidden: [/입니다[.!?。．]?$/, /합니다[.!?。．]?$/, /[\u3400-\u9fff]/],
        maxChars: 70,
    },
    {
        id: "ar-menu-label-en",
        source: "إعدادات أمان حساب المستخدم",
        from: "ar",
        to: "en",
        expectedGood: "User Account Security Settings",
        required: [/user/i, /account/i, /security/i, /settings/i],
        forbidden: [/^This is/i, /\.$/],
        maxChars: 60,
    },
    {
        id: "ja-thanks-sentence-ko",
        source: "平素よりポケモンセンターオンラインをご利用いただき、ありがとうございます。",
        from: "ja",
        to: "ko",
        expectedGood: "평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
        required: [/평소|항상/, /포켓몬\s*센터|포켓몬센터|포켓몬 센터/, /온라인/, /이용/, /감사/],
        forbidden: [/[\u3040-\u30ff]/],
        maxChars: 90,
    },
    {
        id: "en-password-action-ko",
        source: "Please reset your password before signing in again.",
        from: "en",
        to: "ko",
        expectedGood: "다시 로그인하기 전에 비밀번호를 재설정해 주세요.",
        required: [/비밀번호/, /재설정/, /로그인/, /전|전에/],
        forbidden: [/password|signing/i],
        maxChars: 80,
    },
    {
        id: "ko-password-action-ja",
        source: "비밀번호 재설정 후 다시 로그인해 주세요.",
        from: "ko",
        to: "ja",
        expectedGood: "パスワードを再設定してから、再度ログインしてください。",
        required: [/パスワード/, /再設定|リセット/, /ログイン/],
        forbidden: [/[가-힣]/],
        maxChars: 80,
    },
    {
        id: "de-account-settings-en",
        source: "Bitte überprüfen Sie Ihre Kontoeinstellungen.",
        from: "de",
        to: "en",
        expectedGood: "Please check your account settings.",
        required: [/check|review|verify/i, /account/i, /settings/i],
        forbidden: [/Kontoeinstellungen|überprüfen/i],
        maxChars: 80,
    },
    {
        id: "fr-security-suspension-ko",
        source: "Votre compte a été temporairement suspendu pour des raisons de sécurité.",
        from: "fr",
        to: "ko",
        expectedGood: "보안상의 이유로 계정이 일시적으로 정지되었습니다.",
        required: [/계정/, /일시|임시/, /정지|중지|제한/, /보안/],
        forbidden: [/compte|sécurité/i],
        maxChars: 90,
    },
    {
        id: "es-save-question-en",
        source: "¿Quieres guardar los cambios antes de salir?",
        from: "es",
        to: "en",
        expectedGood: "Do you want to save changes before exiting?",
        required: [/save/i, /changes/i, /before/i, /exit|leav/i],
        forbidden: [/guardar|cambios|salir/i],
        maxChars: 90,
    },
    {
        id: "ru-update-warning-ko",
        source: "Обновление может занять несколько минут.",
        from: "ru",
        to: "ko",
        expectedGood: "업데이트에는 몇 분 정도 걸릴 수 있습니다.",
        required: [/업데이트/, /몇\s*분|수\s*분/, /걸릴|소요/],
        forbidden: [/[А-Яа-яЁё]/],
        maxChars: 80,
    },
    {
        id: "vi-privacy-notice-en",
        source: "Chúng tôi đã cập nhật chính sách quyền riêng tư.",
        from: "vi",
        to: "en",
        expectedGood: "We have updated the privacy policy.",
        required: [/updated|update/i, /privacy/i, /policy/i],
        forbidden: [/quyền|riêng|tư/i],
        maxChars: 90,
    },
    {
        id: "en-url-preservation-ko",
        source: "Visit https://example.com/reset?token=ABC123 to reset your password.",
        from: "en",
        to: "ko",
        expectedGood: "비밀번호를 재설정하려면 https://example.com/reset?token=ABC123 에 방문하세요.",
        required: [/https:\/\/example\.com\/reset\?token=ABC123/, /비밀번호/, /재설정/],
        forbidden: [/password/i],
        maxChars: 120,
    },
    {
        id: "en-segment-marker-ko",
        source: "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>\nAccount settings\n<<<EDGE_TRANSLATE_SEGMENT_2 role=paragraph>>>\nReset password",
        from: "en",
        to: "ko",
        expectedGood: "<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>\n계정 설정\n<<<EDGE_TRANSLATE_SEGMENT_2 role=paragraph>>>\n비밀번호 재설정",
        required: [
            /<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>[\s\S]*계정[\s\S]*설정[\s\S]*<<<EDGE_TRANSLATE_SEGMENT_2 role=paragraph>>>[\s\S]*비밀번호[\s\S]*재설정/,
            /<<<EDGE_TRANSLATE_SEGMENT_1 role=title>>>/,
            /<<<EDGE_TRANSLATE_SEGMENT_2 role=paragraph>>>/,
            /계정/,
            /설정/,
            /비밀번호/,
            /재설정/,
        ],
        forbidden: [/Account settings|Reset password/i],
        maxChars: 120,
    },
];

function scoreTranslation(fixture, output) {
    const text = String(output || "").trim();
    const missing = fixture.required.filter((pattern) => !pattern.test(text)).length;
    const forbidden = fixture.forbidden.filter((pattern) => pattern.test(text)).length;
    const lengthPenalty = text.length > fixture.maxChars ? 1 : 0;
    const emptyPenalty = text ? 0 : 3;
    const score = Math.max(0, 100 - missing * 18 - forbidden * 25 - lengthPenalty * 10 - emptyPenalty * 30);
    return { score, missing, forbidden, lengthPenalty, text };
}

function mockFetch() {
    let calls = 0;
    let maxPromptChars = 0;
    global.fetch = async (_url, init = {}) => {
        calls += 1;
        const body = JSON.parse(String(init.body || "{}"));
        const prompt = body?.contents?.[0]?.parts?.[0]?.text || "";
        maxPromptChars = Math.max(maxPromptChars, prompt.length);
        const fixture = fixtures
            .filter((item) => prompt.includes(item.source))
            .sort((a, b) => b.source.length - a.source.length)[0];
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    candidates: [
                        {
                            content: {
                                parts: [{ text: fixture?.expectedGood || "OK" }],
                            },
                        },
                    ],
                };
            },
        };
    };
    return {
        get calls() {
            return calls;
        },
        get maxPromptChars() {
            return maxPromptChars;
        },
    };
}

function wrapLiveFetch() {
    const originalFetch = global.fetch;
    let calls = 0;
    let maxPromptChars = 0;
    global.fetch = async (url, init = {}) => {
        calls += 1;
        try {
            const body = JSON.parse(String(init.body || "{}"));
            const prompt = body?.contents?.[0]?.parts?.[0]?.text || "";
            maxPromptChars = Math.max(maxPromptChars, prompt.length);
        } catch {
            // Ignore malformed benchmark metadata; the request itself should still run.
        }
        return originalFetch(url, init);
    };
    return {
        get calls() {
            return calls;
        },
        get maxPromptChars() {
            return maxPromptChars;
        },
    };
}

async function runSuite(translator, label, iterations = 1) {
    const rows = [];
    const started = performance.now();
    for (let round = 0; round < iterations; round += 1) {
        for (const fixture of fixtures) {
            const caseStarted = performance.now();
            let result = null;
            let error = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    result = await translator.translate(fixture.source, fixture.from, fixture.to);
                    break;
                } catch (nextError) {
                    error = nextError;
                    const message = String(nextError?.errorMsg || nextError?.message || nextError);
                    if (!/high demand|temporar|try again|rate/i.test(message) || attempt === 2) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                }
            }
            if (result) {
                const scored = scoreTranslation(fixture, result.mainMeaning);
                rows.push({ label, id: fixture.id, latencyMs: performance.now() - caseStarted, ...scored });
            } else {
                rows.push({
                    label,
                    id: fixture.id,
                    latencyMs: performance.now() - caseStarted,
                    score: 0,
                    missing: fixture.required.length,
                    forbidden: 0,
                    lengthPenalty: 0,
                    text: `ERROR: ${error?.errorMsg || error?.message || error}`,
                });
            }
        }
    }
    return { rows, totalMs: performance.now() - started };
}

function printRows(rows) {
    for (const row of rows) {
        console.log(
            `${row.label} ${row.id}: score=${row.score} latency=${row.latencyMs.toFixed(
                1
            )}ms text=${JSON.stringify(row.text)}`
        );
    }
}

function summarizeRows(rows) {
    const byLabel = new Map();
    for (const row of rows) {
        const bucket = byLabel.get(row.label) || { label: row.label, count: 0, score: 0, latencyMs: 0 };
        bucket.count += 1;
        bucket.score += row.score;
        bucket.latencyMs += row.latencyMs;
        byLabel.set(row.label, bucket);
    }
    return [...byLabel.values()].map((bucket) => ({
        label: bucket.label,
        count: bucket.count,
        avgScore: bucket.score / Math.max(bucket.count, 1),
        avgLatencyMs: bucket.latencyMs / Math.max(bucket.count, 1),
    }));
}

function printBenchmarkSummary(summaries, baselineLabel) {
    const baseline = summaries.find((item) => item.label === baselineLabel);
    for (const item of summaries) {
        const comparison =
            baseline && item.label !== baselineLabel
                ? ` scoreDelta=${(item.avgScore - baseline.avgScore).toFixed(1)} latencyDelta=${(
                      item.avgLatencyMs - baseline.avgLatencyMs
                  ).toFixed(1)}ms`
                : "";
        console.log(
            `average ${item.label}: score=${item.avgScore.toFixed(1)} latency=${item.avgLatencyMs.toFixed(
                1
            )}ms count=${item.count}${comparison}`
        );
    }
}

if (live && !apiKey) {
    console.error(
        "Live benchmark requested, but GOOGLE_AI_STUDIO_API_KEY or GEMINI_API_KEY is not set."
    );
    process.exit(2);
}

const fetchStats = live ? wrapLiveFetch() : mockFetch();
const bingTranslator = includeBingBaseline ? new BingTranslator() : null;
const localTranslator = new LocalTranslator({
    enabled: true,
    mode: "googleAiStudio",
    apiKey: apiKey || "mock-key",
    model,
    timeoutMs: 120000,
});
const hybridTranslator = new HybridTranslator(
    {
        translators: ["LocalTranslate"],
        selections: {
            originalText: "LocalTranslate",
            mainMeaning: "LocalTranslate",
            detailedMeanings: "LocalTranslate",
            definitions: "LocalTranslate",
            examples: "LocalTranslate",
            sourceLanguage: "LocalTranslate",
            targetLanguage: "LocalTranslate",
        },
    },
    {},
    {
        enabled: true,
        mode: "googleAiStudio",
        apiKey: apiKey || "mock-key",
        model,
        timeoutMs: 120000,
    }
);

const bingRun = bingTranslator ? await runSuite(bingTranslator, "live-bing") : { rows: [] };
const localRun = await runSuite(localTranslator, live ? "live-local" : "mock-local");
const hybridRun = await runSuite(hybridTranslator, live ? "live-hybrid" : "mock-hybrid");
const rows = [...bingRun.rows, ...localRun.rows, ...hybridRun.rows];
const evaluationRows = [...localRun.rows, ...hybridRun.rows];
printRows(rows);
printBenchmarkSummary(summarizeRows(rows), includeBingBaseline ? "live-bing" : "");

const minScore = Math.min(...evaluationRows.map((row) => row.score));
const averageLatency =
    evaluationRows.reduce((total, row) => total + row.latencyMs, 0) /
    Math.max(evaluationRows.length, 1);
const expectedCalls = live ? evaluationRows.length : fixtures.length * 2;
const maxFixtureChars = Math.max(...fixtures.map((fixture) => fixture.source.length));
const maxPromptCharsBudget = maxFixtureChars + 900;

console.log(
    `summary: mode=${live ? "live" : "mock"} minScore=${minScore} avgLatency=${averageLatency.toFixed(
        1
    )}ms fetches=${fetchStats.calls} maxPromptChars=${fetchStats.maxPromptChars}`
);

const failures = [];
if (minScore < 80) failures.push(`min quality score ${minScore} < 80`);
if (fetchStats.maxPromptChars > maxPromptCharsBudget) {
    failures.push(`max prompt chars ${fetchStats.maxPromptChars} > ${maxPromptCharsBudget}`);
}
if (!live && fetchStats.calls !== expectedCalls) {
    failures.push(`mock fetch count ${fetchStats.calls} !== ${expectedCalls}`);
}

if (failures.length) {
    console.error(`benchmark failed: ${failures.join("; ")}`);
    process.exit(1);
}

console.log("benchmark passed.");
