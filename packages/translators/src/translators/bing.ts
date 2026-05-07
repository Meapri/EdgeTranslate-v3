import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { PronunciationSpeed, TranslationResult } from "../types";
import { LRUCache } from "../utils/lru";
import {
    parseExampleResult as parseBingExampleResult,
    parseLookupResult as parseBingLookupResult,
    parseTranslateResult as parseBingTranslateResult,
} from "./bingParsers";

// Use axios for browser compatibility
import axios from "../axios";
const httpClient = axios;

/**
 * Bing translator interface.
 */
class BingTranslator {
    /**
     * Basic request parameters.
     */
    IG = "";
    IID: string | null = "";
    token = "";
    key = "";

    constructor() {
        // Initialize simple cache for immediate use
        this.cache = new LRUCache<string, TranslationResult>({ max: 100, ttl: 10 * 60 * 1000 });
        
        // Try to load cached tokens first
        this.loadCachedTokens();
        
    }

    /**
     * Whether we have initiated tokens.
     */
    tokensInitiated = false;

    /**
     * Promise for token initialization to prevent multiple concurrent requests
     */
    tokenInitPromise: Promise<void> | null = null;

    /**
     * Simple LRU cache for translate results
     */
    private cache: LRUCache<string, TranslationResult>;

    /**
     * Flag to track if warming is in progress
     */
    private warmupInProgress = false;

    /**
     * TTS auth info.
     */
    TTS_AUTH = { region: "", token: "" };

    /**
     * Thresholds for deciding whether Bing dictionary/example details are useful.
     * Longer selections are usually sentence/paragraph translations, where extra
     * lookup/example requests only slow down the result without improving mainMeaning.
     */
    DETAIL_LOOKUP_MAX_WORDS = 3;
    DETAIL_LOOKUP_MAX_CHARS = 60;

    /**
     * Request count.
     */
    count = 0;

    /**
     * Last request timestamp for rate limiting
     */
    lastRequestTime = 0;

    /**
     * Minimum delay between requests (ms)
     */
    REQUEST_DELAY = 50;

    HTMLParser = new DOMParser();

    /**
     * Max retry times.
     */
    MAX_RETRY = 1;


    /**
     * Translate API host.
     */
    HOST = "https://www.bing.com/";

    /**
     * Translate API home page.
     */
    HOME_PAGE = "https://www.bing.com/translator";

