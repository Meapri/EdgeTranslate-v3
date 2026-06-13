import {
    applyHtmlPageSection,
    applyPageSegments,
    buildContextTranslationGroups,
    buildSafeTranslatedHtml,
    buildSegmentedTranslationText,
    buildStrippedSectionHtml,
    buildTranslationIrBatch,
    captureLeafSegmentTexts,
    captureLeafTextsFromElement,
    collectHtmlPageSections,
    findLeafBlocksInElement,
    leafBlockOwnText,
    inferDomPageTextRole,
    isBoilerplateRegion,
    applyPageSegmentToBlock,
    splitTextIntoSentences,
    wrapLeafSentencesInSpans,
    alignSentencesProportional,
    serializeBlockSegment,
    serializeTranslationLeaf,
    splitLeafByLineBreaks,
    splitSegmentedTranslationText,
    splitTranslatedContext,
    stripPresentationAttrs,
    wrapLeafLineSegmentsInSpans,
} from "../../../src/content/dom_page_translate_context.js";

describe("DOM page translation context grouping", () => {
    it("groups sibling text nodes under the same block into one context translation request", () => {
        document.body.innerHTML = `
            <article>
                <p id="sample">
                    <span>Out of the box, the Kindle is good at only one thing.</span>
                    <span>Well, two.</span>
                    <span>It lets me buy books from Amazon and read them with very little friction.</span>
                    <span>That simplicity works well for most people, but I want customization and an experience that goes beyond the core functionality.</span>
                </p>
            </article>
        `;
        const nodes = Array.from(
            document.querySelectorAll("#sample span"),
            (span) => span.firstChild
        );

        const groups = buildContextTranslationGroups(nodes);

        expect(groups).toHaveLength(1);
        expect(groups[0].nodes).toEqual(nodes);
        expect(groups[0].role).toBe("paragraph");
        expect(groups[0].sourceText).toBe(
            [
                "Out of the box, the Kindle is good at only one thing.",
                "Well, two.",
                "It lets me buy books from Amazon and read them with very little friction.",
                "That simplicity works well for most people, but I want customization and an experience that goes beyond the core functionality.",
            ].join("\n")
        );
    });

    it("splits generic text containers into one segment per text node", () => {
        document.body.innerHTML = `
            <div id="generic">
                <span>First generic fragment that should not require line-count preservation.</span>
                <span>Second generic fragment that should travel as its own segment.</span>
            </div>
        `;
        const nodes = Array.from(
            document.querySelectorAll("#generic span"),
            (span) => span.firstChild
        );

        const groups = buildContextTranslationGroups(nodes);

        expect(groups).toHaveLength(2);
        expect(groups.map((group) => group.role)).toEqual(["text", "text"]);
        expect(groups.map((group) => group.nodes)).toEqual([[nodes[0]], [nodes[1]]]);
    });

    it("infers DOM text roles for page translation hints", () => {
        document.body.innerHTML = `
            <article>
                <h1 id="title">Notice title</h1>
                <p class="time" id="date">2025年07月03日（木）</p>
                <p id="body">Article body text.</p>
                <button id="button">Translate</button>
            </article>
        `;

        expect(inferDomPageTextRole(document.getElementById("title"))).toBe("title");
        expect(inferDomPageTextRole(document.getElementById("date"))).toBe("date");
        expect(inferDomPageTextRole(document.getElementById("body"))).toBe("paragraph");
        expect(inferDomPageTextRole(document.getElementById("button"))).toBe("label");
    });

    it("splits translated context lines back to matching source text nodes", () => {
        const translated = [
            "기본 상태에서 Kindle은 한 가지를 잘합니다.",
            "아니, 두 가지죠.",
            "Amazon에서 책을 사고 거의 불편함 없이 읽게 해줍니다.",
        ].join("\n");

        expect(splitTranslatedContext(translated, 3)).toEqual([
            "기본 상태에서 Kindle은 한 가지를 잘합니다.",
            "아니, 두 가지죠.",
            "Amazon에서 책을 사고 거의 불편함 없이 읽게 해줍니다.",
        ]);
    });

    it("uses a larger context window for Google AI Studio API page translation chunks", () => {
        document.body.innerHTML = `
            <article>
                <p id="sample">
                    <span>${"A".repeat(1800)}</span>
                    <span>${"B".repeat(1800)}</span>
                    <span>${"C".repeat(1800)}</span>
                </p>
            </article>
        `;
        const nodes = Array.from(
            document.querySelectorAll("#sample span"),
            (span) => span.firstChild
        );

        expect(buildContextTranslationGroups(nodes, { maxChars: 6000 })).toHaveLength(1);
        expect(buildContextTranslationGroups(nodes, { maxChars: 1400 })).toHaveLength(3);
    });

    it("builds and splits marker-preserving segmented translation batches", () => {
        const source = buildSegmentedTranslationText([
            "First paragraph.",
            "Second paragraph with more text.",
            "Third paragraph.",
        ]);

        expect(source).toBe(
            [
                "[[1:x]]",
                "First paragraph.",
                "[[2:x]]",
                "Second paragraph with more text.",
                "[[3:x]]",
                "Third paragraph.",
            ].join("\n")
        );

        const translated = [
            "[[1:x]]",
            "첫 번째 문단입니다.",
            "[[2:x]]",
            "두 번째 문단입니다.",
            "[[3:x]]",
            "세 번째 문단입니다.",
        ].join("\n");

        expect(splitSegmentedTranslationText(translated, 3)).toEqual([
            "첫 번째 문단입니다.",
            "두 번째 문단입니다.",
            "세 번째 문단입니다.",
        ]);
    });

    it("builds segmented batches with role metadata and splits expanded markers too", () => {
        const source = buildSegmentedTranslationText([
            { text: "Notice title", role: "title" },
            { text: "2025年07月03日（木）", role: "date" },
            { text: "Article body text.", role: "paragraph" },
        ]);

        expect(source).toBe(
            [
                "[[1:t]]",
                "Notice title",
                "[[2:d]]",
                "2025年07月03日（木）",
                "[[3:p]]",
                "Article body text.",
            ].join("\n")
        );

        expect(
            splitSegmentedTranslationText(
                [
                    "[[1:t]]",
                    "공지 제목",
                    "[[2:d]]",
                    "2025년 07월 03일(목)",
                    "[[3:p]]",
                    "본문입니다.",
                ].join("\n"),
                3
            )
        ).toEqual(["공지 제목", "2025년 07월 03일(목)", "본문입니다."]);

        expect(
            splitSegmentedTranslationText(
                [
                    "<<<EDGE_TRANSLATE_SEGMENT_1>>>",
                    "공지 제목",
                    "<<<EDGE_TRANSLATE_SEGMENT_2>>>",
                    "2025년 07월 03일(목)",
                    "<<<EDGE_TRANSLATE_SEGMENT_3>>>",
                    "본문입니다.",
                ].join("\n"),
                3
            )
        ).toEqual(["공지 제목", "2025년 07월 03일(목)", "본문입니다."]);

        const compactSource = buildSegmentedTranslationText(
            [
                { text: "First paragraph.", role: "paragraph" },
                { text: "Second paragraph.", role: "paragraph" },
            ],
            { compactMarkers: true }
        );
        expect(compactSource).toBe("[[1]]\nFirst paragraph.\n[[2]]\nSecond paragraph.");
        expect(splitSegmentedTranslationText("[[1]]\n첫 문단.\n[[2]]\n둘째 문단.", 2)).toEqual([
            "첫 문단.",
            "둘째 문단.",
        ]);
    });
});

