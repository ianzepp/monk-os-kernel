/**
 * VFS Loader - Module Compiler and Bundler
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * VFSLoader is the kernel's TypeScript-to-JavaScript compiler and module bundler
 * for Worker-based process execution. It reads TypeScript source code from the
 * virtual filesystem, transpiles it to JavaScript using Bun's transpiler, rewrites
 * import/export statements to CommonJS-style __require() calls, and bundles all
 * dependencies into a self-contained script suitable for Worker execution.
 *
 * The loader operates in three phases:
 *
 * 1. COMPILATION: Individual modules are read from VFS, transpiled from TypeScript
 *    to JavaScript, and their import statements are scanned to build a dependency
 *    graph. Compiled modules are cached based on content hash to avoid redundant
 *    transpilation.
 *
 * 2. RESOLUTION: Starting from an entry point, the loader recursively resolves all
 *    VFS dependencies by walking the import graph. Each unique module is compiled
 *    exactly once. External (non-VFS) imports are preserved as errors in the bundle
 *    since Workers cannot access the host filesystem.
 *
 * 3. BUNDLING: All resolved modules are assembled into a single JavaScript string
 *    with a CommonJS-style module system (__modules, __cache, __require). The
 *    bundle is wrapped in a Blob URL for Worker instantiation.
 *
 * This design isolates process code from the host environment while enabling
 * TypeScript development with full IDE support. The VFS serves as the module
 * storage layer, the loader as the build system, and Workers as the execution
 * sandbox.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Module cache entries are keyed by absolute VFS path
 * INV-2: Cache hits only occur when source hash matches stored hash
 * INV-3: All VFS imports are resolved to absolute paths before bundling
 * INV-4: Each module in a bundle has exactly one factory function
 * INV-5: Blob URLs are created from bundle strings without external dependencies
 * INV-6: Aliases map package names to VFS paths (not host paths)
 *
 * CONCURRENCY MODEL
 * =================
 * VFSLoader is async but not thread-safe for concurrent operations on the same
 * instance. The cache (ModuleCache) uses a Map which is not safe for concurrent
 * modification. Multiple loaders can run in parallel, but a single loader should
 * be accessed sequentially.
 *
 * RACE CONDITION MITIGATIONS:
 * - VFS file reads are atomic (handle.read completes before next operation)
 * - Module cache uses synchronous Map operations (no await between get/set)
 * - Dependency resolution uses visited Set to prevent infinite loops
 *
 * MEMORY MANAGEMENT
 * =================
 * - Module cache grows unbounded unless clearCache() is called
 * - Each bundle creates a new Blob URL that must be explicitly revoked
 * - Compiled JavaScript is kept in memory for cache duration
 * - Blob URLs pin blobs in memory until revoked - callers MUST call revokeBlobURL()
 *
 * @module kernel/loader/vfs-loader
 */

import type { VFS } from '@src/vfs/index.js';
import type { HAL } from '@src/hal/index.js';
import type { CachedModule, ModuleCacheConfig } from './types.js';
import { ModuleCache } from './cache.js';
import { resolveImport, isVFSPath, rewriteImports } from './imports.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * VFSLoader - Module compiler and bundler for VFS-based scripts.
 *
 * Provides TypeScript compilation, import resolution, and bundling for
 * Worker-based process execution.
 */
export class VFSLoader {
    // =========================================================================
    // CORE DEPENDENCIES
    // =========================================================================

    /**
     * Virtual filesystem for module storage.
     *
     * WHY: All source code is stored in VFS, not host filesystem.
     * This enables per-process isolation and access control.
     */
    private vfs: VFS;

    /**
     * Module compilation cache.
     *
     * WHY: Transpilation is expensive. Cache based on content hash avoids
     * redundant work when source hasn't changed.
     * INVARIANT: Cache keys are absolute VFS paths.
     */
    private cache: ModuleCache;

    /**
     * Bun TypeScript transpiler.
     *
     * WHY: Converts TypeScript to JavaScript. Bun's transpiler is fast and
     * supports modern TS features without needing tsconfig.json.
     * INVARIANT: Configured with loader: 'ts' to handle TypeScript syntax.
     */
    private transpiler: InstanceType<typeof Bun.Transpiler>;

    // =========================================================================
    // IMPORT ALIAS REGISTRY
    // =========================================================================

