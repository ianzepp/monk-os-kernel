/**
 * VFS Module Loader
 *
 * Enables execution of TypeScript scripts stored in VFS.
 * Handles transpilation, import rewriting, dependency resolution,
 * and bundle assembly for Worker execution.
 */

import type { VFS } from '@src/vfs/index.js';
import type { HAL } from '@src/hal/index.js';

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

/**
 * Extract import paths from JavaScript code.
 *
 * Handles:
 * - import { x } from '/path'
 * - import x from '/path'
 * - import * as x from '/path'
 * - import '/path' (side-effect imports)
 * - export * from '/path' (re-exports)
 * - export { x } from '/path' (named re-exports)
 */
export function extractImports(js: string): string[] {
    const imports: string[] = [];

    // Match various import patterns
    const patterns = [
        // import { x, y } from '/path'
        /import\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
        // import x from '/path'
        /import\s+\w+\s+from\s+['"]([^'"]+)['"]/g,
        // import * as x from '/path'
        /import\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]/g,
        // import '/path' (side-effect)
        /import\s+['"]([^'"]+)['"]/g,
        // export * from '/path' (re-exports)
        /export\s+\*\s+from\s+['"]([^'"]+)['"]/g,
        // export { x } from '/path' (named re-exports)
        /export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(js)) !== null) {
            imports.push(match[1]);
        }
    }

    // Deduplicate
    return [...new Set(imports)];
}

/**
 * Resolve an import path relative to the importing module.
 *
 * @param importPath - The import path as written
 * @param fromModule - The VFS path of the importing module
 * @returns Resolved VFS path
 */
export function resolveImport(importPath: string, fromModule: string): string {
    // Strip .js extension added by transpiler (VFS uses .ts)
    let path = importPath;
    if (path.endsWith('.js')) {
        path = path.slice(0, -3);
    }

    // Absolute VFS path
    if (path.startsWith('/')) {
        return path.endsWith('.ts') ? path : path + '.ts';
    }

    // Relative path
    if (path.startsWith('./') || path.startsWith('../')) {
        const fromDir = fromModule.substring(0, fromModule.lastIndexOf('/')) || '/';
        const resolved = resolvePath(fromDir, path);
        return resolved.endsWith('.ts') ? resolved : resolved + '.ts';
    }

    // Built-in or external - return as-is
    return path;
}

/**
 * Simple path resolution (handles . and ..)
 */
function resolvePath(base: string, relative: string): string {
    const baseParts = base.split('/').filter(Boolean);
    const relativeParts = relative.split('/');

    for (const part of relativeParts) {
        if (part === '.' || part === '') {
            continue;
        } else if (part === '..') {
            baseParts.pop();
        } else {
            baseParts.push(part);
        }
    }

    return '/' + baseParts.join('/');
}

/**
 * Check if a path is a VFS path (vs external/builtin).
 */
export function isVFSPath(path: string): boolean {
    // VFS paths start with /
    // External paths include: bun:*, node:*, npm packages
    return path.startsWith('/');
}

/**
 * Rewrite ES imports to use CommonJS-style __require().
 *
 * Transforms:
 * - import { x, y } from '/path' -> const { x, y } = __require('/path')
 * - import x from '/path' -> const x = __require('/path').default
 * - import * as x from '/path' -> const x = __require('/path')
 * - import '/path' -> __require('/path')
 * - export { x } -> exports.x = x
 * - export function/class/const x -> (exports added after)
 * - export default x -> exports.default = x
 */
export function rewriteImports(js: string, fromModule: string): string {
    let result = js;

    // import { x, y } from '/path' -> const { x, y } = __require('/path')
    result = result.replace(
        /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
        (_, imports, path) => {
            const resolved = resolveImport(path, fromModule);
            return `const {${imports}} = __require('${resolved}')`;
        }
    );

    // import x from '/path' -> const x = __require('/path').default
    result = result.replace(
        /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        (_, name, path) => {
            const resolved = resolveImport(path, fromModule);
            return `const ${name} = __require('${resolved}').default`;
        }
    );

    // import * as x from '/path' -> const x = __require('/path')
    result = result.replace(
        /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        (_, name, path) => {
            const resolved = resolveImport(path, fromModule);
            return `const ${name} = __require('${resolved}')`;
        }
    );

    // import '/path' -> __require('/path')
    result = result.replace(
        /import\s+['"]([^'"]+)['"]\s*;?/g,
        (_, path) => {
            const resolved = resolveImport(path, fromModule);
            return `__require('${resolved}');`;
        }
    );

    // export default x -> exports.default = x
    result = result.replace(
        /export\s+default\s+/g,
        'exports.default = '
    );

    // export * from '/path' -> Object.assign(exports, __require('/path'))
    result = result.replace(
        /export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g,
        (_, path) => {
            const resolved = resolveImport(path, fromModule);
            return `Object.assign(exports, __require('${resolved}'));`;
        }
    );

    // export { x, y } from '/path' -> const __reexport = __require('/path'); exports.x = __reexport.x; ...
    result = result.replace(
        /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
        (_, names, path) => {
            const resolved = resolveImport(path, fromModule);
            const items = names.split(',')
                .map((n: string) => n.trim())
                .filter((n: string) => n && !n.startsWith('type '));
            if (items.length === 0) return ''; // Type-only exports
            const tempVar = `__reexport_${Math.random().toString(36).slice(2, 8)}`;
            const assigns = items.map((n: string) => {
                // Handle "x as y" syntax
                const parts = n.split(/\s+as\s+/);
                const source = parts[0].trim();
                const exported = (parts[1] || parts[0]).trim();
                return `exports.${exported} = ${tempVar}.${source}`;
            }).join('; ');
            return `const ${tempVar} = __require('${resolved}'); ${assigns};`;
        }
    );

    // export { x, y } -> exports.x = x; exports.y = y
    result = result.replace(
        /export\s+\{([^}]+)\}/g,
        (_, names) => {
            const items = names.split(',').map((n: string) => n.trim()).filter(Boolean);
            return items.map((n: string) => {
                // Handle "x as y" syntax
                const parts = n.split(/\s+as\s+/);
                const local = parts[0].trim();
                const exported = (parts[1] || parts[0]).trim();
                return `exports.${exported} = ${local}`;
            }).join('; ');
        }
    );

    // export function x() -> function x() ... (track for later export)
    // export class X -> class X ...
    // export const/let/var x -> const/let/var x ...
    // These need post-processing to add exports

    const exportedNames: string[] = [];

    // Handle async functions: export async function x -> async function x
    result = result.replace(
        /export\s+(async\s+function)\s+(\w+)/g,
        (_, type, name) => {
            exportedNames.push(name);
            return `${type} ${name}`;
        }
    );

    // Handle sync functions and classes: export function x -> function x
    result = result.replace(
        /export\s+(function|class)\s+(\w+)/g,
        (_, type, name) => {
            exportedNames.push(name);
            return `${type} ${name}`;
        }
    );

    result = result.replace(
        /export\s+(const|let|var)\s+(\w+)/g,
        (_, kind, name) => {
            exportedNames.push(name);
            return `${kind} ${name}`;
        }
    );

    // Append exports for named function/class/variable exports
    if (exportedNames.length > 0) {
        const exportStatements = exportedNames.map(name => `exports.${name} = ${name};`).join('\n');
        result += '\n' + exportStatements;
    }

    return result;
}