describe("LLM translation IR primitives", () => {
    it("serializes inline content without exposing real DOM attributes", () => {
        document.body.innerHTML = `
            <p id="line">
                Over on <a href="https://kde.org" class="external" data-track="1">the official news feed</a>, KDE announced it.
            </p>
        `;

        const leaf = serializeTranslationLeaf(document.getElementById("line"));

        expect(leaf.text).toBe("Over on <a>the official news feed</a>, KDE announced it.");
        expect(leaf.text).not.toContain("href=");
        expect(leaf.text).not.toContain("class=");
        expect(leaf.text).not.toContain("data-track");
        expect(leaf.plainText).toBe("Over on the official news feed, KDE announced it.");
    });

    it("builds a compact IR batch with sequential markers", () => {
        document.body.innerHTML = `
            <article>
                <h1 id="title">Article title</h1>
                <p id="body">Article body sentence.</p>
            </article>
        `;
        const leaves = [
            { element: document.getElementById("title") },
            { element: document.getElementById("body") },
        ];
        const batch = buildTranslationIrBatch(leaves, { compactMarkers: true });

        expect(batch.text).toBe("[[1]]\nArticle title\n[[2]]\nArticle body sentence.");
        expect(batch.segments.map((segment) => segment.id)).toEqual([1, 2]);
    });
});

