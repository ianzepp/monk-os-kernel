/**
 * ModuleCache - LRU cache for compiled VFS modules
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ModuleCache implements a Least Recently Used (LRU) cache for compiled TypeScript
 * modules. The kernel's module loader transpiles VFS source files to JavaScript on
 * first import, then stores the result here to avoid repeated compilation.
 *
 * The cache enforces three eviction policies: (1) maximum module count, (2) maximum
 * total size in bytes, and (3) time-to-live for unused modules. When any limit is
 * exceeded, the evictIfNeeded() algorithm first removes expired entries, then
 * evicts least-recently-used modules until the cache is under limits.
 *
 * Each cached entry tracks its VFS path (key), compiled JavaScript code, import
 * dependencies, source hash, and last access timestamp. The hash enables cache
 * invalidation when source files change - a mismatch on get() signals the loader
 * to recompile.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: totalSize always equals sum of all mod.js.length values in cache
 * INV-2: cache.size <= config.maxModules (after evictIfNeeded completes)
 * INV-3: totalSize <= config.maxSizeBytes (after evictIfNeeded completes)
 * INV-4: No entry has (now - usedAt) > config.ttlMs (after evictIfNeeded)
 * INV-5: usedAt is updated to Date.now() on every get() hit
 * INV-6: All keys in cache are absolute VFS paths
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * module loads may occur concurrently, causing parallel calls to get() and set().
 * These operations do not await, so they execute atomically without interleaving.
 *
 * The eviction algorithm may run during set() while another get() is in progress.
 * This is safe because Map operations are atomic within the event loop tick. The
 * worst case is a get() returning a module that's immediately evicted - this
 * causes cache churn but no correctness issues.
 *
 * Cache invalidation (via invalidate()) may race with get(). If invalidate()
 * runs between a get() returning an entry and the loader using it, the loader
 * will use stale code. This is acceptable - the next import will trigger a
 * recompile.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: All Map operations are atomic - no interleaving within a method
 * RC-2: totalSize is updated before and after cache mutations to maintain INV-1
 * RC-3: evictIfNeeded() is called after every set() to enforce limits
 * RC-4: get() updates usedAt before returning - race with evict is benign
 *
 * MEMORY MANAGEMENT
 * =================
 * Compiled JavaScript strings can be large (100KB+). The cache limits total
 * memory via maxSizeBytes. When exceeded, LRU eviction removes oldest entries
 * until size drops below the limit.
 *
 * String deallocation is handled by the garbage collector. Once a CachedModule
 * is removed from the Map, it becomes eligible for GC (assuming no other
 * references exist).
 *
 * The totalSize field tracks memory usage by summing string lengths. This is
 * approximate - actual memory includes object overhead and hash table buckets.
 *
 * @module kernel/loader/cache
 */

import type { CachedModule, ModuleCacheConfig } from './types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default cache configuration.
 *
 * WHY these values:
 * - maxModules=100: Typical app has 10-50 modules. 100 provides headroom.
 * - maxSizeBytes=10MB: Average module is 50KB. 10MB = ~200 modules worth.
 * - ttlMs=30min: Balances cache hits vs stale code. Dev cycle is ~5-10min.
 *
 * TUNING: These are conservative defaults. Production systems may increase
 * limits if memory is abundant and module count is high.
 */
const DEFAULT_CONFIG: Required<ModuleCacheConfig> = {
    maxModules: 100,
    maxSizeBytes: 10_000_000, // 10MB
    ttlMs: 30 * 60 * 1000,    // 30 minutes
};

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * LRU cache for compiled modules.
 *
 * Stores transpiled JavaScript to avoid repeated compilation. Enforces
 * module count, total size, and TTL limits via LRU eviction.
 */
export class ModuleCache {
    // =========================================================================
    // CORE STATE
    // =========================================================================

    /**
     * Map from VFS path to cached module.
     *
     * WHY: Map provides O(1) lookup by path and preserves insertion order
     * for iteration during eviction.
     *
     * INVARIANT: All keys are absolute VFS paths (start with /).
     */
    private cache = new Map<string, CachedModule>();

    /**
     * Cache configuration parameters.
     *
     * WHY: Merged with DEFAULT_CONFIG to ensure all fields are set even when
     * partial config is provided.
     *
     * INVARIANT: All fields are defined (not undefined).
     */
    private config: Required<ModuleCacheConfig>;

    /**
     * Total size of all cached modules in bytes.
     *
     * WHY: Tracking total size separately avoids O(n) scan on every set().
     * Updated incrementally as modules are added/removed.
     *
     * INVARIANT: Always equals sum of all mod.js.length values.
     */
    private totalSize = 0;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new ModuleCache.
     *
     * @param config - Optional cache limits (merged with defaults)
     */
    constructor(config?: ModuleCacheConfig) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // =========================================================================
    // CACHE OPERATIONS
    // =========================================================================

