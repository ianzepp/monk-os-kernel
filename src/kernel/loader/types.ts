/**
 * Loader Types
 *
 * Shared types and interfaces for VFS module loading.
 */

/**
 * Cached module entry
 */
export interface CachedModule {
    /** Transpiled JavaScript with rewritten imports */
    js: string;

    /** VFS paths this module imports */
    imports: string[];

    /** Source content hash for invalidation */
    hash: string;

    /** Last access time for LRU eviction */
    usedAt: number;
}

/**
 * Module cache configuration
 */
export interface ModuleCacheConfig {
    /** Maximum number of modules to cache */
    maxModules?: number;

    /** Maximum total size in bytes */
    maxSizeBytes?: number;

    /** TTL in milliseconds for unused modules */
    ttlMs?: number;
}