describe("HTML-native translation safety pipeline (buildSafeTranslatedHtml)", () => {
    it("rejects empty or whitespace-only translations", () => {
        document.body.innerHTML = `<p>Hello world.</p>`;
        const block = document.body.querySelector("p");
        expect(buildSafeTranslatedHtml(block, "")).toBeNull();
        expect(buildSafeTranslatedHtml(block, "   \n  ")).toBeNull();
    });

    it("strips dangerous tags and event handlers", () => {
        document.body.innerHTML = `<p>Hello <a href="/x">x</a>.</p>`;
        const block = document.body.querySelector("p");
        const container = buildSafeTranslatedHtml(
            block,
            '안녕 <a href="/x" onclick="alert(1)">x</a><script>evil()</script><iframe src="x"></iframe>.'
        );
        expect(container).not.toBeNull();
        expect(container.querySelector("script")).toBeNull();
        expect(container.querySelector("iframe")).toBeNull();
        expect(container.querySelector("a").hasAttribute("onclick")).toBe(false);
    });

    it("strips javascript: URLs and falls back to the original safe href", () => {
        document.body.innerHTML = `<p>Hello <a href="/x">link</a>.</p>`;
        const block = document.body.querySelector("p");
        const container = buildSafeTranslatedHtml(
            block,
            '안녕 <a href="javascript:alert(1)">링크</a>.'
        );
        expect(container).not.toBeNull();
        // First: the dangerous href is stripped. Then: the original /x href is restored
        // from the source block. The final element never carries the javascript: URL.
        expect(container.querySelector("a").getAttribute("href")).toBe("/x");
    });

    it("rejects a translation that injects structure the original lacks", () => {
        // The original is plain text with no anchor; the model hallucinated an <a> (with a
        // dangerous javascript: URL). The strict structural guard rejects the whole payload
        // (returns null) so the block is left untranslated rather than gaining an injected,
        // mis-restored element — strictly safer than keeping a model-invented anchor.
        document.body.innerHTML = `<p>Hello world.</p>`;
        const block = document.body.querySelector("p");
        const container = buildSafeTranslatedHtml(
            block,
            '안녕 <a href="javascript:alert(1)">링크</a>.'
        );
        expect(container).toBeNull();
    });

    it("applies a translation onto an inline-link block even when the text-node count differs", () => {
        document.body.innerHTML = `<p id="lead">Over on the <a href="https://x">official news feed</a>, Valve announced it.</p>`;
        const block = document.getElementById("lead");
        // Original has 3 meaningful text nodes (before-link / link / after-link). EN→KO word order
        // moves the link, so the model's reply is a single run (link flattened) — counts no longer
        // match. The old apply REJECTED this and left the paragraph in English; now it writes the
        // full translation onto the block's first direct run and blanks the rest.
        const translated = "발브가 공식 뉴스 피드에서 발표했습니다.";
        const applied = applyPageSegments([block], new Map([[1, translated]]), 0, null);
        expect(applied).toBe(1);
        expect(block.textContent).toContain("발표했습니다");
        expect(block.textContent).not.toContain("Over on the");
    });

    it("strips inline tags from a single-text-node leaf payload (nothing to split)", () => {
        // Link-only rows/TOC entries: the tag pair is paid twice (input + model echo) but
        // with ONE mapped text node it carries zero information for the 1:1 apply.
        document.body.innerHTML = `<li id="l"><a href="/wiki/概要">概要</a></li>`;
        const seg = serializeTranslationLeaf(document.getElementById("l"));
        expect(seg.text).toBe("概要"); // no <a> tags in the payload
        // The plain reply still applies INTO the link's text node — href intact.
        applyPageSegments([document.getElementById("l")], new Map([[1, "개요"]]), 0, null);
        const link = document.querySelector("#l a");
        expect(link.textContent).toBe("개요");
        expect(link.getAttribute("href")).toBe("/wiki/概要");
    });

    it("keeps inline tags when the leaf has multiple text nodes (boundaries needed)", () => {
        document.body.innerHTML = `<p id="p">前文<a href="/x">リンク</a>後文</p>`;
        const seg = serializeTranslationLeaf(document.getElementById("p"));
        expect(seg.text).toContain("<a>");
        expect(seg.text).toContain("</a>");
    });

    it("keeps the model's spaces around inline links on a space-less source (ja→ko)", () => {
        // The space-less Japanese source used to strip the spaces Korean needs around the
        // links — `게이한 본선은요도야바시역` instead of `게이한 본선은 요도야바시역`. The
        // 1:1 apply now follows the MODEL's target-language spacing.
        document.body.innerHTML = `<p id="p">京阪本線は<a href="/x">淀屋橋駅</a>から<a href="/y">三条駅</a>までを結ぶ。</p>`;
        const block = document.getElementById("p");
        applyPageSegments(
            [block],
            new Map([[1, "게이한 본선은 <a>요도야바시역</a>에서 <a>산조역</a>까지를 잇는다."]]),
            0,
            null
        );
        expect(block.textContent).toBe("게이한 본선은 요도야바시역에서 산조역까지를 잇는다.");
        // Links survive in place with their hrefs.
        expect(block.querySelectorAll("a")).toHaveLength(2);
        expect(block.querySelector("a").getAttribute("href")).toBe("/x");
    });

    it("does NOT inject source spaces a no-space target rejects (en→ja around a link)", () => {
        document.body.innerHTML = `<p id="p">foo <a href="/x">bar</a> baz</p>`;
        const block = document.getElementById("p");
        applyPageSegments([block], new Map([[1, "フー<a>バー</a>バズ"]]), 0, null);
        expect(block.textContent).toBe("フーバーバズ");
    });

    it("restores critical attributes from the original block on matching tags", () => {
        document.body.innerHTML = `<p>Hello <a href="https://orig.example/x" class="cta" id="link-1">x</a>.</p>`;
        const block = document.body.querySelector("p");
        // Model hallucinated a different URL and dropped class/id.
        const container = buildSafeTranslatedHtml(
            block,
            '안녕 <a href="https://hallucinated.example/y">x</a>.'
        );
        expect(container).not.toBeNull();
        const anchor = container.querySelector("a");
        expect(anchor.getAttribute("href")).toBe("https://orig.example/x");
        expect(anchor.getAttribute("class")).toBe("cta");
        expect(anchor.getAttribute("id")).toBe("link-1");
    });

    it("preserves img src/alt/srcset even when the model omits them", () => {
        document.body.innerHTML = `<p><img src="/photo.jpg" alt="orig" srcset="/photo@2x.jpg 2x"> caption</p>`;
        const block = document.body.querySelector("p");
        const container = buildSafeTranslatedHtml(block, "<img> 캡션");
        expect(container).not.toBeNull();
        const img = container.querySelector("img");
        expect(img.getAttribute("src")).toBe("/photo.jpg");
        expect(img.getAttribute("alt")).toBe("orig");
        expect(img.getAttribute("srcset")).toBe("/photo@2x.jpg 2x");
    });

    it("returns null when the parsed translation has no visible text content", () => {
        document.body.innerHTML = `<p>Hello world.</p>`;
        const block = document.body.querySelector("p");
        expect(buildSafeTranslatedHtml(block, "<span></span><strong>   </strong>")).toBeNull();
    });
});

