/**
 * Translation-root selection: the primary <main> region plus content-derived regions
 * OUTSIDE it. The in-page TOC case matters on Wikipedia's Vector-2022 skin, where the
 * sidebar table of contents lives in a <nav> NEXT TO <main> — without in-page-nav
 * detection it is never collected and stays untranslated no matter what.
 */
import { BannerController } from "../../../src/content/banner_controller.js";

describe("DOM page translation roots (in-page TOC)", () => {
    const buildVectorLikePage = () => {
        document.body.innerHTML = `
            <header>
                <nav id="global-nav" aria-label="site">
                    <ul>
                        <li><a href="/wiki/Main_Page">대문</a></li>
                        <li><a href="/wiki/Help">도움말</a></li>
                        <li><a href="/wiki/About">소개</a></li>
                        <li><a href="/wiki/Contact">연락처</a></li>
                    </ul>
                </nav>
            </header>
            <div class="columns">
                <nav id="sidebar-toc" aria-label="contents">
                    <ul>
                        <li><a href="#overview">概要</a></li>
                        <li><a href="#history">歴史</a></li>
                        <li><a href="#lines">路線</a></li>
                        <li><a href="#notes">脚注</a></li>
                    </ul>
                </nav>
                <main id="content">
                    <p>${"本文の長い段落です。".repeat(40)}</p>
                    <p>${"二つ目の長い段落です。".repeat(40)}</p>
                </main>
            </div>
            <footer>
                <nav id="footer-nav">
                    <a href="#top">ページ先頭</a>
                    <a href="#overview">概要</a>
                    <a href="#history">歴史</a>
                </nav>
            </footer>
        `;
    };

    it("adds an outside-<main> in-page TOC as a root, but never global site chrome", () => {
        buildVectorLikePage();
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };

        const roots = controller.getDomPageTranslationRoots();
        const toc = document.getElementById("sidebar-toc");
        const globalNav = document.getElementById("global-nav");
        const footerNav = document.getElementById("footer-nav");

        expect(roots.some((r) => r === toc || r.contains(toc))).toBe(true);
        // Global chrome links to other PAGES (no fragment majority) — excluded.
        expect(roots.some((r) => r === globalNav || r.contains(globalNav))).toBe(false);
        // Footer navs are excluded outright (contentinfo region).
        expect(roots.some((r) => r === footerNav || r.contains(footerNav))).toBe(false);
    });

    it("does NOT chrome-filter the in-page TOC sitting outside main (so it translates)", () => {
        // The Vector-2022 sidebar TOC is a <nav> OUTSIDE <main>. The site-chrome text filter
        // skips out-of-main navs — but an on-page-anchor TOC is content, so its entries must
        // stay eligible (this was "the sidebar 目次 is never translated" bug).
        buildVectorLikePage();
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };
        controller._aiPageConfig = controller.normalizeAiPageConfig({});
        controller._aiSectionTranslatedChildren = new WeakSet();
        const toc = document.getElementById("sidebar-toc");
        const tocEntry = toc.querySelector("li");
        const textNode = tocEntry.querySelector("a").firstChild;

        expect(controller.isDomPageChromeTextNode(textNode)).toBe(false);
        expect(controller.isAiPageSectionElementEligible(tocEntry)).toBe(true);

        // A real site nav (links to other pages, no fragment majority) is STILL chrome.
        const globalLink = document.getElementById("global-nav").querySelector("a").firstChild;
        expect(controller.isDomPageChromeTextNode(globalLink)).toBe(true);
    });

    it("ignores SPA hash-router navs and tiny anchor lists", () => {
        document.body.innerHTML = `
            <nav id="router">
                <a href="#/home">홈</a>
                <a href="#/settings">설정</a>
                <a href="#/profile">프로필</a>
                <a href="#/billing">결제</a>
            </nav>
            <nav id="tiny"><a href="#a">하나</a><a href="#b">둘</a></nav>
            <main id="content"><p>${"long enough body text. ".repeat(60)}</p></main>
        `;
        const controller = new BannerController();
        controller._domPageTranslateOptions = { engine: "googleAiStudio", sl: "ja", tl: "ko" };

        const roots = controller.getDomPageTranslationRoots();
        const router = document.getElementById("router");
        const tiny = document.getElementById("tiny");
        expect(roots.some((r) => r === router || r.contains(router))).toBe(false);
        expect(roots.some((r) => r === tiny || r.contains(tiny))).toBe(false);
    });
});
