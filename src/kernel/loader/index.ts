/**
 * Loader Module - Module loading infrastructure for the Monk OS kernel
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module serves as the public API entry point for the kernel's module
 * loading subsystem. It re-exports all types, utilities, and implementations
 * needed to load, cache, and execute TypeScript modules from the VFS.
 *
 * The loader subsystem consists of several key components:
 *
 * 1. **ModuleCache** - Stores compiled modules to avoid re-transpilation
 *    Caches both the transpiled JavaScript and the module's exports object
 *    after first execution. This is critical for performance since transpiling
 *    and executing TypeScript is expensive.
 *
 * 2. **Import Utilities** - Path resolution and ES6 import rewriting
 *    Handles the complexity of converting ES6 import syntax to the kernel's
 *    __require() system, resolving relative paths, and detecting VFS vs
 *    external modules.
 *
 * 3. **VFSLoader** - The core loader implementation
 *    Orchestrates the entire loading pipeline: read source from VFS, transpile
 *    TypeScript to JavaScript, rewrite imports, execute in sandboxed worker,
 *    and cache the result.
 *
 * This barrel export pattern provides a clean boundary between the loader
 * implementation and its consumers (primarily the Kernel class). Consumers
 * don't need to know about internal module structure - they just import from
 * 'kernel/loader' and get everything they need.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All exports maintain their original contracts and semantics
 * INV-2: No initialization side effects occur on import of this module
 * INV-3: Type exports are pure and don't generate runtime code
 * INV-4: Re-exported modules are fully initialized before access
 *
 * CONCURRENCY MODEL
 * =================
 * This is a pure re-export module with no state or side effects. It's safe
 * to import from any context. The concurrency characteristics of individual
 * exported items are documented in their source modules.
 *
 * MEMORY MANAGEMENT
 * =================
 * No memory is allocated by this module itself. It only creates references
 * to exports from other modules. Memory lifetime is controlled by the
 * imported modules and their consumers.
 *
 * @module kernel/loader
 */

// =============================================================================
// TYPE EXPORTS
// =============================================================================

/**
 * Module cache types.
 *
 * WHY export types separately:
 * TypeScript type-only exports don't generate runtime code. Separating them
 * from value exports makes it clear what's compile-time vs runtime.
 *
 * - CachedModule: Represents a compiled and cached module entry
 * - ModuleCacheConfig: Configuration for cache behavior (TTL, size limits, etc)
 */
export type { CachedModule, ModuleCacheConfig } from './types.js';

// =============================================================================
// CACHE IMPLEMENTATION
// =============================================================================

/**
 * Module cache implementation.
 *
 * WHY export the class:
 * Kernel needs to instantiate ModuleCache to store compiled modules.
 * The cache is shared across all module loads to maximize hit rate.
 */
export { ModuleCache } from './cache.js';

// =============================================================================
// IMPORT UTILITIES
// =============================================================================

/**
 * Import extraction, resolution, and rewriting utilities.
 *
 * WHY export all these functions:
 * While VFSLoader uses these internally, other parts of the kernel may need
 * to perform path resolution or import analysis independently. For example,
 * dependency scanning or static analysis tools.
 *
 * Exported functions:
 * - extractImports: Parse JavaScript to find import statements (deprecated)
 * - resolveImport: Convert relative/aliased paths to absolute VFS paths
 * - resolvePath: Normalize paths with . and .. segments
 * - isVFSPath: Classify path as VFS vs external module
 * - rewriteImports: Transform ES6 imports to __require() calls
 */
export {
    extractImports,
    resolveImport,
    resolvePath,
    isVFSPath,
    rewriteImports,
} from './imports.js';

// =============================================================================
// VFS LOADER
// =============================================================================

/**
 * VFS-backed module loader implementation.
 *
 * WHY export the loader:
 * VFSLoader is the main entry point for module loading. The Kernel class
 * instantiates it during boot and uses it to load all kernel modules and
 * user programs from VFS.
 *
 * The loader integrates all components:
 * - Reads TypeScript source from VFS
 * - Transpiles to JavaScript using Bun
 * - Rewrites imports using utilities above
 * - Executes in sandboxed worker context
 * - Stores result in ModuleCache for reuse
 */
export { VFSLoader } from './vfs-loader.js';
