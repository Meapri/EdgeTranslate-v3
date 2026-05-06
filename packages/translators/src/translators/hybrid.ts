import {
    Definition,
    DetailedMeaning,
    Example,
    PronunciationSpeed,
    TranslationResult,
} from "../types";
import BingTranslator from "./bing";
import DeepLTranslator from "./deepl";
import GoogleTranslator from "./google";
import LocalTranslator, { LocalTranslatorConfig } from "./local";
import { LRUCache } from "../utils/lru";
import { fnv1a32 } from "../utils/hash";

export type HybridSupportedTranslators =
    | "BingTranslate"
    | "DeepLTranslate"
    | "GoogleTranslate"
    | "LocalTranslate";

export type HybridConfig = {
    selections: Selections;
    translators: HybridSupportedTranslators[]; // a collection of used translators which is generated based on selections. The generating process is in options.js.
};
export type Selections = Record<keyof TranslationResult, HybridSupportedTranslators>;

class HybridTranslator {
    channel: any; // communication channel.
    /**
     * Hybrid translator config.
     */
    CONFIG: HybridConfig = {
        selections: {} as Selections,
        translators: [],
    };
    REAL_TRANSLATORS: {
        BingTranslate: BingTranslator;
        GoogleTranslate: GoogleTranslator;
        DeepLTranslate: DeepLTranslator;
        LocalTranslate: LocalTranslator;
    };
    MAIN_TRANSLATOR: HybridSupportedTranslators = "GoogleTranslate";

    // Cache: translation results by (text,from,to) hash
    private cache = new LRUCache<string, TranslationResult>({ max: 250, ttl: 15 * 60 * 1000 });
    // In-flight requests to dedupe concurrent calls
    private inflight = new Map<string, Promise<TranslationResult>>();

    // Statistics
    private stats = {
        requests: 0,
        cacheHits: 0,
        errors: 0
    };

    constructor(config: HybridConfig, channel: any, localConfig: LocalTranslatorConfig = {}) {
        this.channel = channel;

        /**
         * Real supported translators.
         */
        this.REAL_TRANSLATORS = {
            BingTranslate: new BingTranslator(),
            GoogleTranslate: new GoogleTranslator(),
            DeepLTranslate: null as unknown as DeepLTranslator,
            LocalTranslate: new LocalTranslator(localConfig),
        };

        /**
         * DeepL translator needs help from other translators and we choose Google for now.
         */
        this.REAL_TRANSLATORS.DeepLTranslate = new DeepLTranslator(
            this.REAL_TRANSLATORS.BingTranslate,
            this.REAL_TRANSLATORS.BingTranslate
        );

        this.useConfig(config);
    }

    useLocalConfig(config: LocalTranslatorConfig = {}) {
        this.REAL_TRANSLATORS.LocalTranslate.useConfig(config);
    }

    /**
     * Update config.
     *
     * @param {Object} config to use.
     */
    useConfig(config: HybridConfig) {
        /**
         * Validate config.
         */
        if (!config || !config.translators || !config.selections) {
            console.error("Invalid config for HybridTranslator!");
            return;
        }

        this.CONFIG = config;
        this.MAIN_TRANSLATOR = config.selections.mainMeaning;
    }

    /**
     * Get translators that support given source language and target language.
     *
     * @param from source language
     * @param to target language
     *
     * @returns available translators
     */
    getAvailableTranslatorsFor(from: string, to: string) {
        const translators: HybridSupportedTranslators[] = [];
        for (const translator of Object.keys(this.REAL_TRANSLATORS) as HybridSupportedTranslators[]) {
            const languages = this.REAL_TRANSLATORS[translator].supportedLanguages();
            if (languages.has(from) && languages.has(to)) {
                translators.push(translator);
            }
        }
        // Sort with Google Translate as the first preference
        return translators.sort((a, b) => {
            if (a === "GoogleTranslate") return -1;
            if (b === "GoogleTranslate") return 1;
            return a.localeCompare(b);
        });
    }

    /**
     * Update hybrid translator config when language setting changed.
     *
     * @param from source language
     * @param to target language
     *
     * @returns new config
     */
    updateConfigFor(from: string, to: string) {
        const newConfig: HybridConfig = { translators: [], selections: {} as Selections };
        const translatorsSet = new Set<HybridSupportedTranslators>();

        // Get translators that support new language setting.
        const availableTranslators = this.getAvailableTranslatorsFor(from, to);

        // Replace translators that don't support new language setting with a default translator.
        const defaultTranslator = availableTranslators[0];

        // Use this set to check if a translator in the old config should be replaced.
        const availableTranslatorSet = new Set(availableTranslators);

        let item: keyof Selections;
        for (item in this.CONFIG.selections) {
            let newTranslator,
                oldTranslator = this.CONFIG.selections[item];

            if (availableTranslatorSet.has(oldTranslator)) {
                newConfig.selections[item] = oldTranslator;
                newTranslator = oldTranslator;
            } else {
                newConfig.selections[item] = defaultTranslator;
                newTranslator = defaultTranslator;
            }

            translatorsSet.add(newTranslator);
        }

        // Update used translator set.
        newConfig.translators = Array.from(translatorsSet);

        // Provide new config.
        return newConfig;
    }

    /**
     * Detect language of given text.
     *
     * @param text text
     *
     * @returns Promise of language of given text
     */
    async detect(text: string) {
        return this.REAL_TRANSLATORS[this.MAIN_TRANSLATOR].detect(text);
    }

