/**
 * Reusable, dependency-free "pretty" language picker.
 *
 * A trigger button that opens a searchable popover list of languages. Built to be used both in the
 * extension popup (its own page) and inside the content-script page-translation banner (injected
 * into an arbitrary host page), so it:
 *   - injects its own scoped CSS once (prefixed `.et-lang-*`), and
 *   - renders the popover into <body> with `position: fixed` so it escapes any `overflow:hidden`
 *     / stacking-context / z-index trap from the popup or the host page.
 *
 * Keyboard accessible (open with Enter/Space/↓, navigate with ↑/↓, select with Enter, close with
 * Esc, type to filter), dark-mode aware, and animation respects prefers-reduced-motion.
 *
 *   const menu = createLanguageMenu({
 *       languages: [{ value: "en", label: "English" }, ...],   // or { en: "English", ... }
 *       value: "en",
 *       onChange: (code) => { ... },
 *       ariaLabel: "Target language",
 *   });
 *   container.appendChild(menu.element);
 *   menu.setValue("ko");   // programmatic update (no onChange)
 *   menu.destroy();        // remove listeners + popover
 */

import { EDGE_UI } from "common/scripts/ui_design_tokens.js";

const STYLE_ID = "edge-translate-language-menu-styles";
const EXTENSION_OWNED_ATTRIBUTE = "data-edge-translate-owned";
// Content-script surfaces (the selection panel and page-translation banner) already occupy the
// browser's highest z-index. Use the same maximum as a fallback and prefer the native popover top
// layer below. Keep the inline important declaration as a shield against arbitrary host-page
// author styles.
export const LANGUAGE_MENU_LAYER_Z_INDEX = 2147483647;
let instanceCounter = 0;

function normalizeLanguages(languages) {
    if (!languages) return [];
    if (Array.isArray(languages)) {
        return languages
            .map((item) =>
                item && typeof item === "object"
                    ? { value: String(item.value), label: String(item.label ?? item.value) }
                    : { value: String(item), label: String(item) }
            )
            .filter((item) => item.value);
    }
    return Object.keys(languages).map((value) => ({
        value,
        label: String(languages[value] ?? value),
    }));
}

// Loose, accent-insensitive match so "francais" finds "Français" and "kor" finds "Korean".
function foldText(text) {
    let value = String(text || "").toLowerCase();
    if (typeof value.normalize === "function") {
        value = value.normalize("NFD").replace(/[̀-ͯ]/g, "");
    }
    return value;
}

function createIcon(doc, name, className) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.classList.add("et-lang-icon", className);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const addPath = (d) => {
        const path = doc.createElementNS(ns, "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
    };
    if (name === "language") {
        const circle = doc.createElementNS(ns, "circle");
        circle.setAttribute("cx", "12");
        circle.setAttribute("cy", "12");
        circle.setAttribute("r", "9");
        svg.appendChild(circle);
        addPath(
            "M3 12h18M12 3c2.3 2.45 3.5 5.45 3.5 9s-1.2 6.55-3.5 9c-2.3-2.45-3.5-5.45-3.5-9S9.7 5.45 12 3Z"
        );
    } else if (name === "search") {
        const circle = doc.createElementNS(ns, "circle");
        circle.setAttribute("cx", "10.8");
        circle.setAttribute("cy", "10.8");
        circle.setAttribute("r", "6.3");
        svg.appendChild(circle);
        addPath("m15.5 15.5 4 4");
    } else if (name === "chevron") {
        addPath("m7.5 9.5 4.5 4.5 4.5-4.5");
    } else if (name === "check") {
        addPath("m7.5 12.2 3 3 6-6.4");
    }
    return svg;
}

// Inject the menu's CSS into a styling root. `root` may be a Document (styles go in <head>), a
// ShadowRoot, or an Element — so the trigger can be styled inside the content-script banner's
// shadow DOM while the popover (rendered into the page body) is styled from the page's <head>.
function injectStyles(root) {
    if (!root) return;
    const already =
        (root.querySelector && root.querySelector(`#${STYLE_ID}`)) ||
        (root.getElementById && root.getElementById(STYLE_ID));
    if (already) return;
    const ownerDoc = root.ownerDocument || (root.nodeType === 9 ? root : document);
    const style = ownerDoc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = LANGUAGE_MENU_CSS;
    const target = root.head || root; // Document → <head>; ShadowRoot/Element → itself.
    target.appendChild(style);
}

