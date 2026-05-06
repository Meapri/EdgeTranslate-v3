// Cache voices and selection to avoid re-computation
let cachedVoices = null;
let voicesLoaded = false;
let lastVoiceByLang = new Map();
let scoreCache = new Map(); // key: `${normalized}|${voice.name}|${voice.lang}|${voice.voiceURI}` -> score

async function loadVoices() {
    if (typeof speechSynthesis === "undefined") return [];
    const existing = speechSynthesis.getVoices();
    if (existing && existing.length) {
        voicesLoaded = true;
        cachedVoices = existing;
        return existing;
    }
    return new Promise((resolve) => {
        const onVoices = () => {
            const list = speechSynthesis.getVoices() || [];
            cachedVoices = list;
            voicesLoaded = true;
            speechSynthesis.removeEventListener?.("voiceschanged", onVoices);
            resolve(list);
        };
        speechSynthesis.addEventListener?.("voiceschanged", onVoices);
        // Fallback timeout in case event never fires
        setTimeout(() => {
            const list = speechSynthesis.getVoices() || [];
            if (!voicesLoaded && list.length) {
                cachedVoices = list;
                voicesLoaded = true;
                speechSynthesis.removeEventListener?.("voiceschanged", onVoices);
                resolve(list);
            } else if (!voicesLoaded) {
                resolve(list);
            }
        }, 1000);
    });
}

function normalizeBCP47(lang) {
    if (!lang) return "";
    const lower = String(lang).toLowerCase();
    if (lower === "ko" || lower.startsWith("ko-")) return "ko-KR";
    if (lower === "en" || lower.startsWith("en-")) return "en-US";
    if (lower === "ja" || lower.startsWith("ja-")) return "ja-JP";
    if (lower === "zh" || lower.startsWith("zh-cn")) return "zh-CN";
    if (lower.startsWith("zh-tw")) return "zh-TW";
    return lang;
}

function scoreVoiceFor(langBCP47, voice) {
    let score = 0;
    if (!voice) return -1;

    const vlang = (voice.lang || "").toLowerCase();
    const base = langBCP47.toLowerCase();
    const name = (voice.name || "").toLowerCase();
    const uri = (voice.voiceURI || "").toLowerCase();
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    const isWindows = /windows/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/chrome|chromium|edg\//i.test(ua);

    // Language matching
    const requestedBase = base.split("-")[0];
    if (vlang.startsWith(requestedBase)) score += 5;
    if (vlang === base) score += 10;

    // Engine/provider preferences
    if (name.includes("google")) score += 8;
    if (name.includes("microsoft")) score += isWindows ? 10 : 8;

    // Apple voices usually don't include vendor in name; detect via URI
    if (uri.includes("com.apple.")) score += 6;

    // Quality tier hints (Safari/macOS): prefer enhanced/premium, avoid compact
    const looksEnhanced =
        name.includes("enhanced") ||
        name.includes("premium") ||
        name.includes("pro") ||
        name.includes("siri") ||
        uri.includes("-premium") ||
        uri.includes("-enhanced");
    const looksCompact = uri.includes("-compact") || name.includes("compact");
    if (looksEnhanced) score += isSafari ? 10 : 6;
    if (looksCompact) score -= isSafari ? 8 : 4;

    // Neural/Natural markers
    if (name.includes("neural") || name.includes("natural")) score += 3;

    // Local availability
    if (voice.localService) score += 2;

    // Default flag as a mild tie-breaker
    if (voice.default) score += 2;

    // Korean-specific preferred voice names
    if (base.startsWith("ko")) {
        if (name.includes("korean")) score += 4;
        if (name.includes("yuna") || name.includes("yuri") || name.includes("nara")) score += 3;
        if (name.includes("한국")) score += 4;
    }

    return score;
}

async function pickBestVoice(lang) {
    const normalized = normalizeBCP47(lang || "");
    const cacheKey = normalized || "default";

    if (lastVoiceByLang.has(cacheKey)) {
        return { lang: normalized, voice: lastVoiceByLang.get(cacheKey) };
    }

    const list = cachedVoices || (await loadVoices());
    if (!list || !list.length) return { lang: normalized, voice: null };

    // 1) 1차 필터: 언어 코드 베이스가 일치하는 보이스 우선 (예: ko-*, en-*)
    const base = (normalized || "").split("-")[0].toLowerCase();
    // Pre-filter once for language base; this reduces scoring work
    const primary = list.filter((v) =>
        String(v.lang || "")
            .toLowerCase()
            .startsWith(base)
    );
    const candidates = primary.length ? primary : list;

    // 2) 스코어 기반 정렬 (사파리에서는 enhanced/premium 우선)
    const scored = candidates
        .map((v) => {
            const k = `${normalized}|${v.name || ""}|${v.lang || ""}|${v.voiceURI || ""}`;
            let s = scoreCache.get(k);
            if (s == null) {
                s = scoreVoiceFor(normalized || v.lang || "", v);
                scoreCache.set(k, s);
            }
            return { v, s };
        })
        .sort((a, b) => b.s - a.s);

    const best = scored.length ? scored[0].v : null;
    lastVoiceByLang.set(cacheKey, best);
    return { lang: normalized, voice: best };
}

export { loadVoices, normalizeBCP47, scoreVoiceFor, pickBestVoice };
