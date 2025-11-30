/**
 * Observer Loader
 *
 * Loads observers from the explicit registry and builds the cache
 * for efficient lookup by model and ring.
 */

import type { Observer } from '@src/lib/observers/interfaces.js';
import type { ObserverRing } from '@src/lib/observers/types.js';
import { UNIVERSAL_MODEL_KEYWORD } from '@src/lib/observers/types.js';
import { observers } from '@src/observers/registry.js';

/**
 * Observer loader with registry-based loading and caching
 */
export class ObserverLoader {
    private static cache = new Map<string, Observer[]>();
    private static loaded = false;

    /**
     * Load all observers from the registry and build the cache
     * Safe to call multiple times - only loads once
     */
    static preloadObservers(): void {
        if (this.loaded) return;

        for (const observer of observers) {
            // Get models this observer applies to (default: all models)
            const models = observer.models ?? [UNIVERSAL_MODEL_KEYWORD];

            for (const model of models) {
                const cacheKey = `${model}:${observer.ring}`;

                if (!this.cache.has(cacheKey)) {
                    this.cache.set(cacheKey, []);
                }

                this.cache.get(cacheKey)!.push(observer);
            }
        }

        // Sort observers within each cache entry by priority
        for (const [key, observerList] of this.cache) {
            observerList.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
        }

        this.loaded = true;
        console.info('Observer loading complete', {
            totalObservers: observers.length,
            cacheEntries: this.cache.size
        });
    }

    /**
     * Get cached observers for specific model and ring
     * Returns both model-specific and universal observers, sorted by priority
     */
    static getObservers(model: string, ring: ObserverRing): Observer[] {
        if (!this.loaded) {
            throw new Error('Observers not loaded - call preloadObservers() first');
        }

        const result: Observer[] = [];

        // Get model-specific observers
        const specificKey = `${model}:${ring}`;
        const specific = this.cache.get(specificKey) || [];
        result.push(...specific);

        // Get universal observers (applies to all models)
        if (model !== UNIVERSAL_MODEL_KEYWORD) {
            const universalKey = `${UNIVERSAL_MODEL_KEYWORD}:${ring}`;
            const universal = this.cache.get(universalKey) || [];
            result.push(...universal);
        }

        // Sort combined result by priority
        result.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

        return result;
    }

    /**
     * Get all loaded observers for debugging/monitoring
     */
    static getAllObservers(): Map<string, Observer[]> {
        if (!this.loaded) {
            throw new Error('Observers not loaded - call preloadObservers() first');
        }
        return new Map(this.cache);
    }

    /**
     * Get total count of registered observers
     */
    static getObserverCount(): number {
        return observers.length;
    }

    /**
     * Clear observer cache (useful for testing)
     */
    static clearCache(): void {
        this.cache.clear();
        this.loaded = false;
    }

    /**
     * Check if observers are loaded
     */
    static isLoaded(): boolean {
        return this.loaded;
    }
}