    /**
     * Import path aliases.
     *
     * WHY: Maps package-style imports (e.g., '@monk/process') to VFS paths
     * (e.g., '/lib/process'). This enables external libraries to be mounted
     * into VFS and imported by processes.
     *
     * Example aliases:
     *   '@monk/process' -> '/lib/process'
     *   '@monk/stream'  -> '/lib/stream'
     *
     * INVARIANT: Alias values are always absolute VFS paths starting with '/'.
     */
    private aliases: Map<string, string> = new Map();

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new VFSLoader.
     *
     * @param vfs - Virtual filesystem for module storage
     * @param _hal - Hardware abstraction layer (unused, reserved for future)
     * @param cacheConfig - Optional cache configuration (size limits, TTL)
     */
    constructor(vfs: VFS, _hal: HAL, cacheConfig?: ModuleCacheConfig) {
        this.vfs = vfs;
        this.cache = new ModuleCache(cacheConfig);
        // WHY loader: 'ts' - Enables TypeScript syntax support
        this.transpiler = new Bun.Transpiler({ loader: 'ts' });
    }

    // =========================================================================
    // ALIAS MANAGEMENT
    // =========================================================================

    /**
     * Set import aliases for transpiled-host mounts.
     *
     * Aliases map external package names to VFS paths, enabling imports like:
     *   import { Process } from '@monk/process'
     * to resolve to:
     *   /lib/process/index.ts
     *
     * WHY: Allows processes to import kernel-provided libraries without
     * hardcoding VFS paths in source code.
     *
     * @param aliases - Map of alias -> VFS path
     */
    setAliases(aliases: Record<string, string>): void {
        for (const [alias, target] of Object.entries(aliases)) {
            this.aliases.set(alias, target);
        }
    }

    /**
     * Get all registered aliases.
     *
     * WHY: Enables inspection of alias configuration for debugging.
     *
     * @returns Copy of alias map
     */
    getAliases(): Map<string, string> {
        // Return copy to prevent external mutation
        return new Map(this.aliases);
    }

    /**
     * Resolve an import path, applying aliases if applicable.
     *
     * ALGORITHM:
     * 1. Check for exact alias match (e.g., '@monk/process')
     * 2. Check for prefix match (e.g., '@monk/process/foo' -> '/lib/process/foo')
     * 3. Return original path if no match
     *
     * WHY prefix matching:
     * Allows subpath imports like '@monk/process/utils' to map to
     * '/lib/process/utils' without explicit alias for every subpath.
     *
     * TESTABILITY: Currently unused (@ts-expect-error scaffolding) but
     * reserved for future alias resolution in import rewriting.
     *
     * @param importPath - Import path from source code
     * @returns Resolved VFS path or original path
     */
    private resolveAlias(importPath: string): string {
        // Check for exact alias match
        if (this.aliases.has(importPath)) {
            return this.aliases.get(importPath)!;
        }

        // Check for prefix match (e.g., '@monk/process/foo' -> '/lib/process/foo')
        for (const [alias, target] of this.aliases) {
            if (importPath.startsWith(alias + '/')) {
                return target + importPath.slice(alias.length);
            }
        }

        return importPath;
    }

    // =========================================================================
    // MODULE COMPILATION
    // =========================================================================

    /**
     * Compile a module from VFS.
     *
     * ALGORITHM:
     * 1. Read source code from VFS
     * 2. Compute content hash
     * 3. Check cache for matching hash
     * 4. If cache miss:
     *    a. Scan imports from TypeScript source (before transpilation)
     *    b. Transpile TypeScript to JavaScript
     *    c. Filter to VFS imports only
     *    d. Rewrite import/export statements to __require()
     *    e. Store in cache
     * 5. Return cached module
     *
     * WHY scan imports before transpilation:
     * Bun's scanner operates on TypeScript AST. After transpilation, type
     * imports are removed and import structure may change.
     *
     * WHY filter to VFS imports:
     * External imports (node:, bun:, npm packages) cannot be loaded in Workers.
     * We track only VFS dependencies for recursive resolution.
     *
     * @param vfsPath - Absolute VFS path to module
     * @returns Compiled module with JavaScript, dependencies, and metadata
     */
    async compileModule(vfsPath: string): Promise<CachedModule> {
        // Read source from VFS
        const source = await this.readVFSFile(vfsPath);
        const hash = this.computeHash(source);

        // Check cache for matching hash
        // WHY hash-based: Detects source changes even if filename unchanged
        const cached = this.cache.get(vfsPath);

        if (cached && cached.hash === hash) {
            return cached;
        }

        // Scan imports from TypeScript source (before transpilation)
        // WHY before transpilation: Bun's parser handles TypeScript syntax
        // and correctly identifies type-only imports
        const scanned = this.transpiler.scanImports(source);
        const rawImports = scanned.map(i => i.path);

        // Transpile TypeScript -> JavaScript
        // WHY transformSync: Compilation is CPU-bound, no I/O benefit from async
        const js = this.transpiler.transformSync(source);

        // Filter to VFS imports only
        // WHY: External imports will error at runtime - we only track VFS deps
        const vfsImports = rawImports
            .map(imp => resolveImport(imp, vfsPath))
            .filter(isVFSPath);

        // Rewrite import/export statements to __require() calls
        const rewritten = rewriteImports(js, vfsPath);

        const mod: CachedModule = {
            js: rewritten,
            imports: vfsImports,
            hash,
            usedAt: Date.now(),
        };

        this.cache.set(vfsPath, mod);

        return mod;
    }

