import {
    buildContextTranslationGroups,
    buildSegmentedTranslationText,
    createReadableBlockReplacement,
    inferDomPageTextRole,
    splitSegmentedTranslationText,
    splitTranslatedContext,
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

    it("preserves inline formatting instead of replacing formatted paragraphs as plain text", () => {
        document.body.innerHTML = `
            <article>
                <p id="sample">
                    <span>Out of the box, the Kindle is good at only one thing.</span>
                    <span>Well, two.</span>
                    <span>It lets me buy books from Amazon and read them with very little friction.</span>
                </p>
            </article>
        `;
        const nodes = Array.from(
            document.querySelectorAll("#sample span"),
            (span) => span.firstChild
        );
        const [group] = buildContextTranslationGroups(nodes);

        expect(createReadableBlockReplacement(group)).toBeNull();
    });

    it("does not whole-replace blocks that contain links or controls", () => {
        document.body.innerHTML = `
            <p id="sample">
                Read the <a href="https://example.test">original article</a> before translating.
            </p>
        `;
        const nodes = Array.from(
            document.querySelectorAll("#sample, #sample *"),
            (element) => element.firstChild
        ).filter(Boolean);
        const [group] = buildContextTranslationGroups(nodes);

        expect(createReadableBlockReplacement(group)).toBeNull();
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

    it("builds segmented batches with role metadata and splits legacy markers too", () => {
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
    });
});