    /**
     * Check if key exists in cache
     */
    hasInCache(key: string): boolean {
        return this.cache.has(key);
    }

    /**
     * Execute one uncached hybrid translation and combine component results.
     *
     * @param text text to translate
     * @param from source language
     * @param to target language
     *
     * @returns {Promise<Object>} translation Promise
     */
    async translateSingle(text: string, from: string, to: string) {
        // Initiate translation requests.
        let requests: Promise<[HybridSupportedTranslators, TranslationResult]>[] = [];
        for (let translator of this.CONFIG.translators) {
            // Translate with a translator.
            requests.push(
                this.REAL_TRANSLATORS[translator]
                    .translate(text, from, to)
                    .then((result) => [translator, result] as [HybridSupportedTranslators, TranslationResult])
            );
        }

        // Combine all results.
        const translation: TranslationResult = {
            originalText: "",
            mainMeaning: "",
        };
        const results = new Map(await Promise.all(requests));
        
        // Process each component with fallback support
        let item: keyof Selections;
        for (item in this.CONFIG.selections) {
            try {
                const selectedTranslator = this.CONFIG.selections[item];
                const selectedResult = results.get(selectedTranslator)!;
                
                // Check if the selected translator provided the component
                if (selectedResult[item] && this.hasValue(selectedResult[item])) {
                    // Use the value from the selected translator
                    translation[item] = selectedResult[item] as string &
                        DetailedMeaning[] &
                        Definition[] &
                        Example[];
                } else {
                    // Fallback: Try to get the component from Google Translate if available
                    const googleResult = results.get("GoogleTranslate");
                    if (googleResult && googleResult[item] && this.hasValue(googleResult[item])) {
                        translation[item] = googleResult[item] as string &
                            DetailedMeaning[] &
                            Definition[] &
                            Example[];
                    } else if (selectedResult[item]) {
                        // Fallback to selected translator's value even if it's empty/undefined
                        // to avoid missing components
                        translation[item] = selectedResult[item] as string &
                            DetailedMeaning[] &
                            Definition[] &
                            Example[];
                    }
                }
            } catch (error) {
                console.log(`${item} ${this.CONFIG.selections[item]}`);
                console.log(error);
            }
        }
        
        // Fill passthrough originalText if empty
        if (!translation.originalText) translation.originalText = text;
        
        return translation;
    }

    /**
     * Hybrid translate with batching and smart prefetching for improved performance.
     *
     * @param text text to translate
     * @param from source language
     * @param to target language
     *
     * @returns result Promise
     */
    async translate(text: string, from: string, to: string) {
        // Fast paths: ignore empty/whitespace
        if (!text || !text.trim()) {
            return { originalText: text || "", mainMeaning: "" } as TranslationResult;
        }

        // Normalize inputs to keep key stable
        const key = `H|${from}|${to}|${fnv1a32(text)}`;

        // Cache hit
        const cached = this.cache.get(key);
        if (cached) {
            this.stats.cacheHits++;
            return cached;
        }

        // In-flight dedupe
        const existing = this.inflight.get(key);
        if (existing) return existing;

        const exec = (async (): Promise<TranslationResult> => {
            try {
                const result = await this.translateSingle(text, from, to);
                this.stats.requests++;
                this.cache.set(key, result);
                return result;
            } catch (error) {
                this.stats.errors++;
                throw error;
            }
        })();

        this.inflight.set(key, exec);
        try {
            const res = await exec;
            return res;
        } finally {
            this.inflight.delete(key);
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
        return await this.REAL_TRANSLATORS[this.MAIN_TRANSLATOR].pronounce(text, language, speed);
    }

    /**
     * Pause pronounce.
     */
    async stopPronounce() {
        this.REAL_TRANSLATORS[this.MAIN_TRANSLATOR].stopPronounce();
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            size: this.cache.size(),
            maxSize: 250,
            ttl: 15 * 60 * 1000,
        };
    }

    /**
     * Get performance statistics from all translators
     */
    getPerformanceStats() {
        const cacheStats = this.getCacheStats();
        const stats: any = {
            ...this.stats,
            cacheSize: cacheStats.size,
            maxCacheSize: cacheStats.maxSize,
            cacheTTL: cacheStats.ttl,
            hitRate: this.stats.requests > 0 
                ? (this.stats.cacheHits / this.stats.requests * 100).toFixed(1) + '%'
                : '0%',
            inflight: this.inflight.size
        };

        // Get Bing translator stats if available
        if (this.REAL_TRANSLATORS.BingTranslate?.getCacheStats) {
            stats.bing = this.REAL_TRANSLATORS.BingTranslate.getCacheStats();
        }

        return stats;
    }

    /**
     * Cleanup all translator resources
     */
    async cleanup() {
        // Clear hybrid cache
        this.cache.clear();
        this.inflight.clear();

        // Cleanup individual translators
        if (this.REAL_TRANSLATORS.BingTranslate?.cleanup) {
            await this.REAL_TRANSLATORS.BingTranslate.cleanup();
        }
    }

    /**
     * Check if a value has meaningful content.
     * 
     * @param value The value to check
     * @returns true if the value has meaningful content, false otherwise
     */
    private hasValue(value: any): boolean {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string') return value.trim().length > 0;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') {
            // For objects, check if they have any enumerable properties
            return Object.keys(value).length > 0;
        }
        return true; // For other types (boolean, number, etc.)
    }
}

export default HybridTranslator;