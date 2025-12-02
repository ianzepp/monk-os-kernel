/**
 * Module Cache
 *
 * LRU cache for compiled VFS modules.
 */

import type { CachedModule, ModuleCacheConfig } from './types.js';

const DEFAULT_CONFIG: Required<ModuleCacheConfig> = {
    maxModules: 100,
    maxSizeBytes: 10_000_000, // 10MB
    ttlMs: 30 * 60 * 1000,    // 30 minutes
};

/**
 * LRU cache for compiled modules
 */
export class ModuleCache {
    private cache = new Map<string, CachedModule>();
    private config: Required<ModuleCacheConfig>;
    private totalSize = 0;

    constructor(config?: ModuleCacheConfig) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Get a cached module.
     */
    get(path: string): CachedModule | undefined {
        const mod = this.cache.get(path);
        if (mod) {
            mod.usedAt = Date.now();
        }
        return mod;
    }

    /**
     * Set a cached module.
     */
    set(path: string, mod: CachedModule): void {
        // Remove old version if exists
        const old = this.cache.get(path);
        if (old) {
            this.totalSize -= old.js.length;
        }

        // Add new version
        this.cache.set(path, mod);
        this.totalSize += mod.js.length;

        // Evict if needed
        this.evictIfNeeded();
    }

    /**
     * Invalidate a specific module.
     */
    invalidate(path: string): void {
        const mod = this.cache.get(path);
        if (mod) {
            this.totalSize -= mod.js.length;
            this.cache.delete(path);
        }
    }

    /**
     * Clear all cached modules.
     */
    clear(): void {
        this.cache.clear();
        this.totalSize = 0;
    }

    /**
     * Get cache statistics.
     */
    stats(): { count: number; sizeBytes: number } {
        return {
            count: this.cache.size,
            sizeBytes: this.totalSize,
        };
    }

    /**
     * Evict modules if over limits.
     */
    private evictIfNeeded(): void {
        const now = Date.now();

        // First, evict expired modules
        for (const [path, mod] of this.cache) {
            if (now - mod.usedAt > this.config.ttlMs) {
                this.totalSize -= mod.js.length;
                this.cache.delete(path);
            }
        }

        // Then evict LRU if still over limits
        while (
            this.cache.size > this.config.maxModules ||
            this.totalSize > this.config.maxSizeBytes
        ) {
            this.evictLRU();
        }
    }

    /**
     * Evict least recently used module.
     */
    private evictLRU(): void {
        let oldest: string | null = null;
        let oldestTime = Infinity;

        for (const [path, mod] of this.cache) {
            if (mod.usedAt < oldestTime) {
                oldest = path;
                oldestTime = mod.usedAt;
            }
        }

        if (oldest) {
            const mod = this.cache.get(oldest)!;
            this.totalSize -= mod.js.length;
            this.cache.delete(oldest);
        }
    }
}
