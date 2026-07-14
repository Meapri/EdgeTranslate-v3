import { MutationWatcher } from "../../../src/content/ai_page_translation/dom/mutation_watcher.js";
import { TargetRegistry } from "../../../src/content/ai_page_translation/dom/target_registry.js";
import {
    applyBlock,
    commitTargetTranslation,
} from "../../../src/content/ai_page_translation/dom/committer.js";
import { collectSubtreeTargets } from "../../../src/content/ai_page_translation/dom/collector.js";

function makeRegistry() {
    return new TargetRegistry("session-watcher");
}

function advanceTargetStates(registry, id, states) {
    for (const state of states) registry.transition(id, state);
}

// jsdom delivers MutationObserver callbacks on the microtask queue; fake timers do not
// intercept microtasks, so a few awaits flush pending records into the watcher.
async function flushObserver() {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("ai page translation vNext mutation watcher", () => {
    let onNewContent;
    let onChangedTarget;

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = "";
        onNewContent = jest.fn();
        onChangedTarget = jest.fn();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function makeWatcher(registry, options = {}) {
        return new MutationWatcher({
            registry,
            onNewContent,
            onChangedTarget,
            ...options,
        });
    }

    test("coalesces mutations inside one 75ms window into a single batch", async () => {
        document.body.innerHTML = "<div id='container'></div>";
        const container = document.getElementById("container");
        const registry = makeRegistry();
        const watcher = makeWatcher(registry);
        watcher.start([container]);

        const first = document.createElement("p");
        first.textContent = "첫 번째 추가";
        container.appendChild(first);
        await flushObserver();
        jest.advanceTimersByTime(30);

        const second = document.createElement("p");
        second.textContent = "두 번째 추가";
        container.appendChild(second);
        await flushObserver();

        // 74ms after the FIRST record: still coalescing.
        jest.advanceTimersByTime(44);
        expect(onNewContent).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        expect(onNewContent).toHaveBeenCalledTimes(1);
        expect(onNewContent.mock.calls[0][0]).toEqual(expect.arrayContaining([first, second]));
        expect(onNewContent.mock.calls[0][0]).toHaveLength(2);
        watcher.stop();
    });

    test("prunes nested pending roots to the outermost node", async () => {
        document.body.innerHTML = "<div id='container'></div>";
        const container = document.getElementById("container");
        const registry = makeRegistry();
        const watcher = makeWatcher(registry);
        watcher.start([container]);

        const wrapper = document.createElement("div");
        wrapper.innerHTML = "<p>첫 문단</p>";
        container.appendChild(wrapper);
        await flushObserver();

        const extra = document.createElement("p");
        extra.textContent = "둘째 문단";
        wrapper.appendChild(extra);
        await flushObserver();

        jest.advanceTimersByTime(80);
        expect(onNewContent).toHaveBeenCalledTimes(1);
        expect(onNewContent.mock.calls[0][0]).toEqual([wrapper]);
        watcher.stop();
    });

    test("committer block applies are recognized as own writes — no re-enqueue loop", async () => {
        document.body.innerHTML = "<div id='container'><p id='blk'>Hello <b>world</b></p></div>";
        const registry = makeRegistry();
        const { targets } = collectSubtreeTargets(document.getElementById("blk"), registry);
        expect(targets).toHaveLength(1);
        const target = targets[0].target;
        advanceTargetStates(registry, target.id, ["queued", "in_flight", "validated"]);

        const watcher = makeWatcher(registry);
        watcher.track(target);
        watcher.start([document.getElementById("container")]);

        // Apply WITHOUT pause: the applied-value guard alone must prevent the loop.
        const applied = applyBlock(target, ["안녕 ", "세계"]);
        expect(applied.status).toBe("applied");
        registry.transition(target.id, "applied", { appliedTranslation: "안녕 세계" });

        await flushObserver();
        jest.advanceTimersByTime(80);
        expect(onChangedTarget).not.toHaveBeenCalled();
        expect(onNewContent).not.toHaveBeenCalled();
        expect(target.revision).toBe(0);
        expect(target.state).toBe("applied");
        watcher.stop();
    });

    test("true site mutations bump the revision via the registry and report onChangedTarget", async () => {
        document.body.innerHTML = "<div id='container'><p id='blk'>Hello <b>world</b></p></div>";
        const registry = makeRegistry();
        const { targets } = collectSubtreeTargets(document.getElementById("blk"), registry);
        const target = targets[0].target;

        const watcher = makeWatcher(registry);
        watcher.track(target);
        watcher.start([document.getElementById("container")]);

        document.getElementById("blk").firstChild.data = "사이트가 바꾼 텍스트 ";
        await flushObserver();
        jest.advanceTimersByTime(80);

        expect(onChangedTarget).toHaveBeenCalledTimes(1);
        const changed = onChangedTarget.mock.calls[0][0];
        expect(changed.id).toBe(target.id);
        expect(changed.revision).toBe(1);
        expect(changed.state).toBe("discovered");
        expect(onNewContent).not.toHaveBeenCalled();
        watcher.stop();
    });

    test("atomic text commits pass the registerText guard; later real edits still revise", async () => {
        document.body.innerHTML = "<div id='container'><p id='p1'>원본 문장</p></div>";
        const registry = makeRegistry();
        const node = document.getElementById("p1").firstChild;
        const target = registry.registerText(node, { role: "p" });
        advanceTargetStates(registry, target.id, ["queued", "in_flight", "validated"]);

        const watcher = makeWatcher(registry);
        watcher.track(target);
        watcher.start([document.getElementById("container")]);

        const committed = commitTargetTranslation(target, "번역된 문장");
        expect(committed.status).toBe("applied");
        registry.transition(target.id, "applied", { appliedTranslation: "번역된 문장" });

        await flushObserver();
        jest.advanceTimersByTime(80);
        expect(onChangedTarget).not.toHaveBeenCalled();
        expect(target.revision).toBe(0);

        node.data = "사이트 변경 문장";
        await flushObserver();
        jest.advanceTimersByTime(80);
        expect(onChangedTarget).toHaveBeenCalledTimes(1);
        expect(target.revision).toBe(1);
        expect(target.state).toBe("discovered");
        watcher.stop();
    });

    test("pause(fn) runs with the observer disconnected and reconnects afterwards", async () => {
        document.body.innerHTML = "<div id='container'><p id='p1'>원본 텍스트</p></div>";
        const container = document.getElementById("container");
        const registry = makeRegistry();
        const watcher = makeWatcher(registry);
        watcher.start([container]);

        const result = watcher.pause(() => {
            document.getElementById("p1").firstChild.data = "조용한 일괄 적용";
            return 42;
        });
        expect(result).toBe(42);

        await flushObserver();
        jest.advanceTimersByTime(100);
        expect(onNewContent).not.toHaveBeenCalled();
        expect(onChangedTarget).not.toHaveBeenCalled();

        // Reconnected: fresh mutations are observed again.
        const extra = document.createElement("p");
        extra.textContent = "재연결 확인";
        container.appendChild(extra);
        await flushObserver();
        jest.advanceTimersByTime(80);
        expect(onNewContent).toHaveBeenCalledTimes(1);
        expect(onNewContent.mock.calls[0][0]).toEqual([extra]);
        watcher.stop();
    });

    test("characterData on untracked text surfaces the parent element as new content", async () => {
        document.body.innerHTML = "<div id='container'><p id='p1'>원본 텍스트</p></div>";
        const registry = makeRegistry();
        const watcher = makeWatcher(registry);
        watcher.start([document.getElementById("container")]);

        document.getElementById("p1").firstChild.data = "변경된 텍스트";
        await flushObserver();
        jest.advanceTimersByTime(80);

        expect(onNewContent).toHaveBeenCalledTimes(1);
        expect(onNewContent.mock.calls[0][0]).toEqual([document.getElementById("p1")]);
        expect(onChangedTarget).not.toHaveBeenCalled();
        watcher.stop();
    });

    test.each([
        ["img", "alt", "원래 사진 설명", "바뀐 사진 설명"],
        ["input", "placeholder", "검색어 입력 안내", "새 검색어 입력 안내"],
        ["button", "aria-label", "메뉴 열기 안내", "탐색 메뉴 열기"],
        ["input", "value", "양식 제출하기", "변경 내용 제출"],
    ])(
        "revises tracked %s[%s] targets on attribute-only mutation",
        async (tag, name, before, after) => {
            const type = name === "value" ? " type='submit'" : "";
            document.body.innerHTML = `<div id='container'><${tag} id='target'${type} ${name}='${before}'></${tag}></div>`;
            const registry = makeRegistry();
            const element = document.getElementById("target");
            const target = registry.registerAttribute(element, name, { role: "aria" });
            const watcher = makeWatcher(registry);
            watcher.track(target);
            watcher.start([document.getElementById("container")]);

            element.setAttribute(name, after);
            await flushObserver();
            jest.advanceTimersByTime(80);

            expect(onChangedTarget).toHaveBeenCalledTimes(1);
            expect(target.revision).toBe(1);
            expect(target.source).toBe(after);
            watcher.stop();
        }
    );

    test("surfaces a newly added translatable attribute as new content", async () => {
        document.body.innerHTML = "<div id='container'><img id='image'></div>";
        const registry = makeRegistry();
        const watcher = makeWatcher(registry);
        watcher.start([document.getElementById("container")]);

        const image = document.getElementById("image");
        image.setAttribute("alt", "새로 추가된 사진 설명");
        await flushObserver();
        jest.advanceTimersByTime(80);

        expect(onNewContent).toHaveBeenCalledTimes(1);
        expect(onNewContent.mock.calls[0][0]).toEqual([image]);
        watcher.stop();
    });

    test("root guardian recovers from body replacement and keeps observing", async () => {
        const registry = makeRegistry();
        const watcher = makeWatcher(registry);
        watcher.start([document.body]);

        const newBody = document.createElement("body");
        const paragraph = document.createElement("p");
        paragraph.textContent = "새 본문";
        newBody.appendChild(paragraph);
        document.documentElement.replaceChild(newBody, document.body);

        await flushObserver();
        jest.advanceTimersByTime(80);
        expect(onNewContent).toHaveBeenCalledTimes(1);
        expect(onNewContent.mock.calls[0][0]).toEqual([newBody]);

        onNewContent.mockClear();
        const extra = document.createElement("p");
        extra.textContent = "추가 문단";
        newBody.appendChild(extra);
        await flushObserver();
        jest.advanceTimersByTime(80);
        expect(onNewContent).toHaveBeenCalledTimes(1);
        expect(onNewContent.mock.calls[0][0]).toEqual([extra]);
        watcher.stop();
    });

    test("stop() disconnects observers and drops pending work", async () => {
        document.body.innerHTML = "<div id='container'></div>";
        const container = document.getElementById("container");
        const registry = makeRegistry();
        const watcher = makeWatcher(registry);
        watcher.start([container]);

        const added = document.createElement("p");
        added.textContent = "중단 전 추가";
        container.appendChild(added);
        await flushObserver();
        watcher.stop();

        jest.advanceTimersByTime(200);
        const late = document.createElement("p");
        late.textContent = "중단 후 추가";
        container.appendChild(late);
        await flushObserver();
        jest.advanceTimersByTime(200);

        expect(onNewContent).not.toHaveBeenCalled();
        expect(onChangedTarget).not.toHaveBeenCalled();
    });
});