describe("HTML-native page sections (collect + apply)", () => {
    it("packs a small article as a single section under its parent", () => {
        document.body.innerHTML = `
            <article id="art">
                <h1>Title</h1>
                <p>First paragraph.</p>
                <p>Second paragraph.</p>
            </article>
        `;
        const sections = collectHtmlPageSections([document.body], {
            minChars: 10,
            maxChars: 12000,
        });
        expect(sections).toHaveLength(1);
        // The collector recurses into semantic containers so eligibility filtering can
        // drop already-translated/UI children without moving non-contiguous siblings.
        expect(sections[0].parent).toBe(document.getElementById("art"));
        expect(sections[0].children.map((c) => c.tagName)).toEqual(["H1", "P", "P"]);
        expect(sections[0].plainText).toContain("First paragraph");
    });

    it("uses eligibility to skip target-language children and split contiguous runs", () => {
        document.body.innerHTML = `
            <article id="art">
                <p id="first">Translate this first paragraph.</p>
                <p id="skip">이미 한국어입니다.</p>
                <p id="second">Translate this second paragraph.</p>
            </article>
        `;
        const sections = collectHtmlPageSections([document.body], {
            minChars: 10,
            maxChars: 12000,
            isEligibleElement: (element) => element.id !== "skip",
        });

        expect(sections).toHaveLength(2);
        expect(sections[0].children.map((c) => c.id)).toEqual(["first"]);
        expect(sections[1].children.map((c) => c.id)).toEqual(["second"]);
    });

    it("recurses into an oversized container and breaks at semantic boundaries", () => {
        document.body.innerHTML = `
            <article id="art">
                <p>${"intro ".repeat(80)}</p>
                <h2>Next section</h2>
                <p>${"more text ".repeat(40)}</p>
            </article>
        `;
        const sections = collectHtmlPageSections([document.body], { minChars: 200, maxChars: 600 });
        // Article exceeds maxChars → collector recurses; result is multiple sub-sections
        // anchored under <article>, and the H2 starts a new section.
        expect(sections.length).toBeGreaterThanOrEqual(2);
        const h2Section = sections.find((s) => s.children[0]?.tagName === "H2");
        expect(h2Section).toBeDefined();
        expect(h2Section.parent.id).toBe("art");
    });

    it("recurses into oversized single children", () => {
        document.body.innerHTML = `
            <main id="m">
                <section>
                    <p>${"intro ".repeat(50)}</p>
                    <p>${"middle ".repeat(50)}</p>
                    <p>${"end ".repeat(50)}</p>
                </section>
            </main>
        `;
        const sections = collectHtmlPageSections([document.body], { minChars: 50, maxChars: 600 });
        // The single <section> child exceeds maxChars, so the collector recurses and
        // returns multiple sub-sections drawn from its children.
        expect(sections.length).toBeGreaterThanOrEqual(1);
        sections.forEach((sec) => {
            sec.children.forEach((c) => expect(c.tagName).toBe("P"));
        });
    });

    it("applies a translated section by replacing the original children atomically", () => {
        document.body.innerHTML = `
            <article id="art">
                <h1>Title</h1>
                <p>Hello <a href="/x" id="link-1" class="cta">world</a>.</p>
                <p>Second.</p>
            </article>
        `;
        const article = document.body.querySelector("#art");
        const entry = {
            parent: article,
            children: Array.from(article.children),
        };
        const ok = applyHtmlPageSection(
            entry,
            '<h1>제목</h1><p>안녕 <a href="https://hallucinated/y">세계</a>.</p><p>두 번째.</p>'
        );
        expect(ok).toBe(true);
        const anchor = article.querySelector("a");
        // Restored href / id / class from the original anchor — the model's hallucinated
        // URL doesn't leak through to the live DOM.
        expect(anchor.getAttribute("href")).toBe("/x");
        expect(anchor.getAttribute("id")).toBe("link-1");
        expect(anchor.getAttribute("class")).toBe("cta");
        expect(anchor.textContent).toBe("세계");
        expect(article.querySelectorAll("p").length).toBe(2);
    });

    it("returns false (preserves originals) when the translated payload is empty", () => {
        document.body.innerHTML = `<article id="art"><p>Hello.</p></article>`;
        const article = document.body.querySelector("#art");
        const entry = { parent: article, children: Array.from(article.children) };
        expect(applyHtmlPageSection(entry, "   ")).toBe(false);
        expect(article.querySelector("p").textContent).toBe("Hello.");
    });

    it("returns false when section children have been moved out of the parent", () => {
        document.body.innerHTML = `<article id="art"><p>One.</p></article>`;
        const article = document.body.querySelector("#art");
        const entry = { parent: article, children: Array.from(article.children) };
        // Simulate the page mutating: detach the child.
        entry.children[0].remove();
        expect(applyHtmlPageSection(entry, "<p>하나.</p>")).toBe(false);
    });

    it("rejects translated sections that change the top-level child structure", () => {
        document.body.innerHTML = `<article id="art"><h2>Title</h2><p>Hello.</p></article>`;
        const article = document.body.querySelector("#art");
        const entry = { parent: article, children: Array.from(article.children) };

        expect(applyHtmlPageSection(entry, "<div><h2>제목</h2><p>안녕.</p></div>")).toBe(false);
        expect(Array.from(article.children).map((el) => el.tagName)).toEqual(["H2", "P"]);
        expect(article.textContent).toContain("Title");
    });

    it("strips script/iframe injections from the model's response", () => {
        document.body.innerHTML = `<article id="art"><p>Hello.</p></article>`;
        const article = document.body.querySelector("#art");
        const entry = { parent: article, children: Array.from(article.children) };
        const ok = applyHtmlPageSection(
            entry,
            '<p>안녕.</p><script>alert(1)</script><iframe src="evil"></iframe>'
        );
        expect(ok).toBe(true);
        expect(article.querySelector("script")).toBeNull();
        expect(article.querySelector("iframe")).toBeNull();
        expect(article.querySelector("p").textContent).toBe("안녕.");
    });
});