    // =========================================================================
    // DEPENDENCY RESOLUTION
    // =========================================================================

    /**
     * Resolve all dependencies for an entry point.
     *
     * ALGORITHM:
     * 1. Start with entry point in queue
     * 2. While queue not empty:
     *    a. Pop module path
     *    b. Skip if already visited
     *    c. Compile module
     *    d. Add to result map
     *    e. Queue all VFS dependencies
     * 3. Return map of path -> compiled module
     *
     * WHY breadth-first:
     * Simpler than depth-first and produces same result since we track visited.
     * Order doesn't matter for bundling.
     *
     * WHY visited set:
     * Prevents infinite loops from circular dependencies and avoids redundant
     * compilation of shared dependencies.
     *
     * @param entryPath - Absolute VFS path to entry point module
     * @returns Map of all reachable modules (keyed by VFS path)
     */
    async resolveDependencies(entryPath: string): Promise<Map<string, CachedModule>> {
        const modules = new Map<string, CachedModule>();
        const queue = [entryPath];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const path = queue.shift()!;

            if (visited.has(path)) {
                continue;
            }

            visited.add(path);

            // Compile module (may hit cache)
            const mod = await this.compileModule(path);

            modules.set(path, mod);

            // Queue unresolved VFS dependencies
            // WHY filter visited: Avoid reprocessing and circular loops
            for (const imp of mod.imports) {
                if (!visited.has(imp)) {
                    queue.push(imp);
                }
            }
        }

