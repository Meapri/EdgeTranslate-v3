import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const extensionDir =
    process.env.EDGE_TRANSLATE_EXTENSION_DIR ||
    path.join(repoRoot, "packages/EdgeTranslate/build/chrome");
const chromeBin =
    process.env.CHROME_BIN ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const remotePort = Number(process.env.CHROME_REMOTE_DEBUGGING_PORT || 9444);
const profileDir =
    process.env.CHROME_USER_DATA_DIR || mkdtempSync(path.join(os.tmpdir(), "edge-translate-smoke-"));

const fixtures = [
    {
        id: "ja-visible-selection-ko",
        text: [
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
        ].join("\n"),
        from: "ja",
        to: "ko",
        required: [/회원\s*계정/, /무단|비정상/, /로그인/, /포켓몬/, /비밀번호/, /재설정/],
        forbidden: [/[\u3040-\u30ff]/, /[\u3400-\u9fff]+[가-힣]+/, /안내\s*말씀/, /있었으로/],
    },
];

class CdpClient {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.ws.on("message", (data) => {
            const message = JSON.parse(String(data));
            if (!message.id || !this.pending.has(message.id)) return;
            const { resolve, reject } = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.result);
        });
    }

    async open() {
        await new Promise((resolve, reject) => {
            this.ws.once("open", resolve);
            this.ws.once("error", reject);
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    close() {
        this.ws.close();
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openJson(endpoint, init) {
    const response = await fetch(`http://127.0.0.1:${remotePort}${endpoint}`, init);
    if (!response.ok) throw new Error(`${endpoint} failed with ${response.status}`);
    return response.json();
}

async function waitForChrome() {
    for (let i = 0; i < 50; i += 1) {
        try {
            return await openJson("/json/list");
        } catch {
            await delay(200);
        }
    }
    throw new Error("Chrome DevTools endpoint did not become available.");
}

async function findExtensionId() {
    const managerPage = await openJson(`/json/new?${encodeURIComponent("chrome://extensions")}`, {
        method: "PUT",
    });
    const cdp = new CdpClient(managerPage.webSocketDebuggerUrl);
    await cdp.open();
    try {
        await cdp.send("Runtime.enable");
        for (let i = 0; i < 30; i += 1) {
            const evaluated = await cdp.send("Runtime.evaluate", {
                expression: `
                    (() => {
                        const manager = document.querySelector("extensions-manager");
                        const list = manager?.shadowRoot
                            ?.querySelector("extensions-item-list")
                            ?.shadowRoot
                            ?.querySelectorAll("extensions-item");
                        return Array.from(list || []).map((item) => ({
                            id: item.getAttribute("id"),
                            name: item.shadowRoot?.querySelector("#name")?.textContent?.trim() || ""
                        }));
                    })()
                `,
                returnByValue: true,
            });
            const items = evaluated?.result?.value || [];
            const edgeTranslate = items.find((item) => item.name === "Edge Translate");
            if (edgeTranslate?.id) return edgeTranslate.id;
            await delay(300);
        }
    } finally {
        cdp.close();
    }
    throw new Error("Could not find the loaded Edge Translate extension in chrome://extensions.");
}

async function runFixture(extensionId, fixture) {
    const page = await openJson(
        `/json/new?${encodeURIComponent(
            `chrome-extension://${extensionId}/offscreen/chrome_prompt.html`
        )}`,
        { method: "PUT" }
    );
    const cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.open();
    try {
        await cdp.send("Runtime.enable");
        const expression = `
            new Promise((resolve) => {
                chrome.runtime.sendMessage(${JSON.stringify(
                    JSON.stringify({
                        type: "chrome_prompt_translate",
                        text: fixture.text,
                        from: fixture.from,
                        to: fixture.to,
                    })
                )}, (response) => {
                    resolve({
                        response,
                        lastError: chrome.runtime.lastError && chrome.runtime.lastError.message,
                        hasLanguageModel: !!globalThis.LanguageModel,
                    });
                });
            })
        `;
        const evaluated = await cdp.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        const value = evaluated?.result?.value;
        if (!value?.response?.ok) {
            throw new Error(
                value?.lastError ||
                    value?.response?.error?.message ||
                    "Chrome extension on-device translation failed."
            );
        }
        const output = String(
            value.response.result?.mainMeaning || value.response.result?.translatedText || ""
        ).trim();
        const missing = fixture.required.filter((pattern) => !pattern.test(output));
        const forbidden = fixture.forbidden.filter((pattern) => pattern.test(output));
        console.log(`${fixture.id}: ${JSON.stringify(output)}`);
        if (missing.length || forbidden.length) {
            throw new Error(
                `${fixture.id} failed quality gate: missing=${missing.length} forbidden=${forbidden.length}`
            );
        }
    } finally {
        cdp.close();
    }
}

const chrome = spawn(
    chromeBin,
    [
        `--remote-debugging-port=${remotePort}`,
        `--user-data-dir=${profileDir}`,
        `--load-extension=${extensionDir}`,
        `--disable-extensions-except=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--lang=ko-KR",
        "about:blank",
    ],
    { stdio: "ignore" }
);

try {
    await waitForChrome();
    const extensionId = await findExtensionId();
    for (const fixture of fixtures) {
        await runFixture(extensionId, fixture);
    }
} finally {
    chrome.kill("SIGTERM");
    if (!process.env.CHROME_USER_DATA_DIR) {
        await delay(500);
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
    }
}