describe("Presentation attribute stripping (LLM token optimization)", () => {
    it("strips restorable attributes from a subtree before sending it to the LLM", () => {
        const container = document.createElement("div");
        container.innerHTML = `
            <p class="prose text-lg" id="p1" style="line-height:1.6" data-test="x" aria-label="Intro">
                Hello <a href="/x" class="link" target="_blank" rel="noopener" tabindex="0">world</a>.
            </p>
        `;
        stripPresentationAttrs(container);
        const p = container.querySelector("p");
        const a = container.querySelector("a");
        expect(p.hasAttribute("class")).toBe(false);
        expect(p.hasAttribute("id")).toBe(false);
        expect(p.hasAttribute("style")).toBe(false);
        expect(p.hasAttribute("data-test")).toBe(false);
        expect(p.hasAttribute("aria-label")).toBe(false);
        expect(a.hasAttribute("class")).toBe(false);
        expect(a.hasAttribute("tabindex")).toBe(false);
        // Links are restored from the live DOM after translation, so URL attrs do not
        // need to consume prompt tokens.
        expect(a.hasAttribute("href")).toBe(false);
        expect(a.hasAttribute("target")).toBe(false);
        expect(a.hasAttribute("rel")).toBe(false);
    });

    it("buildStrippedSectionHtml returns concatenated, attr-stripped HTML for a section", () => {
        document.body.innerHTML = `
            <article>
                <p class="prose" id="p1">Hello.</p>
                <p class="prose" id="p2">World.</p>
            </article>
        `;
        const children = Array.from(document.querySelector("article").children);
        const out = buildStrippedSectionHtml(children);
        expect(out).not.toContain("class=");
        expect(out).not.toContain("id=");
        expect(out).not.toContain("href=");
        expect(out).toContain("<p>Hello.</p>");
        expect(out).toContain("<p>World.</p>");
    });

    it("compacts comments and layout whitespace while preserving inline word gaps", () => {
        document.body.innerHTML = `
            <article>
                <!-- framework marker -->
                <p class="prose">
                    Read the
                    <a href="/article"> original article </a>
                    before translating.
                </p>
            </article>
        `;
        const out = buildStrippedSectionHtml(
            Array.from(document.querySelector("article").children)
        );

        expect(out).toBe("<p>Read the <a>original article</a> before translating.</p>");
    });

    it("does not mutate the original DOM when stripping for the LLM payload", () => {
        document.body.innerHTML = `<p class="prose" id="p1">Hello.</p>`;
        const original = document.body.firstElementChild;
        buildStrippedSectionHtml([original]);
        expect(original.getAttribute("class")).toBe("prose");
        expect(original.getAttribute("id")).toBe("p1");
    });
});

describe("Section maxChars / lead-chunk ttfb tuning", () => {
    it("packs paragraph blocks under the maxChars budget into a single LLM request", () => {
        document.body.innerHTML = `
            <article>
                ${Array.from({ length: 5 }, (_, i) => `<p>${"para ".repeat(200)} ${i}</p>`).join(
                    ""
                )}
            </article>
        `;
        const sections = collectHtmlPageSections([document.body], {
            minChars: 500,
            maxChars: 20000,
        });
        // 5 × ~1000 chars = ~5000 chars < 20000, so one section.
        expect(sections).toHaveLength(1);
    });

    it("splits paragraph blocks into multiple sections once maxChars is exceeded", () => {
        document.body.innerHTML = `
            <article>
                ${Array.from(
                    { length: 20 },
                    (_, i) => `<p>${"longer text ".repeat(300)} ${i}</p>`
                ).join("")}
            </article>
        `;
        const sections = collectHtmlPageSections([document.body], {
            minChars: 500,
            maxChars: 8000,
        });
        // 20 × ~3300 chars = ~66000 chars, requires multiple ≤8000-char sections.
        expect(sections.length).toBeGreaterThan(1);
    });
});

describe("Streaming partial-section apply (popcorn UX)", () => {
    it("applyHtmlPageSection translates by writing text nodes, never swapping elements", () => {
        // The apply writes translated text onto the ORIGINAL child elements — their
        // structure, attributes and identity are never touched — so the layout cannot break
        // and the WeakSet of already-translated elements (keyed on identity) keeps matching,
        // preventing the MutationObserver rescan from re-translating (token bleed).
        document.body.innerHTML = `<article id="art"><p class="a">Hello.</p><p class="b">World.</p></article>`;
        const article = document.querySelector("#art");
        const originalChildren = Array.from(article.children);
        const entry = { parent: article, children: originalChildren.slice() };

        const ok = applyHtmlPageSection(entry, "<p>안녕.</p><p>세계.</p>");
        expect(ok).toBe(true);
        // Same original elements, still connected, classes intact — only text changed.
        expect(entry.children[0]).toBe(originalChildren[0]);
        expect(entry.children[1]).toBe(originalChildren[1]);
        expect(originalChildren[0].isConnected).toBe(true);
        expect(originalChildren[0].className).toBe("a");
        expect(article.children[0].textContent).toBe("안녕.");
        expect(article.children[1].textContent).toBe("세계.");
    });

    it("applyHtmlPageSection respects skipCount and applies only the tail", () => {
        document.body.innerHTML = `<article id="art"><p>One.</p><p>Two.</p><p>Three.</p></article>`;
        const article = document.querySelector("#art");
        const entry = {
            parent: article,
            children: Array.from(article.children),
        };
        // Imagine the stream already swapped the first two children — simulate by
        // replacing them in place and updating entry.children to the new refs.
        const a = document.createElement("p");
        a.textContent = "하나.";
        const b = document.createElement("p");
        b.textContent = "둘.";
        article.replaceChild(a, entry.children[0]);
        article.replaceChild(b, entry.children[1]);
        entry.children[0] = a;
        entry.children[1] = b;

        const ok = applyHtmlPageSection(entry, "<p>하나.</p><p>둘.</p><p>셋.</p>", 2);
        expect(ok).toBe(true);
        const final = Array.from(article.querySelectorAll("p")).map((p) => p.textContent);
        expect(final).toEqual(["하나.", "둘.", "셋."]);
    });
});

