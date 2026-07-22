const fs = require("fs");
const path = require("path");

const dropdownSource = fs.readFileSync(
    path.resolve(__dirname, "../../../src/content/display/Dropdown.jsx"),
    "utf8"
);

describe("translation panel dropdown accessibility contract", () => {
    it("uses native button and radio-menu semantics", () => {
        expect(dropdownSource).toContain("const Title = styled.button");
        expect(dropdownSource).toContain('aria-haspopup="menu"');
        expect(dropdownSource).toContain('role="menu"');
        expect(dropdownSource).toContain('role="menuitemradio"');
        expect(dropdownSource).toContain("aria-checked={Boolean(props.active)}");
    });

    it("supports keyboard traversal and visible keyboard focus", () => {
        for (const key of ["Escape", "ArrowDown", "ArrowUp", "Home", "End"]) {
            expect(dropdownSource).toContain(`event.key === "${key}"`);
        }
        expect(dropdownSource).toContain("&:focus-visible");
        expect(dropdownSource).toContain("titleElRef.current?.focus()");
    });
});