    /**
     * Optimized request headers
     */
    HEADERS = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9,ko;q=0.8,zh-CN;q=0.7,zh;q=0.6",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
        "accept-encoding": "gzip, deflate, br",
        "cache-control": "no-cache",
        "origin": "https://www.bing.com",
        "referer": "https://www.bing.com/translator",
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
    };

    /**
     * Language maps.
     */
    private LANGUAGES: [string, string][] = [
        ["auto", "auto-detect"],
        ["ar", "ar"],
        ["ga", "ga"],
        ["et", "et"],
        ["or", "or"],
        ["bg", "bg"],
        ["is", "is"],
        ["pl", "pl"],
        ["bs", "bs-Latn"],
        ["fa", "fa"],
        ["prs", "prs"],
        ["da", "da"],
        ["de", "de"],
        ["ru", "ru"],
        ["fr", "fr"],
        ["zh-TW", "zh-Hant"],
        ["fil", "fil"],
        ["fj", "fj"],
        ["fi", "fi"],
        ["gu", "gu"],
        ["kk", "kk"],
        ["ht", "ht"],
        ["ko", "ko"],
        ["nl", "nl"],
        ["ca", "ca"],
        ["zh-CN", "zh-Hans"],
        ["cs", "cs"],
        ["kn", "kn"],
        ["otq", "otq"],
        ["tlh", "tlh"],
        ["hr", "hr"],
        ["lv", "lv"],
        ["lt", "lt"],
        ["ro", "ro"],
        ["mg", "mg"],
        ["mt", "mt"],
        ["mr", "mr"],
        ["ml", "ml"],
        ["ms", "ms"],
        ["mi", "mi"],
        ["bn", "bn-BD"],
        ["hmn", "mww"],
        ["af", "af"],
        ["pa", "pa"],
        ["pt", "pt"],
        ["ps", "ps"],
        ["ja", "ja"],
        ["sv", "sv"],
        ["sm", "sm"],
        ["sr-Latn", "sr-Latn"],
        ["sr-Cyrl", "sr-Cyrl"],
        ["no", "nb"],
        ["sk", "sk"],
        ["sl", "sl"],
        ["sw", "sw"],
        ["ty", "ty"],
        ["te", "te"],
        ["ta", "ta"],
        ["th", "th"],
        ["to", "to"],
        ["tr", "tr"],
        ["cy", "cy"],
        ["ur", "ur"],
        ["uk", "uk"],
        ["es", "es"],
        ["he", "iw"],
        ["el", "el"],
        ["hu", "hu"],
        ["it", "it"],
        ["hi", "hi"],
        ["id", "id"],
        ["en", "en"],
        ["yua", "yua"],
        ["yue", "yua"],
        ["vi", "vi"],
        ["ku", "ku"],
        ["kmr", "kmr"],
    ];

    /**
     * Text readers.
     */
    private READERS = {
        ar: ["ar-SA", "Male", "ar-SA-Naayf"],
        bg: ["bg-BG", "Male", "bg-BG-Ivan"],
        ca: ["ca-ES", "Female", "ca-ES-HerenaRUS"],
        cs: ["cs-CZ", "Male", "cs-CZ-Jakub"],
        da: ["da-DK", "Female", "da-DK-HelleRUS"],
        de: ["de-DE", "Female", "de-DE-Hedda"],
        el: ["el-GR", "Male", "el-GR-Stefanos"],
        en: ["en-US", "Female", "en-US-JessaRUS"],
        es: ["es-ES", "Female", "es-ES-Laura-Apollo"],
        fi: ["fi-FI", "Female", "fi-FI-HeidiRUS"],
        fr: ["fr-FR", "Female", "fr-FR-Julie-Apollo"],
        he: ["he-IL", "Male", "he-IL-Asaf"],
        hi: ["hi-IN", "Female", "hi-IN-Kalpana-Apollo"],
        hr: ["hr-HR", "Male", "hr-HR-Matej"],
        hu: ["hu-HU", "Male", "hu-HU-Szabolcs"],
        id: ["id-ID", "Male", "id-ID-Andika"],
        it: ["it-IT", "Male", "it-IT-Cosimo-Apollo"],
        ja: ["ja-JP", "Female", "ja-JP-Ayumi-Apollo"],
        ko: ["ko-KR", "Female", "ko-KR-HeamiRUS"],
        ms: ["ms-MY", "Male", "ms-MY-Rizwan"],
        nl: ["nl-NL", "Female", "nl-NL-HannaRUS"],
        nb: ["nb-NO", "Female", "nb-NO-HuldaRUS"],
        no: ["nb-NO", "Female", "nb-NO-HuldaRUS"],
        pl: ["pl-PL", "Female", "pl-PL-PaulinaRUS"],
        pt: ["pt-PT", "Female", "pt-PT-HeliaRUS"],
        ro: ["ro-RO", "Male", "ro-RO-Andrei"],
        ru: ["ru-RU", "Female", "ru-RU-Irina-Apollo"],
        sk: ["sk-SK", "Male", "sk-SK-Filip"],
        sl: ["sl-SL", "Male", "sl-SI-Lado"],
        sv: ["sv-SE", "Female", "sv-SE-HedvigRUS"],
        ta: ["ta-IN", "Female", "ta-IN-Valluvar"],
        te: ["te-IN", "Male", "te-IN-Chitra"],
        th: ["th-TH", "Male", "th-TH-Pattara"],
        tr: ["tr-TR", "Female", "tr-TR-SedaRUS"],
        vi: ["vi-VN", "Male", "vi-VN-An"],
        "zh-Hans": ["zh-CN", "Female", "zh-CN-HuihuiRUS"],
        "zh-Hant": ["zh-CN", "Female", "zh-CN-HuihuiRUS"],
        yue: ["zh-HK", "Female", "zh-HK-TracyRUS"],
    };

    /**
     * TTS language code.
     */
    private TTS_LAN_CODE = {
        ar: "ar-EG",
        ca: "ca-ES",
        da: "da-DK",
        de: "de-DE",
        en: "en-US",
        es: "es-ES",
        fi: "fi-FI",
        fr: "fr-FR",
        hi: "hi-IN",
        it: "it-IT",
        ja: "ja-JP",
        ko: "ko-KR",
        nb: "nb-NO",
        nl: "nl-NL",
        pl: "pl-PL",
        pt: "pt-PT",
        ru: "ru-RU",
        sv: "sv-SE",
        th: "th-TH",
        "zh-Hans": "zh-CN",
        "zh-Hant": "zh-HK",
        yue: "zh-HK",
        gu: "gu-IN",
        mr: "mr-IN",
        ta: "ta-IN",
        te: "te-IN",
        tr: "tr-TR",
    };

    /**
     * Language to translator language code.
     */
    LAN_TO_CODE = new Map(this.LANGUAGES);

    /**
     * Translator language code to language.
     */
    CODE_TO_LAN = new Map(this.LANGUAGES.map(([lan, code]) => [code, lan]));

    /**
     * Audio instance.
     */
    AUDIO = new Audio();

    /**
     * Get IG and IID for urls.
     *
     * @returns IG and IID Promise
     */
    async updateTokens() {
        // Prevent multiple concurrent token requests
        if (this.tokenInitPromise) {
            await this.tokenInitPromise;
            return;
        }

        this.tokenInitPromise = this._doUpdateTokens();
        try {
            await this.tokenInitPromise;
        } finally {
            this.tokenInitPromise = null;
        }
    }

    /**
     * Load cached tokens from localStorage if available
     */
    private loadCachedTokens(): boolean {
        try {
            if (typeof localStorage === 'undefined') return false;
            
            const cached = localStorage.getItem('bing_translator_tokens');
            if (!cached) return false;
            
            const { IG, token, key, IID, HOST, timestamp } = JSON.parse(cached);
            
            // Check if tokens are still valid (30 minutes TTL)
            if (Date.now() - timestamp < 30 * 60 * 1000) {
                this.IG = IG;
                this.token = token;
                this.key = key;
                this.IID = IID || "";
                this.HOST = HOST || "https://www.bing.com/";
                this.HOME_PAGE = `${this.HOST}translator`;
                this.tokensInitiated = true;
                return true;
            } else {
                // Remove expired cache
                localStorage.removeItem('bing_translator_tokens');
            }
        } catch (error) {
            // Ignore cache errors
        }
        return false;
    }

    /**
     * Cache tokens to localStorage for faster subsequent loads
     */
    private cacheTokens(): void {
        try {
            if (typeof localStorage === 'undefined') return;
            
            const tokenData = {
                IG: this.IG,
                token: this.token,
                key: this.key,
                IID: this.IID,
                HOST: this.HOST,
                timestamp: Date.now()
            };
            
            localStorage.setItem('bing_translator_tokens', JSON.stringify(tokenData));
        } catch (error) {
            // Ignore cache errors
        }
    }

    /**
     * Warm up the translator by pre-fetching tokens in the background.
     * This reduces the latency of the first translation request.
     */
    async warmUp() {
        if (this.tokensInitiated || this.warmupInProgress) {
            return;
        }
        
        this.warmupInProgress = true;
        try {
            await this.updateTokens();
        } catch (error) {
            // Ignore warmup failures - we'll try again on actual request
            console.debug('Bing translator warmup failed:', error);
        } finally {
            this.warmupInProgress = false;
        }
    }

    private async _doUpdateTokens() {
        const response = (await httpClient.get(this.HOME_PAGE, {
            timeout: 5000,
        })) as AxiosResponse<any>;

        /**
         * Bing redirects user requests based on user region. For example, if we are in China and request
         * www.bing.com, we will be redirected to cn.bing.com. This causes translating error because IG and IID
         * for one region are not usable for another. Therefore, we need to update HOST, HOME_PAGE, IG and IID
         * whenever a redirection happened.
         *
         * If the requested host is different from the original host, which means there was a redirection,
         * update HOST and HOME_PAGE with the redirecting host.
         */
        const responseHost = /(https:\/\/.*\.bing\.com\/).*/g.exec(response.request.responseURL);
        if (responseHost && responseHost[1] != this.HOST) {
            this.HOST = responseHost[1];
            this.HOME_PAGE = `${this.HOST}translator`;
        }

        const igMatch = response.data.match(/IG:"([A-Za-z0-9]+)"/);
        if (!igMatch) throw new Error("Failed to extract IG token");
        this.IG = igMatch[1];

        const paramsMatch = response.data.match(
            /var params_AbusePreventionHelper\s*=\s*\[([0-9]+),\s*"([^"]+)",[^\]]*\];/
        );
        if (!paramsMatch) throw new Error("Failed to extract abuse prevention params");
        [, this.key, this.token] = paramsMatch;

        const iidMatch = response.data.match(/data-iid="([^"]+)"/);
        this.IID = iidMatch ? iidMatch[1] : "";

        // Reset request count.
        this.count = 0;
        
        // Cache tokens for future use
        this.cacheTokens();
    }

    /**
     * Extract translated text from ttranslatev3 response safely.
     */
    private extractTextFromTranslateResponse(res: any): string {
        try {
            if (Array.isArray(res)) {
                // Typical shape: [{ translations: [{ text: "..." }] }]
                const parts = res
                    .map((item: any) => item?.translations?.[0]?.text || "")
                    .filter(Boolean);
                return parts.join("");
            }
            if (res && res[0]) {
                return res[0]?.translations?.[0]?.text || "";
            }
        } catch (_) {
            // ignore
        }
        return "";
    }

    // Removed legacy fixed-length chunk splitter; using adaptive segmentation instead.

    /**
     * Adaptively segment and translate without fixed length limits.
     * If a segment fails (network/API/HTML), try finer-grained splits.
     */
    private async segmentAndTranslate(text: string, from: string, to: string): Promise<string> {
        const tryOnce = async (t: string): Promise<string> => {
            const resp = await this.request(this.constructTranslateParams, [t, from, to]);
            const txt = this.extractTextFromTranslateResponse(resp);
            if (txt) return txt;
            // If nothing parsed, force a token refresh and retry once; if still empty, fall back to deeper split
            await this.updateTokens();
            const resp2 = await this.request(this.constructTranslateParams, [t, from, to]);
            return this.extractTextFromTranslateResponse(resp2);
        };

        // First attempt: as-is
        try {
            const r = await tryOnce(text);
            if (r) return r;
        } catch (_) { /* proceed to split */ }

        // Split to paragraphs
        const paragraphs = text.split(/\n{2,}/).filter((p) => p.length > 0);
        if (paragraphs.length > 1) {
            const parts: string[] = [];
            for (const p of paragraphs) {
                const translated = await this.segmentAndTranslate(p, from, to);
                parts.push(translated);
            }
            return parts.join("\n\n");
        }

        // Split to sentences
        const sentences = text.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
        if (sentences.length > 1) {
            const parts: string[] = [];
            for (const s of sentences) {
                const translated = await this.segmentAndTranslate(s, from, to);
                parts.push(translated);
            }
            return parts.join(" ");
        }

        // Split by clauses (commas/semicolons)
        const clauses = text.split(/[,;:、，；：]\s*/).filter(Boolean);
        if (clauses.length > 1) {
            const parts: string[] = [];
            for (const c of clauses) {
                const translated = await this.segmentAndTranslate(c, from, to);
                parts.push(translated);
            }
            return parts.join(" ");
        }

        // Split by whitespace tokens as the last resort
        const tokens = text.split(/\s+/).filter(Boolean);
        if (tokens.length > 1) {
            const parts: string[] = [];
            for (const k of tokens) {
                const translated = await this.segmentAndTranslate(k, from, to);
                parts.push(translated);
            }
            return parts.join(" ");
        }

        // Single token failed; return empty string to let caller fallback to base parse
        try {
            return await tryOnce(text);
        } catch (_) {
            return "";
        }
    }

    /**
     * Parse translate interface result.
     *
     * @param result translate result
     * @param extras extra data
     *
     * @returns Parsed result
     */
    parseTranslateResult(result: any, extras: TranslationResult): TranslationResult {
        return parseBingTranslateResult(result, extras);
    }

    /**
     * Parse the lookup interface result.
     *
     * @param result lookup result
     * @param extras extra data
     *
     * @returns Parsed result
     */
    parseLookupResult(result: any, extras: TranslationResult): TranslationResult {
        return parseBingLookupResult(result, extras);
    }

    /**
     * Parse example response.
     *
     * @param result example response
     * @param extras extra data
     *
     * @returns parse result
     */
    parseExampleResult(result: any, extras: TranslationResult): TranslationResult {
        return parseBingExampleResult(result, extras);
    }

    /**
     * Get TTS auth token.
     *
     * @returns request finished Promise
     */
    async updateTTSAuth() {
        const constructParams = () => {
            return {
                method: "POST",
                baseURL: this.HOST,
                url: `tfetspktok?isVertical=1&&IG=${this.IG}&IID=${
                    this.IID
                }.${this.count.toString()}`,
                headers: this.HEADERS,
                data: `&token=${encodeURIComponent(this.token)}&key=${encodeURIComponent(
                    this.key
                )}`,
            } as AxiosRequestConfig;
        };

        const response = await this.request(constructParams, []);
        this.TTS_AUTH.region = response.region;
        this.TTS_AUTH.token = response.token;
    }

    /**
     * Generate TTS request data.
     *
     * @param text text to pronounce
     * @param language language of text
     * @param speed pronouncing speed, "fast" or "slow"
     *
     * @returns TTS request data
     */
    generateTTSData(text: string, language: string, speed: PronunciationSpeed) {
        const lanCode = this.LAN_TO_CODE.get(language)! as keyof typeof this.READERS &
            keyof typeof this.TTS_LAN_CODE;
        const reader = this.READERS[lanCode];
        const ttsLanCode = this.TTS_LAN_CODE[lanCode];
        const speedValue = speed === "fast" ? "-10.00%" : "-30.00%";
        return `<speak version='1.0' xml:lang='${ttsLanCode}'><voice xml:lang='${ttsLanCode}' xml:gender='${reader[1]}' name='${reader[2]}'><prosody rate='${speedValue}'>${text}</prosody></voice></speak>`;
    }

    /**
     * Transform binary data into Base64 encoding.
     *
     * @param buffer array buffer with audio data
     *
     * @returns Base64 form of binary data in buffer
     */
    arrayBufferToBase64(buffer: Iterable<number>) {
        let str = "",
            array = new Uint8Array(buffer);

        for (let i = 0; i < array.byteLength; i++) {
            str += String.fromCharCode(array[i]);
        }

        return btoa(str);
    }

    /**
     * Construct detect request parameters dynamically.
     *
     * @param text text to detect
     *
     * @returns constructed parameters
     */
    constructDetectParams(text: string): AxiosRequestConfig {
        const url = `ttranslatev3?isVertical=1&IG=${this.IG}&IID=${
                this.IID
            }.${this.count.toString()}`,
            data = `&fromLang=auto-detect&to=zh-Hans&text=${encodeURIComponent(
                text
            )}&token=${encodeURIComponent(this.token)}&key=${encodeURIComponent(this.key)}`;

        return {
            method: "POST",
            baseURL: this.HOST,
            url,
            headers: this.HEADERS,
            data,
        };
    }

    /**
     * Construct translate request parameters dynamically.
     *
     * @param text text to translate
     * @param from source language
     * @param to target language
     *
     * @returns constructed parameters
     */
    constructTranslateParams(text: string, from: string, to: string): AxiosRequestConfig {
        const translateURL = `ttranslatev3?isVertical=1&IG=${this.IG}&IID=${
                this.IID
            }.${this.count.toString()}`,
            translateData = `&fromLang=${this.LAN_TO_CODE.get(from)}&to=${this.LAN_TO_CODE.get(
                to
            )}&text=${encodeURIComponent(text)}&token=${encodeURIComponent(
                this.token
            )}&key=${encodeURIComponent(this.key)}`;

        return {
            method: "POST",
            baseURL: this.HOST,
            url: translateURL,
            headers: this.HEADERS,
            data: translateData,
        };
    }

    /**
     * Construct lookup request parameters dynamically.
     *
     * @param text text to lookup
     * @param from source language
     * @param to target language
     *
     * @returns constructed parameters
     */
    constructLookupParams(text: string, from: string, to: string): AxiosRequestConfig {
        const lookupURL = `tlookupv3?isVertical=1&IG=${this.IG}&IID=${
                this.IID
            }.${this.count.toString()}`,
            lookupData = `&from=${
                // Use detected language.
                from
            }&to=${this.LAN_TO_CODE.get(to)}&text=${encodeURIComponent(
                text
            )}&token=${encodeURIComponent(this.token)}&key=${encodeURIComponent(this.key)}`;

        return {
            method: "POST",
            baseURL: this.HOST,
            url: lookupURL,
            headers: this.HEADERS,
            data: lookupData,
        };
    }

    /**
     * Construct example request parameters dynamically.
     *
     * @param from source language
     * @param to target language
     * @param text original text
     * @param translation text translation
     *
     * @returns constructed parameters
     */
    constructExampleParams(
        from: string,
        to: string,
        text: string,
        translation: string
    ): AxiosRequestConfig {
        const exampleURL = `texamplev3?isVertical=1&IG=${this.IG}&IID=${
                this.IID
            }.${this.count.toString()}`,
            exampleData = `&from=${
                // Use detected language.
                from
            }&to=${this.LAN_TO_CODE.get(to)}&text=${encodeURIComponent(
                text
            )}&translation=${encodeURIComponent(translation)}&token=${encodeURIComponent(
                this.token
            )}&key=${encodeURIComponent(this.key)}`;

        return {
            method: "POST",
            baseURL: this.HOST,
            url: exampleURL,
            headers: this.HEADERS,
            data: exampleData,
        };
    }

    /**
     * Construct TTS request parameters dynamically.
     *
     * @param text text to pronounce
     * @param lang language of text
     * @param speed pronounce speed
     *
     * @returns constructed parameters
     */
    constructTTSParams(text: string, lang: string, speed: PronunciationSpeed) {
        const url = `https://${this.TTS_AUTH.region}.tts.speech.microsoft.com/cognitiveservices/v1?`;

        const headers = {
            "Content-Type": "application/ssml+xml",
            Authorization: `Bearer ${this.TTS_AUTH.token}`,
            "X-MICROSOFT-OutputFormat": "audio-16khz-32kbitrate-mono-mp3",
            "cache-control": "no-cache",
        };

        return {
            method: "POST",
            baseURL: url,
            headers,
            data: this.generateTTSData(text, lang, speed),
            responseType: "arraybuffer",
        } as AxiosRequestConfig;
    }

    /**
     * Request APIs.
     *
     * This is a wrapper of axios with retrying and error handling supported.
     *
     * @param constructParams request parameters constructor
     * @param constructParamsArgs request parameters constructor arguments
     * @param retry whether retry is needed
     *
     * @returns Promise of response data
     */
    async request(
        constructParams: (...args: any[]) => AxiosRequestConfig,
        constructParamsArgs: string[],
        retry = true
    ) {
        // Rate limiting: wait if needed
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.REQUEST_DELAY && this.count > 5) {
            const waitTime = this.REQUEST_DELAY - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastRequestTime = Date.now();

        let retryCount = 0;
        const requestOnce = async (): Promise<any> => {
            this.count++;
            
            try {
                const response = (await httpClient({
                    timeout: 8000,
                    ...constructParams.call(this, ...constructParamsArgs),
                })) as AxiosResponse<any>;
                
                return response;
            } catch (error: any) {
                throw error;
            }
        };

    const processResponse = async (response: AxiosResponse<any>): Promise<any> => {
            /**
             * Status codes 401 and 429 mean that Bing thinks we are robots. We have to wait for it to calm down.
             */
            if (response.status === 401 || response.status === 429) {
                // Throw error.
                throw {
                    errorType: "API_ERR",
                    errorCode: response.status,
                    errorMsg: "Request too frequently!",
                };
            }

            /**
             * Bing redirects user requests based on user region. For example, if we are in China and request
             * www.bing.com, we will be redirected to cn.bing.com. This causes translating error because IG and IID
             * for one region are not usable for another. Therefore, we need to update HOST, HOME_PAGE, IG and IID
             * whenever a redirection happened.
             *
             * If the requested host is different from the original host, which means there was a redirection,
             * update HOST and HOME_PAGE with the redirecting host and retry.
             */
            const responseHost = /(https:\/\/.*\.bing\.com\/).*/g.exec(
                response.request.responseURL
            );
            if (responseHost && responseHost[1] !== this.HOST) {
                this.HOST = responseHost[1];
                this.HOME_PAGE = `${this.HOST}translator`;
                return await this.updateTokens().then(requestOnce);
            }

            /**
             * statusCode will indicate the status of translating.
             *
             * no statusCode or 200: translated successfully
             * 205: tokens need to be updated
             */
            // Guard: Sometimes Bing returns HTML (anti-bot) with 200 OK. Detect non-JSON and retry after token refresh.
            const contentType = (response.headers && (response.headers["content-type"] || response.headers["Content-Type"])) || "";
            if (typeof response.data === "string") {
                const body = response.data as string;
                if (/text\/html/i.test(contentType) || /<html|<!DOCTYPE/i.test(body)) {
                    if (retry && retryCount < this.MAX_RETRY + 1) {
                        retryCount++;
                        await this.updateTokens();
                        return await requestOnce().then(processResponse);
                    }
                    throw {
                        errorType: "API_ERR",
                        errorCode: 200,
                        errorMsg: "Unexpected HTML response from Bing",
                    };
                }
            }

            const statusCode = response.data.StatusCode || response.data.statusCode || 200;
            switch (statusCode) {
                case 200:
                    return response.data;
                case 205:
                    return await this.updateTokens().then(requestOnce);
                default:
                    break;
            }

            // Retry after unknown failure.
            if (retry && retryCount < this.MAX_RETRY) {
                retryCount++;
                return await this.updateTokens().then(requestOnce);
            }

            // Throw error.
            throw {
                errorType: "API_ERR",
                errorCode: statusCode,
                errorMsg: "Request failed.",
            };
        };

        const executeRequest = async (): Promise<any> => {
            const response = await requestOnce();
            return await processResponse(response);
        };

        // Initialize tokens lazily and concurrently
        const ensureTokens = async () => {
            if (!this.tokensInitiated) {
                await this.updateTokens();
                this.tokensInitiated = true;
            }
        };

        await ensureTokens();
        return executeRequest();
    }

    /**
     * Get supported languages of this API.
     *
     * @returns {Set<String>} supported languages
     */
    supportedLanguages() {
        return new Set(this.LAN_TO_CODE.keys());
    }

    shouldFetchDetailedTranslation(text: string) {
        const normalized = String(text || "").replace(/\s+/g, " ").trim();
        if (!normalized) return false;
        if (normalized.length > this.DETAIL_LOOKUP_MAX_CHARS) return false;
        const wordCount = normalized.split(/\s+/).filter(Boolean).length;
        if (wordCount > this.DETAIL_LOOKUP_MAX_WORDS) return false;
        return true;
    }

    /**
     * Detect language of given text.
     *
     * @param text text to detect
     *
     * @returns detected language Promise
     */
    async detect(text: string) {
        try {
            const response = await this.request(this.constructDetectParams, [text]);
            const result = response[0].detectedLanguage.language;
            return this.CODE_TO_LAN.get(result);
        } catch (error: any) {
            error.errorMsg = error.errorMsg || error.message;
            error.errorAct = {
                api: "bing",
                action: "detect",
                text,
                from: null,
                to: null,
            };
            throw error;
        }
    }

    /**
     * Translate given text.
     *
     * @param text text to translate
     * @param from source language
     * @param to target language
     *
     * @returns {Promise<Object>} translation Promise
     */
    async translate(text: string, from: string, to: string, _internalNoChunkFallback = false): Promise<TranslationResult> {
        // Quick validation
        if (!text || !text.trim()) {
            return { originalText: text || "", mainMeaning: "" };
        }
        
        // Check cache first
        const cacheKey = `${from}|${to}|${text.toLowerCase().trim()}`;
        const cached = this.cache.get(cacheKey);
        
        if (cached) {
            return cached;
        }

        // Store original text info for TTS consistency
        const originalTextInfo = { text, from, to };

    // No length-based trigger; try direct call first and only then fallback to adaptive segmentation

        let transResponse;
        try {
            transResponse = await this.request(this.constructTranslateParams, [text, from, to]);
        } catch (error: any) {
            error.errorAct = {
                api: "bing",
                action: "translate",
                text,
                from,
                to,
            };
            throw error;
        }

        // Set up originalText in case that lookup failed.
        const transResult = this.parseTranslateResult(transResponse, {
            originalText: text,
            mainMeaning: "",
        });

        // If we failed to parse any translated text, fallback to adaptive segmentation once
        if (!transResult.mainMeaning && !_internalNoChunkFallback) {
            try {
                const joined = await this.segmentAndTranslate(text, from, to);
                if (joined) {
                    // Determine actual source language for TTS
                    let actualSourceLang = originalTextInfo.from;
                    if (originalTextInfo.from === "auto") {
                        try {
                            const detected = await this.detect(text);
                            if (detected && detected !== "auto") {
                                actualSourceLang = detected;
                            } else {
                                actualSourceLang = "en"; // fallback
                            }
                        } catch (e) {
                            actualSourceLang = "en"; // fallback
                        }
                    }
                    
                    const segResult = { 
                        originalText: originalTextInfo.text,
                        mainMeaning: joined,
                        sourceLanguage: actualSourceLang,
                        targetLanguage: originalTextInfo.to
                    } as TranslationResult;
                    this.cache.set(cacheKey, segResult);
                    return segResult;
                }
            } catch (_) {
                // fall through
            }
        }

        try {
            const detectedLanguage = transResponse[0]?.detectedLanguage?.language;
            if (!detectedLanguage) throw new Error("Failed to detect language from response");
            
            // Add language information to translation result
            transResult.sourceLanguage = from;
            transResult.targetLanguage = to;

            if (!this.shouldFetchDetailedTranslation(text)) {
                this.cache.set(cacheKey, transResult);
                return transResult;
            }
            
            // Run lookup and examples in parallel for better performance
            const [lookupResponse, exampleResponse] = await Promise.allSettled([
                this.request(
                    this.constructLookupParams,
                    [text, detectedLanguage, to],
                    false
                ).then(response => ({ type: 'lookup', response })),
                // Only request examples if we have a main meaning to work with
                transResult.mainMeaning ? this.request(
                    this.constructExampleParams,
                    [detectedLanguage, to, text, transResult.mainMeaning],
                    false
                ).then(response => ({ type: 'example', response })) : Promise.reject('No main meaning')
            ]);

            let result = transResult;
            
            // Apply lookup result if successful
            if (lookupResponse.status === 'fulfilled') {
                result = this.parseLookupResult(lookupResponse.value.response, result);
            }
            
            // Apply example result if successful
            if (exampleResponse.status === 'fulfilled') {
                result = this.parseExampleResult(exampleResponse.value.response, result);
            }
            
            // Cache the final result
            this.cache.set(cacheKey, result);
            return result;
        } catch (e) {
            // Fall back to basic translation and cache it with language info
            transResult.sourceLanguage = from;
            transResult.targetLanguage = to;
            this.cache.set(cacheKey, transResult);
            return transResult;
        }
    }

    /**
     * Pronounce given text.
     *
     * @param text text to pronounce
     * @param language language of text
     * @param speed "fast" or "slow"
     *
     * @returns pronounce finished
     */
    async pronounce(text: string, language: string, speed: PronunciationSpeed) {
        // Pause audio in case that it's playing.
        this.stopPronounce();

        // Handle "auto" language by attempting detection
        let actualLanguage = language;
        if (language === "auto") {
            try {
                const detected = await this.detect(text);
                if (detected && detected !== "auto") {
                    actualLanguage = detected;
                } else {
                    // Fallback to English if detection fails
                    actualLanguage = "en";
                }
            } catch (e) {
                // Fallback to English if detection fails
                actualLanguage = "en";
            }
        }

        // Validate that we have a supported language for TTS
        const lanCode = this.LAN_TO_CODE.get(actualLanguage);
        const readers = this.READERS as { [key: string]: any };
        if (!lanCode || !readers[lanCode]) {
            throw {
                errorType: "LANG_ERR",
                errorCode: 0,
                errorMsg: `Language '${actualLanguage}' is not supported for TTS`,
                errorAct: {
                    api: "bing",
                    action: "pronounce",
                    text,
                    from: actualLanguage,
                    to: null,
                },
            };
        }

        let retryCount = 0;
        const pronounceOnce = async (): Promise<void> => {
            try {
                const TTSResponse = await this.request(
                    this.constructTTSParams,
                    [text, actualLanguage, speed],
                    false
                );
                this.AUDIO.src = `data:audio/mp3;base64,${this.arrayBufferToBase64(TTSResponse)}`;
                await this.AUDIO.play();
            } catch (error: any) {
                if (retryCount < this.MAX_RETRY) {
                    retryCount++;
                    return this.updateTTSAuth().then(pronounceOnce);
                }
                const errorAct = {
                    api: "bing",
                    action: "pronounce",
                    text,
                    from: actualLanguage,
                    to: null,
                };

                if (error.errorType) {
                    error.errorAct = errorAct;
                    throw error;
                }

                throw {
                    errorType: "NET_ERR",
                    errorCode: 0,
                    errorMsg: error.message,
                    errorAct,
                };
            }
        };

        if (!(this.TTS_AUTH.region.length > 0 && this.TTS_AUTH.token.length > 0)) {
            await this.updateTTSAuth();
        }

        return pronounceOnce();
    }

    /**
     * Pause pronounce.
     */
    stopPronounce() {
        if (!this.AUDIO.paused) {
            this.AUDIO.pause();
        }
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            size: this.cache.size(),
            maxSize: 100,
            ttl: 10 * 60 * 1000,
        };
    }

    /**
     * Cleanup connections and resources
     */
    async cleanup() {
        // Clear LRU cache
        this.cache.clear();
    }
}

export default BingTranslator;