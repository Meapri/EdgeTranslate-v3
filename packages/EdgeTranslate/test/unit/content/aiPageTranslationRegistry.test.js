import {
    TargetRegistry,
    compareCapturedValue,
    reattachBoundaryWhitespace,
} from "../../../src/content/ai_page_translation/dom/target_registry.js";
import {
    applyBlock,
    commitTargetTranslation,
    restoreTargetSource,
} from "../../../src/content/ai_page_translation/dom/committer.js";

describe("AI page translation registry and CAS committer (vNext)", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    describe("ported single-node CAS behavior", () => {
        it("deduplicates a Text node and creates a new revision when its source changes", () => {
            const node = document.createTextNode("Original");
            document.body.appendChild(node);
            const registry = new TargetRegistry("session-1");

            const first = registry.registerText(node, { role: "paragraph" });
            const duplicate = registry.registerText(node, { priority: "visible" });
            expect(duplicate).toBe(first);
            expect(first.priority).toBe("visible");

            node.data = "Changed by site";
            const revised = registry.registerText(node);
            expect(revised.id).toBe(first.id);
            expect(revised.revision).toBe(1);
            expect(revised.source).toBe("Changed by site");
            expect(revised.state).toBe("discovered");
        });

        it("rejects a stale response when the site changed the source before commit", () => {
            const node = document.createTextNode("Original");
            document.body.appendChild(node);
            const target = new TargetRegistry("session-1").registerText(node);
            node.data = "Site update";

            expect(commitTargetTranslation(target, "번역")).toEqual({
                status: "stale",
                reason: "source-changed",
            });
            expect(node.data).toBe("Site update");
        });

        it("preserves a site's newer value instead of restoring over it", () => {
            const node = document.createTextNode("Original");
            document.body.appendChild(node);
            const target = new TargetRegistry("session-1").registerText(node);
            commitTargetTranslation(target, "번역");
            node.data = "New site value";

            expect(restoreTargetSource(target)).toMatchObject({
                status: "preserved",
                reason: "site-changed",
            });
            expect(node.data).toBe("New site value");
        });
    });

    describe("applied-value guard (target_registry :128-145, byte-for-byte)", () => {
        it("does not revise an applied text translation when an ancestor rescan sees it", () => {
            const node = document.createTextNode("Original source");
            document.body.appendChild(node);
            const registry = new TargetRegistry("session-1");
            const target = registry.registerText(node);
            registry.transition(target.id, "queued");
            registry.transition(target.id, "in_flight");
            registry.transition(target.id, "validated");
            commitTargetTranslation(target, "번역 결과");
            registry.transition(target.id, "applied", { appliedTranslation: "번역 결과" });

            const rescanned = registry.registerText(node, { role: "paragraph" });

            expect(rescanned).toBe(target);
            expect(rescanned).toMatchObject({
                revision: 0,
                source: "Original source",
                appliedTranslation: "번역 결과",
                state: "applied",
            });
        });

        it("does not revise an applied block when a rescan sees its own committed segments", () => {
            document.body.innerHTML = String.raw`<p id="p">Read <a href="/notes">notes</a> now</p>`;
            const paragraph = document.getElementById("p");
            const nodes = [
                paragraph.childNodes[0],
                paragraph.querySelector("a").firstChild,
                paragraph.childNodes[2],
            ];
            const registry = new TargetRegistry("session-1");
            const target = registry.registerBlockTarget(nodes, { role: "p" });
            registry.transition(target.id, "queued");
            registry.transition(target.id, "in_flight");
            registry.transition(target.id, "validated");

            expect(applyBlock(target, ["지금 ", "노트를", " 읽으세요"])).toMatchObject({
                status: "applied",
                applied: 3,
                casFailures: 0,
            });
            registry.transition(target.id, "applied");

            const rescanned = registry.registerBlockTarget(nodes, { role: "p" });
            expect(rescanned).toBe(target);
            expect(rescanned.revision).toBe(0);
            expect(rescanned.state).toBe("applied");
        });

        it("treats phase-2 serialized translated source as an own write, but still revises a real inline shape change", () => {
            document.body.innerHTML = String.raw`<p id="p">Read <a href="/notes">notes</a></p>`;
            const paragraph = document.getElementById("p");
            const nodes = [paragraph.childNodes[0], paragraph.querySelector("a").firstChild];
            const registry = new TargetRegistry("session-1");
            const target = registry.registerBlockTarget(nodes, {
                role: "p",
                source: "Read <g0>notes</g0>",
            });
            registry.transition(target.id, "queued");
            registry.transition(target.id, "in_flight");
            registry.transition(target.id, "validated");
            expect(applyBlock(target, ["읽기 ", "노트"])).toMatchObject({
                status: "applied",
                applied: 2,
            });
            registry.transition(target.id, "applied", {
                appliedTranslation: "읽기 <g0>노트</g0>",
            });

            const phaseTwo = registry.registerBlockTarget(nodes, {
                role: "p",
                source: "읽기 <g0>노트</g0>",
            });
            expect(phaseTwo).toBe(target);
            expect(phaseTwo.revision).toBe(0);
            expect(phaseTwo.source).toBe("Read <g0>notes</g0>");

            const added = document.createTextNode(" updated by site");
            paragraph.appendChild(added);
            const revised = registry.registerBlockTarget([...nodes, added], {
                role: "p",
                source: "읽기 <g0>노트</g0> updated by site",
            });
            expect(revised.revision).toBe(1);
            expect(revised.state).toBe("discovered");
            expect(revised.textNodes).toHaveLength(3);
        });

        it("revises a block when the site truly mutates one of its Text nodes", () => {
            document.body.innerHTML = String.raw`<p id="p">Read <a href="/notes">notes</a></p>`;
            const paragraph = document.getElementById("p");
            const nodes = [paragraph.childNodes[0], paragraph.querySelector("a").firstChild];
            const registry = new TargetRegistry("session-1");
            const target = registry.registerBlockTarget(nodes, { role: "p" });

            nodes[1].data = "release notes";
            const revised = registry.registerBlockTarget(nodes, { role: "p" });

            expect(revised).toBe(target);
            expect(revised.revision).toBe(1);
            expect(revised.state).toBe("discovered");
            expect(revised.textNodes[1].source).toBe("release notes");
        });
    });

    describe("whitespace-normalized CAS with exact-preserving apply (spec §3)", () => {
        it("exposes the compare primitive with a rescue signal", () => {
            expect(compareCapturedValue("Hello world", "Hello world")).toEqual({
                match: true,
                rescued: false,
            });
            expect(compareCapturedValue("  Hello   world ", "Hello world")).toEqual({
                match: true,
                rescued: true,
            });
            expect(compareCapturedValue("Hello mars", "Hello world")).toEqual({
                match: false,
                rescued: false,
            });
        });

        it("rescues a commit after hydration whitespace churn and re-attaches LIVE boundary whitespace", () => {
            const node = document.createTextNode("Hello world");
            document.body.appendChild(node);
            const registry = new TargetRegistry("session-1");
            const target = registry.registerBlockTarget([node], { role: "p" });

            // Framework hydration re-renders the identical content with churned whitespace.
            node.data = "  Hello   world  ";

            const result = applyBlock(target, ["안녕 세계"], {
                sessionId: "session-1",
                revision: 0,
            });
            expect(result).toMatchObject({
                status: "applied",
                applied: 1,
                casFailures: 0,
                normalizedRescues: 1,
            });
            expect(node.data).toBe("  안녕 세계  ");

            registry.recordCasNormalizedRescue(result.normalizedRescues);
            expect(registry.telemetry.cas_normalized_rescue).toBe(1);
        });

        it("preserves captured boundary whitespace on the exact-match path", () => {
            document.body.innerHTML = String.raw`<p id="p">Read <a href="/n">notes</a></p>`;
            const paragraph = document.getElementById("p");
            const nodes = [paragraph.childNodes[0], paragraph.querySelector("a").firstChild];
            const target = new TargetRegistry("session-1").registerBlockTarget(nodes);

            expect(applyBlock(target, ["읽기", "노트"]).status).toBe("applied");
            expect(nodes[0].data).toBe("읽기 ");
            expect(nodes[1].data).toBe("노트");
        });

        it("preserves target-introduced whitespace at inline node boundaries", () => {
            document.body.innerHTML = String.raw`<p id="p">私は<strong>京阪</strong>を利用する</p>`;
            const paragraph = document.getElementById("p");
            const nodes = [
                paragraph.childNodes[0],
                paragraph.querySelector("strong").firstChild,
                paragraph.childNodes[2],
            ];
            const target = new TargetRegistry("session-1").registerBlockTarget(nodes);

            expect(applyBlock(target, ["나는 매일 ", "게이한", "을 이용한다"]).status).toBe(
                "applied"
            );
            expect(paragraph.textContent).toBe("나는 매일 게이한을 이용한다");
            expect(nodes[0].data).toBe("나는 매일 ");
        });

        it("blanks a sibling node with an empty segment while keeping its boundary whitespace", () => {
            document.body.innerHTML = String.raw`<p id="p"><b>Bold</b> tail</p>`;
            const paragraph = document.getElementById("p");
            const nodes = [paragraph.querySelector("b").firstChild, paragraph.childNodes[1]];
            const target = new TargetRegistry("session-1").registerBlockTarget(nodes);

            expect(applyBlock(target, ["굵은 꼬리", ""]).applied).toBe(2);
            expect(nodes[0].data).toBe("굵은 꼬리");
            expect(nodes[1].data).toBe(" ");
        });

        it("rejects a stale sibling atomically without writing any node", () => {
            const kept = document.createTextNode("Stays the same");
            const mutated = document.createTextNode("Original text");
            document.body.append(kept, mutated);
            const target = new TargetRegistry("session-1").registerBlockTarget([kept, mutated]);
            mutated.data = "Completely different";

            const result = applyBlock(target, ["같은 내용", "원본"]);
            expect(result).toMatchObject({
                status: "stale",
                applied: 0,
                casFailures: 1,
                normalizedRescues: 0,
            });
            expect(kept.data).toBe("Stays the same");
            expect(mutated.data).toBe("Completely different");
        });

        it("keeps normalized-rescue eligibility but writes nothing when another node is stale", () => {
            const rescued = document.createTextNode("Alpha  beta");
            const stale = document.createTextNode("Original");
            document.body.append(rescued, stale);
            const target = new TargetRegistry("session-1").registerBlockTarget([rescued, stale]);
            rescued.data = "Alpha beta"; // whitespace-only hydration churn: rescuable
            stale.data = "Site replacement";

            expect(applyBlock(target, ["알파 베타", "원본"])).toMatchObject({
                status: "stale",
                applied: 0,
                casFailures: 1,
                normalizedRescues: 1,
            });
            expect(rescued.data).toBe("Alpha beta");
            expect(stale.data).toBe("Site replacement");
        });

        it("rejects stale block replies via the same session/revision CAS guards", () => {
            const node = document.createTextNode("Original");
            document.body.appendChild(node);
            const target = new TargetRegistry("session-1").registerBlockTarget([node]);

            expect(applyBlock(target, ["번역"], { sessionId: "other-session" })).toMatchObject({
                status: "stale",
                reason: "session",
                applied: 0,
            });
            expect(applyBlock(target, ["번역"], { revision: 1 })).toMatchObject({
                status: "stale",
                reason: "revision",
                applied: 0,
            });
            document.body.removeChild(node);
            expect(applyBlock(target, ["번역"])).toMatchObject({ status: "stale", applied: 0 });
            expect(node.data).toBe("Original");
        });

        it("keeps re-attachment exact for whitespace-only and empty live values", () => {
            expect(reattachBoundaryWhitespace("  live  ", "번역")).toBe("  번역  ");
            expect(reattachBoundaryWhitespace("live", "")).toBe("");
            expect(reattachBoundaryWhitespace("   ", "번역")).toBe("번역");
        });
    });

    describe("dirty-queue events (O(1) append, no per-event snapshots)", () => {
        it("coalesces appends per target and drains in first-dirty order", () => {
            const first = document.createTextNode("First");
            const second = document.createTextNode("Second");
            document.body.append(first, second);
            const registry = new TargetRegistry("session-1");

            const targetA = registry.registerText(first);
            const targetB = registry.registerText(second);
            registry.transition(targetA.id, "queued");
            registry.transition(targetB.id, "queued");

            const drained = registry.drainDirtyTargets();
            expect(drained.map(({ id }) => id)).toEqual([targetA.id, targetB.id]);
            expect(registry.drainDirtyTargets()).toEqual([]);
        });

        it("re-queues a target dirtied again after a drain", () => {
            const node = document.createTextNode("Original");
            document.body.appendChild(node);
            const registry = new TargetRegistry("session-1");
            const target = registry.registerText(node);
            registry.drainDirtyTargets();

            registry.transition(target.id, "queued");
            registry.transition(target.id, "in_flight");
            expect(registry.drainDirtyTargets()).toEqual([target]);
        });

        it("appends one event per state change without building a registry snapshot", () => {
            const registry = new TargetRegistry("session-1");
            const snapshotSpy = jest.spyOn(registry, "snapshot");
            for (let index = 0; index < 50; index += 1) {
                const node = document.createTextNode(`Text ${index}`);
                document.body.appendChild(node);
                const target = registry.registerText(node);
                registry.transition(target.id, "queued");
            }
            expect(snapshotSpy).not.toHaveBeenCalled();
            expect(registry.drainDirtyTargets()).toHaveLength(50);
            snapshotSpy.mockRestore();
        });

        it("marks revised blocks dirty again", () => {
            const node = document.createTextNode("Original");
            document.body.appendChild(node);
            const registry = new TargetRegistry("session-1");
            const target = registry.registerBlockTarget([node]);
            registry.drainDirtyTargets();

            node.data = "Site changed this";
            registry.registerBlockTarget([node]);
            expect(registry.drainDirtyTargets()).toEqual([target]);
            expect(target.revision).toBe(1);
        });
    });

    describe("block target registration", () => {
        it("captures ordered Text nodes with per-node inline paths and a serialized source", () => {
            document.body.innerHTML = String.raw`<p id="p">See <a href="/n">notes</a> here</p>`;
            const paragraph = document.getElementById("p");
            const anchorText = paragraph.querySelector("a").firstChild;
            const registry = new TargetRegistry("session-1");

            const target = registry.registerBlockTarget(
                [
                    { node: paragraph.childNodes[0], path: null },
                    { node: anchorText, path: "g1" },
                    { node: paragraph.childNodes[2], path: null },
                ],
                { role: "p", source: "See <g1>notes</g1> here" }
            );

            expect(target.kind).toBe("block");
            expect(target.source).toBe("See <g1>notes</g1> here");
            expect(target.textNodes.map(({ path }) => path)).toEqual([null, "g1", null]);
            expect(target.textNodes.map(({ source }) => source)).toEqual([
                "See ",
                "notes",
                " here",
            ]);

            const again = registry.registerBlockTarget([
                paragraph.childNodes[0],
                anchorText,
                paragraph.childNodes[2],
            ]);
            expect(again).toBe(target);
            expect(again.revision).toBe(0);
        });

        it("rejects registrations that are not ordered Text node lists", () => {
            const registry = new TargetRegistry("session-1");
            expect(() => registry.registerBlockTarget([])).toThrow(TypeError);
            expect(() => registry.registerBlockTarget([document.createElement("p")])).toThrow(
                TypeError
            );
        });
    });

    // Re-pinned from the deleted aiPageTranslationV2Core / aiPageTranslationV2DomInvariant suites:
    // the CAS committer is the single guardian of the spec §8 write contract (Text.data or ONE
    // allowlisted attribute, never innerHTML), so DOM identity, listeners, focus and selection
    // survive translation. The v2 suites drove the whole session; here we pin the same invariants
    // at the committer/applyBlock layer that actually enforces them.
    describe("ported DOM-invariant / attribute CAS contract (spec §8)", () => {
        it("applies and restores an allowed attribute with compare-and-swap", () => {
            const input = document.createElement("input");
            input.setAttribute("placeholder", "Search stations");
            document.body.appendChild(input);
            const target = new TargetRegistry("session-1").registerAttribute(
                input,
                "placeholder",
                { role: "placeholder" }
            );

            expect(commitTargetTranslation(target, "역 검색").status).toBe("applied");
            expect(input.getAttribute("placeholder")).toBe("역 검색");
            expect(restoreTargetSource(target).status).toBe("restored");
            expect(input.getAttribute("placeholder")).toBe("Search stations");
        });

        it("rejects a detached target and a response for an older revision", () => {
            const node = document.createTextNode("Original");
            document.body.appendChild(node);
            const registry = new TargetRegistry("session-1");
            const target = registry.registerText(node);

            expect(commitTargetTranslation(target, "번역", { revision: 1 })).toEqual({
                status: "stale",
                reason: "revision",
            });
            document.body.removeChild(node);
            expect(commitTargetTranslation(target, "번역", { revision: 0 })).toEqual({
                status: "stale",
                reason: "detached",
            });
        });

        it("applies a block via Text.data without replacing inline elements or their listeners", () => {
            document.body.innerHTML = String.raw`<p id="p">See <a id="link" href="/n" data-track="keep">notes</a> here</p>`;
            const paragraph = document.getElementById("p");
            const link = document.getElementById("link");
            const anchorText = link.firstChild;
            const elementsBefore = Array.from(paragraph.querySelectorAll("*"));
            let clicks = 0;
            link.addEventListener("click", (event) => {
                event.preventDefault();
                clicks += 1;
            });

            const registry = new TargetRegistry("session-1");
            const target = registry.registerBlockTarget(
                [
                    { node: paragraph.childNodes[0], path: null },
                    { node: anchorText, path: "g1" },
                    { node: paragraph.childNodes[2], path: null },
                ],
                { role: "p", source: "See <g1>notes</g1> here" }
            );

            expect(applyBlock(target, ["보기 ", "메모", " 여기"]).status).toBe("applied");

            // Same element nodes, same anchor identity, listener still bound, forbidden
            // attributes untouched — only the Text nodes' data changed.
            expect(Array.from(paragraph.querySelectorAll("*"))).toEqual(elementsBefore);
            expect(document.getElementById("link")).toBe(link);
            expect(link.firstChild).toBe(anchorText);
            expect(link.firstChild.data).toBe("메모");
            expect(link.getAttribute("href")).toBe("/n");
            expect(link.getAttribute("data-track")).toBe("keep");
            link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            expect(clicks).toBe(1);
        });

        it("preserves focus and selection while translating an allowed attribute", () => {
            document.body.innerHTML = String.raw`<input id="editor" value="user draft" placeholder="Search stations">`;
            const input = document.getElementById("editor");
            input.focus();
            input.setSelectionRange(2, 6);
            const target = new TargetRegistry("session-1").registerAttribute(input, "placeholder", {
                role: "placeholder",
            });

            expect(commitTargetTranslation(target, "역 검색").status).toBe("applied");

            expect(input.placeholder).toBe("역 검색");
            expect(input.value).toBe("user draft");
            expect(document.activeElement).toBe(input);
            expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
        });
    });
});
