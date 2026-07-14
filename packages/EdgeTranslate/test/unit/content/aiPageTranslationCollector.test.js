import {
    collectPage,
    collectSubtreeTargets,
    hasTranslatableText,
} from "../../../src/content/ai_page_translation/dom/collector.js";
import { isTranslationOrderRepresentable } from "../../../src/content/ai_page_translation/dom/block_ir.js";
import { TargetRegistry } from "../../../src/content/ai_page_translation/dom/target_registry.js";

const PT3_ROLES = new Set(["p", "h", "li", "cell", "alt", "ph", "aria", "val"]);

function makeRegistry() {
    return new TargetRegistry("session-collector");
}

async function collectAll(root, registry, options = {}) {
    const result = collectPage(root, registry, options);
    const fullDoc = await result.fullDocPromise;
    return {
        viewportTargets: result.viewportTargets,
        fullDoc,
        stats: result.stats,
        all: [...result.viewportTargets, ...fullDoc.targets],
    };
}

function sourcesOf(entries) {
    return entries.map((entry) => entry.target.source);
}

describe("ai page translation vNext collector", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    describe("script coverage inversion (spec §9, Gate A pins)", () => {
        const SCRIPT_FIXTURES = [
            ["Thai", "สวัสดีชาวโลกทั้งหลาย"],
            ["Lao", "ສະບາຍດີຊາວໂລກ"],
            ["Myanmar", "မင်္ဂလာပါကမ္ဘာလောက"],
            ["Khmer", "សួស្តីពិភពលោក"],
            ["Tibetan", "བཀྲ་ཤིས་བདེ་ལེགས།"],
            ["Georgian", "გამარჯობა მსოფლიო"],
            ["Armenian", "Բարեւ աշխարհ"],
            ["Ethiopic", "ሰላም ለዓለም"],
            ["half-width katakana", "ﾊﾛｰﾜｰﾙﾄﾞﾃｷｽﾄ"],
            ["astral CJK", "𠮷野家で𩸽を食べる"],
        ];

        test.each(SCRIPT_FIXTURES)("collects nonzero targets for %s", async (name, text) => {
            document.body.innerHTML = `<p>${text}</p>`;
            const registry = makeRegistry();
            const { all } = await collectAll(document.body, registry);
            const hits = all.filter((entry) => entry.target.source.includes(text));
            expect(hits.length).toBeGreaterThan(0);
        });
    });

    test("collects the whole document once regardless of viewport position", async () => {
        document.body.innerHTML = [
            "<p id='near'>화면 안의 문단</p>",
            "<p id='above'>한 화면 위의 문단</p>",
            "<p id='far'>멀리 있는 문단</p>",
        ].join("");
        const rectReads = jest.fn();
        for (const element of document.querySelectorAll("p")) {
            element.getBoundingClientRect = rectReads;
        }

        const registry = makeRegistry();
        const { viewportTargets, fullDoc } = await collectAll(document.body, registry);

        expect(sourcesOf(viewportTargets)).toEqual([
            "화면 안의 문단",
            "한 화면 위의 문단",
            "멀리 있는 문단",
        ]);
        expect(fullDoc.targets).toEqual([]);
        expect(rectReads).not.toHaveBeenCalled();
    });

    test("captures punctuation routing nodes so an identity inline order is representable", async () => {
        document.body.innerHTML = "<p id='line'>（<a>対象</a>）説明</p>";
        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);
        const entry = all.find((candidate) => candidate.element?.id === "line");

        expect(entry.target.textNodes.map((node) => node.source)).toEqual(["（", "対象", "）説明"]);
        expect(
            isTranslationOrderRepresentable(
                entry.ir.source,
                entry.ir.placeholderInventory,
                entry.ir.applyMap
            )
        ).toMatchObject({ ok: true, routedNodeIndexes: [0, 1, 2] });
    });

    test("exposes a bounded glossary seed from the same whole-document walk", async () => {
        document.body.innerHTML = [
            "<main id='root'>",
            "<p>Visible introduction</p>",
            "<p data-below>Keihan Railway first mention</p>",
            "<p data-below>Keihan Railway second mention</p>",
            "<p data-below>Keihan Railway third mention</p>",
            "</main>",
        ].join("");
        const registry = makeRegistry();
        const result = collectPage(document.getElementById("root"), registry);

        expect(sourcesOf(result.viewportTargets)).toHaveLength(4);
        expect(result.contextSeedBlocks.join(" ")).toContain("Keihan Railway third mention");
        expect(result.contextSeedBlocks.length).toBeLessThanOrEqual(512);
        await result.fullDocPromise;
    });

    test("legacy viewport timing options cannot reintroduce a partial collection", async () => {
        document.body.innerHTML = Array.from(
            { length: 6 },
            (unused, index) => `<p>느린 페이지 문단 ${index + 1}</p>`
        ).join("");
        const registry = makeRegistry();
        const { viewportTargets, fullDoc, all } = await collectAll(document.body, registry, {
            viewportBudgetMs: 0,
            idleSliceMs: 0,
            scheduleIdle: () => {
                throw new Error("single-pass collection must not schedule an idle phase");
            },
        });

        expect(viewportTargets).toHaveLength(6);
        expect(all).toHaveLength(6);
        expect(fullDoc.targets).toEqual([]);
    });

    test("performs zero layout/rect passes during collection", async () => {
        document.body.innerHTML = [
            "<p>첫 번째 문단</p>",
            "<p>두 번째 문단</p>",
            "<img alt='산 풍경 사진'>",
        ].join("");
        const measureRects = jest.fn((elements) =>
            elements.map((element) => element.getBoundingClientRect())
        );

        const registry = makeRegistry();
        const result = collectPage(document.body, registry, { measureRects });

        expect(measureRects).not.toHaveBeenCalled();
        expect(result.stats.rectPasses).toBe(0);
        expect(result.viewportTargets.length).toBeGreaterThan(0);
        await result.fullDocPromise;
        expect(result.stats.rectPasses).toBe(0);
    });

    test("every registered target carries an explicit pt3 role — none default to 'text'", async () => {
        document.body.innerHTML = [
            "<h2>제목입니다</h2>",
            "<ul><li>목록 항목</li></ul>",
            "<table><tr><th abbr='인구'>인구 통계</th><td>세포 내용</td></tr></table>",
            "<p>본문 문단</p>",
            "<img alt='산 풍경'>",
            "<input placeholder='검색어 입력'>",
            "<button aria-label='닫기 버튼'>×</button>",
            "<input type='submit' value='전송하기'>",
        ].join("");

        const registry = makeRegistry();
        await collectAll(document.body, registry);
        const targets = registry.list();
        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(PT3_ROLES.has(target.role)).toBe(true);
            expect(target.role).not.toBe("text");
        }
    });

    test("maps pt3 roles: h / li / cell / p blocks and alt / ph / aria / val attributes", async () => {
        document.body.innerHTML = [
            "<h2>제목입니다</h2>",
            "<ul><li>목록 항목</li></ul>",
            "<table><tr><th abbr='인구'>인구 통계</th><td>세포 내용</td></tr></table>",
            "<p>본문 문단</p>",
            "<img alt='산 풍경'>",
            "<input placeholder='검색어 입력'>",
            "<button aria-label='닫기 버튼'>×</button>",
            "<input type='submit' value='전송하기'>",
        ].join("");

        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);
        const roleBySource = new Map(all.map((entry) => [entry.target.source, entry.target.role]));

        expect(roleBySource.get("제목입니다")).toBe("h");
        expect(roleBySource.get("목록 항목")).toBe("li");
        expect(roleBySource.get("인구 통계")).toBe("cell");
        expect(roleBySource.get("세포 내용")).toBe("cell");
        expect(roleBySource.get("본문 문단")).toBe("p");
        expect(roleBySource.get("산 풍경")).toBe("alt");
        expect(roleBySource.get("검색어 입력")).toBe("ph");
        expect(roleBySource.get("닫기 버튼")).toBe("aria");
        expect(roleBySource.get("전송하기")).toBe("val");
        expect(roleBySource.get("인구")).toBe("val");
    });

    test("single-Text-node blocks stay plain: block kind, no IR, zero placeholders", async () => {
        document.body.innerHTML = "<p>단일 텍스트 노드 문단</p>";
        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);

        expect(all).toHaveLength(1);
        const [entry] = all;
        expect(entry.kind).toBe("block");
        expect(entry.ir).toBeNull();
        expect(entry.target.kind).toBe("block");
        expect(entry.target.textNodes).toHaveLength(1);
        expect(entry.target.source).toBe("단일 텍스트 노드 문단");
        expect(entry.target.source).not.toMatch(/<g\d+>/);
    });

    test("multi-node blocks are serialized through block_ir at collection time", async () => {
        document.body.innerHTML = "<p>淀屋橋駅から<b>三条駅</b>までを結ぶ。</p>";
        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);

        expect(all).toHaveLength(1);
        const [entry] = all;
        expect(entry.kind).toBe("block");
        expect(entry.ir).not.toBeNull();
        expect(entry.ir.source).toBe("淀屋橋駅から<g1>三条駅</g1>までを結ぶ。");
        expect(entry.ir.placeholderInventory.tags).toEqual([
            { name: "g1", kind: "paired", interactive: false },
        ]);
        expect(entry.target.kind).toBe("block");
        expect(entry.target.source).toBe(entry.ir.source);
        expect(entry.target.textNodes).toHaveLength(3);
        expect(entry.target.textNodes[0].path).toEqual([]);
        expect(entry.target.textNodes[1].path).toEqual([1]);
        expect(entry.target.textNodes[2].path).toEqual([]);
    });

    test("atomicRequired blocks are planned as per-Text-node atomic items from the start", async () => {
        // Interactive wrapper at inline depth >4: depth-flattening would erase the <a>, so the
        // block must never be serialized with placeholders (spec §1.1).
        document.body.innerHTML =
            "<p><b>서문 텍스트</b>（" +
            "<span><span><span><span><a href='#deep'>깊은 링크</a></span></span></span></span>）</p>";
        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);

        expect(all).toHaveLength(2);
        for (const entry of all) {
            expect(entry.kind).toBe("atomic");
            expect(entry.target.kind).toBe("text");
            expect(entry.target.role).toBe("p");
        }
        expect(sourcesOf(all)).toEqual(["서문 텍스트", "깊은 링크"]);
        expect(registry.list().filter((target) => target.kind === "block")).toHaveLength(0);
    });

    test("li with a nested list yields the lead line and nested items as separate blocks", async () => {
        document.body.innerHTML =
            "<ul><li>1990年（平成2年）<ul><li>4月1日：開業</li><li>7月1日：延伸</li></ul></li></ul>";
        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);

        expect(sourcesOf(all)).toEqual(["1990年（平成2年）", "4月1日：開業", "7月1日：延伸"]);
        for (const entry of all) {
            expect(entry.target.role).toBe("li");
            expect(entry.target.kind).toBe("block");
        }
    });

    test("exclusion rules: translate=no, aria-hidden, code/pre, IDREF attrs, a[download], title", async () => {
        document.body.innerHTML = [
            "<div translate='no'><p>번역 금지 텍스트</p></div>",
            "<div aria-hidden='true'><p>숨겨진 텍스트</p></div>",
            "<pre>const excluded = true;</pre>",
            "<code>print(1)</code>",
            "<p aria-labelledby='some-id' title='툴팁 설명문'>참조 문단 본문</p>",
            "<a href='/f.zip' download>다운로드 파일 이름</a>",
            "<div contenteditable='true'>편집 가능 텍스트</div>",
        ].join("");

        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);
        const sources = sourcesOf(all);

        expect(sources).toEqual(["참조 문단 본문"]);
        // Neither the IDREF attribute nor the title tooltip became a target.
        expect(registry.list().filter((target) => target.kind === "attribute")).toHaveLength(0);
    });

    test("inverted translatable test excludes URLs, identifiers, hashes and pure symbols", async () => {
        document.body.innerHTML = [
            "<p>https://example.com/path</p>",
            "<p>www.example.com</p>",
            "<p>user@example.com</p>",
            "<p>d41d8cd98f00b204e9800998ecf8427e</p>",
            "<p>0f8fad5b-d9cb-469f-a165-70867728950e</p>",
            "<p>snake_case_identifier</p>",
            "<p>ns::method::call</p>",
            "<p>bundle.min.js</p>",
            "<p>★ ☆ ♥ → 123</p>",
            "<p>실제 문장 텍스트</p>",
        ].join("");

        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);
        expect(sourcesOf(all)).toEqual(["실제 문장 텍스트"]);

        expect(hasTranslatableText("https://example.com")).toBe(false);
        expect(hasTranslatableText("MY_CONSTANT_NAME")).toBe(false);
        expect(hasTranslatableText("→ ©")).toBe(false);
        expect(hasTranslatableText("문장 안의 https://example.com 링크")).toBe(true);
        expect(hasTranslatableText("สวัสดี")).toBe(true);
    });

    test("collects text inside open shadow roots", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: "open" });
        const paragraph = document.createElement("p");
        paragraph.textContent = "그림자 트리 본문";
        shadow.appendChild(paragraph);

        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);
        expect(sourcesOf(all)).toContain("그림자 트리 본문");
    });

    test("document-position order is preserved with monotonic order indexes", async () => {
        document.body.innerHTML = [
            "<h1>첫 번째 제목</h1>",
            "<p>첫 번째 문단</p>",
            "<ul><li>첫 목록</li><li>둘째 목록</li></ul>",
            "<p>마지막 문단</p>",
        ].join("");

        const registry = makeRegistry();
        const { viewportTargets } = await collectAll(document.body, registry);
        expect(sourcesOf(viewportTargets)).toEqual([
            "첫 번째 제목",
            "첫 번째 문단",
            "첫 목록",
            "둘째 목록",
            "마지막 문단",
        ]);
        const orders = viewportTargets.map((entry) => entry.order);
        for (let index = 1; index < orders.length; index += 1) {
            expect(orders[index]).toBeGreaterThan(orders[index - 1]);
        }
    });

    test("collectSubtreeTargets widens an inline mutation to the enclosing block and revises it", async () => {
        document.body.innerHTML = "<p id='blk'>Hello <b>world</b></p>";
        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);
        expect(all).toHaveLength(1);
        const original = all[0].target;
        expect(original.textNodes).toHaveLength(2);

        // Site adds a text node inside the inline wrapper: re-collection must refresh the SAME
        // registry block target with the new shape, not mint an overlapping one.
        const bold = document.querySelector("#blk b");
        const addedText = document.createTextNode(" again");
        bold.appendChild(addedText);
        const { targets } = collectSubtreeTargets([addedText], registry);

        expect(targets).toHaveLength(1);
        expect(targets[0].target.id).toBe(original.id);
        expect(targets[0].target.revision).toBe(1);
        expect(targets[0].target.textNodes).toHaveLength(3);
    });

    test("attribute targets inside blocks are still collected (img alt within a paragraph)", async () => {
        document.body.innerHTML = "<p>사진 설명 <img alt='교량 전경 사진'> 이어지는 텍스트</p>";
        const registry = makeRegistry();
        const { all } = await collectAll(document.body, registry);

        const attributeEntries = all.filter((entry) => entry.kind === "attribute");
        expect(attributeEntries).toHaveLength(1);
        expect(attributeEntries[0].target.source).toBe("교량 전경 사진");
        expect(attributeEntries[0].target.role).toBe("alt");

        const blockEntries = all.filter((entry) => entry.kind === "block");
        expect(blockEntries).toHaveLength(1);
        expect(blockEntries[0].target.textNodes).toHaveLength(2);
    });

    // Re-pinned from the deleted aiPageTranslationV2Planning suite: the extension injects its own
    // language trigger and popover into the host page (marked data-edge-translate-owned), and the
    // collector must never translate its own UI while still collecting the real page around it.
    test("excludes the extension-owned language trigger and popover subtree", async () => {
        document.body.innerHTML = [
            "<button data-edge-translate-owned>Translate this page</button>",
            "<div data-edge-translate-owned class='et-lang-popover'><span>English</span><span>Korean</span></div>",
            "<p>실제 페이지 본문</p>",
        ].join("");

        const registry = makeRegistry();
        const { all, stats } = await collectAll(document.body, registry);

        expect(sourcesOf(all)).toEqual(["실제 페이지 본문"]);
        expect(stats.skippedByReason["extension-owned"]).toBe(2);
    });
});