export function createLanguageMenu(options = {}) {
    const doc = options.document || document;
    // Where the TRIGGER lives + is styled (default: the document). The banner passes its shadow
    // root so the trigger is styled inside the shadow tree.
    const styleRoot = options.styleRoot || doc;
    // Where the POPOVER is appended (default: the page body) — fixed-positioned so it escapes any
    // overflow / stacking trap, including a shadow host.
    const popoverContainer = options.popoverContainer || doc.body;
    injectStyles(styleRoot);
    // The popover lives in popoverContainer's document, so that document's root also needs the CSS.
    injectStyles(popoverContainer.ownerDocument || doc);

    const items = normalizeLanguages(options.languages);
    const id = `et-lang-${(instanceCounter += 1)}`;
    let currentValue = options.value != null ? String(options.value) : items[0]?.value || "";
    let isOpen = false;
    let activeIndex = -1;
    let filtered = items.slice();

    const wrapper = doc.createElement("div");
    wrapper.className = "et-lang-menu";
    wrapper.setAttribute(EXTENSION_OWNED_ATTRIBUTE, "");

    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = "et-lang-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    if (options.ariaLabel) trigger.setAttribute("aria-label", options.ariaLabel);

    const triggerIcon = createIcon(doc, "language", "et-lang-trigger-icon");
    const triggerLabel = doc.createElement("span");
    triggerLabel.className = "et-lang-trigger-label";
    const chevron = createIcon(doc, "chevron", "et-lang-trigger-chevron");
    trigger.appendChild(triggerIcon);
    trigger.appendChild(triggerLabel);
    trigger.appendChild(chevron);
    wrapper.appendChild(trigger);

    // Popover lives in <body> (fixed) so it can never be clipped by the popup's overflow:hidden
    // or a host page's stacking context.
    const popover = doc.createElement("div");
    popover.className = "et-lang-popover";
    popover.setAttribute(EXTENSION_OWNED_ATTRIBUTE, "");
    popover.setAttribute("role", "listbox");
    popover.id = `${id}-popover`;
    popover.hidden = true;
    popover.style.setProperty("z-index", String(LANGUAGE_MENU_LAYER_Z_INDEX), "important");
    // The browser top layer is the only stacking plane guaranteed to sit above a max-z-index
    // translation panel/banner. Older engines fall back to mounting as the last <html> child.
    let usesTopLayer =
        typeof popover.showPopover === "function" && typeof popover.hidePopover === "function";
    if (usesTopLayer) popover.setAttribute("popover", "manual");
    if (options.ariaLabel) popover.setAttribute("aria-label", options.ariaLabel);

    const searchWrap = doc.createElement("div");
    searchWrap.className = "et-lang-search-wrap";
    const searchIcon = createIcon(doc, "search", "et-lang-search-icon");
    const search = doc.createElement("input");
    search.type = "text";
    search.className = "et-lang-search";
    search.setAttribute("autocomplete", "off");
    search.setAttribute("spellcheck", "false");
    search.placeholder = options.searchPlaceholder || "Search language";
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(search);
    popover.appendChild(searchWrap);

    const list = doc.createElement("div");
    list.className = "et-lang-list";
    popover.appendChild(list);

    const empty = doc.createElement("div");
    empty.className = "et-lang-empty";
    empty.hidden = true;
    empty.textContent = options.emptyText || "No matches";
    popover.appendChild(empty);

    function labelFor(value) {
        const found = items.find((item) => item.value === value);
        return found ? found.label : value;
    }

    function renderTrigger() {
        triggerLabel.textContent = labelFor(currentValue);
    }

    function renderList() {
        list.textContent = "";
        empty.hidden = filtered.length > 0;
        filtered.forEach((item, index) => {
            const option = doc.createElement("button");
            option.type = "button";
            option.className = "et-lang-option";
            option.setAttribute("role", "option");
            option.dataset.value = item.value;
            option.dataset.index = String(index);
            const selected = item.value === currentValue;
            const active = index === activeIndex;
            option.setAttribute("aria-selected", selected ? "true" : "false");
            if (selected) option.classList.add("is-selected");
            if (active) option.classList.add("is-active");

            const text = doc.createElement("span");
            text.className = "et-lang-option-label";
            text.textContent = item.label;
            const check = doc.createElement("span");
            check.className = "et-lang-option-check";
            check.setAttribute("aria-hidden", "true");
            check.appendChild(createIcon(doc, "check", "et-lang-check-icon"));
            if (selected) check.classList.add("is-visible");
            option.appendChild(text);
            option.appendChild(check);
            list.appendChild(option);
        });
    }

    function positionPopover() {
        const rect = trigger.getBoundingClientRect();
        const viewportH = doc.documentElement.clientHeight || window.innerHeight || 600;
        const gap = 6;
        const viewportW = doc.documentElement.clientWidth || window.innerWidth || 800;
        const desiredW = Math.min(Math.max(rect.width, 252), Math.max(200, viewportW - 16));
        popover.style.width = `${desiredW}px`;
        popover.style.left = `${Math.max(8, Math.min(rect.left, viewportW - desiredW - 8))}px`;
        // Flip above the trigger when there isn't room below.
        const spaceBelow = viewportH - rect.bottom;
        const popH = Math.min(popover.scrollHeight || 300, 320);
        if (spaceBelow < popH + gap && rect.top > spaceBelow) {
            popover.style.top = "auto";
            popover.style.bottom = `${Math.max(8, viewportH - rect.top + gap)}px`;
        } else {
            popover.style.bottom = "auto";
            popover.style.top = `${rect.bottom + gap}px`;
        }
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        activeIndex = Math.max(
            0,
            filtered.findIndex((item) => item.value === currentValue)
        );
        search.value = "";
        applyFilter("");
        const fallbackContainer = doc.documentElement || popoverContainer;
        const mount = usesTopLayer ? popoverContainer : fallbackContainer;
        if (!mount.contains(popover)) mount.appendChild(popover);
        popover.hidden = false;
        if (usesTopLayer) {
            try {
                popover.showPopover();
            } catch {
                // A partially implemented Popover API must not leave the menu invisible.
                usesTopLayer = false;
                popover.removeAttribute("popover");
                fallbackContainer.appendChild(popover);
            }
        }
        trigger.setAttribute("aria-expanded", "true");
        wrapper.classList.add("is-open");
        positionPopover();
        // Flush the initial hidden style before enabling the transition. Unlike a deferred rAF,
        // this remains reliable in background/throttled tabs and headless extension QA.
        popover.getBoundingClientRect();
        popover.classList.add("is-visible");
        scrollActiveIntoView();
        setTimeout(() => search.focus(), 0);
        doc.addEventListener("pointerdown", onDocPointerDown, true);
        window.addEventListener("scroll", onScrollOrResize, true);
        window.addEventListener("resize", onScrollOrResize, true);
    }

    function close({ focusTrigger = false } = {}) {
        if (!isOpen) return;
        isOpen = false;
        popover.classList.remove("is-visible");
        trigger.setAttribute("aria-expanded", "false");
        wrapper.classList.remove("is-open");
        doc.removeEventListener("pointerdown", onDocPointerDown, true);
        window.removeEventListener("scroll", onScrollOrResize, true);
        window.removeEventListener("resize", onScrollOrResize, true);
        const finalize = () => {
            if (isOpen) return;
            if (usesTopLayer) {
                try {
                    if (popover.matches(":popover-open")) popover.hidePopover();
                } catch {
                    /* a detached popover is already closed */
                }
            }
            popover.hidden = true;
            if (popover.parentNode) popover.parentNode.removeChild(popover);
        };
        // Wait out the exit transition; fall back if transitionend doesn't fire.
        let done = false;
        const onEnd = () => {
            if (done) return;
            done = true;
            popover.removeEventListener("transitionend", onEnd);
            finalize();
        };
        popover.addEventListener("transitionend", onEnd);
        setTimeout(onEnd, 220);
        if (focusTrigger) trigger.focus();
    }

    function toggle() {
        if (isOpen) close({ focusTrigger: true });
        else open();
    }

    function applyFilter(query) {
        const q = foldText(query).trim();
        filtered = q
            ? items.filter(
                  (item) => foldText(item.label).includes(q) || foldText(item.value).includes(q)
              )
            : items.slice();
        if (activeIndex >= filtered.length) activeIndex = filtered.length - 1;
        if (activeIndex < 0 && filtered.length) activeIndex = 0;
        renderList();
    }

    function scrollActiveIntoView() {
        const node = list.querySelector(`.et-lang-option[data-index="${activeIndex}"]`);
        if (node && typeof node.scrollIntoView === "function") {
            node.scrollIntoView({ block: "center" });
        }
    }

    function setActive(index) {
        if (!filtered.length) return;
        activeIndex = (index + filtered.length) % filtered.length;
        renderList();
        scrollActiveIntoView();
    }

    function commit(value) {
        const next = String(value);
        const changed = next !== currentValue;
        currentValue = next;
        renderTrigger();
        close({ focusTrigger: true });
        if (changed && typeof options.onChange === "function") options.onChange(currentValue);
    }

    function onDocPointerDown(event) {
        // composedPath crosses shadow boundaries, so a click on the trigger inside the banner's
        // shadow DOM (which retargets event.target to the shadow host) is still recognized.
        const path =
            typeof event.composedPath === "function" ? event.composedPath() : [event.target];
        if (path.includes(wrapper) || path.includes(popover)) return;
        close();
    }

    function onScrollOrResize() {
        // Reposition rather than close so the popover tracks the trigger; cheap enough on scroll.
        if (isOpen) positionPopover();
    }

    trigger.addEventListener("click", (event) => {
        event.preventDefault();
        toggle();
    });
    trigger.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
        }
    });

    search.addEventListener("input", () => applyFilter(search.value));
    search.addEventListener("keydown", (event) => {
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                setActive(activeIndex + 1);
                break;
            case "ArrowUp":
                event.preventDefault();
                setActive(activeIndex - 1);
                break;
            case "Enter": {
                event.preventDefault();
                const item = filtered[activeIndex];
                if (item) commit(item.value);
                break;
            }
            case "Escape":
                event.preventDefault();
                close({ focusTrigger: true });
                break;
            default:
                break;
        }
    });

    list.addEventListener("click", (event) => {
        const option = event.target.closest(".et-lang-option");
        if (!option) return;
        event.preventDefault();
        commit(option.dataset.value);
    });
    list.addEventListener("pointermove", (event) => {
        const option = event.target.closest(".et-lang-option");
        if (!option) return;
        const index = Number(option.dataset.index);
        if (Number.isFinite(index) && index !== activeIndex) {
            activeIndex = index;
            renderList();
        }
    });

    renderTrigger();

    return {
        element: wrapper,
        getValue: () => currentValue,
        setValue(value) {
            currentValue = String(value);
            renderTrigger();
            if (isOpen) renderList();
        },
        setLanguages(next) {
            const normalized = normalizeLanguages(next);
            items.length = 0;
            items.push(...normalized);
            renderTrigger();
            if (isOpen) applyFilter(search.value);
        },
        open,
        close: () => close(),
        destroy() {
            close();
            if (popover.parentNode) popover.parentNode.removeChild(popover);
            if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
        },
    };
}

