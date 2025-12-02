/**
 * VFS Module Loader
 *
 * Enables execution of TypeScript scripts stored in VFS.
 * Handles transpilation, import rewriting, dependency resolution,
 * and bundle assembly for Worker execution.
 */

// Re-export types
export type { CachedModule, ModuleCacheConfig } from './loader/types.js';

// Re-export cache
export { ModuleCache } from './loader/cache.js';

// Re-export import utilities
export {
    extractImports,
    resolveImport,
    resolvePath,
    isVFSPath,
    rewriteImports,
} from './loader/imports.js';

// Re-export VFS Loader
export { VFSLoader } from './loader/vfs-loader.js';
