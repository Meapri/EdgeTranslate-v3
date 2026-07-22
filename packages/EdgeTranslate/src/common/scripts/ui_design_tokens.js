/**
 * Shared visual tokens for EdgeTranslate's injected UI surfaces.
 *
 * Content-script surfaces live in separate shadow roots, so CSS custom properties cannot be
 * inherited between them. Keeping the canonical values in this module prevents the page banner,
 * selection panel and shared language menu from drifting while still letting each surface expose
 * locally-scoped CSS variables.
 */
export const EDGE_UI = Object.freeze({
    color: Object.freeze({
        accentLight: "#0066cc",
        accentDark: "#2997ff",
        textLight: "#1d1d1f",
        textDark: "#f5f5f7",
        mutedLight: "rgba(60, 60, 67, 0.62)",
        mutedDark: "rgba(235, 235, 245, 0.60)",
        controlLight: "rgba(118, 118, 128, 0.12)",
        controlLightHover: "rgba(118, 118, 128, 0.20)",
        controlDark: "rgba(118, 118, 128, 0.24)",
        controlDarkHover: "rgba(118, 118, 128, 0.36)",
    }),
    radius: Object.freeze({
        surface: "18px",
        control: "11px",
        pill: "999px",
    }),
    motion: Object.freeze({
        fast: "180ms cubic-bezier(0.25, 1, 0.5, 1)",
        standard: "280ms cubic-bezier(0.25, 1, 0.5, 1)",
        snappy: "280ms cubic-bezier(0.16, 1, 0.3, 1)",
        spotlightIn: "210ms cubic-bezier(0.2, 0, 0, 1)",
        spotlightOut: "170ms cubic-bezier(0.32, 0, 0.67, 0)",
        press: "120ms cubic-bezier(0.25, 1, 0.5, 1)",
    }),
});

export default EDGE_UI;