describe("Leaf-level original text capture (per-paragraph tooltips)", () => {
    it("descends through wrapper containers and returns leaf block elements", () => {
        document.body.innerHTML = `
            <div id="wrap">
                <h1>Title</h1>
                <p>First paragraph.</p>
                <p>Second paragraph with <a href="/x">link</a>.</p>
                <ul><li>List item one</li><li>List item two</li></ul>
            </div>
        `;
        const wrapper = document.getElementById("wrap");
        const leaves = findLeafBlocksInElement(wrapper);
        const tags = leaves.map((el) => el.tagName);
        expect(tags).toEqual(["H1", "P", "P", "LI", "LI"]);
    });

    it("treats a leaf-tagged element with no block descendants as its own leaf", () => {
        document.body.innerHTML = `<p id="solo">Just a paragraph.</p>`;
        const paragraph = document.getElementById("solo");
        const leaves = findLeafBlocksInElement(paragraph);
        expect(leaves).toEqual([paragraph]);
    });

    it("skips block leaves that are empty after trim", () => {
        document.body.innerHTML = `<div><p>real text</p><p>   </p></div>`;
        const wrapper = document.body.firstElementChild;
        const leaves = findLeafBlocksInElement(wrapper);
        expect(leaves).toHaveLength(1);
        expect(leaves[0].textContent).toBe("real text");
    });

    it("captures leaf texts in document order from a wrapper element", () => {
        document.body.innerHTML = `
            <div id="article">
                <h1>제목</h1>
                <p>첫 문장.</p>
                <p>둘째 문장.</p>
            </div>
        `;
        const wrapper = document.getElementById("article");
        const texts = captureLeafTextsFromElement(wrapper);
        expect(texts).toEqual(["제목", "첫 문장.", "둘째 문장."]);
    });

    it("collapses whitespace in captured leaf texts", () => {
        document.body.innerHTML = `<p>  Lots   of\n  spaces.   </p>`;
        const paragraph = document.body.firstElementChild;
        const texts = captureLeafTextsFromElement(paragraph);
        expect(texts).toEqual(["Lots of spaces."]);
    });
});

// Wikipedia history/station lists pack a year line plus a sub-list of events into one
// <li>. Keeping only innermost leaves silently dropped the parent's own line — the
// "translation still has untranslated parts" bug. The parent line must be its OWN leaf,
// translated over its direct content only (never the sub-list, which is a separate leaf).
describe("Nested list-item own line (parent-leaf coverage)", () => {
    it("returns BOTH the parent line and the nested item as leaves, in document order", () => {
        document.body.innerHTML = `
            <ul><li id="outer">1990年（平成2年）<ul><li id="inner">3月16日：開業。</li></ul></li></ul>
        `;
        const outer = document.getElementById("outer");
        const inner = document.getElementById("inner");
        const leaves = findLeafBlocksInElement(document.querySelector("ul"));
        expect(leaves).toEqual([outer, inner]);
    });

    it("serializes the parent leaf over its OWN line only (nested item excluded)", () => {
        document.body.innerHTML = `
            <li id="outer">1990年（平成2年）<ul><li>3月16日：開業。</li></ul></li>
        `;
        const outer = document.getElementById("outer");
        expect(serializeBlockSegment(outer)).toBe("1990年（平成2年）");
        expect(leafBlockOwnText(outer).trim()).toBe("1990年（平成2年）");
    });

    it("skips a pure wrapper li that has only a nested sub-list (no own line)", () => {
        document.body.innerHTML = `
            <ul><li id="outer"><ul><li id="inner">only nested.</li></ul></li></ul>
        `;
        const inner = document.getElementById("inner");
        const leaves = findLeafBlocksInElement(document.querySelector("ul"));
        expect(leaves).toEqual([inner]);
    });

    it("applies translation to the parent line without touching the nested item", () => {
        document.body.innerHTML = `
            <li id="outer">1990年（平成2年）<ul><li id="inner">3月16日：開業。</li></ul></li>
        `;
        const outer = document.getElementById("outer");
        const inner = document.getElementById("inner");
        // Translate the parent's own line; the nested <li> is a separate leaf, untouched here.
        const ok = applyPageSegmentToBlock(outer, "1990년(헤이세이 2년)");
        expect(ok).toBe(true);
        expect(inner.textContent).toBe("3月16日：開業。");
        expect(leafBlockOwnText(outer).replace(/\s+/g, " ").trim()).toBe("1990년(헤이세이 2년)");
    });

    it("translates parent line and nested item exactly once each via a [[n]] batch", () => {
        document.body.innerHTML = `
            <ul><li id="outer">1990年（平成2年）<ul><li id="inner">3月16日：開業。</li></ul></li></ul>
        `;
        const outer = document.getElementById("outer");
        const inner = document.getElementById("inner");
        const leaves = findLeafBlocksInElement(document.querySelector("ul")); // [outer, inner]
        const map = new Map([
            [1, "1990년(헤이세이 2년)"],
            [2, "3월 16일: 개업."],
        ]);
        const applied = applyPageSegments(leaves, map);
        expect(applied).toBe(2);
        expect(leafBlockOwnText(outer).replace(/\s+/g, " ").trim()).toBe("1990년(헤이세이 2년)");
        expect(inner.textContent).toBe("3월 16일: 개업.");
    });
});

