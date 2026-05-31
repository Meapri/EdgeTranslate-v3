import LocalTranslator from "../src/translators/local";

describe("LocalTranslator multilingual quality prompts", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    const cases = [
        {
            name: "Japanese notice heading to Korean keeps heading style",
            text: "「会員アカウント」に対する不正ログインの発生のご報告とポケモンセンターオンラインを安全にご利用いただくためのお願い",
            from: "ja",
            to: "ko",
            output: "회원 계정 무단 로그인 발생 보고 및 포켓몬센터 온라인 안전 이용 안내",
            promptChecks: [
                "Translate faithfully and naturally",
                "Keep the same text form",
                "Do not summarize, explain, or add information",
                "Use the target language's customary writing system.",
                "For Han-script source text",
                "complete semantic units",
                "Never create mixed-script words by combining source-script characters",
                "Preserve proper nouns and official names",
                "Use a localized or translated proper-name form only when it is clearly established",
            ],
        },
        {
            name: "English settings label to Japanese stays a label",
            text: "Account security settings",
            from: "en",
            to: "ja",
            output: "アカウントのセキュリティ設定",
            promptChecks: ["Translate faithfully and naturally", "Keep the same text form"],
        },
        {
            name: "Korean notice title to English stays concise",
            text: "회원 계정 보안 안내",
            from: "ko",
            to: "en",
            output: "Member Account Security Notice",
            promptChecks: ["Translate faithfully and naturally", "Keep the same text form"],
        },
        {
            name: "Chinese service heading to Korean stays a heading",
            text: "关于账户异常登录发生情况及安全使用服务的通知",
            from: "zh-CN",
            to: "ko",
            output: "계정 이상 로그인 발생 및 안전한 서비스 이용 안내",
            promptChecks: [
                "Translate faithfully and naturally",
                "Keep the same text form",
                "Preserve proper nouns and official names",
                "Use a localized or translated proper-name form only when it is clearly established",
            ],
        },
        {
            name: "Arabic menu label to English stays a label",
            text: "إعدادات أمان حساب المستخدم",
            from: "ar",
            to: "en",
            output: "User Account Security Settings",
            promptChecks: ["Translate faithfully and naturally", "Keep the same text form"],
        },
        {
            name: "Japanese complete sentence to Korean keeps sentence style",
            text: "平素よりポケモンセンターオンラインをご利用いただき、ありがとうございます。",
            from: "ja",
            to: "ko",
            output: "평소 포켓몬센터 온라인을 이용해 주셔서 감사합니다.",
            promptChecks: [
                "Translate faithfully and naturally",
                "Do not summarize",
                "Preserve proper nouns and official names",
                "Before finalizing, rewrite any remaining source-language fragment",
            ],
        },
        {
            name: "English password action to Korean preserves instruction intent",
            text: "Please reset your password before signing in again.",
            from: "en",
            to: "ko",
            output: "다시 로그인하기 전에 비밀번호를 재설정해 주세요.",
            promptChecks: [
                "Translate faithfully and naturally",
                "Do not summarize",
                "Preserve proper nouns and official names",
                "Source-language text is forbidden in the output",
            ],
        },
        {
            name: "German account sentence to English stays a sentence",
            text: "Bitte überprüfen Sie Ihre Kontoeinstellungen.",
            from: "de",
            to: "en",
            output: "Please check your account settings.",
            promptChecks: ["Translate faithfully and naturally"],
        },
        {
            name: "English URL instruction to Korean keeps URL unchanged",
            text: "Visit https://example.com/reset?token=ABC123 to reset your password.",
            from: "en",
            to: "ko",
            output: "비밀번호를 재설정하려면 https://example.com/reset?token=ABC123 에 방문하세요.",
            promptChecks: [
                "Respect the original formatting",
                "Source-language text is forbidden in the output",
            ],
        },
        {
            name: "English segmented text to Korean keeps segment markers",
            text: "[[1:t]]\nAccount settings\n[[2:p]]\nReset password",
            from: "en",
            to: "ko",
            output: "[[1:t]]\n계정 설정\n[[2:p]]\n비밀번호 재설정",
            promptChecks: ["English>Korean"],
        },
    ];

    test.each(cases)("$name", async ({ text, from, to, output, promptChecks }) => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: output }] } }],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });

        const result = await translator.translate(text, from, to);

        expect(result.mainMeaning).toBe(output);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const userPrompt = body.contents[0].parts[0].text;
        const systemPrompt = body.systemInstruction.parts[0].text;
        // The new design keeps generic quality directives in the system prompt (cache-friendly
        // across requests) and per-request directives in the user message. Quality checks pass
        // when the directive lands in either slot of the request.
        const combined = `${systemPrompt}\n${userPrompt}`;
        if (/\[\[\d+:[a-z][a-z0-9-]*]]|<<<EDGE_TRANSLATE_SEGMENT_\d+/.test(text)) {
            expect(userPrompt).toContain(`${from === "en" ? "English" : from}>`);
            expect(systemPrompt).toContain("Translate each [[n]] segment");
        } else {
            expect(userPrompt).toContain("Translate the user's text");
        }
        expect(combined).not.toContain("word or short term");
        for (const check of promptChecks) {
            expect(combined).toContain(check);
        }
    });

    test("returns AI Studio output without hard-coded terminology replacement", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [{ text: "회원 계정 부정 로그인 발생 보고 및 안전 이용 안내" }],
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });

        const result = await translator.translate(
            "「会員アカウント」に対する不正ログインの発生のご報告と安全にご利用いただくためのお願い",
            "ja",
            "ko"
        );

        expect(result.mainMeaning).toBe("회원 계정 부정 로그인 발생 보고 및 안전 이용 안내");
    });

    test("prompts against mixed-script Korean words such as copied Japanese or Chinese kanji", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [{ text: "국세조사 사칭 의심스러운 이메일" }],
                        },
                    },
                ],
            }),
        });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });

        const result = await translator.translate("国勢調査を装った不審なメール", "ja", "ko");

        expect(result.mainMeaning).toBe("국세조사 사칭 의심스러운 이메일");
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const userPrompt = body.contents[0].parts[0].text;
        const systemPrompt = body.systemInstruction.parts[0].text;
        const combined = `${systemPrompt}\n${userPrompt}`;
        expect(userPrompt).toContain("Translate the user's text");
        expect(combined).not.toContain("word or short term");
        expect(combined).toContain("Use the target language's customary writing system.");
        expect(combined).toContain(
            "Never create mixed-script words by combining source-script characters"
        );
        expect(combined).toContain("For Han-script source text");
        expect(combined).toContain("complete semantic units");
        expect(combined).toContain("Do not partially translate compound nouns");
        expect(combined).toContain("Silently scan the final answer for mixed-script words");
    });

    test("repairs only mixed-script fragments from Google AI Studio output", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                parts: [{ text: "국勢조사 사칭 의심스러운 이메일" }],
                            },
                        },
                    ],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        text: JSON.stringify({
                                            repairs: [
                                                {
                                                    source: "국勢조사",
                                                    translation: "국세조사",
                                                },
                                            ],
                                        }),
                                    },
                                ],
                            },
                        },
                    ],
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });

        const result = await translator.translate("国勢調査を装った不審なメール", "ja", "ko");

        expect(result.mainMeaning).toBe("국세조사 사칭 의심스러운 이메일");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const repairBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        const repairPrompt = repairBody.contents[0].parts[0].text;
        expect(repairPrompt).toContain("Repair only the listed problematic fragments");
        expect(repairPrompt).toContain("Do not retranslate the whole sentence or paragraph");
        expect(repairPrompt).toContain("Keep the same grammatical span as the fragment");
        expect(repairPrompt).toContain("국勢조사");
        expect(repairPrompt).toContain("国勢調査を装った不審なメール");
    });

    test("rejects over-expanded fragment repairs that absorb neighboring context", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                parts: [{ text: "국勢조사 사칭 의심스러운 이메일" }],
                            },
                        },
                    ],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        text: JSON.stringify({
                                            repairs: [
                                                {
                                                    source: "국勢조사",
                                                    translation: "인구 조사 등을 빙자한",
                                                },
                                            ],
                                        }),
                                    },
                                ],
                            },
                        },
                    ],
                }),
            });
        global.fetch = fetchMock as any;

        const translator = new LocalTranslator({
            enabled: true,
            mode: "googleAiStudio",
            apiKey: "studio-test-key",
        });

        const result = await translator.translate("国勢調査を装った不審なメール", "ja", "ko");

        expect(result.mainMeaning).toBe("국勢조사 사칭 의심스러운 이메일");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