        return modules;
    }

    // =========================================================================
    // BUNDLE ASSEMBLY
    // =========================================================================

    /**
     * Assemble a bundle from entry point and dependencies.
     *
     * ALGORITHM:
     * 1. Resolve all dependencies from entry point
     * 2. Generate module registry preamble (__modules, __cache, __require)
     * 3. Add each module as a factory function in __modules
     * 4. Append entry point execution call
     * 5. Return bundle string
     *
     * BUNDLE STRUCTURE:
     * ```
     * const __modules = {};
     * const __cache = {};
     * function __require(path) { ... }
     *
     * __modules['/path/to/module.ts'] = function(module, exports, __require) {
     *   // Rewritten module code here
     * };
     *
     * __require('/entry/point.ts');
     * ```
     *
     * WHY factory functions:
     * Delays execution until __require() is called. Enables lazy loading and
     * circular dependency handling via __cache.
     *
     * WHY __cache:
     * Prevents infinite loops in circular dependencies and ensures each module
     * is initialized exactly once.
     *
     * WHY throw on built-ins:
     * Workers cannot access bun: or node: modules. Better to fail fast with
     * clear error than fail with cryptic undefined reference.
     *
     * @param entryPath - Absolute VFS path to entry point module
     * @returns Self-contained JavaScript bundle string
     */
    async assembleBundle(entryPath: string): Promise<string> {
        const modules = await this.resolveDependencies(entryPath);

        // Module registry preamble
        let bundle = `
'use strict';
const __modules = {};
const __cache = {};

function __require(path) {
    if (__cache[path]) return __cache[path];
    if (!__modules[path]) {
        // Check if it's a built-in
        if (path.startsWith('bun:') || path.startsWith('node:')) {
            throw new Error('Built-in modules not supported in VFS scripts: ' + path);
        }
        throw new Error('Module not found: ' + path);
    }
    const module = { exports: {} };
    const exports = module.exports;
    __modules[path](module, exports, __require);
    __cache[path] = module.exports;
    return module.exports;
}

`;

        // Add each module as a factory function
        // WHY factory: Defers execution and provides closure for module scope
        for (const [path, mod] of modules) {
            bundle += `
// ${path}
__modules['${path}'] = function(module, exports, __require) {
${mod.js}
};

`;
        }

        // Execute entry point
        // WHY: Starts the module evaluation chain
        // WHY auto-invoke default: Programs export main() as default, runtime should call it
        // This matches how compiled languages (C, Rust, Go) invoke main() automatically
        bundle += `
// Entry point
const __entry = __require('${entryPath}');
if (typeof __entry.default === 'function') {
    __entry.default();
}
`;

        return bundle;
    }

    // =========================================================================
    // BLOB URL MANAGEMENT
    // =========================================================================

    /**
     * Create a Blob URL for a bundle.
     *
     * WHY Blob URLs:
     * Workers require a URL to load code from. Blob URLs allow us to pass
     * in-memory JavaScript without writing to filesystem.
     *
     * MEMORY: Blob URLs pin the blob in memory until revoked. Callers MUST
     * call revokeBlobURL() when the Worker is terminated to prevent leaks.
     *
     * @param bundle - JavaScript bundle string
     * @returns Blob URL (e.g., blob:...)
     */
    createBlobURL(bundle: string): string {
        const blob = new Blob([bundle], { type: 'application/javascript' });

        return URL.createObjectURL(blob);
    }

    /**
     * Revoke a Blob URL.
     *
     * WHY: Releases memory held by the blob. Must be called when Worker
     * terminates to prevent memory leaks.
     *
     * @param url - Blob URL to revoke
     */
    revokeBlobURL(url: string): void {
        URL.revokeObjectURL(url);
    }

    // =========================================================================
    // CACHE MANAGEMENT
    // =========================================================================

    /**
     * Get cache statistics.
     *
     * WHY: Enables monitoring of cache performance and memory usage.
     *
     * @returns Cache metrics (entry count, total size in bytes)
     */
    getCacheStats(): { count: number; sizeBytes: number } {
        return this.cache.stats();
    }

    /**
     * Clear the module cache.
     *
     * WHY: Frees memory when cache grows too large or during testing.
     * Forces recompilation on next compile() call.
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Invalidate a specific module in cache.
     *
     * WHY: Allows targeted cache invalidation when a module is modified
     * without clearing entire cache.
     *
     * @param path - Absolute VFS path to invalidate
     */
    invalidateModule(path: string): void {
        this.cache.invalidate(path);
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Read a file from VFS.
     *
     * ALGORITHM:
     * 1. Open file handle for reading
     * 2. Read in 64KB chunks until EOF
     * 3. Close handle
     * 4. Concatenate chunks into single Uint8Array
     * 5. Decode as UTF-8 string
     *
     * WHY 64KB chunks:
     * Balances memory usage vs. number of async calls. Smaller chunks
     * increase overhead, larger chunks increase memory pressure.
     *
     * WHY finally block:
     * Ensures handle is closed even if read() throws. Prevents handle leaks.
     *
     * @param path - Absolute VFS path to read
     * @returns File content as UTF-8 string
     */
    private async readVFSFile(path: string): Promise<string> {
        const handle = await this.vfs.open(path, { read: true }, 'kernel');
        const chunks: Uint8Array[] = [];

        try {
            while (true) {
                const chunk = await handle.read(65536); // 64KB chunks

                if (chunk.length === 0) {
                    break;
                } // EOF

                chunks.push(chunk);
            }
        }
        finally {
            // SAFETY: Always close handle to prevent leaks
            await handle.close();
        }

        // Concatenate chunks into single array
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const combined = new Uint8Array(total);
        let offset = 0;

        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        return new TextDecoder().decode(combined);
    }

    /**
     * Compute hash of content.
     *
     * WHY: Cache key to detect source changes. Bun.hash() is fast (xxHash)
     * and sufficient for cache invalidation (not cryptographic security).
     *
     * @param content - String to hash
     * @returns Hex-encoded hash string
     */
    private computeHash(content: string): string {
        return Bun.hash(content).toString(16);
    }
}
