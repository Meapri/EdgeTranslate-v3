import { createLanguageMenu } from "../../../src/common/scripts/language_menu.js";

const LANGS = [
    { value: "auto", label: "Auto Detect" },
    { value: "en", label: "English" },
    { value: "ko", label: "Korean" },
    { value: "ja", label: "Japanese" },
    { value: "fr", label: "Français" },
];

describe("createLanguageMenu", () => {
    let host;
    beforeEach(() => {
        document.body.innerHTML = "";
        host = document.createElement("div");
        document.body.appendChild(host);
    });

    it("renders a trigger showing the current value's label", () => {
        const menu = createLanguageMenu({ languages: LANGS, value: "ko", onChange: jest.fn() });
        host.appendChild(menu.element);
        expect(menu.element.querySelector(".et-lang-trigger-label").textContent).toBe("Korean");
        expect(menu.getValue()).toBe("ko");
        menu.destroy();
    });

    it("injects its scoped stylesheet once", () => {
        createLanguageMenu({ languages: LANGS, value: "en" });
        createLanguageMenu({ languages: LANGS, value: "en" });
        expect(document.querySelectorAll("#edge-translate-language-menu-styles").length).toBe(1);
    });

    it("opens a searchable popover listing every language with the selection marked", () => {
        const menu = createLanguageMenu({ languages: LANGS, value: "en" });
        host.appendChild(menu.element);
        menu.open();
        const popover = document.body.querySelector(".et-lang-popover");
        expect(popover).not.toBeNull();
        expect(popover.hidden).toBe(false);
        expect(popover.querySelectorAll(".et-lang-option").length).toBe(LANGS.length);
        const selected = popover.querySelector(".et-lang-option.is-selected");
        expect(selected.dataset.value).toBe("en");
        menu.destroy();
    });

    it("filters the list (accent-insensitive) as the user types", () => {
        const menu = createLanguageMenu({ languages: LANGS, value: "en" });
        host.appendChild(menu.element);
        menu.open();
        const search = document.body.querySelector(".et-lang-search");
        search.value = "franc"; // should match "Français"
        search.dispatchEvent(new Event("input", { bubbles: true }));
        const options = document.body.querySelectorAll(".et-lang-option");
        expect(options.length).toBe(1);
        expect(options[0].dataset.value).toBe("fr");
        menu.destroy();
    });

    it("selecting an option fires onChange once, updates the trigger, and closes", () => {
        const onChange = jest.fn();
        const menu = createLanguageMenu({ languages: LANGS, value: "en", onChange });
        host.appendChild(menu.element);
        menu.open();
        const option = [...document.body.querySelectorAll(".et-lang-option")].find(
            (o) => o.dataset.value === "ja"
        );
        option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith("ja");
        expect(menu.getValue()).toBe("ja");
        expect(menu.element.querySelector(".et-lang-trigger-label").textContent).toBe("Japanese");
        menu.destroy();
    });

    it("setValue updates the trigger WITHOUT firing onChange", () => {
        const onChange = jest.fn();
        const menu = createLanguageMenu({ languages: LANGS, value: "en", onChange });
        host.appendChild(menu.element);
        menu.setValue("ko");
        expect(menu.getValue()).toBe("ko");
        expect(menu.element.querySelector(".et-lang-trigger-label").textContent).toBe("Korean");
        expect(onChange).not.toHaveBeenCalled();
        menu.destroy();
    });

    it("keyboard: ArrowDown then Enter selects the next language", () => {
        const onChange = jest.fn();
        const menu = createLanguageMenu({ languages: LANGS, value: "auto", onChange });
        host.appendChild(menu.element);
        menu.open(); // active starts on the selected 'auto' (index 0)
        const search = document.body.querySelector(".et-lang-search");
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(onChange).toHaveBeenCalledWith("en");
        menu.destroy();
    });

    it("accepts a { code: label } object form for languages", () => {
        const menu = createLanguageMenu({
            languages: { en: "English", ko: "Korean" },
            value: "ko",
        });
        host.appendChild(menu.element);
        expect(menu.element.querySelector(".et-lang-trigger-label").textContent).toBe("Korean");
        menu.open();
        expect(document.body.querySelectorAll(".et-lang-option").length).toBe(2);
        menu.destroy();
    });
});
