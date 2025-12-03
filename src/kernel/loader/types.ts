/**
 * Loader Types - Shared types and interfaces for VFS module loading
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the type system for Monk OS's module loading infrastructure.
 * The loader operates as a caching transpiler that converts TypeScript modules from
 * the VFS into executable JavaScript with rewritten import paths.
 *
 * The CachedModule type represents a compiled module entry. Each entry contains the
 * transpiled JavaScript code, a list of VFS import dependencies, a content hash for
 * cache invalidation, and an LRU timestamp. This structure enables efficient caching
 * while maintaining cache coherence when source files change.
 *
 * ModuleCacheConfig provides tuning parameters for the LRU cache. The cache enforces
 * limits on both module count and total memory usage to prevent unbounded growth in
 * long-running systems.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: CachedModule.hash must match the SHA-256 of the source content
 * INV-2: CachedModule.imports must contain all VFS paths referenced in the module
 * INV-3: CachedModule.usedAt is updated on every cache hit
 * INV-4: ModuleCacheConfig limits are advisory - cache may temporarily exceed them
 * INV-5: All byte sizes are measured as string.length (UTF-16 code units)
 *
 * CONCURRENCY MODEL
 * =================
 * This module defines only types - no runtime behavior or state. All instances of
 * these types are created and managed by the ModuleCache class. Individual
 * CachedModule objects may be mutated (usedAt field) by cache operations, but
 * JavaScript's single-threaded execution prevents data races within a single module.
 *
 * Concurrent module loads may interleave at await points in the loader, but each
 * load operates on independent CachedModule instances. Cache invalidation during
 * a load may cause stale data to be used - this is acceptable as it only affects
 * performance, not correctness.
 *
 * MEMORY MANAGEMENT
 * =================
 * CachedModule.js strings can be large (100KB+ for complex modules). The cache
 * enforces maxSizeBytes to bound total memory usage. When limits are exceeded,
 * the LRU eviction algorithm removes oldest entries until size drops below the
 * threshold.
 *
 * No manual cleanup is required - garbage collection handles deallocation when
 * modules are evicted from the cache.
 *
 * @module kernel/loader/types
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Cached module entry representing a compiled VFS module.
 *
 * TESTABILITY: All fields are exposed to allow test verification of cache state.
 *
 * LIFECYCLE:
 * 1. Created after successful transpilation
 * 2. Stored in ModuleCache with VFS path as key
 * 3. Retrieved on subsequent imports (cache hit)
 * 4. Evicted when TTL expires or cache limits exceeded
 * 5. Invalidated when source file changes (hash mismatch)
 */
export interface CachedModule {
    /**
     * Transpiled JavaScript with rewritten imports.
     *
     * WHY: TypeScript source must be compiled to JavaScript before execution.
     * Import paths are rewritten from VFS paths (/vfs/foo.ts) to blob URLs
     * or data URLs that the runtime can load.
     *
     * INVARIANT: Valid JavaScript code that can be eval'd or loaded as a module.
     */
    js: string;

    /**
     * VFS paths this module imports.
     *
     * WHY: Dependency tracking enables invalidation cascades. When /vfs/a.ts
     * changes, all modules that import it must be invalidated to prevent
     * stale code execution.
     *
     * INVARIANT: All paths in this array exist in the VFS at compile time.
     */
    imports: string[];

    /**
     * Source content hash for invalidation.
     *
     * WHY: Detects when source file has changed since compilation. On cache
     * hit, hash is compared to current file hash. Mismatch triggers recompile.
     *
     * INVARIANT: SHA-256 hex digest of the original TypeScript source.
     */
    hash: string;

    /**
     * Last access time for LRU eviction.
     *
     * WHY: LRU eviction policy keeps frequently used modules in cache while
     * removing old code. This timestamp is updated on every get() to track
     * recency.
     *
     * INVARIANT: Unix timestamp in milliseconds (Date.now() format).
     */
    usedAt: number;
}

/**
 * Module cache configuration parameters.
 *
 * TESTABILITY: Exported type allows test code to configure cache behavior.
 *
 * WHY optional fields:
 * Allows partial config where only some limits are overridden. ModuleCache
 * merges provided config with DEFAULT_CONFIG to ensure all fields are set.
 */
export interface ModuleCacheConfig {
    /**
     * Maximum number of modules to cache.
     *
     * WHY: Bounds the Map size to prevent memory exhaustion in long-running
     * systems. When exceeded, oldest modules are evicted.
     *
     * DEFAULT: 100 modules (see cache.ts DEFAULT_CONFIG)
     */
    maxModules?: number;

    /**
     * Maximum total size in bytes.
     *
     * WHY: Compiled JavaScript can be large (100KB+ per module). This limit
     * prevents unbounded memory growth when many modules are loaded.
     *
     * DEFAULT: 10MB (see cache.ts DEFAULT_CONFIG)
     * MEASUREMENT: Sum of all CachedModule.js.length values.
     */
    maxSizeBytes?: number;

    /**
     * TTL in milliseconds for unused modules.
     *
     * WHY: Evicts stale code that hasn't been accessed recently. Prevents
     * cache from filling with old versions of frequently modified files.
     *
     * DEFAULT: 30 minutes (see cache.ts DEFAULT_CONFIG)
     * MEASUREMENT: (Date.now() - CachedModule.usedAt) > ttlMs
     */
    ttlMs?: number;
}