const LANGUAGE_MENU_CSS = `
.et-lang-menu, .et-lang-popover {
    --et-lang-accent: ${EDGE_UI.color.accentLight};
    --et-lang-accent-soft: rgba(10, 132, 255, 0.12);
    --et-lang-surface: rgba(248, 250, 253, 0.98);
    --et-lang-surface-strong: rgba(255, 255, 255, 0.98);
    --et-lang-surface-2: ${EDGE_UI.color.controlLight};
    --et-lang-text: ${EDGE_UI.color.textLight};
    --et-lang-muted: ${EDGE_UI.color.mutedLight};
    --et-lang-border: rgba(255, 255, 255, 0.78);
    --et-lang-separator: rgba(60, 60, 67, 0.12);
    --et-lang-shadow: 0 24px 60px rgba(20, 35, 58, 0.20), 0 8px 24px rgba(20, 35, 58, 0.12), 0 0 0 0.5px rgba(60, 60, 67, 0.12);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    box-sizing: border-box;
}
.et-lang-menu { position: relative; display: inline-block; width: 100%; }
.et-lang-menu *, .et-lang-popover * { box-sizing: border-box; }
.et-lang-icon { display: block; flex: 0 0 auto; pointer-events: none; }

.et-lang-trigger {
    display: flex; align-items: center; gap: 7px; width: 100%;
    padding: 8px 12px; min-height: 38px;
    border: 1px solid var(--et-lang-border); border-radius: ${EDGE_UI.radius.control};
    background: var(--et-lang-surface-strong); color: var(--et-lang-text);
    font-size: 14px; font-weight: 600; line-height: 1.2; cursor: pointer;
    text-align: left;
    -webkit-backdrop-filter: saturate(180%) blur(18px); backdrop-filter: saturate(180%) blur(18px);
    transition: border-color ${EDGE_UI.motion.fast}, box-shadow ${EDGE_UI.motion.fast}, background-color ${EDGE_UI.motion.fast}, transform ${EDGE_UI.motion.press};
}
.et-lang-trigger:hover { background: var(--et-lang-surface-2); border-color: rgba(74, 140, 247, 0.5); }
.et-lang-trigger:active { transform: scale(0.985); }
.et-lang-trigger:focus-visible { outline: none; border-color: var(--et-lang-accent); box-shadow: 0 0 0 3px rgba(74, 140, 247, 0.25); }
.et-lang-menu.is-open .et-lang-trigger { border-color: var(--et-lang-accent); box-shadow: 0 0 0 3px rgba(74, 140, 247, 0.18); }
.et-lang-trigger-icon { width: 16px; height: 16px; color: var(--et-lang-accent); stroke-width: 1.7; }
.et-lang-trigger-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.et-lang-trigger-chevron { width: 14px; height: 14px; color: var(--et-lang-muted); transition: transform 180ms cubic-bezier(0.2, 0, 0, 1), color 140ms ease; }
.et-lang-menu.is-open .et-lang-trigger-chevron { transform: rotate(180deg); color: var(--et-lang-accent); }

.et-lang-popover {
    position: fixed; inset: auto; margin: 0; z-index: ${LANGUAGE_MENU_LAYER_Z_INDEX} !important; max-height: 320px; min-width: 200px;
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--et-lang-surface); color: var(--et-lang-text);
    border: 1px solid var(--et-lang-border); border-radius: ${EDGE_UI.radius.surface};
    box-shadow: var(--et-lang-shadow);
    opacity: 1; transform: translateY(-5px) scale(0.985); transform-origin: top center;
    transition: transform ${EDGE_UI.motion.spotlightIn};
    /* Chromium can intermittently produce black compositor tiles when a native top-layer popover
       has any backdrop filter. The nearly opaque material, inset highlight and layered shadow keep
       the Liquid Glass language without risking corruption of the page behind it. */
    -webkit-backdrop-filter: none; backdrop-filter: none;
}
.et-lang-popover.is-visible { opacity: 1; transform: translateY(0) scale(1); }

.et-lang-search-wrap {
    display: flex; align-items: center; gap: 8px; margin: 10px 10px 4px; padding: 9px 10px;
    border: 1px solid transparent; border-radius: ${EDGE_UI.radius.control}; flex: 0 0 auto;
    background: var(--et-lang-surface-2);
    box-shadow: 0 0.5px 0 rgba(255, 255, 255, 0.75) inset;
    transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.et-lang-search-wrap:focus-within { background: var(--et-lang-surface-strong); border-color: rgba(10, 132, 255, 0.38); box-shadow: 0 0 0 3px var(--et-lang-accent-soft); }
.et-lang-search-icon { width: 16px; height: 16px; color: var(--et-lang-muted); stroke-width: 1.9; }
.et-lang-search { flex: 1 1 auto; min-width: 0; border: none; outline: none; background: transparent; color: var(--et-lang-text); font: inherit; font-size: 13px; line-height: 18px; padding: 0; }
.et-lang-search::placeholder { color: var(--et-lang-muted); }

.et-lang-list { overflow-y: auto; padding: 4px 8px 8px; flex: 1 1 auto; scrollbar-width: thin; scrollbar-color: rgba(60, 60, 67, 0.24) transparent; }
.et-lang-list::-webkit-scrollbar { width: 8px; }
.et-lang-list::-webkit-scrollbar-track { background: transparent; }
.et-lang-list::-webkit-scrollbar-thumb { background: rgba(60, 60, 67, 0.22); border: 2px solid transparent; border-radius: 999px; background-clip: padding-box; }
.et-lang-option {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
    min-height: 40px; padding: 9px 10px 9px 12px; border: none; border-radius: ${EDGE_UI.radius.control}; background: transparent;
    color: var(--et-lang-text); font-size: 13px; font-weight: 500; line-height: 1.25; text-align: left; cursor: pointer;
    transition: background-color 110ms ease, color 110ms ease, transform 110ms ease;
}
.et-lang-option:active { transform: scale(0.985); }
.et-lang-option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.et-lang-option-check {
    display: grid; place-items: center; flex: 0 0 auto; width: 20px; height: 20px;
    border-radius: ${EDGE_UI.radius.pill}; background: var(--et-lang-accent); color: #fff;
    opacity: 0; transform: scale(0.72);
    transition: opacity 120ms ease, transform 160ms cubic-bezier(0.2, 0, 0, 1);
}
.et-lang-option-check.is-visible { opacity: 1; transform: scale(1); }
.et-lang-check-icon { width: 14px; height: 14px; stroke-width: 2.2; }
.et-lang-option.is-active { background: var(--et-lang-surface-2); }
.et-lang-option.is-selected { color: var(--et-lang-accent); font-weight: 600; }
.et-lang-option.is-selected.is-active { background: var(--et-lang-accent-soft); }
.et-lang-empty { padding: 16px 12px; text-align: center; color: var(--et-lang-muted); font-size: 13px; }

@media (prefers-color-scheme: dark) {
    .et-lang-menu, .et-lang-popover {
        --et-lang-accent: ${EDGE_UI.color.accentDark};
        --et-lang-accent-soft: rgba(64, 156, 255, 0.20);
        --et-lang-surface: rgba(31, 32, 37, 0.97);
        --et-lang-surface-strong: rgba(44, 45, 51, 0.98);
        --et-lang-surface-2: ${EDGE_UI.color.controlDark};
        --et-lang-text: ${EDGE_UI.color.textDark};
        --et-lang-muted: ${EDGE_UI.color.mutedDark};
        --et-lang-border: rgba(255, 255, 255, 0.16);
        --et-lang-separator: rgba(255, 255, 255, 0.12);
        --et-lang-shadow: 0 28px 64px rgba(0, 0, 0, 0.52), 0 8px 24px rgba(0, 0, 0, 0.32), 0 0 0 0.5px rgba(255, 255, 255, 0.10);
    }
    .et-lang-search-wrap { box-shadow: 0 0.5px 0 rgba(255, 255, 255, 0.10) inset; }
    .et-lang-option.is-active { background: rgba(255, 255, 255, 0.08); }
    .et-lang-option.is-selected.is-active { background: var(--et-lang-accent-soft); }
}

@media (prefers-reduced-motion: reduce) {
    .et-lang-trigger, .et-lang-trigger-chevron, .et-lang-popover, .et-lang-option, .et-lang-option-check { transition: none !important; }
}
`;

export default createLanguageMenu;