describe("Per-line-break segment mapping (single-<p>-with-<br> tooltip fix)", () => {
    it("splits a leaf's inline content by <br> into normalized line segments", () => {
        document.body.innerHTML = `
            <p id="news">First line.<br>Second line.<br><br>After blank.<br>・bullet line</p>
        `;
        const leaf = document.getElementById("news");
        const segments = splitLeafByLineBreaks(leaf);
        expect(segments.map((s) => s.text)).toEqual([
            "First line.",
            "Second line.",
            "After blank.",
            "・bullet line",
        ]);
    });

    it("captures one segmentText per <br>-separated line", () => {
        document.body.innerHTML = `
            <div id="wrap">
                <p>Line A.<br>Line B.<br>Line C.</p>
            </div>
        `;
        const wrap = document.getElementById("wrap");
        const captured = captureLeafSegmentTexts(wrap);
        expect(captured).toHaveLength(1);
        expect(captured[0].segmentTexts).toEqual(["Line A.", "Line B.", "Line C."]);
    });

    it("captures one segmentText per leaf when no <br> separators exist", () => {
        document.body.innerHTML = `
            <article id="art">
                <h1>Title</h1>
                <p>Single paragraph.</p>
            </article>
        `;
        const article = document.getElementById("art");
        const captured = captureLeafSegmentTexts(article);
        expect(captured.map((entry) => entry.segmentTexts)).toEqual([
            ["Title"],
            ["Single paragraph."],
        ]);
    });

    it("wraps multi-segment leaves in <span data-edge-translate-segment> elements", () => {
        document.body.innerHTML = `<p id="news">a1<br>a2<br>a3</p>`;
        const leaf = document.getElementById("news");
        const spans = wrapLeafLineSegmentsInSpans(leaf);
        expect(spans).toHaveLength(3);
        expect(spans.map((s) => s.textContent)).toEqual(["a1", "a2", "a3"]);
        spans.forEach((s) => {
            expect(s.tagName).toBe("SPAN");
            expect(s.hasAttribute("data-edge-translate-segment")).toBe(true);
        });
        // <br>s stay in document order between the spans.
        expect(leaf.querySelectorAll("br")).toHaveLength(2);
    });

    it("preserves inline styling within wrapped segments", () => {
        document.body.innerHTML = `
            <p id="news">plain<br><span style="background:#999">【Header】</span><br>after</p>
        `;
        const leaf = document.getElementById("news");
        const spans = wrapLeafLineSegmentsInSpans(leaf);
        expect(spans).toHaveLength(3);
        // Middle segment kept its styled inner span as a child of the wrapper.
        const styledChild = spans[1].querySelector("span[style]");
        expect(styledChild).not.toBeNull();
        expect(styledChild.textContent).toBe("【Header】");
    });

    it("returns an empty array (no DOM mutation) when fewer than 2 segments exist", () => {
        document.body.innerHTML = `<p id="news">single line</p>`;
        const leaf = document.getElementById("news");
        const before = leaf.innerHTML;
        const spans = wrapLeafLineSegmentsInSpans(leaf);
        expect(spans).toEqual([]);
        expect(leaf.innerHTML).toBe(before);
    });
});

describe("Sentence-level hover original (split + wrap + align)", () => {
    it("splits Latin and CJK text into sentences", () => {
        expect(splitTextIntoSentences("First sentence. Second one! Third?")).toEqual([
            "First sentence.",
            "Second one!",
            "Third?",
        ]);
        expect(splitTextIntoSentences("これは一文目です。これは二文目です。")).toEqual([
            "これは一文目です。",
            "これは二文目です。",
        ]);
    });

    it("returns a single sentence unchanged and merges decimal mis-splits", () => {
        expect(splitTextIntoSentences("Just one sentence with no terminal punctuation")).toEqual([
            "Just one sentence with no terminal punctuation",
        ]);
        // "3.14" must not split into "3." + "14".
        expect(splitTextIntoSentences("Pi is about 3.14 today.")).toEqual([
            "Pi is about 3.14 today.",
        ]);
    });

    it("wraps each sentence of a leaf in a segment span, preserving inline elements", () => {
        document.body.innerHTML = `<p id="p">First sentence. Click <a href="/x" id="lnk">here</a> now. Third sentence.</p>`;
        const leaf = document.getElementById("p");
        const link = document.getElementById("lnk");
        const spans = wrapLeafSentencesInSpans(leaf);
        expect(spans.length).toBe(3);
        spans.forEach((s) => expect(s.hasAttribute("data-edge-translate-segment")).toBe(true));
        // The inline <a> (same node identity, href intact) stays inside its sentence span.
        expect(spans[1].contains(link)).toBe(true);
        expect(link.getAttribute("href")).toBe("/x");
        // No visible text is lost by the wrapping.
        expect(leaf.textContent.replace(/\s+/g, " ").trim()).toBe(
            "First sentence. Click here now. Third sentence."
        );
    });

    it("splits sentences inside a sole styled wrapper (news-site <p><span>…</span></p>)", () => {
        document.body.innerHTML = `<p id="p"><span class="styled">첫 문장이다. 둘째 문장이다.</span></p>`;
        const leaf = document.getElementById("p");
        const spans = wrapLeafSentencesInSpans(leaf);
        expect(spans.length).toBe(2);
        // The spans live INSIDE the styled wrapper so its styling applies to every sentence.
        const wrapper = leaf.querySelector(".styled");
        expect(wrapper).not.toBeNull();
        spans.forEach((span) => expect(span.parentElement).toBe(wrapper));
        expect(leaf.textContent).toBe("첫 문장이다. 둘째 문장이다.");
    });

    it("splits sentences inside a sole inline carrier (apply fallback wrote into <a>)", () => {
        document.body.innerHTML = `<li id="l"><a href="/x">첫 문장이다. 둘째 문장이다.</a></li>`;
        const leaf = document.getElementById("l");
        const spans = wrapLeafSentencesInSpans(leaf);
        expect(spans.length).toBe(2);
        spans.forEach((span) => expect(span.closest("a")).not.toBeNull());
    });

    it("never sentence-splits inside code-like carriers", () => {
        document.body.innerHTML = `<p id="p"><code>a.b. c.d. e.f.</code></p>`;
        const leaf = document.getElementById("p");
        expect(wrapLeafSentencesInSpans(leaf)).toEqual([]);
        expect(leaf.querySelector("[data-edge-translate-segment]")).toBeNull();
    });

    it("leaves a single-sentence leaf untouched (no spans)", () => {
        document.body.innerHTML = `<p id="p">Only one sentence here.</p>`;
        const leaf = document.getElementById("p");
        const before = leaf.innerHTML;
        expect(wrapLeafSentencesInSpans(leaf)).toEqual([]);
        expect(leaf.innerHTML).toBe(before);
    });

    it("aligns translated sentences to original sentences proportionally", () => {
        // 1:1 when counts match.
        expect(alignSentencesProportional(2, ["가", "나"])).toEqual(["가", "나"]);
        // Model merged 4 source sentences into 2 — each translated span maps to a 2-sentence range.
        expect(alignSentencesProportional(2, ["a", "b", "c", "d"])).toEqual(["a b", "c d"]);
        // Model split 1 source sentence into 3 — all map back to the single original.
        expect(alignSentencesProportional(3, ["only"])).toEqual(["only", "only", "only"]);
    });
});

