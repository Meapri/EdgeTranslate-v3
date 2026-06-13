import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
const { JSDOM } = require("jsdom");
const ROOT = "/Users/naen/Git/EdgeTranslate-v3";
const p = path.join(ROOT, "packages/EdgeTranslate/src/content/dom_page_translate_context.js");
const html = await fs.readFile(process.argv[2] || "/tmp/keihan_corp.html", "utf8");
const dom = new JSDOM(html); const doc = dom.window.document; const win = dom.window;
globalThis.document = doc;
const src = await fs.readFile(p, "utf8");
const mod = { exports: {} };
const sandbox = { module: mod, exports: mod.exports, require, console, document: doc, window: win, Node: win.Node, NodeFilter: win.NodeFilter, DOMParser: win.DOMParser, Element: win.Element, DocumentFragment: win.DocumentFragment };
vm.createContext(sandbox);
const { code } = transformSync(src, { filename: p, babelrc: false, configFile: false, presets: [[require.resolve("@babel/preset-env"), { targets: { node: "18" } }]] });
new vm.Script(code, { filename: p }).runInContext(sandbox);
const ctx = mod.exports;

function estTokens(text) {
  const v = String(text || "");
  const cjk = (v.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  return Math.ceil(cjk * 0.8 + Math.max(0, v.length - cjk) / 3.6);
}
function textLen(el){return String((el&&el.textContent)||"").replace(/\s+/g," ").trim().length;}
const bodyLen = textLen(doc.body);
const mains = [...doc.querySelectorAll("main,[role=main]")].filter(el => textLen(el) >= 200);
const root = (mains.length === 1 && textLen(mains[0])/bodyLen >= 0.35) ? mains[0] : (doc.querySelector(".mw-parser-output") || doc.body);

// Region classifier (GENERIC structural signals — used for ANALYSIS only, not the fix).
function classify(leaf) {
  const inRefs = leaf.closest("ol.references, .references, [role='doc-endnotes'], .reflist, sup.reference, .mw-references-wrap");
  if (inRefs) return "references";
  if (leaf.closest(".navbox, [role='navigation'], .vector-toc, #mw-panel-toc, nav")) return "nav/toc/navbox";
  if (leaf.closest(".catlinks, .mw-normal-catlinks")) return "categories";
  if (leaf.closest(".infobox, .infobox_v2, table.infobox")) return "infobox";
  if (leaf.closest("figure, .thumb, figcaption, .thumbcaption")) return "captions";
  if (leaf.closest("table")) return "tables";
  return "article-prose";
}
function isDateNumNoise(t) {
  // Mostly digits + the handful of fixed date/page kanji + punctuation/latin.
  const s = String(t||"").replace(/<[^>]+>/g,"");
  const letters = (s.match(/[぀-ヿ㐀-鿿가-힯A-Za-z]/g)||[]).length;
  const cjkContent = (s.match(/[㐀-鿿]/g)||[]).filter(c => !"年月日閲覧頁号巻第版発行".includes(c)).length;
  const kana = (s.match(/[぀-ヿ]/g)||[]).length;
  return letters > 0 && cjkContent + kana <= 2; // almost no real linguistic content
}

const sections = ctx.collectHtmlPageSections([root], { minChars: 600, maxChars: 20000, recurseNestedContainers: true });
const byRegion = {};
let totalTokens = 0, totalLeaves = 0;
const uniqueStrings = new Map(); // dedupe
let noiseTokens = 0, noiseLeaves = 0;
for (const s of sections) {
  for (const child of s.children) {
    for (const leaf of ctx.findLeafBlocksInElement(child)) {
      const seg = ctx.serializeTranslationLeaf(leaf);
      if (!seg || !seg.text) continue;
      const region = classify(leaf);
      const tok = estTokens(seg.text);
      byRegion[region] = byRegion[region] || { leaves: 0, tokens: 0, dedupTokens: 0 };
      byRegion[region].leaves++; byRegion[region].tokens += tok;
      totalLeaves++; totalTokens += tok;
      if (!uniqueStrings.has(seg.text)) { uniqueStrings.set(seg.text, true); byRegion[region].dedupTokens += tok; }
      if (isDateNumNoise(seg.text)) { noiseTokens += tok; noiseLeaves++; }
    }
  }
}
let dedupTotal = 0; for (const r of Object.values(byRegion)) dedupTotal += r.dedupTokens;
console.log(`TOTAL: ${totalLeaves} leaves, ${totalTokens} est input tokens (deduped: ${dedupTotal}, saves ${totalTokens-dedupTotal})`);
console.log(`Date/number/citation NOISE leaves (≤2 real linguistic chars): ${noiseLeaves} leaves, ${noiseTokens} tokens (${(noiseTokens/totalTokens*100).toFixed(0)}%)`);
console.log("\nBy region (after dedup):");
const rows = Object.entries(byRegion).sort((a,b)=>b[1].dedupTokens-a[1].dedupTokens);
for (const [r, v] of rows) {
  console.log(`  ${r.padEnd(18)} ${String(v.leaves).padStart(5)} leaves  ${String(v.dedupTokens).padStart(7)} tok  (${(v.dedupTokens/dedupTotal*100).toFixed(0)}%)`);
}