/**
 * VFS Loader for compiling and bundling scripts
 */
export class VFSLoader {
    private vfs: VFS;
    private hal: HAL;
    private cache: ModuleCache;
    private transpiler: InstanceType<typeof Bun.Transpiler>;
    private aliases: Map<string, string> = new Map();

    constructor(vfs: VFS, hal: HAL, cacheConfig?: ModuleCacheConfig) {
        this.vfs = vfs;
        this.hal = hal;
        this.cache = new ModuleCache(cacheConfig);
        this.transpiler = new Bun.Transpiler({ loader: 'ts' });
    }

    /**
     * Set import aliases for transpiled-host mounts.
     *
     * Aliases map external package names to VFS paths:
     *   '@monk/process' -> '/lib/process'
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
     */
    getAliases(): Map<string, string> {
        return new Map(this.aliases);
    }

    /**
     * Resolve an import path, applying aliases if applicable.
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

    /**
     * Compile a module from VFS.
     *
     * Returns cached version if source hash matches.
     */
    async compileModule(vfsPath: string): Promise<CachedModule> {
        // Read source from VFS
        const source = await this.readVFSFile(vfsPath);
        const hash = this.computeHash(source);

        // Check cache
        const cached = this.cache.get(vfsPath);
        if (cached && cached.hash === hash) {
            return cached;
        }

        // Transpile TypeScript -> JavaScript
        const js = this.transpiler.transformSync(source);

        // Extract imports before rewriting
        const rawImports = extractImports(js);

        // Filter to VFS imports only
        const vfsImports = rawImports
            .map(imp => resolveImport(imp, vfsPath))
            .filter(isVFSPath);

        // Rewrite imports
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

    /**
     * Resolve all dependencies for an entry point.
     *
     * Walks the import graph and compiles all modules.
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

            // Compile module
            const mod = await this.compileModule(path);
            modules.set(path, mod);

            // Queue unresolved VFS dependencies
            for (const imp of mod.imports) {
                if (!visited.has(imp)) {
                    queue.push(imp);
                }
            }
        }

        return modules;
    }

    /**
     * Assemble a bundle from entry point and dependencies.
     *
     * Creates a self-contained JavaScript bundle with:
     * - Module registry
     * - __require() function
     * - All compiled modules
     * - Entry point execution
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
        for (const [path, mod] of modules) {
            // Wrap in async IIFE if the module uses top-level await
            const hasTopLevelAwait = /\bawait\s+/.test(mod.js) && !/\basync\s+function|\basync\s+\(/.test(mod.js.split('await')[0]);

            bundle += `
// ${path}
__modules['${path}'] = function(module, exports, __require) {
${mod.js}
};

`;
        }

        // Execute entry point
        bundle += `
// Entry point
__require('${entryPath}');
`;

        return bundle;
    }

    /**
     * Create a Blob URL for a bundle.
     */
    createBlobURL(bundle: string): string {
        const blob = new Blob([bundle], { type: 'application/javascript' });
        return URL.createObjectURL(blob);
    }

    /**
     * Revoke a Blob URL.
     */
    revokeBlobURL(url: string): void {
        URL.revokeObjectURL(url);
    }

    /**
     * Get cache statistics.
     */
    getCacheStats(): { count: number; sizeBytes: number } {
        return this.cache.stats();
    }

    /**
     * Clear the module cache.
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Invalidate a specific module in cache.
     */
    invalidateModule(path: string): void {
        this.cache.invalidate(path);
    }

    /**
     * Read a file from VFS.
     */
    private async readVFSFile(path: string): Promise<string> {
        const handle = await this.vfs.open(path, { read: true }, 'kernel');
        const chunks: Uint8Array[] = [];

        try {
            while (true) {
                const chunk = await handle.read(65536);
                if (chunk.length === 0) break;
                chunks.push(chunk);
            }
        } finally {
            await handle.close();
        }

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
     */
    private computeHash(content: string): string {
        return Bun.hash(content).toString(16);
    }
}