describe("Boilerplate region detection (opt-in token saver)", () => {
    function frag(html) {
        document.body.innerHTML = html;
        return document.body;
    }

    it("flags reference / citation lists by class and role", () => {
        frag(`
            <ol class="references"><li id="cite">Some citation text, retrieved 2024.</li></ol>
            <section role="doc-bibliography"><p id="bib">Bibliography entry.</p></section>
        `);
        expect(isBoilerplateRegion(document.getElementById("cite"))).toBe(true);
        expect(isBoilerplateRegion(document.getElementById("bib"))).toBe(true);
    });

    it("flags navboxes, category links, the TOC and edit links", () => {
        frag(`
            <table class="navbox"><tr><td id="nav">Related lines and stations</td></tr></table>
            <div class="catlinks"><p id="cat">Categories list</p></div>
            <div id="toc" class="toc"><p id="tocItem">Contents</p></div>
            <span class="mw-editsection"><a id="edit" href="#">edit</a></span>
        `);
        expect(isBoilerplateRegion(document.getElementById("nav"))).toBe(true);
        expect(isBoilerplateRegion(document.getElementById("cat"))).toBe(true);
        expect(isBoilerplateRegion(document.getElementById("tocItem"))).toBe(true);
        expect(isBoilerplateRegion(document.getElementById("edit"))).toBe(true);
    });

    it("flags dense-link navigation cells inside tables", () => {
        frag(`
            <table><tr><td id="links"><a href="#">One</a> <a href="#">Two</a> <a href="#">Three</a></td></tr></table>
        `);
        expect(isBoilerplateRegion(document.getElementById("links"))).toBe(true);
    });

    it("does NOT flag ordinary article prose", () => {
        frag(`
            <article class="mw-parser-output">
                <p id="lead">The line opened in 1910 and has been expanded several times since.</p>
                <p id="body">It connects two major cities and carries heavy commuter traffic with <a href="#">one inline link</a> only.</p>
            </article>
        `);
        expect(isBoilerplateRegion(document.getElementById("lead"))).toBe(false);
        expect(isBoilerplateRegion(document.getElementById("body"))).toBe(false);
    });

    it("does NOT flag prose whose id/class merely contains a keyword (container-gated)", () => {
        frag(`
            <article>
                <h2 id="citations-in-ancient-rome">Citations in ancient Rome</h2>
                <p class="references-explained">References were recorded on wax tablets back then.</p>
                <p id="see-also-history">See also the history of the categories of Roman law.</p>
            </article>
        `);
        expect(isBoilerplateRegion(document.getElementById("citations-in-ancient-rome"))).toBe(
            false
        );
        expect(isBoilerplateRegion(document.querySelector(".references-explained"))).toBe(false);
        expect(isBoilerplateRegion(document.getElementById("see-also-history"))).toBe(false);
    });

    it("does NOT flag a prose table cell with only a couple of links", () => {
        frag(`
            <table><tr><td id="cell">See <a href="#">Tokyo</a> and <a href="#">Osaka</a> for details.</td></tr></table>
        `);
        expect(isBoilerplateRegion(document.getElementById("cell"))).toBe(false);
    });
});

// '=' keep-source protocol (speed redesign W3): the sentinel is VERIFIED upstream
// (BannerController), so the apply layer treats a literal "=" as "this block is already
// in the target language" — counted resolved, applied-set updated, DOM untouched.
describe("'=' keep-source segment apply (applyPageSegments)", () => {
    it("counts a '=' segment as applied without writing to the DOM", () => {
        document.body.innerHTML = `<p id="keep">이미 번역된 한국어 문장입니다.</p>`;
        const block = document.getElementById("keep");
        const appliedSet = new Set();

        const applied = applyPageSegments([block], new Map([[1, "="]]), 0, appliedSet);

        // Counted resolved (an all-sentinel entry must never report applied=0 and loop)…
        expect(applied).toBe(1);
        expect(appliedSet.has(1)).toBe(true);
        // …with the original text left exactly as-is.
        expect(block.textContent).toBe("이미 번역된 한국어 문장입니다.");
    });

    it("applies a mixed map of '=' and a real translation in one pass", () => {
        document.body.innerHTML = `
            <p id="keep">이미 번역된 한국어 문장입니다.</p>
            <p id="translate">Hello world.</p>
        `;
        const keep = document.getElementById("keep");
        const translate = document.getElementById("translate");
        const appliedSet = new Set();

        const applied = applyPageSegments(
            [keep, translate],
            new Map([
                [1, "="],
                [2, "안녕 세상."],
            ]),
            0,
            appliedSet
        );

        expect(applied).toBe(2);
        expect(appliedSet.has(1)).toBe(true);
        expect(appliedSet.has(2)).toBe(true);
        expect(keep.textContent).toBe("이미 번역된 한국어 문장입니다.");
        expect(translate.textContent).toBe("안녕 세상.");
    });
});