    /**
     * Get a cached module.
     *
     * ALGORITHM:
     * 1. Retrieve module from Map
     * 2. Update usedAt timestamp for LRU tracking
     * 3. Return module (or undefined if miss)
     *
     * RACE CONDITION:
     * Module may be evicted immediately after this returns. Caller should
     * check validity (e.g., hash match) before using the result.
     *
     * @param path - VFS path of the module
     * @returns Cached module or undefined if not cached
     */
    get(path: string): CachedModule | undefined {
        const mod = this.cache.get(path);
        if (mod) {
            // Update LRU timestamp on hit
            // WHY: Prevents recently accessed modules from being evicted
            mod.usedAt = Date.now();
        }
        return mod;
    }

    /**
     * Set a cached module.
     *
     * ALGORITHM:
     * 1. Remove old version if exists (update totalSize)
     * 2. Add new version to cache
     * 3. Update totalSize
     * 4. Evict entries if over limits
     *
     * WHY remove before add:
     * Ensures totalSize is accurate and prevents counting same path twice.
     *
     * @param path - VFS path of the module
     * @param mod - Compiled module to cache
     */
    set(path: string, mod: CachedModule): void {
        // Remove old version if exists
        // WHY: Update invalidation requires replacing existing entry
        const old = this.cache.get(path);
        if (old) {
            this.totalSize -= old.js.length;
        }

        // Add new version
        this.cache.set(path, mod);
        this.totalSize += mod.js.length;

        // Enforce cache limits
        // WHY: Called after every set() to maintain INV-2 and INV-3
        this.evictIfNeeded();
    }

    /**
     * Invalidate a specific module.
     *
     * WHY: Called when a VFS file changes. Removes stale code from cache
     * to force recompilation on next import.
     *
     * @param path - VFS path to invalidate
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
     *
     * WHY: Used for testing and manual cache flushes (e.g., after VFS restore).
     */
    clear(): void {
        this.cache.clear();
        this.totalSize = 0;
    }

    // =========================================================================
    // INTROSPECTION (for testing and monitoring)
    // =========================================================================

    /**
     * Get cache statistics.
     *
     * TESTING: Allows tests to verify cache behavior without accessing private fields.
     *
     * @returns Current cache count and total size
     */
    stats(): { count: number; sizeBytes: number } {
        return {
            count: this.cache.size,
            sizeBytes: this.totalSize,
        };
    }

    // =========================================================================
    // EVICTION (private implementation)
    // =========================================================================

    /**
     * Evict modules if over limits.
     *
     * ALGORITHM:
     * 1. Remove all expired modules (usedAt + ttlMs < now)
     * 2. While over maxModules or maxSizeBytes:
     *    a. Find least recently used module
     *    b. Remove it
     *    c. Update totalSize
     *
     * WHY two-phase eviction:
     * Expired entries are cheapest to remove (no LRU scan). Removing them
     * first may bring cache under limits without needing LRU eviction.
     *
     * COMPLEXITY: O(n) for TTL scan, O(n²) worst case for LRU (scan for each evict).
     * This is acceptable because eviction only runs when limits are exceeded.
     */
    private evictIfNeeded(): void {
        const now = Date.now();

        // Phase 1: Evict expired modules
        // WHY: TTL eviction is cheaper than LRU - no need to scan entire cache
        for (const [path, mod] of this.cache) {
            if (now - mod.usedAt > this.config.ttlMs) {
                this.totalSize -= mod.js.length;
                this.cache.delete(path);
            }
        }

        // Phase 2: Evict LRU until under limits
        // WHY while loop: Each evictLRU() removes one entry. Must iterate
        // until both limits are satisfied.
        while (
            this.cache.size > this.config.maxModules ||
            this.totalSize > this.config.maxSizeBytes
        ) {
            this.evictLRU();
        }
    }

    /**
     * Evict least recently used module.
     *
     * ALGORITHM:
     * 1. Scan entire cache to find oldest usedAt
     * 2. Remove that entry
     * 3. Update totalSize
     *
     * WHY linear scan:
     * Map does not maintain LRU order. Proper LRU would require a doubly-linked
     * list or LinkedHashMap-like structure. For cache sizes ~100, linear scan
     * is simpler and fast enough (microseconds).
     *
     * OPTIMIZATION: If profiling shows this is slow, replace with priority queue
     * or doubly-linked list tracking.
     */
    private evictLRU(): void {
        let oldest: string | null = null;
        let oldestTime = Infinity;

        // Find LRU entry
        for (const [path, mod] of this.cache) {
            if (mod.usedAt < oldestTime) {
                oldest = path;
                oldestTime = mod.usedAt;
            }
        }

        // Remove it
        if (oldest) {
            const mod = this.cache.get(oldest)!;
            this.totalSize -= mod.js.length;
            this.cache.delete(oldest);
        }
    }
}
